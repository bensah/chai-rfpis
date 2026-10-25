/**
 * Browser sessions.
 *
 * The session token is signed with a key DERIVED from the project JWT secret, so it is never
 * a valid PostgREST token: a stolen session token cannot be replayed against Supabase.
 *
 * Every authenticated request re-reads the account (active, not blacklisted, not forced to
 * change its password) and re-checks the tenant membership, so a deactivated account or a
 * revoked membership loses access on its next request. (Streamlit re-checks membership when
 * it re-mints its hourly tenant JWT; this is stricter, never looser.)
 */
import { q, type Db, type Scope } from "./db.ts";
import { HttpError } from "./http.ts";
import { derivedKey, signJwt, verifyJwt, type Json, type Key } from "./jwt.ts";
import { roleLabel } from "./permissions.ts";
import type { Membership, Tenants } from "./tenants.ts";

export const SESSION_TTL_S = 8 * 3600;   // = Streamlit's cookie (COOKIE_EXPIRY_DAYS = 1/3)
const CHANGE_PW_TTL_S = 15 * 60;         // a must-change-password token does one thing, briefly

type TenantRef = { id: string; name: string | null; slug: string | null };

/** What the signed token carries. */
export type Session = {
  sub: string;
  email: string;
  scope: "app" | "change-password";
  tenant: TenantRef | null;      // the session's own (home) tenant
  tenantRole: string | null;     // membership role in it (the JWT user_role claim)
  view: TenantRef | null;        // a super_user's view-as target
};

/** A verified request: the session plus the account row as it is right now. */
export type Ctx = {
  session: Session;
  user: Json;                    // the users row (no password_hash)
  scope: Scope;
  homeIsDeveloper: () => Promise<boolean>;
};

export const USER_COLUMNS =
  "id,email,name,role,is_active,is_blacklisted,must_change_password,access_overrides,last_tenant_id";

export function createSessions(jwtSecret: string, db: Db, tenants: Tenants) {
  let keyP: Promise<Key> | null = null;
  const key = () => (keyP ??= derivedKey(jwtSecret, "rfpis-web-session-v1"));

  async function issue(s: Session): Promise<{ token: string; expiresAt: number }> {
    const now = Math.floor(Date.now() / 1000);
    const ttl = s.scope === "change-password" ? CHANGE_PW_TTL_S : SESSION_TTL_S;
    const token = await signJwt({ ...s, typ: "rfpis-web", iat: now, exp: now + ttl }, await key());
    return { token, expiresAt: now + ttl };
  }

  /** Re-issue with changes, keeping the original expiry (a tenant switch does not extend
   * the 8-hour session, just as switching tenant in Streamlit keeps the same cookie). */
  async function reissue(s: Session, exp: number): Promise<{ token: string; expiresAt: number }> {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({ ...s, typ: "rfpis-web", iat: now, exp }, await key());
    return { token, expiresAt: exp };
  }

  async function decode(req: Request): Promise<(Session & { exp: number }) | null> {
    const h = req.headers.get("authorization") ?? "";
    const tok = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
    if (!tok) return null;
    const p = await verifyJwt(tok, await key());
    if (!p || p.typ !== "rfpis-web" || typeof p.sub !== "string") return null;
    return {
      sub: p.sub, email: String(p.email ?? ""),
      scope: p.scope === "change-password" ? "change-password" : "app",
      tenant: (p.tenant as TenantRef) ?? null, tenantRole: (p.tenantRole as string) ?? null,
      view: (p.view as TenantRef) ?? null, exp: Number(p.exp),
    };
  }

  async function fetchUserById(id: string): Promise<Json | null> {
    const rows = await db.service.get("users", `select=${USER_COLUMNS}&id=eq.${q(id)}&limit=1`);
    return rows[0] ?? null;
  }

  async function membershipActive(userId: string, tenantId: string): Promise<boolean> {
    // tenant_context.membership_status: an active row, in a tenant that is not
    // blacklisted or pending.
    const rows = await db.service.get("tenant_memberships",
      `select=tenant_id,tenants(status)&user_id=eq.${q(userId)}&tenant_id=eq.${q(tenantId)}` +
      "&status=eq.active&limit=1");
    if (!rows.length) return false;
    const t = (rows[0].tenants ?? {}) as Json;
    return t.status !== "blacklisted" && t.status !== "pending";
  }

  function toScope(s: Session, user: Json): Scope {
    const isSuper = String(user.role ?? "") === "super_user";
    return {
      sub: s.sub, email: String(user.email ?? s.email),
      tenantRole: s.tenantRole || String(user.role ?? "") || "collaborator",
      tenantId: s.tenant?.id ?? null,
      viewTenantId: isSuper ? (s.view?.id ?? null) : null,
      isSuper,
    };
  }

  /**
   * Verify the request. `allow` is the token scope the route accepts: everything except the
   * password-change route requires a full "app" session, so a restricted token cannot read
   * data — the API equivalent of `_gate_must_change_password` blocking every page.
   */
  async function require(req: Request, allow: Session["scope"] = "app"): Promise<Ctx & { exp: number }> {
    const s = await decode(req);
    if (!s || s.scope !== allow) throw new HttpError(401, "Sign in to continue.");
    const [user, member] = await Promise.all([
      fetchUserById(s.sub),
      s.tenant ? membershipActive(s.sub, s.tenant.id) : Promise.resolve(true),
    ]);
    if (!user || !user.is_active || user.is_blacklisted) {
      throw new HttpError(401, "Your session has ended. Sign in again.");
    }
    if (allow === "app" && user.must_change_password) {
      throw new HttpError(401, "Choose a new password to continue. Sign in again.");
    }
    if (!member) throw new HttpError(401, "Your organisation access changed. Sign in again.");
    let devP: Promise<boolean> | null = null;
    const homeIsDeveloper = () => (devP ??= (async () =>
      !!s.tenant && (await tenants.developerTenantIds()).includes(s.tenant.id))());
    return { session: s, user, scope: toScope(s, user), homeIsDeveloper, exp: s.exp };
  }

  /** The session for a user who just proved who they are (login). */
  function sessionFor(user: Json, chosen: Membership | null, scope: Session["scope"]): Session {
    return {
      sub: String(user.id), email: String(user.email), scope,
      tenant: chosen ? { id: chosen.tenant_id, name: chosen.name, slug: chosen.slug } : null,
      tenantRole: chosen?.role ?? null,
      view: null,
    };
  }

  return { issue, reissue, require, sessionFor, fetchUserById };
}

export type Sessions = ReturnType<typeof createSessions>;

/** What the browser is told about who it is. */
export function publicUser(s: Session, user: Json, extra: Json = {}) {
  return {
    email: String(user.email ?? s.email),
    name: String(user.name || user.email || s.email),
    role: String(user.role ?? ""),
    roleLabel: roleLabel({ role: user.role as string }),
    tenant: s.tenant,
    tenantRole: s.tenantRole,
    view: String(user.role) === "super_user" && s.view && s.view.id !== s.tenant?.id ? s.view : null,
    ...extra,
  };
}
