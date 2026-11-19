// Parity check for the Manual Scan history panel — admin.py's `_run_summary`.
//
//   node scripts/parity/check-scan-history.mjs    (from web/; no database, no writes)
//
// WHY A WHOLE CHECK FOR A SUMMARY PANEL. Because `scan_logs` is not a log of runs, it is
// a log of SOURCES within runs — one row per source per run — so every figure here is a
// sum over a group, and choosing the group wrongly produces a number that is merely too
// big. A too-big "found" on a scan panel does not look like a bug. It looks like a good
// scan.
//
// Three rules carry it:
//
//   1. GROUP BY run_id, which every row of one run has shared since migration 065.
//   2. THE LEGACY FALLBACK STOPS at the first row that HAS a run_id. Rows written before
//      065 are grouped by a fifteen-minute window and a matching trigger, and without
//      that stop a legacy tail merges into a modern run and inflates it.
//   3. `added` IS NULL WHEN NO ROW RECORDED ONE. rfps_added arrived in migration 094, and
//      an extract-only crawl inserts nothing into any pipeline, so a run can legitimately
//      have no count at all. Summing absent values as zero would report "added 0" — a
//      different statement from "added nothing", and the one the panel must not make.
//
// The Python half lifts both functions out of admin.py's tab body, where they are nested
// among Streamlit widgets, and runs them over the same fixtures.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const H = await mod("supabase/functions/_shared/api/scan_history.ts");
const A = await mod("supabase/functions/_shared/api/analytics.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");

let diffs = 0, checks = 0;
const J = (v) => JSON.stringify(v);
const same = (label, ts, pyv) => {
  checks++;
  if (J(ts) === J(pyv)) return;
  diffs++;
  console.log(`DIFF ${label}\n   ts: ${J(ts)}\n   py: ${J(pyv)}`);
};
const ok = (label, cond, detail = "") => {
  checks++;
  if (cond) return;
  diffs++;
  console.log(`DIFF ${label}${detail ? `\n   ${detail}` : ""}`);
};

let want;
try {
  want = JSON.parse(execFileSync(python, [path.join(here, "scan_history_py.py")], {
    input: "{}", encoding: "utf8", maxBuffer: 1 << 26, stdio: ["pipe", "pipe", "pipe"],
  }));
} catch (e) {
  console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
  process.exit(2);
}

// 1. Every run shape, against the Python's own answer. `sources` is this side's own
//    addition — the group size, which the panel shows and the Python does not return —
//    so it is compared separately rather than smuggled into the object comparison.
for (const [i, c] of want.runs.entries()) {
  const got = H.runSummary(c.rows);
  if (got === null || c.want === null) {
    same(`run #${i} (${c.rows.length} rows)`, got, c.want);
    continue;
  }
  const { sources, ...rest } = got;
  same(`run #${i} (${c.rows.length} rows)`, rest, c.want);
  ok(`run #${i} counts its own group`, typeof sources === "number" && sources >= 1);
}

// 2. The trigger prefixes.
for (const [i, c] of want.triggers.entries()) {
  same(`trigger #${i} ${J(c.raw)}`, H.prettyTrigger(c.raw), c.want);
}

// 3. The claims no fixture states on its own.
{
  ok("an empty history is null, not a row of zeroes",
    H.runSummary([]) === null,
    "zeroes would read as a scan that found nothing, which is a claim about a run that "
    + "never happened.");

  ok("`added` is null when no row in the group recorded one",
    H.runSummary([{ scan_date: "2026-11-17T10:00:00", run_id: "r", rfps_found: 5 }])
      .added === null,
    "rfps_added arrived in migration 094, and an extract-only crawl inserts nothing into "
    + "any pipeline. \"added 0\" is a different statement from \"did not count\".");

  ok("...and 0 when a row recorded exactly zero",
    H.runSummary([{ scan_date: "2026-11-17T10:00:00", run_id: "r", rfps_added: 0 }])
      .added === 0,
    "the distinction is the whole point: this run counted, and the count was nothing.");

  ok("a legacy tail is not merged into a run that has a run_id",
    H.runSummary([
      { scan_date: "2026-11-17T10:00:00", rfps_found: 5 },
      { scan_date: "2026-11-17T09:59:00", run_id: "r9", rfps_found: 500 },
    ]).found === 5,
    "without the stop, the panel adds a modern run's totals to a legacy row's and "
    + "reports a scan that found 505 — which looks like a very good scan.");

  ok("an unreadable timestamp ends the legacy group rather than extending it",
    H.runSummary([
      { scan_date: "2026-11-17T10:00:00", rfps_found: 5 },
      { scan_date: "not a date", rfps_found: 500 },
    ]).found === 5,
    "a gap that cannot be computed is treated as too large. The alternative — treating "
    + "it as zero — would merge everything after a single bad row.");

  const label = A.MATCH_RUN_LABEL;
  const split = H.splitHistory([
    { source: label, scan_date: "a" }, { source: "Gates Foundation", scan_date: "b" },
    { source: label, scan_date: "c" },
  ], label);
  ok("screening runs are kept apart from crawls",
    split.screening.length === 2 && split.extraction.length === 1,
    "they answer different questions — what this organisation's last screen found, and "
    + "when the shared store was last refreshed — and one list reports one as the other.");
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
