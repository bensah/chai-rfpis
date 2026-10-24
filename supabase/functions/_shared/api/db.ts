/**
 * Database access: a port of db/supabase_client.py::get_client() for a live session.
 *
 * Every table call names the session (`Scope`) it runs for, and is routed exactly as the
 * Python `_TenantScopedClient` routes it:
 *   * SERVICE_ONLY tables (migration 098)  → the service role, unscoped;
 *   * SERVICE_WRITE tables (migration 098) → reads as the session, writes on the service role;
 *   * TENANT_SCOPED tables                 → the session's base client, reads/updates/deletes
 *                                            filtered to tenant_id, inserts stamped with it;
 *   * anything else                        → the session's base client, unscoped.
 * The session's base client is the tenant JWT (RLS applies), except for a super_user viewing
 * ANOTHER tenant, whose JWT is pinned to their home tenant: that read uses the service role,
 * scoped by the wrapper to the viewed tenant — the Python behaviour.
 *
 * The three sets must match db/supabase_client.py and migration 098's arrays;
 * web/scripts/parity/check-db-routing.mjs compares them.
 */
import { hmacKey, signJwt, type Json, type Key } from "./jwt.ts";

export const SERVICE_ONLY_TABLES = new Set([
  "users", "password_reset_requests", "user_password_tokens", "app_settings", "tenant_settings",
]);
export const SERVICE_WRITE_TABLES = new Set([
  "donor_intel", "donor_sources", "donor_source_seeds", "source_registry",
  "extracted_solicitations", "scan_logs", "scan_blacklist",
]);
export const TENANT_SCOPED_TABLES = new Set([
  "rfp_submissions", "meeting_logs", "meeting_schedule", "engagement_logs",
  "applied_funding", "narrative_logs", "scan_decisions", "donor_contacts",
  "rfp_seen", "resource_suggestions",
]);

/** Matches no row — the fail-closed scope for a session whose tenant can't be resolved. */
export const NO_TENANT_SENTINEL = "00000000-0000-0000-0000-000000000000";

const DB_JWT_TTL_S = 300;   // per-request PostgREST token lifetime

/** Who a database call runs for. */
export type Scope = {
  sub: string;
  email: string;
  tenantRole: string;        // membership role → the JWT's user_role claim
  tenantId: string | null;   // the session's own (home) tenant
  viewTenantId: string | null; // a super_user's view-as target (null otherwise)
  isSuper: boolean;          // users.role == super_user
};

export class DbError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";
export type Rows = Json[];

export type Env = { supabaseUrl: string; supabaseKey: string; jwtSecret: string };

export function createDb(env: Env) {
  const base = env.supabaseUrl.replace(/\/+$/, "") + "/rest/v1/";
  let dbKeyP: Promise<Key> | null = null;
  const dbKey = () => (dbKeyP ??= hmacKey(env.jwtSecret));

  async function tenantJwt(s: Scope): Promise<string> {
    // Same claims as auth/tenant_context.py::mint_tenant_jwt.
    const now = Math.floor(Date.now() / 1000);
    const claims: Json = {
      sub: s.sub, role: "authenticated", aud: "authenticated", email: s.email,
      user_role: s.tenantRole || "collaborator", iat: now, exp: now + DB_JWT_TTL_S,
    };
    if (s.tenantId) claims.tenant_id = s.tenantId;
    return signJwt(claims, await dbKey());
  }

  async function send(bearer: string, method: Method, table: string, query: string,
    payload?: unknown, prefer?: string): Promise<{ rows: Rows; total: number | null }> {
    const headers: Record<string, string> = { apikey: env.supabaseKey, Authorization: `Bearer ${bearer}` };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    if (prefer) headers.Prefer = prefer;
    const r = await fetch(base + table + (query ? `?${query}` : ""), {
      method, headers, body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await r.text();
    if (!r.ok) {
      let code = "";
      try {
        code = String((JSON.parse(text) as Json).code ?? "");
      } catch {
        // not JSON
      }
      throw new DbError(r.status, code, `${method} ${table}: ${r.status} ${text.slice(0, 300)}`);
    }
    const range = r.headers.get("content-range");
    const total = range && range.includes("/") && !range.endsWith("/*") ? Number(range.split("/")[1]) : null;
    return { rows: text ? (JSON.parse(text) as Rows) : [], total };
  }

  /** Service role, no scoping — identity lookups and the Python service_client() calls. */
  const service = {
    get: (table: string, query: string) => send(env.supabaseKey, "GET", table, query).then((r) => r.rows),
    count: (table: string, query: string) =>
      send(env.supabaseKey, "GET", table, query + (query ? "&" : "") + "limit=1", undefined, "count=exact")
        .then((r) => r.total ?? 0),
    insert: (table: string, rows: unknown, prefer = "return=representation") =>
      send(env.supabaseKey, "POST", table, "", rows, prefer).then((r) => r.rows),
    upsert: (table: string, rows: unknown, onConflict: string) =>
      send(env.supabaseKey, "POST", table, `on_conflict=${encodeURIComponent(onConflict)}`, rows,
        "resolution=merge-duplicates,return=representation").then((r) => r.rows),
    update: (table: string, query: string, values: unknown) =>
      send(env.supabaseKey, "PATCH", table, query, values, "return=representation").then((r) => r.rows),
    delete: (table: string, query: string) =>
      send(env.supabaseKey, "DELETE", table, query, undefined, "return=representation").then((r) => r.rows),
  };

  /** The tenant the wrapper scopes to (db/supabase_client.py::_tenant_scope_tid + sentinel). */
  function scopeTid(s: Scope): string {
    if (s.isSuper) return s.viewTenantId || s.tenantId || NO_TENANT_SENTINEL;
    return s.tenantId || NO_TENANT_SENTINEL;
  }

  function viewingAs(s: Scope): boolean {
    return s.isSuper && !!s.viewTenantId && s.viewTenantId !== s.tenantId;
  }

  async function baseBearer(s: Scope): Promise<string> {
    return viewingAs(s) ? env.supabaseKey : tenantJwt(s);
  }

  function withTenant(query: string, tid: string): string {
    return (query ? query + "&" : "") + `tenant_id=eq.${encodeURIComponent(tid)}`;
  }

  function stamp(rows: unknown, tid: string): unknown {
    const one = (r: unknown) =>
      r && typeof r === "object" && !(r as Json).tenant_id ? { ...(r as Json), tenant_id: tid } : r;
    return Array.isArray(rows) ? rows.map(one) : one(rows);
  }

  /** Read/write as the signed-in session, routed like _TenantScopedClient.table(). */
  function as(s: Scope) {
    async function route(method: Method, table: string, query: string, payload?: unknown, prefer?: string) {
      if (SERVICE_ONLY_TABLES.has(table)) {
        return send(env.supabaseKey, method, table, query, payload, prefer);
      }
      if (SERVICE_WRITE_TABLES.has(table) && method !== "GET") {
        return send(env.supabaseKey, method, table, query, payload, prefer);
      }
      const bearer = await baseBearer(s);
      if (TENANT_SCOPED_TABLES.has(table)) {
        const tid = scopeTid(s);
        if (method === "POST") return send(bearer, method, table, query, stamp(payload, tid), prefer);
        return send(bearer, method, table, withTenant(query, tid), payload, prefer);
      }
      return send(bearer, method, table, query, payload, prefer);
    }
    return {
      get: (table: string, query: string) => route("GET", table, query).then((r) => r.rows),
      page: (table: string, query: string) => route("GET", table, query, undefined, "count=exact"),
      insert: (table: string, rows: unknown) =>
        route("POST", table, "", rows, "return=representation").then((r) => r.rows),
      upsert: (table: string, rows: unknown, onConflict: string) =>
        route("POST", table, `on_conflict=${encodeURIComponent(onConflict)}`, rows,
          "resolution=merge-duplicates,return=representation").then((r) => r.rows),
      update: (table: string, query: string, values: unknown) =>
        route("PATCH", table, query, values, "return=representation").then((r) => r.rows),
      delete: (table: string, query: string) =>
        route("DELETE", table, query, undefined, "return=representation").then((r) => r.rows),
    };
  }

  return { service, as, scopeTid };
}

export type Db = ReturnType<typeof createDb>;

/** PostgREST filter value for an `eq.` / `in.` clause. */
export const q = encodeURIComponent;
