/**
 * Sign-in and account flows — ports of auth/authenticator.py, core/password_tokens.py and
 * the session parts of auth/tenant_context.py. Messages are the Streamlit app's wording.
 */
import { q, type Db } from "./db.ts";
import { body, HttpError, json, str } from "./http.ts";
import { sha256Hex, type Json } from "./jwt.ts";
import { isSuperUser, passwordProblems, PASSWORD_RULES_TEXT } from "./permissions.ts";
import { publicUser, USER_COLUMNS, type Ctx, type Session, type Sessions } from "./session.ts";
import type { Tenants } from "./tenants.ts";

export type AuthDeps = {
  bcryptCompare: (plain: string, hash: string) => Promise<boolean>;
  bcryptHash: (plain: string) => Promise<string>;   // cost 12, as bcrypt.gensalt()
};

// A real bcrypt hash (cost 12) of a random string, compared against when the email is
// unknown, so "no such user" and "wrong password" take the same time.
const DUMMY_HASH = "$2b$12$viRKiPpRBNOUFb16VqLUQ.AnuulKgZ5a1NrWOgL0gMJN7waTNQ9cq";

const INVALID_LINK = "Setup and reset links can only be used once, and they expire. " +
  "Ask an administrator to send you a new one.";

export function createAuthRoutes(db: Db, tenants: Tenants, sessions: Sessions, deps: AuthDeps) {
  const nowIso = () => new Date().toISOString();

  /** authenticator._client_ip_ua: first X-Forwarded-For hop, else X-Real-IP. */
  function ipUa(req: Request): [string | null, string | null] {
    const ip = (req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "")
      .split(",")[0].trim() || null;
    return [ip, req.headers.get("user-agent") || null];
  }

  /** authenticator._record_login — best-effort, never blocks a sign-in. */
  async function recordLogin(req: Request, user: Json) {
    const at = nowIso();
    const [ip, ua] = ipUa(req);
    await Promise.allSettled([
      db.service.update("users", `id=eq.${q(String(user.id))}`, { last_login_at: at }),
      db.service.insert("login_logs", { user_id: user.id, email: user.email, at, ip, user_agent: ua },
        "return=minimal"),
    ]);
  }

  async function login(req: Request): Promise<Response> {
    const b = await body(req);
    const email = str(b.email).trim();
    const password = str(b.password);
    if (!email || !password) return json({ error: "Enter your email and password." }, 400);

    const rows = await db.service.get("users",
      `select=${USER_COLUMNS},password_hash&email=eq.${q(email)}&limit=1`);
    const user = rows[0] ?? null;
    const hash = typeof user?.password_hash === "string" && user.password_hash ? user.password_hash : DUMMY_HASH;
    const ok = await deps.bcryptCompare(password, hash);
    // Streamlit's credential list (_load_credentials) holds ACTIVE accounts only, so an
    // inactive account gets the same answer as a wrong password.
    if (!user || !ok || hash === DUMMY_HASH || !user.is_active) {
      return json({ error: "Username or password is incorrect." }, 401);
    }
    delete user.password_hash;
    if (user.is_blacklisted) {
      return json({ error: "This account has been blocked. Contact an administrator." }, 403);
    }
    await recordLogin(req, user);

    if (user.must_change_password) {
      // _gate_must_change_password: the only thing this session may do is choose a password.
      const s = sessions.sessionFor(user, null, "change-password");
      const t = await sessions.issue(s);
      return json({ ...t, mustChangePassword: true, user: publicUser(s, user) });
    }
    return json(await appSession(user));
  }

  async function appSession(user: Json) {
    const mems = await tenants.activeMemberships(String(user.id));
    const chosen = await tenants.defaultMembership(user, mems);
    const s = sessions.sessionFor(user, chosen, "app");
    const t = await sessions.issue(s);
    return { ...t, user: publicUser(s, user, { memberships: membershipList(user, mems),
      homeIsDeveloper: await isDeveloperTenant(s.tenant?.id) }) };
  }

  /** Whether the session's HOME tenant is a developer tenant (the second permission axis). */
  async function isDeveloperTenant(tenantId: string | undefined): Promise<boolean> {
    return !!tenantId && (await tenants.developerTenantIds()).includes(tenantId);
  }

  function membershipList(user: Json, mems: Awaited<ReturnType<Tenants["activeMemberships"]>>) {
    // The non-super tenant switcher (Settings → Accounts → Active tenant) lists these.
    if (isSuperUser({ role: user.role as string })) return [];
    return [...mems]
      .sort((a, b) => (a.name ?? "").toLowerCase().localeCompare((b.name ?? "").toLowerCase()))
      .map((m) => ({ id: m.tenant_id, name: m.name, slug: m.slug, role: m.role }));
  }

  async function me(ctx: Ctx): Promise<Response> {
    const mems = await tenants.activeMemberships(ctx.session.sub);
    return json({
      user: publicUser(ctx.session, ctx.user, {
        memberships: membershipList(ctx.user, mems),
        homeIsDeveloper: await ctx.homeIsDeveloper(),
      }),
    });
  }

  /** The forced change (`_gate_must_change_password`). Accepts the restricted token only. */
  async function forcedChange(req: Request): Promise<Response> {
    const ctx = await sessions.require(req, "change-password");
    const b = await body(req);
    const current = str(b.current), next = str(b.password), confirm = str(b.confirm);
    const rows = await db.service.get("users", `select=password_hash&id=eq.${q(ctx.session.sub)}&limit=1`);
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
    if (next && next === current) errs.push("New password must be different from the temporary one.");
    if (errs.length) return json({ error: "Please fix:", problems: errs }, 400);

    const saved = await db.service.update("users", `id=eq.${q(ctx.session.sub)}`, {
      password_hash: await deps.bcryptHash(next),
      must_change_password: false,
      password_changed_at: nowIso(),
    });
    if (!saved.length) {
      return json({ error: "Couldn't save the new password — no matching account row was updated " +
        "(the database may have rejected the write). Contact an administrator." }, 500);
    }
    // The gate clears and the page they were going to loads: a full session now.
    const user = await sessions.fetchUserById(ctx.session.sub);
    if (!user) throw new HttpError(401, "Your session has ended. Sign in again.");
    return json(await appSession(user));
  }

  /** password_tokens.peek_token: unknown, used and expired are one answer. */
  async function peek(raw: string): Promise<(Json & { user: Json }) | null> {
    if (!raw) return null;
    const rows = await db.service.get("user_password_tokens",
      `select=id,user_id,purpose,expires_at,used_at&token_hash=eq.${await sha256Hex(raw)}&limit=1`);
    const row = rows[0];
    if (!row || row.used_at) return null;
    const exp = Date.parse(String(row.expires_at));
    if (!Number.isFinite(exp) || exp <= Date.now()) return null;
    const users = await db.service.get("users", `select=id,email,name,is_active&id=eq.${q(String(row.user_id))}&limit=1`);
    if (!users.length) return null;
    return { ...row, user: users[0] };
  }

  async function tokenPeek(req: Request): Promise<Response> {
    const rec = await peek(str((await body(req)).token).trim());
    if (!rec) return json({ valid: false, error: INVALID_LINK });
    return json({ valid: true, purpose: rec.purpose === "invite" ? "invite" : "reset",
      email: str(rec.user.email), rules: PASSWORD_RULES_TEXT });
  }

  /** handle_setup_token's save: burn the token BEFORE writing the password. */
  async function tokenRedeem(req: Request): Promise<Response> {
    const b = await body(req);
    const raw = str(b.token).trim(), next = str(b.password), confirm = str(b.confirm);
    const rec = await peek(raw);
    if (!rec) return json({ error: INVALID_LINK, invalid: true }, 400);
    const errs = passwordProblems(next);
    if (next !== confirm) errs.push("The two passwords do not match.");
    if (errs.length) return json({ error: "Please fix:", problems: errs }, 400);

    // consume_token: conditional on used_at is null, so two tabs cannot both succeed.
    const burned = await db.service.update("user_password_tokens",
      `id=eq.${q(String(rec.id))}&used_at=is.null`, { used_at: nowIso() });
    if (!burned.length) {
      return json({ error: "This link was just used somewhere else. Ask an administrator for a new one.",
        invalid: true }, 409);
    }
    const uid = String(rec.user.id);
    let saved: Json[] = [];
    let err = "";
    try {
      saved = await db.service.update("users", `id=eq.${q(uid)}`, {
        password_hash: await deps.bcryptHash(next),
        must_change_password: false,
        password_changed_at: nowIso(),
      });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    if (err || !saved.length) {
      return json({ error: `Could not save the password: ${err ? "the database rejected the write" :
        "no account row was updated"}. Ask an administrator for a new link.` }, 500);
    }
    // invalidate_tokens_for_user: no other link for this account stays live.
    await db.service.update("user_password_tokens", `user_id=eq.${q(uid)}&used_at=is.null`,
      { used_at: nowIso() }).catch(() => undefined);
    return json({ ok: true, email: str(rec.user.email), purpose: rec.purpose === "invite" ? "invite" : "reset" });
  }

  /** password_reset_request_form: recorded either way, same answer for any address. */
  async function resetRequest(req: Request): Promise<Response> {
    const email = str((await body(req)).email);
    if (!email || !email.includes("@")) return json({ error: "Enter a valid email." }, 400);
    await db.service.insert("password_reset_requests", { email: email.trim() }, "return=minimal");
    return json({ ok: true, message: "Request received. After an admin approves it, the app will " +
      "email you a one-time code and link to set a new password. It expires in 2 hours." });
  }

  /** Settings → Accounts → Active tenant (render_active_tenant → set_active_tenant). */
  async function switchTenant(req: Request): Promise<Response> {
    const ctx = await sessions.require(req);
    if (isSuperUser({ role: ctx.user.role as string })) {
      return json({ error: "A super user changes tenant with view-as, from Settings → Tenants." }, 403);
    }
    const id = str((await body(req)).tenantId);
    const mems = await tenants.activeMemberships(ctx.session.sub);
    const m = mems.find((x) => x.tenant_id === id);
    if (!m) return json({ error: "You are not an active member of that tenant." }, 403);
    await db.service.update("users", `id=eq.${q(ctx.session.sub)}`, { last_tenant_id: m.tenant_id })
      .catch(() => undefined);
    const s: Session = { ...ctx.session, tenant: { id: m.tenant_id, name: m.name, slug: m.slug },
      tenantRole: m.role, view: null };
    const t = await sessions.reissue(s, ctx.exp);
    return json({ ...t, user: publicUser(s, ctx.user, { memberships: membershipList(ctx.user, mems),
      homeIsDeveloper: await isDeveloperTenant(m.tenant_id) }) });
  }

  /** A super_user's ?tenant=<slug|id> view-as (app_header._apply_tenant_url). null = return home. */
  async function viewAs(req: Request): Promise<Response> {
    const ctx = await sessions.require(req);
    if (!isSuperUser({ role: ctx.user.role as string })) {
      return json({ error: "Only a super user can view another tenant." }, 403);
    }
    const key = str((await body(req)).key).trim();
    let view: Session["view"] = null;
    if (key) {
      const t = await tenants.resolveTenantByKey(key);
      if (!t) {
        return json({ error: `Couldn't resolve tenant '${key}' — it may have been renamed or removed. ` +
          "Reopen it from Settings → Tenants." }, 404);
      }
      view = t.id === ctx.session.tenant?.id ? null : { id: t.id, name: t.name, slug: t.slug ?? t.id };
    }
    const s: Session = { ...ctx.session, view };
    const t = await sessions.reissue(s, ctx.exp);
    // View-as does not change the home tenant, so developer powers stay as they were.
    return json({ ...t, user: publicUser(s, ctx.user, { memberships: [],
      homeIsDeveloper: await ctx.homeIsDeveloper() }) });
  }

  return { login, me, forcedChange, tokenPeek, tokenRedeem, resetRequest, switchTenant, viewAs };
}
