/**
 * Settings → Sources, Learning data and Suggestions — the three DEVELOPER surfaces.
 *
 * WHAT THEY HAVE IN COMMON is what puts them in one module: all three read or write
 * resources shared by EVERY tenant, so none of them is scoped to the viewer's own, and
 * each is gated on developer-tenant membership rather than on a role alone. A client
 * tenant's admin is an administrator of their organisation; none of this belongs to it.
 *
 *   Sources         the funding catalogue every scan crawls, and the blocked-token list
 *                   that drops candidate URLs for every tenant.
 *   Learning data   scan_decisions — the labelled training signal behind the scoring
 *                   model, pooled across tenants.
 *   Suggestions     the review queue for proposed changes to those shared resources.
 *
 * THEY ARE READ WITH THE SERVICE ROLE AND THAT IS THE POINT. `scan_decisions` is
 * tenant-scoped by RLS, so reading it as the session returns only the viewer's HOME
 * tenant — which for a super_user homed to the platform tenant is nothing at all. The
 * Streamlit page carries a comment about exactly that bug ("the 'No signals captured
 * yet' bug, even though feedback logged under other tenants is exactly the labeled set
 * this developer-only view is meant to show"). The gate is above the read, not in it.
 *
 * APPROVING A SUGGESTION IS A JOB, not a route. `core/suggestions.approve` applies the
 * proposed diff to donor_intel or donor_sources through a per-resource column allow-list
 * and a slug key derived from the live table — 107 lines of rules about shared data that
 * a second implementation would get subtly wrong in a place nobody looks. The route
 * queues; the repo's own Python decides.
 */
import { q, type Db } from "./db.ts";
import { body, json, str } from "./http.ts";
import {
  isAdmin, isDeveloperAdmin, isDeveloperMember, isDeveloperSuper, isSuperUser,
  type PermUser,
} from "./permissions.ts";
import type { Ctx } from "./session.ts";

type Row = Record<string, unknown>;

/** The scan_decisions event types the Learning data cards count, in the page's order. */
export const SIGNAL_TYPES = [
  "system_reject", "human_decision", "feedback", "reject_verification",
] as const;

type Enqueue = (
  kind: string, params: Record<string, unknown>, ctx: Ctx,
) => Promise<{ id: string; dispatched: boolean } | null>;

export function createPlatformRoutes(db: Db, enqueue: Enqueue | null = null) {
  const dev = (ctx: Ctx) => ctx.homeIsDeveloper();

  const LOCKED = (what: string, who: string) => json({
    error: `${what} is a developer-account feature. ${who}`,
  }, 403);

  // ── Sources ────────────────────────────────────────────────────────────────

  /**
   * `GET /settings/sources` — the catalogue and the blocked tokens.
   *
   * The catalogue is readable by any developer-tenant member; the blocked tokens need an
   * admin, because they drop candidate URLs for every tenant's scan. Both gates are the
   * Streamlit page's own, and `canEdit` is resolved here so the page disables what the
   * route would refuse rather than discovering it on save.
   */
  async function sources(_req: Request, ctx: Ctx): Promise<Response> {
    const u = ctx.user as PermUser;
    const isDev = await dev(ctx);
    if (!isDeveloperMember(u, isDev)) {
      return LOCKED("The sources catalogue",
        "It is crawled by every tenant's scan, so it is managed from a developer tenant.");
    }
    const canEditCatalog = isDeveloperSuper(u, isDev);
    const canEditBlocked = isDeveloperAdmin(u, isDev);

    const [catalog, blocked] = await Promise.all([
      db.service.getAll("donor_sources", "select=*", "donor_name").catch(() => [] as Row[]),
      canEditBlocked
        ? db.service.getAll("scan_blacklist", "select=pattern,reason", "pattern")
          .catch(() => [] as Row[])
        : Promise.resolve([] as Row[]),
    ]);

    return json({
      catalog,
      blocked,
      canEditCatalog,
      canEditBlocked,
      // Said in the payload rather than assumed by the page: a non-super developer member
      // sees the catalogue read-only and proposes changes through the suggestion queue,
      // which is a different affordance, not a disabled button.
      note: canEditCatalog ? null
        : "Read-only. The catalogue is shared across all tenants, so direct edits are "
          + "limited to a developer-tenant Super User. Propose changes through the "
          + "suggestion queue instead.",
    });
  }

  /**
   * `PUT /settings/sources/blocked` — replace the blocked-token list.
   *
   * WHOLESALE, because the Streamlit control is a grid the admin edits and saves: rows
   * are added and removed there, so a patch-by-row API would not express "I deleted that
   * one". The list is small and entirely hand-written.
   *
   * Patterns are trimmed and de-duplicated case-insensitively, because they are MATCHED
   * case-insensitively — two spellings of one pattern are one rule that looks like two,
   * and removing the visible one would leave the other still rejecting URLs.
   */
  async function putBlocked(req: Request, ctx: Ctx): Promise<Response> {
    const u = ctx.user as PermUser;
    if (!isDeveloperAdmin(u, await dev(ctx))) {
      return LOCKED("Blocked tokens",
        "These patterns drop candidate URLs for every tenant's scan.");
    }
    const p = (await body(req)) as Row;
    const seen = new Set<string>();
    const rows: Row[] = [];
    for (const raw of (Array.isArray(p.rows) ? p.rows : [])) {
      if (!raw || typeof raw !== "object") continue;
      const pattern = str((raw as Row).pattern).trim();
      if (!pattern || seen.has(pattern.toLowerCase())) continue;
      seen.add(pattern.toLowerCase());
      rows.push({ pattern, reason: str((raw as Row).reason).trim() || null });
    }

    // Replace: delete what is gone, upsert the rest. Deleting everything first would
    // leave the scan unblocked for the width of the write — short, but every candidate
    // URL that arrives in it is one this list exists to reject.
    const current = await db.service.getAll("scan_blacklist", "select=pattern", "pattern")
      .catch(() => [] as Row[]);
    const keep = new Set(rows.map((r) => str(r.pattern)));
    const drop = current.map((r) => str(r.pattern)).filter((x) => !keep.has(x));
    if (rows.length) {
      await db.service.upsert("scan_blacklist", rows, "pattern");
    }
    for (const pattern of drop) {
      await db.service.delete("scan_blacklist", `pattern=eq.${q(pattern)}`)
        .catch(() => undefined);
    }
    return json({ rows, removed: drop.length });
  }

  /**
   * `GET /settings/sources/registry` — every host the scanner has met.
   *
   * The READ is here because it is a select; every WRITE is a job, because
   * `core/source_registry.py` owns a column whitelist, host normalisation from a URL,
   * an upsert keyed on host and — `push_primaries` — a dedupe-by-host upsert into the
   * catalogue every tenant's scan crawls. Four small rules scattered across two
   * languages is worse than four small rules in the module named after them.
   */
  async function registry(_req: Request, ctx: Ctx): Promise<Response> {
    const u = ctx.user as PermUser;
    const isDev = await dev(ctx);
    if (!isDeveloperMember(u, isDev)) {
      return LOCKED("The source registry",
        "It decides what every tenant's scan crawls, so it is managed from a developer "
        + "tenant.");
    }
    const rows = await db.service.getAll("source_registry", "select=*", "host")
      .catch(() => [] as Row[]);
    // Newest contact first, which is the order somebody reviewing a registry wants: the
    // hosts the scanner met most recently are the ones nobody has classified yet.
    rows.sort((a, b) => str(b.last_seen).localeCompare(str(a.last_seen)));
    return json({
      rows,
      canEdit: isDeveloperAdmin(u, isDev),
      counts: {
        total: rows.length,
        unclassified: rows.filter((r) => !str(r.classification).trim()).length,
        confirmed: rows.filter((r) => str(r.status).toLowerCase() === "confirmed").length,
        inCatalogue: rows.filter((r) => r.in_catalogue).length,
      },
      // The three classifications `push_primaries` cares about, and what it will accept:
      // it pushes ONLY a confirmed primary, which is the gate that keeps an unverified
      // aggregator out of every tenant's scan list.
      pushRule: "Only a host classified PRIMARY and marked CONFIRMED is pushed to the "
        + "catalogue. Anything else is skipped and named.",
    });
  }

  /** `POST /settings/sources/registry` — queue one registry write. */
  async function registryAction(req: Request, ctx: Ctx): Promise<Response> {
    const u = ctx.user as PermUser;
    if (!isDeveloperAdmin(u, await dev(ctx))) {
      return LOCKED("Editing the source registry",
        "It decides what every tenant's scan crawls.");
    }
    if (!enqueue) return json({ error: "Background jobs are not configured." }, 503);

    const p = (await body(req)) as Row;
    const action = str(p.action).trim();
    // Named here as well as in the runner: a request for an action this build does not
    // know should be refused where somebody can read the refusal, not queued and then
    // failed minutes later in a job row.
    if (!["update", "add", "classify", "delete", "push"].includes(action)) {
      return json({ error: `Unknown registry action "${action}".` }, 400);
    }
    const hosts = (Array.isArray(p.hosts) ? p.hosts : []).map((h) => str(h).trim())
      .filter(Boolean);
    if (["classify", "delete", "push"].includes(action) && !hosts.length) {
      return json({ error: "Pick at least one host first." }, 400);
    }

    const queued = await enqueue("registry_action", {
      action, hosts, host: str(p.host).trim(),
      classification: str(p.classification).trim(),
      status: str(p.status).trim() || "confirmed",
      fields: (p.fields && typeof p.fields === "object" && !Array.isArray(p.fields))
        ? p.fields : {},
      by: str(ctx.user?.email),
    }, ctx);
    if (!queued) return json({ error: "Could not queue that." }, 500);
    return json({
      job_id: queued.id,
      dispatched: queued.dispatched,
      detail: queued.dispatched
        ? "Queued. The registry's own rules decide what lands."
        : "Queued, but no runner could be reached — nothing has changed yet.",
    });
  }

  // ── Tenants and the blacklist ──────────────────────────────────────────────

  /**
   * `GET /settings/tenants` — the platform's organisation list.
   *
   * VISIBLE TO EVERY ADMIN, EDITABLE BY A SUPER_USER. That split is the Streamlit page's
   * own: knowing which organisations exist on a shared deployment is ordinary context,
   * while suspending one, flagging it as a developer tenant or letting its profile be
   * read to score somebody else's call is not.
   *
   * A NON-SUPER SEES ONLY THE ORGANISATIONS THEY BELONG TO. The Streamlit page scopes it
   * the same way, and the reason is not secrecy but relevance — a list of every
   * organisation on the deployment answers no question an ordinary admin has, and it
   * names other people's clients.
   */
  async function tenants(_req: Request, ctx: Ctx): Promise<Response> {
    const u = ctx.user as PermUser;
    if (!isAdmin(u)) return json({ error: "Organizations is for administrators." }, 403);
    const canManage = isSuperUser(u);

    const [rows, memberships] = await Promise.all([
      db.service.getAll("tenants", "select=*", "name").catch(() => [] as Row[]),
      db.service.getAll("tenant_memberships", "select=tenant_id,user_id,status", "tenant_id")
        .catch(() => [] as Row[]),
    ]);

    let visible = rows;
    if (!canManage) {
      const mine = new Set(memberships
        .filter((m) => str(m.user_id) === str(ctx.user?.id))
        .map((m) => str(m.tenant_id)));
      visible = rows.filter((r) => mine.has(str(r.id)));
    }

    const counts = new Map<string, { active: number; pending: number }>();
    for (const m of memberships) {
      const tid = str(m.tenant_id);
      const c = counts.get(tid) ?? { active: 0, pending: 0 };
      if (str(m.status) === "active") c.active += 1;
      else if (str(m.status) === "pending") c.pending += 1;
      counts.set(tid, c);
    }
    const byId = new Map(rows.map((r) => [str(r.id), r]));

    return json({
      tenants: visible.map((t) => ({
        id: str(t.id),
        name: str(t.name),
        slug: str(t.slug) || null,
        kind: str(t.kind) || "organization",
        status: str(t.status) || "active",
        is_platform: !!t.is_platform,
        is_developer: !!t.is_developer,
        share_for_consortium_scoring: !!t.share_for_consortium_scoring,
        parent_tenant_id: str(t.parent_tenant_id) || null,
        // Resolved here: the page would otherwise have to look it up in a list a
        // non-super cannot see all of, and would show a bare uuid for a parent outside
        // their own scope.
        parent_name: str(byId.get(str(t.parent_tenant_id))?.name) || null,
        blacklisted_at: t.blacklisted_at ?? null,
        blacklisted_by: str(t.blacklisted_by) || null,
        blacklist_reason: str(t.blacklist_reason) || null,
        created_at: t.created_at ?? null,
        members: counts.get(str(t.id))?.active ?? 0,
        pending: counts.get(str(t.id))?.pending ?? 0,
      })),
      canManage,
      note: canManage ? null
        : "Read-only. Suspending an organisation, flagging it as a developer tenant or "
          + "opting it into consortium sharing affects the whole deployment, so it is a "
          + "super-user action. This lists the organisations you belong to.",
    });
  }

  /** `POST /settings/tenants` — queue one write to the organisation list. */
  async function tenantAction(req: Request, ctx: Ctx): Promise<Response> {
    if (!isSuperUser(ctx.user as PermUser)) {
      return json({
        error: "Changing an organization's status is a super-user action.",
      }, 403);
    }
    if (!enqueue) return json({ error: "Background jobs are not configured." }, 503);

    const p = (await body(req)) as Row;
    const action = str(p.action).trim();
    const known = ["activate", "suspend", "blacklist", "developer", "consortium", "parent"];
    if (!known.includes(action)) {
      return json({ error: `Unknown organization action "${action}".` }, 400);
    }
    const tenantIds = (Array.isArray(p.tenant_ids) ? p.tenant_ids : [])
      .map((t) => str(t).trim()).filter(Boolean);
    if (action !== "parent" && !tenantIds.length) {
      return json({ error: "Pick at least one organization first." }, 400);
    }
    // A tenant cannot be its own parent. The database has a cycle-guard that catches the
    // longer loops, and it is right that it does — but a self-link is worth refusing
    // where somebody can read why, rather than as a constraint violation in a job row.
    if (action === "parent" && str(p.child_id) && str(p.child_id) === str(p.parent_id)) {
      return json({ error: "An organization cannot be its own parent." }, 400);
    }

    const queued = await enqueue("tenant_action", {
      action, tenant_ids: tenantIds, on: p.on === true,
      child_id: str(p.child_id).trim(), parent_id: str(p.parent_id).trim(),
      by: str(ctx.user?.email),
    }, ctx);
    if (!queued) return json({ error: "Could not queue that." }, 500);
    return json({
      job_id: queued.id,
      dispatched: queued.dispatched,
      detail: queued.dispatched
        ? "Queued. The change applies once the runner picks it up."
        : "Queued, but no runner could be reached — nothing has changed yet.",
    });
  }

  // ── Learning data ──────────────────────────────────────────────────────────

  /**
   * `GET /settings/learning` — the captured training signals.
   *
   * COUNTS COME FROM count=exact, NOT from the fetched window. PostgREST caps a fetch at
   * 1000 rows, so a recent scan flooding the window with fresh system_reject rows would
   * push older feedback and human decisions out of it — and counting over the window
   * would report those signals as gone when only the window is capped. The Streamlit
   * page learnt this and says so; the same rule applies here.
   */
  async function learning(_req: Request, ctx: Ctx): Promise<Response> {
    if (!isDeveloperMember(ctx.user as PermUser, await dev(ctx))) {
      return LOCKED("Learning data",
        "These captured signals train the shared scoring model across all tenants.");
    }
    const counts: Record<string, number> = {};
    const [total, ...byType] = await Promise.all([
      db.service.count("scan_decisions", "").catch(() => 0),
      ...SIGNAL_TYPES.map((t) =>
        db.service.count("scan_decisions", `event_type=eq.${q(t)}`).catch(() => 0)),
    ]);
    SIGNAL_TYPES.forEach((t, i) => { counts[t] = Number(byType[i] ?? 0); });

    // The reason histogram over EVERY system_reject row, label only — the same paginated
    // read the Python does, for the same reason the counts are exact.
    const labels = await db.service.getAll(
      "scan_decisions", `select=label&event_type=eq.${q("system_reject")}`, "label")
      .catch(() => [] as Row[]);
    const reasons: Record<string, number> = {};
    for (const r of labels) {
      const k = str(r.label) || "—";
      reasons[k] = (reasons[k] ?? 0) + 1;
    }

    // The display window: newest first, capped, and the cap is STATED so a reader does
    // not take the list for the whole set.
    const recent = await db.service.get(
      "scan_decisions", "select=*&order=created_at.desc&limit=200").catch(() => [] as Row[]);

    return json({
      total: Number(total ?? 0),
      counts,
      reasons,
      recent,
      windowSize: recent.length,
      note: "Every scan reject, human decision and thumbs up/down is logged here — the "
        + "labelled training set behind the scoring model. The counts are exact over the "
        + "whole table; the list below is the most recent 200.",
    });
  }

  // ── Suggestions ────────────────────────────────────────────────────────────

  /** `GET /settings/suggestions` — the pending review queue, across all tenants. */
  async function suggestions(_req: Request, ctx: Ctx): Promise<Response> {
    if (!isDeveloperSuper(ctx.user as PermUser, await dev(ctx))) {
      // Not a 403 with an explanation that reveals the queue exists for others: the
      // Python returns an EMPTY LIST for a non-developer, and an empty inbox is the
      // honest answer for somebody with nothing to review.
      return json({ pending: [], canReview: false, count: 0 });
    }
    const pending = await db.service.get("resource_suggestions",
      `select=*&status=eq.${q("pending")}&order=created_at.desc`).catch(() => [] as Row[]);
    return json({ pending, canReview: true, count: pending.length });
  }

  /**
   * `POST /settings/suggestions/:id/approve` and `/reject` — queued, never applied here.
   *
   * `core.suggestions.approve` resolves the target, intersects the proposed diff with a
   * per-resource column allow-list, derives a slug key from the live table and writes to
   * donor_intel or donor_sources. Re-implementing that in TypeScript would put a second
   * set of rules about shared, cross-tenant data where the first one cannot see it.
   */
  async function review(req: Request, ctx: Ctx, id: string, decision: "approve" | "reject"):
    Promise<Response> {
    if (!isDeveloperSuper(ctx.user as PermUser, await dev(ctx))) {
      return LOCKED("Reviewing suggestions",
        "The queue proposes changes to resources every tenant shares.");
    }
    if (!enqueue) return json({ error: "Background jobs are not configured." }, 503);
    const p = (await body(req).catch(() => ({}))) as Row;
    const queued = await enqueue("suggestion_review", {
      suggestion_id: id, decision, note: str(p.note).trim() || null,
      by: str(ctx.user.email),
    }, ctx);
    if (!queued) return json({ error: "Could not queue the review." }, 500);
    return json({
      job_id: queued.id,
      dispatched: queued.dispatched,
      // Said plainly when it is not dispatched: the row is queued and nothing has been
      // applied, which is a different state from "done" and from "failed".
      detail: queued.dispatched
        ? "Queued. The change is applied by the runner, which holds the rules about the "
          + "shared catalogue."
        : "Queued, but no runner could be reached — nothing has been applied yet.",
    });
  }

  return {
    sources, putBlocked, registry, registryAction, tenants, tenantAction,
    learning, suggestions, review,
  };
}
