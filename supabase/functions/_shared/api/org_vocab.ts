/**
 * The My Organization page's constant tables. GENERATED — do not edit.
 *
 *     python scripts/gen_org_vocab.py
 *
 * Source of truth: core/org_profile.py for the profile defaults, the rename map and the
 * legal/entity-type labels; core/settings.py for the identity placeholders;
 * core/program_area_select.py for the rating words. See scripts/gen_org_vocab.py for why
 * these are generated rather than retyped.
 */

/**
 * core/org_profile.DEFAULT_PROFILE — what a tenant's stored profile is merged ONTO.
 *
 * A tenant that has never opened the editor is shown all of this, and the scoring engine
 * reads the same merged dict, so a stale copy here would describe one organisation by
 * another's defaults.
 */
export const DEFAULT_PROFILE: Record<string, unknown> = {"org_active_donors": [], "org_annual_budget": null, "org_authorized_signatory_donors": [], "org_cofinancing_capacity": "limited", "org_domain_expertise": [], "org_domain_ratings": {}, "org_donor_registrations": [], "org_engaged_donors": [], "org_entity_type": "", "org_founding_year": null, "org_funder_history": [], "org_funding_routes": ["grant", "subrecipient"], "org_grants_count": null, "org_has_audit_report": false, "org_has_audited_financials": false, "org_has_established_pi": false, "org_has_govt_endorsement": false, "org_has_govt_mou": false, "org_has_partner_mou": false, "org_has_safeguarding_policy": false, "org_has_sam_uei": false, "org_indirect_cost_rate": null, "org_is_independent_entity": true, "org_largest_grant": null, "org_legal_type": "nonprofit", "org_lowest_grant": null, "org_max_target": null, "org_mid_target": null, "org_min_target": null, "org_operating_countries": [], "org_prefinance_capacity": null, "org_priority_areas": [], "org_priority_ratings": {}, "org_registered_countries": [], "org_stage": "established", "org_tax_exempt": false, "org_user_declared_areas": [], "partners": [], "proposal_languages": ["English"], "trusted_academic_institutions": [], "trusted_for_profit_partners": [], "trusted_partners": []};

/** core/org_profile.PROFILE_FIELDS — the key order, for stable iteration. */
export const PROFILE_FIELDS: string[] = ["org_founding_year", "org_legal_type", "org_entity_type", "org_donor_registrations", "org_registered_countries", "org_annual_budget", "org_largest_grant", "org_lowest_grant", "org_grants_count", "org_min_target", "org_mid_target", "org_max_target", "org_is_independent_entity", "org_has_sam_uei", "org_tax_exempt", "org_stage", "org_has_established_pi", "partners", "org_domain_expertise", "org_domain_ratings", "org_priority_areas", "org_priority_ratings", "org_user_declared_areas", "org_operating_countries", "trusted_partners", "trusted_for_profit_partners", "trusted_academic_institutions", "org_indirect_cost_rate", "org_cofinancing_capacity", "org_prefinance_capacity", "org_has_audited_financials", "org_has_audit_report", "org_has_safeguarding_policy", "org_has_partner_mou", "org_has_govt_mou", "org_has_govt_endorsement", "org_authorized_signatory_donors", "org_funding_routes", "org_funder_history", "org_active_donors", "org_engaged_donors", "proposal_languages"];

/**
 * core/org_profile._RENAMED_KEYS — legacy key -> current key.
 *
 * How a profile saved before the 2026 renames is still read. Applied only when the NEW
 * key is absent, so a profile carrying both keeps the new one.
 */
export const RENAMED_KEYS: Record<string, string> = {"active_donors": "org_active_donors", "annual_budget_usd": "org_annual_budget", "authorized_signatory_donors": "org_authorized_signatory_donors", "cofinancing_capacity": "org_cofinancing_capacity", "countries_of_operation": "org_operating_countries", "countries_registered": "org_registered_countries", "domain_ratings": "org_domain_ratings", "domains": "org_domain_expertise", "donor_registrations": "org_donor_registrations", "entity_type": "org_entity_type", "founding_year": "org_founding_year", "funder_history": "org_funder_history", "funding_target_low": "org_min_target", "funding_target_max": "org_max_target", "funding_target_mid": "org_mid_target", "has_audit_report": "org_has_audit_report", "has_audited_financials": "org_has_audited_financials", "has_established_pi": "org_has_established_pi", "has_govt_endorsement": "org_has_govt_endorsement", "has_govt_mou": "org_has_govt_mou", "has_partner_mou": "org_has_partner_mou", "has_safeguarding_policy": "org_has_safeguarding_policy", "largest_grant_usd": "org_largest_grant", "legal_type": "org_legal_type", "lowest_grant_usd": "org_lowest_grant", "number_of_grants_managed": "org_grants_count", "priority_areas": "org_priority_areas", "program_area_ratings": "org_priority_ratings"};

/** core/org_profile.LEGAL_TYPE_LABELS — stored code -> what the page shows. */
export const LEGAL_TYPE_LABELS: Record<string, string> = {"for_profit": "For-profit company", "government": "Government", "higher_ed": "Higher Education", "individual": "Individual", "nonprofit": "Non-profit organization", "tribal": "Tribal organization"};

/** core/org_profile.ENTITY_TYPE_LABELS — MUST-1 item B, "" meaning not specified. */
export const ENTITY_TYPE_LABELS: Record<string, string> = {"": "(not specified)", "grassroot_local": "Grassroot / Local Organization", "individual": "Individual", "multi_country": "Multi-country Organization"};

/** core/org_profile.LIST_FIELDS — the profile keys stored as a list of strings. */
export const LIST_FIELDS: string[] = ["org_donor_registrations", "org_registered_countries", "org_operating_countries", "trusted_partners", "trusted_for_profit_partners", "trusted_academic_institutions", "org_domain_expertise", "org_priority_areas", "org_funder_history", "org_active_donors", "org_engaged_donors", "proposal_languages", "org_authorized_signatory_donors", "org_funding_routes"];

/**
 * core/settings._ORG_DEFAULTS — the identity placeholders.
 *
 * They exist so the header never renders blank, and the page shows them as values, so a
 * reader seeing "Your Organization" is being told the real name was never set.
 */
export const ORG_DEFAULTS: Record<string, string> = {"org_contact_email": "", "org_country": "", "org_has_bd_team": "false", "org_has_local_board": "", "org_hq_country": "", "org_is_grassroot": "false", "org_is_multi_country": "false", "org_is_us_entity": "false", "org_logo_url": "", "org_name": "Your Organization", "org_short": "Org", "org_team": "Business Development Team", "org_website": ""};

/** core/program_area_select.RATING_WORD — 0-5 to the word beside the bar. */
export const RATING_WORD: Record<string, string> = {"0": "None", "1": "Very low", "2": "Low", "3": "Medium", "4": "High", "5": "Very high"};

/**
 * core/program_area_classifier.CATEGORY_FULL — the key PREFIX expanded.
 *
 * A rated area is stored under its full key, "HSS - Health Financing". The page shows the
 * sub-area in full and the category beside it in grey, so both halves of that key have to
 * be readable; an unknown prefix falls back to itself, as `category_full` does.
 */
export const CATEGORY_FULL: Record<string, string> = {"AGRI": "Agriculture & Food Systems", "Cross-cutting": "Cross-cutting (Health)", "ECON": "Economic Development & Livelihoods", "EDU": "Education & Learning", "ENV": "Climate, Energy & Environment", "GES": "Gender, Equity & Inclusion", "GOV": "Governance, Peace & Rights", "HSS": "Health System Strengthening", "HUM": "Humanitarian & Resilience", "IDs": "Infectious Diseases", "NCDs": "Non-Communicable Diseases", "WASH": "Water, Sanitation & Hygiene (WASH)", "WCH": "Women & Children's Health"};

// ─────────────────────────────────────────────────────────────────────────────
// THE EDITOR'S OWN OPTION LISTS — Settings → Setup, `views/org_setup.py`.
//
// Everything above describes how a STORED profile is read. Everything below is what the
// four tabs OFFER, and the distinction matters: a reader shown a stale default sees a
// wrong number, while a writer offered a stale option list STORES one. The profile is
// read by the scoring engine, so a value outside the vocabulary does not fail, it just
// stops matching — the criterion quietly scores as if the organisation had answered
// nothing. That is the failure this whole file exists to prevent, on the write side.
// ─────────────────────────────────────────────────────────────────────────────

/** core/org_profile.COFINANCING_LEVELS — MUST-5, none / limited / strong. */
export const COFINANCING_LEVELS: string[] = ["none", "limited", "strong"];

/**
 * core/criteria_derive.ROUTE_OPTIONS — [stored token, label on screen].
 *
 * The editor shows the LABELS and stores the TOKENS, so both halves are needed: a label
 * stored where a token belongs matches no call's offered routes, and the MUST-5
 * funding-route gate then scores 0 for an organisation that can in fact be funded.
 */
export const ROUTE_OPTIONS: [string, string][] = [["grant", "Grants"], ["procurement", "Procurement / contracts"], ["loan", "Loans / concessional finance"], ["subrecipient", "As a subrecipient / partner"], ["govt_ccm", "Government / CCM channel"], ["direct", "Direct (local entity)"]];

/** The six legal types the editor offers (`_legal_opts`), in its own order. */
export const LEGAL_TYPES: string[] = ["nonprofit", "government", "higher_ed", "for_profit", "individual", "tribal"];

/**
 * The entity types offered when the legal type is NOT "individual" (`_entity_opts`).
 *
 * The editor's rule is a data-validation one and belongs with the list: legal type
 * "individual" forces entity type to "individual" and offers nothing else; every other
 * legal type offers these three and hides "individual". See `entityOptions` in
 * org_setup.ts, which is the rule itself rather than this table.
 */
export const ENTITY_TYPES: string[] = ["", "grassroot_local", "multi_country"];

/** `_stage_opts` — some funders fund early-stage organisations only. */
export const ORG_STAGES: string[] = ["established", "early-stage"];

/**
 * `_board_opts` — label on screen -> the value stored in `org_has_local_board`.
 *
 * "" is not a missing answer, it is the answer that LEAVES THE GATE OFF: "no" makes a
 * donor requiring a local board a hard MUST-4 disqualifier, and "" means unknown, so a
 * blank and a "no" are opposite instructions to the scorer.
 *
 * PAIRS, not an object, because the ORDER is load-bearing and a Record would lose it.
 * The editor's selectbox falls back to index 0 when the stored value matches nothing, so
 * whichever entry comes first is what an unrecognised value is shown as — and here that
 * entry is the one carrying "". Sorted alphabetically, "No — we don't have one" would
 * come first instead, and a profile with a damaged value would read as a hard no.
 */
export const BOARD_OPTIONS: [string, string][] = [["Unknown — don't apply this gate", ""], ["Yes — we have a local board", "yes"], ["No — we don't have one", "no"]];

/** `_LANGS` — languages a competitive bid can be written in (bid effort). */
export const PROPOSAL_LANGUAGES: string[] = ["English", "French", "Portuguese", "Spanish", "Arabic", "Swahili"];

/** `_PARTNER_TYPES` — the partner table's Type column. */
export const PARTNER_TYPES: string[] = ["Nonprofit / NGO", "Academic / research institutions", "For-profit / private", "Government", "Multilateral / UN", "Bilateral / development agency", "Philanthropy / foundation"];

/** `_STATUS_OPTS` — the partner table's Status column; a partner may hold several. */
export const PARTNER_STATUS: string[] = ["Donor", "Implementing Partner", "Collaborator"];

/**
 * `_crit_labels` — the nine criteria as the Scan Preferences tab names them.
 *
 * A lookup, not an order: the page iterates `CRITERIA` from scorer.ts, which is the
 * scorer's own sequence, and reads a label out of here. Two orders of the same nine
 * things is one of them waiting to go stale.
 */
export const CRITERION_LABELS: Record<string, string> = {"bid_effort": "PREFER 9 — Bid effort", "capacity": "MUST 3 — Implementation capacity", "cofinancing": "MUST 5 — Cofinancing & compliance", "competitiveness": "PREFER 8 — Competitiveness", "funder_relationship": "PREFER 7 — Donor relationship", "funding_quality": "PREFER 6 — Funding quality", "geographic_fit": "MUST 4 — Geographic fit", "qualification": "MUST 1 — Legal status & qualification", "strategic_fit": "MUST 2 — Strategic fit"};

/**
 * core/partners.DONOR_PORTALS, cleaned to bare hosts by `clean_portal_url`.
 *
 * The SEED for "Donor portal registration active". The editor unions it with the hosts
 * on the live donor_intel rows, which the route adds — this half is the repo constant,
 * that half is per-deployment data, the same split the rest of this file keeps.
 */
export const DONOR_PORTAL_SEED: string[] = ["afd.fr", "afdb.org", "cdc.gov", "ec.europa.eu", "fcdo.gov.uk", "gatesfoundation.org", "gavi.org", "gcgh.grandchallenges.org", "grants.gov", "grants.nih.gov", "sam.gov", "theglobalfund.org", "ungm.org", "unitaid.org", "wellcome.org", "workwithusaid.gov"];
