/**
 * Settings → Setup → Scan Preferences — the rules. `views/org_setup.py`'s `_stab`.
 *
 * WHAT THIS DECIDES. These policies run at SCAN time, before scoring: an opportunity that
 * fails the country or theme gate is never inserted, so it is not a low score a reviewer
 * can argue with — it does not exist. Getting the geography wrong here is the difference
 * between an organisation seeing its own region and seeing nothing, and nothing on any
 * screen explains an opportunity that was never captured.
 *
 * THE SAVE REPLACES THE WHOLE DOCUMENT. `set_policies` "stores the FULL blob (not a
 * delta) for simplicity", so what `policyPayload` returns IS the stored policy. The
 * editor writes five of the six top-level keys and omits `scoring_rules` — and that is
 * safe ONLY because `_blank_policies()` carries the same funding-quality tiers, so the
 * merge on the way back restores them. Make the base truly blank and every save would
 * silently reset the tiers. `check-scan-prefs` pins exactly that, because it is the kind
 * of safety that holds by accident until somebody tidies the base.
 *
 * THE GEO SEED IS APPLIED ON SAVE, NOT ONLY ON READ, and the Python explains why in as
 * many words: "Never PERSIST a geo-empty policy for a tenant that HAS a geography in its
 * profile — a saved blank scope would otherwise read as 'see everything'." An empty scope
 * is permissive, so leaving the form blank would turn the hard gate off for the tenants
 * most likely to leave it blank.
 */
import { profileGeoEligible } from "./policies.ts";
import { CRITERIA } from "./scorer.ts";

type Json = Record<string, unknown>;
type Row = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const bool = (v: unknown, dflt: boolean): boolean =>
  (v === undefined || v === null ? dflt : (v === true || v === "true" || v === 1));

/** A multi-select's value: strings, trimmed, blanks dropped, order kept. */
export function terms(v: unknown): string[] {
  if (typeof v === "string") {
    // The Python's own defensive branch: an older session could hold a textarea string
    // where a list belongs, and splitting it is kinder than storing one long "term".
    return v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  }
  return (Array.isArray(v) ? v : []).map((x) => s(x).trim()).filter(Boolean);
}

/** The five top-level keys the editor writes, in the Python's own order and defaults. */
export const POLICY_KEYS = [
  "countries", "themes", "exclusions", "eligibility", "criteria",
] as const;

/**
 * The key the editor does NOT write.
 *
 * Named rather than implied: it survives a save only because the base it merges onto
 * carries it, and a reader of this file should be able to see that claim and go and check
 * it rather than discover it from a reset tier.
 */
export const POLICY_KEY_NOT_WRITTEN = "scoring_rules";

/**
 * The whole policy document, from what the form sent.
 *
 * Every boolean defaults TRUE, as the Streamlit widgets do — these are REJECT rules, and
 * a missing value defaulting to false would quietly admit the thing the rule exists to
 * exclude. A client that omits a key gets the safe answer, not the permissive one.
 */
export function policyPayload(form: Json): Row {
  const src = (form && typeof form === "object" ? form : {}) as Json;
  const criteria: Row = {};
  for (const c of CRITERIA) {
    const rule = ((src.criteria as Json | undefined)?.[c] ?? {}) as Json;
    criteria[c] = { positive: terms(rule.positive), negative: terms(rule.negative) };
  }
  const countries = (src.countries ?? {}) as Json;
  const themes = (src.themes ?? {}) as Json;
  const exclusions = (src.exclusions ?? {}) as Json;
  const eligibility = (src.eligibility ?? {}) as Json;
  return {
    countries: {
      eligible: terms(countries.eligible),
      broad_terms: terms(countries.broad_terms),
      permissive_when_silent: bool(countries.permissive_when_silent, true),
    },
    themes: {
      required_any: terms(themes.required_any),
      excluded_any: terms(themes.excluded_any),
    },
    exclusions: {
      reject_training_only: bool(exclusions.reject_training_only, true),
      reject_loans: bool(exclusions.reject_loans, true),
      reject_consultancies: bool(exclusions.reject_consultancies, true),
      reject_reimbursement: bool(exclusions.reject_reimbursement, true),
    },
    eligibility: {
      // The Python's `or ["nonprofit"]`: an empty applicant-type list would match no
      // call's eligible-applicant rule at all, which rejects everything rather than
      // nothing — the opposite of what an admin clearing a field expects.
      org_applicant_types: terms(eligibility.org_applicant_types).length
        ? terms(eligibility.org_applicant_types) : ["nonprofit"],
      reject_applicant_type_mismatch: bool(eligibility.reject_applicant_type_mismatch, true),
    },
    criteria,
  };
}

/**
 * `core/policies._seed_geo_from_profile`, applied to what is about to be SAVED.
 *
 * No-op when any geographic scope is set — countries OR regions — because an explicit
 * region-only scope is a deliberate choice the seeder must not overwrite. No-op too when
 * the profile has no countries, which leaves the policy permissive rather than inventing
 * a scope nobody chose.
 */
export function seedGeo(policy: Row, profile: Json | null): Row {
  const c = (policy.countries ?? {}) as Json;
  if (terms(c.eligible).length || terms(c.broad_terms).length) return policy;
  const seeded = profileGeoEligible(profile);
  if (!seeded.length) return policy;
  return { ...policy, countries: { ...c, eligible: seeded } };
}

/** The custom search terms, as `core/web_search` stores them: a JSON list of strings. */
export function searchTerms(v: unknown): string[] {
  return terms(v);
}

/**
 * The alternate spellings of one currency row, canonical key first.
 *
 * `core/dropdowns.currency_aliases`. The key is `aliases` — the YAML writes it, the
 * stored `currencies_json` holds it and money.ts reads it — but the Settings editor spent
 * a while writing `donor_aliases`, so any deployment that pressed Save holds rows in that
 * shape. Both are read; only `aliases` is written.
 *
 * THESE ARE NOT DECORATION. They are how a call quoting "£" or "FCFA" is matched to a
 * rate at all: neither string appears in any code or label, and the first-token fallback
 * cannot match a bare symbol. A row saved without them converts at 1.0 — a pound counted
 * as a dollar, with nothing on screen to say so.
 */
export function aliasesOf(row: unknown): string[] {
  if (!row || typeof row !== "object" || Array.isArray(row)) return [];
  const r = row as Json;
  const raw = (Array.isArray(r.aliases) && r.aliases.length) ? r.aliases : r.donor_aliases;
  return (Array.isArray(raw) ? raw : []).map((x) => s(x).trim()).filter(Boolean);
}

/**
 * The currency table, as `settings.set_currency_overrides` stores it.
 *
 * THE WHOLE ROW SURVIVES — code, label, symbol, aliases, rate. The stored list REPLACES
 * the YAML wholesale (`data = {**data, "currencies": overrides}`), so it is the only copy
 * once a deployment has one, and a field this function forgets is a field gone from the
 * deployment. Aliases are the dangerous one, for the reason above.
 *
 * A rate is "how many USD one unit converts to", so it must be POSITIVE: a zero or
 * negative rate converts every amount in that currency to zero or to nonsense, and every
 * award-size comparison downstream agrees without complaint. A row that cannot supply one
 * is dropped rather than stored, and the route reports how many.
 */
export function currencyRows(v: unknown): { rows: Row[]; dropped: number } {
  const out: Row[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of (Array.isArray(v) ? v : [])) {
    if (!raw || typeof raw !== "object") { dropped++; continue; }
    const r = raw as Json;
    // Codes are upper-cased: they are matched against a call's own currency field, which
    // is written "USD", and "usd" would match nothing while looking right.
    const code = s(r.code).trim().toUpperCase();
    const rate = Number(r.usd_rate);
    if (!code || seen.has(code) || !Number.isFinite(rate) || rate <= 0) { dropped++; continue; }
    seen.add(code);
    out.push({
      code,
      label: s(r.label).trim() || code,
      // null, not "", because that is what the Python writes for a blank symbol and what
      // the stored rows hold — an empty string would read as a symbol that is nothing.
      symbol: s(r.symbol).trim() || null,
      aliases: aliasesOf(r),
      usd_rate: rate,
    });
  }
  return { rows: out, dropped };
}
