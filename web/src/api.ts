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
export const peekToken = (token: string) => post<TokenInfo>("/tokens/peek", { token });
export const redeemToken = (token: string, password: string, confirm: string) =>
  post<{ ok: true; email: string; purpose: "invite" | "reset" }>("/tokens/redeem", { token, password, confirm });
export const requestReset = (email: string) =>
  post<{ ok: true; message: string }>("/password/reset-request", { email });

// ── App shell ────────────────────────────────────────────────────────────────
export type FeedItem = { ts: number; icon: string; title: string; detail: string; nav: string; uid: string | null };
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
export type HomeKpis = {
  total_unique: number; total_found: number; duplicates: number;
  proceed: number; park: number; decline: number;
  overdue: number; due_soon: number; submitted: number; awarded_grants: number;
};
export const fetchHome = () => call<HomeKpis>("/home");

/** The rows the rail ranks. The ranking runs in the browser's Python engine. */
export const fetchFeedRows = () =>
  call<{ pipeline: Record<string, unknown>[]; catalog: Record<string, unknown>[]; seen: string[] }>("/feed");

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
