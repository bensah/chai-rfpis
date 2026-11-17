"""The donor field vocabulary and its display rules — lifted out of app_pages/donors.py.

WHY THIS MODULE EXISTS. These constants and helpers decide what the donor form asks, what
a donor record is called on screen, and what fraction of a record counts as documented.
Until now they lived inside a Streamlit page, which means they could not be IMPORTED —
donors.py calls `st` at module scope and loads the live table before defining anything.
Anything else that needed them had to re-implement them:

  * `scripts/gen_donor_vocab.py` had to lift them out of the page's AST.
  * `web/src/donors/model.ts` carried a hand-typed copy.
  * The job runner, which has to apply the same rules when it writes, had nowhere to
    call.

Three copies of one vocabulary is two too many, and the third was about to be written.

THE CLASSIFICATION IS NEGATIVE, AND THAT IS THE DESIGN. `flag_groups()` calls a column a
FLAG when it is not named in any of the text / contact / profile / meta sets below. So a
migration that adds a column to `donor_intel` adds a checkbox to the form with no code
change anywhere — which is why the sets are the thing worth owning in one place, and why
a column quietly dropped from one of them does not remove a field but INVENTS one.

NOTHING HERE TOUCHES THE DATABASE OR STREAMLIT. It is values and pure functions, so it
imports cleanly from a page, a script, a job runner and a test.
"""
from __future__ import annotations

import json
import re
from typing import Any, Iterable

import pandas as pd

# ---------------------------------------------------------------------------
# Acronym-aware labels
# ---------------------------------------------------------------------------
ACR = {
    "lmic": "LMIC", "ngo": "NGO", "hiv": "HIV", "aids": "AIDS", "tb": "TB",
    "ncd": "NCD", "ncds": "NCDs", "mnch": "MNCH", "srhr": "SRHR", "hss": "HSS",
    "ai": "AI", "usd": "USD", "uei": "UEI", "sam": "SAM", "mou": "MOU",
    "cv": "CV", "cvs": "CVs", "irb": "IRB", "ccm": "CCM", "dfi": "DFI",
    "us": "US", "mande": "M&E", "govt": "Govt",
}

LABEL_OVERRIDES = {
    "donor_type": "Donor type (descriptive)",
    "donor_is_dual_role_implementer": "Also an implementer that publishes calls?",
    "donor_opportunity_listing_urls": "Opportunity listing URL(s)",
    "donor_local_board_required": "Local board members required",
    # MUST-5 cofinancing & compliance (migration 052). The portal URL reuses the
    # existing submission_portal_url (matched against the org's donor_registrations).
    "donor_govt_mou_required": "Government MOU required",
    "donor_funding_platform_registration_required": "Funding-platform registration required",
    # New capture fields (migration 062). State/counterpart co-financing is DISTINCT
    # from cost-share match. Indirect-cost flag is phrased as the constraint.
    "donor_cofinancing_required": "Co-financing required",
    "donor_state_party_cofinancing_required": "Government / counterpart co-financing required",
    "donor_indirect_cost_disallowed": "Indirect / overhead costs not allowed",
    "donor_fund_use_conditions": "Conditions on use of funds",
    # PREFER-8 competitiveness (migration 053)
    "donor_multi_country_encouraged": "Encourages multi-country proposals",
    "donor_summary_description": "Summary",
    "donor_values": "Values",
    "donor_strategy_url": "Strategy (URL)",
    "donor_projected_budget_period": "Budget period",
    # Strategic-intelligence fields (migration 029)
    "donor_strategic_priorities": "Strategic priorities",
    "donor_in_scope": "What they fund (in scope)",
    "donor_out_of_scope": "What they don't fund (out of scope)",
    "donor_selection_criteria": "Selection / evaluation criteria",
    "donor_funding_programs": "Funding programs / windows",
    "donor_eligibility_notes": "Who can apply / lead",
    "donor_application_deadlines": "Key dates / deadlines",
    "donor_submission_portal_url": "Submission portal (URL)",
    "donor_strategic_fit_notes": "Ideal applicant & what this funder rewards",
    "donor_gaps_risks": "Common pitfalls & disqualifiers",
    "donor_recommended_approach": "How to position a competitive application",
    "donor_funders_collaborators": "Funders & Collaborators",
    "donor_hq_country_required": "Applicant must be HQ'd in",
    "org_stage_required": "Org stage required",
    "donor_max_annual_budget": "Max annual budget (eligibility ceiling)",
    "donor_indirect_cost_max_pct": "Indirect cost policy (% of project cost) allowed",
    "donor_min_track_record": "Min largest grant managed (floor)",
    "donor_required_partner_type": "Required partner type",
    "donor_required_partner_country": "Required partner country",
    "donor_max_request_pct_of_budget": "Max request (% of project budget)",
    "donor_min_cofinancing_secured_pct": "Min co-financing secured (%)",
    "donor_independent_entity_required": "Independent entity required (no INGO affiliates)",
    "donor_welcome_registration_required": "Pre-registration / senior-leadership approval required",
    # MUST-1 rework (migration 049)
    "donor_entity_type_required": "Entity type required",
    "donor_registration_region": "Registration region/country required",
    "donor_requires_pi": "Requires an individual / PI",
    "donor_pi_country_scope": "PI base-country scope",
    "donor_max_prior_grant": "Max prior grant/award (eligibility ceiling)",
    "donor_prior_beneficiary_rule": "Prior-beneficiary rule",
}


def label(col: str) -> str:
    """Form label for a column name.

    The DB columns carry a source-role prefix (donor_/call_/org_) for an auditable
    schema, but those prefixes must NOT show in the form — "Donor tax exempt status
    required" reads as wanting the DONOR's status, when it means "the donor REQUIRES
    tax-exempt status from applicants". So strip the prefix for display only (owner
    2026-06-29). Schema is unchanged.
    """
    if col in LABEL_OVERRIDES:
        return LABEL_OVERRIDES[col]
    bare = re.sub(r"^(donor_|call_|org_)", "", col)
    if bare in LABEL_OVERRIDES:
        return LABEL_OVERRIDES[bare]
    words = bare.replace("_", " ").split()
    out = []
    for i, w in enumerate(words):
        lw = w.lower()
        if lw in ACR:
            out.append(ACR[lw])
        elif i == 0:
            out.append(w.capitalize())
        else:
            out.append(lw)
    return " ".join(out)


def pretty_choice(v: str) -> str:
    """Display a stored enum value nicely without changing what's stored:
    'reimbursement_only' → 'Reimbursement Only', 'high' → 'High', '' → '—'."""
    s = str(v or "").strip()
    return s.replace("_", " ").title() if s else "—"


# ---------------------------------------------------------------------------
# De-SHOUTING workbook text
# ---------------------------------------------------------------------------
# Acronyms that are legitimately uppercase and must NOT be sentence-cased when
# we tidy SHOUTED phrases from the source workbook (e.g. "HEALTH SYSTEMS
# STRENGTHENING" -> "Health systems strengthening", but keep "HIV", "MNCH").
ACRONYMS = {
    "HIV", "AIDS", "TB", "MNCH", "HSS", "SRHR", "SRH", "NCD", "NCDS", "LMIC",
    "LMICS", "NGO", "NGOS", "CCM", "DFI", "UHC", "PHC", "WHO", "UN", "US", "EU",
    "UK", "AI", "HPV", "NTD", "NTDS", "RMNCAH", "RMNCH", "STI", "STIS", "WASH",
    "UNICEF", "UNAIDS", "UNFPA", "UNHCR", "UNESCO", "USAID", "CEPI", "GAVI",
    "COVID", "IRB", "MOU", "CSO", "CSOS", "PREP", "FP", "GBV", "R&D", "DR-TB",
    "GF", "AFD", "AFDB", "EC", "MCF", "BMGF",
}
SEG_SPLIT_RE = re.compile(r"([.;]\s+)")


def cap_first(s: str) -> str:
    """Capitalize the first alphabetic char only (don't touch the rest)."""
    for i, ch in enumerate(s):
        if ch.isalpha():
            return s[:i] + ch.upper() + s[i + 1:]
    return s


def smart_token(tok: str) -> str:
    """Lowercase a SHOUTED all-caps word/compound, but keep real acronyms.
    A token is 'shouted' if it's all-caps and has an alpha run >=5 letters or
    is a hyphenated compound (CROSS-CUTTING) — otherwise it's treated as an
    acronym (HIV, MNCH, AfDB) and left alone."""
    lead = re.match(r"^[^A-Za-z]*", tok).group(0)
    rest = tok[len(lead):]
    trail = re.search(r"[^A-Za-z]*$", rest).group(0)
    core = rest[:len(rest) - len(trail)] if trail else rest
    if not core or not core.isupper() or core.upper() in ACRONYMS:
        return tok
    alpha_runs = re.findall(r"[A-Z]+", core)
    longest = max((len(r) for r in alpha_runs), default=0)
    if longest >= 5 or ("-" in core and len(alpha_runs) >= 2):
        return lead + core.lower() + trail
    return tok


def deshout(text: str) -> str:
    """Turn SHOUTED phrases from the source workbook into sentence case for
    display, preserving acronyms. Only segments that actually contained a
    shouted word get re-capitalised, so already-clean text is untouched."""
    if not text or not any(c.isupper() for c in text):
        return text
    out = []
    for seg in SEG_SPLIT_RE.split(text):
        if not seg or SEG_SPLIT_RE.fullmatch(seg):
            out.append(seg)
            continue
        seg2 = " ".join(smart_token(t) for t in seg.split(" "))
        out.append(cap_first(seg2) if seg2 != seg else seg)
    return "".join(out)


# ---------------------------------------------------------------------------
# Value coercion
# ---------------------------------------------------------------------------
def na(v) -> bool:
    """True if v is pandas NA/NaN/NaT (safe on non-scalars)."""
    try:
        return v is not None and bool(pd.isna(v))
    except (TypeError, ValueError):
        return False


def disp(v):
    """Clean display value: None for NaN / blank / 'nan' / 'none', else str.
    Also tidies SHOUTED all-caps phrases to sentence case (display only — the
    source data is untouched, so the edit form still shows the raw value)."""
    try:
        if v is None or pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    s = str(v).strip()
    if s.lower() in ("nan", "none", "nat", ""):
        return None
    # Retire the {country} placeholder — it resolved to the org's single Primary
    # country (misleading). Neutralize to broad language; real per-donor
    # coverage now lives in the "Funded geographies" field.
    s = (s.replace("{country}'s ", "").replace("{country}'s", "")
          .replace("in {country}", "in priority countries")
          .replace("{country}", "priority countries"))
    return deshout(s)


def md(v):
    """Markdown-safe value — escape '$' so award amounts ($1K, $50M) don't
    render as LaTeX math."""
    d = disp(v)
    return d.replace("$", r"\$") if d else None


def title_name(row: dict) -> str:
    """Donor display name, appending the short code only when it isn't already
    part of the name (avoids 'African Development Bank (AfDB) (AfDB)')."""
    donor = disp(row.get("donor")) or "Donor"
    short = disp(row.get("donor_short")) or ""
    if short and short.lower() not in donor.lower():
        return f"{donor} ({short})"
    return donor


def cell(v):
    """Stripped string for a data-editor cell, or None. Safe against pandas
    NA / NaN (a bare `if cell` on a StringDtype NA raises 'ambiguous')."""
    try:
        if v is None or pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    s = str(v).strip()
    return s or None


def to_list(v) -> list[str]:
    """Parse a stored value into a list — JSON list, else split legacy free text."""
    if v is None:
        return []
    s = str(v).strip()
    if not s or s.lower() in ("nan", "none", "nat"):
        return []
    try:
        j = json.loads(s)
        if isinstance(j, list):
            return [str(x).strip() for x in j if str(x).strip()]
    except (ValueError, TypeError):
        pass
    # Split legacy free text on ; and , only — NOT "/", which appears inside
    # real values ("Procurement / contracts", "(equity/debt)").
    return [t.strip() for t in re.split(r"[;,]", s) if t.strip()]


def json_dicts(v) -> list[dict]:
    """Parse a JSON-array-of-objects column into a list of dicts (else [])."""
    try:
        j = json.loads(v or "[]")
    except (ValueError, TypeError):
        return []
    return [d for d in j if isinstance(d, dict)] if isinstance(j, list) else []


# ---------------------------------------------------------------------------
# Categories
# ---------------------------------------------------------------------------
CATEGORIES = [
    "Bilaterals / government development agencies",
    "Multilaterals & development banks",   # UN agencies, MDBs/DFIs, GH partnerships
    "International philanthropies & foundations",
    "U.S. federal agencies",
    "Private sector / corporate",
    "Academic / research institutions",
]
CATEGORY_CANON = {
    "bilaterals": "Bilaterals / government development agencies",
    "bilateral": "Bilaterals / government development agencies",
    "bilaterals / government development agencies": "Bilaterals / government development agencies",
    "government development agencies": "Bilaterals / government development agencies",
    "multilaterals": "Multilaterals & development banks",
    "multilateral": "Multilaterals & development banks",
    "multilaterals / global health partnerships": "Multilaterals & development banks",
    "multilateral / global health partnerships": "Multilaterals & development banks",
    "global health partnerships": "Multilaterals & development banks",
    "multilateral development bank / dfi": "Multilaterals & development banks",
    "multilateral development banks / dfis": "Multilaterals & development banks",
    "multilateral development bank": "Multilaterals & development banks",
    "development finance institution": "Multilaterals & development banks",
    "dfi": "Multilaterals & development banks",
    "multilaterals & development banks": "Multilaterals & development banks",
    "international philanthropies and foundations": "International philanthropies & foundations",
    "international philanthropies & foundations": "International philanthropies & foundations",
    "philanthropies and foundations": "International philanthropies & foundations",
    "philanthropy": "International philanthropies & foundations",
    "foundation": "International philanthropies & foundations",
    "foundations": "International philanthropies & foundations",
    "u.s. federal agencies": "U.S. federal agencies",
    "u.s. federal / bilateral agencies": "U.S. federal agencies",
    "us federal agencies": "U.S. federal agencies",
    "u.s. federal agency": "U.S. federal agencies",
    "private sector": "Private sector / corporate",
    "corporate": "Private sector / corporate",
    "academic": "Academic / research institutions",
    "research institution": "Academic / research institutions",
}
UNCATEGORISED = "(uncategorised)"


def normalize_category(raw) -> str:
    """Map any raw donor_category to a canonical display value."""
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return UNCATEGORISED
    s = re.sub(r"\s+", " ", str(raw).strip())
    if not s:
        return UNCATEGORISED
    key = s.lower().rstrip(".")
    if key in CATEGORY_CANON:
        return CATEGORY_CANON[key]
    if key.endswith("s") and key[:-1] in CATEGORY_CANON:  # plural fold
        return CATEGORY_CANON[key[:-1]]
    return s  # unknown → keep cleaned original (at least case/space-trimmed)


# ---------------------------------------------------------------------------
# Field classification
# ---------------------------------------------------------------------------
META = {"id", "updated_at", "created_at", "canonical_key", "category_clean",
        "online_source_check_status", "last_checked", "row_type",
        "award_size_basis"}
SHORT_TEXT = ["donor", "donor_short", "donor_category", "donor_type", "donor_website",
              "donor_award_low", "donor_award_high",
              "donor_total_annual_funding_global", "donor_funding_mechanism"]
LONG_TEXT = ["donor_aliases", "donor_geographic_scope", "donor_active_route_status",
             "donor_direct_local_org_eligible", "donor_priority_areas",
             "donor_verification_caveats", "donor_evidence_summary", "notes",
             "donor_source_urls", "donor_opportunity_listing_urls"]
# Institutional / official donor contact (one set per donor — the donor_intel
# row). The many focal-person contacts live in the donor_contacts table.
CONTACT = ["donor_hq_address", "donor_hq_country", "donor_main_phone", "donor_general_email",
           "donor_linkedin_url", "donor_other_profile_urls",
           "donor_contact_persons", "donor_contact_emails", "donor_contact_phones",
           "donor_contact_linkedin_urls"]
# Columns of the donor_contacts table (focal persons), in form order.
CONTACT_COLS = ["contact_name", "role_title", "email", "phone",
                "linkedin_url", "address", "is_official", "notes"]
CHOICE = {
    "donor_prefinance_required": ["", "none", "partial", "reimbursement_only"],
    "donor_verification_level": ["", "high", "medium", "low"],
    "donor_is_dual_role_implementer": ["", "yes", "no"],
}
# Qualitative donor-intelligence profile (added to the edit form, migration 025).
# Listed here so these columns are treated as free text — NOT flags — once they
# exist in the table, and so the View / Share / PDF summaries include them.
PROFILE = ["donor_founded", "donor_summary_description", "donor_mission", "donor_vision",
           "donor_values", "donor_strategy_url", "donor_total_awards",
           "donor_total_funding_to_date", "donor_current_awards", "donor_past_awards",
           "donor_projected_budget", "donor_projected_budget_period", "donor_funding_cycle",
           "donor_recent_activity", "donor_application_process",
           "donor_reporting_requirements", "donor_past_projects_json",
           # Strategic-intelligence fields (migration 029) — narrative + JSON.
           "donor_strategic_priorities", "donor_in_scope",
           "donor_out_of_scope", "donor_selection_criteria", "donor_funding_programs",
           "donor_funding_tiers_json", "donor_eligibility_notes", "donor_application_deadlines",
           "donor_submission_portal_url", "donor_strategic_fit_notes", "donor_gaps_risks",
           "donor_recommended_approach", "donor_priority_ratings", "donor_funders_collaborators",
           # Hard eligibility conditions (migration 032) — VALUED (not flags).
           "donor_hq_country_required", "org_stage_required", "donor_max_annual_budget",
           "donor_min_track_record", "donor_required_partner_type", "donor_required_partner_country",
           "donor_max_request_pct_of_budget", "donor_min_cofinancing_secured_pct",
           # MUST-1 rework conditions (migration 049) — VALUED text, not flags.
           "donor_entity_type_required", "donor_registration_region",
           "donor_requires_pi", "donor_pi_country_scope", "donor_max_prior_grant",
           "donor_prior_beneficiary_rule",
           # MUST-5 indirect-cost cap (migration 090) — a % of project cost, VALUED.
           "donor_indirect_cost_max_pct",
           # Conditions on how awarded funds may be used (migration 062) — free text.
           "donor_fund_use_conditions"]
# Columns kept for backward-compat but no longer surfaced anywhere (not edited,
# not shown in View, not in share/PDF). verification_level already captures data
# confidence, so the free-text "verification caveats" was redundant + confusing.
# funded_geographies is an unused column (the geo field is donor_geographic_scope).
HIDDEN_FIELDS = {"donor_verification_caveats", "donor_funded_geographies"}

NON_FLAG = (set(META) | set(SHORT_TEXT) | set(LONG_TEXT)
            | set(CHOICE) | set(CONTACT) | set(PROFILE) | HIDDEN_FIELDS)

ELIG = [
    "donor_ngo_eligible", "donor_for_profit_eligible", "donor_govt_or_ccm_route_required",
    "donor_grant_route", "donor_procurement_tender_route", "donor_loan_dev_finance_route",
    "donor_subrecipient_partner_possible", "donor_open_call_unsolicited",
    "donor_invitation_solicited", "donor_two_stage_application", "donor_online_portal_submission",
    "donor_lmic_africa_focus", "donor_global_multi_country_scope",
]


def flag_groups(columns: Iterable[str]) -> tuple[list[str], list[str], list[str], dict]:
    """Classify the LIVE columns into (flags, fit, req, groups).

    THE CLASSIFICATION IS NEGATIVE: a column is a flag when it is not named in any of
    the sets above. That is what makes a migration able to add a form field without a
    code change — and what makes a column missing from one of those sets INVENT a
    field rather than remove one.

    CO-FINANCING and PRE-FINANCING are eligibility requirements, so they belong in the
    tri-state matrix with every other one (owner 2026-08-10). Co-financing had NO plainly
    named field at all — it had to be inferred from "Cost sharing match required",
    "Government / counterpart co-financing required" and a numeric min-secured-%, none of
    which a researcher would recognise as the question (migration 092 adds the column).
    Pre-financing was a special-cased selectbox further down the form; both are now asked
    in the same place, the same way, and scored against their own org capacity.
    """
    flags = [c for c in columns if c not in NON_FLAG]
    fit = [c for c in flags if c.endswith("_fit")]
    req = [c for c in flags if c not in ELIG and c not in fit]
    for rq in ("donor_cofinancing_required", "donor_prefinance_required"):
        if rq not in req:
            req.append(rq)
    groups = {
        "Legal & registration requirements": [c for c in ELIG if c in flags],
        "Program-area fit": fit,
        "Requirements & compliance": req,
    }
    return flags, fit, req, groups


# ---------------------------------------------------------------------------
# Structured dropdown vocabularies for the donor edit form
# ---------------------------------------------------------------------------
# Free text → finite choices. Multi fields accept typed custom values (covers
# "Other"); single fields use an explicit "Other (specify)" escape hatch.
# (Program areas now use the SHARED hierarchical taxonomy via
# core.program_area_select.program_area_rating_editor — same schema as the org
# fit profile — so the donor's *_fit flags are deprecated for the picker.)
FUNDING_MECHANISMS = [
    "Grants", "Loans / concessional finance", "Procurement / contracts",
    "Program-related investments (equity/debt)", "Technical assistance",
    "Co-financing", "Prizes / challenges", "In-kind / commodities",
]
ROUTE_STATUSES = ["Active", "Inactive", "On hold / paused", "Closed", "Unknown"]
LOCAL_ORG_ELIGIBLE = [
    "Yes — direct", "Yes — via competitive RFP / invited proposal",
    "Yes — via international partner only", "No", "Unknown",
]
# Structured vocabularies for the Intelligence section (each + "Other (specify)").
FUNDING_CYCLES = [
    "Rolling / open call (no fixed deadline)", "Annual",
    "Biannual (twice a year)", "Quarterly", "Multi-year cycle",
    "Ad hoc / by announcement", "Unknown",
]
APPLICATION_PROCESSES = [
    "Concept note → full proposal (two-stage)", "Full proposal (single-stage)",
    "Letter of inquiry / EOI first", "Online portal submission",
    "By invitation only", "Competitive tender / RFP",
    "Unsolicited proposals accepted", "Unknown",
]
REPORTING_REQUIREMENTS = [
    "Narrative + financial reports", "Quarterly reporting",
    "Semi-annual reporting", "Annual reporting",
    "Milestone / deliverable-based", "Final report only",
    "Independent audit required", "Unknown",
]
OTHER = "Other (specify)"

# Partner-type vocabulary — shared with the org fit profile so a donor's
# required_partner_type matches the org's partner records.
PARTNER_TYPE_OPTIONS = [
    "Nonprofit / NGO", "Academic / research institutions", "For-profit / private",
    "Government", "Multilateral / UN", "Bilateral / development agency",
    "Philanthropy / foundation",
]

# ---------------------------------------------------------------------------
# Tri-state requirements
# ---------------------------------------------------------------------------
# A donor REQUIREMENT has FOUR states — and "Not Sure" is NOT the same as blank:
#   blank "—"   → genuinely UNANSWERED (missing data — counts against completeness)
#   Required    → "yes"   · Not required → "no"   · Not sure → "not_sure"
# The three explicit responses all mean "a human/extractor ENGAGED with this question"
# (so they count toward data completeness); only blank is missing. Default for an
# untouched field is BLANK, never Not Sure — else missing data would look answered.
# SCORING is unchanged: core.criteria_derive._truthy activates only on "yes"/"required",
# so "no", "not_sure" AND blank all read as Not Required (current logic/defaults).
# Eligibility CAPABILITIES (NGO eligible, grant route, …) stay yes/no checkboxes.
TRISTATE_GROUPS = {"Requirements & compliance"}
TRISTATE_OPTS = ["—", "Required", "Not required", "Not sure"]
TRISTATE_TO_VAL = {"—": None, "Required": "yes", "Not required": "no", "Not sure": "not_sure"}
VAL_TO_TRISTATE = {"yes": "Required", "no": "Not required", "not_sure": "Not sure"}

# ---------------------------------------------------------------------------
# Completeness
# ---------------------------------------------------------------------------
# Fields stored as JSON lists — rendered as comma lists in share/export.
LIST_FIELDS = {"donor_geographic_scope", "donor_priority_areas",
               "donor_funding_mechanism", "donor_funders_collaborators",
               # MUST-1 multi-selects (migration 049) — stored as JSON lists.
               "donor_hq_country_required", "donor_registration_region",
               "donor_required_partner_type", "donor_required_partner_country"}

# Fields that count toward the data-completeness score (every donor-facing field).
# JSON/list fields count as documented when non-empty; flags count when explicitly
# yes/no (blank = undocumented). donor_short is excluded (optional acronym).
COMPLETENESS_TEXT = [
    "donor", "donor_category", "donor_website", "donor_founded",
    "donor_general_email", "donor_main_phone", "donor_hq_country", "donor_hq_address",
    "donor_linkedin_url", "donor_other_profile_urls", "donor_summary_description", "donor_mission",
    "donor_vision", "donor_values", "donor_strategic_priorities", "donor_strategy_url",
    "donor_award_low", "donor_award_high", "donor_total_annual_funding_global",
    "donor_total_awards", "donor_total_funding_to_date", "donor_current_awards", "donor_past_awards",
    "donor_projected_budget", "donor_funding_programs", "donor_in_scope", "donor_out_of_scope",
    "donor_direct_local_org_eligible", "donor_active_route_status", "donor_prefinance_required",
    "donor_application_process", "donor_funding_cycle", "donor_reporting_requirements",
    "donor_application_deadlines", "donor_submission_portal_url", "donor_recent_activity",
    "donor_eligibility_notes", "donor_selection_criteria", "donor_strategic_fit_notes",
    "donor_gaps_risks", "donor_recommended_approach", "donor_verification_level",
    "donor_evidence_summary", "notes", "donor_source_urls",
]
COMPLETENESS_JSON = ["donor_funding_tiers_json", "donor_past_projects_json"]


def disp_field(row: dict, col: str):
    """Display string for share/export: list-fields joined with commas, else disp."""
    if col in LIST_FIELDS:
        vals = to_list(row.get(col))
        return ", ".join(vals) if vals else None
    return disp(row.get(col))


def completeness(row: dict, flags: Iterable[str], fit: Iterable[str]) -> tuple[int, int, int]:
    """Data-quality = % of donor fields that are documented (all fields counted).
    Returns (percent, populated, total).

    `flags` and `fit` come from flag_groups() over the LIVE columns — the denominator
    is derived, not fixed, so both callers must classify the same column set before the
    percentage can mean the same thing in both.
    """
    fit = set(fit)
    have = total = 0
    for c in COMPLETENESS_TEXT:
        total += 1
        if disp(row.get(c)):
            have += 1
    for c in list(LIST_FIELDS) + COMPLETENESS_JSON:
        total += 1
        ok = bool(json_dicts(row.get(c))) if c.endswith("_json") else bool(to_list(row.get(c)))
        if ok:
            have += 1
    # program_area_ratings is a JSON OBJECT (not a list) — documented if non-empty.
    total += 1
    try:
        r = json.loads(row.get("donor_priority_ratings") or "{}")
    except (ValueError, TypeError):
        r = {}
    if isinstance(r, dict) and r:
        have += 1
    # Flags — but NOT the deprecated *_fit program-area flags (program areas are
    # now captured in priority_program_areas + program_area_ratings).
    for c in flags:
        if c in fit:
            continue
        total += 1
        # Any explicit response counts as answered — Required/Not Required AND an
        # explicit "Not sure" (the question was engaged). Only blank is missing data.
        if str(row.get(c) or "").strip().lower() in ("yes", "no", "not_sure"):
            have += 1
    pct = round(100 * have / total) if total else 0
    return pct, have, total


def prov_of(row: dict, col: str) -> Any:
    """Provenance tag for a donor field (human_verified | from_call | auto_created), or
    None. field_provenance is jsonb — a dict from Supabase, or a JSON string."""
    fp = row.get("field_provenance")
    if isinstance(fp, str) and fp.strip():
        try:
            fp = json.loads(fp)
        except Exception:
            fp = {}
    return fp.get(col) if isinstance(fp, dict) else None
