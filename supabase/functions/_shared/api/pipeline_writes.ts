/**
 * The Pipeline's two write paths: the RFP editor's save, and recording a decision.
 *
 * Kept apart from routes_pipelines.ts, which only reads. A route that changes stored data
 * deserves to be read on its own, and the rules below are the ones a reader has to trust.
 *
 * WHAT THIS FILE DOES NOT DO: score. Porting `score_submission` here would be a SECOND
 * implementation of the rule, which is exactly the drift that put 70/45 and 90/70 on the
 * same number for months. Instead a save that could have changed the answer QUEUES the
 * `rescore` job (routes_jobs.ts), which runs the one `core.auto_scorer.auto_score` the scan
 * runs and writes the number back. One implementation, called from two places.
 *
 * So the score a save leaves behind is not final: the job lands a minute or so later. The
 * response says when one was queued precisely so the caller can show that, rather than
 * presenting a stale number as settled.
 *
 * AND IT DOES NOT TOMBSTONE. Recording a decision has two consequences beyond the row —
 * the ML training label (`core/decision_log.py`) and the scan's tombstone
 * (`core/seen_ledger.py`) — and both are queued to Python for the same reason the score
 * is. The tombstone in particular reaches `seen_ledger.column_map()`, which PROBES the
 * live `rfp_seen` table to find out whether it uses the modern or the legacy column
 * spelling. A TypeScript guess at that is a guess at a schema, and when it guesses wrong
 * the tombstone is silently not written — which is precisely the reported bug that
 * function exists to fix: "we keep declining this and it keeps coming back".
 */
import { q, type Db } from "./db.ts";
import { body, json, str } from "./http.ts";
import type { Json } from "./jwt.ts";
import type { Ctx } from "./session.ts";

/** Queue work for the Actions runner. `routes_jobs.ts::enqueue`, narrowed to what is used. */
export type Enqueue = (kind: string, params: Json, ctx: Ctx) => Promise<string | null>;

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

/**
 * `config/dropdowns.yaml`'s `decisions`, which is what the Review page's selectbox offers
 * (`views/review_rfp.py`, via `core/dropdowns.py`). Copied rather than read, because that
 * YAML is a repo file and this module also runs as a Deno Edge Function with no filesystem
 * to read it from — so the test "the decision vocabulary matches config/dropdowns.yaml"
 * re-reads the YAML and fails if the two drift.
 *
 * Validated rather than accepted free-form: `decision` drives who appears in Track
 * (`views/tracking_rfp.py` filters `in.(Proceed, Proceed as sub)`) and whether the scan
 * tombstones the row, so a typo here is not a cosmetic one.
 *
 * The Python ALSO prepends a row's existing decision when it is not in the list, so a
 * value an older vocabulary allowed stays selectable. That is a display rule and this is
 * a write route: it refuses what the vocabulary does not contain, rather than letting a
 * retired value back in through the API.
 */
export const DECISIONS = ["Proceed", "Park", "Decline"] as const;

/**
 * Columns a save may change WITHOUT the score moving — what the team records about its own
 * work on a bid, after the system has judged the call.
 *
 * It is a DENYLIST rather than a list of scoring inputs, and that direction is the whole
 * point. Scoring lives in Python and will grow new inputs; a list of them kept here would
 * fall behind silently, and the symptom would be a row whose score never updates — a wrong
 * number presented as current, which is the failure this whole exercise exists to end. Miss
 * a name from the list below instead and the cost is a redundant job: visible, cheap, right.
 *
 * Every name was checked against core/{criteria_derive,auto_scorer,matching,scorer,
 * assessment}.py and appears in none of them, and the test "no workflow-only column is a
 * scoring input" re-checks that against those files on every run, so the day one of them
 * starts feeding the score this list fails rather than quietly stops queueing.
 *
 * WHAT IS DELIBERATELY NOT HERE, though it looks like workflow state:
 *   progress_status, donor_decision, date_completed — criteria_derive._is_completed reads
 *   all three. Marking a bid submitted tells the scorer the deadline runway is moot, so it
 *   genuinely changes the answer. They are scoring inputs wearing workflow clothes.
 */
const WORKFLOW_ONLY = new Set<string>([
  "decision", "decision_note", "stage", "assigned_to", "action_deadline", "last_update",
  "next_action", "remarks", "proposal_lead", "contributors", "reviewers", "support_roles",
  "date_of_approval", "amount_secured", "currency_secured", "donor_program_officer",
  "kickoff_date", "next_step", "submissions",
]);

/**
 * Could this save have changed the score? Anything outside WORKFLOW_ONLY counts, including
 * `alignment_score` itself: a client that still computes its own number gets it replaced by
 * the server's, which is the migration finishing rather than a conflict.
 */
export function needsRescore(fields: Record<string, unknown>): boolean {
  return Object.keys(fields).some((k) => !WORKFLOW_ONLY.has(k));
}

/** For the test that re-checks the list against the Python. */
export const workflowOnlyColumns = (): string[] => [...WORKFLOW_ONLY];

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

export function createPipelineWrites(db: Db, enqueue: Enqueue | null = null) {
  const nowIso = () => new Date().toISOString();

  /**
   * Queue the re-score for the row just saved. NON-FATAL: the save already succeeded, and
   * failing it here would make the person's edit look lost when in fact only the score is
   * behind. The warning is how they find out — silence would leave a stale number on screen
   * with nothing to say it was never recomputed.
   *
   * tenant_id is passed explicitly from the saved row rather than left to the job row,
   * because `enqueue` stores no tenant for the placeholder scope and the runner refuses a
   * re-score it cannot scope — it would score one tenant's rows against another's profile.
   */
  async function queueRescore(
    ctx: Ctx, row: Json, uid: string,
  ): Promise<{ jobId: string | null; warning: { code: string; detail: string } | null }> {
    const tenantId = str(row.tenant_id).trim() || db.scopeTid(ctx.scope);
    const stale = {
      code: "rescore_not_queued",
      detail: "Saved, but the score could not be queued for recalculation, so it still " +
        "reflects the opportunity as it was before this edit.",
    };
    if (!enqueue || /^0{8}-/.test(tenantId)) return { jobId: null, warning: stale };
    try {
      const jobId = await enqueue("rescore", { tenant_id: tenantId, uid }, ctx);
      return jobId ? { jobId, warning: null } : { jobId: null, warning: stale };
    } catch (e) {
      console.error("rescore enqueue failed", uid, e);
      return { jobId: null, warning: stale };
    }
  }

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

    // The score is the server's to recompute, and this save may have moved it. Queued
    // after the write, so the job reads the saved row rather than racing it.
    let rescore: { job_id: string } | null = null;
    if (needsRescore(fields)) {
      const { jobId, warning } = await queueRescore(ctx, row, uid);
      if (jobId) rescore = { job_id: jobId };
      if (warning) warnings.push(warning);
    }
    return json({ row, warnings, rescore });
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

  /**
   * POST /pipelines/decision — the Review stage's one action.
   *
   * Body: `{ uid, decision, note? }`. Deliberately NOT the editor's save with a decision
   * attached: deciding is the act the Pipeline is built around, it is the one thing a
   * reviewer does in a meeting, and it carries consequences a field edit does not.
   *
   * `decision_date` is the flag the rest of the app reads as "a human has reviewed this"
   * (views/review_rfp.py:212 — the stored decision is only honoured as a human's when this
   * is stamped), so it is stamped here and nowhere else in this file. UTC, matching the
   * deployment the Python runs in, so a decision taken near midnight lands in the same
   * reporting bucket either way.
   */
  async function decide(req: Request, ctx: Ctx): Promise<Response> {
    const b = await body(req);
    const uid = str(b.uid).trim();
    const decision = str(b.decision).trim();
    if (!uid) return json({ error: "No RFP selected." }, 400);
    if (!(DECISIONS as readonly string[]).includes(decision)) {
      return json({
        error: "That is not a decision this app records.",
        problems: [decision], allowed: DECISIONS,
      }, 400);
    }

    const sb = db.as(ctx.scope);
    const before = await sb.get("rfp_submissions", `select=*&uid=eq.${q(uid)}&limit=1`);
    if (!before.length) return json({ error: "No such opportunity." }, 404);

    const note = str(b.note).trim();
    const saved = await sb.update("rfp_submissions", `uid=eq.${q(uid)}`, {
      decision,
      // An omitted note leaves the old one; an explicitly empty one clears it. A reviewer
      // who changes their verdict and says nothing should not keep the rationale for the
      // verdict they just abandoned, so the client sends "" to clear it deliberately.
      ...(b.note === undefined ? {} : { decision_note: note || null }),
      decision_date: new Date().toISOString().slice(0, 10),
      decision_overridden_by: ctx.session.email,
      decision_overridden_at: nowIso(),
    });
    if (!saved.length) return json({ error: "The decision was not saved." }, 409);
    const row = saved[0];

    // The two consequences that are Python's — see the file header. Non-fatal for the same
    // reason the re-score is: the decision IS saved, and failing the request would tell the
    // reviewer their verdict was lost when only its bookkeeping is behind.
    const warnings: { code: string; detail: string }[] = [];
    let recorded: { job_id: string } | null = null;
    const tenantId = str(row.tenant_id).trim() || db.scopeTid(ctx.scope);
    if (!enqueue || /^0{8}-/.test(tenantId)) {
      warnings.push(NOT_RECORDED);
    } else {
      try {
        const jobId = await enqueue("record_decision",
          { tenant_id: tenantId, uid, decision, by: ctx.session.email }, ctx);
        if (jobId) recorded = { job_id: jobId };
        else warnings.push(NOT_RECORDED);
      } catch (e) {
        console.error("record_decision enqueue failed", uid, e);
        warnings.push(NOT_RECORDED);
      }
    }
    return json({ row, warnings, recorded });
  }

  return { patchRfp, decide };
}

/**
 * Said in full because of what it means. The tombstone is what stops a declined call
 * coming back on the next scan, so a reviewer whose Decline was not recorded needs to know
 * the call may reappear — otherwise they find out when it does.
 */
const NOT_RECORDED = {
  code: "decision_not_recorded",
  detail: "The decision is saved, but recording it for the scan and the learning engine " +
    "could not be queued. A declined opportunity may be found again by the next scan.",
};
