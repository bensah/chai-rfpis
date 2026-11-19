// Parity check for Bids Submitted — views/outcomes.py's "Your Applied Funding".
//
//   node scripts/parity/check-grants.mjs    (from web/; reads the live database, read-only)
//
// The page's whole difficulty is that THREE DIFFERENT COUNTS OF "AN APPLICATION" appear on
// it and none of them reconcile:
//
//   rows        distinct RFP rows                       — the by-funder "Calls" column
//   weighted    submission_weight: zero unless progress  — the KPI strip
//               reached Completed, else `submissions`
//   raw         `submissions` filled to 1, no gate       — the by-funder "Submissions" column
//
// A port that picked one and used it everywhere would produce a page that is internally
// consistent and disagrees with the organisation's own reported figures. So each is checked
// against the Python separately, and the GAP between them is asserted by name.
//
// FX is pinned: the Node side resolves every currency string once and the Python answers
// from that map, so a rate moving between the two halves is not reported as a port
// difference. What is tested is which currency COLUMN each figure converts with — the named
// bug there is a USD 715,400 request rendered as $509,530 because the call was advertised
// in CAD.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireEnv } from "./_env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const D = await mod("supabase/functions/_shared/api/db.ts");
const G = await mod("supabase/functions/_shared/api/grants.ts");
const M = await mod("supabase/functions/_shared/api/money.ts");
const FX = await mod("supabase/functions/_shared/api/fx.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");
const py = (payload) => {
  try {
    return JSON.parse(execFileSync(python, [path.join(here, "grants_py.py")], {
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
const near = (a, b) => {
  if (typeof a !== "number" || typeof b !== "number") return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const d = Math.abs(a - b);
  return d <= 1e-9 || d <= 1e-12 * Math.max(Math.abs(a), Math.abs(b));
};
function equal(a, b) {
  if (near(a, b) || J(a) === J(b)) return true;
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
const ok = (label, cond, detail = "") => {
  checks++;
  if (cond) return;
  diffs++;
  console.log(`DIFF ${label}${detail ? `\n   ${detail}` : ""}`);
};

const env = requireEnv(root, "check-grants");
const db = D.createDb({
  supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY,
  jwtSecret: env.SUPABASE_JWT_SECRET ?? "",
});

const rfps = await db.service.getAll("rfp_submissions", `select=${G.GRANT_FIELDS}`, "uid");
const unique = rfps.filter((r) => r.is_duplicate !== true);
const active = unique.filter((r) => G.isSubmitted(r));
const [rates, table] = await Promise.all([
  FX.ratesFor(active.flatMap((r) => [r.currency_secured, r.currency])),
  M.loadCurrencies(db),
]);
console.log(`${rfps.length} rows, ${unique.length} non-duplicate, ${active.length} submitted`);

// One resolved rate per literal currency string, so both halves convert identically.
const resolved = {};
for (const r of active) {
  for (const v of [r.currency_secured, r.currency]) {
    const cur = String(v ?? "").trim();
    if (cur && !(cur in resolved)) resolved[cur] = M.usdRate(cur, rates, table);
  }
}

const ORG = "CHAI";       // only reaches the lead/sub placeholders, which the Python omits
const ts = G.buildGrants({ rfps, rates, table, orgShort: ORG });
const want = py({ rfps, rates: resolved });

same("counts", ts.counts, want.counts);
same("money", ts.money, want.money);
same("win rate", ts.winRate, want.winRate);

// Per row, keyed by uid — pandas promises no order and neither does the port.
{
  const byUid = Object.fromEntries(ts.rows.map((r) => [r.uid, {
    status: r.status, approved: r.approved, pending: r.pending, notApproved: r.notApproved,
    applications: r.applications, submissions: r.submissions,
    usdRequested: r.usdRequested, usdSecured: r.usdSecured,
  }]));
  same("the submitted set", Object.keys(byUid).sort(), Object.keys(want.rows).sort());
  for (const uid of Object.keys(want.rows).sort()) same(`row ${uid}`, byUid[uid], want.rows[uid]);
}

// Per funder, the same way; the ORDER is asserted separately below because the Python's
// single-column sort_values is quicksort and unstable above numpy's insertion threshold.
{
  const byName = Object.fromEntries(ts.byFunder.map((f) => [f.funder, {
    rfps: f.rfps, submissions: f.submissions, approved: f.approved,
    pending: f.pending, notApproved: f.notApproved, requested: f.requested, secured: f.secured,
  }]));
  same("the funder set", Object.keys(byName).sort(), Object.keys(want.byFunder).sort());
  for (const name of Object.keys(want.byFunder).sort()) same(`funder ${name}`, byName[name], want.byFunder[name]);
  ok("funders are ordered by submissions, descending",
    ts.byFunder.every((f, i) => i === 0 || ts.byFunder[i - 1].submissions >= f.submissions),
    J(ts.byFunder.map((f) => [f.funder, f.submissions])));
  ok("the same funders, in the same multiset of submission counts",
    J(ts.byFunder.map((f) => f.submissions).sort((a, b) => a - b))
    === J(want.funderOrder.map((n) => want.byFunder[n].submissions).sort((a, b) => a - b)));
}

// ── Claims about the page itself ─────────────────────────────────────────────

ok("the KPI strip is submission-weighted, not a row count",
  ts.counts.submitted !== ts.counts.rows || active.every((r) => G.rawSubmissions(r) === 1),
  `${ts.counts.submitted} applications over ${ts.counts.rows} calls — these differ whenever a `
  + `call was submitted more than once, and counting rows would under-report every bucket.`);

{
  // THE GAP, decomposed rather than described — which is how this check corrected its own
  // first version. It assumed the by-funder column would run HIGHER than the strip, because
  // it has no progress gate. Measured, it runs LOWER: 20 against 24.
  //
  // Two rules pull in opposite directions, and both are live:
  //
  //   a row that never reached Completed    weighted 0, raw >= 0   -> strip LOWER
  //   a row with `submissions` below 1      weighted 1, raw 0      -> strip HIGHER
  //
  // The second is what dominates today: four completed rows carry `submissions = 0`, which
  // submissionWeight floors up to one application and the raw column leaves at zero. Both
  // numbers are on the page. Asserting the decomposition means neither column can be
  // "fixed" into the other without somebody deciding what an application is.
  const funderTotal = ts.byFunder.reduce((a, f) => a + f.submissions, 0);
  const ungated = ts.rows.filter((r) => r.applications === 0);
  const floored = ts.rows.filter((r) => r.applications > 0 && r.applications > r.submissions);
  const lost = ungated.reduce((a, r) => a + r.submissions, 0);
  const gained = floored.reduce((a, r) => a + (r.applications - r.submissions), 0);
  ok("the by-funder column and the headline count different things, and the gap is accounted for",
    ts.counts.submitted - funderTotal === gained - lost,
    `strip ${ts.counts.submitted} vs by-funder ${funderTotal} (gap ${ts.counts.submitted - funderTotal}): `
    + `${floored.length} rows floored up to one application (+${gained}), `
    + `${ungated.length} rows weighted zero for want of a Completed progress (-${lost}).`);
  ok("the floor is submissionWeight's, not the raw column's",
    floored.every((r) => r.applications === 1 && r.submissions <= 0),
    JSON.stringify(floored.map((r) => [r.uid, r.submissions, r.applications])));
}

ok("a declined application is kept, not dropped",
  ts.counts.notApproved === 0 || ts.rows.some((r) => r.notApproved),
  "the page is an applied-funding record; dropping the losses would make its win rate meaningless.");

{
  // A Completed row with no decision is pending AND shows "Under Review", so the badge and
  // the bucket agree. Without the second half it would show blank while being counted.
  const silent = ts.rows.filter((r) => r.progress.toLowerCase() === "completed" && !r.decision);
  ok("a completed row with no decision reads Under Review",
    silent.every((r) => r.status === "Under Review" && r.pending),
    `${silent.length} such rows; statuses ${J([...new Set(silent.map((r) => r.status))])}`);
}

{
  // The named FX bug: the REQUEST converts with the currency we submitted in, not the one
  // the call was advertised in.
  const split = active.filter((r) =>
    String(r.currency_secured ?? "").trim() && String(r.currency ?? "").trim()
    && String(r.currency_secured).trim().toUpperCase() !== String(r.currency).trim().toUpperCase());
  ok("the request converts with the submission currency, not the call's",
    split.every((r) => M.requestedCurrency(r) === String(r.currency_secured).trim()),
    `${split.length} rows where the two columns differ — reading the call's currency is what `
    + `rendered a USD 715,400 request as $509,530.`);
}

ok("still-in-play never goes negative",
  ts.money.balance >= 0,
  `requested ${ts.money.requested}, secured ${ts.money.secured}, unsecured ${ts.money.unsecured}`);

// ── The period filter ────────────────────────────────────────────────────────
// NEW, and with no Python counterpart: Bids Submitted has no period filter in the
// Streamlit app at all (owner, 2026-11-16). So these are claims about the model's own
// arithmetic and about the two properties that make a filter trustworthy — that the
// windows partition the log rather than overlapping it or losing rows, and that the year
// list can never need a code change to admit a new year.
{
  const TODAY = "2026-11-16";
  const b = (window, year = null, quarter = null) =>
    G.grantBounds({ window, year, quarter }, TODAY);

  same("the whole record has no bounds", b("all"), { start: null, end: null });
  // Inclusive of both ends and counting back N-1 days, so a week is seven dates, not eight.
  same("last 7 days is a week containing today", b("7d"),
    { start: "2026-11-10", end: "2026-11-16" });
  same("last 30 days", b("30d"), { start: "2026-10-18", end: "2026-11-16" });
  same("last 90 days", b("90d"), { start: "2026-08-19", end: "2026-11-16" });
  same("last 365 days", b("365d"), { start: "2025-11-17", end: "2026-11-16" });

  // THE ANCHOR RULE. The current year anchors on today; a past year anchors on its own
  // 31 December, which is what "which year are we viewing the last 7 days for" has to mean
  // if it is to mean anything a reader can act on.
  same("this year's window still ends today", b("7d", 2026),
    { start: "2026-11-10", end: "2026-11-16" });
  same("last 7 days OF 2025 is the end of 2025", b("7d", 2025),
    { start: "2025-12-25", end: "2025-12-31" });
  same("last 30 days of 2025", b("30d", 2025),
    { start: "2025-12-02", end: "2025-12-31" });
  // CLAMPED, so a year's window never reaches into the year before it. Without this,
  // "last 365 days of 2025" would quietly include December 2024 and the year control
  // would be a lie.
  same("last 365 days of 2025 is 2025, not thirteen months",
    b("365d", 2025), { start: "2025-01-01", end: "2025-12-31" });
  same("last 90 days of a leap year ends on its own 31 December",
    b("90d", 2024), { start: "2024-10-03", end: "2024-12-31" });

  same("a whole year", b("all", 2025), { start: "2025-01-01", end: "2025-12-31" });
  same("Q1", b("all", 2026, 1), { start: "2026-01-01", end: "2026-03-31" });
  same("Q2 ends on a 30th", b("all", 2026, 2), { start: "2026-04-01", end: "2026-06-30" });
  same("Q4", b("all", 2026, 4), { start: "2026-10-01", end: "2026-12-31" });
  // February, because a quarter's end is computed rather than tabulated.
  same("Q1 of a leap year still ends in March", b("all", 2024, 1),
    { start: "2024-01-01", end: "2024-03-31" });
  // A quarter is only honoured for the whole-period window: two windows at once is not
  // something the page offers, and silently intersecting them would answer a question
  // nobody asked.
  same("a quarter is ignored when a rolling window is active",
    b("30d", 2025, 2), b("30d", 2025));
  same("a year with no year chosen is the whole record", b("all", null),
    { start: null, end: null });

  ok("both ends are inclusive",
    G.inGrantPeriod("2026-11-10", b("7d")) && G.inGrantPeriod("2026-11-16", b("7d"))
    && !G.inGrantPeriod("2026-11-09", b("7d")) && !G.inGrantPeriod("2026-11-17", b("7d")));
  ok("an undated row belongs to no window but survives the whole record",
    !G.inGrantPeriod(null, b("90d")) && G.inGrantPeriod(null, b("all")),
    "quietly keeping it would make the windows fail to sum to the whole, which is worse "
    + "than one row being invisible until the filter is cleared.");

  // THE YEAR LIST, which is the thing the owner asked about: it must never need editing.
  same("the current year is offered even with no data in it",
    G.offeredYears([], "2027-01-01"), [2027]);
  same("years come from the rows, newest first, with the current one always present",
    G.offeredYears(["2025-06-01", "2023-01-01", "2025-12-31", null], "2026-11-16"),
    [2026, 2025, 2023]);
  ok("a future year is never offered",
    !G.offeredYears(["2031-01-01", "2026-01-01"], "2026-11-16").includes(2031),
    JSON.stringify(G.offeredYears(["2031-01-01", "2026-01-01"], "2026-11-16")));
  ok("next January admits the new year with no code change",
    G.offeredYears(["2026-05-01"], "2027-01-01")[0] === 2027,
    "the list is derived from the rows and the clock, never written down.");

  // THE PROPERTY THAT MATTERS: the four quarters of a year are exactly that year, with
  // nothing double-counted and nothing lost. Checked on the live rows rather than asserted.
  for (const year of ts.years) {
    const whole = G.buildGrants({ rfps, rates, table, orgShort: ORG, today: TODAY,
      selection: { window: "all", year, quarter: null } });
    const quarters = [1, 2, 3, 4].map((q) => G.buildGrants({
      rfps, rates, table, orgShort: ORG, today: TODAY,
      selection: { window: "all", year, quarter: q },
    }));
    same(`${year}'s quarters partition the year`,
      quarters.reduce((a, x) => a + x.rows.length, 0), whole.rows.length);
    same(`${year}'s quarters partition its submitted count`,
      quarters.reduce((a, x) => a + x.counts.submitted, 0), whole.counts.submitted);
    ok(`${year} is a subset of the whole record`,
      whole.rows.length + whole.hiddenByPeriod === ts.rows.length,
      `${whole.rows.length} in ${year} + ${whole.hiddenByPeriod} hidden vs ${ts.rows.length} total`);
    // And a rolling window inside a year is a subset of that year — the clamp, measured
    // on live rows rather than only on bounds.
    const w365 = G.buildGrants({ rfps, rates, table, orgShort: ORG, today: TODAY,
      selection: { window: "365d", year, quarter: null } });
    ok(`${year}'s last 365 days never reaches outside ${year}`,
      w365.rows.every((r) => !r.periodDate || r.periodDate.slice(0, 4) === String(year)),
      JSON.stringify(w365.rows.map((r) => r.periodDate)));
  }

  // The ordering the owner asked for, on the live rows.
  const dates = ts.rows.map((r) => r.periodDate);
  const dated = dates.filter(Boolean);
  ok("rows come back newest first", dated.every((d, i) => i === 0 || dated[i - 1] >= d),
    J(dates));
  ok("undated rows sort last",
    dates.indexOf(null) === -1 || dates.slice(dates.indexOf(null)).every((d) => d === null),
    J(dates));
  ok("every row carries the date it was ordered by, or says it has none",
    ts.rows.every((r) => r.periodDate === null || /^\d{4}-\d{2}-\d{2}$/.test(r.periodDate)));
  // The chain, against the rows it was measured on: a date is never invented.
  ok("the ordering date is one of the row's own columns",
    active.every((r) => {
      const { date, source } = G.submittedOn(r);
      if (source === "none") return date === null;
      const col = { completed: r.date_completed, deadline: r.call_submission_deadline,
        logged: r.submitted_at }[source];
      return date === String(col ?? "").slice(0, 10);
    }));
  ok("the chain prefers a recorded completion over a deadline",
    active.filter((r) => r.date_completed).every((r) => G.submittedOn(r).source === "completed"));

  // The query string, which is the only part a browser controls.
  const YEARS = [2026, 2025];
  const parse = (qs) => G.parseGrantSelection(new URLSearchParams(qs), YEARS);
  same("a plain year", parse("year=2025"),
    { window: "all", year: 2025, quarter: null });
  same("a window inside a year", parse("window=30d&year=2025"),
    { window: "30d", year: 2025, quarter: null });
  same("a quarter", parse("year=2025&quarter=3"),
    { window: "all", year: 2025, quarter: 3 });
  same("an unknown window falls back to the whole period", parse("window=forever"),
    { window: "all", year: null, quarter: null });
  same("a nonsense quarter is dropped, not clamped", parse("year=2025&quarter=9"),
    { window: "all", year: 2025, quarter: null });
  // A stale bookmark naming a year the data cannot support must not render an empty page
  // under a heading nobody can explain.
  same("a year the data does not have falls back to the whole record",
    parse("year=2031"), { window: "all", year: null, quarter: null });
  same("no query string at all", parse(""), { window: "all", year: null, quarter: null });
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
