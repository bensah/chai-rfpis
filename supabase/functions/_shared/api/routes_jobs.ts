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
import { isAdmin, isSuperUser, type PermUser } from "./permissions.ts";
import type { Ctx } from "./session.ts";

export type Dispatch = (jobId: string, group: string) => Promise<void>;

type JobKind = {
  /** The same gate as the Streamlit control that starts this work. */
  allowed: (u: PermUser, ctx: Ctx) => Promise<boolean> | boolean;
  /** Actions concurrency group: jobs sharing one never run at the same time. */
  group: (ctx: Ctx, jobId: string) => string;
};

// New kinds are added phase by phase (extract, screen, excel_sync, backup, report_pdf, …).
const KINDS: Record<string, JobKind> = {
  // A no-op that proves the loop end to end: queue → Actions → runner → row → browser.
  // Lives on Settings → Accounts → Deployment, which only a super_user sees.
  ping: { allowed: (u) => isSuperUser(u), group: (_c, id) => `web-job-${id}` },
};

const JOB_COLUMNS = "id,kind,status,progress,message,result,created_at,started_at,finished_at,run_url,created_by,tenant_id";

export function createJobRoutes(db: Db, dispatch: Dispatch | null) {
  async function create(req: Request, ctx: Ctx): Promise<Response> {
    const b = await body(req);
    const kind = str(b.kind);
    const spec = KINDS[kind];
    if (!spec) return json({ error: `Unknown job kind '${kind}'.` }, 400);
    const u = ctx.user as PermUser;
    if (!(await spec.allowed(u, ctx))) return json({ error: "You don't have access to this action." }, 403);
    const params = b.params && typeof b.params === "object" && !Array.isArray(b.params) ? b.params : {};
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
    } else {
      try {
        await dispatch(id, spec.group(ctx, id));
        await db.service.update("web_jobs", `id=eq.${q(id)}&status=eq.queued`, { status: "dispatched" });
      } catch (e) {
        console.error("job dispatch failed", id, e);
        await db.service.update("web_jobs", `id=eq.${q(id)}`, {
          status: "failed", message: "Could not start the background job. Try again.",
          finished_at: new Date().toISOString(),
        });
      }
    }
    return json({ job: await read(id) }, 202);
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

  return { create, get };
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
