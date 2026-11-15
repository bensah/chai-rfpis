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

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
