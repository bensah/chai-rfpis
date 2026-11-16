// Parity check for Submit New Notice — views/submit_form.py.
//
//   node scripts/parity/check-submit.mjs    (from web/; reads the live database, read-only)
//
// THE REASON THIS ONE MATTERS MORE THAN ITS SIZE SUGGESTS. Every other React screen reads
// rows the Python wrote. This one WRITES, and it writes the row every later stage is about,
// with a score it computes itself — the only place in this app where a number the Python
// owns is produced in TypeScript. Three things therefore have to agree exactly:
//
//   generate_uid           the identifier, which deep links and tombstones are keyed on
//   score_submission       alignment_score + auto_recommendation, written at insert
//   needs_submission_check whether the page warns about a deadline already gone
//
// And two SHAPES, which are not rules but are the cheapest way to catch the bug neither
// side's types can see: a column name. `buildRow` writes twenty-nine keys into
// rfp_submissions and `poolRecord` twenty into extracted_solicitations; a key that is not
// a column fails the insert at the first real submission and nowhere earlier. Both lists
// are read from the live tables.
//
// Plus the job kinds, which live in two files in two languages. A kind the API queues and
// the runner does not know leaves the row `queued` for ever with nothing to say why — and
// this check exists because adding `submit_followup` meant editing both.
//
// SCORING IS CHECKED OVER GENERATED COMBINATIONS, not over live rows. Live rows carry the
// vocabulary the scan writes, which is a fraction of what `_SCORE_MAP` recognises and none
// of what a human picks from the form; the interesting cases — "Not sure", a criterion
// left out entirely, a legacy "Partial", free text nobody's dropdown offered — appear in
// none of them.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const S = await mod("supabase/functions/_shared/api/submit.ts");
const SC = await mod("supabase/functions/_shared/api/scorer.ts");
const V = await mod("supabase/functions/_shared/api/form_vocab.ts");
const J = await mod("supabase/functions/_shared/api/routes_jobs.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");
const py = (payload) => {
  try {
    return JSON.parse(execFileSync(python, [path.join(here, "submit_py.py")], {
      input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 1 << 28,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (e) {
    console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
    process.exit(2);
  }
};

let diffs = 0, checks = 0;
const j = (v) => JSON.stringify(v);
const same = (label, ts, pyv) => {
  checks++;
  if (j(ts) === j(pyv)) return;
  diffs++;
  console.log(`DIFF ${label}\n   ts: ${j(ts)}\n   py: ${j(pyv)}`);
};
const ok = (label, cond, detail = "") => {
  checks++;
  if (cond) return;
  diffs++;
  console.log(`DIFF ${label}${detail ? `\n   ${detail}` : ""}`);
};

// ── UIDs ─────────────────────────────────────────────────────────────────────
// Two names, one name, no name, punctuation, a non-Latin script, and a midnight edge.
const NAMES = [
  "Bernard Nsah", "Emilienne Bieme-Ndi", "Shariffa", "", "   ",
  "  Tata   Pepson  ", "Jean-Pierre O'Brien", "Åsa Öberg", "Михаил Петров",
  "a", "X Y Z",
];
const WHEN = ["2026-02-02T12:20:00", "2026-01-01T00:00:00", "2026-12-31T23:59:00"];
const UID_CASES = NAMES.flatMap((name) => WHEN.map((at) => ({ name, at })));

// ── Scores ───────────────────────────────────────────────────────────────────
// Every answer the FORM can send, plus the spellings live rows carry, plus two things no
// dropdown offers: a criterion omitted entirely, and free text.
const EXTRA = ["Yes", "Partial", "No", "True", "False", "", "wat", null];
const pool = (k) => [...(V.CRITERION_ANSWERS[k] ?? []), ...EXTRA];

const CRIT = SC.CRITERIA;
const SCORE_CASES = [];
// One case per answer per criterion, with the others held on their own first option, so a
// single wrong weight or a mis-scored label shows up as its own line rather than being
// averaged into a sweep.
for (const k of CRIT) {
  for (const a of pool(k)) {
    const values = Object.fromEntries(CRIT.map((c) => [c, (V.CRITERION_ANSWERS[c] ?? [])[0]]));
    if (a === null) delete values[k]; else values[k] = a;
    SCORE_CASES.push({ values, decline: false });
  }
}
// Then combinations, so the weighted sum is exercised rather than one term at a time. A
// fixed sequence, not Math.random: a check that fails only sometimes is a check nobody
// can act on.
let seed = 20261116;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
for (let i = 0; i < 240; i++) {
  const values = {};
  for (const c of CRIT) {
    const opts = pool(c);
    const a = opts[rnd(opts.length)];
    if (a !== null) values[c] = a;
  }
  SCORE_CASES.push({ values, decline: i % 7 === 0 });
}
// And the two ends: everything unanswered, and everything at its best.
SCORE_CASES.push({ values: {}, decline: false });
SCORE_CASES.push({ values: {}, decline: true });
SCORE_CASES.push({
  values: Object.fromEntries(CRIT.map((c) => [c, (V.CRITERION_ANSWERS[c] ?? [])[0]])),
  decline: false,
});

// ── Backdated intake ─────────────────────────────────────────────────────────
// `needs_submission_check` also asks whether the row is COMPLETED, which a row this route
// has just created never is. These cases are shaped like one.
const TODAY = "2026-11-16";
const ROW_CASES = [
  { call_submission_deadline: "2026-11-15" },
  { call_submission_deadline: "2026-11-16" },
  { call_submission_deadline: "2026-11-17" },
  { call_submission_deadline: null },
  { call_submission_deadline: "2020-01-01" },
  {},
];

const want = py({
  uids: UID_CASES,
  scores: SCORE_CASES,
  rows: ROW_CASES,
});

// 1. UIDs
for (const [i, c] of UID_CASES.entries()) {
  // The Python stamps `datetime.now()` — wall-clock where the process runs. The port is
  // given the same instant as UTC with a zero offset, which is the same arithmetic.
  const ts = S.generateUid(c.name, new Date(`${c.at}Z`), 0);
  same(`generate_uid(${j(c.name)}, ${c.at})`, ts, want.uids[i]);
}
ok("a name with no letters still yields an identifier",
  S.generateUid("   ", new Date("2026-02-02T12:20:00Z"), 0) === "XX-260202-1220");

// The offset is the port's own addition — the Python has no equivalent, because its clock
// already runs in the submitter's zone. What is asserted is that it moves the stamp and
// nothing else, and that a hostile value cannot move it far.
{
  const at = new Date("2026-11-16T23:30:00Z");
  ok("the submitter's zone decides the UID's date",
    S.generateUid("Bernard Nsah", at, 60) === "BN-261117-0030",
    S.generateUid("Bernard Nsah", at, 60));
  ok("an absurd offset is clamped rather than believed",
    S.generateUid("Bernard Nsah", at, 99999) === S.generateUid("Bernard Nsah", at, 840),
    "a client claiming +1666 hours must not mint a UID in another year.");
  ok("a missing offset is UTC", S.generateUid("Bernard Nsah", at) === "BN-261116-2330");
}

// 2. Scores
for (const [i, c] of SCORE_CASES.entries()) {
  const got = SC.scoreSubmission(c.values, c.decline);
  same(`score_submission #${i} ${j(c.values)} decline=${c.decline}`,
    [got.score, got.recommendation], want.scores[i]);
}
ok("an unanswered form scores the Park midpoint, not zero",
  SC.alignmentScore({}) === 50,
  `got ${SC.alignmentScore({})} — "Not sure" is rated 0.5, so nine of them is 50.`);
ok("a decline flag beats any score",
  SC.scoreSubmission({}, true).recommendation === "Decline");
ok("the bands are 90/70, not 70/45",
  V.SCORING_THRESHOLDS.proceed === 90 && V.SCORING_THRESHOLDS.park === 70,
  "the same score banded two ways depending on how the row entered the app — see "
  + "config/scoring_weights.yaml's own comment.");

// 3. Backdated intake
for (const [i, r] of ROW_CASES.entries()) {
  same(`needs_submission_check ${j(r)}`,
    S.needsSubmissionCheck(r.call_submission_deadline ?? null, TODAY), want.checks[i]);
}

// 4. Column shapes — the keys the route writes must all be columns that exist.
{
  const row = S.buildRow({
    title: "A call", funder: "BMGF – Gates Foundation", leadApplicant: "CHAI",
    decision: "Proceed", proposalLead: "Bernard Nsah", link: "https://example.org/call",
    geo: ["Cameroon"], programAreas: ["Immunization"], criteria: {},
    deadline: "2026-12-01", value: "250000", currency: "USD", duration: "24",
  }, {
    uid: "BN-261116-0900", submitter: "Bernard Nsah", email: "b@example.org",
    nowIso: "2026-11-16T09:00:00.000Z", reviewWeek: "Week 47 (16 Nov - 22 Nov)",
  });
  if (!want.rfp_columns.length) {
    console.log("SKIP rfp_submissions columns — the table answered no rows");
  } else {
    const strays = Object.keys(row).filter((k) => !want.rfp_columns.includes(k));
    ok("every column buildRow writes exists on rfp_submissions", strays.length === 0,
      `not columns: ${j(strays)}`);
  }
  const pool = S.poolRecord(row);
  ok("a call with a link is shared to the pool", pool !== null);
  if (!want.pool_columns.length) {
    console.log("SKIP extracted_solicitations columns — the table answered no rows");
  } else {
    const strays = Object.keys(pool ?? {}).filter((k) => !want.pool_columns.includes(k));
    ok("every column poolRecord writes exists on extracted_solicitations", strays.length === 0,
      `not columns: ${j(strays)}`);
  }
  ok("a call with no link is not shared", S.poolRecord({ ...row, opportunity_link: null }) === null,
    "the pool's uid is made FROM the url; a record without one is refused there anyway.");
  ok("the score is on the row, not left for the job", typeof row.alignment_score === "number");
  ok("the submitter's answer is what decline_flags_present stores",
    row.decline_flags_present === false,
    "core/scorer.decline_flags would derive it from the criteria; this form asks.");
}

// 5. Validation, against views/submit_form.py 310-324.
{
  const full = {
    title: "A call", funder: "BMGF", leadApplicant: "CHAI", decision: "Decline",
  };
  same("a complete Decline needs no proposal lead", S.validate(full), []);
  same("every missing field is reported at once", S.validate({}), [
    "Opportunity title is required.",
    "Funder is required.",
    "Lead applicant is required.",
    "Decision is required.",
  ]);
  same("Proceed also needs a proposal lead",
    S.validate({ ...full, decision: "Proceed" }),
    ["Proposal lead is required for a Proceed / Park decision."]);
  same("Park does too", S.validate({ ...full, decision: "Park" }),
    ["Proposal lead is required for a Proceed / Park decision."]);
  ok("the NONE sentinel is not an answer",
    S.validate({ ...full, funder: "—" }).includes("Funder is required."),
    "the first entry of every single-select is '—', and picking it means unset.");
  ok("Decline hides the team section", !S.showsTeam("Decline"));
  ok("a legacy 'Proceed as sub' still counts as Proceed", S.showsTeam("Proceed as sub"),
    "migration 019 dropped the option; rows written before it still carry the value.");
}

// 6. Criterion defaults — an omitted key must behave like an untouched dropdown.
{
  const v = S.criteriaValues({});
  same("an untouched form sends Not sure, not blank",
    CRIT.filter((c) => v[c] !== "Not sure"), ["bid_effort"]);
  // THE CLAIM THIS CHECK GOT WRONG FIRST TIME, and the finding is worth more than the
  // line. The port defaulted bid_effort to blank, reasoning that an unanswered criterion
  // should be unscored and so rated the 0.5 midpoint — which is what
  // `core/scorer.default_response` does for this case, at length and on purpose.
  //
  // The SUBMIT FORM does not use default_response. `_crit` is
  // `opts.index("Not sure") if "Not sure" in opts else 0`, and bid_effort has no
  // "Not sure", so `else 0` takes the FIRST option — and the list runs best to worst.
  // An untouched PREFER-9 therefore asserts "Ample time, sufficient resources", scoring a
  // full 2 rather than a midpoint 1, on a form where the submitter may have touched
  // nothing but the four required fields.
  //
  // Asserted as it is rather than as it ought to be: the two apps are live together and
  // the same input must not score two ways. Changing it is a change to the Python.
  ok("bid_effort, which has no Not sure, defaults to the BEST answer",
    SC.criterionScore("bid_effort", v.bid_effort) === 2
      && v.bid_effort === V.CRITERION_ANSWERS.bid_effort[0],
    `got ${j(v.bid_effort)} scoring ${SC.criterionScore("bid_effort", v.bid_effort)} — `
    + "views/submit_form.py::_crit falls back to opts[0], not to the midpoint.");
  ok("a value outside the vocabulary is dropped, not stored",
    S.criteriaValues({ capacity: "something nobody offered" }).capacity === "Not sure");
}

// 7. UID collisions — the port's own guard, which the Python does not have.
{
  const taken = new Set(["BN-261116-0900", "BN-261116-0901"]);
  ok("a free uid is used as it is", S.pickUid("BN-261116-0859", taken) === "BN-261116-0859");
  ok("a taken uid moves to the next free minute",
    S.pickUid("BN-261116-0900", taken) === "BN-261116-0902",
    S.pickUid("BN-261116-0900", taken));
  ok("the last minute of the day wraps rather than reading 2460",
    S.pickUid("BN-261116-2359", new Set(["BN-261116-2359"])) === "BN-261116-0000");
  ok("a wall of collisions still inserts rather than refusing",
    S.pickUid("BN-261116-0900",
      new Set(Array.from({ length: 60 }, (_, i) => `BN-261116-09${String(i).padStart(2, "0")}`)))
      === "BN-261116-0900",
    "the 2026-06-05 policy is that a submission is never refused; five tries then take "
    + "the original.");
}

// 8. Job kinds, both sides.
same("job kinds the API queues vs the runner's", J.jobKinds().sort(), want.job_kinds);

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
