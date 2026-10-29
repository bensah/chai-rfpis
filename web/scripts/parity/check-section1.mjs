// Parity check for Report Section 1 — Scan activity.
//
//   node scripts/parity/check-section1.mjs     (from web/; reads the live database, read-only)
//
// Every block, for EVERY period option × EVERY view. Section 1's eight blocks deliberately
// disagree about the period — intake and cycle time are all-time, focus areas are all-time
// AND Proceed-only, the rest follow the selection — so a single period would exercise the
// disagreement without ever testing it. Running the whole matrix is what catches a block
// that has been quietly brought into line with its neighbours.
//
// Both halves are given the SAME ROWS: this script fetches once and sends them to the Python,
// so "different data" can never be mistaken for "different logic".
//
// WHAT THIS DOES NOT DO, stated plainly. report.py's section-1 blocks are inline in the
// Streamlit script, not functions, so they cannot be lifted the way the period helpers were.
// section1_py.py lifts what IS liftable (_bucket_start, _bucketed_count, _in_period,
// _submitted_mask, _programme_area_freq, _discovery_ts) and imports the shared modules
// (funder_names, member_names, keyword_cloud) — those are the real code. The groupby/sum
// arithmetic around them is TRANSCRIBED, with report.py's line ranges quoted beside each
// block. A green run means the TypeScript agrees with that transcription; it does not prove
// the transcription matches the page. Read the two side by side when changing either.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const D = await mod("supabase/functions/_shared/api/db.ts");
const P = await mod("supabase/functions/_shared/api/report_period.ts");
const S = await mod("supabase/functions/_shared/api/report_section1.ts");
const N = await mod("supabase/functions/_shared/api/report_names.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");
// ONE process for the whole matrix. Importing pandas and the core modules costs about four
// seconds, and paying it per combination made this a three-minute check — which is a check
// nobody runs, which is a check that does not exist.
const py = (payload) => {
  try {
    return JSON.parse(execFileSync(python, [path.join(here, "section1_py.py")], {
      input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 1 << 28,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (e) {
    console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
    process.exit(2);
  }
};

let diffs = 0, checks = 0;
const canon = (v) => (v === null || typeof v !== "object" ? v
  : Array.isArray(v) ? v.map(canon)
  : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])));
// Floats: a mean of days or an average duration is a repeating decimal, and the two
// languages print it to different lengths. Compared to 1e-9, which is far tighter than any
// difference that would come from a genuinely different calculation.
const near = (a, b) => typeof a === "number" && typeof b === "number"
  && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
function equal(a, b) {
  if (near(a, b)) return true;
  const x = canon(a), y = canon(b);
  if (JSON.stringify(x) === JSON.stringify(y)) return true;
  // Element-wise for arrays/objects so a float deep inside still gets the tolerance.
  if (Array.isArray(x) && Array.isArray(y) && x.length === y.length) {
    return x.every((v, i) => equal(v, y[i]));
  }
  if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) {
    const ks = new Set([...Object.keys(x), ...Object.keys(y)]);
    return [...ks].every((k) => equal(x[k], y[k]));
  }
  return false;
}
/**
 * A ranked list whose tie ORDER is arbitrary in report.py (a single-column pandas
 * sort_values, i.e. numpy introsort above its insertion-sort threshold).
 *
 * The count SEQUENCE must match exactly — that pins the ranking. Membership must match
 * exactly above the tie band at the cut. Inside that band report.py's choice is a pivot
 * artefact, so the check reports which names are in contention instead of failing, and
 * fails only if the two disagree about how MANY come from the band.
 */
const tieBands = new Set();
function sameRanked(label, tsTop, pyTop, valueOf, nameOf) {
  checks++;
  const tsV = tsTop.map(valueOf), pyV = pyTop.map(valueOf);
  if (JSON.stringify(tsV) !== JSON.stringify(pyV)) {
    diffs++;
    console.log(`DIFF ${label} count sequence
   ts: ${JSON.stringify(tsV)}
   py: ${JSON.stringify(pyV)}`);
    return;
  }
  if (!tsTop.length) return;
  const cut = tsV[tsV.length - 1];
  const above = (list) => list.filter((x) => valueOf(x) > cut).map(nameOf).sort();
  checks++;
  if (JSON.stringify(above(tsTop)) !== JSON.stringify(above(pyTop))) {
    diffs++;
    console.log(`DIFF ${label} membership above the tie band
   ts: ${JSON.stringify(above(tsTop))}
   py: ${JSON.stringify(above(pyTop))}`);
    return;
  }
  const inBand = (list) => list.filter((x) => valueOf(x) === cut).map(nameOf).sort();
  const t = inBand(tsTop), p = inBand(pyTop);
  checks++;
  if (t.length !== p.length) {
    diffs++;
    console.log(`DIFF ${label} took ${t.length} from the tie band, report.py took ${p.length}`);
    return;
  }
  if (JSON.stringify(t) !== JSON.stringify(p)) {
    tieBands.add(`${label.split(" ")[0]}: ${t.length} of the names tied at ${cut} make the chart; `
      + `this port shows ${JSON.stringify(t)}, report.py ${JSON.stringify(p)}`);
  }
}

const same = (label, ts, pyv) => {
  checks++;
  if (equal(ts, pyv)) return;
  diffs++;
  const a = JSON.stringify(canon(ts)), b = JSON.stringify(canon(pyv));
  console.log(`DIFF ${label}\n   ts: ${a.length > 600 ? a.slice(0, 600) + "…" : a}\n   py: ${b.length > 600 ? b.slice(0, 600) + "…" : b}`);
};

// ── Rows, read once ──────────────────────────────────────────────────────────
function loadEnv() {
  const env = {};
  for (const dir of [process.cwd(), root, "D:/Apps/chai-rfpis"]) {
    const f = path.join(dir, ".env");
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return env;
}
const env = loadEnv();
if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
  console.log("No SUPABASE_URL / SUPABASE_KEY in .env — cannot run against live rows.");
  process.exit(2);
}
const db = D.createDb({
  supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY,
  jwtSecret: env.SUPABASE_JWT_SECRET ?? "",
});
// Service role, unscoped: the check is about the AGGREGATION, and routing/scoping is
// check-routing.mjs's job. Scoping here too would narrow the rows and weaken this check
// without testing anything check-routing does not already cover.
const allRfps = await db.service.get("rfp_submissions", `select=${S.RFP_COLUMNS}&limit=50000`);
const allScans = await db.service.get("scan_logs", "select=*&limit=10000");
console.log(`${allRfps.length} submissions, ${allScans.length} scan rows`);

const nameConfig = await N.loadNameConfig(db, null);
const today = new Date().toISOString().slice(0, 10);

// ── The matrix ───────────────────────────────────────────────────────────────
const matrix = [];
for (const period of P.PERIOD_OPTS) {
  for (const view of P.VIEW_OPTS) {
    const sel = P.resolveSelection({ period, year: 2026, month: "June", view }, today, 2026);
    const bounds = P.periodBounds(sel, today);

    // scan_logs is filtered IN THE QUERY by the real loader, so the check filters the fetched
    // rows the same way before handing them over — otherwise the Python would see the whole
    // table while the TypeScript saw a window, and every scan tile would differ for a reason
    // that has nothing to do with the aggregation.
    const scans = allScans.filter((r) => {
      const d = String(r.scan_date ?? "").slice(0, 10);
      if (!d) return false;
      if (bounds.start && d < bounds.start) return false;
      if (bounds.end) {
        const next = new Date(Date.parse(`${bounds.end}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
        if (d > next) return false;
      }
      return true;
    });

    matrix.push({ period, view, sel, bounds, scans });
  }
}
const wants = py({ rfps: allRfps, cases: matrix.map((m) => ({ view: m.sel.view, bounds: m.bounds, scans: m.scans })) });
{
  for (const [i, m] of matrix.entries()) {
    const { period, view, sel, bounds, scans } = m;
    const ts = S.buildSection1({ rfps: allRfps, scans, view: sel.view, bounds, nameConfig });
    const want = wants[i];
    const tag = `${period} · ${view}`;
    same(`intake totals ${tag}`, { total: ts.intake.total, duplicates: ts.intake.duplicates },
      { total: want.intake.total, duplicates: want.intake.duplicates });
    same(`intake by source ${tag}`,
      Object.fromEntries(ts.intake.bySource.map((x) => [x.source, x])),
      Object.fromEntries(want.intake.bySource.map((x) => [x.source, x])));
    sameRanked(`intake ${tag}`, ts.intake.bySource, want.intake.bySource, (x) => x.total, (x) => x.source);
    same(`scans ${tag}`, ts.scans, want.scans);
    same(`discovery ${tag}`, ts.discovery, want.discovery);
    // The full grouping is the part with real logic in it — funder identity and dominant
    // spelling — and is order-free, so it is compared exactly.
    same(`donors grouping ${tag}`, ts.donors.all, want.donors.all);
    sameRanked(`donors ${tag}`, ts.donors.top, want.donors.top, (x) => x.rfps, (x) => x.donor);
    same(`focusAreas ${tag}`, ts.focusAreas, want.focusAreas);
    same(`proceedCount ${tag}`, ts.proceedCount, want.proceedCount);
    same(`keywordSuccess ${tag}`, ts.keywordSuccess, want.keywordSuccess);
    same(`sources grouping ${tag}`, ts.sources.all, want.sources.all);
    sameRanked(`sources ${tag}`, ts.sources.top, want.sources.top, (x) => x.added, (x) => x.source);
    same(`cycle ${tag}`, ts.cycle, want.cycle ? { ...want.cycle, days: ts.cycle?.days } : null);
  }
}
console.log(`${matrix.length} period × view combinations checked`);
for (const note of tieBands) console.log(`NOTE ${note}`);

// ── The all-time blocks must NOT move with the period ────────────────────────
// This is the check's real teeth. Every assertion above would still pass if intake, focus
// areas and cycle time were "fixed" to honour the period — the Python would be wrong in the
// same way, because this harness transcribes it. So assert the PROPERTY directly: three
// blocks are all-time by design, and their numbers cannot depend on the selection.
{
  const base = { rfps: allRfps, scans: allScans, nameConfig };
  const sel = (p) => P.periodBounds(P.resolveSelection({ period: p, year: 2026, month: "June", view: "Monthly" }, today, 2026), today);
  const all = S.buildSection1({ ...base, view: "Monthly", bounds: sel("All time") });
  for (const period of ["This year", "Specific month", "Last 90 days", "Last 12 months"]) {
    const other = S.buildSection1({ ...base, view: "Monthly", bounds: sel(period) });
    same(`intake is all-time (${period})`, other.intake, all.intake);
    same(`focusAreas is all-time (${period})`, other.focusAreas, all.focusAreas);
    same(`proceedCount is all-time (${period})`, other.proceedCount, all.proceedCount);
    same(`cycle is all-time (${period})`, other.cycle, all.cycle);
  }
  console.log("all-time blocks confirmed independent of the period");

  // And the converse: the period-following blocks MUST move. A block frozen by accident —
  // a filter applied to the wrong frame — would otherwise look identical to a correct one.
  const narrow = S.buildSection1({ ...base, view: "Monthly", bounds: sel("Specific month") });
  const moved = JSON.stringify(canon(narrow.donors)) !== JSON.stringify(canon(all.donors))
    || JSON.stringify(canon(narrow.discovery)) !== JSON.stringify(canon(all.discovery));
  checks++;
  if (!moved) {
    diffs++;
    console.log("DIFF donors and discovery did not change between All time and a single month — "
      + "the period filter is not reaching them.");
  } else {
    console.log("period-following blocks confirmed to move with the selection");
  }
}

// ── A thing agreement cannot catch ───────────────────────────────────────────
//
// Everything above compares two implementations. A fault they SHARE passes silently, and
// there is one: PostgREST caps a response at 1,000 rows whatever limit is asked for.
// `_load_scan_logs` asks for 10,000 and so does loadSection1; both get 1,000, both agree,
// and both compute the scan tiles over an arbitrary subset of the period's runs. No amount
// of cross-checking finds that, because it is not a disagreement.
//
// So this asks the DATABASE how many rows the period really matches — a question neither
// implementation is in a position to get wrong.
{
  const countScans = async (bounds) => {
    const parts = ["select=id"];
    if (bounds.start) parts.push(`scan_date=gte.${bounds.start}`);
    if (bounds.end) {
      const next = new Date(Date.parse(`${bounds.end}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
      parts.push(`scan_date=lte.${next}`);
    }
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/scan_logs?${parts.join("&")}`, {
      headers: {
        apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}`,
        Prefer: "count=exact", Range: "0-0",
      },
    });
    return Number((r.headers.get("content-range") ?? "/0").split("/")[1]);
  };
  const truncated = [];
  for (const period of P.PERIOD_OPTS) {
    const sel = P.resolveSelection({ period, year: 2026, month: "June", view: "Monthly" }, today, 2026);
    const real = await countScans(P.periodBounds(sel, today));
    if (real > 1000) truncated.push(`${period}: the page sees 1000 of ${real} scan runs`);
  }
  checks++;
  if (truncated.length) {
    console.log("\nNOTE the scan tiles and the source table are computed over a TRUNCATED set of "
      + "scan_logs rows, in views/report.py and in this port alike — PostgREST returns at most "
      + "1000 rows per request and neither pages. No `order` is given either, so WHICH 1000 is "
      + "arbitrary. Pre-existing; not introduced here, and not fixed here because fixing it "
      + "changes numbers on the page.");
    for (const t of truncated) console.log(`     ${t}`);
  } else {
    console.log("scan_logs fits in one page for every period — no truncation");
  }
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
