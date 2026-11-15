/**
 * Report, Section 4 as displayed — "Reviews & Decisions", section id **3**.
 *
 * Triage outcomes: how fast a call goes from discovery to a decision, where the reviewer
 * overrode the auto-scorer, and the funder's own answer to what was submitted.
 *
 * THE FOUR BLOCKS DO NOT SHARE A POPULATION, and that is not an oversight in report.py —
 * each one is scoped to the question it answers:
 *
 *   kpis        decided-in-period (every decision, all three outcomes)
 *   distribution  ALL-TIME, every non-duplicate row, period ignored entirely
 *   overTime    decided-in-period AND Proceed only
 *   autoRec     decided-in-period (every decision)
 *   donor       ALL-TIME and Proceed only — a funder's answer is durable
 *
 * The donor block's scope is a fix, not an accident: period-filtering it dropped Not
 * Approved and Submitted from the chart entirely — 13 real donor decisions existed and 6
 * were drawn, so a funder's rejection simply did not appear.
 *
 * THREE DIFFERENT SPELLINGS OF "IS THIS A PROCEED ROW" LIVE IN THIS ONE SECTION:
 *
 *   distribution  .fillna("").str.lower()                  — no strip, `== "park"` exact
 *   overTime      .fillna("").str.lower()                  — no strip
 *   autoRec       .fillna("").str.strip().str.lower()      — strips, and startswith for ALL
 *                                                            three outcomes
 *   donor         .fillna("").str.strip().str.lower()      — strips
 *
 * They are copied as they are. Normalising them here would make this section report a
 * different population from Section 3, which shares `distribution`'s spelling exactly, and
 * a reader comparing the two pages would find a discrepancy with no cause visible anywhere.
 */
import { bucketRange, bucketStart, seriesWindow, type BucketMode, type Bounds } from "./report_period.ts";

type Row = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** `.fillna("").str.lower()` — NO strip. */
const loose = (v: unknown): string => s(v).toLowerCase();
/** `.fillna("").astype(str).str.strip().str.lower()`. */
const tight = (v: unknown): string => s(v).trim().toLowerCase();

/** Python's `str.title()`: first letter of each word up, the rest down. */
const pyTitle = (v: string): string =>
  v.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

/** A `YYYY-MM-DD` day from a date or timestamp cell, or null when there is no usable date. */
const day = (v: unknown): string | null => {
  const d = s(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};

const utc = (d: string): number => Date.parse(`${d}T00:00:00Z`);

/**
 * `_in_period` over a DATE column (here `decision_date`), which is the asymmetry that
 * decides what "Decisions made" counts.
 *
 * Under All time a row with no decision_date is IN; under any other period it is OUT. So
 * "Decisions made" under All time counts rows that carry no decision at all, and under a
 * period counts only rows actually dated. report.py's KPI is `len(decided)` either way.
 */
function decidedInPeriod(r: Row, bounds: Bounds): boolean {
  if (bounds.start === null && bounds.end === null) return true;
  const d = day(r.decision_date);
  if (d === null) return false;
  if (bounds.start && d < bounds.start) return false;
  if (bounds.end && d > bounds.end) return false;
  return true;
}

export type DecisionKpis = {
  decisions: number;
  avgDays: number | null;
  medianDays: number | null;
  overridden: number;
  /** How many of `decisions` carried both a search_date and a decision_date. */
  dated: number;
};

/**
 * The KPI row.
 *
 * `days_to_decide` is `decision_date - search_date.date()`, and NEGATIVE SPANS ARE KEPT.
 * Section 1's discovery→submission cycle drops them; this one does not, so an Excel-migrated
 * row whose decision predates its recorded search date drags the mean down here and is
 * simply absent there. Copied rather than harmonised — the two numbers are computed by two
 * different pieces of report.py and a reader comparing them is comparing two rules.
 *
 * `overridden` is `.notna()`, so an EMPTY STRING counts as overridden: a blank
 * `decision_overridden_by` written by a form is a value, and only a real NULL is not.
 */
export function decisionKpis(decided: Row[]): DecisionKpis {
  const days: number[] = [];
  for (const r of decided) {
    const sd = day(r.search_date), dd = day(r.decision_date);
    if (sd === null || dd === null) continue;
    days.push(Math.round((utc(dd) - utc(sd)) / 86400_000));
  }
  const overridden = decided.filter(
    (r) => r.decision_overridden_by !== null && r.decision_overridden_by !== undefined,
  ).length;
  if (!days.length) {
    return { decisions: decided.length, avgDays: null, medianDays: null, overridden, dated: 0 };
  }
  const sorted = [...days].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  // numpy's median: the average of the two middle values for an even count.
  const medianDays = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    decisions: decided.length,
    avgDays: days.reduce((a, b) => a + b, 0) / days.length,
    medianDays,
    overridden,
    dated: days.length,
  };
}

export type DistributionRow = { decision: string; count: number };

/** The fixed semantic order the bars are drawn in — `_theme.DECISION_ORDER`. */
export const DECISION_ORDER = ["Proceed", "Park", "Decline", "No decision"];

/**
 * Decision distribution — ALL-TIME over every non-duplicate row, period ignored.
 *
 * Identical by construction to Section 3's count funnel, and deliberately recomputed here
 * rather than imported: the two sections read the same rule from the same page, and a
 * shared helper would let one move without the other. The parity check asserts they agree.
 *
 * Fixed order, not frequency order, so a colour means the same thing on every report.
 */
export function distribution(unique: Row[]): DistributionRow[] {
  const proceed = unique.filter((r) => loose(r.decision).startsWith("proceed")).length;
  const park = unique.filter((r) => loose(r.decision) === "park").length;
  const decline = unique.filter((r) => loose(r.decision) === "decline").length;
  // The remainder, so the four categories always sum to the row count.
  const noDecision = unique.length - (proceed + park + decline);
  return [
    { decision: "Proceed", count: proceed },
    { decision: "Park", count: park },
    { decision: "Decline", count: decline },
    { decision: "No decision", count: noDecision },
  ];
}

export type Bucketed = { bucket: string; decisions: number };

/**
 * Proceed decisions over time — `_bucketed_count` on `decision_date`.
 *
 * Zero-filled against the period's own bucket range, so a quiet month draws an empty bar
 * rather than vanishing and pulling the next one left. Under All time the window comes from
 * the data's own min and max, which is what `_bucketed_count` falls back to.
 *
 * Reindexing DROPS as well as fills: a bucket outside the range is gone. That matters for
 * Monthly and Quarterly, where `bucketRange` begins at the first boundary at or after the
 * start, so a decision in the partial first bucket is not drawn.
 */
export function decisionsOverTime(proceedDecided: Row[], view: BucketMode, bounds: Bounds): Bucketed[] {
  const dates = proceedDecided.map((r) => day(r.decision_date)).filter((d): d is string => d !== null);
  if (!dates.length) return [];
  const counts = new Map<string, number>();
  for (const d of dates) {
    const b = bucketStart(d, view);
    if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const win = seriesWindow(bounds, dates);
  const full = win.start && win.end ? bucketRange(win.start, win.end, view) : [];
  const keys = full.length ? full : [...counts.keys()].sort();
  return keys.map((bucket) => ({ bucket, decisions: counts.get(bucket) ?? 0 }));
}

export type AutoRecRow = { decision: string; auto: number; team: number };
export type AutoRec = { rows: AutoRecRow[]; agreed: number; total: number };

/**
 * Auto-scorer against the team — same calls, same three outcomes, side by side.
 *
 * NOT a cross-tab. Both columns count THE SAME rows, every call the team has decided, so a
 * reader can compare them directly without adding a row up. A call the scorer had no
 * opinion on still counts in the team's column, which is why the two columns need not sum
 * to `total` and why `total` is reported alongside them.
 *
 * ALL THREE OUTCOMES MATCH WITH `startswith` HERE, where the distribution above uses exact
 * equality for Park and Decline. "Decline — out of scope" is a Decline in this block and a
 * No decision in the one above it.
 *
 * `agreed` compares the FIRST WHITESPACE TOKEN of each side, so "Proceed with caution"
 * agrees with "proceed". A blank splits to an empty list and yields NaN, and NaN never
 * equals NaN — so TWO BLANKS DO NOT AGREE. That is not tidiness: a row the scorer never saw
 * and the team never decided is not evidence the scorer was right.
 */
export function autoRec(decided: Row[]): AutoRec {
  const firstToken = (v: string): string | null => {
    const t = v.split(/\s+/).filter((x) => x !== "");
    return t.length ? t[0] : null;
  };
  const rows: AutoRecRow[] = ["Proceed", "Park", "Decline"].map((label) => {
    const k = label.toLowerCase();
    return {
      decision: label,
      auto: decided.filter((r) => tight(r.auto_recommendation).startsWith(k)).length,
      team: decided.filter((r) => tight(r.decision).startsWith(k)).length,
    };
  });
  let agreed = 0;
  for (const r of decided) {
    const a = firstToken(tight(r.auto_recommendation));
    const t = firstToken(tight(r.decision));
    if (a !== null && t !== null && a === t) agreed++;
  }
  return { rows, agreed, total: decided.length };
}

export type DonorRow = { decision: string; rfps: number };
export type DonorDecisions = {
  all: Record<string, number>;
  ranked: DonorRow[];
  pending: number;
  order: string[];
};

/**
 * `_AWAITING` — the values that mean "no answer from the funder yet".
 *
 * "SUBMITTED" IS IN THIS LIST, and it is the entry that most looks like a mistake. It
 * records that WE sent the proposal — our own state, not the funder's response — so on a
 * chart headed "the funder's response" it answered a different question. It counts as
 * awaiting an outcome, alongside the rows never submitted.
 */
const AWAITING = new Set(["", "not submitted", "submitted", "pending", "awaiting", "in review"]);

/**
 * Donor decisions — one bar per CALL, not per submission.
 *
 * A proposal sent twice is still one call awaiting one answer; weighting by `submissions`
 * would make a resubmission look like a second decision.
 *
 * `ranked` is sorted by count descending, ties alphabetically. report.py's `value_counts`
 * ties arbitrarily, and the chart then re-sorts by total ascending for display anyway, so
 * reproducing the hash order would buy nothing and cost determinism. `all` carries the full
 * grouping so the parity check can compare it exactly.
 */
export function donorDecisions(proceedAll: Row[]): DonorDecisions {
  let pending = 0;
  const all: Record<string, number> = {};
  for (const r of proceedAll) {
    const raw = s(r.donor_decision).trim();
    if (AWAITING.has(raw.toLowerCase())) { pending++; continue; }
    const k = pyTitle(raw);
    all[k] = (all[k] ?? 0) + 1;
  }
  const ranked = Object.entries(all)
    .map(([decision, rfps]) => ({ decision, rfps }))
    .sort((a, b) => (b.rfps - a.rfps) || (a.decision < b.decision ? -1 : a.decision > b.decision ? 1 : 0));
  return { all, ranked, pending, order: ["Approved", "Under Review", "Not Approved"] };
}

export type Section4Input = {
  rfps: Row[];
  view: BucketMode;
  bounds: Bounds;
};

export function buildSection4(input: Section4Input) {
  const { rfps, view, bounds } = input;
  const unique = rfps.filter((r) => r.is_duplicate !== true);

  // `if _start:` — report.py gates on the START alone, not on the pair. Only "All time"
  // has no start, so today the two readings agree; the gate is written the way the page
  // writes it so a future period with an end but no start behaves the same on both sides.
  const decided = bounds.start === null
    ? unique
    : unique.filter((r) => decidedInPeriod(r, bounds));

  // Proceed WITHIN the period's decisions — the time series only.
  const proceedDecided = decided.filter((r) => loose(r.decision).startsWith("proceed"));

  // Proceed ACROSS ALL TIME, and stripped — the donor block only. A funder's answer is a
  // durable outcome, so it is not hidden by a period that happens to exclude the decision.
  const proceedAll = unique.filter((r) => tight(r.decision).startsWith("proceed"));

  return {
    kpis: decisionKpis(decided),
    distribution: distribution(unique),
    distributionOrder: DECISION_ORDER,
    overTime: decisionsOverTime(proceedDecided, view, bounds),
    autoRec: autoRec(decided),
    donor: donorDecisions(proceedAll),
  };
}
