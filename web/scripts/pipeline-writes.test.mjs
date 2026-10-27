// The Pipeline's write rules, driven directly rather than through HTTP and a session.
//
//   node --test scripts/pipeline-writes.test.mjs        (from web/)
//
// These are the rules that lose data quietly when they are wrong: a mistyped column that
// saves nothing, an empty grant row created on every save, and a completed row with no
// funder decision that nobody is told about.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const W = await import(pathToFileURL(
  path.join(root, "supabase/functions/_shared/api/pipeline_writes.ts")).href);

// ── core/donor_decision.py ───────────────────────────────────────────────────

test("the default counts as no answer; Under Review does not", () => {
  // The subtlety that file names: "Not submitted" is the default every row carries, not a
  // judgement anybody made. "Under Review" somebody put there deliberately.
  for (const v of ["", null, undefined, "Not submitted", "NOT SUBMITTED", " none ", "nan", "null"]) {
    assert.equal(W.isNoAnswer(v), true, `${JSON.stringify(v)} should read as no answer`);
  }
  assert.equal(W.isNoAnswer("Under Review"), false);
  assert.equal(W.isNoAnswer("Approved"), false);
});

test("Under Review is not an outcome either — it records that we are waiting", () => {
  assert.equal(W.isOutcome("Under Review"), false);
  assert.equal(W.isOutcome("Approved"), true);
  assert.equal(W.isOutcome("not approved"), true);
  assert.equal(W.isOutcome(""), false);
  // Which is why a row carrying it belongs in Applied Funding but not a win/loss count.
  assert.equal(W.isNoAnswer("Under Review"), false);
});

// ── Which columns the editor may write ───────────────────────────────────────

test("a mistyped column is named back, not dropped", () => {
  const { unknown, stamped } = W.checkFields({ opportunity_title: "ok", oportunity_title: "typo" });
  assert.deepEqual(unknown, ["oportunity_title"]);
  assert.deepEqual(stamped, []);
});

test("the nine criteria are writable — the editor spreads them in with **vals", () => {
  const criteria = ["qualification", "strategic_fit", "capacity", "geographic_fit",
    "cofinancing", "funding_quality", "funder_relationship", "competitiveness", "bid_effort"];
  const fields = Object.fromEntries(criteria.map((c) => [c, "Yes"]));
  assert.deepEqual(W.checkFields(fields).unknown, []);
});

test("the score columns are writable, because the browser computes them", () => {
  // Scoring stays in one implementation: core/scorer.py, run in the browser through
  // Pyodide. The API stores what it is given rather than keeping a second scorer.
  assert.deepEqual(W.checkFields({ alignment_score: 82, auto_recommendation: "Park" }).unknown, []);
});

test("the server's own stamps are refused, and said to be stamps", () => {
  const { unknown, stamped } = W.checkFields({ decision_overridden_by: "someone@else.org" });
  assert.deepEqual(unknown, ["decision_overridden_by"]);
  assert.deepEqual(stamped, ["decision_overridden_by"]);
});

test("a column from another table is not writable here", () => {
  // report_due_date lives on applied_funding and arrives under `reporting`, not `fields`.
  assert.deepEqual(W.checkFields({ report_due_date: "2026-01-01" }).unknown, ["report_due_date"]);
  assert.deepEqual(W.checkFields({ uid: "RFP-9" }).unknown, ["uid"]);
  assert.deepEqual(W.checkFields({ tenant_id: "other" }).unknown, ["tenant_id"]);
});

// ── The warning that must not be lost ────────────────────────────────────────

test("completed with no funder decision is reported", () => {
  assert.equal(W.completedWithoutDonorDecision(
    { progress_status: "Completed", donor_decision: null }), true);
  assert.equal(W.completedWithoutDonorDecision(
    { progress_status: "completed", donor_decision: "Not submitted" }), true,
    "the default is not an answer");
});

test("nothing to warn about once somebody has recorded a funder response", () => {
  assert.equal(W.completedWithoutDonorDecision(
    { progress_status: "Completed", donor_decision: "Under Review" }), false,
    "Under Review is deliberate, so the gap is closed");
  assert.equal(W.completedWithoutDonorDecision(
    { progress_status: "Completed", donor_decision: "Approved" }), false);
  assert.equal(W.completedWithoutDonorDecision(
    { progress_status: "In progress", donor_decision: null }), false,
    "not completed, so Applied Funding is not expecting it yet");
});

// ── applied_funding: conditional, not an upsert ──────────────────────────────

test("a tab that was never shown leaves the grant row alone", () => {
  // The Reporting tab is reachable from Funding, not from the editor, so an ordinary save
  // omits `reporting` entirely and must not touch applied_funding.
  assert.deepEqual(W.reportingAction(undefined, null), { kind: "none" });
  assert.deepEqual(W.reportingAction(undefined, "G-RFP-1"), { kind: "none" });
});

test("an empty reporting tab never creates a grant row", () => {
  assert.deepEqual(W.reportingAction({}, null), { kind: "none" });
  assert.deepEqual(W.reportingAction({ status: "", owner: "   " }, null), { kind: "none" },
    "blank strings are not values");
  assert.deepEqual(W.reportingAction({ status: null, report_type: null }, null), { kind: "none" });
});

test("the first real value creates the grant; afterwards it is updated", () => {
  const made = W.reportingAction({ status: "Reporting due", owner: "Ama" }, null);
  assert.equal(made.kind, "insert");
  assert.equal(made.payload.status, "Reporting due");
  assert.equal(made.payload.owner, "Ama");
  // Every reporting column is present, so clearing one writes null rather than leaving
  // the previous value behind.
  assert.deepEqual(Object.keys(made.payload).sort(),
    ["owner", "remarks", "report_due_date", "report_type", "status"]);

  const again = W.reportingAction({ status: "Submitted" }, "G-RFP-1");
  assert.equal(again.kind, "update");
  assert.equal(again.fundingId, "G-RFP-1");
  assert.equal(again.payload.status, "Submitted");
  assert.equal(again.payload.owner, null, "a field left out is cleared, not kept");
});

test("an existing grant is updated even when the tab is emptied", () => {
  // Clearing the reporting fields on a linked grant is a real edit, so it must write —
  // unlike the no-grant case, where the same emptiness means "do not create one".
  const a = W.reportingAction({ status: "", owner: "" }, "G-RFP-1");
  assert.equal(a.kind, "update");
  assert.equal(a.payload.status, "");
});
