// The period model's date arithmetic. Boundary errors here are silent — a range that is
// one day short just shows slightly fewer rows, and nobody notices until a month's numbers
// do not add up to the quarter's.
//
//   node --test scripts/period.test.mjs        (from web/)
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const P = await import(pathToFileURL(path.join(here, "../src/pipeline/period.ts")).href);

const at = (grain, anchor) => ({ kind: "grain", grain, anchor });
const range = (grain, anchor) => P.rangeOf(at(grain, anchor));

test("each grain covers exactly its own span, half-open", () => {
  // A Wednesday, deliberately mid-everything.
  assert.deepEqual(range("day", "2026-05-13"), { from: "2026-05-13", to: "2026-05-14" });
  // Weeks start Monday — the team's rhythm starts at the Monday call.
  assert.deepEqual(range("week", "2026-05-13"), { from: "2026-05-11", to: "2026-05-18" });
  assert.deepEqual(range("month", "2026-05-13"), { from: "2026-05-01", to: "2026-06-01" });
  assert.deepEqual(range("quarter", "2026-05-13"), { from: "2026-04-01", to: "2026-07-01" });
  assert.deepEqual(range("half", "2026-05-13"), { from: "2026-01-01", to: "2026-07-01" });
  assert.deepEqual(range("year", "2026-05-13"), { from: "2026-01-01", to: "2027-01-01" });
});

test("a Sunday belongs to the week that started the Monday before it", () => {
  // The off-by-one that getUTCDay() invites: Sunday is 0, so a naive subtraction puts it
  // at the START of the following week and a Sunday's work lands in the wrong week.
  assert.deepEqual(range("week", "2026-05-17"), { from: "2026-05-11", to: "2026-05-18" });
  assert.deepEqual(range("week", "2026-05-18"), { from: "2026-05-18", to: "2026-05-25" });
});

test("the quarter and half boundaries sit where the calendar puts them", () => {
  for (const [d, q] of [["2026-01-01", "2026-01-01"], ["2026-03-31", "2026-01-01"],
    ["2026-04-01", "2026-04-01"], ["2026-12-31", "2026-10-01"]]) {
    assert.equal(range("quarter", d).from, q, `quarter containing ${d}`);
  }
  assert.equal(range("half", "2026-06-30").to, "2026-07-01");
  assert.equal(range("half", "2026-07-01").from, "2026-07-01");
});

test("stepping is reversible and crosses year ends without drifting", () => {
  for (const grain of ["day", "week", "month", "quarter", "half", "year"]) {
    const p = at(grain, "2026-11-20");
    const there = P.shift(p, 1);
    assert.deepEqual(P.rangeOf(P.shift(there, -1)), P.rangeOf(p), `${grain} round-trips`);
  }
  // A month step from the 31st must not skip February by landing on the 31st of it.
  assert.equal(P.rangeOf(P.shift(at("month", "2026-01-31"), 1)).from, "2026-02-01");
  assert.equal(P.rangeOf(P.shift(at("month", "2026-12-15"), 1)).from, "2027-01-01");
  assert.equal(P.rangeOf(P.shift(at("quarter", "2026-11-01"), 1)).from, "2027-01-01");
});

test("consecutive periods meet exactly — no gap, no overlap", () => {
  // This is what half-open buys: the quarter's rows are the sum of its months' rows.
  for (const grain of ["day", "week", "month", "quarter", "half", "year"]) {
    let p = at(grain, "2026-02-10");
    for (let i = 0; i < 6; i++) {
      const next = P.shift(p, 1);
      assert.equal(P.rangeOf(p).to, P.rangeOf(next).from, `${grain} step ${i} is contiguous`);
      p = next;
    }
  }
  // And the months of a quarter tile it exactly.
  const q = P.rangeOf(at("quarter", "2026-08-05"));
  assert.equal(P.rangeOf(at("month", "2026-07-01")).from, q.from);
  assert.equal(P.rangeOf(at("month", "2026-09-20")).to, q.to);
});

test("a period containing today reads as to-date, and the future is not offered", () => {
  const now = P.today();
  const thisYear = at("year", now);
  assert.equal(P.isToDate(thisYear), true);
  assert.match(P.labelOf(thisYear), /to date/);
  assert.equal(P.canGoForward(thisYear), false, "nothing to show after the current period");

  const lastYear = P.shift(thisYear, -1);
  assert.equal(P.isToDate(lastYear), false);
  assert.doesNotMatch(P.labelOf(lastYear), /to date/);
  assert.equal(P.canGoForward(lastYear), true);
});

test("a custom range keeps its length when stepped", () => {
  const p = { kind: "custom", from: "2026-03-02", to: "2026-03-09" };   // 7 days
  assert.deepEqual(P.shift(p, 1), { kind: "custom", from: "2026-03-09", to: "2026-03-16" });
  assert.deepEqual(P.shift(p, -1), { kind: "custom", from: "2026-02-23", to: "2026-03-02" });
  // Labelled inclusively, because "2 Mar – 9 Mar" would read as eight days to a user.
  assert.equal(P.labelOf(p), "2 Mar 2026 – 8 Mar 2026");
});

test("changing grain keeps the moment you were looking at", () => {
  const month = at("month", "2026-05-13");
  assert.deepEqual(P.rangeOf(P.atGrain(month, "year")), { from: "2026-01-01", to: "2027-01-01" });
  assert.deepEqual(P.rangeOf(P.atGrain(month, "day")), { from: "2026-05-13", to: "2026-05-14" });
});
