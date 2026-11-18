// Parity check for `pyRound` — Python's `round(x, n)` in TypeScript.
//
//   node scripts/parity/check-round.mjs     (from web/; no database, no writes)
//
// WHY A WHOLE CHECK FOR ROUNDING. Because the idiom it replaces was wrong on a live row
// and nobody could have guessed which row. `_score` on a featured opportunity came to
// 0.34*0.35 + 0.18*1.0 + 0.10*0.325 — the double 0.36749999999999999334, just BELOW the
// tie. Python answered 0.367. The TypeScript multiplied by 1000 first, that product
// rounded to exactly 367.5, and `Math.round` took the tie upward: 0.368. The information
// the decision turned on was destroyed by the multiplication, one line before the
// decision was made.
//
// That is two distinct bugs in one idiom, and only the second is the famous one:
//
//   1. the multiplication MOVES the value onto or across a tie;
//   2. Python rounds a tie to EVEN, JavaScript rounds it up.
//
// scorer.ts carried a comment arguing (2) was unreachable in its range. It was arguing
// about the wrong half.
//
// The case set is Python's and is deliberately NOT uniform noise: four million random
// doubles found no disagreement at all, because a random double never lands near a
// decimal tie. The generated half is built the way the real scores are — sums of
// hundredth weights over quarter-ish factors — and about one in twenty disagrees. The
// check asserts that too, so a case set that quietly stopped exercising the bug fails
// rather than passing vacuously.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const { pyRound } = await mod("supabase/functions/_shared/api/py_round.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");

let diffs = 0, checks = 0;
const fail = (msg) => { diffs++; console.log(`DIFF ${msg}`); };
const ok = (label, cond, detail = "") => {
  checks++;
  if (cond) return;
  fail(`${label}${detail ? `\n   ${detail}` : ""}`);
};

let want;
try {
  want = JSON.parse(execFileSync(python, [path.join(here, "round_py.py")], {
    input: "{}", encoding: "utf8", maxBuffer: 1 << 26, stdio: ["pipe", "pipe", "pipe"],
  }));
} catch (e) {
  console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
  process.exit(2);
}

// 1. Every case, against Python's own answer. Reported in full for the first few and
//    counted after that: a systematic break would otherwise print eight thousand lines.
let mismatches = 0;
for (const c of want.cases) {
  checks++;
  const got = pyRound(c.x, c.digits);
  if (got === c.want) continue;
  mismatches++;
  if (mismatches <= 10) {
    fail(`round(${c.x}, ${c.digits}): py=${c.want} ts=${got}`);
  } else {
    diffs++;
  }
}
if (mismatches > 10) console.log(`   …and ${mismatches - 10} more`);

// 2. The case set must still EXERCISE the bug. A set that agrees with the broken idiom
//    everywhere has stopped testing the thing this module exists for, and would pass
//    just as happily if pyRound were reverted to it.
{
  const jsScale = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
  const wrong = want.cases.filter((c) => jsScale(c.x, c.digits) !== c.want).length;
  ok("the case set still catches the idiom this replaced",
    wrong > 100 && wrong === want.old_idiom_wrong,
    `the old \`Math.round(x * 10**d) / 10**d\` is wrong on ${wrong} of ${want.cases.length} `
    + `cases here (Python counted ${want.old_idiom_wrong}). If this ever drops to zero, the `
    + "set has stopped exercising the bug and the check passes vacuously.");
}

// 3. The claims worth naming.
{
  ok("the live row that broke check-scoring rounds down",
    pyRound(0.3675, 3) === 0.367,
    "the double is 0.36749999999999999334 — below the tie. Scaling by 1000 lands on "
    + "exactly 367.5 and loses that, which is the entire bug.");

  ok("a genuine tie goes to EVEN, not up",
    pyRound(0.0625, 3) === 0.062 && pyRound(0.3125, 3) === 0.312
    && pyRound(2.5, 0) === 2 && pyRound(1.5, 0) === 2,
    "0.0625 IS exactly representable, so it is a real tie — and `Number(x.toFixed(3))` "
    + "alone would answer 0.063. Ties at three decimals are reachable because every "
    + "weight in the featured score is a hundredth.");

  ok("negatives round away from zero on a tie the same way",
    pyRound(-2.5, 0) === -2 && pyRound(-0.5, 0) === -0,
    "half to even is symmetric; -2.5 goes to -2, not -3.");

  ok("a non-finite value is returned untouched",
    Number.isNaN(pyRound(NaN, 3)) && pyRound(Infinity, 3) === Infinity);

  ok("an out-of-range digit count is refused rather than guessed at",
    (() => { try { pyRound(1, -1); return false; } catch { return true; } })()
    && (() => { try { pyRound(1, 1.5); return false; } catch { return true; } })(),
    "toFixed's own limits make a silent wrong answer possible past them; an error is the "
    + "only honest result.");
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
