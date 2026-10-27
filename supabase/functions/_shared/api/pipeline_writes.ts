/**
 * The Pipeline's two write paths: the RFP editor's save, and recording a decision.
 *
 * Kept apart from routes_pipelines.ts, which only reads. A route that changes stored data
 * deserves to be read on its own, and the rules below are the ones a reader has to trust.
 *
 * WHAT THIS FILE DOES NOT DO: score. `alignment_score` and `auto_recommendation` arrive in
 * the payload because the browser computed them, running `core/scorer.py` itself through
 * the Pyodide seam — the same module the weekly scan uses. Porting `score_submission` here
 * would be a SECOND implementation of the scoring, which is exactly the drift that put
 * 70/45 and 90/70 on the same number for months. One implementation, called from two
 * places, beats two implementations that agree today.
 */
import { q, type Db } from "./db.ts";
import { body, json, str } from "./http.ts";
import type { Json } from "./jwt.ts";
import type { Ctx } from "./session.ts";

/** core/scorer.py's CRITERIA — the nine weighted criteria from scoring_weights.yaml. */
const CRITERIA = [
  "qualification", "strategic_fit", "capacity", "geographic_fit", "cofinancing",
  "funding_quality", "funder_relationship", "competitiveness", "bid_effort",
] as const;

/**
 * Exactly the columns views/rfp_editor.py writes — its `update` dict plus the nine
 * criteria it spreads in with `**vals`. Anything else is refused rather than ignored, so
 * a mistyped field name in the client fails loudly instead of silently not saving.
 */
const EDITABLE = new Set<string>([
  "opportunity_title", "opportunity_id", "funding_agency", "brief_description",
  "date_posted", "call_submission_deadline", "expected_award_date", "applicant_role",
  "lead_applicant", "sub_applicant", "date_completed", "amount_requested",
  "call_award_floor", "call_award_ceiling", "total_program_funding", "expected_awards",
  "funding_opportunity_number", "apply_url", "opportunity_type", "solicitation_type",
  "instrument_type", "notes", "how_to_apply", "eligibility_specifics",
  "compliance_requirements", "application_checklist", "funding_window", "time_to_award",
  "submission_format", "opportunity_link", "call_award_value", "currency",
  "project_duration", "focus_theme", "call_geographic_scope", "call_domain_areas",
  "feasibility", "decline_flags_present", "key_risks", "alignment_score",
  "auto_recommendation", "submissions", "decision", "decision_note", "stage",
  "progress_status", "donor_decision", "assigned_to", "action_deadline", "last_update",
  "next_action", "remarks", "proposal_lead", "contributors", "reviewers", "support_roles",
  "date_of_approval", "amount_secured", "currency_secured", "donor_program_officer",
  "kickoff_date", "next_step",
  ...CRITERIA,
]);

/** The editor stamps these itself; a client sending them would be overwriting the audit. */
const STAMPED = new Set(["decision_overridden_by", "decision_overridden_at"]);

/** The reporting fields that live on the linked applied_funding row. */
const REPORTING = ["status", "report_type", "report_due_date", "owner", "remarks"] as const;

// ── core/donor_decision.py, ported ───────────────────────────────────────────
// Three places had their own copy of this test and they have to agree. Same here: the
// warning below, and the stage a row reads as, both depend on it.
const NO_ANSWER = new Set(["", "none", "nan", "nat", "null", "not submitted"]);
const norm = (v: unknown) => str(v).trim().toLowerCase();
export const isNoAnswer = (v: unknown) => NO_ANSWER.has(norm(v));
/** "Under Review" is deliberately NOT an outcome: it records that we are waiting. */
export const isOutcome = (v: unknown) => norm(v) === "approved" || norm(v) === "not approved";

// ── The rules, as pure functions ─────────────────────────────────────────────
// Exported so tests and the parity harness can drive them directly rather than through
// HTTP and a session. The route below is glue around these.

/** Which of the submitted column names the editor may not write, and why. */
export function checkFields(fields: Record<string, unknown>): {
  unknown: string[]; stamped: string[];
} {
  const unknown = Object.keys(fields).filter((k) => !EDITABLE.has(k));
  return { unknown, stamped: unknown.filter((k) => STAMPED.has(k)) };
}

/**
 * rfp_editor.py, 2026-08-17: this used to force donor_decision to "Under Review" whenever
 * progress was Completed and the answer was blank. The intent was right — a Completed row
 * with no donor decision leaves Tracking without entering Applied Funding, which is how a
 * grant went missing once — but writing it invisibly meant the app stored a decision
 * nobody had made.
 *
 * So the gap is REPORTED rather than papered over, and the report is the feature. A route
 * that saved correctly and said nothing would reintroduce the silent write with extra steps.
 */
export const completedWithoutDonorDecision = (row: Json): boolean =>
  norm(row.progress_status) === "completed" && isNoAnswer(row.donor_decision);

export type ReportingAction =
  | { kind: "none" }
  | { kind: "update"; fundingId: string; payload: Record<string, unknown> }
  | { kind: "insert"; payload: Record<string, unknown> };

/**
 * What the Reporting tab's values should do to applied_funding. NOT an upsert: update the
 * linked row when there is one, otherwise create one ONLY if the person actually entered
 * something, or every save of an RFP would leave an empty grant row behind.
 *
 * `reporting` undefined means the tab was never shown (it is reachable from Funding, not
 * from the editor), so the grant must not be touched at all.
 */
export function reportingAction(
  reporting: unknown, linkedFundingId: string | null,
): ReportingAction {
  if (!reporting || typeof reporting !== "object" || Array.isArray(reporting)) {
    return { kind: "none" };
  }
  const src = reporting as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (const k of REPORTING) payload[k] = src[k] ?? null;
  if (linkedFundingId) return { kind: "update", fundingId: linkedFundingId, payload };
  const hasValue = Object.values(payload).some((v) => v !== null && str(v).trim() !== "");
  return hasValue ? { kind: "insert", payload } : { kind: "none" };
}

export function createPipelineWrites(db: Db) {
  const nowIso = () => new Date().toISOString();

  /**
   * PATCH /pipelines/rfp/:uid — the editor's save.
   *
   * Body: `{ fields: {...changed columns...}, reporting?: {...} }`. Sparse: only what
   * changed. `reporting` is present only when the caller showed the Reporting tab, because
   * tab visibility is a caller decision (it is reachable from Funding, not from the
   * editor itself) and the route must not guess at it.
   */
  async function patchRfp(req: Request, ctx: Ctx, uid: string): Promise<Response> {
    const b = await body(req);
    const fields = (b.fields ?? {}) as Record<string, unknown>;
    if (typeof fields !== "object" || Array.isArray(fields)) {
      return json({ error: "fields must be an object of columns to change." }, 400);
    }

    // Refuse unknown keys rather than dropping them: a typo in a field name should fail
    // where it is made, not look like a save that did nothing.
    const { unknown, stamped } = checkFields(fields);
    if (unknown.length) {
      return json({
        error: stamped.length
          ? "These columns are stamped by the server and cannot be set."
          : "Unknown column(s) for the RFP editor.",
        problems: unknown,
      }, 400);
    }
    if (!Object.keys(fields).length && b.reporting === undefined) {
      return json({ error: "Nothing to save." }, 400);
    }

    const sb = db.as(ctx.scope);
    const before = await sb.get("rfp_submissions", `select=*&uid=eq.${q(uid)}&limit=1`);
    // A row that is missing and a row this tenant cannot see answer alike, so the route
    // cannot be used to discover that a uid exists somewhere else.
    if (!before.length) return json({ error: "No such opportunity." }, 404);

    const update: Record<string, unknown> = { ...fields };
    if (Object.keys(fields).length) {
      // rfp_editor.py stamps these on every save, not only when the decision changed.
      update.decision_overridden_by = ctx.session.email;
      update.decision_overridden_at = nowIso();
    }

    const saved = Object.keys(update).length
      ? await sb.update("rfp_submissions", `uid=eq.${q(uid)}`, update)
      : before;
    if (!saved.length) return json({ error: "The opportunity was not updated." }, 409);
    const row = saved[0];

    const warnings = await writeReporting(sb, b.reporting as Json, row, uid);
    return json({ row, warnings });
  }

  /**
   * The applied_funding side, and the warning that must travel with it.
   *
   * NOT an upsert. Update the linked row when there is one; otherwise create one ONLY if
   * the person actually entered a reporting value, or every save of an RFP would leave an
   * empty grant row behind.
   */
  async function writeReporting(
    sb: ReturnType<Db["as"]>, reporting: unknown, row: Json, uid: string,
  ): Promise<{ code: string; detail: string }[]> {
    const warnings: { code: string; detail: string }[] = [];
    if (completedWithoutDonorDecision(row)) {
      warnings.push({
        code: "completed_without_donor_decision",
        detail: "Progress is Completed but no donor decision is recorded, so this row will " +
          "not appear in Applied Funding yet. Set the donor decision once the funder answers.",
      });
    }

    if (reporting === undefined) return warnings;
    const linked = await sb.get("applied_funding",
      `select=funding_id&form_id_link=eq.${q(uid)}&limit=1`);
    const fundingId = linked.length ? str(linked[0].funding_id) || null : null;
    const action = reportingAction(reporting, fundingId);

    if (action.kind === "update") {
      await sb.update("applied_funding", `funding_id=eq.${q(action.fundingId)}`, action.payload);
    } else if (action.kind === "insert") {
      // funding_id is NOT NULL, so seed it from the uid; form_id_link ties it back.
      await sb.insert("applied_funding", {
        ...action.payload,
        funding_id: `G-${uid}`,
        form_id_link: uid,
        donor_title: row.opportunity_title ?? null,
      });
    }
    return warnings;
  }

  return { patchRfp };
}
