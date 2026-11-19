// Parity check for Report Section 4 as displayed — Reviews & Decisions (id 3).
//
//   node scripts/parity/check-section4.mjs    (from web/; reads the live database, read-only)
//
// Five blocks, five different populations. Agreement on live data is checked first, over
// every period crossed with every view, because `overTime` is the only block the view
// reaches and its reindex both FILLS and DROPS buckets.
//
// Then the part live data cannot test. The rules that distinguish this section from the
// rest of the report are rules about EDGE VALUES — a blank auto-recommendation, a decision
// dated before the call was found, a `decision_overridden_by` written as an empty string,
// a donor_decision of "Submitted" — and a tenant with clean data exercises none of them. So
// a synthetic frame goes through both halves, one row per rule. If the live half is the
// only check, the port can get every one of those backwards and still pass.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireEnv } from "./_env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const D = await mod("supabase/functions/_shared/api/db.ts");
const P = await mod("supabase/functions/_shared/api/report_period.ts");
const S1 = await mod("supabase/functions/_shared/api/report_section1.ts");
const S3 = await mod("supabase/functions/_shared/api/report_section3.ts");
const S = await mod("supabase/functions/_shared/api/report_section4.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");
const py = (payload) => {
  try {
    return JSON.parse(execFileSync(python, [path.join(here, "section4_py.py")], {
      input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 1 << 28,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (e) {
    console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
    process.exit(2);
  }
};

let diffs = 0, checks = 0;
const J = (v) => JSON.stringify(v);
// Only `avgDays` and `medianDays` are floats, and they are a mean of integers — so a
// relative epsilon is ample and an absolute one would be fine too.
const near = (a, b) => typeof a === "number" && typeof b === "number"
  && Number.isFinite(a) && Number.isFinite(b)
  && (Math.abs(a - b) <= 1e-9 || Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b)));
function equal(a, b) {
  if (near(a, b)) return true;
  if (J(a) === J(b)) return true;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.every((v, i) => equal(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => equal(a[k], b[k]));
  }
  return false;
}
const same = (label, ts, pyv) => {
  checks++;
  if (equal(ts, pyv)) return;
  diffs++;
  console.log(`DIFF ${label}\n   ts: ${J(ts)}\n   py: ${J(pyv)}`);
};
const ok = (label, cond, detail) => {
  checks++;
  if (cond) return;
  diffs++;
  console.log(`DIFF ${label}${detail ? `\n   ${detail}` : ""}`);
};

/** The TS blocks, reshaped to what the Python half returns. */
const shape = (b) => ({
  kpis: b.kpis,
  distribution: b.distribution,
  overTime: b.overTime,
  autoRec: b.autoRec,
  donor: { all: b.donor.all, pending: b.donor.pending },
});

const env = requireEnv(root, "check-section4");
const db = D.createDb({
  supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY,
  jwtSecret: env.SUPABASE_JWT_SECRET ?? "",
});
const rfps = await db.service.getAll("rfp_submissions", `select=${S1.RFP_COLUMNS}`, "uid");
console.log(`${rfps.length} submissions`);

const today = new Date().toISOString().slice(0, 10);
const selFor = (period, view) =>
  P.resolveSelection({ period, year: 2026, month: "June", view }, today, 2026);

// ── 1. Live data, every period crossed with every view ──────────────────────
{
  const cases = [];
  for (const period of P.PERIOD_OPTS) {
    for (const view of P.VIEW_OPTS) {
      const sel = selFor(period, view);
      cases.push({ period, view, bounds: P.periodBounds(sel, today) });
    }
  }
  const wants = py({ rfps, cases: cases.map((c) => ({ bounds: c.bounds, view: c.view })) });
  for (const [i, c] of cases.entries()) {
    const ts = shape(S.buildSection4({ rfps, view: c.view, bounds: c.bounds }));
    const w = wants[i];
    const tag = `${c.period} / ${c.view}`;
    // The view reaches overTime alone, so the other four are compared once per period
    // rather than five times — but comparing them anyway costs nothing and would catch a
    // port that accidentally let the view leak into them.
    same(`kpis ${tag}`, ts.kpis, w.kpis);
    same(`distribution ${tag}`, ts.distribution, w.distribution);
    same(`overTime ${tag}`, ts.overTime, w.overTime);
    same(`autoRec ${tag}`, ts.autoRec, w.autoRec);
    same(`donor ${tag}`, ts.donor, w.donor);
  }
  console.log(`${cases.length} period × view combinations checked on live data`);
}

// ── 2. The edge rules, on rows built to carry exactly one each ──────────────
// Each row names the rule it exists for. If a row is ever deleted, the rule it covers is
// no longer tested by anything — live data does not reach these values.
{
  const row = (uid, o) => ({
    uid, is_duplicate: false,
    decision: null, auto_recommendation: null, donor_decision: null,
    decision_overridden_by: null, decision_date: null,
    search_date: null, submitted_at: null, ...o,
  });
  const synthetic = [
    // Two blanks must NOT count as agreement: a row the scorer never saw and the team
    // never decided is not evidence the scorer was right.
    row("blank-vs-blank", {}),
    // First-token comparison: a qualified decision agrees with the bare recommendation.
    row("qualified-agrees", { auto_recommendation: "proceed", decision: "Proceed with caution" }),
    // ...and a differing first token does not, however similar the rest.
    row("qualified-differs", { auto_recommendation: "park for now", decision: "Proceed for now" }),
    // autoRec matches all three outcomes with startswith; the distribution matches Park and
    // Decline exactly. This row is a Decline in one block and a No decision in the other.
    row("decline-qualified", { decision: "Decline - out of scope", auto_recommendation: "decline" }),
    // A decision dated BEFORE the call was found. Section 1's cycle drops negative spans;
    // this section keeps them, so the mean must move downward.
    row("negative-span", { search_date: "2026-03-10T00:00:00+00:00", decision_date: "2026-03-01" }),
    row("positive-span", { search_date: "2026-03-01T00:00:00+00:00", decision_date: "2026-03-21" }),
    // `.notna()`, so an empty string is a value: this row IS overridden.
    row("override-blank-string", { decision_overridden_by: "", decision_date: "2026-03-05" }),
    row("override-null", { decision_overridden_by: null, decision_date: "2026-03-05" }),
    // "Submitted" is OUR state, not the funder's answer — it is pending, not a bar.
    row("donor-submitted", { decision: "Proceed", donor_decision: "Submitted" }),
    row("donor-in-review", { decision: "Proceed", donor_decision: "  In Review " }),
    row("donor-not-approved", { decision: "Proceed", donor_decision: "not approved" }),
    // The donor block strips the decision and the distribution does not: this row is a
    // Proceed there and a No decision here.
    row("leading-space-proceed", { decision: " proceed", donor_decision: "Approved" }),
    // A duplicate is excluded from every block in this section.
    row("duplicate", { is_duplicate: true, decision: "Proceed", donor_decision: "Approved" }),
  ];

  const cases = [];
  for (const period of ["All time", "This year"]) {
    for (const view of ["Monthly", "Weekly"]) {
      cases.push({ period, view, bounds: P.periodBounds(selFor(period, view), today) });
    }
  }
  const wants = py({ rfps: synthetic, cases: cases.map((c) => ({ bounds: c.bounds, view: c.view })) });
  for (const [i, c] of cases.entries()) {
    const ts = shape(S.buildSection4({ rfps: synthetic, view: c.view, bounds: c.bounds }));
    same(`synthetic ${c.period} / ${c.view}`, ts, wants[i]);
  }

  // And the rules themselves, stated as claims rather than left to agreement — because
  // both halves are written by the same hand and could be wrong together.
  const all = S.buildSection4({
    rfps: synthetic, view: "Monthly",
    bounds: P.periodBounds(selFor("All time", "Monthly"), today),
  });
  const dist = Object.fromEntries(all.distribution.map((d) => [d.decision, d.count]));
  const rec = Object.fromEntries(all.autoRec.rows.map((r) => [r.decision, r]));

  ok("two blanks do not agree", all.autoRec.agreed === 2,
    `agreed=${all.autoRec.agreed}, expected 2 (qualified-agrees and decline-qualified only)`);
  ok("startswith in autoRec, exact in the distribution",
    rec.Decline.team === 1 && dist.Decline === 0,
    `autoRec Decline team=${rec.Decline.team} (want 1), distribution Decline=${dist.Decline} (want 0)`);
  ok("a blank-string override counts as overridden", all.kpis.overridden === 1,
    `overridden=${all.kpis.overridden}, expected 1`);
  // Only two rows carry BOTH dates, and one of them is dated backwards. A port that
  // dropped negative spans the way Section 1's cycle does would report 20, not 5.5.
  ok("negative spans are kept", all.kpis.dated === 2 && all.kpis.avgDays === 5.5,
    `dated=${all.kpis.dated} avgDays=${all.kpis.avgDays}, expected 2 and 5.5 ((-9 + 20) / 2)`);
  ok('"Submitted" is pending, not a donor decision',
    all.donor.pending === 4 && !("Submitted" in all.donor.all),
    `pending=${all.donor.pending} (want 4: the two blank Proceed rows, donor-submitted and `
    + `donor-in-review), bars=${J(all.donor.all)}`);
  ok("the donor block strips the decision and the distribution does not",
    all.donor.all.Approved === 1 && dist["No decision"] >= 1,
    `donor Approved=${all.donor.all.Approved} (want 1, from leading-space-proceed), `
    + `distribution No decision=${dist["No decision"]}`);
  ok("duplicates are excluded everywhere",
    all.distribution.reduce((a, d) => a + d.count, 0) === synthetic.length - 1,
    `distribution sums to ${all.distribution.reduce((a, d) => a + d.count, 0)}, `
    + `expected ${synthetic.length - 1}`);
  console.log(`${synthetic.length} synthetic rows, one per edge rule, agreed on `
    + `${cases.length} period × view combinations`);
}

// ── 3. The cross-section claim ──────────────────────────────────────────────
// Section 4's distribution and Section 3's count funnel are the SAME RULE written twice.
// The port keeps them separate so neither section depends on the other's loader; this is
// what stops them drifting apart in silence.
{
  for (const period of ["All time", "This year", "Specific month"]) {
    const bounds = P.periodBounds(selFor(period, "Monthly"), today);
    const s4 = S.buildSection4({ rfps, view: "Monthly", bounds });
    const s3 = S3.buildSection3({ rfps, bounds, rates: {}, table: [] });
    const d = Object.fromEntries(s4.distribution.map((x) => [x.decision, x.count]));
    same(`distribution matches Section 3's funnel (${period})`,
      [d.Proceed, d.Park, d.Decline, d["No decision"]],
      [s3.counts.proceed, s3.counts.park, s3.counts.decline, s3.counts.noDecision]);
  }
}

// ── 4. The properties agreement cannot prove ────────────────────────────────
{
  const at = (period, view = "Monthly") =>
    S.buildSection4({ rfps, view, bounds: P.periodBounds(selFor(period, view), today) });
  const all = at("All time");

  for (const period of ["This year", "Specific month", "Last 90 days", "Last 12 months"]) {
    const other = at(period);
    same(`the distribution ignores the period (${period})`, other.distribution, all.distribution);
    same(`donor decisions ignore the period (${period})`, other.donor, all.donor);
  }

  // The converse: the blocks that SHOULD follow the period must move, or the period
  // control is decorative on this section.
  const month = at("Specific month");
  ok("decisions made follows the period",
    month.kpis.decisions !== all.kpis.decisions,
    `decisions=${month.kpis.decisions} in June 2026 and ${all.kpis.decisions} all-time`);

  // Both auto-scorer columns count the same rows the team's column does, so neither can
  // exceed the total — the claim the side-by-side table makes to the reader.
  for (const r of all.autoRec.rows) {
    ok(`autoRec ${r.decision} is within the decided rows`,
      r.auto <= all.autoRec.total && r.team <= all.autoRec.total,
      `auto=${r.auto} team=${r.team} total=${all.autoRec.total}`);
  }
  ok("agreement cannot exceed the rows compared",
    all.autoRec.agreed <= all.autoRec.total,
    `agreed=${all.autoRec.agreed} total=${all.autoRec.total}`);

  // overTime is reindexed against the bucket range, which DROPS as well as fills. Under a
  // period that is expected; under All time the window is the data's own min and max, so
  // only Monthly/Quarterly's deliberately-absent partial first bucket can lose a row.
  for (const view of P.VIEW_OPTS) {
    const b = at("All time", view);
    const drawn = b.overTime.reduce((a, r) => a + r.decisions, 0);
    ok(`overTime (All time, ${view}) draws no more than the Proceed decisions`,
      drawn <= all.distribution[0].count,
      `drawn=${drawn} proceed=${all.distribution[0].count}`);
  }

  console.log(`period independence confirmed; decisions ${all.kpis.decisions} all-time `
    + `vs ${month.kpis.decisions} in June 2026, `
    + `agreed ${all.autoRec.agreed} of ${all.autoRec.total}, `
    + `${all.donor.pending} awaiting a funder's answer`);
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
