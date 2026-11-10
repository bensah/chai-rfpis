// Thin client for the RFPIS web API (the Supabase Edge Function in production, the Vite
// dev middleware locally). The browser never talks to Supabase itself.
import type { Contact, Donor } from "./donors/model";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, "") || "/api";
const SESSION_KEY = "rfpis.session";
const DONOR_CACHE_KEY = "rfpis.donors.v1";

export type TenantRef = { id: string; name: string | null; slug: string | null };
export type MembershipRef = TenantRef & { role: string | null };

export type User = {
  email: string;
  name: string;
  role: string;            // the account's role (users.role) — what permissions read
  roleLabel: string;
  tenant: TenantRef | null;
  tenantRole: string | null;
  view: TenantRef | null;  // a super_user viewing another tenant
  memberships?: MembershipRef[];
  homeIsDeveloper?: boolean;
};

/** A signed-in session, or the restricted one that may only choose a new password. */
type Stored = { token: string; expiresAt: number; user: User; mustChangePassword?: boolean };

export class ApiError extends Error {
  status: number;
  problems: string[];
  constructor(status: number, message: string, problems: string[] = []) {
    super(message);
    this.status = status;
    this.problems = problems;
  }
}

// In-memory copy so a browser that blocks storage still keeps the session for this page.
let memory: Stored | null = null;
const listeners = new Set<() => void>();
// Bumped on every write, so a refreshed user (same token, new fields) re-renders the app.
let version = 0;
export const sessionVersion = () => version;

function readSession(): Stored | null {
  let s = memory;
  try {
    s = (JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as Stored | null) ?? memory;
  } catch {
    // storage blocked — fall back to memory
  }
  return s && s.expiresAt > Date.now() / 1000 ? s : null;
}

function writeSession(s: Stored | null) {
  memory = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(DONOR_CACHE_KEY);
    }
  } catch {
    // storage blocked: the session lives only as long as this page
  }
  version++;
  listeners.forEach((f) => f());
}

export function onSessionChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function currentSession(): Stored | null {
  return readSession();
}

export function signOut(): void {
  writeSession(null);
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const s = readSession();
  const headers = new Headers(init.headers);
  if (s) headers.set("Authorization", `Bearer ${s.token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  let r: Response;
  try {
    r = await fetch(BASE + path, { ...init, headers });
  } catch {
    throw new ApiError(0, "Couldn't reach the server. Check your connection and try again.");
  }
  const body = (await r.json().catch(() => ({}))) as { error?: string; problems?: string[] };
  if (!r.ok) {
    if (r.status === 401 && s && !PUBLIC.has(path)) signOut();
    throw new ApiError(r.status, body.error ?? `Request failed (${r.status}).`, body.problems ?? []);
  }
  return body as T;
}

const PUBLIC = new Set(["/login", "/tokens/peek", "/tokens/redeem", "/password/reset-request"]);
const post = <T>(path: string, data: unknown = {}) =>
  call<T>(path, { method: "POST", body: JSON.stringify(data) });
const patch = <T>(path: string, data: unknown = {}) =>
  call<T>(path, { method: "PATCH", body: JSON.stringify(data) });
const del = <T>(path: string) => call<T>(path, { method: "DELETE" });

/** Store a session the API just issued, keeping the user fields /me adds. */
function adopt(res: Stored): User {
  writeSession(res);
  return res.user;
}

export async function login(email: string, password: string): Promise<Stored> {
  const res = await post<Stored>("/login", { email, password });
  adopt(res);
  return res;
}

export const forcedChange = (current: string, password: string, confirm: string) =>
  post<Stored>("/password/forced-change", { current, password, confirm }).then(adopt);

export async function me(): Promise<User> {
  const r = await call<{ user: User }>("/me");
  const s = readSession();
  if (s) writeSession({ ...s, user: r.user });
  return r.user;
}

export const switchTenant = (tenantId: string) => post<Stored>("/session/tenant", { tenantId }).then(adopt);
export const viewAs = (key: string | null) => post<Stored>("/session/view", { key }).then(adopt);

// ── Public account flows ─────────────────────────────────────────────────────
export type TokenInfo = { valid: boolean; purpose?: "invite" | "reset"; email?: string; rules?: string; error?: string };
/** The two forms of the same credential: a link's long token, or an emailed six-digit
 *  code, which is only ever checked against the account its email names. */
export type Credential = { token: string } | { email: string; code: string };
export const peekToken = (c: Credential) => post<TokenInfo>("/tokens/peek", c);
export const redeemToken = (c: Credential, password: string, confirm: string) =>
  post<{ ok: true; email: string; purpose: "invite" | "reset" }>("/tokens/redeem",
    { ...c, password, confirm });
export const requestReset = (email: string) =>
  post<{ ok: true; message: string }>("/password/reset-request", { email });

// ── Pipeline ─────────────────────────────────────────────────────────────────
/** A screened row, as `/pipelines/screen` projects it. Fields the projection does not yet
 *  carry are optional rather than assumed: the page renders a dash and keeps working. */
export type ScreenRow = {
  uid: string;
  opportunity_title: string | null;
  funding_agency: string | null;
  call_award_value: number | null;
  currency: string | null;
  call_submission_deadline: string | null;
  call_geographic_scope: string[] | null;
  call_domain_areas: string[] | null;
  opportunity_link: string | null;
  review_week: string | null;
  alignment_score: number | null;
  auto_recommendation: string | null;
  decision: string | null;
  is_duplicate: boolean | null;
  duplicate_of_uid: string | null;
  applicant_role?: string | null;
  key_risks?: string | null;
  feasibility?: string | null;
  /** When the stored score was last computed, and under which profile (migration 101).
   *  A row saved moments ago may still be carrying the score it had BEFORE the edit,
   *  for the minute or so the re-score job takes — see `scoreIsBehind`. */
  scored_at?: string | null;
  score_profile_sig?: string | null;
  /** The flag the app reads as "a human has reviewed this", stamped only by
   *  POST /pipelines/decision. A `decision` without it is the engine's, not a person's. */
  decision_date?: string | null;
  decision_note?: string | null;
  progress_status?: string | null;
  donor_decision?: string | null;
};

/**
 * Is this row's stored score older than the edit that should have changed it?
 *
 * Deliberately NOT "is the score stale against the current profile" — only the job knows
 * the current profile signature, and guessing at it here would put a second opinion about
 * freshness next to the authoritative one. This answers the narrower question a page can
 * actually act on: the row was saved after it was last scored, so a re-score is in flight.
 */
export const scoreIsBehind = (r: {
  scored_at?: string | null; decision_overridden_at?: string | null;
}) => Boolean(r.scored_at && r.decision_overridden_at
  && Date.parse(r.decision_overridden_at) > Date.parse(r.scored_at));

export type Weeks = {
  year: number;
  weeks: string[];
  /** The week we are in. A fact about today, not a selection. */
  current: string;
  /**
   * The week a review screen OPENS on: the one before `current`. A week runs Monday to
   * Sunday and the team reviews it on the following Monday, when the current week is a day
   * old — measured 2026-11-09, it held 0 rows against the previous week's 2. The selector
   * still offers every week and still honours whatever is picked.
   */
  defaultWeek: string;
  weeksWithData: { week: string; count: number }[];
};

export const fetchWeeks = () => call<Weeks>("/pipelines/weeks");
export const fetchScreen = (week: string) =>
  call<{ rows: ScreenRow[] }>(`/pipelines/screen?week=${encodeURIComponent(week)}`);

/** A reviewed row. Everything ScreenRow carries, plus who decided and when. */
export type ReviewedRow = ScreenRow & {
  decision_date: string | null;
  decision_overridden_by?: string | null;
  decision_overridden_at?: string | null;
  /** The date this decision counts under: `decision_date`, else the override stamp, else
   *  `submitted_at`. Resolved by the API so the page does not own a second opinion about
   *  which period a decision belongs to. */
  decided_on: string;
};

export type Reviewed = {
  from: string; to: string;
  rows: ReviewedRow[];
  /** The most recent decision ANYWHERE, so an empty window can point at it rather than
   *  looking like the stage is broken. Null when nothing has been decided at all. */
  latest: string | null;
  /** Decisions in total, and those carrying no usable date — counted rather than dropped. */
  total: number;
  undated: number;
};

/** The window is when the decision was TAKEN, not when the call was found, so a March
 *  call decided in June belongs to June. */
export const fetchReviewed = (from: string, to: string) =>
  call<Reviewed>(
    `/pipelines/reviewed?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

/** A bid in flight, as `/pipelines/track` projects it. The six membership rules are the
 *  route's (core/pipeline.py::is_active_proceed), not the page's. */
export type TrackRow = ScreenRow & {
  /** Where the application has got to — one of `STAGES`, or null before anyone says. */
  stage: string | null;
  applicant_role: string | null;
  assigned_to: string | null;
  next_action: string | null;
  action_deadline: string | null;
  proposal_lead: string | null;
};

export type Track = {
  year: number;
  rows: TrackRow[];
  /** Leads gathered across each duplicate group, so a bid led from a duplicate row still
   *  shows who is on it. */
  leads: { uid: string; proposalLeads: string[] }[];
  /**
   * Proceeds that fail ONLY the deadline rule: nobody recorded a submission and the date
   * has since passed. Almost always work that went in and was never ticked off — the
   * Excel-migrated rows arrive this way — so they are returned to be ASKED about rather
   * than dropped. On the live table this is 15 rows against 1 active bid.
   */
  awaitingSubmission: TrackRow[];
};

/** A proposal sitting with a funder, as `/pipelines/submitted` projects it. */
export type SubmittedRow = ScreenRow & {
  date_completed: string | null;
  date_of_approval: string | null;
  amount_secured: number | null;
  currency_secured: string | null;
  amount_requested: number | null;
  submissions: number | null;
  stage: string | null;
  proposal_lead: string | null;
  assigned_to: string | null;
  donor_program_officer: string | null;
  expected_award_date: string | null;
  next_action: string | null;
  decision_overridden_at?: string | null;
  /** The date the wait is measured from: `date_completed`, else `submitted_at`. Resolved
   *  by the API so the page does not own a second opinion about it. */
  submitted_on: string | null;
  /** False when `submitted_on` fell back to the intake date, so the page can say the wait
   *  is approximate instead of presenting a guess as the day it went to the funder. */
  submitted_on_exact: boolean;
};

export type Submitted = {
  from: string; to: string;
  rows: SubmittedRow[];
  /**
   * Every proposal still waiting, whatever its date — NOT just the ones in the window.
   * Waiting is a state rather than an event, so a submission from last March still counts
   * as outstanding; `rows.length < total` is how the page knows to offer a wider period
   * rather than quietly understating what is owed to the team.
   */
  total: number;
  /** The longest wait anywhere, and the most recent submission. Both outside the window. */
  oldest: string | null;
  latest: string | null;
  /** Waiting proposals with no usable date at all — counted, never dropped. */
  undated: number;
};

/** The window is when the proposal WENT IN, not when the call was found. */
export const fetchSubmitted = (from: string, to: string) =>
  call<Submitted>(
    `/pipelines/submitted?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

/** An application the funder has answered, as `/pipelines/outcome` projects it. */
export type OutcomeRow = ScreenRow & {
  date_completed: string | null;
  date_of_approval: string | null;
  amount_secured: number | null;
  currency_secured: string | null;
  amount_requested: number | null;
  submissions: number | null;
  proposal_lead: string | null;
  donor_program_officer: string | null;
  kickoff_date: string | null;
  project_duration: string | null;
  /** The day the funder answered: `date_of_approval`, else `date_completed`, else
   *  `submitted_at`. Resolved by the API. */
  outcome_on: string | null;
  /** How many donor-side applications this row IS — `core/records.py::submission_weight`.
   *  A row submitted twice is two, and a row whose progress never reached Completed is
   *  ZERO, which is what `ledgerGap` surfaces. */
  applications: number;
  /** Converted server-side at the live rate, so the page adds up one set of numbers.
   *  The request uses the currency WE submitted in, not the call's advertised one. */
  usd_requested: number;
  usd_secured: number;
};

export type Outcome = {
  from: string; to: string;
  rows: OutcomeRow[];
  /**
   * SUBMISSION-WEIGHTED, not row counts. `pending` is here only so the Funding page's win
   * rate — approved over everything submitted, including what is still waiting — stays
   * recomputable from this one response. This stage's own rate divides by the DECIDED
   * applications, because it shows only answered ones; live, that is 44% against the
   * Funding page's 17%, and they answer different questions.
   */
  counts: { applications: number; approved: number; notApproved: number; pending: number };
  /** USD. `unsecured` is what was asked for on applications that were turned down —
   *  funding lost, not funding not yet won. `rates` is what each currency converted at. */
  money: {
    requested: number; secured: number; unsecured: number;
    rates: Record<string, [number | null, string | null]>;
  };
  /** Answered rows the ledger counts as zero applications, because `progress_status`
   *  never reached Completed. Reported, never repaired — writing it is the resurrection
   *  migration 089 undid. */
  ledgerGap: string[];
  total: number;
  undated: number;
  latest: string | null;
};

/** The window is when the FUNDER ANSWERED, not when the call was found. */
export const fetchOutcome = (from: string, to: string) =>
  call<Outcome>(
    `/pipelines/outcome?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

export const fetchTrack = (from?: string, to?: string) =>
  call<Track>("/pipelines/track" + (from && to
    ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : ""));

/**
 * Save columns on one RFP. Sparse — only what changed.
 *
 * The response's `rescore` is not null whenever the save touched something the score
 * depends on; a stage change never does, which is why the Bidding stepper costs no job.
 */
export const saveRfpFields = (uid: string, fields: Record<string, unknown>) =>
  patch<{ row: TrackRow; warnings: Warning[]; rescore: { job_id: string } | null }>(
    `/pipelines/rfp/${encodeURIComponent(uid)}`, { fields });

/** What a write route says about the work it could not finish inline. */
export type Warning = { code: string; detail: string };

/**
 * Record a human decision. `note` omitted leaves the previous rationale in place; `""`
 * clears it, which is how a reviewer changing their verdict drops the reasoning for the
 * one they abandoned.
 *
 * `recorded` is the queued job that writes the scan's tombstone and the training label.
 * When it comes back null there is a warning saying so, and it matters: a Decline whose
 * tombstone was never written can be found again by the next scan.
 */
export const recordDecision = (
  uid: string, decision: string, note?: string, decisionDate?: string,
) =>
  post<{ row: ScreenRow; warnings: Warning[]; recorded: { job_id: string } | null }>(
    "/pipelines/decision", {
      uid, decision,
      ...(note === undefined ? {} : { note }),
      // Omitted means "today", which is right for a decision recorded as it is taken and
      // wrong for one being written up later. The server rejects a future date rather
      // than quietly substituting today.
      ...(decisionDate ? { decision_date: decisionDate } : {}),
    });

// ── App shell ────────────────────────────────────────────────────────────────
export type FeedItem = {
  ts: number; icon: string; title: string; detail: string; nav: string;
  uid: string | null;
  /** The bell shows a line; the Alerts screen opens one of these. */
  kind: "scan" | "opportunity" | "verdict";
  facts?: { label: string; value: string }[];
};
export type Shell = {
  org: { name: string; logo: { b64: string; mime: string } | null };
  nextMeeting: { date: string; note_taker: string; presenter: string; chair: string } | null;
  feed: FeedItem[];
  seen: number | null;
  unread: number;
  classicUrl: string | null;
};
export const fetchShell = () => call<Shell>("/shell");
export const markAllRead = () => post<{ ok: true; seen: number }>("/notifications/read");

// ── Background jobs ──────────────────────────────────────────────────────────
export type Job = {
  id: string; kind: string; status: "queued" | "dispatched" | "running" | "done" | "failed" | "cancelled";
  progress: { pct: number | null; message: string } | null; message: string | null;
  result: Record<string, unknown> | null; created_at: string; started_at: string | null;
  finished_at: string | null; run_url: string | null;
};
export const startJob = (kind: string, params: Record<string, unknown> = {}) =>
  post<{ job: Job }>("/jobs", { kind, params }).then((r) => r.job);
export const fetchJob = (id: string) => call<{ job: Job }>(`/jobs/${encodeURIComponent(id)}`).then((r) => r.job);

// ── Home, the rail and one opportunity ───────────────────────────────────────
/** The Dashboard's figures. Each band is a PARTITION of the one above it:
 *    found             = awaiting_review + proceed + parked + declined  (calls)
 *    applications_sent = awaiting_answer + approved + not_approved      (applications)
 *  so a reader can check the sums by eye. routes_phase1.ts::home says why "submitted"
 *  became `sent_to_funder` and which of its four possible meanings won. */
export type HomeKpis = {
  found: number; awaiting_review: number;
  proceed: number; parked: number; declined: number; due_in_14_days: number;
  // APPLICATIONS, not calls: a proposal resubmitted to the same funder is two attempts
  // (core/records.py::submission_weight). Counting rows made the Dashboard disagree with
  // the Funding page by 2 on sent and 1 on not-approved.
  applications_sent: number; awaiting_answer: number;
  approved: number; not_approved: number;
  /** Answered by a funder yet weighing zero applications, because progress_status never
   *  reached Completed. Surfaced so the arithmetic can be trusted when it does not add up. */
  ledger_gap: number;
  /** The rows behind "Due in 14 days", soonest first. A count says there is
   *  work; the list is what lets somebody start it. */
  closing_soon: {
    uid: string; title: string; funder: string;
    deadline: string | null; usd: number;
  }[];
  usd_requested: number; usd_secured: number;
  /** Requested over applications a funder has ANSWERED - the ratio's own
   *  denominator. Over everything sent the share drifts down on every
   *  submission; live, the two readings are 28.8% and 62.0%. */
  usd_requested_decided: number; pct_won_of_decided: number | null;
};
export const fetchHome = () => call<HomeKpis>("/home");

// ── The triage list ──────────────────────────────────────────────────────────

/** One of the Dashboard's figures, as something you can open.
 *
 * `kind` matters and the page says it out loud: four of these weigh APPLICATIONS rather
 * than count rows, because a proposal sent to the same funder twice is two applications
 * and one call. So "Applications sent 24" opens a list of 21 opportunities, and the page
 * reports both numbers instead of looking broken. */
export type OpportunityBucket = {
  key: string;
  label: string;
  kind: "rows" | "applications";
  /** One line a reader can check the selection against. */
  rule: string;
  count: number;
};

export type OpportunityListRow = {
  uid: string;
  title: string;
  funder: string;
  link: string | null;
  deadline: string | null;
  found: string | null;
  submitted: string | null;
  decision: string | null;
  donorDecision: string | null;
  stage: string | null;
  progress: string | null;
  role: string | null;
  lead: string | null;
  score: number | null;
  recommendation: string | null;
  currency: string | null;
  value: number | null;
  usd: number;
  requestedUsd: number;
  securedUsd: number;
  /** What this one row weighs in the application figures — 0 until it is Completed. */
  applications: number;
  /** The Dashboard figures this row belongs to. The page filters on THIS and owns no
   *  definition of its own; the server computed it with the same code that counts the
   *  tiles (supabase/functions/_shared/api/home_buckets.ts). */
  buckets: string[];
};

export type OpportunityList = {
  today: string;
  buckets: OpportunityBucket[];
  rows: OpportunityListRow[];
};

export const fetchOpportunityList = () => call<OpportunityList>("/opportunities/list");

/** One item in the rail's four cards. supabase/functions/_shared/api/opportunity_feed.ts
 * builds these; core/opportunity_feed.py's `_item` / `catalog_item` are what it mirrors.
 *
 * Not to be confused with `FeedItem` above, which is the app shell's activity feed. */
export type OpportunityFeedItem = {
  uid: string | null;
  title: string;
  funder: string;
  amount: number;
  currency: string;
  deadline: string | null;
  days_until: number | null;
  geo: string;
  alignment: number;
  link: string;
  recommendation: string;
  /** Featured only: why this call was surfaced, and the score behind it. */
  _why?: string;
  _score?: number;
};

export type OpportunityFeed = {
  featured: OpportunityFeedItem[];
  top_matches: OpportunityFeedItem[];
  top_funding: OpportunityFeedItem[];
  other: OpportunityFeedItem[];
};

/** The rail's four cards, ranked by the server.
 *
 * The ranking used to run in the browser's Python engine over rows from `/feed`. It needs
 * no scoring — it ranks values already stored on each row — so it moved server-side, and
 * the rail no longer boots a Python runtime to draw a sidebar. */
export const fetchOpportunityFeed = () => call<OpportunityFeed>("/opportunities/feed");

export const fetchOpportunityRows = (uid: string) =>
  call<{
    uid: string;
    pipelineRow: Record<string, unknown> | null;
    catalogRow: Record<string, unknown> | null;
    extraction: Record<string, unknown> | null;
    isSuper: boolean;
  }>(`/opportunity?uid=${encodeURIComponent(uid)}`);

/** Everything the Python scoring path reads from the database, with this caller's
 * permissions and tenant scope already applied. */
export const fetchSnapshot = () => call<import("./scoring/protocol").ScoringSnapshot>("/scoring/snapshot");

// ── The RFP editor ───────────────────────────────────────────────────────────
// One record and one vocabulary list, both feeding the single editor in
// src/opportunity/RfpEditor.tsx. Every screen that edits an opportunity opens that
// component, which is why these are not per-screen shapes.

/** One opportunity, every column, plus its linked grant when the Reporting tab is open.
 *
 * Unprojected on purpose — the editor writes about sixty columns, so a projection would be
 * a list of nearly the whole table that then has to be kept in step with the form. The row
 * is typed loosely for the same reason: the form reads it by column name and the server
 * already refuses any name that is not editable. */
export type RfpRecord = {
  row: Record<string, unknown>;
  grant: Record<string, unknown> | null;
};

export const fetchRfp = (uid: string, reporting = false) =>
  call<RfpRecord>(
    `/pipelines/rfp/${encodeURIComponent(uid)}${reporting ? "?reporting=1" : ""}`);

/**
 * What the editor's dropdowns offer — `core/dropdowns.py::load` for the browser.
 *
 * Fetched rather than bundled because two of these are per-deployment settings rather than
 * repo data: the team roster is tenant-scoped and deliberately absent from the repo, and
 * the currency table can be overridden in Admin → Settings. The rest are generated from
 * the Python that owns them (scripts/gen_form_vocab.py).
 */
export type FormOptions = {
  dropdowns: Record<string, string[]>;
  programAreas: string[];
  geoOptions: string[];
  criterionAnswers: Record<string, string[]>;
  /** Stored value (lower-cased) → the answer it pre-selects, as
   *  core/scorer.default_response resolves it. Resolved server-side because it
   *  runs through criterion_score, which is a scoring rule. */
  criterionDefaults: Record<string, Record<string, string>>;
  opportunityTypes: string[];
  solicitationTypes: string[];
  instrumentTypes: string[];
  teamMembers: string[];
  currencies: string[];
};

export const fetchFormOptions = () => call<FormOptions>("/pipelines/form-options");

/** The editor's save. Sparse, and `reporting` only when that tab was shown — the server
 *  must not guess at tab visibility, so an absent key means "do not touch the grant". */
export const saveRfp = (
  uid: string,
  fields: Record<string, unknown>,
  reporting?: Record<string, unknown>,
) =>
  patch<{
    row: Record<string, unknown>;
    warnings: Warning[];
    rescore: { job_id: string } | null;
  }>(`/pipelines/rfp/${encodeURIComponent(uid)}`, {
    fields,
    ...(reporting === undefined ? {} : { reporting }),
  });

/**
 * Delete one opportunity. Admin only, and it does NOT come back deleted: the server
 * answers 202 with a job, and the row is still there until that job has written the
 * scan's tombstone and then removed it. The caller waits for the job before it says the
 * opportunity is gone — see `pipeline_writes.ts::deleteRfp` for why the order cannot be
 * the other way round. A 503 means nothing was removed at all.
 */
export const deleteRfp = (uid: string) =>
  del<{ uid: string; title: string | null; queued: { job_id: string } }>(
    `/pipelines/rfp/${encodeURIComponent(uid)}`);

// ── Donors ───────────────────────────────────────────────────────────────────
export const fetchDonors = () => call<{ donors: Donor[] }>("/donors").then((r) => {
  try {
    localStorage.setItem(DONOR_CACHE_KEY, JSON.stringify(r.donors));
  } catch {
    // quota or blocked storage — the next load just waits for the network
  }
  return r.donors;
});

/** Last donor list this browser loaded, so a reload paints instantly while it refreshes. */
export function cachedDonors(): Donor[] | null {
  try {
    return JSON.parse(localStorage.getItem(DONOR_CACHE_KEY) ?? "null") as Donor[] | null;
  } catch {
    return null;
  }
}
export const fetchContacts = (key: string) =>
  call<{ contacts: Contact[] }>(`/donors/${encodeURIComponent(key)}/contacts`).then((r) => r.contacts);
