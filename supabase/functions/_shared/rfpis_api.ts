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
import { createMailer } from "./api/email.ts";
import { createFormOptions } from "./api/form_options.ts";
import { corsHeaders, gzipped, HttpError, json, withCors } from "./api/http.ts";
import { isAdmin, isSuperUser, type PermUser } from "./api/permissions.ts";
import { createAuthRoutes, type AuthDeps } from "./api/routes_auth.ts";
import { createJobRoutes, type Dispatch } from "./api/routes_jobs.ts";
import { createPhase1Routes } from "./api/routes_phase1.ts";
import { createPipelineWrites } from "./api/pipeline_writes.ts";
import { createPipelineRoutes } from "./api/routes_pipelines.ts";
import { createReportRoutes } from "./api/routes_report.ts";
import { buildGrants, loadGrants, parseGrantSelection, yearsFor } from "./api/grants.ts";
import { createActionRoutes } from "./api/routes_actions.ts";
import { loadOrgIdentity } from "./api/report_section2.ts";
import { createShellRoutes } from "./api/routes_shell.ts";
import { createOrgRoutes } from "./api/routes_org.ts";
import { createOrgSetupRoutes } from "./api/routes_org_setup.ts";
import { createUserRoutes } from "./api/routes_users.ts";
import { createRecordRoutes } from "./api/routes_records.ts";
import {
  MATCH_RUN_LABEL, systemDiscoveryStats, tenantActivity, userStats,
} from "./api/analytics.ts";
import { runSummary, splitHistory } from "./api/scan_history.ts";
import { createPlatformRoutes } from "./api/routes_platform.ts";
import { createScanPrefRoutes } from "./api/routes_scan_prefs.ts";
import { createProfileRoutes } from "./api/routes_profile.ts";
import { createSearchRoutes } from "./api/routes_search.ts";
import { createSubmitRoutes } from "./api/routes_submit.ts";
import { createSessions } from "./api/session.ts";
import { createTenants } from "./api/tenants.ts";

export type Env = {
  supabaseUrl: string;
  supabaseKey: string;      // service-role key
  jwtSecret: string;        // project legacy HS256 JWT secret (SUPABASE_JWT_SECRET)
  allowedOrigins?: string[]; // CORS allow-list; empty/undefined = any origin (bearer auth, no cookies)
  // Email (core/mailer.py's RESEND_API_KEY / RESEND_FROM_EMAIL). Unset = the API sends no
  // mail, and the self-service reset goes back to being a dead end — see api/email.ts.
  resendApiKey?: string;
  resendFrom?: string;
  appPublicUrl?: string;    // fallback for link building when app_settings has none
  /**
   * The app owner / Super User to contact for account and data requests — permanent
   * deletion, reactivating a suspended org, a role change. `ADMIN_CONTACT_EMAIL` in
   * views/account_sections.py, which reads the same environment variable and falls back
   * to the same placeholder. Surfaced on the shell so the Help page and the Profile
   * page's danger zone say the same address.
   */
  adminContactEmail?: string;
};

export type Deps = AuthDeps & {
  dispatchJob?: Dispatch | null;
};

export function createApi(env: Env, deps: Deps) {
  const db = createDb(env);
  const tenants = createTenants(db);
  const sessions = createSessions(env.jwtSecret, db, tenants);
  const mailer = createMailer(db, {
    resendApiKey: env.resendApiKey, resendFrom: env.resendFrom, appPublicUrl: env.appPublicUrl,
  });
  const auth = createAuthRoutes(db, tenants, sessions, deps,
    { mailer, allowedOrigins: env.allowedOrigins });
  const shell = createShellRoutes(db, env.adminContactEmail);
  const jobs = createJobRoutes(db, deps.dispatchJob ?? null);
  const phase1 = createPhase1Routes(db);
  const pipelines = createPipelineRoutes(db);
  // The editor's save queues a re-score through the same path POST /jobs uses, so there is
  // one way a job reaches the runner rather than a second one owned by the write route.
  const pipelineWrites = createPipelineWrites(db, jobs.enqueue);
  const formOptions = createFormOptions(db);
  const report = createReportRoutes(db, jobs.enqueue);
  const actions = createActionRoutes(db);
  // Submit New Notice queues through the same path too: the insert is this function's,
  // the seen-ledger tombstone and the share to the global pool are Python's.
  const submitNotice = createSubmitRoutes(db, jobs.enqueue);
  // Search: the in-app half answers in the request, the web half is a job — 21.4s
  // against the live providers, in Python that holds the keys. See api/routes_search.ts.
  const siteSearch = createSearchRoutes(db, jobs.enqueue);
  // My Organization: one read, no writes — the editor is Settings, not this page.
  const organization = createOrgRoutes(db);
  // Settings → Setup: that editor. Admin-gated per route, since an Edge Function has no
  // nav to omit the page from.
  const orgSetup = createOrgSetupRoutes(db);
  // Settings → Accounts → Users. It resets a password through auth's OWN `issueToken`,
  // not a second minting path: that function retires any live token on the account first,
  // and a duplicate would be a second place to forget that step.
  const users = createUserRoutes(db, auth.issueToken, mailer, env.allowedOrigins ?? [],
    jobs.enqueue);
  // Settings → Records: one route over several tables, and the TABLE IS NAMED BY THE
  // CLIENT — so it names a spec key, never a table. See api/routes_records.ts.
  const records = createRecordRoutes(db);
  // Settings → Sources, Learning data and Suggestions: the three surfaces whose
  // resources belong to every tenant, so none is scoped to the viewer's own.
  const platform = createPlatformRoutes(db, jobs.enqueue);
  // Settings → Setup → Scan Preferences. Three stores, because the policy is
  // tenant-scoped and the search terms and currency table are not.
  const scanPrefs = createScanPrefRoutes(db);
  // Profile: self-service only, and every route keyed on the session's own id.
  const profile = createProfileRoutes(db, deps);

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
    // Phase 1. The snapshot seeds the browser's Python engine, which is down to a single
    // caller — the Opportunity page's decision aid. Everything else here decides in TS.
    if (path === "/scoring/snapshot" && m === "GET") return phase1.snapshot(req, ctx);
    if (path === "/home" && m === "GET") return phase1.home(ctx);
    // The rail's RAW rows. No longer served to a browser: the rail is ranked below. It
    // stays because web/scripts/parity/check-scoring.mjs feeds these exact rows to
    // core/opportunity_feed.py to produce the Python side it compares against.
    if (path === "/feed" && m === "GET") return phase1.feed(req, ctx);
    // The rail's finished cards, ranked here — the ranking orders values already stored on
    // each row and computes no score, so it needs no Python.
    if (path === "/opportunities/feed" && m === "GET") return phase1.opportunitiesFeed(req, ctx);
    // The Dashboard's other half: every call, tagged with the figures it belongs to, so a
    // tile can open the rows behind its number without the page owning a second
    // definition of what that number means. See api/home_buckets.ts.
    if (path === "/opportunities/list" && m === "GET") return phase1.opportunityList(req, ctx);
    // Phase 2. Same division: these serve rows, the page scores and decides.
    if (path === "/report/periods" && m === "GET") return report.periods(req, ctx);
    if (path === "/report/section1" && m === "GET") return report.section1(req, ctx);
    if (path === "/report/section2" && m === "GET") return report.section2(req, ctx);
    if (path === "/report/section3" && m === "GET") return report.section3(req, ctx);
    if (path === "/report/section4" && m === "GET") return report.section4(req, ctx);
    if (path === "/report/section5" && m === "GET") return report.section5(req, ctx);
    // The `?r=` link: GET resolves one into a selection, POST is Generate. The store is one
    // shared row holding the newest 100 — see api/report_snapshots.ts.
    if (path === "/report/snapshot" && m === "GET") return report.snapshotGet(req, ctx);
    if (path === "/report/snapshot" && m === "POST") return report.snapshotPost(req, ctx);
    // The six-sheet workbook. A job, not a response: it runs openpyxl over every row the
    // page's figures come from, which no Edge Function CPU budget survives.
    if (path === "/report/export" && m === "POST") return report.exportXlsx(req, ctx);

    // Bids Submitted (views/outcomes.py). Every application ever sent to a funder, with no
    // date window — deliberately NOT the Pipeline's Outcome stage, which answers a
    // different question over a window. See api/grants.ts.
    // Meeting Actions: one read for all four tabs, then the writes. See api/actions.ts.
    if (path === "/actions" && m === "GET") return actions.read(req, ctx);
    if (path === "/actions/notes" && m === "POST") return actions.createNote(req, ctx);
    if (path === "/actions/engagements" && m === "POST") return actions.createEngagement(req, ctx);
    if (path === "/actions/schedule" && m === "PUT") return actions.putSchedule(req, ctx);
    if (path.startsWith("/actions/notes/") && m === "PATCH") {
      return actions.patchNote(req, ctx, decodeURIComponent(path.slice("/actions/notes/".length)));
    }
    if (path.startsWith("/actions/engagements/") && m === "PATCH") {
      return actions.patchEngagement(req, ctx, decodeURIComponent(path.slice("/actions/engagements/".length)));
    }

    // `?window=all|7d|30d|90d|365d[&year=&quarter=]`. The window is applied on the
    // server, before anything is counted, so the tiles, the money, the win rate, the
    // by-funder table and the picker cannot answer different questions — see
    // api/grants.ts::buildGrants.
    //
    // The selection is parsed AGAINST THE YEARS THE DATA SUPPORTS: `?year=2031` from a
    // stale bookmark falls back to the whole record rather than rendering an empty page
    // under a heading nobody can explain.
    //
    // NO-STORE, and that is the point of saying it rather than leaving it off. This page
    // is read right after somebody edits a bid, and a figure served from any cache on the
    // way is a figure that contradicts the editor the reader just used.
    if (path === "/grants" && m === "GET") {
      const tid = db.scopeTid(ctx.scope);
      const org = await loadOrgIdentity(db, /^0{8}-/.test(tid) ? null : tid);
      const { rfps, rates, table } = await loadGrants(db, ctx.scope);
      const today = new Date().toISOString().slice(0, 10);
      const selection = parseGrantSelection(
        new URL(req.url).searchParams, yearsFor(rfps, today));
      return gzipped(req, json(
        buildGrants({ rfps, rates, table, orgShort: org.short, selection, today }),
        200, { "Cache-Control": "no-store" }));
    }

    // Submit New Notice (views/submit_form.py). Open to any signed-in member, and it
    // never refuses a row for being a duplicate — see api/submit.ts on the 2026-06-05
    // policy that de-duplication happens at display time instead.
    if (path === "/submit" && m === "POST") return submitNotice.submit(req, ctx);

    // What the matching engine believes about this tenant, and how much of it is still
    // missing. Read-only by the page's own design — see api/routes_org.ts.
    if (path === "/organization" && m === "GET") return organization.read(req, ctx);

    // Settings → Setup. Three saves, not one: the Streamlit page has three buttons
    // writing three places, and a single PUT would let a half-filled Bid Fitness tab
    // overwrite a complete identity. See api/routes_org_setup.ts.
    if (path === "/settings/setup" && m === "GET") return orgSetup.read(req, ctx);
    if (path === "/settings/setup/identity" && m === "PUT") return orgSetup.putIdentity(req, ctx);
    if (path === "/settings/setup/profile" && m === "PUT") return orgSetup.putProfile(req, ctx);
    if (path === "/settings/setup/team" && m === "PUT") return orgSetup.putTeam(req, ctx);
    if (path === "/settings/setup/logo" && m === "PUT") return orgSetup.putLogo(req, ctx);

    /**
     * Settings → Analytics — the cross-tenant platform rollups.
     *
     * SUPER_USER ONLY, and the gate is the whole of the access control: every figure
     * crosses tenant boundaries and every query runs on the service role. Inline rather
     * than in a routes module because it is three reads and no rules — api/analytics.ts
     * holds what little arithmetic there is, pinned by check-analytics.
     */
    if (path === "/settings/analytics" && m === "GET") {
      if (!isSuperUser(ctx.user as PermUser)) {
        return json({ error: "App analytics are visible to the Super User only." }, 403);
      }
      const [discovery, tenantRows, users] = await Promise.all([
        systemDiscoveryStats(db), tenantActivity(db), userStats(db),
      ]);
      return json({ discovery, tenants: tenantRows, users });
    }

    /**
     * `GET /settings/scan-history` — what the last runs found.
     *
     * Admin-gated, tenant-scoped, and SPLIT: a screening run and a crawl answer different
     * questions, and one list reports one as the other. The split is on `source`, whose
     * screening value is MATCH_RUN_LABEL — owned by api/analytics.ts so the two readers
     * of that constant stay one.
     *
     * 500 rows, newest first, as the Streamlit page reads: scan_logs is one row per
     * SOURCE per run, so a few hundred rows is a handful of runs.
     */
    if (path === "/settings/scan-history" && m === "GET") {
      if (!isAdmin(ctx.user as PermUser)) {
        return json({ error: "Scan history is for administrators." }, 403);
      }
      const rows = await db.as(ctx.scope).get(
        "scan_logs", "select=*&order=scan_date.desc&limit=500").catch(() => []);
      const { screening, extraction } = splitHistory(rows, MATCH_RUN_LABEL);
      return json({
        screening: { last: runSummary(screening), recent: screening.slice(0, 50) },
        extraction: { last: runSummary(extraction), recent: extraction.slice(0, 50) },
        matchLabel: MATCH_RUN_LABEL,
      });
    }

    if (path === "/settings/scan-prefs" && m === "GET") return scanPrefs.read(req, ctx);
    if (path === "/settings/scan-prefs/policies" && m === "PUT") return scanPrefs.putPolicies(req, ctx);
    if (path === "/settings/scan-prefs/search-terms" && m === "PUT") return scanPrefs.putSearchTerms(req, ctx);
    if (path === "/settings/scan-prefs/currencies" && m === "PUT") return scanPrefs.putCurrencies(req, ctx);

    if (path === "/settings/sources" && m === "GET") return platform.sources(req, ctx);
    if (path === "/settings/sources/blocked" && m === "PUT") return platform.putBlocked(req, ctx);
    if (path === "/settings/sources/registry" && m === "GET") return platform.registry(req, ctx);
    if (path === "/settings/sources/registry" && m === "POST") return platform.registryAction(req, ctx);
    if (path === "/settings/learning" && m === "GET") return platform.learning(req, ctx);
    if (path === "/settings/suggestions" && m === "GET") return platform.suggestions(req, ctx);
    {
      // /settings/suggestions/<id>/(approve|reject) — matched on segments, as the users
      // routes are, so an id is never confused with the action that follows it.
      const seg = path.startsWith("/settings/suggestions/")
        ? path.slice("/settings/suggestions/".length).split("/") : [];
      if (seg.length === 2 && m === "POST"
          && (seg[1] === "approve" || seg[1] === "reject")) {
        return platform.review(req, ctx, decodeURIComponent(seg[0]), seg[1]);
      }
    }

    if (path === "/settings/records" && m === "GET") return records.read(req, ctx);
    if (path === "/settings/records" && m === "PATCH") return records.update(req, ctx);
    if (path === "/settings/records" && m === "DELETE") return records.remove(req, ctx);

    // Settings → Accounts → Users. Admin to reach the surface, canManageUser per TARGET
    // on every write — two different questions, both asked. See api/routes_users.ts.
    if (path === "/settings/users" && m === "GET") return users.list(req, ctx);
    if (path === "/settings/users" && m === "POST") return users.create(req, ctx);
    if (path === "/settings/users/bulk" && m === "POST") return users.createBulk(req, ctx);
    {
      // Matched on the SEGMENTS rather than a prefix: `/settings/users/<id>` is the
      // account and `/settings/users/<id>/reset` is an action on it, and a prefix test
      // would hand "<id>/reset" to the patch route as an id — which then matches no row
      // and answers "No such user" for a request that was perfectly well formed.
      const seg = path.startsWith("/settings/users/")
        ? path.slice("/settings/users/".length).split("/") : [];
      const id = seg[0] ? decodeURIComponent(seg[0]) : "";
      if (id && seg.length === 1 && m === "PATCH") return users.patch(req, ctx, id);
      if (id && seg.length === 2 && seg[1] === "reset" && m === "POST") {
        return users.resetPassword(req, ctx, id);
      }
    }

    // Nothing here takes a user id from the request — see api/routes_profile.ts.
    if (path === "/profile" && m === "GET") return profile.read(req, ctx);
    if (path === "/profile" && m === "PATCH") return profile.patch(req, ctx);
    if (path === "/profile" && m === "DELETE") return profile.remove(req, ctx);
    if (path === "/profile/password" && m === "POST") return profile.password(req, ctx);

    if (path === "/search" && m === "GET") return siteSearch.search(req, ctx);
    if (path === "/search/web" && m === "POST") return siteSearch.web(req, ctx);
    if (path === "/search/action" && m === "POST") return siteSearch.action(req, ctx);

    if (path === "/pipelines/weeks" && m === "GET") return pipelines.weeks(req, ctx);
    if (path === "/pipelines/screen" && m === "GET") return pipelines.screen(req, ctx);
    if (path === "/pipelines/summary" && m === "GET") return pipelines.summary(req, ctx);
    if (path === "/pipelines/reviewed" && m === "GET") return pipelines.reviewed(req, ctx);
    if (path === "/pipelines/track" && m === "GET") return pipelines.track(req, ctx);
    if (path === "/pipelines/submitted" && m === "GET") return pipelines.submitted(req, ctx);
    if (path === "/pipelines/outcome" && m === "GET") return pipelines.outcome(req, ctx);
    if (path.startsWith("/pipelines/rfp/") && m === "GET") {
      const rest = path.slice("/pipelines/rfp/".length);
      const notes = rest.endsWith("/meeting-notes");
      const uid = decodeURIComponent(
        notes ? rest.slice(0, -"/meeting-notes".length) : rest).trim();
      if (!uid) return json({ error: "No RFP selected." }, 400);
      return notes
        ? pipelines.meetingNotes(req, ctx, uid)
        : pipelines.rfp(req, ctx, uid);
    }
    // What the RFP editor's dropdowns offer. One route for every screen that opens the
    // editor, because the roster and the currency table are per-deployment settings rather
    // than repo data — see api/form_options.ts.
    if (path === "/pipelines/form-options" && m === "GET") return formOptions.options(req, ctx);
    if (path === "/pipelines/decision" && m === "POST") return pipelineWrites.decide(req, ctx);
    if (path.startsWith("/pipelines/rfp/") && m === "PATCH") {
      const uid = decodeURIComponent(path.slice("/pipelines/rfp/".length)).trim();
      if (!uid) return json({ error: "No RFP selected." }, 400);
      return pipelineWrites.patchRfp(req, ctx, uid);
    }
    // Admin only, and it removes nothing by itself: it queues the job that tombstones the
    // row for the scan and then deletes it. pipeline_writes.ts::deleteRfp says why that
    // order cannot be reversed.
    if (path.startsWith("/pipelines/rfp/") && m === "DELETE") {
      const uid = decodeURIComponent(path.slice("/pipelines/rfp/".length)).trim();
      if (!uid) return json({ error: "No RFP selected." }, 400);
      return pipelineWrites.deleteRfp(ctx, uid);
    }
    if (path === "/opportunity" && m === "GET") {
      const uid = new URL(req.url).searchParams.get("uid")?.trim() ?? "";
      if (!uid) return json({ error: "No opportunity selected." }, 400);
      return phase1.opportunity(req, ctx, uid);
    }
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
