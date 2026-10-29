/**
 * Report, Section 1 — Scan activity. The aggregation half of `views/report.py`'s first
 * section, computed server-side so the rows never leave and there is one implementation of
 * each rule to hold against the Python.
 *
 * EIGHT BLOCKS, AND THEY DO NOT AGREE ABOUT THE PERIOD. That is deliberate and is the main
 * thing a porter can quietly break:
 *
 *   intake        ALL-TIME. "Where this organisation's calls came from" is an intake fact;
 *                 filtering it by the period would make the tiles disagree with the workbook
 *                 somebody is reconciling against. The caption says so.
 *   scans         PERIOD, applied in the QUERY (scan_logs is fetched already filtered).
 *   discovery     PERIOD, applied in memory, and only when a period is active.
 *   donors        PERIOD, same frame as discovery.
 *   focusAreas    ALL-TIME, and Proceed only. A Proceed decision is the durable signal and
 *                 a short period would leave this near-empty.
 *   keywords      PERIOD, same frame as discovery.
 *   sources       PERIOD, from the already-filtered scan_logs.
 *   cycle         ALL-TIME. Discovery-to-submission lag over everything there is.
 *
 * Reconciling those would be the obvious tidy-up and would change numbers a reader has been
 * acting on. The parity check compares every one of them against report.py's own output.
 */
import { q, type Db } from "./db.ts";
import {
  bucketRange, bucketStart, inPeriod, seriesWindow, type BucketMode, type Bounds,
} from "./report_period.ts";
import { extractKeywordFrequencies, programmeAreaFreq } from "./report_keywords.ts";
import { createNames, dominantSpelling, funderKey, type NameConfig } from "./report_names.ts";

/** The columns `_load_rfps` selects. Every monetary field carries its own currency column. */
export const RFP_COLUMNS = [
  "uid", "source", "opportunity_title", "brief_description", "funding_agency",
  "submitted_at", "search_date", "submitted_by", "submitted_by_email",
  "call_submission_deadline", "date_completed", "decision_date", "date_of_approval",
  "decision", "auto_recommendation", "donor_decision", "progress_status", "stage",
  "alignment_score", "call_award_value", "currency",
  "amount_requested", "amount_secured", "currency_secured", "submissions",
  "call_geographic_scope", "call_domain_areas", "decision_overridden_by",
  "proposal_lead", "contributors", "reviewers",
  "lead_applicant", "sub_applicant",
  "is_duplicate", "review_week", "applicant_role",
].join(",");

/** `_SUBMITTED_DECISIONS` — a donor decision that means the proposal went in. */
const SUBMITTED_DECISIONS = new Set(["approved", "under review", "not approved"]);

type Row = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const lower = (v: unknown): string => s(v).trim().toLowerCase();

/**
 * numpy's `round`, which pandas' `.round(1)` uses: HALF TO EVEN, not half away from zero.
 * 0.25 → 0.2, 0.35 → 0.4. JavaScript's `Math.round` and `toFixed` both go half-up, so a
 * yield of exactly 12.25% would read 12.3 here and 12.2 in the report — a difference nobody
 * would ever look for, in a column people compare between the two apps.
 */
export function roundHalfEven(x: number, digits = 1): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  const scaled = x * f;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let n: number;
  if (diff > 0.5) n = floor + 1;
  else if (diff < 0.5) n = floor;
  else n = floor % 2 === 0 ? floor : floor + 1;   // exactly .5 → the even neighbour
  return n / f;
}

/** `_discovery_ts` — search_date, falling back to submitted_at for Excel-migrated rows. */
const discoveryTs = (r: Row): unknown =>
  r.search_date !== null && r.search_date !== undefined ? r.search_date : r.submitted_at;

/** `_submitted_mask`, per row: progress "completed" OR a donor decision on file. */
const isSubmitted = (r: Row): boolean =>
  lower(r.progress_status) === "completed" || SUBMITTED_DECISIONS.has(lower(r.donor_decision));

/** `decision` starting with "proceed" — the asymmetric match report.py uses throughout. */
const isProceed = (r: Row): boolean => lower(r.decision).startsWith("proceed");

const isDuplicate = (r: Row): boolean => r.is_duplicate === true;

/** Python's `str.title()`: first letter of each word up, the rest down. */
const pyTitle = (v: string): string =>
  v.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

/**
 * A stable sort by several keys, descending, over rows already in the order pandas'
 * `groupby` leaves them (keys ascending).
 *
 * TIES ARE ORDERED ALPHABETICALLY HERE AND ARBITRARILY IN report.py, deliberately.
 *
 * pandas sorts a MULTI-column `sort_values` with lexsort, which is stable — so the keyword
 * table (Approved → Submitted → Proceed → Hits) matches exactly. But a SINGLE-column
 * `sort_values` defaults to `kind="quicksort"`, which is not: above numpy's insertion-sort
 * threshold the tie order is whatever introsort's pivots happen to produce. The funder and
 * source charts both sort on one column, so their tie order in report.py is an artefact.
 *
 * That is not merely cosmetic. Both take `.head(15)`, and on live data as of 2026-10-29 four
 * funders are tied at 4 calls with room for one: report.py shows one of them and drops three
 * with exactly the same count, picked by the pivot. Reproducing that would mean porting
 * numpy's introsort, and would make the React chart inherit an arbitrary answer.
 *
 * So this is stable and alphabetical: the same data always draws the same chart. The parity
 * check compares the full grouping exactly and the ranked list tie-insensitively, and names
 * the boundary tie rather than hiding it.
 */
function stableSortDesc<T>(rows: T[], keys: ((r: T) => number)[]): T[] {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => {
    for (const k of keys) {
      const d = k(b.r) - k(a.r);
      if (d) return d;
    }
    return a.i - b.i;
  }).map((x) => x.r);
}

// ── The blocks ───────────────────────────────────────────────────────────────

export type IntakeRow = { source: string; label: string; unique: number; duplicates: number; total: number };

/**
 * "Where this organisation's calls came from" — ALL-TIME, every intake route, duplicates
 * stated beside the unique count.
 *
 * The tile showed unique rows only, so "Excel imported 52" could not be reconciled with the
 * 63 records actually imported: the 11 the dedupe caught were invisible and a reader
 * comparing against the workbook found a shortfall with no explanation. Unique stays the
 * headline because it is what every other figure counts; the duplicates close the arithmetic.
 *
 * Grouped on the LOWERCASED source, so "Auto" and "auto" are one route.
 */
export function intake(rows: Row[]): { total: number; duplicates: number; bySource: IntakeRow[] } {
  const LABELS: Record<string, string> = {
    auto: "System eligibility auto-scan",
    migration: "Excel imported",
    manual: "Manually submitted via platform",
  };
  const by = new Map<string, { total: number; dups: number }>();
  for (const r of rows) {
    // `fillna("(unknown)")` replaces only a MISSING source. An empty string stays empty and
    // groups under "", which is why the label falls back to the key itself rather than to
    // "(unknown)".
    const raw = r.source === null || r.source === undefined ? "(unknown)" : s(r.source).trim();
    const key = raw.toLowerCase();
    const e = by.get(key) ?? { total: 0, dups: 0 };
    e.total += 1;
    if (isDuplicate(r)) e.dups += 1;
    by.set(key, e);
  }
  const keys = [...by.keys()].sort();   // groupby orders keys ascending
  const bySource = stableSortDesc(
    keys.map((k) => {
      const e = by.get(k)!;
      return { source: k, label: LABELS[k] ?? pyTitle(k), unique: e.total - e.dups, duplicates: e.dups, total: e.total };
    }),
    [(x) => x.total],
  );
  return {
    total: bySource.reduce((a, x) => a + x.total, 0),
    duplicates: bySource.reduce((a, x) => a + x.duplicates, 0),
    bySource,
  };
}

export type ScanKpis = {
  runs: number; found: number; eligible: number; added: number | null;
  duplicates: number; rejected: number; errorRuns: number;
};

/**
 * The seven scan tiles, over the period's scan_logs rows.
 *
 * `added` is NULL, not 0, when no run in the period recorded a created count — pre-094 runs
 * and extraction-only crawls, which insert nothing. Zero would be a claim; blank is the
 * truth, and this is the one number here that is deliberately not coerced to 0.
 *
 * `eligible` is `rfps_new`: everything that PASSED THE GATE, merge-updates of already-tracked
 * calls included. It is not "rows inserted" and never was — that is `added`.
 */
export function scanKpis(scans: Row[]): ScanKpis | null {
  if (!scans.length) return null;
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;          // to_numeric(coerce).fillna(0)
  };
  const days = new Set<string>();
  for (const r of scans) {
    const d = s(r.scan_date).slice(0, 10);       // .dt.normalize().nunique() — distinct DAYS
    if (d) days.add(d);
  }
  const added = scans.map((r) => r.rfps_added)
    .filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)))
    .map(Number);
  return {
    runs: days.size,
    found: scans.reduce((a, r) => a + num(r.rfps_found), 0),
    eligible: scans.reduce((a, r) => a + num(r.rfps_new), 0),
    added: added.length ? added.reduce((a, b) => a + b, 0) : null,
    duplicates: scans.reduce((a, r) => a + num(r.rfps_duplicate), 0),
    rejected: scans.reduce((a, r) => a + num(r.rfps_rejected), 0),
    errorRuns: scans.filter((r) => s(r.errors) !== "").length,
  };
}

export type DiscoveryBucket = { bucket: string; total: number; bySubmitter: Record<string, number> };

/**
 * Funding calls discovered over time, stacked by the member who submitted them.
 *
 * NOT ZERO-FILLED when the stack has members. report.py reindexes the plain count against
 * the full bucket range so an empty period draws a flat line, but the STACKED frame is a
 * groupby with no reindex — an empty bucket is simply absent. Both shapes are returned as
 * they are, because filling the stacked one would add bars the Streamlit page does not draw.
 */
export function discovery(
  rows: Row[], view: BucketMode, bounds: Bounds, names: ReturnType<typeof createNames>,
): { buckets: DiscoveryBucket[]; submitters: string[]; zeroFilled: boolean } {
  const dated = rows.filter((r) => r.search_date !== null && r.search_date !== undefined);
  if (!dated.length) return { buckets: [], submitters: [], zeroFilled: false };

  // The display map is built over every canonical name present, BEFORE grouping, so two
  // spellings of one person merge into the single bar they are.
  const canonical = [...new Set(rows.flatMap((r) => names.splitAndNormalizeNames(r.submitted_by)))];
  const display = names.firstNameDisplayMap(canonical);

  const byBucket = new Map<string, Map<string, number>>();
  const submitters = new Set<string>();
  for (const r of dated) {
    const b = bucketStart(r.search_date, view);
    if (!b) continue;
    for (const m of names.splitAndNormalizeNames(r.submitted_by)) {
      const label = display[m] ?? m;
      if (!label) continue;
      const cell = byBucket.get(b) ?? new Map<string, number>();
      cell.set(label, (cell.get(label) ?? 0) + 1);
      byBucket.set(b, cell);
      submitters.add(label);
    }
  }

  if (byBucket.size) {
    const buckets = [...byBucket.keys()].sort().map((bucket) => {
      const cell = byBucket.get(bucket)!;
      const bySubmitter = Object.fromEntries([...cell.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
      return { bucket, total: [...cell.values()].reduce((a, b) => a + b, 0), bySubmitter };
    });
    return { buckets, submitters: [...submitters].sort(), zeroFilled: false };
  }

  // No submitter survived normalisation → report.py falls back to the PLAIN bucketed count,
  // which IS reindexed against the full range, so empty buckets render as zero.
  const counts = new Map<string, number>();
  for (const r of dated) {
    const b = bucketStart(r.search_date, view);
    if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const win = seriesWindow(bounds, dated.map((r) => s(r.search_date)));
  const full = win.start && win.end ? bucketRange(win.start, win.end, view) : [];
  const keys = full.length ? full : [...counts.keys()].sort();
  return {
    buckets: keys.map((bucket) => ({ bucket, total: counts.get(bucket) ?? 0, bySubmitter: {} })),
    submitters: [], zeroFilled: full.length > 0,
  };
}

export type DonorRow = { donor: string; rfps: number };

/**
 * Funding calls by donor, top 15, grouped by funder IDENTITY rather than literal string.
 *
 * "BMGF - Gates Foundation" and "BMGF – Gates Foundation" (en dash, which Excel autocorrect
 * produces) are one funder. Counting the spellings apart drew it as two shorter bars and
 * understated a funder the organisation has a real relationship with. The label is the
 * spelling that appears most often, so the chart stays in the organisation's own words.
 */
export function donors(rows: Row[]): { all: Record<string, number>; top: DonorRow[] } {
  const groups = new Map<string, unknown[]>();
  for (const r of rows) {
    // fillna("(unspecified)") then replace("", "(unspecified)") — both a missing funder and
    // an empty one land on the same label.
    const raw = r.funding_agency === null || r.funding_agency === undefined || s(r.funding_agency) === ""
      ? "(unspecified)" : s(r.funding_agency);
    const key = funderKey(raw);
    const g = groups.get(key);
    if (g) g.push(raw); else groups.set(key, [raw]);
  }
  const ordered = [...groups.keys()].sort().map((k) => ({
    donor: dominantSpelling(groups.get(k)!), rfps: groups.get(k)!.length,
  }));
  return {
    all: Object.fromEntries(ordered.map((x) => [x.donor, x.rfps])),
    top: stableSortDesc(ordered, [(x) => x.rfps]).slice(0, 15),
  };
}

export type KeywordRow = { keyword: string; hits: number; proceed: number; submitted: number; approved: number };

/**
 * Which topics convert — the same curated vocabulary as the focus-area cloud, broken out by
 * Proceed / Submitted / Approved.
 *
 * PRESENCE PER CALL, not token count: a call saying "AI" twice is one AI hit, because the
 * question is how often calls mentioning a topic progressed, not how often the word appears.
 * Sorted Approved → Submitted → Proceed → Hits, top 50.
 */
export function keywordSuccess(rows: Row[]): KeywordRow[] {
  const agg = new Map<string, KeywordRow>();
  for (const r of rows) {
    const text = `${s(r.opportunity_title)} ${s(r.brief_description)}`;
    if (!text.trim()) continue;
    const stems = Object.keys(extractKeywordFrequencies([text]));
    if (!stems.length) continue;
    const p = isProceed(r), sub = isSubmitted(r), app = lower(r.donor_decision) === "approved";
    for (const kw of stems) {
      const e = agg.get(kw) ?? { keyword: kw, hits: 0, proceed: 0, submitted: 0, approved: 0 };
      e.hits += 1;
      if (p) e.proceed += 1;
      if (sub) e.submitted += 1;
      if (app) e.approved += 1;
      agg.set(kw, e);
    }
  }
  const ordered = [...agg.keys()].sort().map((k) => agg.get(k)!);
  return stableSortDesc(ordered, [(x) => x.approved, (x) => x.submitted, (x) => x.proceed, (x) => x.hits])
    .slice(0, 50);
}

export type SourceRow = {
  source: string; runs: number; found: number; added: number; rejected: number;
  avgDur: number | null; yieldPct: number;
};

/**
 * Top 15 sources by new-call yield. The one block here that really is scan-log-derived.
 *
 * `found.replace(0, 1)` guards the division: a source that found nothing reads 0% rather than
 * dividing by zero. Only an exact 0 is replaced, so the guard cannot touch a real count.
 */
export function sources(scans: Row[]): { all: Record<string, SourceRow>; top: SourceRow[] } {
  if (!scans.length) return { all: {}, top: [] };
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const by = new Map<string, { runs: number; found: number; added: number; rejected: number; durs: number[] }>();
  for (const r of scans) {
    const key = s(r.source);
    const e = by.get(key) ?? { runs: 0, found: 0, added: 0, rejected: 0, durs: [] };
    // runs=("scan_date", "count") — count skips nulls.
    if (r.scan_date !== null && r.scan_date !== undefined) e.runs += 1;
    e.found += num(r.rfps_found);
    e.added += num(r.rfps_new);
    e.rejected += num(r.rfps_rejected);
    const d = Number(r.duration_sec);
    if (r.duration_sec !== null && r.duration_sec !== undefined && Number.isFinite(d)) e.durs.push(d);
    by.set(key, e);
  }
  const ordered = [...by.keys()].sort().map((k) => {
    const e = by.get(k)!;
    const mean = e.durs.length ? e.durs.reduce((a, b) => a + b, 0) / e.durs.length : null;
    return {
      source: k, runs: e.runs, found: e.found, added: e.added, rejected: e.rejected,
      avgDur: mean === null ? null : roundHalfEven(mean, 1),
      yieldPct: roundHalfEven((e.added / (e.found === 0 ? 1 : e.found)) * 100, 1),
    };
  });
  return {
    all: Object.fromEntries(ordered.map((x) => [x.source, x])),
    top: stableSortDesc(ordered, [(x) => x.added]).slice(0, 15),
  };
}

export type Cycle = { n: number; median: number; mean: number; min: number; max: number; days: number[] };

/**
 * Discovery → submission lag, in days. ALL-TIME, non-duplicates, both dates present.
 *
 * Negative spans are dropped: a `date_completed` before the `search_date` is a data-entry
 * artefact from the Excel migration, not a proposal submitted before it was found, and
 * leaving it in drags the mean below what any reader would recognise.
 */
export function cycle(rows: Row[]): Cycle | null {
  const days: number[] = [];
  for (const r of rows) {
    const sd = s(r.search_date).slice(0, 10), dc = s(r.date_completed).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sd) || !/^\d{4}-\d{2}-\d{2}$/.test(dc)) continue;
    const n = Math.round((Date.parse(`${dc}T00:00:00Z`) - Date.parse(`${sd}T00:00:00Z`)) / 86400_000);
    if (n >= 0) days.push(n);
  }
  if (!days.length) return null;
  const sorted = [...days].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  // numpy's median: the average of the two middle values for an even count.
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    n: days.length, median,
    mean: days.reduce((a, b) => a + b, 0) / days.length,
    min: sorted[0], max: sorted[sorted.length - 1], days,
  };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export type Section1Input = {
  rfps: Row[];
  scans: Row[];
  view: BucketMode;
  bounds: Bounds;
  nameConfig: NameConfig;
};

/** Every block, with each one's own period rule applied where report.py applies it. */
export function buildSection1(input: Section1Input) {
  const { rfps, scans, view, bounds, nameConfig } = input;
  const names = createNames(nameConfig);
  const periodActive = bounds.start !== null;

  const nonDup = rfps.filter((r) => !isDuplicate(r));
  // `disc`: non-duplicates, narrowed to the period ONLY when one is active. The date tested
  // is `_discovery_ts` — search_date, or submitted_at where the Excel migration left none —
  // so a row can be in the period on its submitted_at while still having NO search_date, and
  // the time series then skips it. That is why `discovery` filters on search_date again.
  const disc = periodActive
    ? nonDup.filter((r) => inPeriod(discoveryTs(r), bounds))
    : nonDup;
  const proceedAll = nonDup.filter(isProceed);

  const freq = programmeAreaFreq(proceedAll as { call_domain_areas?: unknown }[]);
  const focusAreas = Object.entries(freq)
    .map(([area, calls]) => ({ area, calls }))
    .sort((a, b) => (b.calls - a.calls) || (a.area < b.area ? -1 : a.area > b.area ? 1 : 0));

  return {
    intake: intake(rfps),                       // ALL-TIME, duplicates included
    scans: scanKpis(scans),                     // period, filtered in the query
    discovery: discovery(disc, view, bounds, names),
    donors: donors(disc),
    focusAreas,                                 // ALL-TIME, Proceed only
    proceedCount: proceedAll.length,
    keywordSuccess: keywordSuccess(disc),
    sources: sources(scans),
    cycle: cycle(nonDup),                       // ALL-TIME
  };
}

/**
 * Load the two frames Section 1 needs.
 *
 * scan_logs is filtered IN THE QUERY, rfp_submissions is not — report.py loads all 50,000 and
 * filters in memory, because the intake tiles and the cycle time are all-time and would be
 * wrong against a period-filtered fetch.
 *
 * The end bound on scan_date is `end + 1 day` with `lte`: scan_date is a timestamp, and
 * `lte(end)` would drop every run after midnight on the final day.
 *
 * SCAN_LOGS IS NOT TENANT-SCOPED BY RLS. Migration 098 made it read-only for `authenticated`
 * with no tenant predicate, so the session's own token returns every tenant's runs plus the
 * system-wide discovery crawl (tenant_id NULL). `_load_scan_logs` narrows it in Python and
 * this has to do the same, or one tenant's Activity Report would count another's scans and
 * the shared crawl's 25,000 discovered rows would swamp every tile on the page.
 *
 * A super_user is deliberately NOT narrowed — they are shown everything, which is what the
 * Python's `not is_super_user(...)` means. Rows with a NULL tenant_id drop out for everyone
 * else: the shared crawl is not any one tenant's activity.
 */
export async function loadSection1(db: Db, scope: Parameters<Db["as"]>[0], bounds: Bounds) {
  let scanQuery = "select=*";
  if (bounds.start) scanQuery += `&scan_date=gte.${q(bounds.start)}`;
  if (bounds.end) {
    const next = new Date(Date.parse(`${bounds.end}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
    scanQuery += `&scan_date=lte.${q(next)}`;
  }
  // getAll, not get: PostgREST returns at most 1000 rows per request however large a limit
  // is asked for. `scan_logs` passed a thousand long ago — 3,082 rows on 2026-10-29, of
  // which the page saw 1,000 — so every scan tile was a partial sum presented as a total.
  // `rfp_submissions` still fits, which is exactly why it had to change too: at 1,001 rows
  // every figure in this section would have started under-counting silently, and nobody
  // would have connected the two events.
  const [rfps, scansRaw] = await Promise.all([
    db.as(scope).getAll("rfp_submissions", `select=${RFP_COLUMNS}`, "uid"),
    db.as(scope).getAll("scan_logs", scanQuery, "id"),
  ]);
  const tid = db.scopeTid(scope);
  const mine = scope.isSuper || /^0{8}-/.test(tid)
    ? (scansRaw as Row[])
    : (scansRaw as Row[]).filter((r) => s(r.tenant_id) === tid);
  return { rfps: rfps as Row[], scans: mine };
}
