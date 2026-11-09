/**
 * The Pipeline route filters, tested as pure functions.
 *
 * The HTTP around them is covered by api-flows.test.mjs. What matters here is the
 * filtering, because two of these rules look like inconsistencies and would be
 * "tidied" by anyone who met them without the Python open.
 *
 * Run: node --test scripts/pipelines.test.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mod = await import(pathToFileURL(
  path.join(root, "supabase/functions/_shared/api/routes_pipelines.ts")).href);
const { selectTrackRows, selectSubmittedRows, leadsFor, allWeeksForYear, reviewWeekLabel,
        previousReviewWeekLabel, mondayFromWeekLabel, weekMondays } = mod;

const TODAY = "2026-10-27";

/** A row that passes all six conditions, so each test can break exactly one. */
const ok = (over = {}) => ({
  uid: "R1",
  decision: "Proceed",
  submitted_at: "2026-03-04T09:00:00+00:00",
  donor_decision: "",
  progress_status: "In progress",
  call_submission_deadline: "2026-12-01",
  proposal_lead: "Ada Lovelace",
  ...over,
});

const uids = (rows) => rows.map((r) => r.uid);

// ── Condition 2: the stored decision ─────────────────────────────────────────

test("track takes any Proceed, and nothing else", () => {
  const rows = [ok({ uid: "A", decision: "Proceed" }),
                ok({ uid: "B", decision: "Proceed as sub" }),
                ok({ uid: "C", decision: "Park" }),
                ok({ uid: "D", decision: "Decline" })];
  assert.deepEqual(uids(selectTrackRows(rows, 2026, TODAY)), ["A", "B"]);
});

test("track does NOT fall back to auto_recommendation, unlike Screened", () => {
  // The trap. A freshly scanned row the engine rates Proceed belongs on Screened and
  // must not reach Track until a person has decided. Harmonising the two would fill
  // Track with work nobody committed to.
  const row = ok({ decision: "", auto_recommendation: "Proceed" });
  assert.deepEqual(selectTrackRows([row], 2026, TODAY), []);
});

test("track matches the decision by prefix, as the Python does", () => {
  // This test used to assert the opposite — exact match against {Proceed, Proceed as
  // sub}, on the reasoning that prefix matching was Screened's alone. It is not.
  // core/pipeline.py::is_active_proceed tests `.startswith("proceed")`, and
  // tracking_rfp._fetch narrows with `.ilike("decision", "Proceed%")` before that, so the
  // Streamlit page shows every one of these. Verified by running the real function:
  // 'Proceeding with caution' and 'Proceed (as co-applicant)' both come back True.
  //
  // The real difference between the two pages is WHICH COLUMN the prefix is applied to —
  // Screened falls back to auto_recommendation, this reads the stored decision only —
  // and the test below is the one that guards it.
  //
  // No live row turns on this (40 decisions start with "Proceed", and 40 are exactly one
  // of the two), so it is the failure direction that decides: matching narrowly loses a
  // bid that the Streamlit page still shows, and work vanishing silently is the fault
  // this whole stage line exists to stop. Matching widely shows an odd decision string to
  // somebody who can fix it.
  for (const d of ["Proceeding with caution", "Proceed (as co-applicant)", "proceed"]) {
    assert.equal(selectTrackRows([ok({ decision: d })], 2026, TODAY).length, 1, d);
  }
});

// ── Condition 3: the year of submitted_at ────────────────────────────────────

test("track is scoped to the requested year", () => {
  const rows = [ok({ uid: "A", submitted_at: "2026-01-01T00:00:00+00:00" }),
                ok({ uid: "B", submitted_at: "2025-12-31T23:59:00+00:00" })];
  assert.deepEqual(uids(selectTrackRows(rows, 2026, TODAY)), ["A"]);
});

test("a row with no submitted_at is excluded rather than defaulted", () => {
  assert.deepEqual(selectTrackRows([ok({ submitted_at: null })], 2026, TODAY), []);
});

test("the year is read off the text, so an offset does not move a row between years", () => {
  // 2026-01-01T00:30+02:00 is 2025 in UTC. The Python reads the year as written, so
  // parsing to an instant here would silently drop the row from its own year.
  const row = ok({ submitted_at: "2026-01-01T00:30:00+02:00" });
  assert.equal(selectTrackRows([row], 2026, TODAY).length, 1);
});

// ── Condition 4: the donor decision ──────────────────────────────────────────

test("only a blank or Not submitted donor decision stays active", () => {
  const rows = [ok({ uid: "A", donor_decision: "" }),
                ok({ uid: "B", donor_decision: "Not submitted" }),
                ok({ uid: "C", donor_decision: "NOT SUBMITTED" }),
                ok({ uid: "D", donor_decision: "Approved" }),
                ok({ uid: "E", donor_decision: null })];
  assert.deepEqual(uids(selectTrackRows(rows, 2026, TODAY)), ["A", "B", "C", "E"]);
});

test("donor_decision IS stripped, like every other column the rule reads", () => {
  // This test used to assert the opposite — an "asymmetry" where tracking_rfp.py
  // lower-cased donor_decision without stripping it. There is no such asymmetry.
  // `_fetch` does none of this comparing itself; it hands each row to
  // core/pipeline.py::is_active_proceed, which reads every column through `_txt`
  // (strip, lower, and the Excel "nan" treated as blank). Checked by running the real
  // function on this exact row: is_active_proceed(...) is True, so the Streamlit page
  // keeps it, and the old rule here dropped a bid the Python still shows.
  assert.equal(selectTrackRows([ok({ donor_decision: " not submitted " })],
                               2026, TODAY).length, 1);
  // The same treatment of the import's empty cell, for the same reason.
  assert.equal(selectTrackRows([ok({ donor_decision: "nan" })], 2026, TODAY).length, 1);
});

test("a recorded submission date takes a bid off the board", () => {
  // The third branch of is_submitted, and the one this port was missing. A person who
  // writes down the day a proposal went in has said it went in, whatever `progress_status`
  // still says — core/pipeline.py::is_active_proceed is False for this row.
  assert.deepEqual(selectTrackRows([ok({ date_completed: "2026-05-01" })], 2026, TODAY), []);
  // And it is the same rule that puts the row on the next stage, so it does not vanish.
  assert.equal(selectSubmittedRows([ok({ date_completed: "2026-05-01" })]).length, 1);
});


// ── Condition 5: progress status overrides the decision ──────────────────────

test("Completed and Discontinued drop out even though the decision is Proceed", () => {
  const rows = [ok({ uid: "A", progress_status: "Completed" }),
                ok({ uid: "B", progress_status: "Discontinued" }),
                ok({ uid: "C", progress_status: "  completed  " }),
                ok({ uid: "D", progress_status: "In progress" })];
  assert.deepEqual(uids(selectTrackRows(rows, 2026, TODAY)), ["D"]);
});

// ── Condition 6: the deadline ────────────────────────────────────────────────

test("a passed deadline drops out, today's does not, and a missing one stays", () => {
  const rows = [ok({ uid: "A", call_submission_deadline: "2026-10-26" }),
                ok({ uid: "B", call_submission_deadline: TODAY }),
                ok({ uid: "C", call_submission_deadline: "2026-10-28" }),
                ok({ uid: "D", call_submission_deadline: null })];
  assert.deepEqual(uids(selectTrackRows(rows, 2026, TODAY)), ["B", "C", "D"]);
});

test("a timestamp deadline compares by its date, not its text length", () => {
  const row = ok({ call_submission_deadline: "2026-10-28T23:00:00+00:00" });
  assert.equal(selectTrackRows([row], 2026, TODAY).length, 1);
});

// ── Leads across the duplicate group ─────────────────────────────────────────

test("a duplicate's lead reaches the canonical row", () => {
  const rows = [ok({ uid: "A", proposal_lead: "Ada" })];
  const dups = [{ duplicate_of_uid: "A", proposal_lead: "Grace" }];
  assert.deepEqual(leadsFor(rows, dups), [{ uid: "A", proposalLeads: ["Ada", "Grace"] }]);
});

test("leads are deduplicated, trimmed and sorted", () => {
  const rows = [ok({ uid: "A", proposal_lead: "  Ada  " })];
  const dups = [{ duplicate_of_uid: "A", proposal_lead: "Ada" },
                { duplicate_of_uid: "A", proposal_lead: "Grace" }];
  assert.deepEqual(leadsFor(rows, dups)[0].proposalLeads, ["Ada", "Grace"]);
});

test("blank and missing leads are dropped rather than becoming empty entries", () => {
  const rows = [ok({ uid: "A", proposal_lead: null })];
  const dups = [{ duplicate_of_uid: "A", proposal_lead: "   " },
                { duplicate_of_uid: "A", proposal_lead: null },
                { duplicate_of_uid: "B", proposal_lead: "Elsewhere" }];
  assert.deepEqual(leadsFor(rows, dups), [{ uid: "A", proposalLeads: [] }]);
});

// ── The week labels ──────────────────────────────────────────────────────────

test("a week label matches review_week_label's format", () => {
  // "Week N (D Mon - D Mon)", with the leading zero stripped from the day.
  assert.equal(reviewWeekLabel(new Date("2026-06-03T12:00:00Z")),
               "Week 23 (1 Jun - 7 Jun)");
});

test("a year has 52 or 53 weeks and no duplicates", () => {
  for (const y of [2024, 2025, 2026, 2027]) {
    const w = allWeeksForYear(y);
    assert.ok(w.length === 52 || w.length === 53, `${y} produced ${w.length}`);
    assert.equal(new Set(w).size, w.length, `${y} has duplicate labels`);
    assert.match(w[0], /^Week 1 \(/);
  }
});

// ── Label to Monday, the mapping the browser must not own ────────────────────

test("a label resolves to the Monday its text names", () => {
  assert.equal(mondayFromWeekLabel("Week 23 (1 Jun - 7 Jun)", 2026), "2026-06-01");
});

test("every Monday is a Monday, and matches the label it came from", () => {
  for (const y of [2024, 2025, 2026, 2027]) {
    for (const { label, monday } of weekMondays(y)) {
      const d = new Date(`${monday}T00:00:00Z`);
      assert.equal(d.getUTCDay(), 1, `${label} -> ${monday} is not a Monday`);
      // The label was built from this Monday, so it must round-trip.
      assert.equal(reviewWeekLabel(d), label);
    }
  }
});

test("consecutive weeks are exactly seven days apart, with no gap at a year end", () => {
  const w = weekMondays(2026);
  for (let i = 1; i < w.length; i++) {
    const gap = (Date.parse(w[i].monday) - Date.parse(w[i - 1].monday)) / 86400_000;
    assert.equal(gap, 7, `${w[i - 1].label} to ${w[i].label}`);
  }
});

test("a malformed label resolves to null rather than a wrong date", () => {
  for (const bad of ["", "Week", "Weekly (1 Jun - 7 Jun)", "Week x (1 Jun)"]) {
    assert.equal(mondayFromWeekLabel(bad, 2026), null, bad);
  }
});

// ── Track over an explicit range ─────────────────────────────────────────────

test("a range replaces the year test and keeps the other five conditions", () => {
  const rows = [ok({ uid: "A", submitted_at: "2026-03-04T09:00:00+00:00" }),
                ok({ uid: "B", submitted_at: "2026-05-04T09:00:00+00:00" }),
                // In range, but Completed: condition 5 still applies.
                ok({ uid: "C", submitted_at: "2026-03-10T09:00:00+00:00",
                     progress_status: "Completed" })];
  const got = selectTrackRows(rows, null, TODAY,
                              { from: "2026-03-01", to: "2026-04-01" });
  assert.deepEqual(uids(got), ["A"]);
});

test("the track range is half-open, so months tile without overlap", () => {
  const rows = [ok({ uid: "A", submitted_at: "2026-03-31T23:00:00+00:00" }),
                ok({ uid: "B", submitted_at: "2026-04-01T00:00:00+00:00" })];
  const march = selectTrackRows(rows, null, TODAY,
                                { from: "2026-03-01", to: "2026-04-01" });
  const april = selectTrackRows(rows, null, TODAY,
                                { from: "2026-04-01", to: "2026-05-01" });
  assert.deepEqual(uids(march), ["A"]);
  assert.deepEqual(uids(april), ["B"]);
});

// â”€â”€ The week a review screen opens on â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test("the default week is the one just gone, not the one we are in", () => {
  // core/review_week.py::previous_review_week_label. The team reviews a week on the
  // Monday after it ends, when the current week is one day old: measured on the live
  // table on Monday 2026-11-09, the current week held 0 rows and the previous one 2.
  // Opening on `current` opens on nothing.
  const mon = new Date(Date.UTC(2026, 10, 9));          // Monday 9 Nov 2026
  assert.equal(reviewWeekLabel(mon), "Week 46 (9 Nov - 15 Nov)");
  assert.equal(previousReviewWeekLabel(mon), "Week 45 (2 Nov - 8 Nov)");

  // Every day of a week resolves to the same previous week â€” the default must not drift
  // as the week goes on, or two people opening the page on different days compare
  // different periods without noticing.
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon.getTime() + i * 86400_000);
    assert.equal(previousReviewWeekLabel(d), "Week 45 (2 Nov - 8 Nov)", d.toISOString());
  }
});

test("the default week is always one real week back, across a year boundary", () => {
  // The case that would go unnoticed: in the first days of January the previous week
  // belongs to the OLD year, so it is absent from this year's label list and the selector
  // would be asked to show a value it has no option for.
  const jan1 = new Date(Date.UTC(2026, 0, 1));          // Thursday
  assert.equal(previousReviewWeekLabel(jan1), "Week 52 (22 Dec - 28 Dec)");
  assert.ok(!allWeeksForYear(2026).includes(previousReviewWeekLabel(jan1)),
    "and it is NOT in 2026's list, which is why the route prepends it");

  // Always exactly seven days earlier than the current label's Monday, every week of a
  // 53-week year included.
  for (let i = 0; i < 400; i++) {
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86400_000);
    const prevMonday = mondayFromWeekLabel(previousReviewWeekLabel(d), d.getUTCFullYear());
    const curMonday = mondayFromWeekLabel(reviewWeekLabel(d), d.getUTCFullYear());
    if (!prevMonday || !curMonday) continue;            // label from a neighbouring year
    assert.equal(
      (Date.parse(curMonday) - Date.parse(prevMonday)) / 86400_000, 7,
      `${d.toISOString().slice(0, 10)}: ${previousReviewWeekLabel(d)} -> ${reviewWeekLabel(d)}`);
  }
});

