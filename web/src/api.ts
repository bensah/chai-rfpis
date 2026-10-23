// Thin client for the RFPIS web API (the Supabase Edge Function in production, the Vite
// dev middleware locally). The browser never talks to Supabase itself.
import type { Contact, Donor } from "./donors/model";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, "") || "/api";
const SESSION_KEY = "rfpis.session";
const DONOR_CACHE_KEY = "rfpis.donors.v1";

export type User = {
  email: string;
  name: string;
  role: string;
  roleLabel: string;
  tenant: { id: string; name: string | null } | null;
};

type Stored = { token: string; expiresAt: number; user: User };

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// In-memory copy so a browser that blocks storage still keeps the session for this page.
let memory: Stored | null = null;

function readSession(): Stored | null {
  let s = memory;
  try {
    s = (JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as Stored | null) ?? memory;
  } catch {
    // storage blocked — fall back to memory
  }
  return s && s.expiresAt > Date.now() / 1000 ? s : null;
}

export function storedUser(): User | null {
  return readSession()?.user ?? null;
}

export function signOut(): void {
  memory = null;
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(DONOR_CACHE_KEY);
  } catch {
    // storage blocked — nothing to clear
  }
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
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) {
    if (r.status === 401 && path !== "/login") signOut();
    throw new ApiError(r.status, body.error ?? `Request failed (${r.status}).`);
  }
  return body as T;
}

export async function login(email: string, password: string): Promise<User> {
  const res = await call<Stored>("/login", { method: "POST", body: JSON.stringify({ email, password }) });
  memory = res;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(res));
  } catch {
    // storage blocked: the session lives only as long as this page
  }
  return res.user;
}

export const me = () => call<{ user: User }>("/me").then((r) => r.user);
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
