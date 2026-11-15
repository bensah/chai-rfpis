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
].join(",");

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
  dateSubmitted: string | null;
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
}): GrantsPayload {
  const { rfps, rates, table, orgShort } = input;
  // `eq("is_duplicate", False)` in the Python's own fetch. A duplicate is the same call
  // twice, and counting both would inflate every figure on the page.
  const unique = rfps.filter((r) => r.is_duplicate !== true);
  const active = unique.filter(isSubmitted);

  const rows: GrantRow[] = active.map((r) => {
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
      expectedAward: s(r.expected_award_date).slice(0, 10) || s(r.date_of_approval).slice(0, 10) || null,
      role: s(r.applicant_role).trim(),
      leadApplicant: lead, subApplicant: sub,
      proposalLead: s(r.proposal_lead).trim(),
      geography: list(r.call_geographic_scope),
      link: s(r.opportunity_link).trim(),
    };
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
