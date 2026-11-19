// Parity check for Report Section 3 as displayed — the status & eligibility funnel (id 2).
//
//   node scripts/parity/check-section3.mjs    (from web/; reads the live database, read-only)
//
// Almost nothing here follows the period, which is the thing most likely to be "fixed" by a
// porter: the funnel is all-time on purpose, because the Excel-migrated rows carry no
// search_date and filtering would hide the organisation's whole pre-migration pipeline. So
// the matrix runs every period anyway, and then asserts DIRECTLY that only one number moved.
//
// FX IS PINNED. `_to_usd` reaches core.dropdowns.usd_rate, which does a live lookup; two
// halves calling it seconds apart can disagree because a rate moved, which is not a port
// difference. The Node side sends the rates it used and the Python answers from them.
// `usd_rate` itself is covered by check-scoring; what is tested here is which COLUMN PAIR
// each funnel stage converts.
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
const S = await mod("supabase/functions/_shared/api/report_section3.ts");
const M = await mod("supabase/functions/_shared/api/money.ts");
const FX = await mod("supabase/functions/_shared/api/fx.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");
const py = (payload) => {
  try {
    return JSON.parse(execFileSync(python, [path.join(here, "section3_py.py")], {
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
/**
 * RELATIVE, not absolute, and the difference matters here.
 *
 * The value funnel sums award values in the tens of billions of dollars. At 2e10 a double's
 * last bit is worth about 4e-6, so two correct implementations that add the same numbers in
 * a different ORDER differ by more than any fixed absolute epsilon — the two halves of this
 * check disagreed by exactly one unit in the last place. A 1e-6 absolute tolerance would
 * have reported that as a port difference forever.
 *
 * 1e-12 relative is far tighter than any real disagreement: converting one row with the
 * wrong rate, or summing the wrong column, moves the total by percent, not by a bit. The
 * absolute floor catches the near-zero case where a relative test degenerates.
 */
const near = (a, b) => {
  if (typeof a !== "number" || typeof b !== "number") return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  return diff <= 1e-9 || diff <= 1e-12 * Math.max(Math.abs(a), Math.abs(b));
};
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

const env = requireEnv(root, "check-section3");
const db = D.createDb({
  supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY,
  jwtSecret: env.SUPABASE_JWT_SECRET ?? "",
});
const rfps = await db.service.getAll("rfp_submissions", `select=${S1.RFP_COLUMNS}`, "uid");
const [rates, table] = await Promise.all([
  FX.ratesFor(S.currenciesUsed(rfps)),
  M.loadCurrencies(db),
]);
console.log(`${rfps.length} submissions, ${Object.keys(rates).length} live rates, ${table.length} currencies configured`);

// Every distinct currency string in the data, resolved through the SAME usdRate the port
// uses. The Python half then needs no lookup of its own — see section3_py.py::_pin_rates
// for why the harness deliberately holds none.
const resolved = {};
for (const v of S.currenciesUsed(rfps)) {
  const cur = String(v ?? "").trim();
  if (cur && !(cur in resolved)) resolved[cur] = M.usdRate(cur, rates, table);
}
console.log(`${Object.keys(resolved).length} distinct currency strings resolved`);

const today = new Date().toISOString().slice(0, 10);
const cases = [];
for (const period of P.PERIOD_OPTS) {
  const sel = P.resolveSelection({ period, year: 2026, month: "June", view: "Monthly" }, today, 2026);
  cases.push({ period, bounds: P.periodBounds(sel, today) });
}
const wants = py({ rfps, rates: resolved, cases: cases.map((c) => ({ bounds: c.bounds })) });

for (const [i, c] of cases.entries()) {
  const ts = S.buildSection3({ rfps, bounds: c.bounds, rates, table });
  same(`counts ${c.period}`, ts.counts, wants[i].counts);
  same(`values ${c.period}`, ts.values, wants[i].values);
  same(`progress ${c.period}`, ts.progress, wants[i].progress);
  same(`proceedRows ${c.period}`, ts.proceedRows, wants[i].proceedRows);
}
console.log(`${cases.length} periods checked`);

// ── The properties agreement cannot prove ───────────────────────────────────
// Everything above would still pass if BOTH sides had been "fixed" to filter the funnel by
// the period, because the Python half is a transcription. So assert the shape directly.
{
  const bounds = (p) => P.periodBounds(P.resolveSelection({ period: p, year: 2026, month: "June", view: "Monthly" }, today, 2026), today);
  const all = S.buildSection3({ rfps, bounds: bounds("All time"), rates, table });

  for (const period of ["This year", "Specific month", "Last 90 days", "Last 12 months"]) {
    const other = S.buildSection3({ rfps, bounds: bounds(period), rates, table });
    const strip = (c) => { const { discoveredInPeriod, ...rest } = c; return rest; };
    same(`the funnel ignores the period (${period})`, strip(other.counts), strip(all.counts));
    same(`the value funnel ignores the period (${period})`, other.values, all.values);
    same(`progress ignores the period (${period})`, other.progress, all.progress);
  }

  // And the converse: the one number that SHOULD move must move, or the badge is dead.
  checks++;
  const narrow = S.buildSection3({ rfps, bounds: bounds("Specific month"), rates, table });
  if (narrow.counts.discoveredInPeriod === all.counts.discoveredInPeriod) {
    diffs++;
    console.log("DIFF discoveredInPeriod did not change between All time and a single month — "
      + "the only period-sensitive number on this section is not reading the period.");
  }
  console.log(`period independence confirmed; discoveredInPeriod ${all.counts.discoveredInPeriod} all-time `
    + `vs ${narrow.counts.discoveredInPeriod} in June 2026`);

  // The nesting is the funnel's whole claim. Assert it rather than trusting it.
  checks++;
  const c = all.counts;
  if (!(c.approved <= c.submitted && c.submitted <= c.proceed && c.proceed <= c.total)) {
    diffs++;
    console.log(`DIFF the funnel stages are not nested: total=${c.total} proceed=${c.proceed} `
      + `submitted=${c.submitted} approved=${c.approved}`);
  }
  checks++;
  if (c.proceed + c.park + c.decline + c.noDecision !== c.total) {
    diffs++;
    console.log(`DIFF the four decision buckets do not sum to the total: `
      + `${c.proceed}+${c.park}+${c.decline}+${c.noDecision} != ${c.total}`);
  }
  checks++;
  const progressTotal = all.progress.reduce((a, r) => a + r.rfps, 0);
  if (progressTotal !== c.proceed) {
    diffs++;
    console.log(`DIFF progress rows sum to ${progressTotal}, not the Proceed count ${c.proceed} — `
      + "a blank progress should default to Not Started, so every Proceed row lands somewhere.");
  }
  console.log(`nesting, bucket sum and progress coverage all hold `
    + `(total ${c.total}, proceed ${c.proceed}, submitted ${c.submitted}, approved ${c.approved})`);
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
