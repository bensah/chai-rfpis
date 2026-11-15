/**
 * Report, Section 2 as displayed — "Team & Partnership Activity", section id **4**.
 *
 * The id and the position differ, and that is load-bearing: snapshots persist the id, so
 * the file is named for the display position and every lookup uses `"4"`.
 *
 * Everything here is about WHO does the work and WHO we do it with. Six blocks:
 *
 *   meetings      internal review items — logged, open, resolved, % unresolved
 *   donors        donor engagements — count, distinct donors, depth, tied to an RFP
 *   engagements   those engagements over time, bucketed
 *   topDonors     top 10 by touchpoints, with the engagement types joined
 *   leads         proposal leads, stacked Submitted / Unsubmitted, top 15
 *   contributors  the same for contributors
 *   partners      lead and sub applicants, canonicalised, top 10 each
 *
 * THE PERIOD IS APPLIED IN THE QUERY for meetings and engagements, and NOT AT ALL for the
 * RFP-derived blocks. `meeting_logs` and `engagement_logs` are fetched with `gte`/`lte`
 * bounds; the people and partner charts run over every Proceed row there is. That asymmetry
 * is report.py's and is not an oversight to correct here.
 */
import { q, type Db } from "./db.ts";
import { bucketRange, bucketStart, seriesWindow, type BucketMode, type Bounds } from "./report_period.ts";
import { createNames, type NameConfig } from "./report_names.ts";
import { splitOrgs, type OrgIdentity } from "./report_partners.ts";

type Row = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const lower = (v: unknown): string => s(v).trim().toLowerCase();

/** `_submitted_mask`, per row: progress "completed" OR a donor decision on file. */
const SUBMITTED_DECISIONS = new Set(["approved", "under review", "not approved"]);
const isSubmitted = (r: Row): boolean =>
  lower(r.progress_status) === "completed" || SUBMITTED_DECISIONS.has(lower(r.donor_decision));

/**
 * A stable sort by one key, descending, over rows already in groupby order.
 *
 * pandas' single-column `sort_values` and `value_counts` are NOT stable above numpy's
 * insertion-sort threshold, so report.py's tie order in these top-N cuts is an introsort
 * artefact. This sorts stably with an alphabetical tie-break, as Section 1 does and for the
 * same reason: the same data should always draw the same chart. The parity check compares
 * the count sequence and the membership above the tie band, not the raw order.
 */
function topBy<T>(rows: T[], value: (r: T) => number, n: number): T[] {
  return rows.map((r, i) => ({ r, i }))
    .sort((a, b) => (value(b.r) - value(a.r)) || (a.i - b.i))
    .slice(0, n).map((x) => x.r);
}

// ── Blocks ───────────────────────────────────────────────────────────────────

export type MeetingKpis = { logged: number; open: number; resolved: number; pctUnresolved: number };

/** Internal review meetings and the actions they raised. */
export function meetingKpis(meetings: Row[]): MeetingKpis {
  const logged = meetings.length;
  // `is_resolved` is summed as a boolean in pandas after fillna(False), so only an actual
  // true counts — a null is unresolved, which is the cautious reading of follow-up debt.
  const resolved = meetings.filter((r) => r.is_resolved === true).length;
  const open = logged - resolved;
  return { logged, open, resolved, pctUnresolved: logged > 0 ? (open / logged) * 100 : 0 };
}

export type DonorKpis = { engagements: number; donors: number; avgPerDonor: number; tiedToRfp: number };

/** Donor conversations and how far they reached. */
export function donorKpis(engagements: Row[]): DonorKpis {
  const n = engagements.length;
  // nunique() skips nulls; a blank string is a value and counts as its own donor, which is
  // what the Python does and is visible as an empty bar rather than silently folded away.
  const donors = new Set(engagements.filter((r) => r.donor !== null && r.donor !== undefined)
    .map((r) => s(r.donor))).size;
  const tied = engagements.filter((r) => r.linked_rfp_uid !== null && r.linked_rfp_uid !== undefined).length;
  return { engagements: n, donors, avgPerDonor: donors > 0 ? n / donors : 0, tiedToRfp: tied };
}

export type Bucketed = { bucket: string; count: number };

/**
 * Engagements over time. `_bucketed_count` with the period as the window, so empty buckets
 * are zero-filled and a quiet period draws a flat line rather than vanishing.
 */
export function engagementSeries(engagements: Row[], view: BucketMode, bounds: Bounds): Bucketed[] {
  const dates = engagements.map((r) => s(r.engagement_date)).filter((d) => d !== "");
  if (!dates.length) return [];
  const counts = new Map<string, number>();
  for (const d of dates) {
    const b = bucketStart(d, view);
    if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const win = seriesWindow(bounds, dates);
  const full = win.start && win.end ? bucketRange(win.start, win.end, view) : [];
  const keys = full.length ? full : [...counts.keys()].sort();
  return keys.map((bucket) => ({ bucket, count: counts.get(bucket) ?? 0 }));
}

export type TopDonor = { donor: string; touchpoints: number; types: string };

/**
 * Top 10 donors by touchpoints.
 *
 * `touchpoints` counts rows with a non-null `engagement_date` — it is `count` on that
 * column, not `size`, so an engagement logged without a date does not count toward depth
 * even though it counted toward the KPI above. The two numbers can therefore disagree, and
 * they disagree in report.py too.
 *
 * `types` is the distinct non-empty engagement types, sorted, joined, then **truncated to 80
 * characters** — a display cap that lands in the data, so it is reproduced exactly rather
 * than tidied into something a reader would not recognise.
 */
export function topDonors(engagements: Row[]): { all: Record<string, TopDonor>; top: TopDonor[] } {
  const by = new Map<string, { touchpoints: number; types: Set<string> }>();
  for (const r of engagements) {
    if (r.donor === null || r.donor === undefined) continue;   // groupby drops null keys
    const key = s(r.donor);
    const e = by.get(key) ?? { touchpoints: 0, types: new Set<string>() };
    if (r.engagement_date !== null && r.engagement_date !== undefined) e.touchpoints += 1;
    const t = s(r.engagement_type);
    if (t) e.types.add(t);                                      // filter(None, x)
    by.set(key, e);
  }
  const ordered = [...by.keys()].sort().map((donor) => {
    const e = by.get(donor)!;
    return { donor, touchpoints: e.touchpoints, types: [...e.types].sort().join(", ").slice(0, 80) };
  });
  // `all` is the whole grouping, order-free, which is where the real logic is; `top` is the
  // chart's cut, whose tie order is a pandas artefact. The parity check needs both.
  return { all: Object.fromEntries(ordered.map((x) => [x.donor, x])), top: topBy(ordered, (x) => x.touchpoints, 10) };
}

export type PersonStack = { name: string; submitted: number; unsubmitted: number; total: number };

/**
 * One people-vs-status chart: proposal leads, or contributors.
 *
 * `proposal_lead` is free text that may hold one name or a comma-separated list;
 * `contributors` is a Postgres text[] whose elements can themselves carry comma-separated
 * names from sloppy form submissions. `splitAndNormalizeNames` handles both, and the
 * per-row set means ONE RFP NEVER COUNTS THE SAME PERSON TWICE.
 *
 * Both halves of every bar are returned even when one is zero. report.py forces them to
 * exist so the legend stays stable and the bars stay visually comparable; dropping a zero
 * would make two people's bars mean different things.
 */
export function peopleStack(
  rows: Row[], col: "proposal_lead" | "contributors", names: ReturnType<typeof createNames>,
): { all: Record<string, PersonStack>; top: PersonStack[] } {
  const mentions: { name: string; submitted: boolean }[] = [];
  for (const r of rows) {
    const sub = isSubmitted(r);
    // sorted(set(...)) per RFP — the dedupe is per row, before any grouping.
    for (const m of [...new Set(names.splitAndNormalizeNames(r[col]))].sort()) {
      if (m !== "") mentions.push({ name: m, submitted: sub });
    }
  }
  if (!mentions.length) return { all: {}, top: [] };
  const display = names.firstNameDisplayMap(mentions.map((m) => m.name));
  const by = new Map<string, { submitted: number; unsubmitted: number }>();
  for (const m of mentions) {
    const label = display[m.name] ?? m.name;
    const e = by.get(label) ?? { submitted: 0, unsubmitted: 0 };
    if (m.submitted) e.submitted += 1; else e.unsubmitted += 1;
    by.set(label, e);
  }
  const ordered = [...by.keys()].sort().map((name) => {
    const e = by.get(name)!;
    return { name, submitted: e.submitted, unsubmitted: e.unsubmitted, total: e.submitted + e.unsubmitted };
  });
  return { all: Object.fromEntries(ordered.map((x) => [x.name, x])), top: topBy(ordered, (x) => x.total, 15) };
}

export type PartnerCount = { org: string; rfps: number };

/** Lead or sub applicants over the Proceed rows, canonicalised, top 10. */
export function partners(rows: Row[], col: "lead_applicant" | "sub_applicant", org: OrgIdentity): { all: Record<string, number>; top: PartnerCount[] } {
  const by = new Map<string, number>();
  for (const r of rows) {
    for (const o of splitOrgs(r[col], org)) {       // already de-duped per RFP and sorted
      if (o.trim() !== "") by.set(o, (by.get(o) ?? 0) + 1);
    }
  }
  const ordered = [...by.keys()].sort().map((o) => ({ org: o, rfps: by.get(o)! }));
  return { all: Object.fromEntries(ordered.map((x) => [x.org, x.rfps])), top: topBy(ordered, (x) => x.rfps, 10) };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export type Section2Input = {
  rfps: Row[];
  meetings: Row[];
  engagements: Row[];
  view: BucketMode;
  bounds: Bounds;
  nameConfig: NameConfig;
  org: OrgIdentity;
};

export function buildSection2(input: Section2Input) {
  const { rfps, meetings, engagements, view, bounds, nameConfig, org } = input;
  const names = createNames(nameConfig);

  // `activity_rows`: non-duplicates whose decision starts with "proceed".
  //
  // NOTE THE MISSING `.strip()`. Section 1's Proceed filter is
  // `.fillna("").str.strip().str.lower().str.startswith("proceed")`; this one is
  // `.fillna("").str.lower().str.startswith("proceed")`. A decision stored with a LEADING
  // SPACE is counted by Section 1 and skipped here. That is a real inconsistency in
  // report.py, and copying it is the point: the two sections would otherwise report
  // different populations from the same database for a reason no reader could find.
  const activity = rfps.filter((r) =>
    r.is_duplicate !== true && s(r.decision).toLowerCase().startsWith("proceed"));

  return {
    meetings: meetingKpis(meetings),
    donors: donorKpis(engagements),
    engagements: engagementSeries(engagements, view, bounds),
    topDonors: topDonors(engagements),
    leads: peopleStack(activity, "proposal_lead", names),
    contributors: peopleStack(activity, "contributors", names),
    partners: {
      lead: partners(activity, "lead_applicant", org),
      sub: partners(activity, "sub_applicant", org),
    },
    proceedRows: activity.length,
  };
}

/**
 * The deploying organisation's own names — `core/settings.py::get_org`.
 *
 * With a tenant, `tenants.name` is the display name and wins over `org_identity.org_name`,
 * because the Organization editor's "Organization name" field IS the tenant rename. Without
 * one, the global `app_settings` keys answer. The placeholder defaults are the Python's, so
 * an unconfigured deployment canonicalises against the same strings rather than against "".
 */
export async function loadOrgIdentity(db: Db, tenantId: string | null): Promise<OrgIdentity> {
  const DEFAULTS = { full: "Your Organization", short: "Org" };
  if (tenantId) {
    const rows = await db.service.get("tenants",
      `select=name,org_identity&id=eq.${q(tenantId)}&limit=1`).catch(() => [] as Row[]);
    if (rows.length) {
      const ident = (rows[0].org_identity && typeof rows[0].org_identity === "object"
        ? rows[0].org_identity : {}) as Row;
      return {
        full: s(rows[0].name) || s(ident.org_name) || DEFAULTS.full,
        short: s(ident.org_short) || DEFAULTS.short,
      };
    }
  }
  const [nameRows, shortRows] = await Promise.all([
    db.service.get("app_settings", `select=value&key=eq.${q("org_name")}&limit=1`).catch(() => [] as Row[]),
    db.service.get("app_settings", `select=value&key=eq.${q("org_short")}&limit=1`).catch(() => [] as Row[]),
  ]);
  return {
    full: s(nameRows[0]?.value) || DEFAULTS.full,
    short: s(shortRows[0]?.value) || DEFAULTS.short,
  };
}

/**
 * Load the three frames.
 *
 * meeting_logs and engagement_logs are filtered IN THE QUERY, as `_load_meetings` and
 * `_load_engagements` do — and note the end bound is `lte(end)` with NO +1 day, unlike
 * scan_logs. Both columns are dates rather than timestamps, so the day is whole; if either
 * ever becomes a timestamp, that bound starts dropping the final day's rows.
 *
 * `rfp_submissions` is not filtered: the people and partner charts are all-time.
 */
export async function loadSection2(db: Db, scope: Parameters<Db["as"]>[0], bounds: Bounds, rfpColumns: string) {
  const range = (col: string) => {
    let qs = "select=*";
    if (bounds.start) qs += `&${col}=gte.${q(bounds.start)}`;
    if (bounds.end) qs += `&${col}=lte.${q(bounds.end)}`;
    return qs;
  };
  const [rfps, meetings, engagements] = await Promise.all([
    db.as(scope).getAll("rfp_submissions", `select=${rfpColumns}`, "uid"),
    db.as(scope).getAll("meeting_logs", range("meeting_date"), "id"),
    db.as(scope).getAll("engagement_logs", range("engagement_date"), "id"),
  ]);
  return { rfps: rfps as Row[], meetings: meetings as Row[], engagements: engagements as Row[] };
}
