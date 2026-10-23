// Donor display + scoring rules, ported from app_pages/donors.py so both apps show the
// same labels, categories and completeness numbers. Keep the two in step: each function
// names the Python helper it mirrors.
import { categoryFull, expandGeo, expandProgramAreas, subareaLabel } from "./vocab";

export type Donor = Record<string, unknown> & { canonical_key: string };
export type Contact = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Labels (_ACR, _LABEL_OVERRIDES, _label)
// ---------------------------------------------------------------------------
const ACR: Record<string, string> = {
  lmic: "LMIC", ngo: "NGO", hiv: "HIV", aids: "AIDS", tb: "TB", ncd: "NCD", ncds: "NCDs",
  mnch: "MNCH", srhr: "SRHR", hss: "HSS", ai: "AI", usd: "USD", uei: "UEI", sam: "SAM",
  mou: "MOU", cv: "CV", cvs: "CVs", irb: "IRB", ccm: "CCM", dfi: "DFI", us: "US",
  mande: "M&E", govt: "Govt",
};

const LABEL_OVERRIDES: Record<string, string> = {
  donor_type: "Donor type (descriptive)",
  donor_is_dual_role_implementer: "Also an implementer that publishes calls?",
  donor_opportunity_listing_urls: "Opportunity listing URL(s)",
  donor_local_board_required: "Local board members required",
  donor_govt_mou_required: "Government MOU required",
  donor_funding_platform_registration_required: "Funding-platform registration required",
  donor_cofinancing_required: "Co-financing required",
  donor_state_party_cofinancing_required: "Government / counterpart co-financing required",
  donor_indirect_cost_disallowed: "Indirect / overhead costs not allowed",
  donor_fund_use_conditions: "Conditions on use of funds",
  donor_multi_country_encouraged: "Encourages multi-country proposals",
  donor_summary_description: "Summary",
  donor_values: "Values",
  donor_strategy_url: "Strategy (URL)",
  donor_projected_budget_period: "Budget period",
  donor_strategic_priorities: "Strategic priorities",
  donor_in_scope: "What they fund (in scope)",
  donor_out_of_scope: "What they don't fund (out of scope)",
  donor_selection_criteria: "Selection / evaluation criteria",
  donor_funding_programs: "Funding programs / windows",
  donor_eligibility_notes: "Who can apply / lead",
  donor_application_deadlines: "Key dates / deadlines",
  donor_submission_portal_url: "Submission portal (URL)",
  donor_strategic_fit_notes: "Ideal applicant & what this funder rewards",
  donor_gaps_risks: "Common pitfalls & disqualifiers",
  donor_recommended_approach: "How to position a competitive application",
  donor_funders_collaborators: "Funders & Collaborators",
  donor_hq_country_required: "Applicant must be HQ'd in",
  org_stage_required: "Org stage required",
  donor_max_annual_budget: "Max annual budget (eligibility ceiling)",
  donor_indirect_cost_max_pct: "Indirect cost policy (% of project cost) allowed",
  donor_min_track_record: "Min largest grant managed (floor)",
  donor_required_partner_type: "Required partner type",
  donor_required_partner_country: "Required partner country",
  donor_max_request_pct_of_budget: "Max request (% of project budget)",
  donor_min_cofinancing_secured_pct: "Min co-financing secured (%)",
  donor_independent_entity_required: "Independent entity required (no INGO affiliates)",
  donor_welcome_registration_required: "Pre-registration / senior-leadership approval required",
  donor_entity_type_required: "Entity type required",
  donor_registration_region: "Registration region/country required",
  donor_requires_pi: "Requires an individual / PI",
  donor_pi_country_scope: "PI base-country scope",
  donor_max_prior_grant: "Max prior grant/award (eligibility ceiling)",
  donor_prior_beneficiary_rule: "Prior-beneficiary rule",
};

export function label(col: string): string {
  if (LABEL_OVERRIDES[col]) return LABEL_OVERRIDES[col];
  const bare = col.replace(/^(donor_|call_|org_)/, "");
  if (LABEL_OVERRIDES[bare]) return LABEL_OVERRIDES[bare];
  const words = bare.replace(/_/g, " ").split(/\s+/).filter(Boolean);
  return words.map((w, i) => {
    const lw = w.toLowerCase();
    if (ACR[lw]) return ACR[lw];
    return i === 0 ? lw.charAt(0).toUpperCase() + lw.slice(1) : lw;
  }).join(" ");
}

/** 'reimbursement_only' -> 'Reimbursement Only' (_pretty_choice). */
export function prettyChoice(v: unknown): string {
  const s = String(v ?? "").trim();
  return s ? s.replace(/_/g, " ").replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()) : "—";
}

// ---------------------------------------------------------------------------
// De-shouting (_ACRONYMS, _smart_token, _deshout) + display (_disp)
// ---------------------------------------------------------------------------
const ACRONYMS = new Set([
  "HIV", "AIDS", "TB", "MNCH", "HSS", "SRHR", "SRH", "NCD", "NCDS", "LMIC", "LMICS", "NGO",
  "NGOS", "CCM", "DFI", "UHC", "PHC", "WHO", "UN", "US", "EU", "UK", "AI", "HPV", "NTD", "NTDS",
  "RMNCAH", "RMNCH", "STI", "STIS", "WASH", "UNICEF", "UNAIDS", "UNFPA", "UNHCR", "UNESCO",
  "USAID", "CEPI", "GAVI", "COVID", "IRB", "MOU", "CSO", "CSOS", "PREP", "FP", "GBV", "R&D",
  "DR-TB", "GF", "AFD", "AFDB", "EC", "MCF", "BMGF",
]);

const isUpper = (s: string) => s === s.toUpperCase() && s !== s.toLowerCase();

function capFirst(s: string): string {
  const i = s.search(/\p{L}/u);
  return i < 0 ? s : s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1);
}

function smartToken(tok: string): string {
  const lead = tok.match(/^[^A-Za-z]*/)![0];
  const rest = tok.slice(lead.length);
  const trail = rest.match(/[^A-Za-z]*$/)![0];
  const core = trail ? rest.slice(0, rest.length - trail.length) : rest;
  if (!core || !isUpper(core) || ACRONYMS.has(core.toUpperCase())) return tok;
  const runs = core.match(/[A-Z]+/g) ?? [];
  const longest = Math.max(0, ...runs.map((r) => r.length));
  if (longest >= 5 || (core.includes("-") && runs.length >= 2)) return lead + core.toLowerCase() + trail;
  return tok;
}

function deshout(text: string): string {
  if (!text || !/[A-Z]/.test(text)) return text;
  return text.split(/([.;]\s+)/).map((seg) => {
    if (!seg || /^[.;]\s+$/.test(seg)) return seg;
    const seg2 = seg.split(" ").map(smartToken).join(" ");
    return seg2 !== seg ? capFirst(seg2) : seg;
  }).join("");
}

/** Clean display value or null for blank / 'nan' / 'none' (_disp). */
export function disp(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isNaN(v)) return null;
  const s = (typeof v === "object" ? JSON.stringify(v) : String(v)).trim();
  if (["nan", "none", "nat", ""].includes(s.toLowerCase())) return null;
  const neutral = s.replaceAll("{country}'s ", "").replaceAll("{country}'s", "")
    .replaceAll("in {country}", "in priority countries").replaceAll("{country}", "priority countries");
  return deshout(neutral);
}

export function titleName(row: Donor): string {
  const donor = disp(row.donor) ?? "Donor";
  const short = disp(row.donor_short) ?? "";
  return short && !donor.toLowerCase().includes(short.toLowerCase()) ? `${donor} (${short})` : donor;
}

export function webUrl(v: unknown): string | null {
  const s = disp(v);
  if (!s) return null;
  return /^https?:\/\//.test(s) ? s : `https://${s}`;
}

// ---------------------------------------------------------------------------
// Categories (_CATEGORY_CANON, _normalize_category)
// ---------------------------------------------------------------------------
const BIL = "Bilaterals / government development agencies";
const MUL = "Multilaterals & development banks";
const PHI = "International philanthropies & foundations";
const USF = "U.S. federal agencies";
const PRI = "Private sector / corporate";
const ACA = "Academic / research institutions";
const CATEGORY_CANON: Record<string, string> = {
  "bilaterals": BIL, "bilateral": BIL, "bilaterals / government development agencies": BIL,
  "government development agencies": BIL,
  "multilaterals": MUL, "multilateral": MUL, "multilaterals / global health partnerships": MUL,
  "multilateral / global health partnerships": MUL, "global health partnerships": MUL,
  "multilateral development bank / dfi": MUL, "multilateral development banks / dfis": MUL,
  "multilateral development bank": MUL, "development finance institution": MUL, "dfi": MUL,
  "multilaterals & development banks": MUL,
  "international philanthropies and foundations": PHI, "international philanthropies & foundations": PHI,
  "philanthropies and foundations": PHI, "philanthropy": PHI, "foundation": PHI, "foundations": PHI,
  "u.s. federal agencies": USF, "u.s. federal / bilateral agencies": USF, "us federal agencies": USF,
  "u.s. federal agency": USF,
  "private sector": PRI, "corporate": PRI,
  "academic": ACA, "research institution": ACA,
};
export const UNCATEGORISED = "(uncategorised)";

export function normalizeCategory(raw: unknown): string {
  if (raw === null || raw === undefined) return UNCATEGORISED;
  const s = String(raw).trim().replace(/\s+/g, " ");
  if (!s) return UNCATEGORISED;
  const key = s.toLowerCase().replace(/\.+$/, "");
  if (CATEGORY_CANON[key]) return CATEGORY_CANON[key];
  if (key.endsWith("s") && CATEGORY_CANON[key.slice(0, -1)]) return CATEGORY_CANON[key.slice(0, -1)];
  return s;
}

// ---------------------------------------------------------------------------
// Value parsing (_to_list, _json_dicts, ratings)
// ---------------------------------------------------------------------------
export function toList(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = String(v).trim();
  if (!s || ["nan", "none", "nat"].includes(s.toLowerCase())) return [];
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return j.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    // legacy free text
  }
  return s.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
}

function parseJson(v: unknown, fallback: unknown): unknown {
  if (v === null || v === undefined || v === "") return fallback;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function jsonDicts(v: unknown): Record<string, unknown>[] {
  const j = parseJson(v, []);
  return Array.isArray(j) ? j.filter((d) => d && typeof d === "object" && !Array.isArray(d)) : [];
}

export const pastProjects = (row: Donor) => jsonDicts(row.donor_past_projects_json).filter((p) => p.title);
export const fundingTiers = (row: Donor) => jsonDicts(row.donor_funding_tiers_json).filter((t) => t.name);

/** {canonical key: 0-5} (_as_rating_map). */
export function ratings(row: Donor): Record<string, number> {
  const raw = parseJson(row.donor_priority_ratings, {});
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = Math.trunc(Number(v));
      if (!Number.isNaN(n)) out[k] = Math.max(0, Math.min(5, n));
    }
  }
  return out;
}

export const isYes = (v: unknown) => String(v ?? "").trim().toLowerCase() === "yes";

// ---------------------------------------------------------------------------
// Field classification (_META … _FLAG_GROUPS)
// ---------------------------------------------------------------------------
const META = ["id", "updated_at", "created_at", "canonical_key", "category_clean",
  "online_source_check_status", "last_checked", "row_type", "award_size_basis"];
const SHORT_TEXT = ["donor", "donor_short", "donor_category", "donor_type", "donor_website",
  "donor_award_low", "donor_award_high", "donor_total_annual_funding_global", "donor_funding_mechanism"];
const LONG_TEXT = ["donor_aliases", "donor_geographic_scope", "donor_active_route_status",
  "donor_direct_local_org_eligible", "donor_priority_areas", "donor_verification_caveats",
  "donor_evidence_summary", "notes", "donor_source_urls", "donor_opportunity_listing_urls"];
export const CONTACT_FIELDS = ["donor_hq_address", "donor_hq_country", "donor_main_phone",
  "donor_general_email", "donor_linkedin_url", "donor_other_profile_urls", "donor_contact_persons",
  "donor_contact_emails", "donor_contact_phones", "donor_contact_linkedin_urls"];
const CHOICE = ["donor_prefinance_required", "donor_verification_level", "donor_is_dual_role_implementer"];
const PROFILE = ["donor_founded", "donor_summary_description", "donor_mission", "donor_vision",
  "donor_values", "donor_strategy_url", "donor_total_awards", "donor_total_funding_to_date",
  "donor_current_awards", "donor_past_awards", "donor_projected_budget", "donor_projected_budget_period",
  "donor_funding_cycle", "donor_recent_activity", "donor_application_process",
  "donor_reporting_requirements", "donor_past_projects_json", "donor_strategic_priorities",
  "donor_in_scope", "donor_out_of_scope", "donor_selection_criteria", "donor_funding_programs",
  "donor_funding_tiers_json", "donor_eligibility_notes", "donor_application_deadlines",
  "donor_submission_portal_url", "donor_strategic_fit_notes", "donor_gaps_risks",
  "donor_recommended_approach", "donor_priority_ratings", "donor_funders_collaborators",
  "donor_hq_country_required", "org_stage_required", "donor_max_annual_budget",
  "donor_min_track_record", "donor_required_partner_type", "donor_required_partner_country",
  "donor_max_request_pct_of_budget", "donor_min_cofinancing_secured_pct",
  "donor_entity_type_required", "donor_registration_region", "donor_requires_pi",
  "donor_pi_country_scope", "donor_max_prior_grant", "donor_prior_beneficiary_rule",
  "donor_indirect_cost_max_pct", "donor_fund_use_conditions"];
const HIDDEN = ["donor_verification_caveats", "donor_funded_geographies"];
const NON_FLAG = new Set([...META, ...SHORT_TEXT, ...LONG_TEXT, ...CHOICE, ...CONTACT_FIELDS, ...PROFILE, ...HIDDEN]);

const ELIG = ["donor_ngo_eligible", "donor_for_profit_eligible", "donor_govt_or_ccm_route_required",
  "donor_grant_route", "donor_procurement_tender_route", "donor_loan_dev_finance_route",
  "donor_subrecipient_partner_possible", "donor_open_call_unsolicited", "donor_invitation_solicited",
  "donor_two_stage_application", "donor_online_portal_submission", "donor_lmic_africa_focus",
  "donor_global_multi_country_scope"];

export const LIST_FIELDS = new Set(["donor_geographic_scope", "donor_priority_areas",
  "donor_funding_mechanism", "donor_funders_collaborators", "donor_hq_country_required",
  "donor_registration_region", "donor_required_partner_type", "donor_required_partner_country"]);

export type Schema = {
  columns: string[];                         // every column, in first-seen order (CSV export)
  flags: string[];
  groups: Record<string, string[]>;          // _FLAG_GROUPS
};

/** _FLAGS / _FLAG_GROUPS are derived from the table's columns, exactly as in Python. */
export function buildSchema(rows: Donor[]): Schema {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
  const flags = columns.filter((c) => !NON_FLAG.has(c));
  const fit = flags.filter((c) => c.endsWith("_fit"));
  const req = flags.filter((c) => !ELIG.includes(c) && !fit.includes(c));
  for (const rq of ["donor_cofinancing_required", "donor_prefinance_required"]) if (!req.includes(rq)) req.push(rq);
  return {
    columns, flags,
    groups: {
      "Legal & registration requirements": ELIG.filter((c) => flags.includes(c)),
      "Program-area fit": fit,
      "Requirements & compliance": req,
    },
  };
}

// ---------------------------------------------------------------------------
// Completeness (_COMPLETENESS_TEXT, _completeness, _completeness_band)
// ---------------------------------------------------------------------------
const COMPLETENESS_TEXT = ["donor", "donor_category", "donor_website", "donor_founded",
  "donor_general_email", "donor_main_phone", "donor_hq_country", "donor_hq_address",
  "donor_linkedin_url", "donor_other_profile_urls", "donor_summary_description", "donor_mission",
  "donor_vision", "donor_values", "donor_strategic_priorities", "donor_strategy_url",
  "donor_award_low", "donor_award_high", "donor_total_annual_funding_global", "donor_total_awards",
  "donor_total_funding_to_date", "donor_current_awards", "donor_past_awards", "donor_projected_budget",
  "donor_funding_programs", "donor_in_scope", "donor_out_of_scope", "donor_direct_local_org_eligible",
  "donor_active_route_status", "donor_prefinance_required", "donor_application_process",
  "donor_funding_cycle", "donor_reporting_requirements", "donor_application_deadlines",
  "donor_submission_portal_url", "donor_recent_activity", "donor_eligibility_notes",
  "donor_selection_criteria", "donor_strategic_fit_notes", "donor_gaps_risks",
  "donor_recommended_approach", "donor_verification_level", "donor_evidence_summary", "notes",
  "donor_source_urls"];
const COMPLETENESS_JSON = ["donor_funding_tiers_json", "donor_past_projects_json"];

export function completeness(row: Donor, schema: Schema): { pct: number; have: number; total: number } {
  let have = 0;
  let total = 0;
  for (const c of COMPLETENESS_TEXT) { total++; if (disp(row[c])) have++; }
  for (const c of [...LIST_FIELDS, ...COMPLETENESS_JSON]) {
    total++;
    if (c.endsWith("_json") ? jsonDicts(row[c]).length : toList(row[c]).length) have++;
  }
  total++;
  if (Object.keys(ratings(row)).length) have++;
  const fit = new Set(schema.groups["Program-area fit"]);
  for (const c of schema.flags) {
    if (fit.has(c)) continue;
    total++;
    if (["yes", "no", "not_sure"].includes(String(row[c] ?? "").trim().toLowerCase())) have++;
  }
  // Python's round() is banker's rounding; match it so both apps print the same percent.
  const raw = total ? (100 * have) / total : 0;
  const fl = Math.floor(raw);
  const pct = raw - fl === 0.5 ? (fl % 2 === 0 ? fl : fl + 1) : Math.round(raw);
  return { pct, have, total };
}

export function completenessBand(pct: number): { label: string; color: string } {
  if (pct >= 75) return { label: "High", color: "#16a34a" };
  if (pct >= 50) return { label: "Moderate", color: "#d97706" };
  return { label: "Low", color: "#dc2626" };
}

// ---------------------------------------------------------------------------
// Filters (the "Filter & search" block)
// ---------------------------------------------------------------------------
export type Filters = {
  q: string;
  categories: string[];
  verification: string[];
  areas: string[];
  applicant: string[];
  fundsIn: string[];
};
export const EMPTY_FILTERS: Filters = { q: "", categories: [], verification: [], areas: [], applicant: [], fundsIn: [] };

export const APPLICANT_FLAG: Record<string, string> = {
  "NGO": "donor_ngo_eligible",
  "For-profit / private": "donor_for_profit_eligible",
  "Sub-recipient / partner": "donor_subrecipient_partner_possible",
};

export function applyFilters(rows: Donor[], f: Filters, schema: Schema): Donor[] {
  let out = rows;
  const q = f.q.trim().toLowerCase();
  if (q) {
    out = out.filter((r) => [r.donor, r.donor_short, r.donor_aliases]
      .map((v) => (v == null ? "" : String(v))).join(" ").toLowerCase().includes(q));
  }
  if (f.categories.length) out = out.filter((r) => f.categories.includes(normalizeCategory(r.donor_category)));
  if (f.verification.length) out = out.filter((r) => f.verification.includes(String(r.donor_verification_level ?? "")));
  if (f.areas.length) {
    const want = expandProgramAreas(f.areas);
    out = out.filter((r) => [...expandProgramAreas(toList(r.donor_priority_areas))].some((k) => want.has(k)));
  }
  const appl = f.applicant.map((a) => APPLICANT_FLAG[a]).filter((c) => c && schema.columns.includes(c));
  if (appl.length) out = out.filter((r) => appl.some((c) => isYes(r[c])));
  if (f.fundsIn.length) {
    const want = expandGeo(f.fundsIn);
    out = out.filter((r) => [...expandGeo(toList(r.donor_geographic_scope))].some((g) => want.has(g)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Share / download summary (_summary_lines + helpers)
// ---------------------------------------------------------------------------
function projectLine(p: Record<string, unknown>): string {
  const bits: string[] = [];
  const amt = p.amount;
  if (amt !== null && amt !== undefined && amt !== "") {
    const cur = String(p.currency ?? "").trim();
    const n = Number(amt);
    bits.push((cur ? `${cur} ` : "") + (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : String(amt)).trim());
  }
  for (const k of ["year", "country", "stage"]) if (p[k]) bits.push(String(p[k]).trim());
  let head = `- ${String(p.title).trim()}`;
  if (bits.length) head += ` — ${bits.join(", ")}`;
  const desc = String(p.description ?? "").trim();
  if (desc) head += `. ${desc}`;
  const link = String(p.link ?? "").trim();
  if (link) head += ` (${link})`;
  return head;
}

function tierLine(t: Record<string, unknown>): string {
  const seg = ["amount", "duration"].filter((k) => t[k]).map((k) => String(t[k]).trim());
  let head = `- **${String(t.name ?? "").trim()}**`;
  if (seg.length) head += ` — ${seg.join(", ")}`;
  const notes = String(t.notes ?? "").trim();
  if (notes) head += `. ${notes}`;
  return head;
}

export function dispField(row: Donor, col: string): string | null {
  if (LIST_FIELDS.has(col)) {
    const vals = toList(row[col]);
    return vals.length ? vals.join(", ") : null;
  }
  return disp(row[col]);
}

export function summaryLines(row: Donor, schema: Schema): string[] {
  const lines = [`# ${titleName(row)}`, ""];
  const section = (title: string, pairs: [string, string | null][]) => {
    const kept = pairs.filter(([, v]) => v);
    if (!kept.length) return;
    lines.push(title);
    for (const [lbl, v] of kept) lines.push(`- **${lbl}:** ${v}`);
    lines.push("");
  };
  const flags = (group: string) => {
    const labs = (schema.groups[group] ?? []).filter((c) => isYes(row[c]))
      .map((c) => (group === "Program-area fit" ? label(c).replace(/\s*fit$/i, "") : label(c)));
    return labs.length ? labs.join(", ") : null;
  };
  const choice = (col: string) => (disp(row[col]) ? prettyChoice(row[col]) : null);
  const listf = (col: string) => {
    const vals = toList(row[col]);
    return vals.length ? vals.join(", ") : null;
  };
  const d = (col: string) => disp(row[col]);

  const cat = normalizeCategory(row.donor_category);
  section("Overview", [
    ["Category", cat !== UNCATEGORISED ? cat : null], ["Donor type", d("donor_type")],
    ["Also an implementer that publishes calls", d("donor_is_dual_role_implementer")],
    ["Founded", d("donor_founded")], ["Website", d("donor_website")], ["HQ country", d("donor_hq_country")],
    ["HQ address", d("donor_hq_address")], ["General email", d("donor_general_email")],
    ["Main phone", d("donor_main_phone")], ["LinkedIn", d("donor_linkedin_url")],
    ["Other profiles", d("donor_other_profile_urls")],
  ]);
  section("About & strategy", [
    ["Summary", d("donor_summary_description")], ["Mission", d("donor_mission")],
    ["Vision", d("donor_vision")], ["Values", d("donor_values")],
    [label("donor_strategic_priorities"), d("donor_strategic_priorities")],
    ["Strategy (URL)", d("donor_strategy_url")],
  ]);
  const lo = d("donor_award_low");
  const hi = d("donor_award_high");
  let pb = d("donor_projected_budget");
  if (pb && d("donor_projected_budget_period")) pb = `${pb} (${d("donor_projected_budget_period")})`;
  section("Funding", [
    ["Award range", lo || hi ? `${lo ?? "—"} – ${hi ?? "—"}` : null],
    ["Annual funding", d("donor_total_annual_funding_global")], ["Total awards", d("donor_total_awards")],
    ["Total funding to date", d("donor_total_funding_to_date")], ["Current awards", d("donor_current_awards")],
    ["Past awards", d("donor_past_awards")], ["Projected budget", pb],
    ["Funding mechanism", dispField(row, "donor_funding_mechanism")],
    [label("donor_funders_collaborators"), dispField(row, "donor_funders_collaborators")],
    [label("donor_funding_programs"), d("donor_funding_programs")],
  ]);
  const tiers = fundingTiers(row);
  if (tiers.length) lines.push("Funding tiers / bands", ...tiers.map(tierLine), "");

  const areas = toList(row.donor_priority_areas);
  const rmap = ratings(row);
  const scopePairs = ([
    ["Funding scope — geographies", listf("donor_geographic_scope")],
    [label("donor_in_scope"), d("donor_in_scope")],
    [label("donor_out_of_scope"), d("donor_out_of_scope")],
  ] as [string, string | null][]).filter(([, v]) => v);
  if (areas.length || scopePairs.length) {
    lines.push("Scope & fit");
    for (const [k, v] of Object.entries(rmap).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      lines.push(`- **Priority:** ${subareaLabel(k)} (${categoryFull(k)}) — ${v}/5`);
    }
    for (const a of areas) if (!(a in rmap)) lines.push(`- **Priority area:** ${subareaLabel(a)}`);
    for (const [lbl, v] of scopePairs) lines.push(`- **${lbl}:** ${v}`);
    lines.push("");
  }
  section("Eligibility & process", [
    ["Legal & registration requirements", flags("Legal & registration requirements")],
    ["Requirements & compliance", flags("Requirements & compliance")],
    ["Direct local org eligible", d("donor_direct_local_org_eligible")],
    ["Route status", d("donor_active_route_status")], ["Prefinance", choice("donor_prefinance_required")],
    ["Application process", d("donor_application_process")], ["Funding cycle", d("donor_funding_cycle")],
    ["Reporting requirements", d("donor_reporting_requirements")],
    [label("donor_application_deadlines"), d("donor_application_deadlines")],
    [label("donor_submission_portal_url"), d("donor_submission_portal_url")],
    ["Recent activity", d("donor_recent_activity")],
    [label("donor_eligibility_notes"), d("donor_eligibility_notes")],
    [label("donor_selection_criteria"), d("donor_selection_criteria")],
    [label("donor_hq_country_required"), listf("donor_hq_country_required")],
    [label("org_stage_required"), d("org_stage_required")],
    [label("donor_max_annual_budget"), dispField(row, "donor_max_annual_budget")],
    [label("donor_min_track_record"), dispField(row, "donor_min_track_record")],
    [label("donor_required_partner_type"), listf("donor_required_partner_type")],
    [label("donor_required_partner_country"), listf("donor_required_partner_country")],
    [label("donor_max_request_pct_of_budget"), d("donor_max_request_pct_of_budget")],
    [label("donor_min_cofinancing_secured_pct"), d("donor_min_cofinancing_secured_pct")],
    [label("donor_entity_type_required"), choice("donor_entity_type_required")],
    [label("donor_registration_region"), listf("donor_registration_region")],
    [label("donor_requires_pi"), choice("donor_requires_pi")],
    [label("donor_pi_country_scope"), choice("donor_pi_country_scope")],
    [label("donor_max_prior_grant"), dispField(row, "donor_max_prior_grant")],
    [label("donor_prior_beneficiary_rule"), choice("donor_prior_beneficiary_rule")],
  ]);
  const projects = pastProjects(row);
  if (projects.length) lines.push(`Past Projects — funded projects (${projects.length})`, ...projects.map(projectLine), "");
  section("Strategic guidance", [
    [label("donor_strategic_fit_notes"), d("donor_strategic_fit_notes")],
    [label("donor_gaps_risks"), d("donor_gaps_risks")],
    [label("donor_recommended_approach"), d("donor_recommended_approach")],
  ]);
  section("Sources & data quality", [
    ["Verification", choice("donor_verification_level")], ["Evidence summary", d("donor_evidence_summary")],
    ["Notes", d("notes")], ["Aliases", d("donor_aliases")], ["Source URLs", d("donor_source_urls")],
    ["Opportunity listing URL(s)", d("donor_opportunity_listing_urls")],
  ]);
  return lines;
}

// ---------------------------------------------------------------------------
// CSV (the "Download all … donors (CSV)" export)
// ---------------------------------------------------------------------------
export function toCsv(rows: Donor[], columns: string[]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

export function download(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
