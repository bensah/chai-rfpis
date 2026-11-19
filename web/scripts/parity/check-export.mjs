// Parity check for the Report's data export — the six-sheet workbook.
//
//   node scripts/parity/check-export.mjs    (from web/; reads the live database, read-only)
//
// The export is the one piece of this port where the Python did not move: the workbook is
// still built by openpyxl, in `scripts/report_export_job.py`, run as a background job. What
// moved is WHO CALLS IT — a Streamlit download button became an API route and a job — and
// the risk that comes with that is not arithmetic, it is a TRANSCRIPTION.
//
// `views/report.py` cannot be imported (it renders a page on import), so the job holds its
// own copy of the five queries the page loads its frames with. A copy that is merely
// reviewed agrees with the original until the original changes. So this check lifts those
// five functions out of the source with `ast`, strips the `@st.cache_data` decorator, runs
// them against the same live database as the job's copies, and compares the frames.
//
// It also covers the two things that DID move into TypeScript: the filename rule, and the
// decision about whose scan runs go in the file.
//
// NOTHING HERE BUILDS A WORKBOOK OR TOUCHES THE STORAGE BUCKET. The sheets are a function
// of the frames; the frames are what can silently drift.
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
const E = await mod("supabase/functions/_shared/api/report_export.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");
const py = (payload) => {
  try {
    return JSON.parse(execFileSync(python, [path.join(here, "export_py.py")], {
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
const same = (label, a, b) => {
  checks++;
  if (J(a) === J(b)) return;
  diffs++;
  console.log(`DIFF ${label}\n   page: ${J(a)}\n   job:  ${J(b)}`);
};
const ok = (label, cond, detail = "") => {
  checks++;
  if (cond) return;
  diffs++;
  console.log(`DIFF ${label}${detail ? `\n   ${detail}` : ""}`);
};

// ── The filename, TS against report.py's own `_slug` ─────────────────────────
//
// Every part of the name is there because the old one was the same string for every tenant
// and every period: two downloads collided in the browser's folder, and a file on disk
// could not be traced back to the report that produced it.
const SLUGS = [
  { text: "CHAI Cameroon", limit: 28 },
  { text: "Clinton Health Access Initiative, Inc.", limit: 28 },
  { text: "", limit: 28 },
  { text: "   ", limit: 28 },
  { text: "---", limit: 28 },
  { text: "20261115-000042", limit: 20 },
  // A cut that lands ON a dash — the trim has to run again after the slice, or the name
  // carries a dangling separator.
  { text: "Organisation-Of-A-Very-Long-Name", limit: 13 },
  { text: "Française (Santé)", limit: 28 },
  { text: "日本", limit: 28 },
  { text: null, limit: 28 },
  { text: 2026, limit: 28 },
];

const env = requireEnv(root, "check-export");
const db = D.createDb({
  supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY,
  jwtSecret: env.SUPABASE_JWT_SECRET ?? "",
});

// The tenant with the most rows, so the frames under test are not empty ones agreeing.
const counts = {};
for (const r of await db.service.getAll("rfp_submissions", "select=uid,tenant_id", "uid")) {
  const t = r.tenant_id ?? "";
  if (t) counts[t] = (counts[t] ?? 0) + 1;
}
const tenantId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
if (!tenantId) {
  console.log("No tenanted rfp_submissions rows — nothing to compare.");
  process.exit(0);
}
console.log(`tenant ${tenantId}, ${counts[tenantId]} calls`);

const today = new Date().toISOString().slice(0, 10);
// Every period the picker offers. The bounds are what actually reach the queries, and the
// two bound SPELLINGS — scan_logs' +1 day against the date columns' bare lte — are the
// detail a transcription loses.
const windows = P.PERIOD_OPTS.map((period) => {
  const sel = P.resolveSelection({ period, year: 2026, month: "June", view: "Monthly" }, today, 2026);
  const b = P.periodBounds(sel, today);
  return { label: period, start: b.start, end: b.end, sel };
});

const want = py({ tenantId, windows: windows.map((w) => ({ label: w.label, start: w.start, end: w.end })), slugs: SLUGS });

for (const [i, c] of SLUGS.entries()) {
  same(`_slug(${J(c.text)}, ${c.limit})`, E.slugToken(c.text, c.limit), want.slug[i]);
}

// The whole filename. `periodSlug` is already checked by check-report.mjs; what is new here
// is the assembly — and that an unsaved report says so rather than leaving a gap.
{
  const sel = P.resolveSelection({ period: "Specific month", year: 2026, month: "June", view: "Monthly" }, today, 2026);
  ok("the filename carries period, org, report id and year",
    E.exportFilename(sel, "CHAI Cameroon", "20261115-000042", "xlsx")
    === "RFPIS_jun2026_report_CHAI-Cameroon_20261115-000042_2026.xlsx",
    E.exportFilename(sel, "CHAI Cameroon", "20261115-000042", "xlsx"));
  ok("a report with no saved link is named `unsaved`, not left blank",
    E.exportFilename(sel, "CHAI Cameroon", null, "xlsx").includes("_unsaved_"));
  ok("two periods of one org cannot produce the same filename",
    E.exportFilename(P.resolveSelection({ period: "All time" }, today, 2026), "CHAI", null, "xlsx")
    !== E.exportFilename(P.resolveSelection({ period: "Last 90 days" }, today, 2026), "CHAI", null, "xlsx"));
}

// ── The five frames, per period ──────────────────────────────────────────────
for (const [i, w] of windows.entries()) {
  const e = want.windows[i];
  for (const key of ["scans", "rfps", "meetings", "engagements", "grants", "rfpsPeriod"]) {
    same(`${key} (${w.label})`, e.page[key], e.job[key]);
  }
}

// ── Whose scan runs go in the file ───────────────────────────────────────────
//
// The one decision the port moved into TypeScript. `_load_scan_logs` drops the untenanted
// discovery crawl for an ordinary member of a tenant and keeps it for a super_user; getting
// that backwards puts another organisation's runs into a file with a download link on it.
{
  const e = want.windows.find((x) => x.label === "All time");
  ok("a member sees no more than a super_user", e.wideExtra >= 0,
    `unfiltered=${e.wideScans.rows} member=${e.job.scans.rows}`);
  // The decomposition is the assertion, and it is what corrected this check's own first
  // version: "unfiltered" is NOT "plus the shared crawl". Measured here, the extra rows are
  // the untenanted crawl AND other tenants' runs, with nothing left over — which is right
  // for a super_user and would be a leak for anyone else, so the flag's two possible values
  // are pinned rather than described.
  ok("the extra rows are exactly the untenanted crawl plus other tenants' runs",
    e.wideExtra === e.untenanted + e.otherTenants,
    `${e.wideExtra} extra = ${e.untenanted} untenanted + ${e.otherTenants} other tenants'`
    + ` (remainder ${e.wideExtra - e.untenanted - e.otherTenants}). A remainder means the member`
    + ` filter is dropping rows that DO belong to this tenant.`);
  ok("and a member's own set contains no other tenant's runs",
    e.job.scans.rows === e.wideScans.rows - e.untenanted - e.otherTenants,
    `member=${e.job.scans.rows}, unfiltered=${e.wideScans.rows}, untenanted=${e.untenanted},`
    + ` other=${e.otherTenants}`);
}

// ── _safe_for_excel ──────────────────────────────────────────────────────────
//
// Driven over a frame built to carry every case it exists for: a tz-aware column (pandas
// refuses to write one), ±inf (openpyxl raises), a Postgres array, a dict, and non-ASCII
// text. Live rows exercise the first and third; nothing in the database produces an inf,
// so without a hand-built frame that branch is never run by either half.
same("_safe_for_excel: frame", want.safe.page, want.safe.job);
same("_safe_for_excel: every cell", want.safe.pageCells, want.safe.jobCells);
ok("inf becomes empty, not the string 'inf'",
  !want.safe.jobCells.some((c) => c === "inf" || c === "-inf"), J(want.safe.jobCells));
ok("an array column becomes JSON, not a Python repr",
  want.safe.jobCells.some((c) => c === '["a", "b"]'), J(want.safe.jobCells));

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
