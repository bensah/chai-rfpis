/**
 * Report, Section 3 as displayed — "Insights: Status & Eligibility Funnel", section id **2**.
 *
 * THIS WHOLE SECTION IGNORES THE PERIOD, and the caption on the page says so: the funnel is
 * "current pipeline state across ALL stored RFPs", because a funnel of a three-month window
 * answers a question nobody asked. The period appears once, as `discoveredInPeriod`, which
 * is a badge beside the total rather than a filter on it.
 *
 * Excel-migrated rows are the reason. They carry no `search_date`, so a period-filtered
 * funnel would drop the organisation's entire pre-migration history and report a pipeline
 * far smaller than the one the team is working.
 *
 * THE STAGES ARE NESTED, AND THAT IS WHAT MAKES THE FUNNEL HONEST:
 *
 *     Total  ⊇  Proceed  ⊇  Submitted  ⊇  Approved
 *
 * Submitted is the submitted set WITHIN the Proceed track, not everything the app would call
 * submitted; Approved is the approved subset OF those. Computing either independently lets
 * Approved exceed Submitted, which is the failure this nesting exists to prevent — and it is
 * also why this section's "Submitted" is NOT the same number as the tile in Section 5.
 */
import { usdValue, type Currency } from "./money.ts";
import { type Rate } from "./fx.ts";

type Row = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/**
 * `_dec_all` — `.fillna("").str.lower()`, with NO `.strip()`.
 *
 * Section 1's Proceed filter strips first and this one does not, so a decision stored with a
 * leading space is counted there and not here. Copied rather than corrected: the two
 * sections would otherwise report different populations from the same database for a reason
 * no reader could find. The same inconsistency is noted in Section 2's port.
 */
const dec = (r: Row): string => s(r.decision).toLowerCase();

/** `_submitted_mask`: progress "completed" OR a donor decision on file. */
const SUBMITTED_DECISIONS = new Set(["approved", "under review", "not approved"]);
const submittedMask = (r: Row): boolean =>
  s(r.progress_status).trim().toLowerCase() === "completed"
  || SUBMITTED_DECISIONS.has(s(r.donor_decision).trim().toLowerCase());

const isApproved = (r: Row): boolean => s(r.donor_decision).toLowerCase() === "approved";

/**
 * `_discovery_ts` + `_in_period` — search_date, falling back to submitted_at.
 * A row with neither is OUT when a period is active and IN under All time.
 */
function discoveredInPeriod(r: Row, bounds: { start: string | null; end: string | null }): boolean {
  if (bounds.start === null && bounds.end === null) return true;
  const raw = r.search_date !== null && r.search_date !== undefined ? r.search_date : r.submitted_at;
  const d = s(raw).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  if (bounds.start && d < bounds.start) return false;
  if (bounds.end && d > bounds.end) return false;
  return true;
}

export type FunnelCounts = {
  total: number; proceed: number; park: number; decline: number; noDecision: number;
  submitted: number; approved: number; discoveredInPeriod: number;
};

export type FunnelValues = { discovered: number; proceed: number; submitted: number; approved: number };

export type ProgressRow = { status: string; rfps: number };

/**
 * `_canon_progress` — blank or unrecognised becomes "Not Started".
 *
 * PROCEED-ONLY upstream: progress_status is a lifecycle only a Proceed row has, and a
 * Park/Decline row with a blank progress used to draw an "(unset)" bar that was really one
 * Decline row rather than a data gap. Scoping to Proceed removes it, and the blank default
 * means every Proceed row lands somewhere — so the bars sum to the Proceed count exactly.
 */
const PS_CANON: Record<string, string> = {
  "not started": "Not Started", "in progress": "In Progress",
  "completed": "Completed", "discontinued": "Discontinued",
  "missed": "Missed", "missing": "Missed",
};
const PROGRESS_ORDER = ["Not Started", "In Progress", "Completed", "Discontinued", "Missed"];

export function canonProgress(v: unknown): string {
  return PS_CANON[s(v).trim().toLowerCase()] ?? "Not Started";
}

export type Section3Input = {
  rfps: Row[];
  bounds: { start: string | null; end: string | null };
  rates: Record<string, Rate>;
  table: Currency[];
};

export function buildSection3(input: Section3Input) {
  const { rfps, bounds, rates, table } = input;
  const unique = rfps.filter((r) => r.is_duplicate !== true);

  const proceedRows = unique.filter((r) => dec(r).startsWith("proceed"));
  const park = unique.filter((r) => dec(r) === "park").length;
  const decline = unique.filter((r) => dec(r) === "decline").length;
  const total = unique.length;
  // The remainder, not a fourth test: an unexpected decision string lands here rather than
  // being dropped, so the four categories always sum to the total.
  const noDecision = total - (proceedRows.length + park + decline);

  const submittedRows = proceedRows.filter(submittedMask);
  const approvedRows = submittedRows.filter(isApproved);

  const counts: FunnelCounts = {
    total, proceed: proceedRows.length, park, decline, noDecision,
    submitted: submittedRows.length, approved: approvedRows.length,
    discoveredInPeriod: unique.filter((r) => discoveredInPeriod(r, bounds)).length,
  };

  // EACH STAGE USES A DIFFERENT COLUMN PAIR, and that is the point of the value funnel:
  //   Discovered / Proceed  the call's advertised award value, in the call's currency
  //   Submitted             what WE asked for, still against `currency`
  //   Approved              what we actually won, against `currency_secured`
  // Reading one column across all four would make the funnel compare unlike things and
  // report a conversion that never happened.
  const sum = (rows: Row[], amount: string, currency: string): number =>
    rows.reduce((a, r) => a + usdValue(r[amount], r[currency], rates, table), 0);

  const values: FunnelValues = {
    discovered: sum(unique, "call_award_value", "currency"),
    proceed: sum(proceedRows, "call_award_value", "currency"),
    submitted: sum(submittedRows, "amount_requested", "currency"),
    approved: sum(approvedRows, "amount_secured", "currency_secured"),
  };

  // Zero-filled against the fixed order, so an absent status draws an empty slot rather
  // than shifting the bars along.
  const by = new Map<string, number>();
  for (const r of proceedRows) {
    const k = canonProgress(r.progress_status);
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  const progress: ProgressRow[] = PROGRESS_ORDER.map((status) => ({ status, rfps: by.get(status) ?? 0 }));

  return { counts, values, progress, proceedRows: proceedRows.length };
}

/** Every currency string the value funnel will need a rate for. */
export function currenciesUsed(rfps: Row[]): unknown[] {
  const out: unknown[] = [];
  for (const r of rfps) out.push(r.currency, r.currency_secured);
  return out;
}
