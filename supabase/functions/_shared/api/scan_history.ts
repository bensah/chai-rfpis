/**
 * Settings → Manual Scan — what the last run found. `app_pages/admin.py::_run_summary`.
 *
 * ONE ROW PER SOURCE PER RUN. `scan_logs` is not a log of runs, it is a log of SOURCES
 * within runs, so every figure on this panel is a sum over a group — and choosing the
 * group wrongly is how a panel reports a number that is merely too big. Since migration
 * 065 every row of one run shares a `run_id`, so the group is "the newest row's run_id".
 *
 * THE LEGACY FALLBACK IS NOT DEAD CODE. Rows written before 065 have no run_id, and the
 * heuristic that handles them — contiguous rows less than fifteen minutes apart, same
 * trigger — must STOP at the first row that does have one, or a legacy tail would be
 * merged into a modern run and inflate it. That stop is the part worth testing.
 *
 * `added` IS NULLABLE AND THAT IS A CLAIM, NOT A GAP. `rfps_added` arrived in migration
 * 094; a run that predates it, or an extract-only crawl that inserts nothing into any
 * pipeline, recorded none. Summing absent values as zero would report "added 0" for a run
 * that never counted — a different statement from "added nothing", and the one the panel
 * must not make.
 */
type Row = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.trunc(x) : 0;
};

/** The audit prefixes `triggered_by` carries, so the panel can show the person. */
const TRIGGER_PREFIXES = ["manual:", "extraction:", "match:"] as const;

/**
 * `_pretty_trigger` — the audit prefix stripped for display.
 *
 * The stored value keeps it; this only changes what a reader sees. A run started from
 * the React page writes `match:<email>` exactly as Streamlit does, so the two apps'
 * history reads identically.
 */
export function prettyTrigger(raw: unknown): string {
  const t = s(raw);
  if (!t) return "—";
  for (const p of TRIGGER_PREFIXES) {
    if (t.startsWith(p)) return t.slice(p.length);
  }
  return t;
}

export type RunSummary = {
  ts: string;
  trigger: string;
  found: number;
  new: number;
  /** Null when NO row in the group recorded one — see the module note. */
  added: number | null;
  rejected: number;
  /** How many source rows the run wrote, which is what the sums are over. */
  sources: number;
};

/** Milliseconds between two scan_date values, or Infinity when either is unreadable. */
function gap(newer: unknown, older: unknown): number {
  const a = Date.parse(s(newer));
  const b = Date.parse(s(older));
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : Infinity;
}

/**
 * The most recent run within `rows`, which must be NEWEST FIRST.
 *
 * The caller orders by scan_date descending, as the Streamlit page does; this does not
 * re-sort, because a re-sort would hide an ordering mistake rather than surface it.
 */
export function runSummary(rows: Row[]): RunSummary | null {
  if (!rows.length) return null;
  const latest = rows[0];
  const trigger = latest.triggered_by;
  const rid = s(latest.run_id);

  let group: Row[];
  if (rid) {
    group = rows.filter((r) => s(r.run_id) === rid);
  } else {
    group = [latest];
    let prev = latest.scan_date;
    for (const r of rows.slice(1)) {
      // STOP at a row that has a run_id: merging a legacy tail into a modern run would
      // inflate it, and the inflated number looks exactly like a good scan.
      if (s(r.run_id)) break;
      if (gap(prev, r.scan_date) > 900_000) break;        // >15 minutes → another run
      if (s(r.triggered_by) === s(trigger)) group.push(r);
      prev = r.scan_date;
    }
  }

  const counted = group.filter((r) => r.rfps_added !== null && r.rfps_added !== undefined);
  return {
    ts: s(latest.scan_date).slice(0, 16).replace("T", " "),
    trigger: prettyTrigger(trigger),
    found: group.reduce((a, r) => a + n(r.rfps_found), 0),
    new: group.reduce((a, r) => a + n(r.rfps_new), 0),
    added: counted.length ? counted.reduce((a, r) => a + n(r.rfps_added), 0) : null,
    rejected: group.reduce((a, r) => a + n(r.rfps_rejected), 0),
    sources: group.length,
  };
}

/**
 * The history split the page shows: screening runs apart from crawls.
 *
 * They answer different questions — "what did this organisation's last screen find" and
 * "when was the shared store last refreshed" — and a single list mixing them reports one
 * as the other. The split is on `source`, which is the only field that distinguishes
 * them; MATCH_RUN_LABEL is passed in rather than imported so the two readers of that
 * constant stay one (api/analytics.ts owns it).
 */
export function splitHistory(rows: Row[], matchLabel: string): {
  screening: Row[]; extraction: Row[];
} {
  const screening: Row[] = [];
  const extraction: Row[] = [];
  for (const r of rows) (s(r.source) === matchLabel ? screening : extraction).push(r);
  return { screening, extraction };
}
