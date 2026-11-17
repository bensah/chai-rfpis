/**
 * Background jobs. Work that cannot fit an Edge Function (scans, PDF rendering, backups,
 * Excel sync) runs on GitHub Actions: this route checks the caller may start it, records a
 * `web_jobs` row (migration 099), and dispatches `.github/workflows/web-job.yml` with the
 * job id as its only input. The runner (scripts/run_web_job.py) reports back into the row;
 * the browser polls GET /jobs/:id.
 *
 * The repository is public, so Actions logs are public: nothing but the opaque job id goes
 * into the dispatch, and the runner logs only status.
 */
import { q, type Db } from "./db.ts";
import { body, HttpError, json, str } from "./http.ts";
import type { Json } from "./jwt.ts";
import {
  isAdmin, isDeveloperAdmin, isDeveloperSuper, isSuperUser, type PermUser,
} from "./permissions.ts";
import type { Ctx } from "./session.ts";

export type Dispatch = (jobId: string, group: string) => Promise<void>;

type JobKind = {
  /** The same gate as the Streamlit control that starts this work. */
  allowed: (u: PermUser, ctx: Ctx) => Promise<boolean> | boolean;
  /**
   * Actions concurrency group: jobs sharing one never run at the same time.
   *
   * KEEP IT AS NARROW AS THE HAZARD. GitHub holds at most ONE pending run per group, so a
   * third dispatch into a busy group does not queue behind the second — it CANCELS it.
   * The job row is left `queued` for ever and nothing says so. Measured 2026-11-10:
   * dispatching three decisions for one tenant ran two and silently stranded the third,
   * which is a lost tombstone, which is "we keep declining this and it keeps coming back"
   * arriving by a new route.
   *
   * So a group may only cover work that genuinely collides. `params` is passed for that:
   * the collisions here are per ROW, not per tenant.
   */
  group: (ctx: Ctx, jobId: string, params: Json) => string;
};

// New kinds are added phase by phase (extract, screen, excel_sync, backup, report_pdf, …).
/** The row a job is about, when it is about one. A tenant-wide job has none. */
const subject = (params: Json): string => {
  const uid = typeof params?.uid === "string" ? params.uid.trim() : "";
  return uid || "all";
};
const tenantOf = (ctx: Ctx) => ctx.scope.viewTenantId ?? ctx.scope.tenantId ?? "none";

const KINDS: Record<string, JobKind> = {
  // A no-op that proves the loop end to end: queue → Actions → runner → row → browser.
  // Lives on Settings → Accounts → Deployment, which only a super_user sees.
  ping: { allowed: (u) => isSuperUser(u), group: (_c, id) => `web-job-${id}` },

  /**
   * Recompute this tenant's stored scores — one row after a save, or the whole table after
   * a profile edit. The server owning the score (owner, 2026-10-28) is this job: the same
   * Python the scan runs, on Actions, writing alignment_score and auto_recommendation
   * back where every reader already looks.
   *
   * Anyone who can edit an RFP can cause a re-score of what they edited, so the gate is
   * simply a signed-in member — the same reach the edit itself has.
   *
   * ONE GROUP PER ROW, not per tenant. The group used to cover the whole tenant so that a
   * save queued during a full re-score waited rather than racing it — but two re-scores of
   * one row compute the same number from the same row and write the same value, so the
   * race was never harmful, while the cancellation the wide group causes leaves a score
   * stale with nothing to say so. A tenant-wide re-score has no uid and keeps the old
   * group, since there is only ever one of those worth running at a time.
   */
  rescore: {
    allowed: () => true,
    group: (ctx, _id, params) => `rescore-${tenantOf(ctx)}-${subject(params)}`,
  },

  /**
   * The two consequences of a human decision that live in Python: the ML training label
   * (`core/decision_log.py`) and the scan's tombstone (`core/seen_ledger.py`, whose
   * column map is probed from the live table and so cannot be guessed at from here).
   *
   * Queued by POST /pipelines/decision, with the same gate as the decision itself.
   * Its own group rather than the re-score's: these are an append-only log and an upsert
   * keyed by uid, so they race nothing, and sharing a group would have a decision wait
   * behind a whole-tenant re-score for no reason.
   *
   * AND PER ROW, because "they race nothing" was always the argument for a narrow group
   * and the group was nevertheless per tenant. Recording three decisions in quick
   * succession dropped one of them.
   */
  record_decision: {
    allowed: () => true,
    group: (ctx, _id, params) => `decision-${tenantOf(ctx)}-${subject(params)}`,
  },

  /**
   * Remove one opportunity from the pipeline: the scan's tombstone, the ML training
   * label, and THEN the row - `views/rfp_editor.py`'s delete button, in its order.
   *
   * Queued by DELETE /pipelines/rfp/:uid, which deletes nothing itself. That route's
   * docstring says why the row cannot go first; the short version is that both
   * consequences are read FROM the live row, so a row deleted before the job runs is a
   * row that can never be tombstoned - the "we keep declining this and it keeps coming
   * back" bug, with the evidence gone.
   *
   * Admin only, matching the Streamlit button (`core/permissions.is_admin`). Checked here
   * as well as at the route, because `POST /jobs` can start a kind directly and a gate
   * that lives only on the convenient path is not a gate.
   *
   * SHARES THE DECISION GROUP rather than taking one of its own — and the sharing is what
   * matters, not the width. A delete and a decision ON THE SAME ROW both write `rfp_seen`
   * and `scan_decisions`, and the delete ends with the row itself going away: running them
   * at once would have one job tombstoning from a row the other is removing. Serialised,
   * the loser simply finds no row and says so.
   *
   * Same row, same group — so that protection is intact — and different rows no longer
   * queue behind each other, so a third one cannot cancel a second.
   */
  delete_rfp: {
    allowed: (u) => isAdmin(u),
    group: (ctx, _id, params) => `decision-${tenantOf(ctx)}-${subject(params)}`,
  },

  /**
   * The Report's six-sheet data export — see api/report_export.ts for what goes in it and
   * why it cannot run in this function.
   *
   * Anyone who can open Report can export it, exactly as the Streamlit download button is
   * open to anyone who reaches the page: the workbook holds the rows the charts on that
   * page are already drawn from, so the export reveals nothing the reader cannot see.
   *
   * ONE GROUP PER TENANT, which is wider than the per-row groups above and deliberately
   * so. Two exports of one tenant read the same tables and write two files, so they do not
   * corrupt each other — but they do read a few thousand rows each, and GitHub keeps only
   * one pending run per group, so a third dispatch CANCELS the second. A reader pressing
   * Export twice would therefore lose the second file silently. Narrow enough that two
   * tenants never wait on each other; wide enough that one reader's double-press collapses
   * into one run rather than a cancelled one.
   *
   * The period is NOT in the group. Including it would let one reader start five exports at
   * once by flicking through periods, which is the cost this group exists to bound.
   */
  export_report_xlsx: {
    allowed: () => true,
    group: (ctx) => `report-export-${tenantOf(ctx)}`,
  },

  /**
   * The two consequences of a manual submission that live in Python: the seen-ledger
   * tombstone (`core/seen_ledger`, whose column map is probed from the live table) and the
   * share to the global opportunity pool (`core/extracted_store`, whose uid is a hash of
   * the URL that must not be computed a second way). Queued by POST /submit.
   *
   * Anyone who can submit can cause its follow-up, so the gate is the route's own: a
   * signed-in member. Both halves are best-effort in the Streamlit form and stay so here —
   * the row is already saved when this runs.
   *
   * SHARES THE DECISION GROUP, per row, for the reason `delete_rfp` does: this writes
   * `rfp_seen` for a uid, and so do a decision and a delete on that same uid. Serialised,
   * whichever loses simply finds the row in the state the other left it. Different rows do
   * not wait on each other, which matters because GitHub CANCELS a third pending run in a
   * group rather than queueing it — a Friday of hand-captured calls would otherwise lose
   * every tombstone but the last two.
   */
  submit_followup: {
    allowed: () => true,
    group: (ctx, _id, params) => `decision-${tenantOf(ctx)}-${subject(params)}`,
  },

  /**
   * One web-discovery run for the Search page — `core/web_search.py`, which holds the
   * provider keys, fans one keyword into several RFP-framed searches across Serper and
   * Tavily, fetches candidate pages to read their posted dates, and filters the hits
   * through seven rules. Measured live at 21.4 seconds for one query, so it is nobody's
   * request to serve.
   *
   * Open to any signed-in member, matching the Streamlit button on a page open to
   * everyone.
   *
   * ONE GROUP PER READER, not per tenant and not per query. The hazard being bounded is
   * provider quota, and the way it is spent is one person flicking through keywords: each
   * new query cancels their pending run instead of queueing a second. Two people searching
   * at once is not a collision and must not become one, so the group carries the session
   * rather than the tenant.
   */
  web_search: {
    allowed: () => true,
    group: (ctx) => `web-search-${ctx.session.sub}`,
  },

  /**
   * Rating a web result, or tracking it into Found Records.
   *
   * `decision_log.log_feedback` writes the ML training label; `found_loader.load_candidate`
   * scores the candidate with `auto_scorer`, checks `deduplicator`, and may route it to
   * the Sources registry instead. Three Python modules, one of which is the scorer this
   * repo must never hold a second copy of.
   *
   * ONE GROUP PER JOB, because these collide with nothing: the feedback table is
   * append-only and a track inserts a new row whose duplicate check is its own. Anything
   * wider would have a reader's second rating cancel their first.
   */
  search_action: {
    allowed: () => true,
    group: (_c, id) => `search-action-${id}`,
  },

  /**
   * Settings → Manual Scan → Eligibility Scan. Screens the shared extracted store
   * against THIS organisation's eligibility — fast, no crawl.
   *
   * A job not because it is slow but because it is PYTHON: `core/scan_pipeline` is the
   * geography gate, the nine MUST/PREFER criteria and the donor-intel joins, which is
   * the engine this whole port exists not to re-implement.
   *
   * GROUPED PER TENANT, so a second press while one is running joins the run in flight
   * instead of starting another. Two concurrent screens of the same store into the same
   * pipeline race on the rows they insert.
   */
  scan_screen: {
    allowed: (u) => isAdmin(u),
    group: (ctx) => `scan-screen-${tenantOf(ctx)}`,
  },

  /**
   * Settings → Manual Scan → Extraction. Crawls every catalogued source into the SHARED
   * global store: 25-40 minutes with LLM enrichment, and the slowest thing the product
   * does.
   *
   * DEVELOPER-TENANT ADMINS ONLY, which is the Streamlit page's own gate and not a
   * tightening: the store it writes belongs to every tenant, so one organisation's admin
   * triggering a platform-wide crawl is the thing being prevented.
   *
   * ONE GROUP FOR EVERYBODY — not per tenant — because there is one store and one crawl.
   * A per-tenant group would let two tenants start two simultaneous full crawls of the
   * same sources, which is how a polite scraper becomes a rude one.
   */
  scan_extract: {
    allowed: async (u, ctx) => isDeveloperAdmin(u, await ctx.homeIsDeveloper()),
    group: () => "scan-extract",
  },

  /**
   * Settings → Manual Scan → Excel Sync. Imports the master workbook into THIS tenant's
   * pipeline, stamping every row with the tenant — without which they land with a null
   * tenant and appear in nobody's pipeline.
   */
  excel_sync: {
    allowed: (u) => isAdmin(u),
    group: (ctx) => `excel-sync-${tenantOf(ctx)}`,
  },

  /**
   * Settings → Suggestions: applying one proposal to a SHARED catalogue.
   *
   * `core/suggestions.approve` intersects the diff with a per-resource column allow-list
   * and writes into donor_intel or donor_sources — tables every tenant's scan reads. A
   * TypeScript version of those rules would be a second set of opinions about shared
   * data, where the first cannot see it.
   *
   * DEVELOPER-TENANT SUPER ONLY, and the runner re-establishes that from the users table
   * rather than trusting the params: by the time a job runs, the only record of who
   * asked is what was written down.
   *
   * GROUPED PER SUGGESTION, so a double-click cannot apply one proposal twice.
   */
  suggestion_review: {
    allowed: async (u, ctx) => isDeveloperSuper(u, await ctx.homeIsDeveloper()),
    group: (_c, _id, params) => `suggestion-${str(params?.suggestion_id)}`,
  },
};

/**
 * The kinds this function will queue, for the parity check that compares them against
 * `scripts/run_web_job.py::KINDS`.
 *
 * A kind on one side only is a silent failure in whichever direction it goes: queued here
 * and unknown to the runner, the job row sits `queued` for ever with nothing to say why;
 * known to the runner and absent here, `enqueue` returns null and the caller is told
 * "unknown job kind" for work that exists.
 */
export const jobKinds = (): string[] => Object.keys(KINDS);

const JOB_COLUMNS = "id,kind,status,progress,message,result,created_at,started_at,finished_at,run_url,created_by,tenant_id";

export function createJobRoutes(db: Db, dispatch: Dispatch | null) {
  /**
   * Write the row and ask Actions to run it. Shared by the public route below and by any
   * route that queues work as a SIDE EFFECT of something else — the editor's save queues a
   * rescore — so there is one place that knows how a job reaches the runner.
   *
   * Never throws. A job that could not be dispatched is recorded as failed rather than
   * lost, and the caller decides whether that matters: it is fatal to `POST /jobs`, whose
   * whole purpose was to start it, and not to a save, which succeeded.
   *
   * WHICH IS WHY IT RETURNS `dispatched` AND NOT JUST AN ID. For a long time it returned
   * the id either way, so no caller could actually make that decision — and the one that
   * tried, `deleteRfp`, had to re-read the job row to find out. The editor's save could
   * not, and told people "the score is being recalculated" over a job that had already
   * failed. Measured live on 2026-11-10, with the dispatch token missing: four jobs failed
   * and the UI reported two of them as queued.
   *
   * Returns null only for an unknown kind — "nothing was created", which is different
   * from "created but not started".
   */
  async function enqueue(
    kind: string, params: Json, ctx: Ctx,
  ): Promise<{ id: string; dispatched: boolean } | null> {
    const spec = KINDS[kind];
    if (!spec) return null;
    const tenantId = db.scopeTid(ctx.scope);
    const [row] = await db.service.insert("web_jobs", {
      kind, params, status: "queued", created_by: ctx.session.sub,
      tenant_id: /^0{8}-/.test(tenantId) ? null : tenantId,
    });
    const id = String(row.id);
    if (!dispatch) {
      await db.service.update("web_jobs", `id=eq.${q(id)}`, {
        status: "failed", message: "Background jobs are not configured on this server.",
        finished_at: new Date().toISOString(),
      });
      return { id, dispatched: false };
    }
    try {
      await dispatch(id, spec.group(ctx, id, params));
      await db.service.update("web_jobs", `id=eq.${q(id)}&status=eq.queued`, { status: "dispatched" });
    } catch (e) {
      console.error("job dispatch failed", id, e);
      await db.service.update("web_jobs", `id=eq.${q(id)}`, {
        status: "failed", message: "Could not start the background job. Try again.",
        finished_at: new Date().toISOString(),
      });
      return { id, dispatched: false };
    }
    return { id, dispatched: true };
  }

  async function create(req: Request, ctx: Ctx): Promise<Response> {
    const b = await body(req);
    const kind = str(b.kind);
    const spec = KINDS[kind];
    if (!spec) return json({ error: `Unknown job kind '${kind}'.` }, 400);
    const u = ctx.user as PermUser;
    if (!(await spec.allowed(u, ctx))) return json({ error: "You don't have access to this action." }, 403);
    const params = b.params && typeof b.params === "object" && !Array.isArray(b.params) ? b.params : {};
    const queued = await enqueue(kind, params as Json, ctx);
    if (!queued) return json({ error: `Unknown job kind '${kind}'.` }, 400);
    // Starting it WAS the request, so a job that never reached the runner is a failure of
    // this call, not a footnote on it. The row is returned either way, so the caller can
    // still see its status and message rather than being told only that something broke.
    const job = await read(queued.id);
    return json({ job }, queued.dispatched ? 202 : 503);
  }

  async function read(id: string): Promise<Json | null> {
    const rows = await db.service.get("web_jobs", `select=${JOB_COLUMNS}&id=eq.${q(id)}&limit=1`);
    return rows[0] ?? null;
  }

  /** Who started it, an admin of the same tenant, or a super_user. */
  async function get(ctx: Ctx, id: string): Promise<Response> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "No such job.");
    const job = await read(id);
    const u = ctx.user as PermUser;
    const mine = job && String(job.created_by) === ctx.session.sub;
    const sameTenantAdmin = job && isAdmin(u) && job.tenant_id && String(job.tenant_id) === db.scopeTid(ctx.scope);
    if (!job || !(mine || sameTenantAdmin || isSuperUser(u))) throw new HttpError(404, "No such job.");
    return json({ job });
  }

  return { create, get, enqueue };
}

/** Dispatch through the GitHub REST API (production). */
export function githubDispatch(token: string, repo: string, ref = "main"): Dispatch {
  return async (jobId, group) => {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/web-job.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "rfpis-api",
      },
      body: JSON.stringify({ ref, inputs: { job_id: jobId, group } }),
    });
    if (r.status !== 204) throw new Error(`GitHub dispatch ${r.status}: ${(await r.text()).slice(0, 200)}`);
  };
}
