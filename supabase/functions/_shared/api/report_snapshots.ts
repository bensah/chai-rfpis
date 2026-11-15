/**
 * Report snapshots (core/report_snapshots.py) — the `?r=YYYYMMDD-NNNNNN` store.
 *
 * A generated report keeps its whole selection — period, view, sections, metrics — server
 * side under a short id, so the URL is a neat shareable link AND the report survives a
 * refresh or a dropped connection. Opening `?r=<id>` restores the exact selection.
 *
 * THREE PROPERTIES OF THE STORE, inherited and deliberately not changed here:
 *
 *   1. It is ONE row. Every snapshot lives in `app_settings.report_snapshots_json`, a single
 *      JSON object. Two Generates landing together is a read-modify-write race and the
 *      loser's snapshot is gone — last write wins.
 *   2. It is GLOBAL, not per tenant. `report_snapshots_json` is not in
 *      `core.settings._TENANT_SCOPED_KEYS`, so every tenant reads and writes the same
 *      object: a link minted in one tenant resolves in another, and one tenant's Generates
 *      push another's out of the window. The snapshot holds only a selection — periods and
 *      metric keys, no rows — so this leaks no data, but the capacity is shared.
 *   3. It holds the newest 100. Beyond that the oldest by `created_at` are dropped, which
 *      is what "that link says the report wasn't found" means.
 *
 * Scoping it per tenant would break every `?r=` link already in circulation, so it stays as
 * it is until someone decides to migrate them. See check-snapshots.mjs, which asserts all
 * three so none of them can drift closed unnoticed.
 *
 * Everything with a rule in it is a pure function over a plain object here: the db round
 * trip is a read, a merge and a write with no decisions of its own. That is what lets the
 * parity check drive the real `core/report_snapshots.py` against this without going
 * anywhere near the live row.
 */
import { q, type Db } from "./db.ts";

/** `core.report_snapshots._KEY` — the single `app_settings` row every snapshot shares. */
export const SNAPSHOT_KEY = "report_snapshots_json";

/** `core.report_snapshots._MAX` — how many are kept before the oldest are pruned. */
export const SNAPSHOT_MAX = 100;

export type SnapshotEntry = {
  created_at: string;
  selection: Record<string, unknown>;
};

export type SnapshotStore = Record<string, SnapshotEntry>;

// ── The section / metric catalogue ───────────────────────────────────────────
//
// `views/report.py::_REPORT_SECTIONS`. The server owns it for the same reason it owns the
// period options: a snapshot records which metric keys were ON, and restoring one has to
// compare that list against the keys that exist NOW. If the browser held its own copy, a
// deploy could leave the page restoring against a different universe from the one the
// snapshot is judged by, which is precisely the "the chart quietly vanished" bug that
// `restoreItems` exists to fix.
//
// The ids are NOT the display order: section "4" is shown second and "2" third. They are
// the ids the stored snapshots already carry, so they cannot be renumbered.

export type ReportSection = {
  id: string;
  label: string;
  items: ReadonlyArray<{ key: string; label: string }>;
};

export const REPORT_SECTIONS: ReadonlyArray<ReportSection> = [
  {
    id: "1",
    label: "1 · Scan activity",
    items: [
      { key: "s1_discovery", label: "Funding discovered by member" },
      { key: "s1_donor", label: "Funding by donor (top 15)" },
      { key: "s1_keywords", label: "Search keyword cloud" },
      { key: "s1_kw_success", label: "Keywords driving success" },
      { key: "s1_sources", label: "Top sources by yield" },
      { key: "s1_cycle", label: "Search → Submission cycle time" },
    ],
  },
  {
    id: "4",
    label: "2 · Team & partners",
    items: [
      { key: "s4_eng_ts", label: "Donor engagements over time" },
      { key: "s4_topdonors", label: "Top donors by touchpoints" },
      { key: "s4_leads", label: "Proposal leads" },
      { key: "s4_contrib", label: "Contributors" },
      { key: "s4_partners", label: "Lead & sub applicant partners" },
    ],
  },
  {
    id: "2",
    label: "3 · Insights — status & eligibility funnel",
    items: [
      { key: "s2_funnel", label: "Conversion funnel" },
      { key: "s2_progress", label: "Progress status" },
    ],
  },
  {
    id: "3",
    label: "4 · Reviews & decisions",
    items: [
      { key: "s3_decdist", label: "Decision distribution" },
      { key: "s3_dectime", label: "Decisions over time" },
      { key: "s3_autorec", label: "Auto-recommendation vs decision" },
      { key: "s3_donordec", label: "Donor decisions" },
    ],
  },
  {
    id: "5",
    label: "5 · Our results",
    items: [
      { key: "s5_cumusd", label: "Cumulative USD secured" },
      { key: "s5_grants", label: "Applied Funding pipeline" },
      { key: "s5_reqsec", label: "Requested vs secured" },
      { key: "s5_conv", label: "Conversion rates" },
    ],
  },
];

/** `_ALL_KEYS` — every metric key, in catalogue order. */
export const ALL_KEYS: ReadonlyArray<string> = REPORT_SECTIONS.flatMap((s) =>
  s.items.map((i) => i.key)
);

/** `_ALL_SEC_IDS` — every section id, in catalogue order. */
export const ALL_SEC_IDS: ReadonlyArray<string> = REPORT_SECTIONS.map((s) => s.id);

// ── Restoring a selection ────────────────────────────────────────────────────

/**
 * `core.report_snapshots.restore_items` — which metrics a restored report shows.
 *
 * A snapshot records the metrics that were ON. It does not, on its own, record which
 * metrics EXISTED, so a metric added to the report after the snapshot was saved is simply
 * absent from it — indistinguishable from one the author deliberately switched off. Older
 * snapshots came back with the checkbox unticked and the chart gone, which is what "charts
 * went missing" was.
 *
 * Newer snapshots carry their key universe (`all_items`), which settles it exactly:
 * anything inside that universe but not in `items` was switched off and stays off, anything
 * outside it did not exist yet and comes back ON.
 *
 * For a snapshot with no universe the ambiguity is real and is resolved one way — an
 * unknown key is treated as ON, matching the page's own "everything defaults to on". The
 * cost is that a deliberate de-selection in a pre-`all_items` snapshot is not preserved.
 * That is the accepted trade: the alternative silently drops content the reader cannot
 * discover is missing.
 *
 * Note the asymmetry with `restoreSecs` below, which is NOT the same rule.
 */
export function restoreItems(
  savedItems: unknown,
  allKeys: ReadonlyArray<string>,
  savedUniverse: unknown,
): string[] {
  const all = new Set(allKeys ?? []);
  // `if not isinstance(saved_items, list): return set(all_keys)` — nothing saved is
  // everything on, and so is a snapshot whose `items` is null or a string.
  if (!Array.isArray(savedItems)) return [...all];
  const kept = new Set(savedItems.filter((k): k is string => typeof k === "string" && all.has(k)));
  // `universe = set(saved_universe) if isinstance(saved_universe, list) else set(kept)` —
  // with no recorded universe, the kept keys ARE the universe, so every other key is
  // "added later" and comes back on.
  const universe = Array.isArray(savedUniverse) ? new Set(savedUniverse.map(String)) : new Set(kept);
  const out = new Set(kept);
  for (const k of all) if (!universe.has(k)) out.add(k);
  return [...out];
}

/**
 * `views/report.py:_restored_secs` — which SECTIONS a restored report shows.
 *
 * Deliberately not `restoreItems`: a section id the snapshot does not list stays OFF, even
 * when it did not exist when the snapshot was saved. So a whole new section is hidden on
 * every older snapshot, where a new metric inside an existing section is shown.
 *
 * That asymmetry is the page's, not a port decision, and it is asserted by name in
 * check-snapshots.mjs. It has not bitten yet because no section has been added since the
 * feature shipped; it will the day one is.
 *
 * Order is the SNAPSHOT's, not the catalogue's — `[s for s in _secs_saved if s in ...]`.
 */
export function restoreSecs(savedSecs: unknown, allSecIds: ReadonlyArray<string>): string[] {
  const all = new Set(allSecIds ?? []);
  if (!Array.isArray(savedSecs)) return [...(allSecIds ?? [])];
  return savedSecs.filter((s): s is string => typeof s === "string" && all.has(s));
}

/**
 * `views/report.py:_snap_sig` / `_cur_sig` — the comparison behind "✎ Selections changed".
 *
 * It is built from the RAW stored values, not the restored ones. That matters: restoring an
 * older snapshot switches newly-added metrics ON (see `restoreItems`), so the restored
 * selection legitimately differs from the saved one and the page says "changed" the moment
 * it opens. Reproduced rather than smoothed over, because the banner is telling the truth —
 * re-Generating really would save something different from what the link holds.
 *
 * Returns null where the Python cannot build a signature at all. `int(_sel("year", 0))`
 * raises TypeError on a stored `"year": null`, which takes the whole page down rather than
 * falling back; here that snapshot simply reads as "always changed". A selection written by
 * either the widgets or POST /report/snapshot is always an int, so this is reachable only
 * through a hand-edited row.
 */
export function signatureOf(raw: Record<string, unknown> | null | undefined): string | null {
  if (!raw) return null;
  const year = Number.parseInt(String(raw.year ?? 0), 10);
  if (!Number.isFinite(year)) return null;
  const list = (v: unknown): string[] =>
    (Array.isArray(v) ? v.map(String) : []).slice().sort();
  return JSON.stringify([
    raw.period ?? null,
    year,
    raw.month ?? null,
    raw.view ?? null,
    list(raw.secs),
    list(raw.items),
  ]);
}

// ── The store ────────────────────────────────────────────────────────────────

/**
 * `core.report_snapshots._load` — the stored object, or an empty one.
 *
 * Unset, unparseable and "parsed to something that is not an object" all read as empty. A
 * JSON array parses fine and is not a dict, so it is empty too; in JS `typeof [] === "object"`,
 * hence the explicit Array check.
 */
export function parseStore(raw: unknown): SnapshotStore {
  if (raw === null || raw === undefined || raw === "") return {};
  try {
    const d = JSON.parse(String(raw));
    return d && typeof d === "object" && !Array.isArray(d) ? d as SnapshotStore : {};
  } catch {
    return {};
  }
}

/**
 * A free `YYYYMMDD-NNNNNN` id. `rand` returns an integer in [0, 999999] — injected so the
 * parity check can make the whole mint deterministic.
 *
 * The Python mints one BEFORE the loop and the loop re-checks it, so there are 21 candidates
 * in all, and the 21st is used whether or not it collides. At 100 live ids out of a million
 * per day a single collision is already a once-in-a-very-long-time event; twenty-one in a
 * row is not a case worth a different outcome.
 */
export function mintRid(store: SnapshotStore, today: string, rand: () => number): string {
  const six = () => String(rand() % 1000000).padStart(6, "0");
  let rid = `${today}-${six()}`;
  for (let i = 0; i < 20; i++) {
    if (!(rid in store)) break;
    rid = `${today}-${six()}`;
  }
  return rid;
}

/**
 * Add one snapshot and prune back to `max`, returning a NEW object.
 *
 * The prune keeps the newest `max` by `created_at` compared AS TEXT — which is why the
 * timestamp is written as ISO. A missing `created_at` reads as `""` and sorts last, so an
 * entry without one is the first to go. Ties keep insertion order: Python's
 * `sorted(reverse=True)` is stable, and so is this comparator, which returns 0 for equal
 * timestamps rather than reversing a sorted-ascending list.
 */
export function insertSnapshot(
  store: SnapshotStore,
  rid: string,
  createdAt: string,
  selection: Record<string, unknown>,
  max: number = SNAPSHOT_MAX,
): SnapshotStore {
  const d: SnapshotStore = { ...store, [rid]: { created_at: createdAt, selection } };
  const keys = Object.keys(d);
  if (keys.length <= max) return d;
  const ts = (k: string) => String(d[k]?.created_at ?? "");
  const keep = keys
    .slice()
    .sort((a, b) => (ts(a) < ts(b) ? 1 : ts(a) > ts(b) ? -1 : 0))
    .slice(0, max);
  const out: SnapshotStore = {};
  for (const k of keep) out[k] = d[k];
  return out;
}

/**
 * The timestamp a new snapshot carries. `datetime.now().isoformat(timespec="seconds")` —
 * no timezone marker, second resolution.
 *
 * The Python writes its HOST's local wall clock; an Edge Function has no local zone, so
 * this is UTC. The two only ever meet inside the prune's text comparison, so a deployment
 * whose Python host is not on UTC would order a mixed store by two different clocks and
 * could drop a snapshot a few hours early or late. Not worth a stored offset: the same
 * string format is what keeps old entries sortable at all.
 */
export const nowStamp = (d: Date = new Date()): string => d.toISOString().slice(0, 19);

/** `date.today().strftime("%Y%m%d")`, in the same clock as `nowStamp`. */
export const todayStamp = (d: Date = new Date()): string =>
  d.toISOString().slice(0, 10).replace(/-/g, "");

// ── The db round trip ────────────────────────────────────────────────────────

/** Read the shared row. Service role: the store is global and has no RLS story of its own. */
export async function loadStore(db: Db): Promise<SnapshotStore> {
  const rows = await db.service
    .get("app_settings", `select=value&key=eq.${q(SNAPSHOT_KEY)}&limit=1`)
    .catch(() => [] as Array<Record<string, unknown>>);
  return parseStore(rows[0]?.value);
}

/** `get_snapshot` — the stored selection for `rid`, or null. */
export function getSelection(
  store: SnapshotStore,
  rid: string | null | undefined,
): Record<string, unknown> | null {
  if (!rid) return null;
  const entry = store[rid];
  if (!entry) return null;
  const sel = entry.selection;
  return sel && typeof sel === "object" && !Array.isArray(sel)
    ? sel as Record<string, unknown>
    : null;
}

/**
 * `save_snapshot` — persist a selection, return its id.
 *
 * Read, merge, write: the window between the read and the write is the race described at
 * the top of this file. It is not closed here because closing it means either a second
 * store or a lock, and the loser of the race today is one unsaved link rather than any
 * data — the report itself is recomputed from the rows on every open.
 */
export async function saveSnapshot(
  db: Db,
  selection: Record<string, unknown>,
  updatedBy: string | null,
): Promise<{ rid: string; createdAt: string }> {
  const store = await loadStore(db);
  const now = new Date();
  const rid = mintRid(store, todayStamp(now), () => Math.floor(Math.random() * 1000000));
  const createdAt = nowStamp(now);
  const next = insertSnapshot(store, rid, createdAt, selection);
  await db.service.upsert(
    "app_settings",
    { key: SNAPSHOT_KEY, value: JSON.stringify(next), updated_by: updatedBy },
    "key",
  );
  return { rid, createdAt };
}
