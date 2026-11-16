// Parity check for criteria provenance — core/criteria_provenance.py::record.
//
//   node scripts/parity/check-provenance.mjs    (from web/; no database, no writes)
//
// Migration 102 added `rfp_submissions.criteria_provenance`, and since 2b6d42f the scorer
// HONOURS a criterion a person answered instead of re-deriving it. That makes this column
// load-bearing in a way a column recording "who did what" usually is not: an entry written
// where a person did not actually answer makes the scorer defer to the form's own default
// in that person's name, and a missing entry throws away an answer somebody typed.
//
// So the rule is subtractive and the refusals are the interesting part:
//
//   a value identical to the stored one     the save carries all nine, touched or not
//   a value landing in an EMPTY column      `_elig` falls to option 0 when nothing maps,
//                                           so any save writes a default into a blank
//   clearing a criterion                    drops the entry; nobody authors a blank
//
// and "Not sure" is NOT empty — it is a stored non-answer, so answering one counts.
//
// ONE ANSWER KEY. The cases and the expected results both come from the Python: it runs
// its own `record` over each shape and this side compares. A shared fixture with two
// hand-written answer keys is two things to keep in step, which is the problem a parity
// check exists to solve. Adding a case needs no edit here.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const P = await mod("supabase/functions/_shared/api/provenance.ts");
const S = await mod("supabase/functions/_shared/api/scorer.ts");

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
  want = JSON.parse(execFileSync(python, [path.join(here, "provenance_py.py")], {
    input: "{}", encoding: "utf8", maxBuffer: 1 << 26, stdio: ["pipe", "pipe", "pipe"],
  }));
} catch (e) {
  console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
  process.exit(2);
}

// 1. The two sides must agree on which columns are criteria and what the column is called.
same("the nine criteria", [...S.CRITERIA], want.criteria);
same("the column name", P.PROVENANCE_COLUMN, want.column);

// 2. `record`, over every shape the Python chose, against the Python's own answers.
for (const [i, c] of want.cases.entries()) {
  same(`record #${i} row=${J(c.row)} values=${J(c.values)}`,
    P.record(c.row, c.values, want.by, want.at), c.want);
}

// 3. The claims worth naming, so a future change has to argue with them rather than
//    quietly pass because every case happened to agree.
{
  const AT = want.at, BY = want.by;
  ok("a round-tripped value records nothing",
    P.record({ qualification: "Yes, fully" }, { qualification: "Yes, fully" }, BY, AT) === null,
    "an editor save carries all nine columns whether or not the person touched them, so "
    + "\"present in the payload\" means nothing.");

  ok("a default landing in an empty column records nothing",
    P.record({ capacity: null }, { capacity: "Yes, comfortably" }, BY, AT) === null,
    "`_elig` falls to option 0 when nothing maps, so a save of any OTHER field writes a "
    + "default into a blank criterion. The cost is a false negative, which is the safe "
    + "direction to be wrong in.");

  ok("answering a \"Not sure\" DOES record",
    P.record({ capacity: "Not sure" }, { capacity: "Yes, comfortably" }, BY, AT)
      ?.capacity?.by === BY,
    "\"Not sure\" is a stored non-answer, not an empty column.");

  ok("clearing a criterion drops its entry rather than recording one",
    !("capacity" in (P.record(
      { capacity: "Yes, comfortably", criteria_provenance: { capacity: { by: "o@x", at: AT } } },
      { capacity: "" }, BY, AT) ?? { capacity: 1 })));

  const kept = P.record(
    { qualification: "Yes, fully", capacity: "Yes, comfortably",
      criteria_provenance: { capacity: { by: "old@x.org", at: "2026-01-01T00:00:00+00:00" } } },
    { qualification: "Mostly, one item unclear" }, BY, AT);
  ok("an entry on another criterion survives somebody else's save",
    kept?.capacity?.by === "old@x.org" && kept?.qualification?.by === BY, J(kept));

  ok("nothing moved means null, not an unchanged object",
    P.record({ qualification: "Yes, fully" }, { next_action: "x" }, BY, AT) === null,
    "returning the column unchanged would rewrite it on every save and touch a row "
    + "nothing changed on.");

  ok("a non-criterion key is ignored",
    P.record({ qualification: "Yes, fully" }, { decision: "Proceed" }, BY, AT) === null);

  ok("a missing author is recorded as unknown rather than blank",
    P.record({ capacity: "Not sure" }, { capacity: "No, beyond us" }, "", AT)
      ?.capacity?.by === "unknown");
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
