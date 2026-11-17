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
  /** This call's own deadline has gone by — `deadlinePassed`, decided server-side so the
   *  page does not own a second definition of "expired". The row is still counted, because
   *  what the scan found that week is history; it just leaves the review queue. */
  expired?: boolean;
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

/** Where a row's score stands with the job meant to produce it. Null, or absent on an
 *  older API, means settled: the stored number is the one the server computed. */
export type RescoreState = "pending" | "failed";

/**
 * Is a re-score actually on its way for this row?
 *
 * Still deliberately NOT "is the score stale against the current profile" — only the job
 * knows the current profile signature, and guessing at it here would put a second opinion
 * about freshness next to the authoritative one.
 *
 * WHAT CHANGED, 2026-11-16. This used to be computed here, as
 * `decision_overridden_at > scored_at`: saved since it was scored, so a re-score must be
 * in flight. That inference was wrong in both directions of the server's actual behaviour.
 * `PATCH /pipelines/rfp/:uid` stamps `decision_overridden_at` on every save and queues a
 * re-score only when the save touched a scoring input; `POST /pipelines/decision` stamps
 * it and queues `record_decision`, which does not score at all. So changing a next action,
 * or recording a decision, left the row looking permanently mid-recalculation — three rows
 * had been spinning since 9 November under scores that were correct and settled.
 *
 * The queue is the only thing that knows, and the queue is the server's, so the server now
 * answers it: `rescore_state`, from `routes_pipelines.rescoreStateByUid`. A row served by
 * an older API has no such field and simply does not spin, which is the right way for this
 * to degrade.
 */
export const scoreIsBehind = (r: { rescore_state?: RescoreState | null }) =>
  r.rescore_state === "pending";

/**
 * Did the re-score this row was waiting for die?
 *
 * A separate question from the one above and a louder one. A job that was dispatched and
 * then failed leaves the row holding a number from BEFORE the edit that queued it, with
 * nothing in flight to replace it — so a page that only knew about `pending` would show
 * that number as settled. The save-time path warns when the enqueue itself fails; this is
 * the case where it started and died, which is what the dispatch-token outage produced.
 */
export const rescoreFailed = (r: { rescore_state?: RescoreState | null }) =>
  r.rescore_state === "failed";

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
  /** How the last `rescore` job for this row ended: still in flight, or dead. Answered
   *  from the job queue by the API — see `scoreIsBehind` for why the page cannot work this
   *  out from the save stamps. Null when the row is settled; absent on an older API. */
  rescore_state?: RescoreState | null;
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
  /** The app owner to contact for account and data requests. Falls back to a visibly
   *  unconfigured placeholder when ADMIN_CONTACT_EMAIL is not set, in both apps. */
  adminContactEmail: string;
  /** False when it is the unset placeholder — do not print it at somebody. */
  adminContactConfigured?: boolean;
  /** The parts of the chrome that could not be READ, as opposed to being empty: any of
   *  "feed", "seen", "meeting", "org", "classicUrl". The shell renders either way — it is
   *  on every page — so this is how a panel says "unavailable" instead of drawing an empty
   *  state that reads as a fact about the user's data. Absent on an older API. */
  unavailable?: string[];
};

/** Did this part of the chrome fail to load, rather than come back empty? */
export const shellPartFailed = (s: Shell | null, part: string) =>
  Boolean(s?.unavailable?.includes(part));
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
  found: number;
  /** Still OPEN and undecided. A call whose deadline has passed is not awaiting a decision
   *  anybody can act on, so it is counted below instead. */
  awaiting_review: number;
  /** Undecided, deadline gone. Not a prompt — but the bar still has to add up. */
  expired_unreviewed: number;
  /** Every call whose deadline has passed, decided or not. Overlaps the others on
   *  purpose: a submitted proposal still awaiting its funder is archived AND awaiting. */
  archived: number;
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
  /** Countries alone — a person's location on the Profile page, where the regions and
   *  income tiers in `geoOptions` are not answers. */
  countries: string[];
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
/**
 * Donor writes. Every one QUEUES a job and returns its id — none of them changes a donor
 * before the caller polls it (`awaitJob`). The rules live in core/donor_write.py so the
 * runner and the Streamlit page apply the same ones to this shared, cross-tenant table.
 *
 * `suggest: true` files a proposal for review instead of writing. Which of the two a
 * given user is allowed to do is decided in the job, against the users table — not here,
 * and not by hiding a button.
 */
export type DonorJob = { job_id: string; dispatched: boolean; detail: string };

export const createDonor = (
  name: string, opts: { edited?: Record<string, unknown>; suggest?: boolean; rationale?: string } = {},
) => call<DonorJob>("/donors", { method: "POST", body: JSON.stringify({ name, ...opts }) });

export const updateDonor = (
  key: string,
  opts: {
    edited: Record<string, unknown>;
    /** OMIT to leave contacts alone. Sending [] DELETES every contact this donor has. */
    contacts?: Record<string, unknown>[];
    suggest?: boolean;
    rationale?: string;
  },
) => call<DonorJob>(`/donors/${encodeURIComponent(key)}`,
  { method: "PATCH", body: JSON.stringify(opts) });

export const deleteDonor = (key: string) =>
  call<DonorJob>(`/donors/${encodeURIComponent(key)}`, { method: "DELETE" });

export const deleteDonors = (keys: string[]) =>
  call<DonorJob>("/donors/delete", { method: "POST", body: JSON.stringify({ keys }) });

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

// ── Report ───────────────────────────────────────────────────────────────────
//
// Every figure on the Report page is computed on the server and arrives as a number. The
// page reads up to 50,000 submissions; shipping those to draw a dozen tiles would cost tens
// of megabytes per period change, and it would put a second copy of each rule in the
// browser to disagree with the Python. So these types are shapes to DRAW, not data to
// reduce — if something here needs arithmetic beyond a percentage of a total, it belongs in
// supabase/functions/_shared/api/report_section*.ts with a parity check on it.

export type ReportSelection = { period: string; year: number; month: string; view: string };
export type ReportBounds = { start: string | null; end: string | null };

export type ReportPeriods = {
  today: string;
  currentYear: number;
  options: { periods: string[]; views: string[]; months: string[]; yearMin: number; yearMax: number };
  selection: ReportSelection;
  bounds: ReportBounds;
  label: string;
  phrase: string;
  slug: string;
  cadence: string;
  bucketLabel: string;
  /** Null under All time: the window then comes from the rows, so each series brings its own. */
  buckets: string[] | null;
};

/** What a saved `?r=` link resolves to, plus everything /report/periods returns. */
export type ReportSnapshot = ReportPeriods & {
  rid: string | null;
  found: boolean;
  /** An id was asked for and was not there — it may have aged out of the newest 100. */
  missing: boolean;
  createdAt: string | null;
  restored: { secs: string[]; items: string[] };
  savedSignature: string | null;
  catalog: {
    sections: { id: string; label: string; items: { key: string; label: string }[] }[];
    allKeys: string[];
    allSecIds: string[];
  };
};

const periodQuery = (sel: ReportSelection) =>
  `?period=${encodeURIComponent(sel.period)}&year=${sel.year}`
  + `&month=${encodeURIComponent(sel.month)}&view=${encodeURIComponent(sel.view)}`;

export const fetchReportSnapshot = (rid: string | null) =>
  call<ReportSnapshot>(`/report/snapshot${rid ? `?r=${encodeURIComponent(rid)}` : ""}`);

/** Generate: save the selection, get the short id that goes in the URL. */
export const saveReportSnapshot = (sel: ReportSelection, secs: string[], items: string[]) =>
  post<{ rid: string; createdAt: string }>("/report/snapshot", { ...sel, secs, items });

type Bucketed<T> = T & { bucket: string };
/** Every ranked block ships the full map AND the top slice; the page draws the slice.
 *  `all` is deliberately loose — the page never reads it, and typing it would be a second
 *  description of a shape only the server's own parity check needs to be exact about. */
type Ranked = { all: Record<string, unknown> };

export type ReportSection1 = {
  selection: ReportSelection; bounds: ReportBounds; label: string; bucketLabel: string;
  intake: {
    total: number; duplicates: number;
    bySource: { source: string; label: string; unique: number; duplicates: number; total: number }[];
  };
  scans: {
    runs: number; found: number; eligible: number; added: number;
    duplicates: number; rejected: number; errorRuns: number;
  };
  discovery: {
    buckets: Bucketed<{ total: number; bySubmitter: Record<string, number> }>[];
    submitters: string[];
    /** True when empty buckets were filled in, so a gap is a real zero and not a missing bar. */
    zeroFilled: boolean;
  };
  donors: { all: Record<string, number>; top: { donor: string; rfps: number }[] };
  focusAreas: { area: string; calls: number }[];
  proceedCount: number;
  keywordSuccess: { keyword: string; hits: number; proceed: number; submitted: number; approved: number }[];
  sources: {
    all: Record<string, unknown>;
    top: { source: string; runs: number; found: number; added: number; rejected: number; avgDur: number; yieldPct: number }[];
  };
  cycle: { n: number; median: number; mean: number; min: number; max: number; days: number[] } | null;
};

export type ReportSection2 = {
  selection: ReportSelection; bounds: ReportBounds; label: string; bucketLabel: string;
  meetings: { logged: number; open: number; resolved: number; pctUnresolved: number };
  donors: { engagements: number; donors: number; avgPerDonor: number; tiedToRfp: number };
  engagements: Bucketed<{ engagements: number }>[];
  topDonors: Ranked & { top: { donor: string; touchpoints: number }[] };
  leads: Ranked & { top: { name: string; submitted: number; unsubmitted: number; total: number }[] };
  contributors: Ranked & { top: { name: string; submitted: number; unsubmitted: number; total: number }[] };
  partners: {
    lead: Ranked & { top: { org: string; rfps: number }[] };
    sub: Ranked & { top: { org: string; rfps: number }[] };
  };
  proceedRows: number;
};

export type ReportSection3 = {
  selection: ReportSelection; bounds: ReportBounds; label: string;
  counts: {
    total: number; proceed: number; park: number; decline: number; noDecision: number;
    submitted: number; approved: number; discoveredInPeriod: number;
  };
  values: { discovered: number; proceed: number; submitted: number; approved: number };
  progress: { status: string; rfps: number }[];
  proceedRows: number;
};

export type ReportSection4 = {
  selection: ReportSelection; bounds: ReportBounds; label: string; bucketLabel: string;
  kpis: {
    decisions: number;
    /** Null when no decided row carries both dates — not zero, which would read as "same day". */
    avgDays: number | null; medianDays: number | null;
    overridden: number; dated: number;
  };
  distribution: { decision: string; count: number }[];
  distributionOrder: string[];
  overTime: Bucketed<{ decisions: number }>[];
  autoRec: { rows: { decision: string; auto: number; team: number }[]; agreed: number; total: number };
  donor: { all: Record<string, number>; ranked: { decision: string; rfps: number }[]; pending: number; order: string[] };
};

export type ReportSection5 = {
  selection: ReportSelection; bounds: ReportBounds; label: string; bucketLabel: string;
  kpis: { submitted: number; approved: number; winRate: number; securedRatio: number };
  money: { requested: number; secured: number; unsecured: number; pipeline: number; pipelineRfps: number };
  /** Rows whose amount has no currency beside it, so their dollars are a guess. */
  missingCurrency: { approved: number; pipeline: number };
  conversion: {
    proceeded: number; submitted: number; approved: number;
    proceededToSubmitted: number; submittedToApproved: number; endToEnd: number;
  };
  outcomes: {
    uid: string; label: string; funder: string; outcome: string; donorDecision: string;
    reqUsd: number; secUsd: number; signedUsd: number;
  }[];
  grants: {
    uid: string; grant: string; funder: string; requestedUsd: number; securedUsd: number;
    donorDecision: string; submissions: number; submittedOn: string | null;
  }[];
  cumulative: Bucketed<{ secured: number; cumulative: number }>[];
};

export const fetchReportSection1 = (s: ReportSelection) => call<ReportSection1>(`/report/section1${periodQuery(s)}`);
export const fetchReportSection2 = (s: ReportSelection) => call<ReportSection2>(`/report/section2${periodQuery(s)}`);
export const fetchReportSection3 = (s: ReportSelection) => call<ReportSection3>(`/report/section3${periodQuery(s)}`);
export const fetchReportSection4 = (s: ReportSelection) => call<ReportSection4>(`/report/section4${periodQuery(s)}`);
export const fetchReportSection5 = (s: ReportSelection) => call<ReportSection5>(`/report/section5${periodQuery(s)}`);

/**
 * The six-sheet data export. A JOB, not a download: the workbook is built by openpyxl over
 * every row in the period, which no Edge Function CPU budget survives.
 *
 * Returns the queued job — poll it with `awaitJob`. A finished one carries
 * `ReportExportResult` in `job.result`, with a SHORT-LIVED signed URL to a private bucket;
 * `expiresInS` is how long that link lasts, and it is worth saying out loud, because the
 * natural thing for a reader to do with it is paste it into a chat thread.
 *
 * `rid` is the `?r=` report id, which only shapes the filename — the rows come from the
 * period, not from the snapshot. The period itself is sent so the server resolves it once,
 * the same way every section route does.
 */
export type ReportExportResult = {
  url: string; filename: string; bytes: number; expiresInS: number;
  /** Sheet name to row count. A sheet is absent when the period held none of that thing. */
  sheets: Record<string, number>;
  pruned: number; runner: string;
};

export const requestReportExport = (sel: ReportSelection, rid: string | null) =>
  post<{ job: Job; filename: string }>("/report/export", { ...sel, r: rid ?? "" });

// ── Applications ───────────────────────────────────────────────────────────
//
// The rail called this Bids Submitted until 2026-11-16.
// Every application ever sent to a funder, with no date window. Deliberately NOT the
// Pipeline's Outcome stage, which answers "what did funders decide in this window" — live
// the two win rates are 17% and 44%, and both are right because they divide by different
// things. See supabase/functions/_shared/api/grants.ts.

export type GrantRow = {
  uid: string; title: string; funder: string; status: string;
  decision: string; progress: string;
  approved: boolean; pending: boolean; notApproved: boolean;
  /** The KPI's unit — zero for a row whose progress never reached Completed. */
  applications: number;
  /** The by-funder table's unit — `submissions` filled to 1, with no progress gate. */
  submissions: number;
  usdRequested: number; usdSecured: number;
  /** As entered, shown beside the conversion so the page cannot look like it disagrees
   *  with the editor. */
  amountRequested: number | null; amountSecured: number | null;
  requestCurrency: string; securedCurrency: string;
  deadline: string | null; dateSubmitted: string | null; expectedAward: string | null;
  /** The date this page ORDERS and FILTERS by — `date_completed`, else the deadline, else
   *  the day the row was logged. `dateSource` says which, so a stand-in can be labelled. */
  periodDate: string | null;
  dateSource: "completed" | "deadline" | "logged" | "none";
  role: string; leadApplicant: string; subApplicant: string; proposalLead: string;
  geography: string[]; link: string;
};

export type GrantFunderRow = {
  funder: string; rfps: number; submissions: number;
  approved: number; pending: number; notApproved: number;
  requested: number; secured: number;
};

export type Grants = {
  counts: { submitted: number; approved: number; pending: number; notApproved: number; rows: number };
  money: { requested: number; secured: number; unsecured: number; balance: number };
  winRate: number;
  rows: GrantRow[];
  byFunder: GrantFunderRow[];
  rates: Record<string, [number | null, string | null]>;
  /** Answered rows the weighted count scores as zero. Reported, never repaired. */
  ledgerGap: string[];
  /** The window every figure above was computed for. */
  period: {
    selection: GrantSelection;
    bounds: { start: string | null; end: string | null };
    label: string;
  };
  /**
   * The years the page may offer: every year with a bid, plus the current one, newest
   * first, never a future one. Derived from the rows and the clock, so next year appears
   * on its own without a code change.
   */
  years: number[];
  /** Submitted bids outside the window, so an empty table can be told from no data. */
  hiddenByPeriod: number;
};

/**
 * Two controls, not one: a WINDOW, and the YEAR it is anchored in.
 *
 * A rolling window ends on today when the chosen year is the current one (or none is
 * chosen) and on 31 December of that year otherwise, clamped so it never reaches outside
 * it. "Last 30 days" of 2025 is 2-31 December 2025. See api/grants.ts for why.
 */
export type GrantWindow = "all" | "7d" | "30d" | "90d" | "365d";
export type GrantSelection = {
  window: GrantWindow;
  /** null = the whole record, every year. */
  year: number | null;
  /** Only applied when `window` is "all". */
  quarter: number | null;
};

/**
 * Every figure on the Applications page for one window.
 *
 * The window is a QUERY PARAMETER rather than something the page applies to what it got,
 * because the tiles, the money, the win rate and the by-funder table are all aggregates
 * the server computes. Filtering here would leave them answering a different question from
 * the list underneath them.
 */
export const fetchGrants = (sel?: GrantSelection) => {
  const p = new URLSearchParams();
  if (sel) {
    if (sel.window !== "all") p.set("window", sel.window);
    if (sel.year) p.set("year", String(sel.year));
    // A quarter only means something inside a whole year; sending it with a rolling
    // window would ask the server to honour two windows at once, which it will not.
    if (sel.year && sel.quarter && sel.window === "all") p.set("quarter", String(sel.quarter));
  }
  const qs = p.toString();
  return call<Grants>(`/grants${qs ? `?${qs}` : ""}`);
};

// ── Meetings ──────────────────────────────────────────────────────────
//
// One read for all four tabs — they are small, they are read together, and four round
// trips to paint a Monday-morning screen is how a page comes to feel slow.

export type MeetingNote = {
  id: string; meetingDate: string | null; rfpUid: string; donorTitle: string;
  remarks: string; actions: string; owner: string; deadline: string | null;
  resolved: boolean; createdAt: string | null;
};

export type Engagement = {
  id: string; date: string | null; donor: string; type: string; format: string;
  internalLead: string; donorContacts: string; purpose: string; outcome: string;
  rfpUid: string;
  /** A NULL in the column reads as not resolved, so this is never null. */
  resolved: boolean;
  open: boolean;
};

export type RotaEntry = { date: string; noteTaker: string; presenter: string; chair: string; cid: string };

export type Actions = {
  week: { monday: string; sunday: string; label: string };
  rota: RotaEntry | null;
  weeks: string[];
  notes: MeetingNote[];
  engagements: Engagement[];
  pending: {
    notes: MeetingNote[]; engagements: Engagement[];
    meetingTotal: number; meetingOpen: number; meetingPct: number;
    engagementTotal: number; engagementOpen: number; engagementPct: number;
    owners: { name: string; items: number }[];
  };
  schedule: RotaEntry[];
  quarter: { from: string; count: number };
  canEditSchedule: boolean;
};

export const fetchActions = (week?: string) =>
  call<Actions>(`/actions${week ? `?week=${encodeURIComponent(week)}` : ""}`);

export const createNote = (n: Partial<MeetingNote> & { actions: string }) =>
  post<{ id: string }>("/actions/notes", n);
/** Sparse: send only what changes. The resolve toggle sends `{resolved}` alone. */
export const patchNote = (id: string, patch: Record<string, unknown>) =>
  call<{ ok: true }>(`/actions/notes/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(patch) });

export const createEngagement = (e: Record<string, unknown>) =>
  post<{ id: string }>("/actions/engagements", e);
export const patchEngagement = (id: string, patch: Record<string, unknown>) =>
  call<{ ok: true }>(`/actions/engagements/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(patch) });

/** Replaces the whole rota — the store is one blob, as it has always been. */
export const putSchedule = (schedule: RotaEntry[]) =>
  call<{ ok: true; count: number }>("/actions/schedule",
    { method: "PUT", body: JSON.stringify({ schedule }) });

// ── Submit New Notice ────────────────────────────────────────────────────────

/** What the form sends. Every key optional: the server validates, not the client. */
export type SubmitPayload = {
  title: string;
  opportunityId?: string;
  funder?: string;
  brief?: string;
  datePosted?: string;
  deadline?: string;
  awardDate?: string;
  applicantRole?: string;
  fundingWindow?: string;
  timeToAward?: string;
  submissionFormat?: string;
  link?: string;
  value?: string;
  currency?: string;
  duration?: string;
  focusTheme?: string;
  leadApplicant?: string;
  subApplicant?: string;
  geo?: string[];
  programAreas?: string[];
  criteria?: Record<string, string>;
  feasibility?: string;
  declineFlags?: boolean;
  keyRisks?: string;
  decision?: string;
  rationale?: string;
  proposalLead?: string;
  contributors?: string[];
  reviewers?: string[];
};

export type SubmitResult = {
  uid: string;
  alignmentScore: number;
  autoRecommendation: string;
  /** The deadline has already passed and nothing marks the bid submitted — the page
   *  prompts for the one field that stops it reading as a missed opportunity. */
  needsSubmissionCheck: boolean;
  warnings: Warning[];
};

/**
 * Capture one opportunity. Never refused for being a duplicate — that policy is the
 * server's and the reasoning is in api/submit.ts.
 *
 * `offsetMinutes` is sent, not read from the server, because the UID carries the
 * submitter's own date and minute the way the Streamlit app's does. The clock stays the
 * server's; only the zone comes from here.
 */
export const submitNotice = (payload: SubmitPayload) =>
  post<SubmitResult>("/submit", { ...payload, offsetMinutes: -new Date().getTimezoneOffset() });

// ── Search ───────────────────────────────────────────────────────────────────
//
// Two halves with two shapes. The in-app search is a static nav registry and two ilike
// queries, so it answers in the request. Web discovery holds the provider keys, fans one
// keyword into several searches, fetches candidate pages and filters them through seven
// rules — 21.4 seconds live — so it is a job the page polls.

export type NavHit = { label: string; href: string; score: number };
export type OppHit = {
  title: string; funder: string; deadline: string; decision: string; source: string;
  uid: string;
};
export type DonorHit = { name: string };

export type SiteSearch = {
  query: string;
  nav: NavHit[];
  opportunities: OppHit[];
  donors: DonorHit[];
  total: number;
};

export const siteSearch = (q: string) =>
  call<SiteSearch>(`/search?q=${encodeURIComponent(q)}`);

/** One hit from the web, as core/web_search.py yields it. */
export type WebHit = {
  title: string; link: string; domain: string; snippet: string;
  deadline?: string | null; page_date?: string | null;
};

/**
 * The web job's result.
 *
 * `available` is false when no provider key is set, which is an administrator's answer the
 * browser cannot work out for itself — the environment holding the keys is the Python's.
 * The `dropped_*` counts are the filter explaining itself: a run that kept 12 of 43 should
 * say where the other 31 went, or the filter looks like a failure.
 */
export type WebSearchResult = {
  available: boolean;
  ok?: boolean;
  mode?: "discovery" | "lookup" | string;
  error?: string;
  raw_count?: number;
  results?: WebHit[];
  suggest?: string[];
  dropped_aggregator?: number;
  dropped_expired?: number;
  dropped_old?: number;
  dropped_notrfp?: number;
  dropped_geo?: number;
  dropped_scholarship?: number;
  dropped_offtopic?: number;
  dropped_lang?: number;
};

/** Queue one web-discovery run. `fresh` drops the 15-minute cache first. */
export const startWebSearch = (q: string, fresh = false) =>
  post<{ jobId: string }>("/search/web", { q, fresh });

export type TrackResult = {
  action: "track";
  ok?: boolean; uid?: string | null; skipped?: boolean; reason?: string;
  routed?: string; rejected?: boolean;
};

/**
 * Rate a web hit, or track it into Found Records.
 *
 * Both run in Python: the rating writes the ML training label, and tracking scores the
 * candidate with auto_scorer, checks the deduplicator and may route it to the Sources
 * registry instead of inserting it. Four outcomes, all the module's judgement.
 */
export const searchAction = (
  action: "feedback" | "track", result: WebHit, verdict?: "good" | "neutral" | "bad",
) => post<{ jobId: string }>("/search/action", { action, result, verdict });

// ── My Organization ──────────────────────────────────────────────────────────
//
// A READ-ONLY view of what the matching engine believes about this tenant, and how much
// of it is still missing. The editor is Settings → Setup; this page links to it.

export type OrgRatingRow = {
  key: string; label: string; category: string; value: number; word: string;
};

export type Organization = {
  /** core/settings.get_org — the blob merged onto the placeholder defaults, with the
   *  display name taken from `tenants.name` rather than the blob's own copy. */
  identity: Record<string, string>;
  /** core/org_profile.get_profile — the stored overlay merged onto DEFAULT_PROFILE,
   *  legacy keys renamed on the way in. */
  profile: Record<string, unknown>;
  /** Ready for a `src`, whether it was stored as base64 or as a URL. */
  logo: string | null;
  /** Resolved server-side, from tables generated out of the Python. */
  labels: { legalType: string; entityType: string };
  /** Pre-sorted by `rating_bars_html`'s own order: value descending, then key. */
  ratings: {
    domain: OrgRatingRow[];
    priority: OrgRatingRow[];
    /** Selected but never graded — plain chips beside the bars. */
    domainUngraded: string[];
    priorityUngraded: string[];
  };
  completeness: {
    pct: number;
    /** The still-unfilled field labels, in the Python's weighted order. */
    missing: string[];
    band: "red" | "amber" | "green";
    /** What is missing before screening can run. Empty = ready. */
    gap: string[];
    /** Any geography at all — a different question from `gap`, and it decides whether
     *  the page warns or merely nudges. */
    hasGeo: boolean;
  };
  team: string[];
  canEdit: boolean;
};

export const fetchOrganization = () => call<Organization>("/organization");

// ── Settings → Setup ─────────────────────────────────────────────────────────
//
// The EDITOR for the two blobs `/organization` displays. Three saves, not one, because
// the Streamlit page has three buttons writing three places — see
// supabase/functions/_shared/api/routes_org_setup.ts. Folding them together would let a
// half-filled Bid Fitness tab overwrite a complete identity.

export type OrgPartner = { name: string; type: string; status: string[]; country: string };

export type SetupOptions = {
  legalTypes: string[];
  entityTypes: string[];
  stages: string[];
  cofinancing: string[];
  /** [label on screen, stored value]. Order matters — the first leaves MUST-4 off. */
  boards: [string, string][];
  /** [stored token, label on screen]. The editor shows the label and stores the token. */
  routes: [string, string][];
  languages: string[];
  partnerTypes: string[];
  partnerStatus: string[];
  countries: string[];
  /**
   * [category, canonical area keys] for the two rating matrices.
   *
   * The KEYS travel whole and are never composed in the browser: a stored area is
   * "IDs - Malaria & NTDs", and that exact string is what the classifier matches an
   * organisation's areas against a call's and a donor's.
   */
  areaTaxonomy: [string, string[]][];
  /** Key prefix → the category's full name, for display only. */
  categoryNames: Record<string, string>;
  /** Stored code → the sentence the editor shows. Display only; the value is the code. */
  legalTypeLabels: Record<string, string>;
  entityTypeLabels: Record<string, string>;
  /** The live donor_intel catalogue, for both relationship pickers. */
  donors: string[];
  /** The generated seed unioned with the catalogue's own hosts, cleaned the same way. */
  portals: string[];
};

export type OrgSetup = {
  identity: Record<string, string>;
  profile: Record<string, unknown>;
  logo: string | null;
  /** Structured partners PLUS the legacy flat lists, which the save writes FROM. */
  partners: OrgPartner[];
  team: string[];
  options: SetupOptions;
  /** The fields a save re-reads, and the only ones a failed write is reported for. */
  verifiedFields: string[];
  /**
   * What the logo uploader will accept.
   *
   * The cap is TIGHTER than Streamlit's, deliberately: the image lives on the
   * organisation record, which the header reads on every page render, so an oversized
   * one is paid for by everybody in that organisation on every page.
   */
  logo_limits: { maxBytes: number; types: string[] };
};

export type SetupSaved = {
  identity?: Record<string, string>;
  profile?: Record<string, unknown>;
  partners?: OrgPartner[];
  team?: string[];
  /** A rename that did not go through. The other fields ARE saved — see the route. */
  warnings?: Warning[];
};

const put = <T>(path: string, data: unknown = {}) =>
  call<T>(path, { method: "PUT", body: JSON.stringify(data) });

// ── Settings → Accounts → Users ──────────────────────────────────────────────

export type UserRights = {
  profile: boolean; role: boolean; overrides: boolean; reset: boolean; remove: boolean;
};

export type AdminUser = {
  id: string; email: string; name: string | null; role: string;
  is_active: boolean; must_change_password: boolean;
  department: string | null; program: string | null; job_title: string | null;
  phone: string | null;
  last_login_at: string | null; password_changed_at: string | null; created_at: string | null;
  access_overrides: Record<string, string>;
  /** The tenants this account belongs to, "(pending)" marked. */
  tenant: string | null;
  /** core/user_lifecycle's label, resolved server-side — emoji included. */
  status: string;
  /**
   * What THIS actor may do to THIS account, decided by the server.
   *
   * The page could work it out from the role, and then a permission rule would have two
   * implementations, one of them in a browser where it decides only what is drawn. These
   * are the same answers the write routes enforce.
   */
  rights: UserRights;
  /**
   * One row per access surface: what the target's ROLE already grants there, the options
   * THIS actor may assign, and what is currently stored. Resolved server-side for the
   * same reason as `rights` — the ceiling and the role matrix are permission logic.
   */
  overrides: {
    surface: string; roleDefault: string; roleDefaultLabel: string;
    options: string[]; current: string;
  }[];
  /** The roles this actor may put on this account, the current one always included. */
  roles: string[];
};

export type AdminUsers = {
  users: AdminUser[];
  canAdd: boolean;
  /** The roles this actor may hand out, so the form offers nothing the route refuses. */
  assignableRoles: string[];
  /** Only a super_user may choose WHOSE tenant a new account lands in. */
  canChooseTenant: boolean;
  addNote: string;
};

/** Creating an account is QUEUED: the Python inserts the row and creates the tenant. */
export type InviteQueued = {
  job_id: string; dispatched: boolean; email: string; detail: string;
};

export type ResetResult = {
  sent: boolean;
  /** The short code, handed back ONLY when no email went. Never the token. */
  code: string | null;
  detail: string;
};

export const fetchUsers = () => call<AdminUsers>("/settings/users");
export const saveUser = (id: string, form: Record<string, unknown>) =>
  patch<{ saved: boolean; warnings?: Warning[] }>(
    `/settings/users/${encodeURIComponent(id)}`, form);
export const inviteUser = (form: Record<string, unknown>) =>
  post<InviteQueued>("/settings/users", form);

export type BulkRow = {
  email: string; name: string; role: string; department: string; areas: string[];
};
export type BulkQueued = {
  queued: { email: string; job_id: string | null; dispatched: boolean }[];
  detail: string;
};
/**
 * Validated as a batch, queued as rows.
 *
 * Every problem across every row comes back BEFORE anything is created — a batch with
 * one bad row creates nobody. After that each row is its own job, so one that fails at
 * runtime fails alone.
 */
export const inviteUsers = (rows: BulkRow[], form: Record<string, unknown> = {}) =>
  post<BulkQueued>("/settings/users/bulk", { ...form, rows });
export const resetUserPassword = (id: string) =>
  post<ResetResult>(`/settings/users/${encodeURIComponent(id)}/reset`);

// ── Settings → Records ───────────────────────────────────────────────────────
//
// One route over several tables. The client names a SPEC KEY ("Meeting Logs"), never a
// table — see supabase/functions/_shared/api/routes_records.ts for why that distinction
// is the whole security of the surface.

export type RecordSpec = {
  table: string;
  orderCol: string;
  tableCols: string[];
  colLabels: Record<string, string>;
  dateCols: string[];
  searchCols: string[];
  advancedFilters: string[];
  /** [column, kind, label]; kind is date | text | area | bool. */
  editFields: [string, string, string][];
  caption: string;
};

export type RecordsPage = {
  table: string;
  /** "aux" is an editable table; "extracted" is the read-only global store. */
  kind: "aux" | "extracted" | "screened";
  rows: Record<string, unknown>[];
  total: number;
  truncated?: boolean;
  spec?: RecordSpec;
  columns?: string[];
  note?: string;
  /** The picker's options, from the generated list — carried with every answer. */
  options?: string[];
};

export const fetchRecords = (table: string) =>
  call<RecordsPage>(`/settings/records?table=${encodeURIComponent(table)}`);
export const saveRecord = (table: string, id: string, values: Record<string, unknown>) =>
  patch<{ saved: Record<string, unknown> }>("/settings/records", { table, id, values });
export const deleteRecord = (table: string, id: string) =>
  del<{ deleted: string }>(
    `/settings/records?table=${encodeURIComponent(table)}&id=${encodeURIComponent(id)}`);

// ── Settings → Analytics ─────────────────────────────────────────────────────

export type PlatformAnalytics = {
  /** Deployment-wide discovery. A "system run" excludes every tenant's own screening. */
  discovery: {
    runs: number; found: number; rejected: number; catalog: number; last_run: string | null;
  };
  tenants: {
    id: string; name: string | null; status: string; is_platform: boolean;
    members: number; pending: number; rfps: number;
    last_screen: string | null; created: string;
  }[];
  users: { total: number; active: number; inactive: number; by_role: Record<string, number> };
};

export const fetchAnalytics = () => call<PlatformAnalytics>("/settings/analytics");

// ── Settings → Manual Scan → history ─────────────────────────────────────────

export type RunSummary = {
  ts: string; trigger: string; found: number; new: number;
  /** Null when NO row of the run recorded one — "did not count", not "counted zero". */
  added: number | null;
  rejected: number;
  /** The source rows the run wrote, which is what the sums are over. */
  sources: number;
};

export type ScanHistory = {
  /** This organisation's own screening runs. */
  screening: { last: RunSummary | null; recent: Record<string, unknown>[] };
  /** Crawls of the shared store, which belong to no organisation. */
  extraction: { last: RunSummary | null; recent: Record<string, unknown>[] };
  matchLabel: string;
};

export const fetchScanHistory = () => call<ScanHistory>("/settings/scan-history");

// ── Settings → Sources, Learning data, Suggestions ───────────────────────────
//
// The three DEVELOPER surfaces. What they have in common is what puts them together:
// everything on them belongs to every tenant, not to the organisation whose Settings
// page is open, so each is gated on developer-tenant membership rather than a role.

export type SourcesData = {
  catalog: Record<string, unknown>[];
  blocked: { pattern: string; reason: string | null }[];
  canEditCatalog: boolean;
  canEditBlocked: boolean;
  /** Why the catalogue is read-only for this viewer, when it is. */
  note: string | null;
};

export type LearningData = {
  /** Exact over the whole table, NOT derived from `recent` — see the route. */
  total: number;
  counts: Record<string, number>;
  reasons: Record<string, number>;
  recent: Record<string, unknown>[];
  windowSize: number;
  note: string;
};

export type SuggestionsData = {
  pending: Record<string, unknown>[];
  /** False for anybody but a developer-tenant super_user; `pending` is then empty. */
  canReview: boolean;
  count: number;
};

/** A review is QUEUED, never applied in the request — the runner holds the rules. */
export type ReviewQueued = { job_id: string; dispatched: boolean; detail: string };

export type TenantRow = {
  id: string; name: string; slug: string | null; kind: string; status: string;
  is_platform: boolean; is_developer: boolean; share_for_consortium_scoring: boolean;
  parent_tenant_id: string | null;
  /** Resolved server-side: a non-super cannot see every organization to look it up. */
  parent_name: string | null;
  blacklisted_at: string | null; blacklisted_by: string | null;
  blacklist_reason: string | null; created_at: string | null;
  members: number; pending: number;
};

export type TenantsData = {
  tenants: TenantRow[];
  /** Readable by any admin, editable by a super_user only. */
  canManage: boolean;
  note: string | null;
};

export type DeploymentSecret = {
  name: string; present: boolean; length: number;
  /** First 8 hex of sha256 — comparable between runtimes, not reversible. */
  fingerprint?: string | null;
  project_ref?: string | null;
  kind?: string;
  is_service_role?: boolean | null;
};

export type DeploymentInfo = {
  runtime: string;
  secrets: DeploymentSecret[];
  verdicts: { level: "bad" | "warn" | "good"; text: string }[];
  extras: { dispatchConfigured: boolean; mailerConfigured: boolean; adminContact: boolean };
  allowedOrigins: string[];
  note: string;
};

/** What the runtime SERVING React is configured with — the half Streamlit cannot see. */
export const fetchDeployment = () => call<DeploymentInfo>("/settings/deployment");

export const fetchTenants = () => call<TenantsData>("/settings/tenants");
/** Queued: two of these writes clear a cache a TypeScript write would leave stale. */
export const tenantAction = (body: Record<string, unknown>) =>
  post<{ job_id: string; dispatched: boolean; detail: string }>("/settings/tenants", body);

export const fetchSources = () => call<SourcesData>("/settings/sources");

export type RegistryData = {
  rows: Record<string, unknown>[];
  canEdit: boolean;
  counts: { total: number; unclassified: number; confirmed: number; inCatalogue: number };
  /** What push_primaries will accept, said so the page does not have to guess. */
  pushRule: string;
};

/** Every registry WRITE is queued: core/source_registry.py owns the rules. */
export const fetchRegistry = () => call<RegistryData>("/settings/sources/registry");
export const registryAction = (body: Record<string, unknown>) =>
  post<{ job_id: string; dispatched: boolean; detail: string }>(
    "/settings/sources/registry", body);
export const saveBlockedTokens = (rows: { pattern: string; reason: string }[]) =>
  put<{ rows: { pattern: string; reason: string | null }[]; removed: number }>(
    "/settings/sources/blocked", { rows });
export const fetchLearning = () => call<LearningData>("/settings/learning");
export const fetchSuggestions = () => call<SuggestionsData>("/settings/suggestions");
export const approveSuggestion = (id: string) =>
  post<ReviewQueued>(`/settings/suggestions/${encodeURIComponent(id)}/approve`);
export const rejectSuggestion = (id: string, note?: string) =>
  post<ReviewQueued>(`/settings/suggestions/${encodeURIComponent(id)}/reject`, { note });

// ── Settings → Setup → Scan Preferences ──────────────────────────────────────
//
// Three stores, because that is where the data lives: the policy is TENANT-scoped and
// the search terms and the currency table are deployment-wide. That split is
// core/settings._TENANT_SCOPED_KEYS, not a choice made in the client.

export type CurrencyRow = {
  code: string; label: string; symbol: string | null;
  /** How "£" or "FCFA" in a call's text is matched to a rate. Dropping them kills that. */
  aliases: string[];
  usd_rate: number;
};

export type ScanPrefs = {
  /** The stored document — what the editor edits. An empty scope stays visibly empty. */
  stored: Record<string, unknown>;
  /** What the scan gates on TODAY, profile seeding included. */
  effective: { countries: { eligible: string[]; broad_terms: string[] };
               themes: { required_any: string[] } };
  /** True where the effective scope came from the profile rather than the document. */
  seeded: { countries: boolean; themes: boolean };
  searchTerms: string[];
  currencies: CurrencyRow[];
  options: {
    countries: string[]; geoOptions: string[];
    criteria: string[]; criterionLabels: Record<string, string>;
  };
  /** A stored policy that would not parse — the scan is running on no rules at all. */
  policyParseError: boolean;
  globalKeys: string[];
};

export const fetchScanPrefs = () => call<ScanPrefs>("/settings/scan-prefs");
export const saveScanPolicies = (form: Record<string, unknown>) =>
  put<{ policy: Record<string, unknown>; seeded: boolean; detail: string }>(
    "/settings/scan-prefs/policies", form);
export const saveSearchTerms = (terms: string[]) =>
  put<{ terms: string[]; detail: string }>("/settings/scan-prefs/search-terms", { terms });
export const saveCurrencies = (rows: CurrencyRow[]) =>
  put<{ rows: CurrencyRow[]; dropped: number; detail: string }>(
    "/settings/scan-prefs/currencies", { rows });

export const fetchSetup = () => call<OrgSetup>("/settings/setup");
export const saveSetupIdentity = (form: Record<string, unknown>) =>
  put<SetupSaved>("/settings/setup/identity", form);
export const saveSetupProfile = (form: Record<string, unknown>) =>
  put<SetupSaved>("/settings/setup/profile", form);
export const saveSetupTeam = (names: string[]) =>
  put<SetupSaved>("/settings/setup/team", { names });
/** Base64 in JSON, because the image is STORED as base64 either way. */
export const saveSetupLogo = (data: string, mime: string) =>
  put<{ logo: string | null; detail: string }>("/settings/setup/logo", { data, mime });
export const clearSetupLogo = () =>
  put<{ logo: string | null; detail: string }>("/settings/setup/logo", { clear: true });

// ── Profile ──────────────────────────────────────────────────────────────────
//
// Self-service only. Every route is keyed on the session's own id — none of them takes a
// user id — so there is no shape of request that reaches somebody else's row.

export type MyProfile = {
  id: string; email: string; name: string | null; role: string;
  phone: string | null; job_title: string | null; department: string | null;
  program: string | null; address: string | null; city: string | null;
  state_region: string | null; country: string | null;
  created_at: string | null; last_login_at: string | null;
  password_changed_at: string | null; must_change_password: boolean | null;
};

export type LoginRow = { at: string; device: string; ip: string };

export type ProfileView = {
  profile: MyProfile;
  metrics: { created: string | null; lastLogin: string | null; passwordSet: string | null };
  /** The last twelve sign-ins: when, which device, which address. Location is
   *  deliberately not derived — that needs an external geo-IP call. */
  logins: LoginRow[];
  passwordRules: string;
  /** True when deleting this account would leave nobody able to administer the app.
   *  Enforced server-side as well; this only decides what the page offers. */
  soleSuperUser: boolean;
};

export const fetchProfile = () => call<ProfileView>("/profile");

/** The ten self-editable columns. Role is NOT one of them and the server refuses it. */
export type ProfilePatch = Partial<Pick<MyProfile,
  "name" | "email" | "phone" | "job_title" | "department" | "program"
  | "address" | "city" | "state_region" | "country">>;

export const saveProfile = (fields: ProfilePatch) =>
  patch<{ profile: MyProfile; emailChanged: boolean; notice: string | null }>(
    "/profile", fields);

/** Changing it needs the current one as proof. The session is deliberately not re-issued. */
export const changeMyPassword = (current: string, password: string, confirm: string) =>
  post<{ ok: true }>("/profile/password", { current, password, confirm });

/** Irreversible. Takes the account's own email back as confirmation. */
export const deleteMyAccount = (confirmEmail: string) =>
  call<{ ok: true }>("/profile", {
    method: "DELETE", body: JSON.stringify({ confirmEmail }),
  });
