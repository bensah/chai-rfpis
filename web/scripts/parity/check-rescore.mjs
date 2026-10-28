// Parity check: the two paths that write a row's recommendation must agree.
//
//   node scripts/parity/check-rescore.mjs [rows-per-tenant]   (read-only, live database)
//
// `core.auto_scorer.auto_score` is what the scan runs and what every live screen recomputes.
// `scripts.rescore_existing._evaluate` is what a re-score runs over stored rows. They share
// their helpers but keep their post-rules in two hand-maintained sequences, and `_evaluate`
// promises in a comment that it matches. This measures whether it does.
//
// Why it is worth a check of its own: once scoring runs as a server-side job, the re-score
// path decides what a reader sees. A disagreement there is not a background detail — it is
// the number on the screen changing depending on which code last touched the row.
//
// TWO NUMBERS, and only the first is about code:
//   * DRIFT — the re-score re-deriving the criteria, as a fresh scan does. A difference here
//     means the two sequences disagree. This is what fails the check.
//   * STALENESS — the re-score keeping the stored criteria columns. A difference here means
//     those columns have aged against the current profile and donor data. Reported, never
//     failed: it is a fact about the data, and the cure is running the re-score.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python = process.env.RFPIS_PYTHON || (existsSync(venv) ? venv : "python");
const rows = process.argv[2] ?? "120";

const report = JSON.parse(execFileSync(python, [path.join(here, "rescore_py.py"), rows],
  { encoding: "utf8", maxBuffer: 1 << 28, cwd: root }));

// _evaluate only writes a score when it moves by at least this much, so anything smaller
// would never reach the database and is not a disagreement worth reporting.
const EPSILON = 0.05;

function compare(side) {
  const out = { checked: 0, rec: 0, score: 0, errors: 0, moves: new Map(), examples: [] };
  for (const [tenant, items] of Object.entries(report)) {
    for (const it of items) {
      const a = it.scan ?? {}, b = it[side] ?? {};
      if (a.error || b.error) {
        out.errors++;
        if (out.examples.length < 6) out.examples.push(`  ERROR ${tenant} ${it.uid}: scan=${a.error ?? "ok"} rescore=${b.error ?? "ok"}`);
        continue;
      }
      out.checked++;
      if (a.rec !== b.rec) {
        out.rec++;
        const key = `${a.rec ?? "none"} → ${b.rec ?? "none"}`;
        out.moves.set(key, (out.moves.get(key) ?? 0) + 1);
        if (out.examples.length < 6) out.examples.push(`  ${tenant} ${it.uid}: scan=${a.rec}/${a.score} rescore=${b.rec}/${b.score}`);
      }
      if (a.score !== null && b.score !== null && Math.abs(a.score - b.score) >= EPSILON) out.score++;
    }
  }
  return out;
}

function show(title, r) {
  console.log(`\n${title}`);
  console.log(`  ${r.checked} rows compared, recommendation differs on ${r.rec}, score differs on ${r.score}`);
  if (r.errors) console.log(`  ${r.errors} rows could not be scored by one side or the other`);
  if (r.moves.size) {
    console.log("  how the recommendation moves (scan → re-score):");
    for (const [k, n] of [...r.moves].sort((x, y) => y[1] - x[1])) console.log(`    ${String(n).padStart(5)}  ${k}`);
  }
  if (r.examples.length) console.log(r.examples.join("\n"));
}

const drift = compare("rescore");
const stale = compare("rescore_stored_criteria");

show("DRIFT — re-score re-deriving the criteria, as a fresh scan does:", drift);
show("STALENESS — re-score keeping the stored criteria columns (reported, not failed):", stale);

const bad = drift.rec + drift.score + drift.errors;
console.log(bad
  ? "\nThe two code paths disagree. This is the seam the scoring move makes authoritative."
  : "\nThe two code paths agree on every row.");
if (stale.rec || stale.score) {
  console.log(`Separately, ${stale.rec} rows would change recommendation and ${stale.score} would ` +
    "change score if re-scored from their stored criteria — those columns have aged.");
}
process.exit(bad ? 1 : 0);
