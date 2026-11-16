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
