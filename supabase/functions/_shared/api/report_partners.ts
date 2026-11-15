/**
 * Splitting an applicant cell into the organisations it names — a port of
 * `core/partner_names.py`.
 *
 * A `lead_applicant` / `sub_applicant` cell can name several organisations that applied
 * jointly on one grant, separated by ";" or ",". Counting partners means splitting on those
 * separators — but one organisation's own name can CONTAIN one, and then the split invents a
 * partner that does not exist. Two shapes are known:
 *
 *   * a legal-entity suffix after a comma — "Westvale Media Labs, Inc."
 *   * an abbreviation after a separator — "Northline Statistics Group Inc.; (NSG)", which
 *     split into two bars, one a bare "(NSG)". The same name written WITHOUT a separator was
 *     never affected, which is what makes the separator the culprit, not the parentheses.
 *
 * Both are handled by RE-ATTACHING rather than by weakening the separator rule: the split
 * still happens on every ";" and ",", and a piece is only glued back when it is recognisably
 * part of the name before it. Anything unrecognised stays its own organisation, so an
 * unfamiliar shape is over-counted — visible and correctable — rather than silently merged.
 */

/** Blank-equivalents. "N/A" is a real value a person typed; it is still not an applicant. */
export const NA_VALUES = new Set([
  "n/a", "na", "not applicable", "none", "nil", "tbd", "-", "—", "nan",
]);

/** Legal-entity suffixes that follow a COMMA inside one org name. */
const LEGAL_SUFFIX = /^(inc|llc|l\.l\.c|ltd|co|corp|pbc|gmbh|s\.?a|plc|llp|pte|bv|ag|nv|limited|incorporated|company)\.?$/i;

/** A parenthesised abbreviation standing alone as a split piece: "(NSG)", "( NSG )". */
const PAREN_ACRONYM = /^\(\s*([A-Za-z0-9&.\-]{2,12})\s*\)$/;

/** A trailing parenthesised abbreviation still attached to its name. */
const TRAILING_ACRONYM = /\s*\(\s*([A-Za-z0-9&.\-]{2,12})\s*\)\s*$/;

/** Words an abbreviation skips. "Institute OF Statistics" abbreviates to IS, not IOS. */
const ACRONYM_SKIP = new Set([
  "of", "and", "the", "for", "in", "on", "at", "to", "a", "an", "&",
  "de", "du", "des", "la", "le", "les", "el", "y",
]);

const words = (name: unknown): string[] =>
  String(name ?? "").split(/[^A-Za-z0-9&]+/).filter(Boolean);

/**
 * The abbreviations `name` could reasonably produce.
 *
 * A legal suffix may or may not be counted — "Northline Statistics Group Inc." is written
 * both NSG and NSGI — so both readings are accepted. Nothing else is guessed.
 */
function initialVariants(name: string): Set<string> {
  const ws = words(name);
  const out = new Set<string>();
  if (!ws.length) return out;
  for (const dropSuffix of [true, false]) {
    const picked: string[] = [];
    for (const w of ws) {
      if (ACRONYM_SKIP.has(w.toLowerCase())) continue;
      if (dropSuffix && LEGAL_SUFFIX.test(w)) continue;
      picked.push(w[0].toUpperCase());
    }
    if (picked.length >= 2) out.add(picked.join(""));
  }
  return out;
}

const letters = (token: unknown): string =>
  String(token ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/**
 * True when `token` abbreviates `name`. This is the test that lets a split piece be
 * re-attached, so it is deliberately strict: initials must match exactly. A piece that
 * merely looks short and shouty stays its own organisation.
 */
export function isAcronymOf(token: string, name: string): boolean {
  const l = letters(token);
  return !!l && initialVariants(name).has(l);
}

/**
 * Drop a trailing "(ABC)" when it abbreviates the rest of the name, else leave it.
 *
 * Needed for IDENTITY, not display: once "Org Full Name; (OFN)" is re-attached, the result
 * must still be recognisable as the deploying org's own name, or canonicalisation misses it
 * and the org gets a second bar of its own.
 */
export function stripTrailingAcronym(name: unknown): string {
  const s = String(name ?? "").trim();
  const m = TRAILING_ACRONYM.exec(s);
  if (!m) return s;
  const base = s.slice(0, m.index).trim();
  return base && isAcronymOf(m[1], base) ? base : s;
}

/** Split on ";" / "," and re-attach the pieces that belong to the name before them. */
export function splitPieces(value: unknown): string[] {
  const merged: string[] = [];
  for (const raw of String(value ?? "").split(/[;,]/)) {
    const piece = raw.trim();
    if (!piece) continue;
    if (merged.length && LEGAL_SUFFIX.test(piece)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}, ${piece}`;
      continue;
    }
    const m = PAREN_ACRONYM.exec(piece);
    if (merged.length && m && isAcronymOf(m[1], merged[merged.length - 1])) {
      // Re-attached with a SPACE, not the original separator, so it reads the way the same
      // organisation reads when it was never split: "Name (ABC)".
      merged[merged.length - 1] = `${merged[merged.length - 1]} (${m[1]})`;
      continue;
    }
    merged.push(piece);
  }
  return merged;
}

/** The deploying organisation's own names, as `settings.get_org` resolves them. */
export type OrgIdentity = { full: string; short: string };

/**
 * `views/report.py::_norm_org` — one organisation name, canonicalised.
 *
 * Hyphens become spaces and whitespace collapses before anything else, so a hyphenated or
 * double-spaced spelling of the deploying org still matches. Blank and the NA values are
 * dropped: neither is an applicant.
 *
 * The three canonicalisations all fold onto the org's FULL name, and only that org's:
 * its short name, a whitespace/hyphen/case variant of the full name, and the bare leading
 * acronym. A qualified sibling — two tokens — is deliberately left alone.
 */
export function normOrg(raw: unknown, org: OrgIdentity): string {
  const s = String(raw ?? "").replace(/-/g, " ").replace(/\s+/g, " ").trim();
  if (!s || NA_VALUES.has(s.trim().toLowerCase())) return "";
  // Canonicalise on the name WITHOUT its own trailing abbreviation, so the deploying org
  // still resolves to one bar when its cell was written "Full Name; (FN)" and the splitter
  // re-attached the abbreviation.
  const low = stripTrailingAcronym(s).toLowerCase();
  const fullKey = org.full.replace(/-/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const first = org.full ? org.full.split(/\s+/)[0].toLowerCase() : "";
  if (org.short && low === org.short.toLowerCase()) return org.full || s;
  if (org.full && low === fullKey) return org.full;
  if (first && low === first) return org.full;
  return s;
}

/** `_split_orgs` — the distinct organisations one cell names, sorted. */
export function splitOrgs(value: unknown, org: OrgIdentity): string[] {
  const set = new Set<string>();
  for (const p of splitPieces(value)) {
    const o = normOrg(p, org);
    if (o) set.add(o);
  }
  return [...set].sort();
}
