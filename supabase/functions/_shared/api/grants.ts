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
 * The windows the page offers. Rolling ones first, then a calendar year, optionally
 * narrowed to a quarter.
 *
 * DELIBERATELY NOT `report_period.ts`. That module is a port of the Report page's own
 * selectors — "This year", "Specific month", "Last 12 months" — and it exists to agree
 * with `views/report.py` figure for figure; a parity check pins it. Bending it to carry
 * 7/30/90/365-day windows and quarters would change what that check is checking. These
 * are a different page's windows and they answer to nothing in the Python, because Bids
 * Submitted has no period filter there at all: this is new (owner, 2026-11-16).
 */
export const GRANT_PERIODS = ["all", "7d", "30d", "90d", "365d", "year"] as const;
export type GrantPeriod = (typeof GRANT_PERIODS)[number];

export type GrantSelection = { period: GrantPeriod; year: number | null; quarter: number | null };
export type GrantBounds = { start: string | null; end: string | null };

const QUARTER_MONTHS: Record<number, [number, number]> = {
  1: [1, 3], 2: [4, 6], 3: [7, 9], 4: [10, 12],
};
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * `today` is passed in rather than read, for the reason report_period.ts gives: a model
 * with a clock of its own cannot be pinned by a test, and UTC is not the reader's day.
 *
 * A rolling window is INCLUSIVE of today and counts back N-1 further days, so "Last 7
 * days" is a week containing today rather than eight dates. Both ends are inclusive
 * everywhere, which is also what `inGrantPeriod` assumes.
 */
export function grantBounds(sel: GrantSelection, today: string): GrantBounds {
  const days = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 }[sel.period as string];
  if (days) {
    const end = new Date(`${today}T00:00:00Z`);
    const start = new Date(end.getTime() - (days - 1) * 86400000);
    return { start: start.toISOString().slice(0, 10), end: today };
  }
  if (sel.period === "year" && sel.year) {
    const [a, b] = sel.quarter && QUARTER_MONTHS[sel.quarter]
      ? QUARTER_MONTHS[sel.quarter] : [1, 12];
    return {
      start: `${sel.year}-${pad(a)}-01`,
      end: `${sel.year}-${pad(b)}-${pad(lastDay(sel.year, b))}`,
    };
  }
  return { start: null, end: null };
}

/**
 * Is this row's date inside the window?
 *
 * A row with NO date at all is kept only by "All time". It cannot be shown to belong to a
 * window, and quietly including it would make the periods fail to sum to the whole — which
 * is worse than one row being invisible until the filter is cleared.
 */
export function inGrantPeriod(date: string | null, b: GrantBounds): boolean {
  if (!b.start && !b.end) return true;
  if (!date) return false;
  if (b.start && date < b.start) return false;
  if (b.end && date > b.end) return false;
  return true;
}

/** What the reader is looking at, in words, for the caption under the controls. */
export function grantPeriodLabel(sel: GrantSelection): string {
  switch (sel.period) {
    case "7d": return "Last 7 days";
    case "30d": return "Last 30 days";
    case "90d": return "Last 90 days";
    case "365d": return "Last 365 days";
    case "year":
      if (!sel.year) return "All time";
      return sel.quarter ? `Q${sel.quarter} ${sel.year}` : String(sel.year);
    default: return "All time";
  }
}

/** The selection a query string asks for, with anything unparseable falling back to all. */
export function parseGrantSelection(p: URLSearchParams): GrantSelection {
  const raw = s(p.get("period")).trim().toLowerCase();
  const period = (GRANT_PERIODS as readonly string[]).includes(raw)
    ? raw as GrantPeriod : "all";
  const year = Number(p.get("year"));
  const quarter = Number(p.get("quarter"));
  return {
    period,
    year: Number.isInteger(year) && year >= 1990 && year <= 2100 ? year : null,
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
   * Every year that has a submitted bid in it, newest first — computed BEFORE the filter,
   * or choosing 2025 would empty the list that offers 2025.
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
    input.selection ?? { period: "all", year: null, quarter: null };
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const bounds = grantBounds(selection, today);
  const active = everSubmitted.filter((r) => inGrantPeriod(submittedOn(r).date, bounds));

  // Offered before the filter, so picking a year never removes that year from the list.
  const years = [...new Set(everSubmitted
    .map((r) => submittedOn(r).date)
    .filter((d): d is string => !!d)
    .map((d) => Number(d.slice(0, 4))))]
    .filter((y) => Number.isInteger(y)).sort((a, b) => b - a);

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
