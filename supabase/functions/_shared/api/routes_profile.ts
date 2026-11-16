/**
 * Profile — the routes. `app_pages/profile.py` + `views/account_sections.py`.
 *
 * FOUR ROUTES, ALL SELF-SCOPED. Not one of them takes a user id from the request: every
 * read and write is keyed on `ctx.session.sub`, so there is no shape of request that
 * reaches somebody else's row. That is the entire security model of a self-service page,
 * and it is worth stating because the obvious alternative — accepting an id and checking
 * it matches — is one forgotten check away from an account-takeover endpoint.
 *
 * THE SERVICE ROLE, DELIBERATELY. `views/account_sections.py` carries the reason as a
 * comment and it is a trap rather than a shortcut: the tenant-scoped `authenticated`
 * client can READ `users` but its UPDATE is silently blocked by RLS — zero rows, no
 * error. A profile save would look saved and change nothing; a password change would
 * no-op while the old password still worked. Both writes therefore use `db.service`,
 * scoped by the session's own id, and both check that a row came back.
 */
import { q, type Db } from "./db.ts";
import { body, json, str } from "./http.ts";
import {
  buildPatch, day, emailChanged, LOGIN_COLUMNS, LOGIN_LIMIT, parseUserAgent,
  PROFILE_COLUMNS, validate, type ProfilePayload,
} from "./profile.ts";
import { passwordProblems, PASSWORD_RULES_TEXT } from "./permissions.ts";
import type { Ctx } from "./session.ts";

type Deps = {
  bcryptCompare: (plain: string, hash: string) => Promise<boolean>;
  bcryptHash: (plain: string) => Promise<string>;
};

const nowIso = () => new Date().toISOString();

export function createProfileRoutes(db: Db, deps: Deps) {
  const myId = (ctx: Ctx) => str(ctx.session.sub);

  /** The signed-in user's own row, re-read rather than taken from the session. */
  async function self(ctx: Ctx): Promise<Record<string, unknown> | null> {
    const rows = await db.service.get(
      "users", `select=${PROFILE_COLUMNS}&id=eq.${q(myId(ctx))}&limit=1`);
    return rows[0] ?? null;
  }

  /**
   * `GET /profile` — the row and the recent sign-ins.
   *
   * The row is RE-READ rather than served from the session, for the Python's stated
   * reason: an admin may have changed the role out of band, and a form populated from a
   * stale session would show it wrong until a hard refresh.
   */
  async function read(_req: Request, ctx: Ctx): Promise<Response> {
    const me = await self(ctx);
    if (!me) return json({ error: "Your account could not be read." }, 404);

    // Best-effort, exactly as the panel is. `login_logs` arrived in migration 084 and a
    // deployment that has not applied it should show a profile page, not an error.
    const logs = await db.service.get(
      "login_logs",
      `select=${LOGIN_COLUMNS}&user_id=eq.${q(myId(ctx))}&order=at.desc&limit=${LOGIN_LIMIT}`,
    ).catch(() => [] as Record<string, unknown>[]);

    return json({
      profile: me,
      metrics: {
        created: day(me.created_at),
        lastLogin: day(me.last_login_at),
        passwordSet: day(me.password_changed_at),
      },
      logins: logs.map((r) => ({
        at: str(r.at), device: parseUserAgent(r.user_agent), ip: str(r.ip) || "—",
      })),
      passwordRules: PASSWORD_RULES_TEXT,
      /** Whether deleting this account would leave nobody able to administer the app. */
      soleSuperUser: await soleSuper(ctx),
    });
  }

  /**
   * Would deleting this account remove the last super_user?
   *
   * The ACCOUNT role decides, not the effective one — this guards deleting YOUR OWN
   * account, so what matters is whether that account is the last administrator, not which
   * tenant happens to be on screen.
   *
   * FAILS OPEN on a count error, as the Python does, and that is the right way round for
   * this particular check: a transient failure must not permanently wedge somebody out of
   * deleting their own account. The route re-checks before it deletes, so a false "no" here
   * costs a wasted click rather than a lockout.
   */
  async function soleSuper(ctx: Ctx): Promise<boolean> {
    if (str(ctx.user.role) !== "super_user") return false;
    try {
      const n = await db.service.count("users", `role=eq.${q("super_user")}`);
      return n <= 1;
    } catch {
      return false;
    }
  }

  /** `PATCH /profile` — the ten self-editable columns. */
  async function patch(req: Request, ctx: Ctx): Promise<Response> {
    const me = await self(ctx);
    if (!me) return json({ error: "Your account could not be read." }, 404);
    const p = (await body(req)) as ProfilePayload;
    const fields = buildPatch(p);
    if (!Object.keys(fields).length) return json({ error: "Nothing to change." }, 400);

    // Only when the address actually changes, and case-insensitively on both sides —
    // the login lookup is case-insensitive too, so "Ben@x.org" slipping past a check that
    // "ben@x.org" exists would create an account that collides at sign-in.
    const next = str(fields.email ?? me.email);
    let taken = false;
    if ("email" in fields && emailChanged(next, me.email)) {
      const hit = await db.service.get(
        "users", `select=id&email=ilike.${q(next)}&limit=1`).catch(() => []);
      taken = hit.length > 0;
    }
    const errs = validate(next, me.email, taken);
    if (errs.length) return json({ error: "Please fix:", problems: errs }, 400);

    const saved = await db.service.update("users", `id=eq.${q(myId(ctx))}`, fields);
    if (!saved.length) {
      return json({
        error: "Save didn't update your record (no matching row). Please retry, or "
          + "contact an admin if it persists.",
      }, 500);
    }

    const changed = "email" in fields && emailChanged(next, me.email);
    return json({
      profile: saved[0],
      emailChanged: changed,
      // SAID, NOT DONE. Changing the login username does not end the session: the
      // Streamlit app's cookie runs its ~8 hours and so does this token, which is the
      // behaviour being ported. What must not happen is the page staying silent about it
      // and the person finding out at the next sign-in.
      notice: changed
        ? `Your login email is now ${next} — use it to sign in next session.`
        : null,
    });
  }

  /**
   * `POST /profile/password` — change it, with the current one as proof.
   *
   * The same four checks `render_change_password` makes, in its order. Deliberately NOT
   * re-issuing the session: this is a signed-in user changing their own password, not the
   * forced-change gate clearing, and ending their session as a reward for good security
   * hygiene is a worse experience than leaving the token to expire.
   */
  async function password(req: Request, ctx: Ctx): Promise<Response> {
    const b = await body(req);
    const current = str(b.current), next = str(b.password), confirm = str(b.confirm);
    const rows = await db.service.get(
      "users", `select=password_hash&id=eq.${q(myId(ctx))}&limit=1`);
    const stored = str(rows[0]?.password_hash);

    const errs: string[] = [];
    let ok = false;
    try {
      ok = !!current && !!stored && await deps.bcryptCompare(current, stored);
    } catch {
      ok = false;
    }
    if (!ok) errs.push("Current password is incorrect.");
    errs.push(...passwordProblems(next));
    if (next !== confirm) errs.push("The two passwords do not match.");
    if (next && next === current) errs.push("New password must be different from current.");
    if (errs.length) return json({ error: "Please fix:", problems: errs }, 400);

    const saved = await db.service.update("users", `id=eq.${q(myId(ctx))}`, {
      password_hash: await deps.bcryptHash(next),
      password_changed_at: nowIso(),
      must_change_password: false,
    });
    if (!saved.length) {
      return json({
        error: "Password change didn't take — no matching record. Please retry, or "
          + "contact an admin.",
      }, 500);
    }
    return json({ ok: true });
  }

  /**
   * `DELETE /profile` — self-service account deletion.
   *
   * IRREVERSIBLE, so it takes the account's own email in the body as confirmation, the
   * way the Streamlit dialog makes you type it. A DELETE with no payload is one stray
   * request away from an account nobody meant to remove.
   *
   * THE SOLE-SUPER-USER GUARD IS ENFORCED HERE, which is the one place this port is
   * stricter than the page it copies. Streamlit computes the same condition and then only
   * hides the button — so the check lives entirely in the client, and anything that is not
   * the UI skips it. Deleting the last super_user locks every remaining person out of
   * administering the app, which is not a state a wrong click should be able to reach.
   *
   * MEMBERSHIPS GO FIRST, then the row. The Python's order, and the reason is orphan rows:
   * `tenant_memberships.user_id` would otherwise point at an account that no longer
   * exists. The FK is `on delete cascade` for `login_logs` but memberships are deleted
   * explicitly, so the order is load-bearing rather than cosmetic.
   *
   * What is NOT deleted: everything the person contributed. Meeting notes, engagements and
   * submitted opportunities stay, for the institutional memory the page promises — only
   * the ability to sign in is removed.
   */
  async function remove(req: Request, ctx: Ctx): Promise<Response> {
    const me = await self(ctx);
    if (!me) return json({ error: "Your account could not be read." }, 404);
    const b = await body(req);
    if (str(b.confirmEmail).trim().toLowerCase() !== str(me.email).trim().toLowerCase()) {
      return json({ error: "Type your own email address to confirm." }, 400);
    }
    if (await soleSuper(ctx)) {
      return json({
        error: "You're the only Super User — deleting your account would lock everyone "
          + "out of platform administration. Promote another Super User first "
          + "(Settings → Accounts → Users).",
      }, 409);
    }

    // Best-effort, as the Python has it: a membership row that will not delete must not
    // leave the account itself standing after the person asked for it to go.
    await db.service.delete("tenant_memberships", `user_id=eq.${q(myId(ctx))}`)
      .catch(() => []);
    const gone = await db.service.delete("users", `id=eq.${q(myId(ctx))}`);
    if (!gone.length) {
      return json({ error: "Delete failed — no matching account row." }, 500);
    }
    // No session to revoke: `sessions.require` re-reads the account row on every
    // request, so the token stops resolving the moment the row is gone.
    return json({ ok: true });
  }

  return { read, patch, password, remove };
}
