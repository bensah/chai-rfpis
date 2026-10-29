// The Pipeline's write rules, driven directly rather than through HTTP and a session.
//
//   node --test scripts/pipeline-writes.test.mjs        (from web/)
//
// These are the rules that lose data quietly when they are wrong: a mistyped column that
// saves nothing, an empty grant row created on every save, and a completed row with no
// funder decision that nobody is told about.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("the score columns are writable, though the server now owns the answer", () => {
  // rfp_editor.py writes them, so refusing them here would break the save. What they are
  // NOT any more is the last word: a save that touches them queues a re-score, and the
  // job's number replaces whatever arrived. See the rescore tests below.
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

// ── Which saves have to re-score ─────────────────────────────────────────────
// The expensive mistake here is NOT queueing when the score moved: the row then shows a
// number computed from the opportunity as it used to be, with nothing on screen to say so.
// Queueing when it did not move costs one redundant Actions run.

test("editing what the call says re-scores", () => {
  for (const f of [
    { brief_description: "new text" },      // _full_text, and criteria_derive's notes blob
    { opportunity_title: "new title" },     // _full_text
    { funding_agency: "Wellcome" },         // _full_text, and the donor match
    { call_submission_deadline: "2027-01-01" },
    { call_award_ceiling: 500000 },
    { call_geographic_scope: ["Kenya"] },
    { notes: "a note" },                    // criteria_derive reads notes twice
    { strategic_fit: "Strongly aligns" },
  ]) {
    assert.equal(W.needsRescore(f), true, `${Object.keys(f)[0]} should re-score`);
  }
});

test("recording what the team is doing about a bid does not re-score", () => {
  assert.equal(W.needsRescore({ assigned_to: "Ama", next_action: "Draft budget" }), false);
  assert.equal(W.needsRescore({ amount_secured: 120000, date_of_approval: "2026-11-02" }), false);
  assert.equal(W.needsRescore({}), false, "a reporting-only save changes no column here");
});

test("one scoring field among workflow fields is enough", () => {
  // The whole save is one write, so the question is whether ANY of it could move the score.
  assert.equal(W.needsRescore({ assigned_to: "Ama", brief_description: "new" }), true);
});

test("marking a bid submitted re-scores — it is not workflow state", () => {
  // The trap this guards: all three read like project tracking, and criteria_derive's
  // _is_completed reads all three to decide the deadline runway is moot. Score moves.
  assert.equal(W.needsRescore({ progress_status: "Completed" }), true);
  assert.equal(W.needsRescore({ donor_decision: "Under Review" }), true);
  assert.equal(W.needsRescore({ date_completed: "2026-10-02" }), true);
});

test("a client's own score is replaced rather than trusted", () => {
  // The migration finishing: a page still computing in Pyodide may send a number, and the
  // queued job overwrites it with the server's. Not a conflict — one owner, arriving late.
  assert.equal(W.needsRescore({ alignment_score: 91, auto_recommendation: "Proceed" }), true);
});

test("no workflow-only column is a scoring input", () => {
  // Re-derives the claim the denylist makes, from the Python itself, so the day somebody
  // feeds `remarks` to the scorer this fails instead of the score quietly going stale.
  // Matches a READ of the row (.get("col") or ["col"]), not a dict key the scorer returns
  // — matching.py builds an output called "decision", which is not a read of the column.
  const sources = [
    "core/criteria_derive.py", "core/auto_scorer.py", "core/matching.py",
    "core/scorer.py", "core/assessment.py",
  ].map((p) => [p, readFileSync(path.join(root, p), "utf8")]);

  for (const col of W.workflowOnlyColumns()) {
    const read = new RegExp(String.raw`(\.get\(|\[)\s*["']${col}["']`);
    for (const [file, src] of sources) {
      assert.equal(read.test(src), false,
        `${file} reads "${col}", so a save touching it changes the score — ` +
        "take it out of WORKFLOW_ONLY in pipeline_writes.ts");
    }
  }
});

// ── The decision vocabulary ──────────────────────────────────────────────────

test("the decision vocabulary matches config/dropdowns.yaml", () => {
  // The API copies the list because it also runs as a Deno Edge Function with no
  // filesystem to read the YAML from. This is what keeps the copy honest: `decision`
  // decides who appears in Track and whether the scan tombstones the row, so a value the
  // app offers but the API refuses would be a save that fails for no visible reason.
  const yaml = readFileSync(path.join(root, "config/dropdowns.yaml"), "utf8");
  const inline = yaml.match(/^decisions:\s*\[([^\]]*)\]/m);
  const block = yaml.match(/^decisions:\s*\n((?:\s*-\s*.+\n)+)/m);
  assert.ok(inline || block, "config/dropdowns.yaml no longer declares `decisions`");
  const want = inline
    ? inline[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
    : block[1].split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()
      .replace(/^["']|["']$/g, "")).filter(Boolean);
  assert.deepEqual([...W.DECISIONS], want);
});

test("an existing grant is updated even when the tab is emptied", () => {
  // Clearing the reporting fields on a linked grant is a real edit, so it must write —
  // unlike the no-grant case, where the same emptiness means "do not create one".
  const a = W.reportingAction({ status: "", owner: "" }, "G-RFP-1");
  assert.equal(a.kind, "update");
  assert.equal(a.payload.status, "");
});
