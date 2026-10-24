/**
 * RFPIS web API — the server half of the React app.
 *
 * Why this exists at all (and the browser does not call Supabase directly):
 *   * SUPABASE_KEY is the SERVICE-ROLE key (db/supabase_client.py). It can never ship to a
 *     browser.
 *   * Every permission the Streamlit app enforces in Python (core/permissions.py, the
 *     tenant rules in auth/tenant_context.py) has to be enforced somewhere the user cannot
 *     edit. That is here.
 *
 * It is written against web-standard APIs only (fetch, Request/Response, WebCrypto) so the
 * SAME module runs as the Supabase Edge Function in production (Deno — ../rfpis-api/index.ts)
 * and inside the Vite dev server locally (Node — web/vite.config.ts). The non-standard needs
 * (bcrypt, job dispatch) are injected by each host.
 *
 * Modules (./api/):
 *   jwt.ts          HS256 on WebCrypto
 *   db.ts           PostgREST, routed like _TenantScopedClient (tenant JWT vs service role)
 *   tenants.ts      membership + default-tenant rules (auth/tenant_context.py)
 *   permissions.ts  core/permissions.py
 *   session.ts      browser session tokens; per-request account + membership re-check
 *   routes_*.ts     the routes, grouped by area
 */
import { createDb, q } from "./api/db.ts";
import { corsHeaders, gzipped, HttpError, json, withCors } from "./api/http.ts";
import { createAuthRoutes, type AuthDeps } from "./api/routes_auth.ts";
import { createJobRoutes, type Dispatch } from "./api/routes_jobs.ts";
import { createShellRoutes } from "./api/routes_shell.ts";
import { createSessions } from "./api/session.ts";
import { createTenants } from "./api/tenants.ts";

export type Env = {
  supabaseUrl: string;
  supabaseKey: string;      // service-role key
  jwtSecret: string;        // project legacy HS256 JWT secret (SUPABASE_JWT_SECRET)
  allowedOrigins?: string[]; // CORS allow-list; empty/undefined = any origin (bearer auth, no cookies)
};

export type Deps = AuthDeps & {
  dispatchJob?: Dispatch | null;
};

export function createApi(env: Env, deps: Deps) {
  const db = createDb(env);
  const tenants = createTenants(db);
  const sessions = createSessions(env.jwtSecret, db, tenants);
  const auth = createAuthRoutes(db, tenants, sessions, deps);
  const shell = createShellRoutes(db);
  const jobs = createJobRoutes(db, deps.dispatchJob ?? null);

  async function route(req: Request, path: string): Promise<Response> {
    const m = req.method;
    // ── Public: no session ────────────────────────────────────────────────────
    if (path === "/health") return json({ ok: true });
    if (path === "/login" && m === "POST") return auth.login(req);
    if (path === "/tokens/peek" && m === "POST") return auth.tokenPeek(req);
    if (path === "/tokens/redeem" && m === "POST") return auth.tokenRedeem(req);
    if (path === "/password/reset-request" && m === "POST") return auth.resetRequest(req);
    // Restricted token (must change password): this route only.
    if (path === "/password/forced-change" && m === "POST") return auth.forcedChange(req);
    if (path === "/session/tenant" && m === "POST") return auth.switchTenant(req);
    if (path === "/session/view" && m === "POST") return auth.viewAs(req);

    // ── Signed in ─────────────────────────────────────────────────────────────
    const ctx = await sessions.require(req);
    if (path === "/me" && m === "GET") return auth.me(ctx);
    if (path === "/shell" && m === "GET") return shell.shell(ctx);
    if (path === "/notifications/read" && m === "POST") return shell.markRead(ctx);
    if (path === "/jobs" && m === "POST") return jobs.create(req, ctx);
    const job = path.match(/^\/jobs\/([^/]+)$/);
    if (job && m === "GET") return jobs.get(ctx, decodeURIComponent(job[1]));

    if (path === "/donors" && m === "GET") {
      // donor_intel is the shared, cross-tenant catalogue (no tenant_id) — same query as
      // app_pages/donors.py::_load. ~1.3 MB of JSON for 190 donors; gzip takes it to ~100 KB.
      const rows = await db.as(ctx.scope).get("donor_intel", "select=*&order=donor.asc");
      return gzipped(req, json({ donors: rows }, 200, { "Cache-Control": "private, max-age=30" }));
    }
    const contacts = path.match(/^\/donors\/([^/]+)\/contacts$/);
    if (contacts && m === "GET") {
      // donor_contacts IS tenant-scoped: RLS and the wrapper return only this tenant's rows.
      const rows = await db.as(ctx.scope).get("donor_contacts", "select=*" +
        `&canonical_key=eq.${q(decodeURIComponent(contacts[1]))}` +
        "&order=is_official.desc,contact_name.asc");
      return json({ contacts: rows });
    }
    return json({ error: "Not found." }, 404);
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
      return withCors(await route(req, path), cors);
    } catch (e) {
      if (e instanceof HttpError) return withCors(json({ error: e.message }, e.status), cors);
      console.error("rfpis-api error", req.method, path, e);
      return withCors(json({ error: "The database could not be reached. Try again." }, 502), cors);
    }
  }

  return { handle };
}
