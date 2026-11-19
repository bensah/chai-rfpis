/**
 * Bids Submitted (views/outcomes.py — "Your Applied Funding") — the server half.
 *
 * The full log of every application sent to a funder: Approved, Under Review, Not Approved,
 * and Completed-but-undecided. A declined application is KEPT, because the page is an
 * applied-funding RECORD rather than a list of wins — dropping the losses would make the
 * win rate it reports meaningless.
 *
 * NOT THE PIPELINE'S OUTCOME STAGE, and the two are supposed to differ. That stage shows
 * what a funder has ANSWERED inside a date window; this page is every application ever
 * sent, pending ones included, with no window at all. Live, the stage's win rate is 44% and
 * this page's is 17%, and both are right — they divide by different things. `/pipelines/outcome`
 * returns `counts.pending` precisely so this page's figures stay reconstructable from it.
 *
 * THREE COUNTS OF "AN APPLICATION" LIVE ON THIS ONE PAGE, and they are not reconcilable:
 *
 *   rows        — distinct RFP rows. The by-funder table's "RFPs" column.
 *   weighted    — `submissionWeight`: the KPI strip. ZERO for a row whose progress_status
 *                 never reached Completed, N for one submitted N times.
 *   raw         — `submissions` filled to 1: the by-funder table's "Submissions" column.
 *                 It does NOT check progress_status, so a row the KPI counts as zero still
 *                 counts as one here.
 *
 * So the by-funder Submissions column can sum higher than Total Submitted, and does today.
 * Reproduced rather than harmonised: both numbers are reported to the organisation now, and
 * which one is "right" is a decision about what they mean, not a porting question.
 * check-grants.mjs asserts the gap by name so it cannot close unnoticed.
 */
import { loadCurrencies, requestedCurrency, submissionWeight, usdRate, usdValue, type Currency } from "./money.ts";
import { ratesFor, type Rate } from "./fx.ts";
import type { Json } from "./jwt.ts";
import type { Db } from "./db.ts";

type Row = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const norm = (v: unknown): string => s(v).trim().toLowerCase();

/** The three decisions a funder can have given. A blank is none of them. */
const ANSWERED = new Set(["approved", "under review", "not approved"]);

/** Every column the page reads, plus the ones its detail panel shows. */
export const GRANT_FIELDS = [
  "uid", "opportunity_title", "funding_agency", "donor_decision", "progress_status",
  "amount_requested", "amount_secured", "currency", "currency_secured", "submissions",
  "call_submission_deadline", "date_completed", "expected_award_date", "date_of_approval",
  "applicant_role", "lead_applicant", "sub_applicant", "proposal_lead",
  "call_geographic_scope", "opportunity_link", "is_duplicate", "stage",
  // `submitted_at` is the last resort of the date chain below, not a figure the page
  // shows: it is when the ROW was created in RFPIS, which for an imported bid is the day
  // of the import rather than the day of the bid.
  "submitted_at",
].join(",");

// ── When a bid was submitted ─────────────────────────────────────────────────

/**
 * THE PAGE HAS NO SINGLE "DATE SUBMITTED" COLUMN, and that is why this is a chain rather
 * than a field read. Measured on the live table, of 19 submitted bids:
 *
 *   date_completed            18 / 19   — when the bid was marked Completed. The real one.
 *   call_submission_deadline  19 / 19   — a submitted bid went in by its deadline.
 *   submitted_at              19 / 19   — when the ROW was created here. All 2026, because
 *                                         the history was imported in one go, so it dates
 *                                         the import and not the bid.
 *
 * So the chain is completed → deadline → logged, and which link answered travels with the
 * row as `dateSource`. The page says so where it matters: ordering and a period filter
 * both turn on this date, and a reader sorting by "latest" deserves to know that one row's
 * date is its deadline standing in for a completion nobody recorded.
 */
export type DateSource = "completed" | "deadline" | "logged" | "none";

export function submittedOn(r: Row): { date: string | null; source: DateSource } {
  const completed = s(r.date_completed).slice(0, 10);
  if (completed) return { date: completed, source: "completed" };
  const deadline = s(r.call_submission_deadline).slice(0, 10);
  if (deadline) return { date: deadline, source: "deadline" };
  const logged = s(r.submitted_at).slice(0, 10);
  if (logged) return { date: logged, source: "logged" };
  return { date: null, source: "none" };
}

// ── The period filter ────────────────────────────────────────────────────────

/**
 * TWO CONTROLS, NOT ONE (owner, 2026-11-16). A WINDOW, and the YEAR it is anchored in.
 *
 * The first version put the rolling windows and the calendar years in one dropdown, which
 * made them look like alternatives and made the year list look hard-coded — the owner read
 * "2026, 2025" and reasonably asked whether 2027 would need a code change. It would not;
 * the list is computed from the rows. But the shape invited the question, and a control
 * that invites a wrong question about the data is the wrong control.
 *
 * So the window is one thing and the year is another:
 *
 *   window   all | 7d | 30d | 90d | 365d       — drawn as buttons, one click each
 *   year     a calendar year, or null for the whole record
 *   quarter  narrows a year; only meaningful when the window is `all`
 *
 * THE ANCHOR RULE, which is what makes "last 30 days of 2025" mean anything: a rolling
 * window ends on TODAY when the chosen year is the current one (or no year is chosen), and
 * on 31 DECEMBER of the chosen year otherwise. "Last 30 days" of 2025 is therefore 2–31
 * December 2025, which is the reading of "which year are we viewing the last 7 days for"
 * that a reader can act on: it is the end of that year's run-up.
 *
 * It is also clamped: a window anchored in a year never reaches outside that year. "Last
 * 365 days" of 2025 is the whole of 2025 and not thirteen months of it, because a window
 * that silently spilled into 2024 would make the year control a lie.
 *
 * DELIBERATELY NOT `report_period.ts`. That module is a port of the Report page's own
 * selectors and a parity check pins it to `views/report.py` figure for figure. These
 * windows answer to nothing in the Python, because Bids Submitted has no period filter
 * there at all.
 */
export const GRANT_WINDOWS = ["all", "7d", "30d", "90d", "365d"] as const;
export type GrantWindow = (typeof GRANT_WINDOWS)[number];

export type GrantSelection = {
  window: GrantWindow;
  /** null = the whole record, every year. */
  year: number | null;
  /** 1-4, and only applied when `window` is "all" — see `grantBounds`. */
  quarter: number | null;
};
export type GrantBounds = { start: string | null; end: string | null };

const QUARTER_MONTHS: Record<number, [number, number]> = {
  1: [1, 3], 2: [4, 6], 3: [7, 9], 4: [10, 12],
};
const WINDOW_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * `today` is passed in rather than read, for the reason report_period.ts gives: a model
 * with a clock of its own cannot be pinned by a test, and UTC is not the reader's day.
 *
 * A rolling window is INCLUSIVE of both ends and counts back N-1 days from its anchor, so
 * "Last 7 days" is a week containing the anchor rather than eight dates.
 */
export function grantBounds(sel: GrantSelection, today: string): GrantBounds {
  const thisYear = Number(today.slice(0, 4));
  const year = sel.year;

  // The year's own bounds, narrowed by a quarter when one is asked for. A quarter is only
  // honoured for the `all` window: "Q2, last 30 days" is two windows fighting, and the
  // page does not offer it.
  const yearBounds = (): GrantBounds => {
    if (!year) return { start: null, end: null };
    const [a, b] = sel.window === "all" && sel.quarter && QUARTER_MONTHS[sel.quarter]
      ? QUARTER_MONTHS[sel.quarter] : [1, 12];
    return {
      start: `${year}-${pad(a)}-01`,
      end: `${year}-${pad(b)}-${pad(lastDay(year, b))}`,
    };
  };

  if (sel.window === "all") return yearBounds();

  const days = WINDOW_DAYS[sel.window];
  // A PAST year anchors on its last day; the current year, and "every year", anchor on
  // today. A FUTURE year cannot be selected — `offeredYears` does not offer one — but if
  // one arrives in a URL it anchors on its last day like any other past year rather than
  // being treated as now.
  const anchor = !year || year === thisYear ? today : `${year}-12-31`;
  const start = addDays(anchor, -(days - 1));

  if (!year) return { start, end: anchor };
  // Clamped into the year, so a window anchored in one year never reaches into the one
  // before it. Without this, "last 365 days" of 2025 would quietly include December 2024.
  const yb = yearBounds();
  return {
    start: yb.start && start < yb.start ? yb.start : start,
    end: yb.end && anchor > yb.end ? yb.end : anchor,
  };
}

/**
 * Is this row's date inside the window?
 *
 * A row with NO date at all is kept only when there are no bounds at all. It cannot be
 * shown to belong to a window, and quietly including it would make the periods fail to sum
 * to the whole — which is worse than one row being invisible until the filter is cleared.
 */
export function inGrantPeriod(date: string | null, b: GrantBounds): boolean {
  if (!b.start && !b.end) return true;
  if (!date) return false;
  if (b.start && date < b.start) return false;
  if (b.end && date > b.end) return false;
  return true;
}

/**
 * THE YEARS THE PAGE MAY OFFER: every year that has a submitted bid, plus the current one,
 * newest first, and never a future one.
 *
 * The current year is included even with no bids in it yet, because it is the default and
 * a default that is not on its own list is a control that opens empty. On 1 January the
 * page must still open on this year and say, correctly, that nothing has been submitted.
 *
 * Everything after the current year is absent rather than disabled — a year that cannot
 * hold data is not a choice a reader should have to rule out. That is what makes 2027
 * "invalid" today and ordinary on 1 January 2027, with no code change: the list is derived
 * from the rows and the clock, never written down.
 */
export function offeredYears(dates: (string | null)[], today: string): number[] {
  const thisYear = Number(today.slice(0, 4));
  const found = dates
    .filter((d): d is string => !!d)
    .map((d) => Number(d.slice(0, 4)))
    .filter((y) => Number.isInteger(y) && y <= thisYear);
  return [...new Set([thisYear, ...found])].sort((a, b) => b - a);
}

/** What the reader is looking at, in words, for the caption under the controls. */
export function grantPeriodLabel(sel: GrantSelection): string {
  const win = {
    "7d": "Last 7 days", "30d": "Last 30 days",
    "90d": "Last 90 days", "365d": "Last 365 days",
  }[sel.window as string];
  if (!sel.year) return win ? `${win} (to today)` : "Every year";
  if (win) return `${win} of ${sel.year}`;
  return sel.quarter ? `Q${sel.quarter} ${sel.year}` : String(sel.year);
}

/**
 * The selection a query string asks for.
 *
 * A year the data cannot support is dropped rather than honoured, which is why this takes
 * the offered list: a bookmark to `?year=2031`, or a hand-edited URL, must not produce a
 * page that says "0 of 0" under a heading nobody can explain. It falls back to the whole
 * record, which is always a true answer.
 */
export function parseGrantSelection(p: URLSearchParams, years: number[] = []): GrantSelection {
  const raw = s(p.get("window")).trim().toLowerCase();
  const window = (GRANT_WINDOWS as readonly string[]).includes(raw)
    ? raw as GrantWindow : "all";
  const year = Number(p.get("year"));
  const quarter = Number(p.get("quarter"));
  const allowed = years.length === 0 || years.includes(year);
  return {
    window,
    year: Number.isInteger(year) && year >= 1990 && allowed ? year : null,
    quarter: Number.isInteger(quarter) && quarter >= 1 && quarter <= 4 ? quarter : null,
  };
}

/**
 * `_submitted` — has this row been sent to a funder?
 *
 * A decision OR `progress_status = Completed`. The second half is what keeps a row from
 * falling into the gap between two pages: marking Progress = Completed on Tracking takes a
 * row OUT of Tracking, so it has to arrive HERE even while its donor_decision is still
 * blank. Without it the count sticks low and nobody can say which rows are missing.
 */
export const isSubmitted = (r: Row): boolean =>
  ANSWERED.has(norm(r.donor_decision)) || norm(r.progress_status) === "completed";

const isApproved = (r: Row) => norm(r.donor_decision) === "approved";
const isNotApproved = (r: Row) => norm(r.donor_decision) === "not approved";

/**
 * `_pending` — waiting on the funder.
 *
 * "Under review", OR completed with no decision at all. Note what it does NOT include: a
 * completed row whose decision is some fourth string the vocabulary does not know. That row
 * counts in `submitted` and in none of the three buckets, so the buckets do not sum to the
 * total — which is the page's own behaviour, and visible rather than hidden.
 */
const isPending = (r: Row): boolean => {
  const d = norm(r.donor_decision);
  return d === "under review" || (norm(r.progress_status) === "completed" && d !== "approved" && d !== "not approved");
};

/**
 * `_status_display` — the badge.
 *
 * The raw decision, trimmed but NOT re-cased, except that a completed row with no
 * recognised decision reads "Under Review" — so the badge and the KPI bucket agree instead
 * of a row showing blank while being counted as pending.
 */
export const statusDisplay = (r: Row): string => {
  const raw = s(r.donor_decision).trim();
  return norm(r.progress_status) === "completed" && !ANSWERED.has(raw.toLowerCase())
    ? "Under Review"
    : raw;
};

/**
 * `_submissions_int` — the by-funder table's weight. `submissions` filled to 1.
 *
 * DELIBERATELY NOT `submissionWeight`: no progress_status gate, and no floor at 1 beyond
 * the null case, so a stored 0 stays 0 and a stored 2.9 truncates to 2. See the file header
 * for why the two live side by side.
 */
export const rawSubmissions = (r: Row): number => {
  const v = r.submissions;
  if (v === null || v === undefined || v === "") return 1;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 1;
};

export type GrantRow = {
  uid: string;
  title: string;
  funder: string;
  status: string;
  decision: string;
  progress: string;
  approved: boolean; pending: boolean; notApproved: boolean;
  /** `submissionWeight` — the KPI's unit. Zero for a row that never reached Completed. */
  applications: number;
  /** `submissions` filled to 1 — the by-funder table's unit. */
  submissions: number;
  usdRequested: number;
  usdSecured: number;
  /** As entered, so the page can show it beside the conversion — see the note below. */
  amountRequested: number | null;
  amountSecured: number | null;
  requestCurrency: string;
  securedCurrency: string;
  deadline: string | null;
  /** `date_completed` as stored — blank when nobody recorded one. */
  dateSubmitted: string | null;
  /** The date this page ORDERS and FILTERS by: `submittedOn`'s chain. Never invented. */
  periodDate: string | null;
  /** Which link of that chain answered, so the page can say when it is a stand-in. */
  dateSource: DateSource;
  expectedAward: string | null;
  role: string;
  leadApplicant: string;
  subApplicant: string;
  proposalLead: string;
  geography: string[];
  link: string;
};

export type FunderRow = {
  funder: string;
  rfps: number; submissions: number;
  approved: number; pending: number; notApproved: number;
  requested: number; secured: number;
};

export type GrantsPayload = {
  counts: { submitted: number; approved: number; pending: number; notApproved: number; rows: number };
  money: { requested: number; secured: number; unsecured: number; balance: number };
  winRate: number;
  rows: GrantRow[];
  byFunder: FunderRow[];
  /** What the reader is looking at, and the years they can ask for. */
  period: { selection: GrantSelection; bounds: GrantBounds; label: string };
  /**
   * The years the page may offer: every year with a submitted bid, plus the current one,
   * newest first, never a future one. Computed BEFORE the filter, or choosing 2025 would
   * empty the list that offers 2025. See `offeredYears`.
   */
  years: number[];
  /** Submitted bids outside the window, so a reader can tell a filter from an empty table. */
  hiddenByPeriod: number;
  /** What each currency converted at, so a reader can check a figure rather than trust it. */
  rates: Record<string, [number | null, string | null]>;
  /**
   * Rows the funder has ANSWERED that the weighted count scores as zero, because
   * progress_status never reached Completed. Reported, never repaired: writing Completed
   * here because a decision implies it is the resurrection migration 089 undid.
   */
  ledgerGap: string[];
};

/**
 * Lead and sub applicant as the page displays them.
 *
 * The role drives the defaults, because the Excel import left both columns blank far more
 * often than it filled them: Prime means this organisation leads, Sub means somebody else
 * does and this organisation is underneath, Technical means neither. "N/A", "NA" and "none"
 * are import debris and count as blank.
 */
const PLACEHOLDER = new Set(["", "n/a", "na", "none", "—"]);
const real = (v: unknown): string => {
  const t = typeof v === "string" ? v.trim() : "";
  return PLACEHOLDER.has(t.toLowerCase()) ? "" : t;
};

export function applicants(r: Row, orgShort: string): { lead: string; sub: string } {
  const role = norm(r.applicant_role);
  const lead = real(r.lead_applicant);
  const sub = real(r.sub_applicant);
  if (role === "prime") return { lead: lead || orgShort, sub: sub || "—" };
  if (role === "sub") return { lead: lead || "TBD", sub: sub || orgShort };
  if (role === "technical") return { lead: lead || "TBD", sub: sub || "—" };
  return { lead: lead || "—", sub: sub || "—" };
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => s(x).trim()).filter(Boolean) : (s(v).trim() ? [s(v).trim()] : []);

/**
 * The years a selection may name, from the raw rows — the same answer `buildGrants` puts
 * in its payload, without the aggregation.
 *
 * The route needs it BEFORE it can parse the query string, because a `?year=` the data
 * cannot support has to fall back rather than render an empty page nobody can explain.
 * Running `buildGrants` twice to learn one list would read every row, convert every
 * amount and group every funder for an answer that is four lines of date arithmetic.
 */
export function yearsFor(rfps: Row[], today: string): number[] {
  const everSubmitted = rfps.filter((r) => r.is_duplicate !== true && isSubmitted(r));
  return offeredYears(everSubmitted.map((r) => submittedOn(r).date), today);
}

export function buildGrants(input: {
  rfps: Row[]; rates: Record<string, Rate>; table: Currency[]; orgShort: string;
  selection?: GrantSelection; today?: string;
}): GrantsPayload {
  const { rfps, rates, table, orgShort } = input;
  // `eq("is_duplicate", False)` in the Python's own fetch. A duplicate is the same call
  // twice, and counting both would inflate every figure on the page.
  const unique = rfps.filter((r) => r.is_duplicate !== true);
  const everSubmitted = unique.filter(isSubmitted);

  // THE FILTER IS APPLIED HERE, BEFORE ANYTHING IS COUNTED, and that is the whole point of
  // doing it on the server. The KPI strip, the money, the win rate, the by-funder table,
  // the picker and the ledger-gap notice are all derived from `rows` below, so one filter
  // moves all of them together. A page that filtered its own list would leave the tiles
  // above it answering a different question.
  const selection: GrantSelection =
    input.selection ?? { window: "all", year: null, quarter: null };
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const bounds = grantBounds(selection, today);
  const active = everSubmitted.filter((r) => inGrantPeriod(submittedOn(r).date, bounds));

  // Offered before the filter, so picking a year never removes that year from the list.
  const years = yearsFor(rfps, today);

  const rows: GrantRow[] = active.map((r) => {
    const when = submittedOn(r);
    const { lead, sub } = applicants(r, orgShort);
    const reqCur = requestedCurrency(r as { currency_secured?: unknown; currency?: unknown });
    return {
      uid: s(r.uid),
      title: s(r.opportunity_title) || "(no title)",
      funder: s(r.funding_agency) || "—",
      status: statusDisplay(r) || "—",
      decision: s(r.donor_decision).trim(),
      progress: s(r.progress_status).trim(),
      approved: isApproved(r), pending: isPending(r), notApproved: isNotApproved(r),
      applications: submissionWeight(r as never),
      submissions: rawSubmissions(r),
      // The REQUEST converts with the currency we SUBMITTED in, not the call's advertised
      // one — `requestedCurrency`. Reading the call's currency rendered a USD 715,400
      // request as "$509,530 USD" because the call happened to be advertised in CAD.
      usdRequested: usdValue(r.amount_requested, reqCur, rates, table),
      usdSecured: usdValue(r.amount_secured, r.currency_secured, rates, table),
      // Both figures travel: showing only the conversion made this page look like it
      // disagreed with the editor, with nothing on screen saying a conversion had happened.
      amountRequested: num(r.amount_requested),
      amountSecured: num(r.amount_secured),
      requestCurrency: reqCur,
      securedCurrency: s(r.currency_secured).trim(),
      deadline: s(r.call_submission_deadline).slice(0, 10) || null,
      dateSubmitted: s(r.date_completed).slice(0, 10) || null,
      periodDate: when.date,
      dateSource: when.source,
      expectedAward: s(r.expected_award_date).slice(0, 10) || s(r.date_of_approval).slice(0, 10) || null,
      role: s(r.applicant_role).trim(),
      leadApplicant: lead, subApplicant: sub,
      proposalLead: s(r.proposal_lead).trim(),
      geography: list(r.call_geographic_scope),
      link: s(r.opportunity_link).trim(),
    };
  });

  // NEWEST FIRST, by the same date the period filter uses, with undated rows last
  // (owner, 2026-11-16: "sorted from the latest to the earlier from top to bottom").
  //
  // It replaced an Approved-then-pending-then-the-rest ranking, which was this author's
  // idea of what a reader wants at the top and is not what was asked for. Ordering here
  // rather than in the page means the picker, the detail panel's neighbours and anything
  // reading `rows` later cannot disagree about which bid is the most recent.
  rows.sort((a, b) => {
    if (!a.periodDate && !b.periodDate) return a.uid.localeCompare(b.uid);
    if (!a.periodDate) return 1;
    if (!b.periodDate) return -1;
    return b.periodDate.localeCompare(a.periodDate) || a.uid.localeCompare(b.uid);
  });

  // The KPI strip, SUBMISSION-WEIGHTED throughout. One weight drives the total, each
  // bucket and the win rate, so they cannot drift apart.
  const sum = (f: (g: GrantRow) => number) => rows.reduce((a, g) => a + f(g), 0);
  const submitted = sum((g) => g.applications);
  const approved = sum((g) => (g.approved ? g.applications : 0));
  const pending = sum((g) => (g.pending ? g.applications : 0));
  const notApproved = sum((g) => (g.notApproved ? g.applications : 0));

  const requested = sum((g) => g.usdRequested);
  const secured = sum((g) => (g.approved ? g.usdSecured : 0));
  // Unsecured is what was asked for on applications that were REFUSED — funding lost, not
  // funding not yet won. The two are different questions and the page answers both.
  const unsecured = sum((g) => (g.notApproved ? g.usdRequested : 0));
  // Still in play. Floored at zero: the three figures come from different columns, and a
  // row with a secured amount larger than its request would otherwise show a negative
  // balance, which reads as a data claim rather than the data error it is.
  const balance = Math.max(0, requested - secured - unsecured);

  // Sorted by Submissions, descending — the RAW column, not the weighted one, which is what
  // the Python's `sort_values("Submissions")` sorts by. Ties keep funder order, where the
  // Python's quicksort does not; the check compares the table as a set and asserts the
  // ordering separately, for the same reason Section 5's grants table does.
  const groups = new Map<string, FunderRow>();
  for (const g of rows) {
    const key = g.funder;
    let f = groups.get(key);
    if (!f) {
      f = { funder: key, rfps: 0, submissions: 0, approved: 0, pending: 0, notApproved: 0, requested: 0, secured: 0 };
      groups.set(key, f);
    }
    f.rfps += 1;
    f.submissions += g.submissions;
    f.approved += g.approved ? 1 : 0;
    f.pending += g.pending ? 1 : 0;
    f.notApproved += g.notApproved ? 1 : 0;
    f.requested += g.usdRequested;
    f.secured += g.approved ? g.usdSecured : 0;
  }
  const byFunder = [...groups.values()].sort((a, b) => b.submissions - a.submissions);

  const usedRates: Record<string, [number | null, string | null]> = {};
  for (const g of rows) {
    for (const cur of [g.requestCurrency, g.securedCurrency]) {
      const k = cur.trim().toUpperCase();
      if (!k || k in usedRates) continue;
      // The rate actually used, and the day it came from. A `Rate` is [rate, asOf]; a
      // currency with no live rate falls back to the table, so the two can differ and the
      // page shows both rather than implying every figure was converted live.
      usedRates[k] = [usdRate(cur, rates, table), rates[k]?.[1] ?? null];
    }
  }

  return {
    counts: { submitted, approved, pending, notApproved, rows: rows.length },
    money: { requested, secured, unsecured, balance },
    winRate: submitted > 0 ? (approved / submitted) * 100 : 0,
    rows,
    byFunder,
    period: { selection, bounds, label: grantPeriodLabel(selection) },
    years,
    hiddenByPeriod: everSubmitted.length - active.length,
    rates: usedRates,
    ledgerGap: rows.filter((g) => ANSWERED.has(g.decision.toLowerCase()) && g.applications === 0)
      .map((g) => g.uid),
  };
}

/** Read the rows and the FX this page needs. */
export async function loadGrants(db: Db, scope: Parameters<Db["as"]>[0]) {
  const rfps = await db.as(scope).getAll("rfp_submissions", `select=${GRANT_FIELDS}`, "uid") as Row[];
  const active = rfps.filter((r) => r.is_duplicate !== true && isSubmitted(r));
  const [rates, table] = await Promise.all([
    ratesFor(active.flatMap((r) => [r.currency_secured, r.currency])),
    loadCurrencies(db),
  ]);
  return { rfps, rates, table } as { rfps: Row[]; rates: Record<string, Rate>; table: Currency[]; _?: Json };
}
