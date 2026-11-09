/**
 * The org's hard geographic gate — a port of core/auto_scorer.geographic_exclusion_reject.
 *
 * The opportunity rail used to run this inside the browser's Pyodide engine, against the
 * repo's own Python. With the rail moving server-side it has to exist in TypeScript, so
 * this is a DELIBERATE port: every function below names the Python symbol it mirrors, the
 * ~400 lines of geography tables it reads are GENERATED from that Python
 * (scripts/gen_geo_tables.py → geo_tables.ts) rather than retyped, and
 * web/scripts/parity/check-scoring.mjs runs the two side by side over the live database.
 *
 * Measured before porting (2026-11-09, all six active tenants): the gate rejects ZERO rows
 * today. That is a reason to port it faithfully and let parity keep proving it rejects
 * zero — not a reason to drop it. The day a tenant's policies change, it has to be here.
 */
import {
  REGION_MEMBERS, COUNTRY_CANON, KNOWN_COUNTRIES, PLACE_TOKENS, DEMONYM_TO_PLACE,
  REGION_VARIANT_PAIRS, DEV_TIER_VARIANTS, INCOME_TIERS,
} from "./geo_tables.ts";

type Json = Record<string, unknown>;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const str = (v: unknown) => (v == null ? "" : String(v));

/** core/auto_scorer._normalize */
const normalize = (s: unknown) => str(s).toLowerCase();

/**
 * JavaScript's \b is ASCII-only, so it does not fire correctly beside the accented and
 * apostrophised names in this vocabulary — "Côte d'Ivoire", "São Tomé and Príncipe".
 * These lookarounds over a Unicode letter class stand in for the boundary Python's `re`
 * gives for free.
 */
const WB_L = "(?<![\\p{L}\\p{N}_])";
const WB_R = "(?![\\p{L}\\p{N}_])";
const word = (v: string, flags = "giu") => new RegExp(`${WB_L}(?:${esc(v)})${WB_R}`, flags);

/** core/geographies.expand — the labels themselves plus any member countries, lowercased. */
export function expand(selection: unknown[]): Set<string> {
  const out = new Set<string>();
  for (const item of selection ?? []) {
    const s = str(item).trim();
    if (!s) continue;
    out.add(s.toLowerCase());
    for (const c of REGION_MEMBERS[s.toLowerCase()] ?? []) out.add(c.toLowerCase());
  }
  return out;
}

/** core/geographies.canonical_geo, over exactly the forms the country matcher produces. */
const canonical = (m: string) => COUNTRY_CANON[m.toLowerCase()] ?? m;

// core/auto_scorer._COUNTRY_PATTERN — longest-first, so "Mali" cannot win inside "Somalia".
const COUNTRY_RE = new RegExp(
  `${WB_L}(${KNOWN_COUNTRIES.map(esc).join("|")})${WB_R}`, "giu");

/** Canonical countries named in `text`, plus the raw matched forms (which the gate blanks
 * out of the text before it looks for regions). */
function countriesIn(text: string): { canon: Set<string>; raw: string[] } {
  const raw: string[] = [];
  const canon = new Set<string>();
  for (const m of text.matchAll(COUNTRY_RE)) {
    raw.push(m[1]);
    canon.add(canonical(m[1]).toLowerCase());
  }
  return { canon, raw };
}

/** core/auto_scorer._geo_text — title + description + scope + theme, and deliberately NOT
 * the funder name ("African Development Bank" must not make a call Africa-wide). */
export function geoText(c: Json): string {
  const scope = Array.isArray(c.call_geographic_scope)
    ? (c.call_geographic_scope as unknown[]).map(str).join(" ")
    : str(c.call_geographic_scope);
  return normalize([str(c.opportunity_title), str(c.brief_description), scope,
    str(c.focus_theme)].join(" "));
}

// core/auto_scorer._INCLUSIVE_ELIGIBILITY_PATTERN
const INCLUSIVE_RE = new RegExp(
  "(?:" +
  "(?:foreign|international|non[\\-\\s]*u\\.?s\\.?)\\s+and\\s+domestic" +
  "|domestic\\s+and\\s+(?:foreign|international|non[\\-\\s]*u\\.?s\\.?)" +
  "|foreign\\s+(?:organizations?|entities|applicants?|institutions?)\\s+(?:are\\s+)?eligible" +
  "|non[\\-\\s]*domestic\\s+(?:entities|organizations?|applicants?)?\\s*(?:are\\s+)?eligible" +
  "|non[\\-\\s]*u\\.?s\\.?\\s+(?:entities|organizations?|applicants?)\\s+(?:are\\s+)?eligible" +
  "|international\\s+(?:applicants?|organizations?|entities)\\s+(?:are\\s+)?(?:welcomed?|eligible|accepted)" +
  "|open\\s+to\\s+(?:applicants?\\s+from\\s+)?(?:any|all)\\s+countr" +
  "|worldwide\\s+eligibility" +
  "|globally\\s+eligible" +
  "|applicants?\\s+from\\s+(?:any|all)\\s+countr" +
  ")", "i");

/** core/auto_scorer._has_inclusive_eligibility */
export const hasInclusiveEligibility = (text: string) => INCLUSIVE_RE.test(text ?? "");

// core/auto_scorer._EXCLUSIVITY_RE, global so the port can walk every match the way
// Python's finditer does.
const EXCLUSIVITY_SRC =
  "(only (?:open |available )?to|open only to|restricted to|limited to" +
  "|reserved for|exclusively (?:for|to|open)|specific to" +
  "|must be (?:based|located|registered|headquartered|incorporated|established) in" +
  "|applicants? must be (?:from|based in|located in)|eligibility is limited to" +
  "|-based\\s+(?:researchers?|institutions?|organi[sz]ations?|applicants?|entities|" +
  "companies|teams)[^.]{0,25}?\\bonly)";

// core/auto_scorer._PLACE_RE
const PLACE_RE = new RegExp(`${WB_L}(${PLACE_TOKENS.map(esc).join("|")})${WB_R}`, "iu");

// core/auto_scorer._WORLDWIDE_RE
const WORLDWIDE_RE = new RegExp(
  `${WB_L}(?:globally|world\\s?wide|any country|all countries` +
  `|across the (?:globe|world)|open to all|all eligible countries` +
  `|regardless of (?:country|location)|international applicants?)${WB_R}`, "iu");

/** core/auto_scorer._dev_tier_mentioned — matches a tier's LABEL and synonyms only, never
 * its member countries, or any African country name would falsely register the LMIC tier.
 *
 * The Python anchors only the LEFT edge (`\b` then the variant, with no trailing
 * boundary), so a prefix match counts — "LMICs" fires on the variant "lmic". Mirrored. */
export function devTierMentioned(text: string): boolean {
  const tl = (text ?? "").toLowerCase();
  return DEV_TIER_VARIANTS.some((v) => new RegExp(`${WB_L}${esc(v)}`, "iu").test(tl));
}

/** core/auto_scorer._org_geo_set — the org's geographic ANCHOR. Eligible countries win
 * when set; only otherwise do the region broad-terms apply. Income tiers never anchor. */
export function orgGeoSet(policies: Json): Set<string> {
  const countries = (policies?.countries ?? {}) as Json;
  const eligible = ((countries.eligible ?? []) as unknown[]).filter((c) => !!c);
  if (eligible.length) return expand(eligible);
  const tiers = new Set(INCOME_TIERS);
  const broad = ((countries.broad_terms ?? []) as unknown[])
    .filter((b) => !!b && !tiers.has(str(b)));
  return expand(broad);
}

/** core/auto_scorer._place_in_org */
function placeInOrg(place: string, orgSet: Set<string>): boolean {
  const canon = DEMONYM_TO_PLACE[place.trim().toLowerCase()] ?? place;
  let members = expand([canon]);
  if (!members.size) members = new Set([canon.trim().toLowerCase()]);
  for (const m of members) if (orgSet.has(m)) return true;
  return false;
}

/** core/geographies.regions_in_text — longest variant first, consuming each span so
 * "sub-Saharan Africa" registers that subregion and the inner "africa" does not also
 * register the whole continent. */
export function regionsInText(textLower: string): Set<string> {
  const found = new Set<string>();
  let work = textLower;
  for (const [v, term] of REGION_VARIANT_PAIRS) {
    if (word(v).test(work)) {
      found.add(term);
      work = work.replace(word(v), " ");
    }
  }
  return found;
}

/** core/auto_scorer.title_countries — the call's own headline scope. */
export function titleCountries(c: Json): Set<string> {
  return countriesIn(normalize(str(c.opportunity_title))).canon;
}

/**
 * core/auto_scorer.geographic_exclusion_reject.
 *
 * A call is in scope only if its defined geography INCLUDES the org's country or region.
 * The decision order below is the Python's, step for step, because each one exists to beat
 * the step after it.
 */
export function geographicExclusionReject(c: Json, policies: Json): [boolean, string] {
  const orgSet = orgGeoSet(policies);
  if (!orgSet.size) return [false, ""];        // org geography unconfigured → defer
  const text = geoText(c);

  // 1. Exclusive-to-a-place restriction. Beats a passing in-region mention further down,
  //    e.g. a call that says "India-based … only" while also naming South Africa.
  for (const em of text.matchAll(new RegExp(EXCLUSIVITY_SRC, "gi"))) {
    const start = em.index ?? 0;
    const window = text.slice(Math.max(0, start - 30), start + em[0].length + 50);
    const pm = PLACE_RE.exec(window);
    if (pm && !placeInOrg(pm[1], orgSet)) {
      return [true, `geography: eligibility restricted to ${pm[1]} (outside org scope)`];
    }
  }

  // Country spans are blanked before region detection, so "South Africa" / "South Sudan"
  // cannot register a continent.
  const { canon: callCountries, raw } = countriesIn(text);
  let clean = text;
  for (const name of [...new Set(raw.map((m) => m.toLowerCase()))]
    .sort((a, b) => b.length - a.length)) {
    clean = clean.replace(word(name), " ");
  }
  const specificRegions = regionsInText(clean);

  // 1b. A country named in the TITLE is the call's headline scope and outranks every broad
  //     qualifier below it — an income tier is a property of the CALL, never of the tenant.
  const titleC = titleCountries(c);
  if (titleC.size) {
    for (const t of titleC) if (orgSet.has(t) || placeInOrg(t, orgSet)) return [false, ""];
    const sample = [...titleC].sort().slice(0, 3).join(", ");
    return [true, `geography: the title scopes this call to ${sample} (outside org scope)`];
  }

  // 2. A specific REGION is the hardest scope signal — it CONSTRAINS the call, and a
  //    development-tier word alongside is only a qualifier ("LMICs in Asia" is Asia-scoped).
  if (specificRegions.size) {
    const regionSet = new Set<string>();
    for (const r of specificRegions) for (const m of expand([r])) regionSet.add(m);
    for (const m of [...regionSet, ...callCountries]) if (orgSet.has(m)) return [false, ""];
    const sample = [...specificRegions].sort().slice(0, 3).join(", ");
    return [true, `geography: scope (${sample}) excludes the org's country/region`];
  }

  // 3. No specific region. Keep when the call is open to the org's development tier,
  //    worldwide, or to international applicants.
  if (hasInclusiveEligibility(text) || WORLDWIDE_RE.test(text) || devTierMentioned(text)) {
    return [false, ""];
  }

  // 4. No region, no tier, no worldwide — named countries constrain the scope.
  if (callCountries.size) {
    for (const m of callCountries) if (orgSet.has(m)) return [false, ""];
    const sample = [...callCountries].sort().slice(0, 3).join(", ");
    return [true, `geography: scope (${sample}) excludes the org's country`];
  }

  // 5. No geography at all → defer (country_eligible parks it).
  return [false, ""];
}
