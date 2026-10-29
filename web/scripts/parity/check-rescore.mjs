// Is the score the server stores the same answer the screens would compute?
//
//   node scripts/parity/check-rescore.mjs [rows-per-tenant]   (read-only, live database)
//
// Scoring moved to the server on 2026-10-28: the browser stops computing a score and reads
// what the database holds. That changes which disagreement can hurt.
//
// WHAT THIS CHECKS, and why it is not the two things it looks like:
//
//   * NOT the job's path against the screens' path. Both now call `core.assessment.assess_row`,
//     so comparing them compares a function with itself — green by construction and worth
//     nothing. `tests/test_rescore_job_matches_the_screens.py` pins that structurally, which
//     is the right shape for it and enough.
//
//   * NOT "has the job run lately". A stored score older than the current profile is stale,
//     not wrong, and the cure is running the job.
//
//   The fault worth failing on is a stored score that CLAIMS to be current — tagged with the
//   profile signature in force — and still disagrees with a fresh computation. That is the
//   failure mode server-owned scoring introduces, because nothing recomputes at read time to
//   cover it. It needs migration 101's `scored_at` / `score_profile_sig`; until those exist
//   the section reports that it cannot run rather than passing silently.
//
// It also REPORTS, without failing, the standing difference between `auto_scorer.auto_score`
// and `scripts/rescore_existing._evaluate` — the CLI re-score derives its criteria without
// `_apply_criteria_keywords`, so it reaches a different answer from the same row. Nothing the
// server writes goes through it any more. It is left visible rather than failing, because a
// check that is always red stops being read, which is the same disease as one that is green
// and lying.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python = process.env.RFPIS_PYTHON || (existsSync(venv) ? venv : "python");

const { rows: report, current_profile_sig: sigs } = JSON.parse(
  execFileSync(python, [path.join(here, "rescore_py.py"), process.argv[2] ?? "120"],
    { encoding: "utf8", maxBuffer: 1 << 28, cwd: root }));

// _evaluate only writes a score when it moves by at least this much, so anything smaller
// would never reach the database.
const EPSILON = 0.05;
const moved = (a, b) => a !== null && b !== null && Math.abs(a - b) >= EPSILON;

let failures = 0;

// ── 1. The stored score, against what the screens would compute ──────────────
let current = 0, stale = 0, untagged = 0, unstamped = 0, wrong = 0, missing = 0;
const wrongRows = [];
for (const [tenant, items] of Object.entries(report)) {
  const sig = sigs[tenant];
  for (const it of items) {
    const s = it.stored ?? {}, fresh = it.scan ?? {};
    if (fresh.error) continue;
    if (s.score === null && s.rec === null) {
      missing++;
      continue;
    }
    if (s.has_stamp === false) {
      // The COLUMN is not there: migration 101 is unapplied and this section has nothing
      // to read.
      untagged++;
      continue;
    }
    if (s.profile_sig === undefined || s.profile_sig === null) {
      // The column is there and empty: the job has not reached this row. That is UNVERIFIED,
      // not stale and not wrong — the row predates server-owned scoring, and calling it
      // stale would report every row as a problem the morning 101 lands.
      unstamped++;
      continue;
    }
    if (sig && s.profile_sig !== sig) {
      stale++;
      continue;
    }
    current++;
    if (s.rec !== fresh.rec || moved(s.score, fresh.score)) {
      wrong++;
      if (wrongRows.length < 8) {
        wrongRows.push(`  ${tenant} ${it.uid}: stored=${s.rec}/${s.score} fresh=${fresh.rec}/${fresh.score}`);
      }
    }
  }
}
console.log("Stored score against what the screens would compute");
if (untagged) {
  console.log(`  cannot run yet: ${untagged} rows have no score_profile_sig COLUMN — migration 101 ` +
    "is not applied, so there is no way to tell a current score from a stale one.");
} else {
  console.log(`  ${current} rows claim to be current, ${stale} are stale (the job has not caught up), ` +
    `${unstamped} are unverified (never stamped: the job has not run on them), ` +
    `${missing} have never been scored`);
  if (current === 0 && unstamped) {
    console.log("  nothing to verify yet: migration 101 is applied but no row has been stamped, " +
      "so no stored score YET CLAIMS to be current. This section starts reporting the moment " +
      "the rescore job writes its first row.");
  }
  console.log(`  current-but-wrong: ${wrong}`);
  if (wrongRows.length) console.log(wrongRows.join("\n"));
  failures += wrong;
}

// ── 2. The CLI re-score, reported only ───────────────────────────────────────
let cliRec = 0, cliScore = 0, compared = 0;
const moves = new Map();
for (const items of Object.values(report)) {
  for (const it of items) {
    const a = it.scan ?? {}, b = it.rescore ?? {};
    if (a.error || b.error) continue;
    compared++;
    if (a.rec !== b.rec) {
      cliRec++;
      const k = `${a.rec ?? "none"} → ${b.rec ?? "none"}`;
      moves.set(k, (moves.get(k) ?? 0) + 1);
    }
    if (moved(a.score, b.score)) cliScore++;
  }
}
console.log("\nStanding finding — scripts/rescore_existing._evaluate against auto_score (reported, not failed)");
console.log(`  ${compared} rows compared: recommendation differs on ${cliRec}, score on ${cliScore}`);
if (moves.size) {
  for (const [k, n] of [...moves].sort((x, y) => y[1] - x[1])) console.log(`    ${String(n).padStart(5)}  ${k}`);
}
console.log("  Cause: _evaluate derives criteria without auto_score's _apply_criteria_keywords pass.");
console.log("  Nothing the server writes uses this path; the CLI re-score still does.");

console.log(failures
  ? `\n${failures} stored scores claim to be current and are not.`
  : "\nNo stored score claims to be current while disagreeing with a fresh computation.");
process.exit(failures ? 1 : 0);
