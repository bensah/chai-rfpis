/**
 * Profile — `app_pages/profile.py` and `views/account_sections.py`'s self-service half.
 *
 * SELF-SERVICE ONLY. Every signed-in user manages their own row here; Manage Users and
 * User Access are admin surfaces and moved to Settings in the 2026-06-07 nav redesign.
 * Nothing in this module takes a user id from the request — the session decides whose row
 * is read and written, which is the whole security argument for the page.
 *
 * THE SERVICE ROLE IS USED ON PURPOSE, and the Python says why in a comment worth
 * repeating because it is a trap rather than a shortcut: the tenant-scoped `authenticated`
 * client can READ `users` (the form populates fine) but its UPDATE is silently blocked by
 * RLS — zero rows, no error. A profile save would look saved and change nothing, and a
 * PASSWORD change would no-op while the old password still worked. So both writes go
 * through the service role, scoped by the session's own id, and both VERIFY that a row
 * came back rather than trusting the call.
 *
 * WHAT THIS PORT DOES BETTER THAN THE PAGE IT COPIES: the sole-super-user guard on account
 * deletion. Streamlit computes it and then only hides the button, so the check lives
 * entirely in the client; here it is enforced in the route. A guard that can be skipped by
 * not using the UI is not a guard, and this one stops the last administrator locking
 * everybody out of administration.
 */

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const blankToNull = (v: unknown): string | null => s(v).trim() || null;

/** The columns the page reads. `password_hash` is NOT among them and must never be. */
export const PROFILE_COLUMNS = [
  "id", "email", "name", "role", "phone", "job_title", "department", "program",
  "address", "city", "state_region", "country",
  "created_at", "last_login_at", "password_changed_at", "must_change_password",
].join(",");

/**
 * The ten columns a user may write on their own row.
 *
 * ROLE IS NOT ONE OF THEM, and that is the point of listing them rather than passing a
 * body through: role decides what every other screen allows, so a self-service form that
 * accepted it would be a privilege-escalation endpoint wearing a profile form's clothes.
 * The Streamlit page renders role as a disabled input and never submits it; this refuses
 * it even if a client sends it.
 */
export const EDITABLE = [
  "name", "email", "phone", "job_title", "department", "program",
  "address", "city", "state_region", "country",
] as const;

export type ProfilePayload = Partial<Record<(typeof EDITABLE)[number], unknown>>;

/**
 * The patch, with every blank becoming NULL rather than an empty string.
 *
 * `(new_phone or "").strip() or None` in the Python, for all ten. It matters beyond
 * tidiness: `program` feeds `core.user_program_areas.declared_keys`, which is read into
 * the org profile as evidence of the organisation's expertise in MUST-2, and an empty
 * string there is a declared area of "" rather than no declaration.
 *
 * EMAIL IS THE EXCEPTION — it is the login username, so it is stored trimmed but never
 * nulled; `validate` refuses a blank one outright instead.
 */
export function buildPatch(p: ProfilePayload): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const k of EDITABLE) {
    if (!(k in p)) continue;
    patch[k] = k === "email" ? s(p[k]).trim() : blankToNull(p[k]);
  }
  return patch;
}

/**
 * The Python's two checks, in its order and its words.
 *
 * The uniqueness test is CASE-INSENSITIVE on both sides — `ilike` in the Python — because
 * the login lookup is too. Letting "Ben@x.org" through while "ben@x.org" exists would
 * create a second account that collides with the first at sign-in.
 */
export function validate(email: unknown, currentEmail: unknown, taken: boolean): string[] {
  const errs: string[] = [];
  const next = s(email).trim();
  if (!next || !next.includes("@")) errs.push("Email must be a valid address.");
  if (!errs.length && next.toLowerCase() !== s(currentEmail).trim().toLowerCase() && taken) {
    errs.push("Another user already has that email.");
  }
  return errs;
}

/** Is the submitted address a real change, case-insensitively? */
export const emailChanged = (next: unknown, current: unknown): boolean =>
  s(next).trim().toLowerCase() !== s(current).trim().toLowerCase();

// ── Login history ────────────────────────────────────────────────────────────

/**
 * `views/login_history._parse_ua` — "Chrome · Windows" from a raw user-agent.
 *
 * Substring heuristics with no dependency, and the ORDER of the browser tests is the
 * whole trick: every one of these strings contains "safari/" and most contain "chrome/",
 * so Edge must be tested before Chrome and Chrome before Safari. Reorder them and every
 * Edge user becomes a Chrome user.
 *
 * LOCATION IS DELIBERATELY NOT DERIVED. The Python's own docstring says so: that needs an
 * external geo-IP call, and the panel shows IP plus device instead. The point of the panel
 * is a user spotting a sign-in they do not recognise, and a device and an address do that
 * without sending anybody's IP to a third party.
 */
export function parseUserAgent(ua: unknown): string {
  const u = s(ua).toLowerCase();
  if (!u) return "Unknown device";
  const browser = u.includes("edg/") ? "Edge"
    : (u.includes("opr/") || u.includes(" opera") || u.startsWith("opera")) ? "Opera"
    : u.includes("firefox/") ? "Firefox"
    : (u.includes("chrome/") && !u.includes("chromium")) ? "Chrome"
    : u.includes("safari/") ? "Safari"
    : "Browser";
  const os = u.includes("windows") ? "Windows"
    : u.includes("android") ? "Android"
    : (u.includes("iphone") || u.includes("ipad") || u.includes("ios ")) ? "iOS"
    : (u.includes("mac os") || u.includes("macintosh")) ? "macOS"
    : u.includes("linux") ? "Linux"
    : "—";
  return `${browser} · ${os}`;
}

export type LoginRow = { at: string; device: string; ip: string };

/** The columns the history panel reads from `login_logs` (migration 084): `at`, `ip`,
 *  `user_agent` — the migration's own names, not the `created_at` / `ip_address` a
 *  reader might assume from the rest of the schema. */
export const LOGIN_COLUMNS = "at,ip,user_agent";
/** Twelve, as the Python's panel takes — a few sign-ins, not an audit log. */
export const LOGIN_LIMIT = 12;

/** A date column as a plain day, which is all three profile metrics show. */
export const day = (v: unknown): string | null => s(v).slice(0, 10) || null;
