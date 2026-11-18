/**
 * Settings → Accounts → Users — the rules. `views/account_sections.render_manage_users`.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE OTHER PORTS. Everywhere else a wrong answer costs a
 * score or a number on a page. Here it costs ACCESS: a role assigned one step too high,
 * an override granted beyond the grantor's own, a deactivation that reads as active.
 * Every gate in this file is therefore enforced on the SERVER, not relied on from a
 * disabled control — a disabled dropdown is a hint to a person, and the request a client
 * sends is not bound by it.
 *
 * THREE GATES, AND THEY ARE NOT THE SAME GATE:
 *
 *   canManageUser(actor, target)   may the actor touch this account at all
 *   the SELF lock                  role, active, reset and delete are closed on your own
 *                                  account, even when canManageUser says yes — so nobody
 *                                  demotes or deactivates themselves out of the product
 *   the OVERRIDE ceiling           an actor may never grant a capability beyond their own
 *                                  on that surface; an existing higher grant can be kept
 *                                  or lowered, never raised
 *
 * The Streamlit page calls the last one "defense in depth vs the filtered dropdown". It is
 * not defence in depth here, it is the only defence: there is no dropdown between a
 * client and this route.
 *
 * THE PROFILE FIELDS AND THE ACCESS FIELDS TRAVEL TOGETHER AND ARE AUTHORISED APART. A
 * self-edit saves the profile and the overrides and silently drops role and active rather
 * than refusing the whole request, which is what the Python does and what the page
 * promises ("You can edit your profile + access overrides; role, active, reset, and
 * delete are locked").
 */
import {
  ACCESS_MATRIX, assignableOverrideOptions, assignableRoles, canAssignOverride,
  canManageUser, capabilityLabel, isSuperUser, OVERRIDE_OPTIONS, roleGroup, USE_DEFAULT,
  type PermUser,
} from "./permissions.ts";

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const trimmed = (v: unknown): string => s(v).trim();

// ── Account status ───────────────────────────────────────────────────────────

/** core/user_lifecycle's three labels, emoji included — the page prints them as-is. */
export const STATUS_PENDING = "\u{1F553} Pending";
export const STATUS_ACTIVE = "\u{1F7E2} Active";
export const STATUS_INACTIVE = "⏸ Inactive";

/**
 * The values that mean "nothing here" after a column has been through pandas or JSON.
 *
 * "nan" is the one that matters and the one that already caused this bug once: a None
 * last_login_at arrives from pandas as the float nan, whose string is "nan" — truthy — so
 * an inline version of this rule never reported anybody as Pending. The module docstring
 * in core/user_lifecycle records that a structural test grepping for "Pending" would have
 * passed happily. JSON cannot produce "nan", but the Streamlit page can still send one
 * through an export, and agreeing with the Python costs nothing.
 */
const BLANKS = new Set(["", "nan", "none", "nat", "null", "<na>"]);
const isBlank = (v: unknown): boolean =>
  BLANKS.has((v === null || v === undefined || v === false ? "" : String(v)).trim().toLowerCase());

/**
 * `core.user_lifecycle.account_status`.
 *
 * PENDING needs BOTH halves outstanding — the invitation unredeemed AND the account never
 * signed into. Either alone is something else: somebody who has signed in and been asked
 * to rotate a password is an active user with a chore, and a cleared flag on an unused
 * account is an anomaly, not a pending invitation.
 */
export function accountStatus(
  isActive: unknown, mustChangePassword: unknown, lastLoginAt: unknown,
): string {
  if (!isActive) return STATUS_INACTIVE;
  const neverSignedIn = isBlank(lastLoginAt);
  if (mustChangePassword && neverSignedIn) return STATUS_PENDING;
  return STATUS_ACTIVE;
}

// ── What a client may change ─────────────────────────────────────────────────

/** The profile columns the edit dialog writes. Everything else on `users` is off-limits. */
export const PROFILE_COLUMNS = [
  "name", "email", "phone", "job_title", "department", "program",
] as const;

/** What the actor may do to the target, before a single field is looked at. */
export function editRights(actor: PermUser, target: PermUser): {
  profile: boolean; role: boolean; overrides: boolean; reset: boolean; remove: boolean;
} {
  // `PermUser` admits null — an unauthenticated or unresolved actor. A missing email is
  // never "the same person": treating two absences as a match would hand self-edit rights
  // to a session that has no identity at all.
  const actorEmail = trimmed(actor?.email).toLowerCase();
  const self = !!actorEmail && actorEmail === trimmed(target?.email).toLowerCase();
  const manage = canManageUser(actor, target);
  return {
    profile: manage || self,
    // The self lock. `canManageUser` already refuses an admin editing themselves, but a
    // super_user passes it — and a super_user demoting their own account is exactly the
    // lockout this guards against.
    role: manage && !self,
    // Overrides stay editable on a self-edit, deliberately: they cannot grant super or
    // developer powers (those gates are role plus tenant, not override-driven), and the
    // banner already promises a user may tune them.
    overrides: manage || self,
    reset: manage && !self,
    remove: manage && !self,
  };
}

/**
 * `_new_user_problems` — what stops a row being created, before touching the database.
 *
 * FAITHFUL, INCLUDING THE HOLE. The Python tests `if not name`, so a name of pure
 * whitespace passes: it is truthy. The bulk path never reaches that case because
 * `_bulk_rows` strips every cell first, but the single-user dialog hands the text input's
 * value through untouched, and Streamlit does not strip it.
 *
 * Tightening it HERE would make the two apps disagree about the same input, which is the
 * one thing a parity check exists to prevent — so the trim happens at the route instead,
 * where it matches what the bulk path already does to its own cells. The Streamlit
 * dialog's hole is left alone and reported rather than quietly diverged from.
 */
export function newUserProblems(email: unknown, name: unknown): string[] {
  const errs: string[] = [];
  const e = s(email);
  if (!e || !e.includes("@") || e.trim().includes(" ")) {
    errs.push("a valid email is required");
  }
  if (!s(name)) errs.push("full name is required");
  return errs;
}

/**
 * `_bulk_rows` — the filled-in rows of the bulk table, numbered as the admin sees them.
 *
 * A ROW WITH NOTHING IN IT IS SPARE CAPACITY, NOT A MISTAKE. The table always offers
 * more rows than anybody uses, so reporting "email required" for the empty ones would
 * bury the real typos under noise the admin cannot act on. A row counts as used when ANY
 * of its fields has something in it — including the department or the programme areas,
 * because somebody who typed a department and forgot the email has made an error worth
 * showing.
 *
 * Numbering starts at 1 and counts EVERY row including the skipped ones, so "row 4" in a
 * problem message is the fourth row on screen.
 */
export function bulkRows(rows: unknown): {
  n: number; email: string; name: string; role: string; dept: string; areas: string[];
}[] {
  const out: { n: number; email: string; name: string; role: string; dept: string; areas: string[] }[] = [];
  const src = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < src.length; i++) {
    const r = (src[i] && typeof src[i] === "object" ? src[i] : {}) as Json;
    // A COMMA STRING IS ACCEPTED, because that is what a paste produces: somebody copies
    // a spreadsheet column of "Malaria, Health Financing" and the cell arrives as one
    // string. The Python splits it for the same reason, and without this the whole list
    // would be stored as a single programme area that matches nothing.
    const raw = r.areas ?? r["Program areas"];
    const areas = (typeof raw === "string"
      ? raw.split(",")
      : (Array.isArray(raw) ? raw : []))
      .map((a) => s(a).trim()).filter(Boolean);
    const row = {
      n: i + 1,
      email: trimmed(r.email),
      name: trimmed(r.name),
      role: trimmed(r.role),
      dept: trimmed(r.department ?? r.dept),
      areas,
    };
    if (row.email || row.name || row.dept || areas.length) out.push(row);
  }
  return out;
}

/**
 * `_bulk_problems` — every reason the batch cannot go ahead, one line per row problem.
 *
 * THE BATCH IS ALL OR NOTHING, and the Python says why: "a half-created team, with the
 * admin left to work out which rows went through, is harder to fix than a list of typos."
 * So this returns EVERY problem rather than stopping at the first — a list you can fix in
 * one pass beats four round trips.
 *
 * `existing` is compared lower-cased because addresses are stored as typed; a batch that
 * differed from a live account only in case would pass validation and then fail on the
 * unique index, which is the half-created team this exists to prevent.
 */
export function bulkProblems(
  rows: ReturnType<typeof bulkRows>, roles: string[], existing: Iterable<string>,
): string[] {
  const taken = new Set([...existing].map((e) => trimmed(e).toLowerCase()));
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const r of rows) {
    const probs = newUserProblems(r.email, r.name);
    const key = r.email.toLowerCase();
    if (key && seen.has(key)) probs.push(`same email as row ${seen.get(key)}`);
    else if (key) seen.set(key, r.n);
    if (key && taken.has(key)) probs.push("a user with this email already exists");
    if (r.role && !roles.includes(r.role)) {
      probs.push(`role “${r.role}” is not one you can assign`);
    }
    if (probs.length) {
      const label = r.email || r.name || "(blank)";
      out.push(`Row ${r.n} (${label}): ${probs.join("; ")}`);
    }
  }
  return out;
}

/**
 * The single-user form, cleaned the way `_bulk_rows` cleans a table cell.
 *
 * This is where the whitespace-name hole above is closed, and closing it here rather than
 * in `newUserProblems` is the point: the shared rule stays identical in both apps, and
 * this route simply does not hand it a value the bulk path would never have produced.
 */
export function cleanNewUser(form: Json): { email: string; name: string; role: string;
  dept: string; program: string } {
  return {
    email: trimmed(form.email),
    name: trimmed(form.name),
    role: trimmed(form.role),
    dept: trimmed(form.department),
    program: trimmed(form.program),
  };
}

/**
 * The edit dialog's own validation: a usable address, and nobody else holding it.
 *
 * ONLY FOR FIELDS THE REQUEST CARRIES. The Streamlit dialog is a form and always submits
 * every input, so its check can assume an email is present; a PATCH cannot. Validating an
 * absent key rejected "change this person's department" with "Email must be a valid
 * address", which is both wrong and impossible to act on — found by probing the route,
 * not by reading it.
 *
 * The collision test is case-INSENSITIVE and skips the target's own current address, so
 * re-saving a form without touching the email is not a collision with yourself.
 */
export function editProblems(
  form: Json, currentEmail: string, otherEmails: Iterable<string>,
): string[] {
  const errs: string[] = [];
  if (!("email" in form)) return errs;
  const next = trimmed(form.email);
  if (!next || !next.includes("@")) errs.push("Email must be a valid address.");
  if (next && next.toLowerCase() !== trimmed(currentEmail).toLowerCase()) {
    for (const other of otherEmails) {
      if (trimmed(other).toLowerCase() === next.toLowerCase()) {
        errs.push("Another user already has that email.");
        break;
      }
    }
  }
  return errs;
}

/**
 * The `users` patch, built from what the form sent and what the actor may change.
 *
 * EMPTY BECOMES NULL for every optional column, as the Python's `or None` does. The
 * distinction is not cosmetic: "" and null sort and group differently, and a department
 * cleared to "" would show as a department named nothing in the roster's own filters.
 * `email` is the exception — it is the login username, so it is trimmed and kept.
 */
export function editPatch(form: Json, rights: ReturnType<typeof editRights>): Row {
  const patch: Row = {};
  for (const col of PROFILE_COLUMNS) {
    if (!(col in form)) continue;
    const v = trimmed(form[col]);
    patch[col] = col === "email" ? v : (v || null);
  }
  if (rights.role) {
    if ("role" in form) patch.role = trimmed(form.role);
    if ("is_active" in form) patch.is_active = !!form.is_active;
  }
  return patch;
}

/**
 * The overrides the actor is allowed to set, and the surfaces they were refused on.
 *
 * "Use role default" is an ABSENCE, not a value: it is dropped rather than stored, so the
 * role policy answers for that surface. Storing the words would make a later change to
 * ACCESS_MATRIX invisible to everybody who had ever opened this dialog.
 *
 * A surface this build does not know is dropped too. An unknown key in
 * `users.access_overrides` is read by `access()` BEFORE the matrix is consulted, so a
 * typo'd surface would sit on the row forever, matching nothing and explaining nothing.
 */
export function overridesFor(actor: PermUser, form: unknown, current: unknown): {
  overrides: Record<string, string>; refused: string[];
} {
  const src = (form && typeof form === "object" && !Array.isArray(form))
    ? form as Json : {};
  const now = (current && typeof current === "object" && !Array.isArray(current))
    ? current as Json : {};
  const overrides: Record<string, string> = {};
  const refused: string[] = [];
  for (const surface of Object.keys(ACCESS_MATRIX)) {
    const pick = trimmed(src[surface]);
    if (!pick || pick === USE_DEFAULT) continue;
    if (!OVERRIDE_OPTIONS.includes(pick)) {
      refused.push(surface);
      continue;
    }
    // THE CEILING. An actor may never grant beyond their own capability on a surface; an
    // existing higher grant may be kept or lowered, which is why the current value is
    // passed in rather than inferred.
    if (!canAssignOverride(actor, surface, pick, s(now[surface]) || null)) {
      refused.push(surface);
      continue;
    }
    overrides[surface] = pick;
  }
  return { overrides, refused };
}

/** A role the actor may actually assign — anything else is refused rather than clamped. */
export function roleAllowed(actor: PermUser, role: unknown, currentRole: unknown): boolean {
  const want = trimmed(role);
  if (!want) return false;
  // Keeping a role the actor could not newly assign is allowed: a super_user editing
  // another super_user's department must not silently demote them.
  if (want === trimmed(currentRole)) return true;
  return assignableRoles(actor).includes(want);
}

/**
 * Who this actor may SEE.
 *
 * Blacklisted accounts are hidden outright — they are hard-blocked and managed under
 * their own tab, so listing them here would offer actions that do not apply. A super_user
 * in their own account sees everyone; anybody else sees the members of the tenant ON
 * SCREEN.
 *
 * The tenant that matters is the one being VIEWED, not the session's. While a super_user
 * views another tenant they are gated as that tenant's admin — `isSuperUser` answers
 * false — and scoping to their session tenant would list their own colleagues under
 * somebody else's name. The route passes the viewed id for exactly that reason.
 */
export function visibleUsers(rows: Row[], actor: PermUser, memberIds: Set<string> | null): Row[] {
  const live = rows.filter((u) => !u.is_blacklisted);
  if (isSuperUser(actor) || !memberIds) return live;
  return live.filter((u) => memberIds.has(s(u.id)));
}

/**
 * The override editor's rows for one target, decided HERE rather than in the browser.
 *
 * Each row carries the surface, what the target's ROLE already grants there, and the
 * options this ACTOR may assign — the ceiling, with an existing higher grant preserved so
 * it can be kept or lowered but never raised. Resolving it server-side is not an
 * optimisation: `access()`, the ceiling and the role matrix are permission logic, and a
 * second copy of permission logic in a browser is a copy that decides what is drawn while
 * the real one decides what is allowed. The two then disagree silently, and the page
 * shows a grant that the save refuses.
 */
export function overrideRows(actor: PermUser, target: PermUser): {
  surface: string; roleDefault: string; roleDefaultLabel: string;
  options: string[]; current: string;
}[] {
  const raw = target?.access_overrides;
  const stored = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? raw as Record<string, unknown> : {};
  const group = roleGroup(target);
  return Object.entries(ACCESS_MATRIX).map(([surface, caps]) => {
    const roleDefault = caps[group] ?? "hidden";
    // A stored value outside the option list reads as "Use role default", exactly as the
    // Python's `if current_choice not in OVERRIDE_OPTIONS` branch does: an unreadable
    // override is not an override, and presenting it as one would invite somebody to
    // "keep" a setting that has never applied.
    let current = s(stored[surface]).trim();
    if (!OVERRIDE_OPTIONS.includes(current)) current = USE_DEFAULT;
    return {
      surface,
      roleDefault,
      roleDefaultLabel: capabilityLabel(roleDefault),
      options: assignableOverrideOptions(actor, surface, current),
      current,
    };
  });
}

/** The tenant label a user's memberships add up to — "(pending)" marked, as the page does. */
export function tenantLabels(memberships: Row[]): Record<string, string> {
  const by = new Map<string, Set<string>>();
  for (const m of memberships) {
    const status = s(m.status);
    if (status !== "active" && status !== "pending") continue;
    const name = s((m.tenants as Row | null)?.name).trim();
    if (!name) continue;
    const uid = s(m.user_id);
    if (!by.has(uid)) by.set(uid, new Set());
    by.get(uid)!.add(status === "active" ? name : `${name} (pending)`);
  }
  const out: Record<string, string> = {};
  for (const [uid, names] of by) out[uid] = [...names].sort().join(", ");
  return out;
}
