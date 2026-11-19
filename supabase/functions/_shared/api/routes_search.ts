/**
 * Search — the route. `app_pages/search.py`.
 *
 * ONE SYNCHRONOUS READ, AND A JOB. The in-app half is a static registry and two `ilike`
 * queries, so it answers in the request. The web half cannot: `core/web_search.py` holds
 * the provider keys, fans one keyword into several RFP-framed searches across Serper and
 * Tavily, fetches candidate pages to read their posted dates, and filters everything
 * through seven rules. Measured live, one query took 21.4 seconds. So it is a job, like
 * the Report's workbook, and the page polls it.
 *
 * WHAT THE JOB TELLS THE BROWSER ANYWAY: whether web search is configured at all. The
 * Streamlit page checks `web_search.available()` and, when no provider key is set, prints
 * an admin's instructions instead of a button. That answer lives in the Python's
 * environment, so this route cannot give it — but a button that queues a job which fails
 * with "no provider configured" is a worse way to learn it than being told up front. The
 * page therefore shows the button and the job reports the reason; `available` travels back
 * in the job's own result so the page can say the right thing the first time.
 */
import { body, json, str } from "./http.ts";
import { searchDonors, searchNav, searchOpportunities } from "./search.ts";
import { isAdmin, type PermUser } from "./permissions.ts";
import type { Db } from "./db.ts";
import type { Ctx } from "./session.ts";

type Enqueue = (
  kind: string, params: Record<string, unknown>, ctx: Ctx,
) => Promise<{ id: string; dispatched: boolean } | null>;

export function createSearchRoutes(db: Db, enqueue: Enqueue | null = null) {
  /** `GET /search?q=` — the in-app half, all three groups in one response. */
  async function search(req: Request, ctx: Ctx): Promise<Response> {
    const q = str(new URL(req.url).searchParams.get("q")).trim();
    const admin = isAdmin(ctx.user as PermUser);
    // The nav registry is admin-aware and needs no database; the two data groups are
    // tenant-scoped reads. They are independent, so they go together.
    const scoped = db.as(ctx.scope);
    const [opportunities, donors] = await Promise.all([
      searchOpportunities(scoped, q),
      searchDonors(scoped, q),
    ]);
    const nav = searchNav(q, admin);
    return json({
      query: q,
      nav,
      opportunities,
      donors,
      total: nav.length + opportunities.length + donors.length,
    });
  }

  /**
   * `POST /search/web` — queue one web discovery run.
   *
   * Open to any signed-in member, the same reach the Streamlit button has: the page is
   * open to everyone and the button sits on it. It spends provider quota, which is the
   * argument for a gate, but the quota is per-organisation and the people who find calls
   * are not the administrators.
   */
  async function web(req: Request, ctx: Ctx): Promise<Response> {
    if (!enqueue) return json({ error: "Web search is not available here." }, 503);
    const b = await body(req);
    const q = str(b.q).trim();
    if (q.length < 2) return json({ error: "Type at least two characters." }, 400);
    const queued = await enqueue("web_search", {
      tenant_id: db.scopeTid(ctx.scope), q, num: 30,
      // The Streamlit page's Refresh button calls `web_search.search.clear()` before
      // re-running, which drops the 15-minute cache. Carried through as a flag rather
      // than a second kind: it is the same work with one line done first.
      fresh: b.fresh === true,
    }, ctx);
    if (!queued) return json({ error: "Web search is not available here." }, 503);
    if (!queued.dispatched) {
      return json({
        error: "The web search could not be started. The job runner is not reachable "
          + "from this deployment.",
        jobId: queued.id,
      }, 503);
    }
    return json({ jobId: queued.id }, 202);
  }

  /**
   * `POST /search/action` — rate a web result, or track it.
   *
   * BOTH ARE PYTHON'S, and for the same reason the submit follow-up is. Rating writes
   * through `core/decision_log.log_feedback`, whose record shape is the ML training
   * label's. Tracking runs `core/found_loader.load_candidate`, which scores the candidate
   * with `auto_scorer`, checks `deduplicator` for a row already tracking it, and may route
   * it to the Sources registry instead — three modules this function has no port of, and
   * the scoring one it must never acquire a second copy of.
   *
   * One kind rather than two: they are the same shape of work on the same object, they
   * both take one result dict, and splitting them would be two job kinds to keep in step
   * for no gain.
   */
  async function action(req: Request, ctx: Ctx): Promise<Response> {
    if (!enqueue) return json({ error: "That action is not available here." }, 503);
    const b = await body(req);
    const kind = str(b.action).trim();
    if (kind !== "feedback" && kind !== "track") {
      return json({ error: "Unknown action." }, 400);
    }
    const result = b.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return json({ error: "No result to act on." }, 400);
    }
    const verdict = str(b.verdict).trim().toLowerCase();
    if (kind === "feedback" && !["good", "neutral", "bad"].includes(verdict)) {
      return json({ error: "A rating must be good, neutral or bad." }, 400);
    }
    const queued = await enqueue("search_action", {
      tenant_id: db.scopeTid(ctx.scope),
      action: kind, result, verdict: kind === "feedback" ? verdict : null,
      by: str(ctx.user.email),
    }, ctx);
    if (!queued) return json({ error: "That action is not available here." }, 503);
    if (!queued.dispatched) {
      return json({
        error: "That could not be recorded. The job runner is not reachable from this "
          + "deployment.",
        jobId: queued.id,
      }, 503);
    }
    return json({ jobId: queued.id }, 202);
  }

  return { search, web, action };
}
