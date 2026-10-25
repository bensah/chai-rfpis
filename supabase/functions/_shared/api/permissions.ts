/**
 * A port of core/permissions.py (plus core/suggestions.can_suggest and
 * core/password_policy). Checks read the ACCOUNT's role (`users.role`), as the Python
 * `app_user` dict does — never the membership role, which only feeds the tenant JWT claim.
 *
 * The developer-tenant axis is keyed to the session's HOME tenant (a super_user's view-as
 * does not change it), so `homeIsDeveloper` is passed in by the caller.
 *
 * Parity: web/scripts/parity/check-permissions.mjs runs every function here and its Python
 * twin over every role × developer flag × override combination.
 */
export type PermUser = {
  role?: string | null;
  email?: string | null;
  access_overrides?: Record<string, string> | null;
} | null | undefined;

export const ACCESS_MATRIX: Record<string, { admin: string; user: string }> = {
  "Home":                       { admin: "edit",    user: "edit" },
  "Pipelines":                  { admin: "edit",    user: "edit" },
  "Grants":                     { admin: "edit",    user: "edit" },
  "Actions":                    { admin: "edit",    user: "edit" },
  "Report":                     { admin: "edit",    user: "view" },
  "Donors":                     { admin: "edit",    user: "view" },
  "Profile → My Profile":       { admin: "self",    user: "self" },
  "Profile → Change Password":  { admin: "self",    user: "self" },
  "Settings → Manage Users":    { admin: "all",     user: "hidden" },
  "Settings → User Access":     { admin: "view",    user: "hidden" },
  "Settings → Setup":           { admin: "edit",    user: "hidden" },
  "Settings → Records":         { admin: "edit",    user: "hidden" },
  "Settings → Sources":         { admin: "edit",    user: "view+add" },
  "Settings → Manual Scan":     { admin: "trigger", user: "hidden" },
};

export const ROLE_LABELS: Record<string, string> = {
  collaborator: "Contributor",
  reviewer: "Reviewer",
  admin: "Admin",
  super_user: "Super User",
};

/** Python truthiness of the user dict: None and {} are both "no user". */
const present = (u: PermUser): u is NonNullable<PermUser> => !!u && Object.keys(u).length > 0;

export const isSuperUser = (u: PermUser) => present(u) && u.role === "super_user";
export const isAdmin = (u: PermUser) => present(u) && (u.role === "admin" || u.role === "super_user");
export const canEditStatus = (u: PermUser) => present(u) && Boolean(u.role);
export const roleGroup = (u: PermUser): "admin" | "user" => (isAdmin(u) ? "admin" : "user");

export const isDeveloperSuper = (u: PermUser, homeIsDeveloper: boolean) => isSuperUser(u) && homeIsDeveloper;
export const isDeveloperAdmin = (u: PermUser, homeIsDeveloper: boolean) => isAdmin(u) && homeIsDeveloper;
export const isDeveloperMember = (u: PermUser, homeIsDeveloper: boolean) => present(u) && homeIsDeveloper;

/** core/suggestions.can_suggest */
export const canSuggest = (u: PermUser, homeIsDeveloper: boolean) =>
  present(u) && !isDeveloperSuper(u, homeIsDeveloper);

/** Python `str.title()` for the fallback label: each run of letters capitalised. */
function pyTitle(s: string): string {
  return s.toLowerCase().replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1));
}

export function roleLabel(u: PermUser): string {
  const raw = u?.role;
  if (raw && Object.hasOwn(ROLE_LABELS, raw)) return ROLE_LABELS[raw];
  return pyTitle(raw || "—");
}

const MANAGEABLE_BY: Record<string, Set<string>> = {
  super_user: new Set(["super_user", "admin", "reviewer", "collaborator"]),
  admin: new Set(["admin", "reviewer", "collaborator"]),
};

export function canManageUser(actor: PermUser, target: PermUser): boolean {
  if (!present(actor) || !present(target)) return false;
  const actorRole = actor.role || "";
  const targetRole = target.role || "";
  if (!Object.hasOwn(MANAGEABLE_BY, actorRole) || !MANAGEABLE_BY[actorRole].has(targetRole)) return false;
  if (actorRole === "admin" && actor.email === target.email) return false;
  return true;
}

export function assignableRoles(actor: PermUser): string[] {
  if (isSuperUser(actor)) return ["collaborator", "reviewer", "admin", "super_user"];
  if (isAdmin(actor)) return ["collaborator", "reviewer", "admin"];
  return [];
}

export function access(u: PermUser, surface: string): string {
  if (present(u)) {
    const ov = u.access_overrides;
    if (ov && typeof ov === "object" && !Array.isArray(ov) && Object.hasOwn(ov, surface)) {
      const cap = ov[surface];
      if (cap) return cap;
    }
  }
  if (!Object.hasOwn(ACCESS_MATRIX, surface)) return "hidden";
  const row = ACCESS_MATRIX[surface];
  return row[roleGroup(u)] ?? "hidden";
}

export const USE_DEFAULT = "Use role default";
export const OVERRIDE_OPTIONS = [USE_DEFAULT, "edit", "view", "view+add", "trigger", "hidden"];
const CAP_RANK: Record<string, number> = {
  hidden: 0, self: 1, view: 1, "view+add": 2, trigger: 2, edit: 3, all: 4,
};
const capRank = (c: string | null | undefined) => (c && Object.hasOwn(CAP_RANK, c) ? CAP_RANK[c] : 0);

export function assignableOverrideOptions(actor: PermUser, surface: string, current?: string | null): string[] {
  const ceiling = capRank(access(actor, surface));
  const opts = [USE_DEFAULT];
  for (const cap of OVERRIDE_OPTIONS) {
    if (cap === USE_DEFAULT) continue;
    if (capRank(cap) <= ceiling) opts.push(cap);
  }
  if (current && !opts.includes(current)) opts.push(current);
  return opts;
}

export function canAssignOverride(actor: PermUser, surface: string, cap: string, current?: string | null): boolean {
  if (cap === USE_DEFAULT || cap === "hidden") return true;
  if (cap === current) return true;
  return capRank(cap) <= capRank(access(actor, surface));
}

export const canView = (u: PermUser, surface: string) => access(u, surface) !== "hidden";
export const canEdit = (u: PermUser, surface: string) =>
  ["edit", "all", "self", "trigger", "view+add"].includes(access(u, surface));

// ── core/password_policy ──────────────────────────────────────────────────────
export const PASSWORD_MIN_LEN = 8;
export const PASSWORD_RULES_TEXT =
  "At least 8 characters, including at least one letter and one number. Spaces are allowed.";

// Python's str.isdigit is Numeric_Type Decimal (\p{Nd}) OR Digit: superscripts, subscripts,
// circled and parenthesised digits. JS regex cannot ask for Numeric_Type, so the Digit
// characters are listed.
const PY_DIGIT = new RegExp("[\\p{Nd}\\u00B2\\u00B3\\u00B9\\u1369-\\u1371\\u19DA\\u2070\\u2074-\\u2079" +
  "\\u2080-\\u2089\\u2460-\\u2468\\u2474-\\u247C\\u2488-\\u2490\\u24EA\\u24F5-\\u24FD\\u24FF" +
  "\\u2776-\\u277E\\u2780-\\u2788\\u278A-\\u2792\\u{10A40}-\\u{10A43}\\u{10E60}-\\u{10E68}" +
  "\\u{11052}-\\u{1105A}\\u{1F100}-\\u{1F10A}]", "u");

/** Python's str.isalpha / str.isdigit are Unicode-aware; so are these. */
export function passwordProblems(pw: string | null | undefined): string[] {
  const p = pw ?? "";
  const n = [...p].length;
  const out: string[] = [];
  if (n < PASSWORD_MIN_LEN) {
    out.push(`Too short — use at least ${PASSWORD_MIN_LEN} characters (this one has ${n}).`);
  }
  if (!/\p{L}/u.test(p)) out.push("Add at least one letter.");
  if (!PY_DIGIT.test(p)) out.push("Add at least one number.");
  return out;
}
