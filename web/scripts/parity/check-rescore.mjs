// Is the score the server stores the same answer the screens would compute?
//
//   node scripts/parity/check-rescore.mjs [rows-per-tenant]   (read-only, live database)
//
// Scoring moved to the server on 2026-10-28: the browser stops computing a score and reads
// what the database holds. That changes which disagreement can hurt.
//
// WHAT THIS CHECKS, and why it is not the two things it looks like:
//
//   * NOT the job's path against the screens' path. The job calls `auto_scorer.auto_score`
//     and the screens call `assessment.assess_row`, which is a wrapper AROUND auto_score —
//     so comparing them compares a function with itself, green by construction and worth
//     nothing. (The job deliberately does not go through the wrapper: assess_row swallows a
//     scoring failure and returns the row's STORED score, which is right for a display and
//     would make this job stamp rows as freshly scored while computing nothing.)
//     `tests/test_rescore_job_matches_the_screens.py` pins that structurally, which is the
//     right shape for it and enough.
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
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python = process.env.RFPIS_PYTHON || (existsSync(venv) ? venv : "python");

const {
  rows: report, current_profile_sig: sigs, human_markers: markers,
  human_cases: HUMAN_CASES, human_answers: humanWant,
} = JSON.parse(
  execFileSync(python, [path.join(here, "rescore_py.py"), process.argv[2] ?? "120"],
    { encoding: "utf8", maxBuffer: 1 << 28, cwd: root }));

const W = await import(
  pathToFileURL(path.join(root, "supabase/functions/_shared/api/pipeline_writes.ts")).href);

// _evaluate only writes a score when it moves by at least this much, so anything smaller
// would never reach the database.
const EPSILON = 0.05;
const moved = (a, b) => a !== null && b !== null && Math.abs(a - b) >= EPSILON;

let failures = 0;
let pinFailures = 0;

// ── 0. The two apps must agree on what "a human assessed this" means ─────────
// Since dcea067 the re-score job DECLINES a row a person has assessed, and PATCH
// /pipelines/rfp answers the same question before the job does — it decides whether to
// tell the editor a recalculation is coming. Drift means the job quietly declining a row
// the API has just promised to recalculate: a number that never moves, with no message.
//
// BOTH HALVES ARE CHECKED, because the names alone are not the rule. The list is the
// columns the predicate READS and the rule over them is a conjunction, so a port could
// carry all three names and still answer differently — which is exactly what this port's
// first draft did (any-of, and `decision_overridden_by` is stamped by every save).
{
  const ts = [...W.ASSESSED_BY_A_HUMAN].sort();
  if (JSON.stringify(ts) !== JSON.stringify(markers)) {
    pinFailures++;
    console.log("DIFF the columns that decide whether a human assessed a row"
      + `
   ts: ${JSON.stringify(ts)}
   py: ${JSON.stringify(markers)}`);
  }
  // The answers, on the shapes that tell the three candidate rules apart. Compared against
  // the PYTHON's own predicate over the same rows rather than against a list written here.
  for (const [i, row] of HUMAN_CASES.entries()) {
    const got = W.humanAssessed(row);
    if (got !== humanWant[i]) {
      pinFailures++;
      console.log(`DIFF humanAssessed(${JSON.stringify(row)}) = ${got}, python says ${humanWant[i]}`);
    }
  }
  if (!pinFailures) {
    console.log(`human-assessment rule agrees: ${ts.join(", ")}, over ${HUMAN_CASES.length} row shapes`);
  }
}

// ── 1. The stored score, against what the screens would compute ──────────────
//
// THE VERDICT IS PYTHON'S NOW. This used to re-derive it here — null-check the stamp,
// compare the signature, else call the row current — which is a second definition of what
// a stamp means, and it drifted exactly as a second definition does: `rescore_py` passed
// a null signature for weeks (it imported a `profile_signature` that did not exist and
// swallowed the ImportError), `if (sig && ...)` therefore never fired, and every stamped
// row was reported as current. The check could not distinguish a stale score from a wrong
// one and said nothing about it.
//
// `core.score_stamp.stamp_state` is the single definition and `stored.state` is its
// answer. Two of its five words were unavailable to the old derivation at any price:
// `deferred` (unstamped because a human assessed the row, so the re-score job will NEVER
// re-stamp it) and `unknown` (stamped, but the signature could not be read — the absence
// of evidence, not evidence of currency).
const seen = { current: 0, stale: 0, unverified: 0, deferred: 0, unknown: 0 };
let untagged = 0, wrong = 0, missing = 0;
const wrongRows = [];
for (const [tenant, items] of Object.entries(report)) {
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
    const state = s.state ?? "unknown";
    if (state in seen) seen[state]++;
    // ONLY `current` IS ASSERTED. A row that claims to be scored under the signature in
    // force, and then disagrees with a fresh computation, is the one fault server-owned
    // scoring introduces — nothing recomputes at read time to cover it. Stale, unverified
    // and deferred rows make no such claim, so there is nothing to contradict.
    if (state !== "current") continue;
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
  console.log(`  ${seen.current} current (claim to be scored under the signature in force)`);
  console.log(`  ${seen.stale} stale — a re-score fixes these`);
  console.log(`  ${seen.unverified} unverified — the job has not reached them yet`);
  console.log(`  ${seen.deferred} deferred — a human assessed them, so the job will NEVER re-stamp ` +
    "them; they are permanently outside what this section asserts");
  if (seen.unknown) {
    console.log(`  ${seen.unknown} UNKNOWN — stamped, but the current signature could not be read. ` +
      "That is this harness failing, not a fact about the rows: see rescore_py's import of " +
      "core.live_scoring.profile_signature.");
  }
  console.log(`  ${missing} have never been scored`);
  if (seen.current === 0 && (seen.unverified || seen.deferred)) {
    console.log("  nothing to verify yet: no stored score CLAIMS to be current, so there is " +
      "nothing this section can contradict. It starts reporting the moment the rescore job " +
      "stamps its first row.");
  }
  console.log(`  current-but-wrong: ${wrong}`);
  if (wrongRows.length) console.log(wrongRows.join("\n"));
  failures += wrong;
  // An `unknown` row means the check silently lost its ability to classify. That is the
  // defect this section was blind to for weeks, so it fails rather than reports.
  failures += seen.unknown;
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

// TWO FAILURE KINDS, COUNTED AND WORDED APART. They shared one counter and one sentence,
// so a drifted predicate printed "1 stored scores claim to be current and are not" — a
// true number attached to the wrong claim, which is the sort of thing this check exists to
// stop the APP doing. Caught by the session that wrote the Python half.
console.log(failures
  ? `\n${failures} stored scores claim to be current and are not.`
  : "\nNo stored score claims to be current while disagreeing with a fresh computation.");
if (pinFailures) {
  console.log(`${pinFailures} disagreement${pinFailures === 1 ? "" : "s"} with `
    + "core/score_stamp.py about what counts as a human assessment.");
}
process.exit(failures || pinFailures ? 1 : 0);
