/**
 * Report, Section 5 — "Our Results: Proposals Submitted & Grants Secured", section id **5**.
 *
 * ALL-TIME except the cumulative chart, and the page's caption says so: the Excel-migrated
 * rows carry no `search_date`, so a period-filtered bottom line would report a smaller
 * organisation than the one that exists. The cumulative area chart is the one block that
 * follows the period and the view, because a trend is the thing a period is FOR.
 *
 * THIS SECTION CONTAINS THE THIRD AND FOURTH MEANINGS OF "SUBMITTED" ON THIS PAGE, and they
 * are different numbers on purpose:
 *
 *   kpis.submitted        donor-side submission EVENTS on Proceed rows whose progress is
 *                         Completed. A row submitted to a funder twice counts twice.
 *   conversion.submitted  Proceed ROWS matching the app-wide submitted mask (Completed OR a
 *                         donor decision on file). This is Section 3's `submitted` exactly.
 *
 * So `winRate` (approved ROWS ÷ submitted EVENTS) and `submittedToApproved` (approved rows ÷
 * submitted rows) answer different questions and will not agree. Both are drawn, a tile
 * apart, and reconciling them here would mean changing a figure the organisation reports.
 *
 * THREE SHARED HELPERS ARE DELIBERATELY NOT USED, because report.py's own rules differ:
 *
 *   submissionWeight()    floors at 1 and strips `progress_status`. This section does
 *                         `fillna(1).astype(int)` with no floor, over an unstripped
 *                         `== "completed"` gate. A row storing `submissions = 0` counts 0
 *                         here and 1 there.
 *   requestedCurrency()   strips `currency_secured` before deciding. This section falls back
 *                         to `currency` only when it is EXACTLY blank, so a whitespace-only
 *                         `currency_secured` is passed through to the rate lookup (which
 *                         strips it and answers 1.0) instead of falling back.
 *   the grants table      converts `amount_requested` with `currency`, where the KPI row two
 *                         hundred lines above converts the same column with
 *                         `currency_secured`. The table and the tile can therefore disagree
 *                         on one row, and they do so in report.py too.
 *
 * Each is reproduced and named rather than harmonised: harmonising would move numbers the
 * Streamlit page is reporting today, which is a decision about the data and not about the
 * port. `check-section5.mjs` asserts each divergence directly so it cannot drift unnoticed.
 */
import { usdValue, type Currency } from "./money.ts";
import { type Rate } from "./fx.ts";
import { bucketRange, bucketStart, seriesWindow, type BucketMode, type Bounds } from "./report_period.ts";

type Row = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
/** `.fillna("").str.lower()` — NO strip, the spelling this section uses almost everywhere. */
const loose = (v: unknown): string => s(v).toLowerCase();
/** `.fillna("").str.strip().str.lower()` — used only where report.py strips. */
const tight = (v: unknown): string => s(v).trim().toLowerCase();

/** `.fillna(0) > 0` over a numeric column. A blank or unparseable cell is 0, so it is out. */
const positive = (v: unknown): boolean => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
};

const day = (v: unknown): string | null => {
  const d = s(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};

/** The three donor decisions that mean the funder has been given something to answer. */
const OUTCOME_DECISIONS = new Set(["approved", "under review", "not approved"]);

/** `_submitted_mask`: progress "completed" OR a donor decision on file. */
const submittedMask = (r: Row): boolean =>
  tight(r.progress_status) === "completed" || OUTCOME_DECISIONS.has(tight(r.donor_decision));

/**
 * The currency `amount_requested` converts with in the KPI row and the outcome chart.
 *
 * NOT `requestedCurrency()`. report.py writes this inline as
 * `currency_secured.fillna("").replace("", pd.NA).fillna(currency)`, which falls back only
 * on an EXACTLY blank value — a `currency_secured` of "  " is kept and handed to the rate
 * lookup, which strips it and answers 1.0. `requestedCurrency()` would strip first and fall
 * back to the call's currency, converting that row at a different rate.
 */
const requestCurrencyInline = (r: Row): unknown =>
  s(r.currency_secured) === "" ? r.currency : r.currency_secured;

export type ResultKpis = {
  /** Submission EVENTS, not rows. See the module header. */
  submitted: number;
  approved: number;
  /** Approved ROWS ÷ submitted EVENTS, as a percentage. 0 with no submissions. */
  winRate: number;
  securedRatio: number;
};

export type ResultMoney = {
  requested: number; secured: number; unsecured: number;
  pipeline: number; pipelineRfps: number;
};

/** The transparency badge: rows carrying an amount with no currency, converted as USD. */
export type MissingCurrency = { approved: number; pipeline: number };

export type CumulativePoint = { bucket: string; secured: number; cumulative: number };

export type OutcomeRow = {
  uid: string; label: string; funder: string; outcome: string;
  donorDecision: string; reqUsd: number; secUsd: number; signedUsd: number;
};

export type Conversion = {
  proceeded: number; submitted: number; approved: number;
  proceededToSubmitted: number; submittedToApproved: number; endToEnd: number;
};

export type GrantRow = {
  uid: string; grant: string; funder: string;
  requestedUsd: number; securedUsd: number;
  donorDecision: string; submissions: number; submittedOn: string | null;
};

/**
 * `_subs` — `submissions` with a blank read as 1 and NO floor at 1.
 *
 * `submissionWeight()` floors at 1, which is migration 089's rule for the data. This tile
 * does not, so a Completed row storing `submissions = 0` contributes nothing to
 * "Applications submitted" here while the Pipeline counts it as one. `.astype(int)`
 * truncates toward zero, so 2.9 is two submissions.
 */
export function submissionsOn(r: Row): number {
  const raw = r.submissions;
  if (raw === null || raw === undefined || raw === "") return 1;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 1;
}

/**
 * Cumulative USD secured — `_bucketed_sum` on `date_of_approval`, then `cumsum`.
 *
 * The ONLY period-aware block in this section. Reindexing against the bucket range both
 * fills and drops, so an approval outside the period is not merely absent from its bucket:
 * it never enters the running total, and the curve a reader sees is the period's own.
 */
export function cumulativeSecured(
  approved: Row[], view: BucketMode, bounds: Bounds,
  rates: Record<string, Rate>, table: Currency[],
): CumulativePoint[] {
  const dated = approved.filter(
    (r) => day(r.date_of_approval) !== null
      && r.amount_secured !== null && r.amount_secured !== undefined,
  );
  if (!dated.length) return [];
  const sums = new Map<string, number>();
  for (const r of dated) {
    const b = bucketStart(day(r.date_of_approval)!, view);
    if (!b) continue;
    sums.set(b, (sums.get(b) ?? 0) + usdValue(r.amount_secured, r.currency_secured, rates, table));
  }
  const win = seriesWindow(bounds, dated.map((r) => day(r.date_of_approval)!));
  const full = win.start && win.end ? bucketRange(win.start, win.end, view) : [];
  const keys = full.length ? full : [...sums.keys()].sort();
  let running = 0;
  return keys.map((bucket) => {
    const secured = sums.get(bucket) ?? 0;
    running += secured;
    return { bucket, secured, cumulative: running };
  });
}

const OUTCOME_LABEL: Record<string, string> = {
  "approved": "Secured",
  "under review": "Requested (pending)",
  "not approved": "Unsecured (declined)",
};

export type Section5Input = {
  rfps: Row[];
  view: BucketMode;
  bounds: Bounds;
  rates: Record<string, Rate>;
  table: Currency[];
};

export function buildSection5(input: Section5Input) {
  const { rfps, view, bounds, rates, table } = input;
  const unique = rfps.filter((r) => r.is_duplicate !== true);
  const usd = (amount: unknown, currency: unknown) => usdValue(amount, currency, rates, table);

  const proceedTrack = unique.filter((r) => loose(r.decision).startsWith("proceed"));
  // `_pc` — the Completed gate, UNSTRIPPED. A progress_status of "Completed " is not
  // Completed here, and is Completed to `submissionWeight()`.
  const completed = proceedTrack.filter((r) => loose(r.progress_status) === "completed");
  const approvedCompleted = completed.filter((r) => loose(r.donor_decision) === "approved");

  const submittedEvents = completed.reduce((a, r) => a + submissionsOn(r), 0);
  const kpis: ResultKpis = {
    submitted: submittedEvents,
    approved: approvedCompleted.length,
    winRate: submittedEvents > 0 ? (approvedCompleted.length / submittedEvents) * 100 : 0,
    securedRatio: 0,   // filled below, once `requested` is known
  };

  // ── The outcome set: rows the funder has been asked to answer ─────────────
  // STRIPPED here, where almost everything else in this section is not — so a donor_decision
  // of " Approved " is in the money totals and out of `kpis.approved` above.
  const outcome = unique.filter((r) => OUTCOME_DECISIONS.has(tight(r.donor_decision)));
  const reqUsdOf = (r: Row) => usd(r.amount_requested, requestCurrencyInline(r));
  const secUsdOf = (r: Row) => usd(r.amount_secured, r.currency_secured);

  const requested = outcome.reduce((a, r) => a + reqUsdOf(r), 0);
  const secured = outcome.filter((r) => tight(r.donor_decision) === "approved")
    .reduce((a, r) => a + secUsdOf(r), 0);
  const unsecured = outcome.filter((r) => tight(r.donor_decision) === "not approved")
    .reduce((a, r) => a + reqUsdOf(r), 0);
  kpis.securedRatio = requested > 0 ? (secured / requested) * 100 : 0;

  const pipeline = proceedTrack.reduce((a, r) => a + usd(r.call_award_value, r.currency), 0);

  const money: ResultMoney = {
    requested, secured, unsecured, pipeline, pipelineRfps: proceedTrack.length,
  };

  // An amount with no currency was converted at 1.0, which is a silent assumption — so the
  // page says how many rows it made. Counted over the APPROVED outcome rows and over the
  // Proceed track, the two places a rate was applied to a number a reader will quote.
  const missingCurrency: MissingCurrency = {
    approved: outcome.filter(
      (r) => tight(r.donor_decision) === "approved" && positive(r.amount_secured)
        && s(r.currency_secured).trim() === "",
    ).length,
    pipeline: proceedTrack.filter(
      (r) => positive(r.call_award_value) && s(r.currency).trim() === "",
    ).length,
  };

  // ── Requested against secured, call by call ───────────────────────────────
  // A row is drawn when either side is positive, so a call we asked nothing for but won
  // something on still appears.
  const drawn = outcome.filter((r) => reqUsdOf(r) > 0 || secUsdOf(r) > 0);
  const outcomes: OutcomeRow[] = drawn.map((r) => {
    const d = tight(r.donor_decision);
    const reqUsd = reqUsdOf(r), secUsd = secUsdOf(r);
    // `row["sec_usd"] or row["req_usd"]` — Python's `or`, so a secured amount of ZERO on an
    // Approved call falls back to what was requested rather than plotting a bar of nothing.
    // An approval with no amount recorded is drawn at the size of the ask.
    const signedUsd = d === "approved" ? (secUsd || reqUsd)
      : d === "not approved" ? -reqUsd
      : reqUsd;
    return {
      uid: s(r.uid),
      label: [...s(r.opportunity_title === null || r.opportunity_title === undefined
        ? "(untitled)" : r.opportunity_title)].slice(0, 42).join(""),
      funder: s(r.funding_agency),
      outcome: OUTCOME_LABEL[d] ?? d,
      donorDecision: s(r.donor_decision).trim(),
      reqUsd, secUsd, signedUsd,
    };
  }).sort((a, b) => (b.signedUsd - a.signedUsd)
    || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
    || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));

  // ── Conversion ────────────────────────────────────────────────────────────
  // `submitted` here is Section 3's `submitted`: Proceed ROWS matching the app-wide mask.
  // It is NOT `kpis.submitted`, which counts submission events on Completed rows only.
  const submittedRows = proceedTrack.filter(submittedMask);
  const approvedRows = submittedRows.filter((r) => loose(r.donor_decision) === "approved");
  const conversion: Conversion = {
    proceeded: proceedTrack.length,
    submitted: submittedRows.length,
    approved: approvedRows.length,
    proceededToSubmitted: proceedTrack.length
      ? (submittedRows.length / proceedTrack.length) * 100 : 0,
    submittedToApproved: submittedRows.length
      ? (approvedRows.length / submittedRows.length) * 100 : 0,
    endToEnd: proceedTrack.length ? (approvedRows.length / proceedTrack.length) * 100 : 0,
  };

  // ── The closing table ─────────────────────────────────────────────────────
  // `requestedUsd` converts with `currency`, NOT with the request currency the KPI row uses.
  // One live CAD call requested in USD therefore reads differently in the tile and in this
  // table; the divergence is report.py's and is asserted by the parity check.
  const grants: GrantRow[] = completed.map((r) => ({
    uid: s(r.uid),
    grant: [...s(r.opportunity_title === null || r.opportunity_title === undefined
      ? "(untitled)" : r.opportunity_title)].slice(0, 70).join(""),
    funder: r.funding_agency === null || r.funding_agency === undefined
      ? "—" : s(r.funding_agency),
    requestedUsd: usd(r.amount_requested, r.currency),
    securedUsd: usd(r.amount_secured, r.currency_secured),
    // A blank donor decision reads as "Under Review" in this table and as blank everywhere
    // else — the table has no room to say "we have not heard back", so it says the state.
    donorDecision: s(r.donor_decision).trim() || "Under Review",
    submissions: submissionsOn(r),
    submittedOn: day(r.date_completed),
  })).sort((a, b) => (b.requestedUsd - a.requestedUsd)
    || (a.grant < b.grant ? -1 : a.grant > b.grant ? 1 : 0)
    || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));

  return {
    kpis, money, missingCurrency, conversion, outcomes, grants,
    cumulative: cumulativeSecured(approvedCompleted, view, bounds, rates, table),
  };
}
