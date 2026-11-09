/**
 * Reading a stored column into the editor, and writing it back.
 *
 * Kept apart from the form itself because this is where a shared editor goes quietly
 * wrong. `views/rfp_editor.py` opens with the same six helpers (`_str`, `_num`, `_date`,
 * `_is_blank`, `_val`, `_multi_default`) and they exist for a reason: a column can arrive
 * as null, as a number, as a Postgres array, or as the comma-joined string an older Excel
 * import left behind, and the widget must neither render "nan" nor write one back.
 *
 * The two directions have to agree, and that is the real hazard. The editor saves only
 * what CHANGED, which it works out by comparing the loaded value with the current one. Two
 * hand-written coercions that disagree make a field either permanently dirty — saved and
 * re-scored on every open, for no edit — or permanently clean, and never saved at all.
 * So the pairing is declared once, as KIND, and pinned by scripts/rfp-values.test.mjs.
 */

/** `_str`: "" for null / undefined / NaN, so no widget ever shows "nan". */
export const txt = (v: unknown): string =>
  v === null || v === undefined || (typeof v === "number" && Number.isNaN(v)) ? "" : String(v);

/**
 * Numbers stay STRINGS in form state. A number input bound to a number cannot hold the
 * empty string, and empty is a real value here: `float(x) if x else None` in the Python
 * writes null, which is not the same as 0.
 */
export const numText = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : "";
};

/** yyyy-mm-dd, which is what `<input type="date">` and the column both want. */
export const dateText = (v: unknown): string => {
  const s = txt(v).trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
};

/** `_team_multi`'s coercion: a list stays a list, anything else splits on , or ;. The
 *  "nan"/"none" guard is the Python's — those are pandas stringifying an empty cell. */
export const toList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => txt(x).trim()).filter(Boolean);
  const s = txt(v).trim();
  if (!s || s.toLowerCase() === "nan" || s.toLowerCase() === "none") return [];
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((x) => txt(x).trim()).filter(Boolean);
    } catch { /* not JSON after all — fall through to the split */ }
  }
  return s.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
};

export const isTruthyFlag = (v: unknown): boolean =>
  v === true || ["true", "yes", "1", "y"].includes(txt(v).trim().toLowerCase());

/** `_val`: "" and the em-dash placeholder both mean "no value", which is null. */
export const orNull = (s: string): string | null => {
  const t = s.trim();
  return t === "" || t === "—" ? null : t;
};

/** `float(x) if x else None`. Note that 0 writes null, not 0 — in the Python too. */
export const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

export const intOrNull = (s: string): number | null => {
  const n = numOrNull(s);
  return n === null ? null : Math.round(n);
};

export const listOrNull = (v: string[]): string[] | null => (v.length ? v : null);

export type Kind = "text" | "number" | "int" | "date" | "list" | "bool";
export type FormValue = string | string[] | boolean;
export type Form = Record<string, FormValue>;

/**
 * Column → how its value is held while editing. Every name here is on the PATCH route's
 * own `EDITABLE` set (supabase/functions/_shared/api/pipeline_writes.ts), which refuses
 * anything else, so this list cannot quietly grow a column the server will not take.
 */
export const KIND: Record<string, Kind> = {
  // Opportunity
  opportunity_title: "text", opportunity_id: "text", funding_agency: "text",
  brief_description: "text", date_posted: "date", call_submission_deadline: "date",
  expected_award_date: "date", applicant_role: "text", funding_window: "text",
  time_to_award: "text", submission_format: "text", lead_applicant: "text",
  sub_applicant: "text", opportunity_link: "text", call_award_value: "number",
  currency: "text", project_duration: "int", focus_theme: "text",
  call_geographic_scope: "list", call_domain_areas: "list",
  funding_opportunity_number: "text", apply_url: "text", opportunity_type: "text",
  solicitation_type: "text", instrument_type: "text", notes: "text",
  // Eligibility
  feasibility: "text", qualification: "text", strategic_fit: "text", capacity: "text",
  geographic_fit: "text", cofinancing: "text", funding_quality: "text",
  funder_relationship: "text", competitiveness: "text", bid_effort: "text",
  decline_flags_present: "bool", key_risks: "text",
  // Decision & pipeline
  decision: "text", decision_note: "text", submissions: "int", stage: "text",
  progress_status: "text", donor_decision: "text", assigned_to: "text",
  action_deadline: "date", last_update: "date", next_action: "text", remarks: "text",
  // Team
  proposal_lead: "text", contributors: "list", reviewers: "list", support_roles: "list",
  // Submission & award
  date_completed: "date", amount_requested: "number", call_award_floor: "number",
  call_award_ceiling: "number", total_program_funding: "number", expected_awards: "int",
  date_of_approval: "date", amount_secured: "number", currency_secured: "text",
  donor_program_officer: "text", kickoff_date: "date", next_step: "text",
  // Application
  how_to_apply: "text", eligibility_specifics: "text", compliance_requirements: "text",
  application_checklist: "text",
};

/**
 * `support_roles` is the one multi-value column stored as a string rather than an array:
 * its Excel column is "Support (e.g. tech/finance/compliance)" and the Python joins the
 * chosen functions with ", " on save.
 */
export const SUPPORT_JOINED = "support_roles";

export function readRow(row: Record<string, unknown>): Form {
  const out: Form = {};
  for (const [col, kind] of Object.entries(KIND)) {
    const v = row[col];
    out[col] = kind === "list" ? toList(v)
      : kind === "bool" ? isTruthyFlag(v)
      : kind === "date" ? dateText(v)
      : kind === "number" || kind === "int" ? numText(v)
      : txt(v);
  }
  return out;
}

export function columnValue(col: string, v: FormValue): unknown {
  if (col === SUPPORT_JOINED) {
    const chosen = v as string[];
    return chosen.length ? chosen.join(", ") : null;
  }
  switch (KIND[col]) {
    case "list": return listOrNull(v as string[]);
    case "bool": return Boolean(v);
    case "number": return numOrNull(v as string);
    case "int": return intOrNull(v as string);
    default: return orNull(v as string);
  }
}

/** Which columns the save should carry. Arrays compare by content, so a multi-select
 *  that was opened and closed again is not an edit. */
export const changedColumns = (now: Form, loaded: Form): string[] =>
  Object.keys(KIND).filter((c) => {
    const a = now[c], b = loaded[c];
    return Array.isArray(a) || Array.isArray(b)
      ? JSON.stringify(a) !== JSON.stringify(b)
      : a !== b;
  });
