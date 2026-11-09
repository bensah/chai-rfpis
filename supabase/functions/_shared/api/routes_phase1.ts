/**
 * Home, the opportunity rail and the Opportunity page.
 *
 * These routes mostly FETCH. What decides here is what was measured to need no scoring:
 *
 *   * Home's counters — plain arithmetic over a few columns, which would otherwise cost a
 *     four-second engine boot to answer.
 *   * The rail's four cards (`opportunitiesFeed`) — core/opportunity_feed.py ORDERS values
 *     already stored on each row and computes none of them.
 *
 * What is left in the browser's Python engine, against the snapshot this file assembles,
 * is the Opportunity page's decision aid: it computes nine criteria live, reaching most of
 * core/criteria_derive.py and core/auto_scorer.py, and the stored alignment_score is
 * measurably a different number from the one it shows.
 *
 * Both ports are held to the Python by web/scripts/parity/check-scoring.mjs.
 */
import { q, type Db } from "./db.ts";
import { json, gzipped, str } from "./http.ts";
import { ratesFor } from "./fx.ts";
import type { Json } from "./jwt.ts";
import { asToday, classify, featured } from "./opportunity_feed.ts";
import { getPolicies, tenantPrefs } from "./policies.ts";
import { isSuperUser, type PermUser } from "./permissions.ts";
import type { Ctx } from "./session.ts";

/** views/opportunity_rail.py::_FIELDS, plus call_domain_areas.
 *
 * The extra column is not decoration. In Streamlit the rail makes a SECOND query for its
 * preferences (`_tenant_prefs`) that selects funding_agency, call_domain_areas and decision.
 * The browser answers that query from these same rows, so leaving the column out silently
 * emptied `pursued_areas` — the programme areas the tenant has actually bid on, and 28% of
 * what Featured ranks by. web/scripts/parity/check-scoring.mjs is what caught it. */
const PIPELINE_FIELDS = "uid,opportunity_title,funding_agency,call_award_value,currency," +
  "call_submission_deadline,call_geographic_scope,date_posted,search_date," +
  "created_at,alignment_score,auto_recommendation,decision,opportunity_link," +
  "brief_description,focus_theme,call_domain_areas";

/** views/opportunity_rail.py::_CATALOG_FIELDS */
const CATALOG_FIELDS = "uid,opportunity_name,opportunity_url,funder_name,deadline," +
  "grant_amount,currency,call_geographic_scope,call_domain_areas," +
  "focus_themes,brief_description,solicitation_type,instrument_type," +
  "opportunity_type,date_posted";

/** app_pages/home.py::_kpis */
const HOME_FIELDS = "uid,decision,donor_decision,progress_status,call_submission_deadline,is_duplicate";

const today = () => new Date().toISOString().slice(0, 10);

/** pandas.to_datetime(v).date() for the values these columns actually hold: an ISO date, an
 * ISO timestamp, or something unparseable (which pandas coerces to NaT → None). */
function asDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

const norm = (v: unknown) => str(v).trim().toLowerCase();
/** pandas' truthiness for the is_duplicate column: real booleans, plus the strings Supabase
 * can return for a nullable boolean. */
const truthy = (v: unknown) => v === true || v === "true" || v === "t" || v === 1;

export function createPhase1Routes(db: Db) {
  /** Everything core/ reads from the database while scoring, plus the rates it would
   * otherwise fetch over the network. The reads are the ones traced from the live path. */
  async function snapshot(req: Request, ctx: Ctx): Promise<Response> {
    const sb = db.as(ctx.scope);
    const tid = db.scopeTid(ctx.scope);
    const [policies, donors, tenantRow, programs, tenants, currencies] = await Promise.all([
      db.service.get("tenant_settings",
        `select=value&tenant_id=eq.${q(tid)}&key=eq.scan_policies&limit=1`).catch(() => []),
      sb.get("donor_intel", "select=*"),
      db.service.get("tenants", `select=name,org_profile,org_identity&id=eq.${q(tid)}&limit=1`).catch(() => []),
      db.service.get("users", "select=program&is_active=eq.true").catch(() => []),
      db.service.get("tenants",
        "select=id,name,slug,status,parent_tenant_id,share_for_consortium_scoring&status=neq.blacklisted")
        .catch(() => []),
      // The currencies this tenant's rows actually use — the only rates worth fetching.
      // getAll, because `limit=2000` was a lie: PostgREST caps a response at 1000 and says
      // nothing. A currency only used by row 1001 would have had no rate, and every amount
      // in it would have gone unconverted.
      sb.getAll("rfp_submissions", "select=currency,uid", "uid").catch(() => []),
    ]);
    const row = (tenantRow[0] ?? {}) as Json;
    return gzipped(req, json({
      tenant_id: tid,
      today: today(),
      scan_policies: policies[0]?.value ?? null,
      donor_intel: donors,
      org_profile: row.org_profile ?? null,
      org_identity: { name: row.name ?? null, org_identity: row.org_identity ?? null },
      user_programs: programs.map((p) => p.program ?? null),
      tenants,
      fx_rates: await ratesFor(currencies.map((r) => r.currency)),
    }, 200, { "Cache-Control": "private, max-age=60" }));
  }

  /** app_pages/home.py::_kpis — the same counts, over the same columns.
   *
   *  getAll: every number this returns is a count over the whole table, so a read capped
   *  at 1000 would not make the home page look short — it would make it look wrong, with
   *  no way for a reader to tell. */
  async function home(ctx: Ctx): Promise<Response> {
    const rows = await db.as(ctx.scope).getAll("rfp_submissions", `select=${HOME_FIELDS}`, "uid");
    const t = today();
    const soon = new Date(Date.parse(t) + 14 * 86400_000).toISOString().slice(0, 10);

    const unique = rows.filter((r) => !truthy(r.is_duplicate));
    const decision = (r: Json) => norm(r.decision);
    const proceed = unique.filter((r) => decision(r).startsWith("proceed"));
    const deadlines = proceed.map((r) => asDate(r.call_submission_deadline));
    return json({
      total_unique: unique.length,
      total_found: rows.length,
      duplicates: rows.length - unique.length,
      proceed: proceed.length,
      park: unique.filter((r) => decision(r) === "park").length,
      decline: unique.filter((r) => decision(r) === "decline").length,
      // Urgency applies only to Proceed rows: Park and Decline have no actionable deadline.
      overdue: deadlines.filter((d) => d !== null && d < t).length,
      due_soon: deadlines.filter((d) => d !== null && d >= t && d <= soon).length,
      submitted: unique.filter((r) => norm(r.progress_status) === "completed").length,
      awarded_grants: unique.filter((r) => norm(r.donor_decision) === "approved").length,
    });
  }

  /** The rows the rail's four cards are ranked from. The ranking itself is Python's. */
  async function feed(req: Request, ctx: Ctx): Promise<Response> {
    const sb = db.as(ctx.scope);
    const [pipeline, catalog, links] = await Promise.all([
      sb.get("rfp_submissions", `select=${PIPELINE_FIELDS}&order=created_at.desc&limit=800`)
        .catch(() => [] as Json[]),
      // Not tenant-scoped, by design: the shared catalogue is what makes a screening miss
      // recoverable. It holds no tenant data.
      //
      // 1000 and not 1200, because 1200 was never what happened: PostgREST caps a response
      // at 1000 silently, and the table passed 1000 some time ago (1546 rows, measured
      // 2026-10-29). This is a RANKING feed — the browser picks four cards from it — so the
      // newest 1000 by scraped_at is a sound basis and paging the whole catalogue would
      // grow this payload without end. The bound is now the real one, stated.
      db.service.get("extracted_solicitations",
        `select=${CATALOG_FIELDS}&order=scraped_at.desc&limit=1000`).catch(() => [] as Json[]),
      // getAll, unlike the catalogue above: this is the set of calls already in the
      // pipeline, and the rail subtracts it to decide what is NEW. A short read here does
      // not rank anything badly, it offers the user a call they have already screened.
      sb.getAll("rfp_submissions", "select=opportunity_link,uid", "uid").catch(() => [] as Json[]),
    ]);
    return gzipped(req, json({
      pipeline, catalog,
      seen: links.map((r) => str(r.opportunity_link).trim().toLowerCase().replace(/\/+$/, ""))
        .filter(Boolean),
    }, 200, { "Cache-Control": "private, max-age=45" }));
  }

  /**
   * The rail's four cards, RANKED HERE.
   *
   * `feed` above returns rows for the browser's Python engine to rank. This returns the
   * finished cards, because the ranking needs no scoring: measured over the live database,
   * core/opportunity_feed.classify reads only columns already stored on the row. Moving it
   * here is what lets Home and Pipelines stop booting a Python runtime to draw a sidebar.
   *
   * The Opportunity page's decision aid is a different matter and still runs in the engine
   * — it computes nine criteria live, and the stored alignment_score is measurably not the
   * same number (see the retirement notes).
   */
  async function opportunitiesFeed(req: Request, ctx: Ctx): Promise<Response> {
    const sb = db.as(ctx.scope);
    const tid = db.scopeTid(ctx.scope);
    const [pipeline, catalog, links, policyRow, tenantRow] = await Promise.all([
      sb.get("rfp_submissions", `select=${PIPELINE_FIELDS}&order=created_at.desc&limit=800`)
        .catch(() => [] as Json[]),
      db.service.get("extracted_solicitations",
        `select=${CATALOG_FIELDS}&order=scraped_at.desc&limit=1000`).catch(() => [] as Json[]),
      sb.getAll("rfp_submissions", "select=opportunity_link,uid", "uid")
        .catch(() => [] as Json[]),
      db.service.get("tenant_settings",
        `select=value&tenant_id=eq.${q(tid)}&key=eq.scan_policies&limit=1`).catch(() => []),
      db.service.get("tenants", `select=org_profile&id=eq.${q(tid)}&limit=1`).catch(() => []),
    ]);

    const profile = ((tenantRow[0] ?? {}).org_profile ?? null) as Json | null;
    const policies = getPolicies((policyRow[0]?.value as string) ?? null, profile);
    // The server's date, as the snapshot passed it before: a browser in another timezone
    // must not classify a deadline differently from Streamlit.
    const day = asToday(today());
    const seen = new Set(links.map((r) =>
      str(r.opportunity_link).trim().toLowerCase().replace(/\/+$/, "")).filter(Boolean));

    const groups = classify(pipeline, day, policies as unknown as Json);
    const prefs = tenantPrefs(policies, profile, pipeline);
    return gzipped(req, json({
      featured: featured(catalog, prefs, seen, day),
      ...groups,
    }, 200, { "Cache-Control": "private, max-age=45" }));
  }

  /** The candidate rows for one uid. app_pages/opportunity.py's own readers, server-side:
   * the pipeline is tenant-scoped, the catalogue deliberately is not. */
  async function opportunity(req: Request, ctx: Ctx, uid: string): Promise<Response> {
    const sb = db.as(ctx.scope);
    const [pipelineRows, catalogRows] = await Promise.all([
      sb.get("rfp_submissions", `select=*&uid=eq.${q(uid)}&limit=1`).catch(() => [] as Json[]),
      db.service.get("extracted_solicitations", `select=*&uid=eq.${q(uid)}&limit=1`)
        .catch(() => [] as Json[]),
    ]);
    const pipelineRow = pipelineRows[0] ?? null;

    // A screened row is joined back to its extraction by call URL, so the page shows the
    // whole call rather than only the fields screening kept. The column stores the URL as
    // published while the lookup key is lower-cased, hence the case-insensitive match —
    // then verified, because `like` can over-match.
    let extraction: Json | null = null;
    const link = str(pipelineRow?.opportunity_link).trim().toLowerCase().replace(/\/+$/, "");
    if (link) {
      const bare = link.replace(/^https?:\/\//, "");
      for (const pattern of [link, `%${bare}%`]) {
        const hits = await db.service.get("extracted_solicitations",
          `select=*&opportunity_url=ilike.${q(pattern)}&limit=5`).catch(() => [] as Json[]);
        extraction = hits.find((r) =>
          str(r.opportunity_url).trim().toLowerCase().replace(/\/+$/, "") === link) ?? null;
        if (extraction) break;
      }
    }
    return gzipped(req, json({
      uid,
      pipelineRow,
      catalogRow: catalogRows[0] ?? null,
      extraction,
      isSuper: isSuperUser(ctx.user as PermUser),
    }));
  }

  return { snapshot, home, feed, opportunitiesFeed, opportunity };
}
