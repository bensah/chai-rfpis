/**
 * RFPIS web API — the server half of the React proof of concept.
 *
 * Why this exists at all (and the browser does not call Supabase directly):
 *   * SUPABASE_KEY is the SERVICE-ROLE key (db/supabase_client.py). It can never ship
 *     to a browser.
 *   * The anon/public role is not a safe fallback either: migration 023 gave `users`,
 *     `password_reset_requests`, `donor_intel`, `app_settings`, ... a permissive
 *     `for all using (true)` policy, so any key that reaches PostgREST can read password
 *     hashes and rewrite shared data.
 * So the browser only ever talks to this handler, which exposes a short allow-list of
 * read endpoints and holds every secret server-side.
 *
 * It is written against web-standard APIs only (fetch, Request/Response, WebCrypto) so the
 * SAME module runs as the Supabase Edge Function in production (Deno — see
 * ../rfpis-api/index.ts) and inside the Vite dev server locally (Node — see
 * web/vite.config.ts). The one non-standard need, bcrypt, is injected by each host.
 *
 * Identity mirrors the Streamlit app exactly:
 *   * login = `users` row by email, `is_active`, not `is_blacklisted`, bcrypt against
 *     `password_hash` (auth/authenticator.py);
 *   * tenant = the same default-membership choice as auth/tenant_context.py;
 *   * every PostgREST call carries a short-lived tenant JWT minted with the project JWT
 *     secret (role=authenticated, tenant_id claim), so the migration-085 RLS policies
 *     scope tenant tables (donor_contacts) to the caller's tenant — exactly like the
 *     per-session client in db/supabase_client.py.
 * The browser's own session token is signed with a key DERIVED from that secret, so it is
 * NOT a valid PostgREST JWT: a stolen session token cannot be replayed against Supabase.
 */

export type Env = {
  supabaseUrl: string;
  supabaseKey: string;      // service-role key (apikey header, and the login/identity lookups)
  jwtSecret: string;        // project legacy HS256 JWT secret (SUPABASE_JWT_SECRET)
  allowedOrigins?: string[]; // CORS allow-list; empty/undefined = any origin (bearer auth, no cookies)
};

export type Deps = {
  bcryptCompare: (plain: string, hash: string) => Promise<boolean>;
};

type Json = Record<string, unknown>;

const SESSION_TTL_S = 8 * 3600;   // browser session lifetime
const DB_JWT_TTL_S = 300;         // per-request PostgREST token lifetime
const SESSION_KEY_LABEL = "rfpis-web-session-v1";

// A real bcrypt hash (cost 12) of a random string, compared against when the email is
// unknown, so "no such user" and "wrong password" take the same time.
const DUMMY_HASH = "$2b$12$viRKiPpRBNOUFb16VqLUQ.AnuulKgZ5a1NrWOgL0gMJN7waTNQ9cq";

const ROLE_LABELS: Record<string, string> = {
  collaborator: "Contributor",
  reviewer: "Reviewer",
  admin: "Admin",
  super_user: "Super User",
};

// ---------------------------------------------------------------------------
// JWT (HS256) on WebCrypto
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
// Node's typings have no global CryptoKey type; derive it so the module typechecks on both hosts.
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(raw: Uint8Array | string): Promise<Key> {
  const bytes = typeof raw === "string" ? enc.encode(raw) : raw;
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false,
    ["sign", "verify"]);
}

async function signJwt(payload: Json, key: Key): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

async function verifyJwt(token: string, key: Key): Promise<Json | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(parts[2]),
      enc.encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as Json;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PostgREST
// ---------------------------------------------------------------------------
class DbError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Session = {
  sub: string;
  email: string;
  name: string;
  role: string;            // app role within the tenant (user_role claim)
  tenant_id: string | null;
  tenant_name: string | null;
};

export function createApi(env: Env, deps: Deps) {
  const base = env.supabaseUrl.replace(/\/+$/, "") + "/rest/v1/";
  let dbKeyP: Promise<Key> | null = null;
  let sessionKeyP: Promise<Key> | null = null;

  const dbKey = () => (dbKeyP ??= hmacKey(env.jwtSecret));
  const sessionKey = () => (sessionKeyP ??= (async () => {
    // Derive a separate key so a browser session token is never a valid PostgREST JWT.
    const k = await hmacKey(env.jwtSecret);
    const raw = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(SESSION_KEY_LABEL)));
    return hmacKey(raw);
  })());

  /** Service-role read — identity lookups only (users / memberships / tenants), the same
   * calls auth/tenant_context.py makes on service_client() before any tenant exists. */
  async function serviceGet(path: string): Promise<Json[]> {
    const r = await fetch(base + path, {
      headers: { apikey: env.supabaseKey, Authorization: `Bearer ${env.supabaseKey}` },
    });
    if (!r.ok) throw new DbError(r.status, await r.text());
    return (await r.json()) as Json[];
  }

  /** Read AS the signed-in user: a fresh tenant JWT as the bearer, so RLS applies. */
  async function userGet(s: Session, path: string): Promise<Json[]> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Json = {
      sub: s.sub, role: "authenticated", aud: "authenticated", email: s.email,
      user_role: s.role, iat: now, exp: now + DB_JWT_TTL_S,
    };
    if (s.tenant_id) claims.tenant_id = s.tenant_id;
    const tok = await signJwt(claims, await dbKey());
    const r = await fetch(base + path, {
      headers: { apikey: env.supabaseKey, Authorization: `Bearer ${tok}` },
    });
    if (!r.ok) throw new DbError(r.status, await r.text());
    return (await r.json()) as Json[];
  }

  // -------------------------------------------------------------------------
  // Tenant resolution — a port of auth/tenant_context.py
  // -------------------------------------------------------------------------
  type Membership = {
    tenant_id: string; name: string | null; slug: string | null; role: string | null;
    is_platform: boolean;
  };

  async function activeMemberships(userId: string): Promise<Membership[]> {
    // Every variant embeds `status`: it is the only guard that drops blacklisted/pending
    // tenants (RLS gates on tenant_id alone). Later variants degrade the newer columns.
    const selects = [
      "tenant_id,role,tenants(name,slug,is_platform,is_developer,status)",
      "tenant_id,role,tenants(name,slug,is_platform,status)",
      "tenant_id,role,tenants(name,slug,status)",
    ];
    for (const sel of selects) {
      let rows: Json[];
      try {
        rows = await serviceGet(`tenant_memberships?select=${encodeURIComponent(sel)}` +
          `&user_id=eq.${encodeURIComponent(userId)}&status=eq.active`);
      } catch {
        continue;
      }
      const out: Membership[] = [];
      for (const r of rows) {
        const t = (r.tenants && typeof r.tenants === "object" ? r.tenants : {}) as Json;
        if (t.status === "blacklisted" || t.status === "pending") continue;
        out.push({
          tenant_id: String(r.tenant_id), name: (t.name as string) ?? null,
          slug: (t.slug as string) ?? null, role: (r.role as string) ?? null,
          is_platform: Boolean(t.is_platform),
        });
      }
      return out;
    }
    return [];
  }

  async function platformHome(): Promise<Membership | null> {
    for (const [col, val] of [["is_platform", "true"], ["slug", "rfpis"]]) {
      try {
        const rows = await serviceGet(`tenants?select=id,name,slug&${col}=eq.${val}&limit=1`);
        if (rows.length) {
          const t = rows[0];
          return { tenant_id: String(t.id), name: (t.name as string) ?? null,
            slug: (t.slug as string) ?? null, role: "super_user", is_platform: true };
        }
      } catch {
        // column may not exist yet — try the next lookup
      }
    }
    return null;
  }

  const byName = (a: Membership, b: Membership) =>
    (a.name ?? "").toLowerCase().localeCompare((b.name ?? "").toLowerCase());

  async function defaultMembership(user: Json, mems: Membership[]): Promise<Membership | null> {
    if (!mems.length) return null;
    if (mems.length === 1) return mems[0];
    if (String(user.role ?? "").toLowerCase() === "super_user") {
      const preds: ((m: Membership) => boolean)[] = [
        (m) => m.is_platform,
        (m) => (m.slug ?? "").trim().toLowerCase() === "rfpis",
        (m) => (m.name ?? "").trim().toLowerCase().startsWith("rfpis"),
      ];
      for (const p of preds) {
        const home = mems.find(p);
        if (home) return home;
      }
      // The platform membership was filtered out (pending/blacklisted tenant, ...): resolve
      // it directly. Python's set_active_tenant then refuses a tenant the user does not
      // actively hold and leaves the session tenant-LESS — never another tenant.
      const direct = await platformHome();
      if (direct) return mems.find((m) => m.tenant_id === direct.tenant_id) ?? null;
      return [...mems].sort(byName)[0];
    }
    const last = user.last_tenant_id ? String(user.last_tenant_id) : null;
    if (last) {
      const m = mems.find((x) => x.tenant_id === last);
      if (m) return m;
    }
    return [...mems].sort(byName)[0];
  }

  async function fetchUser(email: string): Promise<Json | null> {
    const rows = await serviceGet(`users?select=*&email=eq.${encodeURIComponent(email)}&limit=1`);
    return rows[0] ?? null;
  }

  function publicUser(s: Session) {
    return {
      email: s.email, name: s.name || s.email, role: s.role,
      roleLabel: ROLE_LABELS[s.role] ?? (s.role ? s.role[0].toUpperCase() + s.role.slice(1) : "—"),
      tenant: s.tenant_id ? { id: s.tenant_id, name: s.tenant_name } : null,
    };
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------
  async function login(req: Request): Promise<Response> {
    let body: Json;
    try {
      body = (await req.json()) as Json;
    } catch {
      return json({ error: "Expected a JSON body." }, 400);
    }
    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "");
    if (!email || !password) return json({ error: "Enter your email and password." }, 400);

    const user = await fetchUser(email);
    const hash = typeof user?.password_hash === "string" ? user.password_hash : DUMMY_HASH;
    const ok = await deps.bcryptCompare(password, hash);
    if (!user || !ok) return json({ error: "Email or password is incorrect." }, 401);
    if (user.is_blacklisted) {
      return json({ error: "This account has been blocked. Contact an administrator." }, 403);
    }
    if (!user.is_active) {
      return json({ error: "Your account is inactive. Contact an administrator." }, 403);
    }
    if (user.must_change_password) {
      return json({ error: "An administrator has asked you to choose a new password. " +
        "Sign in to the main RFPIS app once to set it, then come back." }, 403);
    }

    const chosen = await defaultMembership(user, await activeMemberships(String(user.id)));
    const now = Math.floor(Date.now() / 1000);
    const s: Session = {
      sub: String(user.id), email: String(user.email), name: String(user.name ?? ""),
      role: String(chosen?.role || user.role || "collaborator"),
      tenant_id: chosen?.tenant_id ?? null, tenant_name: chosen?.name ?? null,
    };
    const token = await signJwt({ ...s, typ: "rfpis-web", iat: now, exp: now + SESSION_TTL_S },
      await sessionKey());
    return json({ token, expiresAt: now + SESSION_TTL_S, user: publicUser(s) });
  }

  async function session(req: Request): Promise<Session | null> {
    const h = req.headers.get("authorization") ?? "";
    const tok = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
    if (!tok) return null;
    const p = await verifyJwt(tok, await sessionKey());
    if (!p || p.typ !== "rfpis-web" || typeof p.sub !== "string") return null;
    return {
      sub: p.sub, email: String(p.email ?? ""), name: String(p.name ?? ""),
      role: String(p.role ?? "collaborator"),
      tenant_id: (p.tenant_id as string) ?? null, tenant_name: (p.tenant_name as string) ?? null,
    };
  }

  async function me(s: Session): Promise<Response> {
    // Re-check on every app load: a deactivated / blocked account, or a revoked tenant
    // membership, ends the session here rather than at token expiry.
    const user = await fetchUser(s.email);
    if (!user || String(user.id) !== s.sub || !user.is_active || user.is_blacklisted) {
      return json({ error: "Your session has ended. Sign in again." }, 401);
    }
    if (s.tenant_id) {
      const mems = await activeMemberships(s.sub);
      if (!mems.some((m) => m.tenant_id === s.tenant_id)) {
        return json({ error: "Your organisation access changed. Sign in again." }, 401);
      }
    }
    return json({ user: publicUser(s) });
  }

  async function handle(req: Request): Promise<Response> {
    const origin = req.headers.get("origin");
    const cors = corsHeaders(origin, env.allowedOrigins);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin && cors["Access-Control-Allow-Origin"] === undefined) {
      return withCors(json({ error: "Origin not allowed." }, 403), cors);
    }

    // Accept both /functions/v1/rfpis-api/<route> (Supabase) and /api/<route> (Vite dev).
    const path = new URL(req.url).pathname.replace(/^.*?\/(rfpis-api|api)(?=\/|$)/, "") || "/";
    try {
      if (path === "/login" && req.method === "POST") return withCors(await login(req), cors);
      if (path === "/health") return withCors(json({ ok: true }), cors);

      const s = await session(req);
      if (!s) return withCors(json({ error: "Sign in to continue." }, 401), cors);

      if (path === "/me" && req.method === "GET") return withCors(await me(s), cors);
      if (path === "/donors" && req.method === "GET") {
        // donor_intel is the shared, cross-tenant catalogue (no tenant_id) — same query as
        // app_pages/donors.py::_load.
        const rows = await userGet(s, "donor_intel?select=*&order=donor.asc");
        // ~1.3 MB of JSON for 190 donors; gzip takes it to ~100 KB.
        return withCors(gzipped(req, json({ donors: rows }, 200, { "Cache-Control": "private, max-age=30" })), cors);
      }
      const m = path.match(/^\/donors\/([^/]+)\/contacts$/);
      if (m && req.method === "GET") {
        // donor_contacts IS tenant-scoped: RLS returns only the caller's tenant's rows.
        const key = decodeURIComponent(m[1]);
        const rows = await userGet(s, "donor_contacts?select=*" +
          `&canonical_key=eq.${encodeURIComponent(key)}` +
          "&order=is_official.desc,contact_name.asc");
        return withCors(json({ contacts: rows }), cors);
      }
      return withCors(json({ error: "Not found." }, 404), cors);
    } catch (e) {
      const status = e instanceof DbError ? 502 : 500;
      console.error("rfpis-api error", path, e);
      return withCors(json({ error: "The database could not be reached. Try again." }, status), cors);
    }
  }

  return { handle };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

function gzipped(req: Request, res: Response): Response {
  const accepts = /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
  if (!accepts || !res.body || typeof CompressionStream === "undefined") return res;
  const headers = new Headers(res.headers);
  headers.set("Content-Encoding", "gzip");
  headers.append("Vary", "Accept-Encoding");
  return new Response(res.body.pipeThrough(new CompressionStream("gzip")), { status: res.status, headers });
}

function corsHeaders(origin: string | null, allowed?: string[]): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (!allowed || allowed.length === 0) h["Access-Control-Allow-Origin"] = "*";
  else if (origin && allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function withCors(res: Response, cors: Record<string, string>): Response {
  for (const [k, v] of Object.entries(cors)) {
    if (k === "Vary") res.headers.append(k, v);
    else res.headers.set(k, v);
  }
  return res;
}
