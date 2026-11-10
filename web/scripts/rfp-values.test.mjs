// The RFP editor's two directions — reading a stored column into the form, and writing it
// back — pinned against each other and against views/rfp_editor.py's own helpers.
//
//   node --test scripts/rfp-values.test.mjs        (from web/)
//
// This is the part of a shared editor that goes quietly wrong. The form saves only what
// CHANGED, worked out by comparing the loaded value with the current one, so if the read
// and the write disagree about a column a field becomes either permanently dirty — saved
// and re-scored on every open, for no edit anyone made — or permanently clean, and never
// saved at all. Neither shows up as an error; both show up months later as data.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const V = await import(pathToFileURL(path.join(here, "../src/opportunity/values.ts")).href);
const { KIND, changedColumns, columnValue, readRow } = V;

test("a column read and written back unchanged produces no edit", async () => {
  // The round trip that matters: open the editor on a real-shaped row, touch nothing,
  // and the save must be empty. Anything that fails here re-queues a rescore job on every
  // open and republishes the same values as if someone had typed them.
  const row = {
    opportunity_title: "Malaria diagnostics call",
    funding_agency: "BMGF - Gates Foundation",
    brief_description: null,
    date_posted: "2026-04-02",
    call_submission_deadline: "2026-06-30T00:00:00+00:00",
    call_award_value: 750000,
    project_duration: 24,
    amount_requested: 0,
    expected_awards: null,
    call_domain_areas: ["Malaria", "Health systems"],
    call_geographic_scope: "Cameroon, Mali",
    contributors: null,
    support_roles: "Technical, Finance",
    decline_flags_present: false,
    qualification: "Yes, fully",
    decision: "Proceed",
    notes: "",
  };
  const loaded = readRow(row);
  assert.deepEqual(changedColumns({ ...loaded }, loaded), []);
});

test("every column the form holds is one the save route accepts", async () => {
  // KIND is the form's column list; EDITABLE is what PATCH /pipelines/rfp/:uid allows, and
  // it REFUSES anything else rather than dropping it. A column here that is not there
  // would make the whole save fail the moment someone edited that field.
  const api = await import(pathToFileURL(
    path.join(here, "../../supabase/functions/_shared/api/pipeline_writes.ts")).href);
  for (const col of Object.keys(KIND)) {
    const { unknown } = api.checkFields({ [col]: null });
    assert.deepEqual(unknown, [], `${col} is not on the route's EDITABLE list`);
  }
});

test("a stored list arrives as a list however it was stored", () => {
  // Postgres arrays, the comma-joined strings older Excel imports left, and pandas
  // stringifying an empty cell as "nan" — views/rfp_editor.py's _team_multi copes with
  // all three, so the form must too or a reviewer sees one value where there are four.
  const f = readRow({
    call_domain_areas: ["Malaria", "TB"],
    call_geographic_scope: "Cameroon; Mali , Kenya",
    contributors: "nan",
    reviewers: '["Ada","Sam"]',
    support_roles: null,
  });
  assert.deepEqual(f.call_domain_areas, ["Malaria", "TB"]);
  assert.deepEqual(f.call_geographic_scope, ["Cameroon", "Mali", "Kenya"]);
  assert.deepEqual(f.contributors, [], "an empty pandas cell is not a contributor named nan");
  assert.deepEqual(f.reviewers, ["Ada", "Sam"]);
  assert.deepEqual(f.support_roles, []);
});

test("support is written back as the string its column holds", () => {
  // The one multi-value column that is text rather than an array. Sending an array would
  // land "{Technical,Finance}" or fail, depending on the column type.
  assert.equal(columnValue("support_roles", ["Technical", "Finance"]), "Technical, Finance");
  assert.equal(columnValue("support_roles", []), null);
  assert.deepEqual(columnValue("contributors", ["Ada"]), ["Ada"], "this one IS an array");
  assert.equal(columnValue("contributors", []), null);
});

test("an emptied field writes null, not an empty string", () => {
  // `_val` in the Python. A column cleared to "" reads as a value that is present and
  // blank, which is a different thing from absent everywhere that counts coverage.
  assert.equal(columnValue("notes", ""), null);
  assert.equal(columnValue("notes", "   "), null);
  assert.equal(columnValue("applicant_role", "—"), null, "the placeholder is not a role");
  assert.equal(columnValue("notes", " keep this "), "keep this");
});

test("money and counts follow the Python, including that 0 is not a number here", () => {
  // `float(x) if x else None`. Worth pinning precisely because it is surprising: typing 0
  // into Amount requested clears it rather than recording zero, and the form and the
  // Streamlit editor must at least agree on that.
  assert.equal(columnValue("amount_requested", "250000"), 250000);
  assert.equal(columnValue("amount_requested", ""), null);
  assert.equal(columnValue("amount_requested", "0"), null);
  assert.equal(columnValue("project_duration", "24.4"), 24, "a count is an integer");
  assert.equal(columnValue("expected_awards", "abc"), null);
});

test("a timestamp deadline edits as the date it names", () => {
  // The column carries both shapes. A date input cannot hold a timestamp, and rendering
  // it blank would let a save wipe a deadline nobody meant to touch.
  const f = readRow({ call_submission_deadline: "2026-06-30T00:00:00+00:00" });
  assert.equal(f.call_submission_deadline, "2026-06-30");
  assert.equal(columnValue("call_submission_deadline", "2026-06-30"), "2026-06-30");
  assert.equal(columnValue("call_submission_deadline", ""), null);
});

test("the decline flag reads every spelling the table holds", () => {
  for (const stored of [true, "true", "Yes", "1"]) {
    assert.equal(readRow({ decline_flags_present: stored }).decline_flags_present, true,
      `${JSON.stringify(stored)} means the flags are present`);
  }
  for (const stored of [false, "false", "No", null, undefined, ""]) {
    assert.equal(readRow({ decline_flags_present: stored }).decline_flags_present, false);
  }
  assert.equal(columnValue("decline_flags_present", false), false,
    "false is a value, not an absence — it must still be written");
});

test("only what moved is reported as changed", () => {
  const loaded = readRow({
    opportunity_title: "A call", call_domain_areas: ["Malaria"], amount_requested: 100,
  });
  const now = { ...loaded, opportunity_title: "A call, revised" };
  assert.deepEqual(changedColumns(now, loaded), ["opportunity_title"]);

  // A multi-select opened and closed again is not an edit, even though the array is new.
  const reselected = { ...loaded, call_domain_areas: ["Malaria"] };
  assert.deepEqual(changedColumns(reselected, loaded), []);

  // Order within a multi IS a change: the stored array keeps the order it was given.
  const reordered = readRow({ call_domain_areas: ["Malaria", "TB"] });
  const swapped = { ...reordered, call_domain_areas: ["TB", "Malaria"] };
  assert.deepEqual(changedColumns(swapped, reordered), ["call_domain_areas"]);
});

// ── The funder's own link ────────────────────────────────────────────────────

test("a placeholder in opportunity_link is not offered as a link", () => {
  // Measured on CHAI Cameroon's Submitted stage: one row of twelve stores the literal
  // string "NA". Every stage rendered `{r.opportunity_link && <a href={...}>}`, and a
  // placeholder is a truthy string — so the arrow icon looked exactly like the eleven
  // real ones and navigated to the relative path /NA, a dead end claiming to be the call.
  for (const junk of ["NA", "n/a", "N/A", "none", "None", "TBD", "-", "—", "", "   ",
                      "to be confirmed", null, undefined]) {
    assert.equal(V.callHref(junk), null, `${JSON.stringify(junk)} is not a link`);
  }
});

test("a real link survives, and a bare host is given its scheme", () => {
  assert.equal(V.callHref("https://www.cgdev.org/sites/x.pdf"), "https://www.cgdev.org/sites/x.pdf");
  assert.equal(V.callHref("  http://example.org/call  "), "http://example.org/call");
  assert.equal(V.callHref("grants.gov/search-results-detail/363649"),
    "https://grants.gov/search-results-detail/363649");
  assert.equal(V.callHref("example.org"), "https://example.org");
});
