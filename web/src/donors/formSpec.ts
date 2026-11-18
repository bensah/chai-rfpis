/**
 * The donor edit form's LAYOUT — which field appears on which tab, as which control.
 *
 * WHY THIS IS HAND-WRITTEN WHEN EVERYTHING ELSE IS GENERATED. The vocabulary is data and
 * is generated (every option list below comes from donor_vocab.json, which
 * scripts/gen_donor_vocab.py emits from core/donor_fields.py). The LAYOUT is a design
 * decision — eight tabs, this order, these groupings — and lives in the Streamlit dialog
 * as 480 lines of imperative widget calls. There is nothing to generate it from that
 * would not be a parser for one specific function's shape.
 *
 * So the layout is written here and its COVERAGE is pinned instead: check-donors reads
 * every `edited[...]` column out of `_edit_dialog`'s AST and asserts this spec names the
 * same set. A field added to the Streamlit form and not here fails the gate rather than
 * going quietly missing from the React one — which is the failure that matters, because
 * a field absent from a form looks exactly like a donor who has not filled it in.
 *
 * WHAT IS DELIBERATELY NOT HERE, and must stay out:
 *
 *   * `donor_priority_ratings` — the per-area rating matrix. React has no editor for it
 *     yet, so the field is OMITTED rather than rendered empty: the save writes only the
 *     keys it is given, and PostgREST's upsert leaves absent columns alone, so omitting
 *     it PRESERVES whatever the classic app stored. Sending it as an empty object would
 *     silently wipe a donor's program-area ratings.
 *   * the flag matrix columns, which are derived from the live table and cannot be a
 *     fixed list — `kind: "matrix"` renders whatever flag_groups() classified.
 */
import {
  APPLICATION_PROCESSES, CONDITION_CHOICE, CHOICE, FUNDING_CYCLES, FUNDING_MECHANISMS,
  LOCAL_ORG_ELIGIBLE, PARTNER_TYPE_OPTIONS, REPORTING_REQUIREMENTS, ROUTE_STATUSES,
} from "./writeVocab";
import { BROAD_GEOGRAPHIES, COUNTRIES, GEO_OPTIONS, PA_ALL_KEYS } from "./vocab";

export type Field =
  /** One line of free text. */
  | { kind: "text"; col: string; label?: string; help?: string; placeholder?: string }
  /** Several lines of free text. */
  | { kind: "area"; col: string; label?: string; help?: string; rows?: number }
  /** A fixed enum. `pretty` displays 'reimbursement_only' as 'Reimbursement Only'. */
  | { kind: "select"; col: string; options: string[]; label?: string; help?: string;
      pretty?: boolean }
  /** A finite list with an "Other (specify)" escape hatch; stores the typed text. */
  | { kind: "singleOther"; col: string; options: string[]; label?: string; help?: string }
  /** Multi-select stored as a JSON list. Accepts typed values not in `options`. */
  | { kind: "multi"; col: string; options: string[]; label?: string; help?: string }
  /** The derived flag groups — checkboxes, or tri-state for requirements. */
  | { kind: "matrix"; groups: string[] }
  /** A JSON array of objects, edited as rows. */
  | { kind: "repeater"; col: string; columns: { key: string; label: string }[];
      label?: string; help?: string }
  /** The donor_contacts table (focal persons), which is not a donor_intel column. */
  | { kind: "contacts" };

export type Tab = { id: string; title: string; fields: Field[] };

/** Current year back to 1800, plus "" for unset — the Founded dropdown. */
export const YEAR_OPTIONS: string[] = [
  "", ...Array.from({ length: new Date().getFullYear() - 1799 },
    (_, i) => String(new Date().getFullYear() - i)),
];

export const TABS: Tab[] = [
  {
    id: "identity",
    title: "Identity",
    fields: [
      { kind: "text", col: "donor", label: "Donor" },
      { kind: "text", col: "donor_short", label: "Donor Code" },
      { kind: "select", col: "donor_category", options: [], label: "Donor category" },
      { kind: "text", col: "donor_website", label: "Website" },
      {
        kind: "text", col: "donor_type",
        help: "Richer descriptive label, e.g. 'Private Foundation & Philanthropic "
          + "Organization'. Complements (doesn't replace) Donor category.",
      },
      {
        kind: "select", col: "donor_is_dual_role_implementer",
        options: CHOICE.donor_is_dual_role_implementer, pretty: true,
        help: "Yes for implementers that ALSO publish their own calls / sub-grants.",
      },
      {
        kind: "area", col: "donor_opportunity_listing_urls", rows: 2,
        help: "The donor's RFP / tender / grant LISTING page(s) — pipe-separated. These "
          + "feed the scan catalogue (Sources) via the listing-URL sync.",
      },
      {
        kind: "select", col: "donor_founded", options: YEAR_OPTIONS,
        label: "Founded (year)", help: "Year the organisation was established.",
      },
      {
        kind: "multi", col: "donor_funders_collaborators", options: [],
        help: "Who funds / partners with this donor. If your org is in this list and you "
          + "apply, it lifts your competitiveness.",
      },
      { kind: "text", col: "donor_general_email", label: "General email" },
      { kind: "text", col: "donor_main_phone", label: "Main phone" },
      { kind: "select", col: "donor_hq_country", options: ["", ...COUNTRIES],
        label: "HQ country" },
      { kind: "text", col: "donor_linkedin_url", label: "Donor LinkedIn" },
      { kind: "area", col: "donor_hq_address", label: "HQ address", rows: 2 },
      { kind: "area", col: "donor_other_profile_urls", label: "Other profile URLs", rows: 2 },
    ],
  },
  {
    id: "about",
    title: "About & strategy",
    fields: [
      { kind: "area", col: "donor_summary_description", label: "Summary / description", rows: 4 },
      { kind: "area", col: "donor_mission", label: "Mission", rows: 3 },
      { kind: "area", col: "donor_vision", label: "Vision", rows: 3 },
      { kind: "area", col: "donor_values", label: "Values", rows: 3 },
      {
        kind: "area", col: "donor_strategic_priorities", rows: 5,
        help: "Current strategic priorities, rotating themes and the period they cover "
          + "(e.g. '2026 theme: AMR; 2026–2030 strategy').",
      },
      { kind: "text", col: "donor_strategy_url", label: "Donor strategy (URL)",
        help: "Link to the donor's published strategy document." },
    ],
  },
  {
    id: "funding",
    title: "Funding",
    fields: [
      { kind: "text", col: "donor_total_awards" },
      { kind: "text", col: "donor_total_funding_to_date" },
      { kind: "text", col: "donor_current_awards" },
      { kind: "text", col: "donor_past_awards" },
      { kind: "text", col: "donor_projected_budget" },
      { kind: "text", col: "donor_projected_budget_period" },
      { kind: "multi", col: "donor_funding_mechanism", options: FUNDING_MECHANISMS,
        label: "Funding mechanism (type)" },
      { kind: "area", col: "donor_funding_programs", rows: 4 },
      {
        kind: "repeater", col: "donor_funding_tiers_json", label: "Funding tiers",
        columns: [
          { key: "name", label: "Tier / band / stage" },
          { key: "amount", label: "Amount / ceiling" },
          { key: "duration", label: "Duration" },
          { key: "notes", label: "Notes / criteria" },
        ],
        help: "A row without a tier name is dropped on save.",
      },
    ],
  },
  {
    id: "scope",
    title: "Scope & fit",
    fields: [
      {
        kind: "multi", col: "donor_priority_areas", options: PA_ALL_KEYS,
        label: "Strategic priority areas",
        help: "Per-area RATINGS are still edited in the classic app; they are left "
          + "untouched by a save here.",
      },
      {
        kind: "multi", col: "donor_geographic_scope", options: GEO_OPTIONS,
        label: "Funding scope — geographies (UN regions / tiers / countries)",
      },
      { kind: "area", col: "donor_in_scope", rows: 4 },
      { kind: "area", col: "donor_out_of_scope", rows: 4 },
    ],
  },
  {
    id: "eligibility",
    title: "Eligibility & process",
    fields: [
      { kind: "matrix", groups: ["Legal & registration requirements", "Requirements & compliance"] },
      { kind: "singleOther", col: "donor_direct_local_org_eligible",
        options: LOCAL_ORG_ELIGIBLE, label: "Direct local org eligible" },
      { kind: "singleOther", col: "donor_active_route_status", options: ROUTE_STATUSES,
        label: "Route status" },
      { kind: "singleOther", col: "donor_funding_cycle", options: FUNDING_CYCLES,
        label: "Funding cycle / timing" },
      { kind: "singleOther", col: "donor_reporting_requirements",
        options: REPORTING_REQUIREMENTS },
      { kind: "singleOther", col: "donor_application_process",
        options: APPLICATION_PROCESSES, label: "Application process" },
      { kind: "text", col: "donor_application_deadlines" },
      { kind: "text", col: "donor_submission_portal_url" },
      { kind: "text", col: "donor_recent_activity" },
      { kind: "area", col: "donor_eligibility_notes", rows: 3 },
      { kind: "area", col: "donor_selection_criteria", rows: 3 },
      { kind: "multi", col: "donor_hq_country_required", options: ["Any", ...COUNTRIES] },
      { kind: "select", col: "org_stage_required",
        options: CONDITION_CHOICE.org_stage_required, pretty: true },
      { kind: "text", col: "donor_max_annual_budget" },
      { kind: "text", col: "donor_min_track_record" },
      { kind: "multi", col: "donor_required_partner_type",
        options: ["Any", ...PARTNER_TYPE_OPTIONS] },
      { kind: "multi", col: "donor_required_partner_country", options: ["Any", ...COUNTRIES] },
      { kind: "text", col: "donor_max_request_pct_of_budget" },
      { kind: "text", col: "donor_min_cofinancing_secured_pct" },
      { kind: "select", col: "donor_entity_type_required",
        options: CONDITION_CHOICE.donor_entity_type_required, pretty: true },
      { kind: "select", col: "donor_requires_pi",
        options: CONDITION_CHOICE.donor_requires_pi, pretty: true },
      { kind: "multi", col: "donor_registration_region",
        options: ["Any", ...BROAD_GEOGRAPHIES, ...COUNTRIES] },
      { kind: "select", col: "donor_pi_country_scope",
        options: CONDITION_CHOICE.donor_pi_country_scope, pretty: true },
      { kind: "text", col: "donor_max_prior_grant" },
      { kind: "select", col: "donor_prior_beneficiary_rule",
        options: CONDITION_CHOICE.donor_prior_beneficiary_rule, pretty: true },
    ],
  },
  {
    id: "projects",
    title: "Past projects",
    fields: [
      {
        kind: "repeater", col: "donor_past_projects_json", label: "Past projects",
        columns: [
          { key: "title", label: "Project title" },
          { key: "amount", label: "Award amount" },
          { key: "currency", label: "Currency" },
          { key: "year", label: "Year" },
          { key: "country", label: "Country" },
          { key: "stage", label: "Stage / band" },
          { key: "description", label: "Description" },
          { key: "link", label: "Link" },
        ],
        help: "A row without a project title is dropped on save.",
      },
    ],
  },
  {
    id: "guidance",
    title: "Strategic guidance",
    fields: [
      { kind: "area", col: "donor_strategic_fit_notes", rows: 4 },
      { kind: "area", col: "donor_gaps_risks", rows: 4 },
      { kind: "area", col: "donor_recommended_approach", rows: 4 },
      { kind: "select", col: "donor_verification_level",
        options: CHOICE.donor_verification_level, pretty: true },
      { kind: "area", col: "donor_evidence_summary", label: "Evidence summary", rows: 3 },
      { kind: "area", col: "notes", label: "Notes", rows: 3 },
      { kind: "area", col: "donor_aliases", label: "Aliases", rows: 3 },
      { kind: "area", col: "donor_source_urls", label: "Source URLs", rows: 3 },
    ],
  },
  { id: "contacts", title: "Contacts", fields: [{ kind: "contacts" }] },
];

/** Every donor_intel column this form edits — what check-donors compares. */
export const SPEC_COLUMNS: string[] = TABS.flatMap((t) =>
  t.fields.flatMap((f) => ("col" in f ? [f.col] : [])));
