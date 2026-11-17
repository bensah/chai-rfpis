/**
 * Settings → Accounts → Users — the routes. `views/account_sections.render_manage_users`.
 *
 * WHO MAY: admin and above to reach the surface at all, and then `canManageUser` per
 * TARGET on every write. The two are different questions and both are asked: an admin
 * reaching the page says nothing about whether this particular account is theirs to edit.
 *
 * EVERY GATE IS ENFORCED HERE, not inherited from a disabled control. The Streamlit page
 * greys out role and active on a self-edit and filters the override dropdown by the
 * actor's own ceiling; neither of those travels with an HTTP request. users_admin.ts
 * holds the rules and check-users-admin pins them against the Python.
 *
 * WHAT IS PORTED AND WHAT IS NOT, stated rather than discovered:
 *
 *   list · edit profile · edit role and active · edit per-surface overrides · reset a
 *   password (email a one-time link)                                        — here
 *
 *   ADD a user, BULK add, DELETE                                            — not here
 *
 * Adding is not a smaller version of editing. `_create_user_account` writes the users
 * row, creates or joins a tenant, mints an invite token and sends a welcome email — and
 * the mailer ported so far has `sendPasswordReset` and nothing else, so a React invite
 * would create an account whose holder is never told. That is worse than no button. The
 * page says so and points at the classic page, which still works and writes the same
 * rows.
 *
 * THE RESET DOES NOT CHANGE THE PASSWORD, deliberately, and the Python's comment is worth
 * repeating because the opposite looks more secure: overwriting the password here locks
 * the user out the moment an admin clicks, before the email has arrived, and if the mail
 * bounces they are stranded. The existing password keeps working until the link is used.
 */
import { q, type Db } from "./db.ts";
import { body, json, str } from "./http.ts";
import { isAdmin, type PermUser } from "./permissions.ts";
import type { Ctx } from "./session.ts";
import type { Mailer } from "./email.ts";
import {
  accountStatus, editPatch, editProblems, editRights, overridesFor, roleAllowed,
  tenantLabels, visibleUsers,
} from "./users_admin.ts";

type Row = Record<string, unknown>;

/** The columns the roster needs. `password_hash` is not among them and never will be. */
const USER_COLUMNS = "id,email,name,role,is_active,is_blacklisted,must_change_password,"
  + "access_overrides,department,program,job_title,phone,last_login_at,"
  + "password_changed_at,created_at";

type IssueToken = (
  userId: string, purpose: "reset" | "invite", createdBy: string,
) => Promise<{ token: string; code: string }>;

export function createUserRoutes(
  db: Db, issueToken: IssueToken, mailer: Mailer | null, allowedOrigins: string[] = [],
) {
  const BLOCKED = () => json({ error: "Managing users is for administrators." }, 403);

  /** The tenant whose people belong on screen — the one being VIEWED. */
  const viewedTid = (ctx: Ctx): string | null => {
    const tid = db.scopeTid(ctx.scope);
    return /^0{8}-/.test(tid) ? null : tid;
  };

  /** Everybody this actor may see, with their tenant labels resolved. */
  async function roster(ctx: Ctx): Promise<{ rows: Row[]; labels: Record<string, string> }> {
    const actor = ctx.user as PermUser;
    const [all, memberships] = await Promise.all([
      db.service.getAll("users", `select=${USER_COLUMNS}`, "email"),
      db.service.getAll("tenant_memberships", "select=user_id,status,tenants(name)", "user_id")
        .catch(() => [] as Row[]),
    ]);
    // Members of the tenant on screen, for a non-super. `isSuperUser` answers FALSE while
    // a super views another tenant — they are gated as that tenant's admin — so this is
    // the branch that runs then, and the viewed id is what it must scope to. Scoping to
    // the session tenant would list the super's own colleagues under somebody else's name.
    let memberIds: Set<string> | null = null;
    const tid = viewedTid(ctx);
    if (tid) {
      const scoped = await db.service.get(
        "tenant_memberships", `select=user_id&tenant_id=eq.${q(tid)}`).catch(() => [] as Row[]);
      memberIds = new Set(scoped.map((m) => str(m.user_id)));
    }
    return { rows: visibleUsers(all, actor, memberIds), labels: tenantLabels(memberships) };
  }

  /** `GET /settings/users` — the roster, with each account's rights already resolved. */
  async function list(_req: Request, ctx: Ctx): Promise<Response> {
    const actor = ctx.user as PermUser;
    if (!isAdmin(actor)) return BLOCKED();
    const { rows, labels } = await roster(ctx);
    return json({
      users: rows.map((u) => ({
        id: str(u.id),
        email: str(u.email),
        name: str(u.name) || null,
        role: str(u.role),
        is_active: !!u.is_active,
        must_change_password: !!u.must_change_password,
        department: str(u.department) || null,
        program: str(u.program) || null,
        job_title: str(u.job_title) || null,
        phone: str(u.phone) || null,
        last_login_at: u.last_login_at ?? null,
        password_changed_at: u.password_changed_at ?? null,
        created_at: u.created_at ?? null,
        access_overrides: u.access_overrides ?? {},
        tenant: labels[str(u.id)] ?? null,
        // RESOLVED SERVER-SIDE. The page could compute this from the role, and then two
        // implementations of a permission rule would exist — one of them in a browser,
        // where it decides only what is drawn. These are the same answers the write
        // routes enforce, which is the point.
        status: accountStatus(u.is_active, u.must_change_password, u.last_login_at),
        rights: editRights(actor, u as PermUser),
      })),
      // What the actor may assign, so the page offers nothing the route would refuse.
      canAdd: false,
      addNote: "Adding and removing accounts is still on the classic Settings page: an "
        + "invitation needs the welcome email, which this API does not send yet. Creating "
        + "an account whose holder is never told is worse than no button.",
    });
  }

  /** `PATCH /settings/users/:id` — profile, role, active and the per-surface overrides. */
  async function patch(req: Request, ctx: Ctx, id: string): Promise<Response> {
    const actor = ctx.user as PermUser;
    if (!isAdmin(actor)) return BLOCKED();

    const rows = await db.service.get("users", `select=${USER_COLUMNS}&id=eq.${q(id)}&limit=1`);
    const target = rows[0];
    if (!target) return json({ error: "No such user." }, 404);

    const rights = editRights(actor, target as PermUser);
    if (!rights.profile) {
      return json({ error: "That account is outside your management scope." }, 403);
    }

    const form = (await body(req)) as Row;

    // The roster the collision test runs against is the one the ACTOR can see, which is
    // also the one the Streamlit page compares with. An address held by an account
    // outside the actor's scope is caught by the database's own unique index instead.
    const { rows: visible } = await roster(ctx);
    const problems = editProblems(form, str(target.email),
      visible.filter((u) => str(u.id) !== id).map((u) => str(u.email)));
    if (problems.length) {
      return json({ error: "Please fix the following:", problems }, 400);
    }

    // A role the actor could not assign is REFUSED rather than dropped: unlike a locked
    // field on a self-edit, this is not something the dialog disabled — it is a value
    // outside the actor's authority, and silently saving the rest would report success
    // for a change that did not happen.
    if (rights.role && "role" in form
        && !roleAllowed(actor, form.role, target.role)) {
      return json({ error: `You cannot assign the role "${str(form.role)}".` }, 403);
    }

    const update = editPatch(form, rights);
    if (rights.overrides && form.access_overrides !== undefined) {
      const { overrides, refused } = overridesFor(
        actor, form.access_overrides, target.access_overrides);
      if (refused.length) {
        return json({
          error: "You can't grant access beyond your own on: " + refused.join(", "),
          problems: refused,
        }, 403);
      }
      update.access_overrides = overrides;
    }
    if (!Object.keys(update).length) return json({ error: "Nothing to change." }, 400);

    const wasInactive = !target.is_active;
    try {
      await db.service.update("users", `id=eq.${q(id)}`, update);
    } catch (e) {
      const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
      // The Python's own fallback: `users.access_overrides` arrived in migration 017, and
      // a deployment without it must still be able to save a name and a role. Saying so
      // beats a 500 that reads as "nothing saved" when everything else would have been.
      if ("access_overrides" in update
          && (m.includes("access_overrides") || m.includes("pgrst204"))) {
        delete update.access_overrides;
        await db.service.update("users", `id=eq.${q(id)}`, update);
        return json({
          saved: true,
          warnings: [{
            code: "overrides_not_persisted",
            detail: "Profile and role saved, but the per-surface overrides were not: the "
              + "users.access_overrides column is missing. Apply migration 017 to enable "
              + "them.",
          }],
        });
      }
      return json({ error: `Save failed: ${e instanceof Error ? e.message : e}` }, 500);
    }

    const warnings: { code: string; detail: string }[] = [];
    // Reactivating an account is news to its holder. Best-effort, exactly as the Python
    // has it — a mail failure must not undo a save that already landed.
    if (wasInactive && update.is_active === true) {
      warnings.push({
        code: "approval_email_not_sent",
        detail: "The account is active again. The “account approved” email is "
          + "not sent from here yet, so tell them yourself.",
      });
    }
    return json({ saved: true, warnings });
  }

  /**
   * `POST /settings/users/:id/reset` — email a one-time link.
   *
   * Three writes and an email, in the Python's order and for its reasons: flag the
   * account, retire any pending reset REQUEST so the queue does not keep asking, mint the
   * token, then send. The link is built before the send so a mail failure still leaves
   * something to hand over out of band — there is no temporary password to fall back on,
   * because this flow does not produce one.
   */
  async function resetPassword(req: Request, ctx: Ctx, id: string): Promise<Response> {
    const actor = ctx.user as PermUser;
    if (!isAdmin(actor)) return BLOCKED();

    const rows = await db.service.get("users",
      `select=id,email,name,role,is_active,is_blacklisted&id=eq.${q(id)}&limit=1`);
    const target = rows[0];
    if (!target) return json({ error: "No such user." }, 404);
    if (!editRights(actor, target as PermUser).reset) {
      return json({
        error: "You can't reset that account's password"
          + (str(target.email).toLowerCase() === str(actor.email).toLowerCase()
            ? " — use Profile → Change password for your own." : "."),
      }, 403);
    }

    await db.service.update("users", `id=eq.${q(id)}`, { must_change_password: true });
    await db.service.update("password_reset_requests",
      `email=eq.${q(str(target.email))}&status=eq.pending`,
      { status: "handled", handled_by: str(actor.email), handled_at: new Date().toISOString() })
      .catch(() => undefined);

    const { token, code } = await issueToken(id, "reset", str(actor.email));
    let sent = false;
    if (mailer?.configured()) {
      sent = await mailer.sendPasswordReset({
        toEmail: str(target.email), toName: str(target.name) || null, token, code,
        origin: req.headers.get("origin"), allowedOrigins,
      }).catch(() => false);
    }
    return json({
      // The CODE, never the token. The code is the short form a person can read down a
      // phone, which is the whole point of handing one back when the mail did not go; the
      // 43-character token is the credential itself and has no business in a page.
      sent,
      code: sent ? null : code,
      detail: sent
        ? `A one-time link is on its way to ${str(target.email)}. It works once and `
          + "expires in 2 hours; their current password keeps working until they use it."
        : "The link was created but no email was sent — this deployment has no mailer "
          + "configured. Give them the code below; it expires in 2 hours.",
    });
  }

  return { list, patch, resetPassword };
}
