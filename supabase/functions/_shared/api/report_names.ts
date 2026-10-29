/**
 * Funder identity and person-name canonicalisation — ports of `core/funder_names.py` and
 * `core/member_names.py`.
 *
 * These are the foundation the Report sections stand on rather than a section of their own:
 * "Which funders our calls come from" groups by funder identity, and the whole of Team &
 * Partners is person names. Both are the kind of rule where a plausible re-implementation
 * gets 95% of rows right and splits one real person, or one real funder, across two bars —
 * which reads as a smaller relationship than the organisation actually has.
 *
 * PERSON NAMES ARE DATA. Nothing in this file contains one. The roster, the nickname map and
 * the alias map are read from the database exactly as the Python reads them, and all three
 * are empty by default, so an unconfigured deployment leaves names as they were typed.
 */
import { q, type Db } from "./db.ts";

// ── Funder identity (core/funder_names.py) ───────────────────────────────────

/** Every dash Unicode offers that a human means as "-", plus the invisible soft hyphen. */
const DASHES = "‐‑‒–—―−­";
const DASH_RE = new RegExp(`[${DASHES}]`, "g");
const WS_RE = /\s+/g;

/**
 * The funder name as it should be STORED — same words, one spelling.
 *
 * Word and Excel autocorrect `ACRONYM - Name` into `ACRONYM – Name` the moment somebody
 * edits the cell, and the two are indistinguishable at a glance. NFKC first, then the dash
 * family folds to an ASCII hyphen and runs of whitespace collapse. A soft hyphen is
 * invisible, so it disappears rather than becoming a visible '-'.
 */
export function canonicalFunder(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value).normalize("NFKC");
  s = s.replace(/­/g, "");          // soft hyphen: invisible, not a dash
  s = s.replace(DASH_RE, "-");
  return s.replace(WS_RE, " ").trim();
}

/**
 * The IDENTITY of a funder name — what makes two spellings the same donor.
 *
 * Deliberately the same rule `core.donor_intel._norm` uses to match funders against donor
 * records: lowercase, and every run of non-alphanumeric characters becomes one space. It is
 * literal about letters ("Française" and "Francaise" differ), which the Python documents
 * as intentional — widening it here alone would break the agreement with the matcher and the
 * report's numbers would stop matching the donor pages.
 */
export function funderKey(value: unknown): string {
  return canonicalFunder(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * The spelling to SHOW for a group of variants: the most common one, ties broken by the
 * alphabetically first so the label does not flicker between renders.
 *
 * Python sorts by `(-count, name)`. JavaScript's default string comparison is by UTF-16 code
 * unit, which is what Python's `<` on `str` does too, so the tie-break agrees.
 */
export function dominantSpelling(values: Iterable<unknown>): string {
  const counts = new Map<string, number>();
  for (const v of values) {
    const name = canonicalFunder(v);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0];
}

export type FunderGroup = { label: string; count: number; variants: Record<string, number> };

/** `group_by_funder` — the whole reconciliation picture for a column of funder strings. */
export function groupByFunder(values: Iterable<unknown>): Record<string, FunderGroup> {
  const out: Record<string, FunderGroup> = {};
  for (const value of values) {
    const raw = String(value ?? "").trim();
    if (!raw) continue;
    const key = funderKey(raw);
    if (!key) continue;
    const entry = out[key] ?? (out[key] = { label: "", count: 0, variants: {} });
    entry.count += 1;
    entry.variants[raw] = (entry.variants[raw] ?? 0) + 1;
  }
  for (const entry of Object.values(out)) {
    const expanded: string[] = [];
    for (const [v, n] of Object.entries(entry.variants)) for (let i = 0; i < n; i++) expanded.push(v);
    entry.label = dominantSpelling(expanded);
  }
  return out;
}

// ── Person names (core/member_names.py) ──────────────────────────────────────

/** Honorifics are TITLES, not names. A bare title charted as a bar labelled "Prof". */
const HONORIFICS = new Set([
  "prof", "professor", "dr", "doc", "mr", "mrs", "ms", "miss", "mx", "sir", "madam", "mme",
  "eng", "ing", "hon", "rev", "fr", "pr", "pastor", "amb", "sen", "capt", "col", "gen",
]);

/** Python's `str.split()` with no argument: split on any whitespace run, no empty pieces. */
const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);

/** Drop leading honorifics. Returns "" when the value is ONLY a title. */
export function stripHonorifics(name: unknown): string {
  const toks = words(String(name ?? "").replace(/\./g, " "));
  let i = 0;
  while (i < toks.length && HONORIFICS.has(toks[i].toLowerCase())) i++;
  return toks.slice(i).join(" ");
}

/**
 * Python's `str.capitalize()`: first character upper, EVERY OTHER CHARACTER LOWER. Not
 * JavaScript's usual `s[0].toUpperCase() + s.slice(1)`, which would leave "MCDONALD" as
 * "MCDONALD" where Python gives "Mcdonald" — a difference that puts the same person on two
 * bars whenever one row was typed in caps.
 */
const capitalize = (w: string): string =>
  w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : "";

/** ALL CAPS / lower / Mixed → Sentence Case per word, keeping apostrophe casing (O'Brien). */
export function titleCase(s: unknown): string {
  const str = String(s ?? "");
  if (!str) return "";
  return words(str).map((w) => (w.includes("'") ? w.split("'").map(capitalize).join("'") : capitalize(w))).join(" ");
}

/** The three database-held maps `core/member_names.py` reads. All empty by default. */
export type NameConfig = {
  roster: string[];                      // dropdowns.get("team_members")
  nicknames: Record<string, string>;     // {nickname: formal}, both lowercased
  aliases: Record<string, string>;       // {shortform: "Canonical Full Name"}, key lowercased
};

export const EMPTY_NAME_CONFIG: NameConfig = { roster: [], nicknames: {}, aliases: {} };

export function createNames(cfg: NameConfig) {
  const { roster, nicknames, aliases } = cfg;

  /** Lowercase token SET: honorifics dropped, nicknames expanded to their formal form. */
  function tokenizeName(s: unknown): Set<string> {
    const out = new Set<string>();
    for (const tok of words(stripHonorifics(s).toLowerCase().replace(/-/g, " "))) {
      out.add(nicknames[tok] ?? tok);
    }
    return out;
  }

  const isSubset = (a: Set<string>, b: Set<string>): boolean => {
    for (const x of a) if (!b.has(x)) return false;
    return true;
  };

  /**
   * A raw name string to the canonical team-member name. Resolution order, from the Python:
   * strip + title-case, whole-string alias, exact roster match, token subset (either
   * direction), longest-roster tie-break, else the tidied input unchanged.
   *
   * Empty, or a value that was nothing but a title, is "(unknown)" so it still buckets.
   */
  function normalizeMemberName(raw: unknown): string {
    if (raw === null || raw === undefined) return "(unknown)";
    const s = stripHonorifics(String(raw).trim());
    if (!s) return "(unknown)";
    const tidy = titleCase(s);
    if (roster.length === 0) return tidy;

    // Before the exact-match shortcut: a first-name-only mention must roll up to a specific
    // person even when that first name is also a roster entry in its own right.
    const aliasTarget = aliases[tidy.toLowerCase()];
    if (aliasTarget) {
      for (const c of roster) if (c.toLowerCase() === aliasTarget.toLowerCase()) return c;
      // Not on the roster — returned anyway so the rollup still happens.
      return aliasTarget;
    }
    for (const c of roster) if (c.toLowerCase() === tidy.toLowerCase()) return c;

    const input = tokenizeName(tidy);
    if (input.size === 0) return tidy;
    const matches: string[] = [];
    for (const c of roster) {
      const ct = tokenizeName(c);
      if (ct.size === 0) continue;
      if (isSubset(input, ct) || isSubset(ct, input)) matches.push(c);
    }
    if (matches.length) {
      // Prefer the fully-specified form: "First Last" beats "First".
      matches.sort((a, b) => (tokenizeName(b).size - tokenizeName(a).size)
        || (a < b ? -1 : a > b ? 1 : 0));
      return matches[0];
    }
    return tidy;
  }

  /**
   * A comma-separated name, or a Postgres text[] array, to a flat list of canonical names.
   * A list element that itself contains commas is split too — common where a form submission
   * packed two names into one entry. "(unknown)" results are dropped; they only arise from
   * empty input.
   */
  function splitAndNormalizeNames(value: unknown): string[] {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value.flatMap((v) => splitAndNormalizeNames(v));
    return String(value).split(",").map((p) => p.trim()).filter(Boolean)
      .map((p) => normalizeMemberName(p))
      .filter((n) => n && n !== "(unknown)");
  }

  /**
   * {canonical name → chart label}: first names, full names only where truly ambiguous.
   *
   * Sharing a first name is not the same as being different people: the data holds the same
   * person written both ways, short on one row and full on another. So the question is how
   * many DISTINCT fuller forms a first name has. One means one person written at different
   * lengths, and because this map is applied BEFORE the group-by, their bars merge into the
   * single person they are. Two or more means genuinely different people, and only then is
   * the full name needed.
   */
  function firstNameDisplayMap(names: Iterable<string>): Record<string, string> {
    const canonical = [...new Set(names)].filter((n) => n && n !== "(unknown)");
    const byFirst = new Map<string, string[]>();
    for (const name of canonical) {
      // Honorific-aware: "Prof <name>".split()[0] is "Prof", which labelled a titled person
      // with the courtesy word instead of their name.
      const bare = stripHonorifics(name) || name;
      const first = words(bare)[0];
      if (first === undefined) continue;
      const list = byFirst.get(first) ?? [];
      list.push(name);
      byFirst.set(first, list);
    }
    const display: Record<string, string> = {};
    for (const [first, group] of byFirst) {
      const fuller = new Set(group.map((n) => stripHonorifics(n) || n).filter((n) => words(n).length > 1));
      for (const n of group) {
        display[n] = fuller.size <= 1 ? first : (stripHonorifics(n) || n);
      }
    }
    display["(unknown)"] = "(unknown)";   // passed through so it still groups
    return display;
  }

  return { normalizeMemberName, splitAndNormalizeNames, firstNameDisplayMap, tokenizeName };
}

// ── Reading the three maps out of the database ───────────────────────────────

function parseMap(raw: unknown, lowercaseValues: boolean): Record<string, string> {
  if (raw === null || raw === undefined || raw === "") return {};
  let data: unknown;
  try {
    data = JSON.parse(String(raw));
  } catch {
    return {};   // malformed degrades to "leave the input alone", never to an error
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const key = String(k).trim().toLowerCase();
    const val = String(v ?? "").trim();
    if (key && val) out[key] = lowercaseValues ? val.toLowerCase() : val;
  }
  return out;
}

/**
 * Load the name config for one tenant.
 *
 * `team_members_json` is TENANT-SCOPED (`_TENANT_SCOPED_KEYS` in core/settings.py). The
 * routing has two halves and both matter:
 *
 *   * WITH a tenant, `tenant_settings` answers with NO fallback to the global store, so a
 *     fresh tenant gets an empty roster rather than another organisation's team.
 *   * WITHOUT one, `_scoped_store` returns None and the GLOBAL `app_settings` row answers —
 *     which is the single-tenant deployment, where there is no tenant store to read. Reading
 *     only `tenant_settings` would leave every such deployment with an empty roster, and an
 *     empty roster makes `normalize_member_name` return the tidied input unchanged: names
 *     stop collapsing onto their canonical form and one person spreads across several bars.
 *
 * The nickname and alias maps are global in both cases.
 *
 * "Other" is appended to the roster exactly as `core/dropdowns.py` does, so the forms'
 * "Other → specify" path stays a roster entry and normalises to itself.
 */
export async function loadNameConfig(db: Db, tenantId: string | null): Promise<NameConfig> {
  const [nickRows, aliasRows, rosterRows] = await Promise.all([
    db.service.get("app_settings", `select=value&key=eq.${q("member_nicknames_json")}&limit=1`).catch(() => []),
    db.service.get("app_settings", `select=value&key=eq.${q("member_name_aliases_json")}&limit=1`).catch(() => []),
    tenantId
      ? db.service.get("tenant_settings",
          `select=value&tenant_id=eq.${q(tenantId)}&key=eq.${q("team_members_json")}&limit=1`).catch(() => [])
      : db.service.get("app_settings",
          `select=value&key=eq.${q("team_members_json")}&limit=1`).catch(() => []),
  ]);
  let roster: string[] = [];
  const rawRoster = (rosterRows as Record<string, unknown>[])[0]?.value;
  if (rawRoster) {
    try {
      const parsed = JSON.parse(String(rawRoster));
      if (Array.isArray(parsed)) roster = parsed.map((x) => String(x).trim()).filter(Boolean);
    } catch { /* unset or malformed → empty roster, names left as typed */ }
  }
  if (roster.length && !roster.includes("Other")) roster.push("Other");
  return {
    roster,
    nicknames: parseMap((nickRows as Record<string, unknown>[])[0]?.value, true),
    aliases: parseMap((aliasRows as Record<string, unknown>[])[0]?.value, false),
  };
}
