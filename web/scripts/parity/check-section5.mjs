// Parity check for Report Section 5 — Our Results (id 5).
//
//   node scripts/parity/check-section5.mjs    (from web/; reads the live database, read-only)
//
// This is the money section, and it disagrees with itself on purpose in three places:
// `amount_requested` converts with `currency_secured` in the tiles and with `currency` in
// the closing table; the submissions tile neither strips `progress_status` nor floors at 1,
// where the shared `submissionWeight()` does both; and the request-currency fallback fires
// only on an EXACTLY blank value, where the shared `requestedCurrency()` strips first.
//
// Agreement on live data cannot prove any of that — live rows are clean, and a port that
// "tidied" all three would still match. So a synthetic frame carries one row per divergence
// and the check states each as a claim about the numbers.
//
// FX IS PINNED, for the reason check-section3 gives: `_to_usd` does a live lookup, and two
// halves calling it seconds apart can disagree because a rate moved.
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
const S = await mod("supabase/functions/_shared/api/report_section5.ts");
const M = await mod("supabase/functions/_shared/api/money.ts");
const FX = await mod("supabase/functions/_shared/api/fx.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");
const py = (payload) => {
  try {
    return JSON.parse(execFileSync(python, [path.join(here, "section5_py.py")], {
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
// Relative, for the reason check-section3 spells out: these sums reach 2e10, where a
// double's last bit is worth 4e-6 and two correct implementations summing in a different
// order differ by more than any fixed absolute epsilon.
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

/**
 * Both ranked lists are a SINGLE-column `sort_values` in report.py, which is quicksort and
 * not stable, so the tie order there is whatever introsort's pivots produced. The port sorts
 * stably. Comparing content means comparing the two as SETS, keyed by uid; the order itself
 * is checked separately, as the property it actually has to have.
 */
const byUid = (rows) => [...rows].sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));

const env = requireEnv(root, "check-section5");
const db = D.createDb({
  supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY,
  jwtSecret: env.SUPABASE_JWT_SECRET ?? "",
});
const rfps = await db.service.getAll("rfp_submissions", `select=${S1.RFP_COLUMNS}`, "uid");
console.log(`${rfps.length} submissions`);

const today = new Date().toISOString().slice(0, 10);
const selFor = (period, view) =>
  P.resolveSelection({ period, year: 2026, month: "June", view }, today, 2026);

// ── The synthetic frame: one row per rule this section does NOT share ───────
const srow = (uid, o) => ({
  uid, is_duplicate: false, decision: "Proceed", opportunity_title: `T ${uid}`,
  funding_agency: "A Funder", progress_status: null, donor_decision: null,
  submissions: null, amount_requested: null, amount_secured: null,
  call_award_value: null, currency: null, currency_secured: null,
  date_of_approval: null, date_completed: null,
  search_date: null, submitted_at: null, decision_date: null,
  auto_recommendation: null, decision_overridden_by: null, ...o,
});
const synthetic = [
  // `submissions = 0` on a Completed row contributes NOTHING here. `submissionWeight()`
  // floors at 1, so the Pipeline counts this row as one application and this tile as none.
  srow("s-zero-submissions", { progress_status: "Completed", submissions: 0 }),
  srow("s-three-submissions", { progress_status: "Completed", submissions: 3 }),
  // Trailing space: NOT Completed to this section's unstripped gate, and Completed to
  // `submissionWeight()`.
  srow("s-completed-padded", { progress_status: "Completed ", submissions: 5 }),
  // A whitespace-only currency_secured is NOT "exactly blank", so it is handed to the rate
  // lookup (which answers 1.0) instead of falling back to the call's EUR rate.
  srow("s-ws-currency", {
    donor_decision: "Under Review", amount_requested: 1000,
    currency: "EUR", currency_secured: "   ",
  }),
  // ...and an exactly-blank one DOES fall back to EUR.
  srow("s-blank-currency", {
    donor_decision: "Under Review", amount_requested: 1000,
    currency: "EUR", currency_secured: "",
  }),
  // Approved with a secured amount of zero: `sec_usd or req_usd` falls back to the ask, so
  // the bar is drawn at what we asked for rather than at nothing.
  srow("s-approved-zero-secured", {
    progress_status: "Completed", donor_decision: "Approved",
    amount_requested: 500, amount_secured: 0, currency_secured: "USD",
  }),
  // An approved amount with no currency at all — the transparency badge counts this one.
  srow("s-approved-no-currency", {
    progress_status: "Completed", donor_decision: "Approved",
    amount_secured: 2000, currency_secured: null,
    date_of_approval: "2026-06-15", date_completed: "2026-05-01",
  }),
  // A pipeline amount with no currency — the badge's other half.
  srow("s-pipeline-no-currency", { call_award_value: 90000, currency: null }),
  // A padded donor decision: inside the money totals (which strip) and outside
  // `kpis.approved` (which does not).
  srow("s-padded-approved", {
    progress_status: "Completed", donor_decision: " Approved ",
    amount_secured: 700, currency_secured: "USD", date_of_approval: "2026-06-20",
  }),
  srow("s-not-approved", {
    progress_status: "Completed", donor_decision: "Not Approved",
    amount_requested: 4000, currency_secured: "USD",
  }),
  // Completed with no answer back: "Under Review" in the table, blank everywhere else.
  srow("s-blank-decision", { progress_status: "Completed", amount_requested: 100, currency: "USD" }),
  // The grants table converts the request with `currency`; the tiles use `currency_secured`.
  // This row is the one that makes the two disagree.
  srow("s-split-currency", {
    progress_status: "Completed", donor_decision: "Under Review",
    amount_requested: 1000, currency: "EUR", currency_secured: "USD",
  }),
  // Duplicates are out of every block.
  srow("s-duplicate", { is_duplicate: true, progress_status: "Completed", submissions: 9 }),
  // A Park row is not on the Proceed track at all.
  srow("s-park", { decision: "Park", progress_status: "Completed", submissions: 9 }),
];

// Every distinct currency string BOTH frames will need, resolved through the port's own
// `usdRate` so the Python half needs no lookup of its own.
const [rates, table] = await Promise.all([
  FX.ratesFor([...S3.currenciesUsed(rfps), ...S3.currenciesUsed(synthetic)]),
  M.loadCurrencies(db),
]);
const resolved = {};
for (const v of [...S3.currenciesUsed(rfps), ...S3.currenciesUsed(synthetic)]) {
  const cur = String(v ?? "").trim();
  if (cur && !(cur in resolved)) resolved[cur] = M.usdRate(cur, rates, table);
}
console.log(`${Object.keys(resolved).length} distinct currency strings resolved`);

// ── 1. Live data, every period crossed with every view ──────────────────────
{
  const cases = [];
  for (const period of P.PERIOD_OPTS) {
    for (const view of P.VIEW_OPTS) {
      cases.push({ period, view, bounds: P.periodBounds(selFor(period, view), today) });
    }
  }
  const wants = py({ rfps, rates: resolved, cases: cases.map((c) => ({ bounds: c.bounds, view: c.view })) });
  for (const [i, c] of cases.entries()) {
    const ts = S.buildSection5({ rfps, view: c.view, bounds: c.bounds, rates, table });
    const w = wants[i], tag = `${c.period} / ${c.view}`;
    same(`kpis ${tag}`, ts.kpis, w.kpis);
    same(`money ${tag}`, ts.money, w.money);
    same(`missingCurrency ${tag}`, ts.missingCurrency, w.missingCurrency);
    same(`conversion ${tag}`, ts.conversion, w.conversion);
    same(`cumulative ${tag}`, ts.cumulative, w.cumulative);
    same(`outcomes ${tag}`, byUid(ts.outcomes), byUid(w.outcomes));
    same(`grants ${tag}`, byUid(ts.grants), byUid(w.grants));
  }
  console.log(`${cases.length} period × view combinations checked on live data`);
}

// ── 2. The synthetic frame ──────────────────────────────────────────────────
{
  const cases = [];
  for (const period of ["All time", "This year"]) {
    for (const view of ["Monthly", "Weekly"]) {
      cases.push({ period, view, bounds: P.periodBounds(selFor(period, view), today) });
    }
  }
  const wants = py({ rfps: synthetic, rates: resolved, cases: cases.map((c) => ({ bounds: c.bounds, view: c.view })) });
  for (const [i, c] of cases.entries()) {
    const ts = S.buildSection5({ rfps: synthetic, view: c.view, bounds: c.bounds, rates, table });
    const w = wants[i], tag = `synthetic ${c.period} / ${c.view}`;
    same(`${tag} kpis`, ts.kpis, w.kpis);
    same(`${tag} money`, ts.money, w.money);
    same(`${tag} missingCurrency`, ts.missingCurrency, w.missingCurrency);
    same(`${tag} conversion`, ts.conversion, w.conversion);
    same(`${tag} cumulative`, ts.cumulative, w.cumulative);
    same(`${tag} outcomes`, byUid(ts.outcomes), byUid(w.outcomes));
    same(`${tag} grants`, byUid(ts.grants), byUid(w.grants));
  }

  // The three divergences, stated as claims about the numbers — because both halves are
  // written by the same hand and a shared mistake would pass the comparison above.
  const b = S.buildSection5({
    rfps: synthetic, view: "Monthly",
    bounds: P.periodBounds(selFor("All time", "Monthly"), today), rates, table,
  });
  const g = Object.fromEntries(b.grants.map((r) => [r.uid, r]));
  const o = Object.fromEntries(b.outcomes.map((r) => [r.uid, r]));
  const eur = M.usdRate("EUR", rates, table);

  // Completed rows: zero-submissions(0) + three(3) + approved-zero-secured(1)
  // + approved-no-currency(1) + padded-approved(1) + not-approved(1) + blank-decision(1)
  // + split-currency(1) = 9. "Completed " and the Park and duplicate rows are out.
  ok("the submissions tile neither strips nor floors",
    b.kpis.submitted === 9 && !("s-completed-padded" in g),
    `submitted=${b.kpis.submitted} (want 9: a submissions of 0 contributes nothing, and `
    + `"Completed " is not Completed), padded row in the table: ${"s-completed-padded" in g}`);
  ok("submissionWeight() would disagree with it",
    M.submissionWeight(synthetic.find((r) => r.uid === "s-zero-submissions")) === 1
    && M.submissionWeight(synthetic.find((r) => r.uid === "s-completed-padded")) === 5,
    "the shared helper floors at 1 and strips; if it stopped doing either, this section "
    + "would silently become consistent and the divergence would go unrecorded");

  ok("a whitespace-only currency_secured does NOT fall back to the call's currency",
    near(o["s-ws-currency"].reqUsd, 1000) && near(o["s-blank-currency"].reqUsd, 1000 * eur),
    `whitespace row reqUsd=${o["s-ws-currency"].reqUsd} (want 1000, converted as USD), `
    + `blank row reqUsd=${o["s-blank-currency"].reqUsd} (want ${1000 * eur}, converted as EUR)`);
  ok("requestedCurrency() would disagree with it",
    M.requestedCurrency({ currency_secured: "   ", currency: "EUR" }) === "EUR",
    "the shared helper strips first and falls back; this section does not");

  ok("the grants table converts the request with `currency`",
    near(g["s-split-currency"].requestedUsd, 1000 * eur)
    && near(o["s-split-currency"].reqUsd, 1000),
    `table requestedUsd=${g["s-split-currency"].requestedUsd} (want ${1000 * eur}, EUR) vs `
    + `tile reqUsd=${o["s-split-currency"].reqUsd} (want 1000, USD)`);

  ok("an Approved call with nothing secured is drawn at what was asked",
    o["s-approved-zero-secured"].signedUsd === 500,
    `signedUsd=${o["s-approved-zero-secured"].signedUsd}, expected 500`);
  ok("a Not Approved call is drawn below zero",
    o["s-not-approved"].signedUsd === -4000,
    `signedUsd=${o["s-not-approved"].signedUsd}, expected -4000`);
  ok("the money totals strip the donor decision and the count tile does not",
    b.kpis.approved === 2 && near(b.money.secured, 2000 + 700),
    `kpis.approved=${b.kpis.approved} (want 2: the two unpadded Approved rows), `
    + `money.secured=${b.money.secured} (want 2700: the padded row's 700 is included)`);
  ok("the transparency badge counts both halves",
    b.missingCurrency.approved === 1 && b.missingCurrency.pipeline === 1,
    `approved=${b.missingCurrency.approved} pipeline=${b.missingCurrency.pipeline}, want 1 and 1`);
  ok("a blank donor decision reads as Under Review in the table only",
    g["s-blank-decision"].donorDecision === "Under Review" && !("s-blank-decision" in o),
    `table says ${J(g["s-blank-decision"].donorDecision)}, and the row is `
    + `${"s-blank-decision" in o ? "wrongly" : "correctly"} absent from the outcome chart`);
  console.log(`${synthetic.length} synthetic rows, one per divergence, agreed on `
    + `${cases.length} period × view combinations`);
}

// ── 3. The cross-section claim, and the orders ──────────────────────────────
{
  const at = (period, view = "Monthly") =>
    S.buildSection5({ rfps, view, bounds: P.periodBounds(selFor(period, view), today), rates, table });
  const all = at("All time");

  // `conversion.submitted` IS Section 3's `submitted` — the same rule, written twice.
  for (const period of ["All time", "This year"]) {
    const bounds = P.periodBounds(selFor(period, "Monthly"), today);
    const s3 = S3.buildSection3({ rfps, bounds, rates, table });
    const s5 = S.buildSection5({ rfps, view: "Monthly", bounds, rates, table });
    same(`conversion matches Section 3's funnel (${period})`,
      [s5.conversion.proceeded, s5.conversion.submitted, s5.conversion.approved],
      [s3.counts.proceed, s3.counts.submitted, s3.counts.approved]);
  }

  // Everything but the cumulative curve ignores the period.
  for (const period of ["This year", "Specific month", "Last 90 days", "Last 12 months"]) {
    const other = at(period);
    same(`kpis ignore the period (${period})`, other.kpis, all.kpis);
    same(`money ignores the period (${period})`, other.money, all.money);
    same(`conversion ignores the period (${period})`, other.conversion, all.conversion);
    same(`the outcome chart ignores the period (${period})`, byUid(other.outcomes), byUid(all.outcomes));
    same(`the grants table ignores the period (${period})`, byUid(other.grants), byUid(all.grants));
  }

  // ...and the curve must not, or the period control is decorative on this section.
  const month = at("Specific month");
  ok("the cumulative curve follows the period",
    J(month.cumulative) !== J(all.cumulative),
    `both periods produced ${all.cumulative.length} identical points — the one block that `
    + "should read the period is not reading it");

  // The curve is a running total, so it can only fall when a bucket is negative — which it
  // never is, since every term is an approved amount.
  for (const view of P.VIEW_OPTS) {
    const c = at("All time", view).cumulative;
    let monotone = true;
    for (let i = 1; i < c.length; i++) if (c[i].cumulative < c[i - 1].cumulative) monotone = false;
    ok(`the cumulative curve never falls (${view})`, monotone,
      `${c.length} buckets, with a decrease — a cumsum over non-negative amounts cannot do that`);
    if (c.length) {
      ok(`the curve's last point is the sum of its buckets (${view})`,
        near(c[c.length - 1].cumulative, c.reduce((a, r) => a + r.secured, 0)),
        `last=${c[c.length - 1].cumulative} sum=${c.reduce((a, r) => a + r.secured, 0)}`);
    }
  }

  // The port's own ordering, which report.py's unstable sort cannot be compared against.
  const nonIncreasing = (rows, key) => rows.every((r, i) => i === 0 || rows[i - 1][key] >= r[key]);
  ok("the outcome chart is ordered by signed value, descending",
    nonIncreasing(all.outcomes, "signedUsd"), `${all.outcomes.length} rows`);
  ok("the grants table is ordered by requested value, descending",
    nonIncreasing(all.grants, "requestedUsd"), `${all.grants.length} rows`);

  console.log(`period independence confirmed; ${all.kpis.submitted} submissions, `
    + `${all.kpis.approved} approved, win rate ${all.kpis.winRate.toFixed(1)}%, `
    + `secured $${Math.round(all.money.secured).toLocaleString("en-US")} of `
    + `$${Math.round(all.money.requested).toLocaleString("en-US")} requested, `
    + `${all.cumulative.length} buckets on the curve`);
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
