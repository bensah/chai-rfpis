/**
 * The tenant's effective scan policies, and the rail's preference profile — ports of
 * core/policies.get_policies and views/opportunity_rail._tenant_prefs.
 *
 * Only the slice the rail reaches is here. `geographic_exclusion_reject` wants
 * `countries.eligible` / `countries.broad_terms`; the Featured card's ranking wants those
 * plus `themes.required_any`. Nothing else in DEFAULT_POLICIES is consulted by either, so
 * nothing else is ported — the full policy document stays Python's.
 *
 * The seeding matters as much as the stored value. A tenant that never configured a scan
 * policy still gates on its own profile: its registered and operating countries become the
 * geographic scope, and its programme-area categories become the theme scope. Skipping
 * that would hand the gate an empty org set, which short-circuits to "defer" and quietly
 * turns the gate off for exactly the tenants that have not configured one.
 */
import { COUNTRY_CANON } from "./geo_tables.ts";
import {
  PROGRAM_AREA_KEYWORDS, KEYS_BY_CATEGORY, KEYS_BY_SUBLABEL, THEME_UMBRELLAS,
  HEALTH_THEME_PREFIXES, DEFAULT_HEALTH_THEMES, EDU_THEMES,
} from "./policy_tables.ts";

type Json = Record<string, unknown>;

const str = (v: unknown) => (v == null ? "" : String(v));
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export type Policies = {
  countries: { eligible: string[]; broad_terms: string[] };
  themes: { required_any: string[] };
};

/** core/geographies.canonical_geo, for a profile-supplied country name. The generated map
 * is keyed by the forms the country matcher produces, which covers the long/official names
 * a profile can hold; anything else is free text and passes through unchanged. */
const canonicalCountry = (c: string) => COUNTRY_CANON[c.trim().toLowerCase()] ?? c;

/** core/policies._profile_geo_eligible — the tenant's OWN geographies, canonicalised and
 * deduped. An empty profile stays permissive (Option C). */
export function profileGeoEligible(profile: Json | null): string[] {
  const raw = [...list(profile?.org_registered_countries),
    ...list(profile?.org_operating_countries)];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    const cc = canonicalCountry(str(c)) || str(c);
    const k = str(cc).trim().toLowerCase();
    if (cc && !seen.has(k)) {
      seen.add(k);
      out.push(cc);
    }
  }
  return out;
}

/** core/program_area_classifier.expand — a mix of category names, canonical keys and bare
 * sub-labels, widened to the set of canonical sub-area keys. */
function expandAreas(selections: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const sel of selections) {
    const s = str(sel).trim();
    if (s in PROGRAM_AREA_KEYWORDS) out.add(s);
    else if (s in KEYS_BY_CATEGORY) for (const k of KEYS_BY_CATEGORY[s]) out.add(k);
    else if (s in KEYS_BY_SUBLABEL) for (const k of KEYS_BY_SUBLABEL[s]) out.add(k);
  }
  return out;
}

/**
 * core/policies._profile_theme_keywords.
 *
 * Derives at the CATEGORY level plus a broad umbrella term per family, so a call anywhere
 * in the org's categories still matches and only clearly off-category calls fail. It errs
 * toward KEEP on purpose — a theme gate must not hide a relevant call.
 */
export function profileThemeKeywords(profile: Json | null): string[] {
  const codes = new Set<string>();
  for (const f of ["org_domain_expertise", "org_priority_areas"]) {
    for (const a of list(profile?.[f])) if (str(a).trim()) codes.add(str(a).trim());
  }
  for (const f of ["org_domain_ratings", "org_priority_ratings"]) {
    const r = profile?.[f];
    if (r && typeof r === "object" && !Array.isArray(r)) {
      for (const k of Object.keys(r)) if (k.trim()) codes.add(k.trim());
    }
  }
  if (!codes.size) return [];

  const canon = expandAreas(codes);
  const prefixes = new Set<string>();
  for (const k of canon) {
    if (k.includes(" - ")) prefixes.add(k.split(" - ")[0].trim());
  }
  if (!prefixes.size) return [];

  const kws = new Set<string>();
  for (const [area, bag] of Object.entries(PROGRAM_AREA_KEYWORDS)) {
    if (prefixes.has(area.split(" - ")[0].trim())) for (const k of bag) kws.add(str(k));
  }
  // Any health prefix pulls in the FULL default health vocabulary, so a Malaria-only org
  // still matches an adjacent Diagnostics or Research call.
  if (HEALTH_THEME_PREFIXES.some((p) => prefixes.has(p))) {
    for (const k of DEFAULT_HEALTH_THEMES) kws.add(k);
  }
  if (prefixes.has("EDU")) for (const k of EDU_THEMES) kws.add(k);
  for (const [pfx, terms] of Object.entries(THEME_UMBRELLAS)) {
    if (prefixes.has(pfx)) for (const t of terms) kws.add(t);
  }
  return [...kws].filter(Boolean).sort();
}

/**
 * core/policies.get_policies, for a SCOPED tenant — which every tenant reaching this API
 * is, by core/policies._is_scoped_tenant's own test (a caller that names a tenant is
 * scoped by definition).
 *
 * That branch matters: a scoped tenant merges its saved policy onto a NEUTRAL base, never
 * onto DEFAULT_POLICIES. Merging onto the shipped defaults is what once made a tenant that
 * had chosen no scope silently inherit another org's country and health list — and that
 * non-empty geo then blocked the profile seeding below.
 */
export function getPolicies(rawPolicy: string | null, profile: Json | null): Policies {
  let countries = { eligible: [] as string[], broad_terms: [] as string[] };
  let themes = { required_any: [] as string[] };

  if (rawPolicy) {
    try {
      const overlay = JSON.parse(rawPolicy);
      if (overlay && typeof overlay === "object" && !Array.isArray(overlay)) {
        const c = (overlay.countries ?? {}) as Json;
        countries = {
          eligible: list(c.eligible).map(str).filter(Boolean),
          broad_terms: list(c.broad_terms).map(str).filter(Boolean),
        };
        const t = overlay.themes;
        const req = t && typeof t === "object" && !Array.isArray(t)
          ? (t as Json).required_any : t;
        themes = { required_any: list(req).map(str).filter(Boolean) };
      }
    } catch {
      // Unparseable saved policy → the neutral base, same as Python's except branch.
    }
  }

  // Seed geo from the profile when the policy set NEITHER countries NOR regions. The
  // seeder no-ops on an explicit scope (including a deliberate region-only one), so an
  // admin's choice always wins.
  if (!countries.eligible.length && !countries.broad_terms.length) {
    const seeded = profileGeoEligible(profile);
    if (seeded.length) countries = { ...countries, eligible: seeded };
  }
  if (!themes.required_any.length) {
    const kws = profileThemeKeywords(profile);
    if (kws.length) themes = { required_any: kws };
  }
  return { countries, themes };
}

/**
 * views/opportunity_rail._tenant_prefs — what this tenant SAYS it wants plus what it
 * actually DOES.
 *
 * `pursuedAreas` and the funders drawn from Proceed rows are 28% of what Featured ranks
 * by, which is why the feed route selects call_domain_areas alongside the rest: the
 * Streamlit rail makes a second query for them, and leaving the column out silently
 * emptied this.
 */
export function tenantPrefs(policies: Policies, profile: Json | null, pipeline: Json[]) {
  const knownFunders = [
    ...list(profile?.org_engaged_donors).map(str),
    ...list(profile?.org_active_donors).map(str),
  ];
  const pursuedAreas: string[] = [];
  for (const r of pipeline ?? []) {
    if (!str(r.decision).toLowerCase().startsWith("proceed")) continue;
    if (r.funding_agency) knownFunders.push(str(r.funding_agency));
    for (const a of list(r.call_domain_areas)) if (a) pursuedAreas.push(str(a));
  }
  return {
    countries: policies.countries.eligible,
    broad_terms: policies.countries.broad_terms,
    themes: policies.themes.required_any,
    pursued_areas: pursuedAreas,
    known_funders: knownFunders.filter(Boolean),
  };
}
