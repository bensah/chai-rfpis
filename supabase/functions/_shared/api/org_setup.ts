/**
 * Settings → Setup — the rules behind the four tabs. `views/org_setup.py`.
 *
 * THIS IS THE WRITE SIDE OF `org.ts`, and the asymmetry decides how careful it has to be.
 * My Organization READS `tenants.org_identity` and `tenants.org_profile`; these tabs are
 * the only place either is authored. `core.auto_scorer` reads the same merged profile, so
 * every value stored here is a scoring input — and the failure mode of a wrong one is
 * silence. A legal type outside the vocabulary does not raise: it matches no call's
 * eligible-applicant rule, MUST-1 scores as though nobody answered, and the organisation
 * is marked down for a field it filled in.
 *
 * THREE SAVES, NOT ONE, because the Streamlit page has three buttons and they write
 * different places:
 *
 *   identity   `settings.set_org`    → tenants.org_identity, PARTIAL (merges onto the
 *                                      stored blob; unknown keys ignored)
 *   profile    `org_profile.set_profile` → tenants.org_profile, WHOLESALE (replaces the
 *                                      blob — see `profileFields`)
 *   team       `settings.set_team_members` → an app_settings key
 *
 * Folding them into one PUT would be tidier and wrong: a half-filled Bid Fitness tab
 * would then overwrite a complete identity, and the Streamlit app — still live, still
 * editing the same rows — would keep writing them separately.
 *
 * THE RENAME IS NOT COSMETIC. "Organization name" IS the tenant rename: `set_org` syncs
 * `tenants.name`, and `get_org` reports THAT column as org_name. A rename that fails
 * silently reads back as the old name and looks like the whole save was dropped, which is
 * why the Python raises `OrgRenameError` with the two causes separated — a duplicate name
 * is the admin's to fix, anything else is not. `renameOutcome` keeps that split.
 */
import {
  BOARD_OPTIONS, COFINANCING_LEVELS, DEFAULT_PROFILE, ENTITY_TYPES, LEGAL_TYPES,
  ORG_DEFAULTS, ORG_STAGES, PARTNER_STATUS, PARTNER_TYPES, ROUTE_OPTIONS,
} from "./org_vocab.ts";

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const trimmed = (v: unknown): string => s(v).trim();
const bool = (v: unknown): boolean => v === true || v === "true" || v === 1;

/** The profile key `set_profile` refuses to persist, because every read recomputes it. */
export const DERIVED_PROFILE_KEY = "org_user_declared_areas";

/** The identity keys the Profile tab writes — `_fields` in the editor's save block. */
export const IDENTITY_FIELDS = [
  "org_name", "org_short", "org_country", "org_team", "org_contact_email", "org_website",
  "org_is_us_entity", "org_has_local_board", "org_has_bd_team",
] as const;

/**
 * The identity keys the FIT tab also writes, derived from answers on that tab.
 *
 * `org_is_grassroot` and `org_is_multi_country` used to be their own checkboxes and are
 * now read off `org_entity_type`, so they are written as a consequence of it rather than
 * asked twice — the Python's comment calls entity type the single source of truth. They
 * stay in identity because that is where the competitiveness reads look for them.
 */
export const DERIVED_IDENTITY_FIELDS = [
  "org_is_grassroot", "org_is_multi_country", "org_hq_country",
] as const;

/**
 * The fields the Python verifies came back after a save, and ONLY when non-empty.
 *
 * `get_org` substitutes placeholders for blanks (`org_team` becomes "Business Development
 * Team"), so a deliberately CLEARED field reads back as its default. Checking it would
 * report a phantom failure on a save that did exactly what was asked.
 */
export const VERIFIED_FIELDS = [
  "org_name", "org_country", "org_team", "org_contact_email",
] as const;

// ── Identity (tab 1: Profile) ────────────────────────────────────────────────

/** Label on screen -> stored value for `org_has_local_board`; "" leaves MUST-4 off. */
export function boardValue(label: unknown): string {
  const hit = BOARD_OPTIONS.find(([l]) => l === trimmed(label));
  if (hit) return hit[1];
  // A value rather than a label is accepted too, so a client that sends what it was given
  // on the read round-trips. Anything else is the first option, which is what the
  // selectbox falls back to — and it is the one that leaves the gate off.
  const asValue = BOARD_OPTIONS.find(([, v]) => v === trimmed(label));
  return asValue ? asValue[1] : BOARD_OPTIONS[0][1];
}

/**
 * The nine identity fields, from what the form sent. `_fields` in the editor, verbatim:
 * every text field is `.strip()`ed and every checkbox becomes the STRING "true"/"false",
 * because `_ORG_DEFAULTS` is a dict of strings and `get_org` compares them as such.
 */
export function identityFields(form: Json): Record<string, string> {
  return {
    org_name: trimmed(form.orgName),
    org_short: trimmed(form.orgShort),
    org_country: trimmed(form.orgCountry),
    org_team: trimmed(form.orgTeam),
    org_contact_email: trimmed(form.orgEmail),
    org_website: trimmed(form.orgWebsite),
    org_is_us_entity: bool(form.usEntity) ? "true" : "false",
    org_has_local_board: boardValue(form.localBoard),
    org_has_bd_team: bool(form.bdTeam) ? "true" : "false",
  };
}

/**
 * `settings.set_org`'s own filter, applied to whatever a caller passes.
 *
 * Two rules, both from the Python loop: a key outside `_ORG_DEFAULTS` is IGNORED (so a
 * client cannot invent an identity field), and the value is `value or ""` — None and a
 * missing value both store the empty string rather than null, because every reader of
 * this blob treats it as a dict of strings.
 */
export function setOrgFields(fields: Json): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k in ORG_DEFAULTS) out[k] = s(v) || "";
  }
  return out;
}

/**
 * The identity blob after a partial save — the RAW stored blob with the accepted keys
 * replaced, which is `ident = dict(ident)` followed by `ident[key] = value` in the Python.
 *
 * TWO THINGS DEPEND ON IT BEING THE RAW BLOB. The logo lives in this same column under
 * `org_logo_b64`, so writing the merged-with-defaults identity back would be the only
 * save on the page that deletes a logo. And untouched keys are passed through UNCHANGED
 * rather than stringified: every key the editor writes happens to be a string today, and
 * coercing the rest would quietly rewrite anything that is not.
 */
export function mergedIdentity(stored: unknown, fields: Json): Row {
  const base: Row = (stored !== null && typeof stored === "object" && !Array.isArray(stored))
    ? { ...(stored as Row) } : {};
  return { ...base, ...setOrgFields(fields) };
}

/** The tenant rename "Organization name" implies, or null when the field was left blank. */
export function renameImplied(fields: Json): string | null {
  if (!("org_name" in fields)) return null;
  const name = trimmed(fields.org_name);
  return name || null;
}

/**
 * Which of the two `OrgRenameError` messages a failed rename deserves.
 *
 * The Python splits them because they ask different things of the admin: a name another
 * tenant already holds is theirs to change, and anything else is not. Reporting the wrong
 * one sends somebody to check RLS and the service-role key over a typo.
 */
export function renameOutcome(name: string, error: string): {
  duplicate: boolean; message: string;
} {
  const m = error.toLowerCase();
  const duplicate = m.includes("23505") || m.includes("duplicate key")
    || m.includes("already exists");
  return {
    duplicate,
    message: duplicate
      ? `Another organization is already named “${name}”. The organization name `
        + "doubles as this tenant's unique name, so choose a distinct one."
      : `Could not rename the organization to “${name}”: ${error}`,
  };
}

/**
 * The fields a save claimed to write that did not come back. `_bad` in the editor.
 *
 * Only non-empty submitted values are compared, for the reason on VERIFIED_FIELDS. The
 * check exists because the common failure here is not an exception: an RLS or wrong-key
 * write returns success and changes nothing, and without this the admin is told it saved.
 */
export function notPersisted(sent: Json, readBack: Json): string[] {
  return VERIFIED_FIELDS.filter((k) => {
    const want = trimmed(sent[k]);
    return !!want && want !== trimmed(readBack[k]);
  });
}

// ── Fit profile (tab 2: Bid Fitness) ─────────────────────────────────────────

/**
 * The entity types offered for a given legal type — the editor's data-validation rule.
 *
 * "individual" is not in the general list and the general list is not offered to an
 * individual: the two are the same statement from either side, and the Python writes it
 * as an if/else over `_entity_opts`. Kept as a function rather than two constants so the
 * rule is in one place; the page and the save both ask it.
 */
export function entityOptions(legalType: unknown): string[] {
  return trimmed(legalType) === "individual" ? ["individual"] : [...ENTITY_TYPES];
}

/** `_status_list` — a stored status coerced to clean, valid options, list or string. */
export function statusList(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v.map((x) => s(x).trim())
    : s(v).split(",").map((p) => p.trim());
  return raw.filter((x) => PARTNER_STATUS.includes(x));
}

/**
 * `_pc` — a data-editor cell as a clean string.
 *
 * "nan" and "none" are dropped by NAME, not by type: the Python reads the table back
 * through pandas, which stringifies a missing cell to exactly those. Without this an
 * empty Country column saves the literal text "nan" into the profile, where it matches no
 * country and quietly costs the geographic fit.
 */
export function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const t = s(v).trim();
  return ["nan", "none"].includes(t.toLowerCase()) ? "" : t;
}

/** The partner table as it is stored: nameless rows dropped, statuses cleaned. */
export function partnerRows(rows: unknown): Row[] {
  if (!Array.isArray(rows)) return [];
  const out: Row[] = [];
  for (const r of rows) {
    if (r === null || typeof r !== "object") continue;
    const row = r as Row;
    const name = cell(row.name);
    if (!name) continue;
    out.push({
      name, type: cell(row.type), status: statusList(row.status), country: cell(row.country),
    });
  }
  return out;
}

/**
 * The partner table as the editor SEEDS it: the structured `partners` plus a one-time
 * merge of the three legacy flat lists, matched case-insensitively on name.
 *
 * It belongs here rather than in the page because it is the only thing standing between a
 * tenant whose partners predate the structured table and a save that drops them: the save
 * writes `partners` from the table, so a legacy name the table never showed is gone.
 */
export function seedPartners(profile: Json): Row[] {
  const seed: Row[] = [];
  const seen = new Set<string>();
  for (const p of (Array.isArray(profile.partners) ? profile.partners : [])) {
    if (p === null || typeof p !== "object") continue;
    const row = p as Row;
    const name = cell(row.name);
    seed.push({ ...row, status: statusList(row.status) });
    if (name) seen.add(name.toLowerCase());
  }
  const merge = (names: unknown, type: string) => {
    for (const n of (Array.isArray(names) ? names : [])) {
      const nm = s(n).trim();
      if (nm && !seen.has(nm.toLowerCase())) {
        seen.add(nm.toLowerCase());
        seed.push({ name: nm, type, status: [], country: "" });
      }
    }
  };
  merge(profile.trusted_partners, "Nonprofit / NGO");
  merge(profile.trusted_for_profit_partners, "For-profit / private");
  merge(profile.trusted_academic_institutions, "Academic / research institutions");
  return seed;
}

/** A number the form sent, or null — `int(x) or None`, where 0 means "unset". */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/**
 * A rate, or null — `float(x) if x is not None else None`.
 *
 * NOT `num`: 0 is a real answer here ("we recover no overhead"), and blank is not. The
 * Python keeps them apart deliberately — blank leaves the MUST-5 indirect-cost component
 * out of the denominator, while 0 is scored. Collapsing them would quietly pass an
 * organisation that never said.
 */
function rate(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map((x) => s(x).trim()).filter(Boolean) : []);

/** One of a fixed vocabulary, or its default when the client sent something else. */
function oneOf(v: unknown, options: readonly string[], fallback: string): string {
  const t = trimmed(v);
  return options.includes(t) ? t : fallback;
}

/**
 * THE WHOLE PROFILE BLOB, from what the Bid Fitness tab sent.
 *
 * `set_profile` REPLACES `tenants.org_profile` — it is an `update`, not a merge — so what
 * this returns is the entire stored profile and anything missing from it is gone. The
 * Streamlit form sends all 41 persistable keys for exactly that reason, and so does this;
 * `check-org-setup.mjs` asserts the two sets are equal against DEFAULT_PROFILE, so a key
 * added to the Python without being added here fails a check rather than being silently
 * reset on the next save.
 *
 * Every vocabulary field is clamped to its own list. A client is not a form: it can send
 * "Nonprofit" where "nonprofit" belongs, and the profile would store it, match nothing,
 * and cost MUST-1 — with nothing on any screen to say so.
 */
export function profileFields(form: Json): Row {
  const legal = oneOf(form.legalType, LEGAL_TYPES, DEFAULT_PROFILE.org_legal_type as string);
  const partners = partnerRows(form.partners);
  const routeTokens = ROUTE_OPTIONS.map(([t]) => t);
  // The entity fallback is option 0 of whatever the legal type OFFERS, not "": an
  // individual is offered "individual" alone, so the editor's selectbox cannot produce
  // anything else and a refused value has to land there too. Falling back to "" would
  // store "no entity type" for the one applicant category whose entity type is certain.
  const entityOpts = entityOptions(legal);
  return {
    org_legal_type: legal,
    org_entity_type: oneOf(form.entityType, entityOpts, entityOpts[0]),
    org_founding_year: num(form.foundingYear),
    org_cofinancing_capacity: oneOf(
      form.cofinancing, COFINANCING_LEVELS, DEFAULT_PROFILE.org_cofinancing_capacity as string),
    // "" is a stored answer here — "not recorded" — so it is null rather than the default.
    org_prefinance_capacity: oneOf(form.prefinancing, COFINANCING_LEVELS, "") || null,
    org_indirect_cost_rate: rate(form.indirectCostRate),
    org_annual_budget: num(form.annualBudget),
    org_largest_grant: num(form.largestGrant),
    org_lowest_grant: num(form.lowestGrant),
    org_grants_count: num(form.grantsCount),
    org_min_target: num(form.minTarget),
    org_mid_target: num(form.midTarget),
    org_max_target: num(form.maxTarget),
    org_is_independent_entity: bool(form.independentEntity),
    org_has_sam_uei: bool(form.samUei),
    org_tax_exempt: bool(form.taxExempt),
    org_stage: oneOf(form.stage, ORG_STAGES, DEFAULT_PROFILE.org_stage as string),
    org_has_established_pi: bool(form.establishedPi),
    org_has_audited_financials: bool(form.auditedFinancials),
    org_has_audit_report: bool(form.auditReport),
    org_has_safeguarding_policy: bool(form.safeguardingPolicy),
    org_has_partner_mou: bool(form.partnerMou),
    org_has_govt_mou: bool(form.govtMou),
    org_has_govt_endorsement: bool(form.govtEndorsement),
    org_authorized_signatory_donors: list(form.authorizedSignatoryDonors),
    org_funding_routes: list(form.fundingRoutes).filter((t) => routeTokens.includes(t)),
    partners,
    org_domain_expertise: list(form.domains),
    org_domain_ratings: ratings(form.domainRatings),
    org_priority_areas: list(form.priorities),
    org_priority_ratings: ratings(form.priorityRatings),
    org_operating_countries: list(form.operatingCountries),
    // The flat lists are kept for back-compat readers and CONSOLIDATED: every partner
    // name lands in trusted_partners (which is what the geographic "via a partner" check
    // reads), and the two typed lists collapse into it. Writing them from the table is
    // what stops the two representations drifting apart.
    trusted_partners: partners.map((p) => s(p.name)),
    trusted_for_profit_partners: [],
    trusted_academic_institutions: [],
    org_registered_countries: list(form.registeredCountries),
    org_donor_registrations: list(form.donorRegistrations),
    org_funder_history: list(form.funderHistory),
    org_active_donors: list(form.activeDonors),
    org_engaged_donors: list(form.engagedDonors),
    proposal_languages: list(form.proposalLanguages),
  };
}

/** A program-area rating map — 0-5, integers, keyed by the full area name. */
function ratings(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v === null || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, raw] of Object.entries(v as Row)) {
    const n = Math.trunc(Number(raw));
    if (s(k).trim() && Number.isFinite(n)) out[s(k)] = Math.min(5, Math.max(0, n));
  }
  return out;
}

/** `set_profile`'s refusal: the derived key never persists, however it arrived. */
export function stripDerived(profile: Row): Row {
  if (!(DERIVED_PROFILE_KEY in profile)) return profile;
  const out = { ...profile };
  delete out[DERIVED_PROFILE_KEY];
  return out;
}

/** The three identity keys the fit save writes alongside the profile. */
export function derivedIdentity(entityType: unknown, hqCountry: unknown): Record<string, string> {
  const hq = trimmed(hqCountry);
  return {
    org_is_grassroot: trimmed(entityType) === "grassroot_local" ? "true" : "false",
    org_is_multi_country: trimmed(entityType) === "multi_country" ? "true" : "false",
    org_hq_country: hq === "(none)" ? "" : hq,
  };
}

// ── Team (tab 3) ─────────────────────────────────────────────────────────────

/**
 * Every boundary Python's `str.splitlines` breaks on, which is NOT just \r\n.
 *
 * It also splits on \v, \f, the three ASCII information separators, NEL, and the two
 * Unicode line separators. That matters here because the roster is pasted, usually out of
 * a document, and U+2028 is what a soft line break in Word becomes: Streamlit would store
 * two members and a `/\r?\n/` split would store one name with an invisible character in
 * the middle of it, which then matches nobody in the Proposal lead dropdown.
 *
 * Built from a STRING rather than written as a literal, because U+2028 is itself a line
 * terminator in JavaScript source: spelled out in a `/.../` literal it ends the line and
 * the file no longer parses.
 */
const PY_LINE_BREAKS = new RegExp(
  "\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]");

/**
 * The roster from the textarea: one name per line, blanks dropped.
 *
 * `splitlines`, not a newline split — see PY_LINE_BREAKS. Order is kept, because it is
 * the order the Proposal lead / Contributors / Reviewers dropdowns offer and somebody
 * arranged it.
 */
export function teamNames(text: unknown): string[] {
  return s(text).split(PY_LINE_BREAKS).map((l) => l.trim()).filter(Boolean);
}

/**
 * `settings.set_team_members`' OWN cleaning, which the textarea split does not do.
 *
 * Two rules the view never applies, because they are the writer's: de-duplicate
 * case-insensitively keeping the first spelling and the original order, and drop the
 * tokens "Other" and "All". Those two are not names — `core/dropdowns.py` APPENDS them to
 * the roster when it builds the Proposal lead / Contributors / Reviewers lists, so a
 * roster that stores one ends up offering it twice, and picking the stored one files the
 * work under a person who does not exist.
 *
 * Ported because the React save calls the same store directly: skip it and the
 * Streamlit app would keep cleaning while React quietly stopped.
 */
export function cleanTeam(names: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of (Array.isArray(names) ? names : [])) {
    const name = s(m).trim();
    const low = name.toLowerCase();
    if (!name || low === "other" || low === "all" || seen.has(low)) continue;
    seen.add(low);
    out.push(name);
  }
  return out;
}

/** The partner types a client may store, for the page's Type column. */
export const PARTNER_TYPE_OPTIONS: string[] = [...PARTNER_TYPES];

// ── Donor portals ────────────────────────────────────────────────────────────

/**
 * `core/partners.clean_portal_url` — a website reduced to a bare host.
 *
 * "https://www.wellcome.org/funding/schemes" and "wellcome.org" are the same portal, and
 * the editor unions a GENERATED seed (cleaned by the Python itself) with the hosts on the
 * live donor_intel rows. That union is the whole reason this is ported rather than
 * approximated: a second normalisation that disagreed anywhere would list the same portal
 * twice, and an admin ticking the wrong one would record a registration against a host no
 * donor matches.
 *
 * Step for step, in the Python's order — the "(label)" drop comes FIRST, because an entry
 * reads "ec.europa.eu (EU Funding & Tenders portal)" and the parenthesis would otherwise
 * survive into the stored value.
 */
export function cleanPortalUrl(url: unknown): string {
  let v = s(url).trim().toLowerCase();
  v = v.replace(/\s*\(.*$/s, "");          // drop "(EU Funding & Tenders…)" labels
  v = v.replace(/^[a-z]+:\/\//, "");       // drop the scheme
  v = v.replace(/^www\./, "");             // drop a leading www.
  v = v.split(/[/?#]/)[0];                 // host only — no subpages
  return v.trim().replace(/^\.+|\.+$/g, "");
}
