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
const { selectTrackRows, leadsFor, allWeeksForYear, reviewWeekLabel,
        mondayFromWeekLabel, weekMondays } = mod;

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

// ── Condition 2: the stored decision, exactly ────────────────────────────────

test("track takes Proceed and Proceed as sub, and nothing else", () => {
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

test("track matches the decision exactly, not by prefix, unlike Screened", () => {
  // Screened uses startswith("proceed"), which would admit this. Track must not.
  const row = ok({ decision: "Proceeding with caution" });
  assert.deepEqual(selectTrackRows([row], 2026, TODAY), []);
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

test("donor_decision is NOT stripped, matching the Python's asymmetry", () => {
  // tracking_rfp.py lower-cases donor_decision without stripping it, while stripping
  // progress_status. records.drop_concluded strips both. Tidying this would admit a row
  // the Streamlit page excludes, so the asymmetry is kept deliberately.
  assert.deepEqual(selectTrackRows([ok({ donor_decision: " not submitted " })],
                                   2026, TODAY), []);
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
