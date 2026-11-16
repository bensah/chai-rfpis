// Parity check for Profile — views/account_sections.py and views/login_history.py.
//
//   node scripts/parity/check-profile.mjs    (from web/; no database, no writes)
//
// This page edits ACCOUNTS, so the interesting comparisons are not cosmetic:
//
//   THE EDITABLE SET   the ten columns a user may write on their own row, taken out of
//                      the Python's own UPDATE dict by AST rather than retyped. `role`
//                      must not be among them: a self-service form that accepted it is a
//                      privilege-escalation endpoint wearing a profile form's clothes.
//   THE PASSWORD RULES one implementation, imported on the Python side and already
//                      ported in permissions.ts. Compared over a spread of passwords so a
//                      rule that exists on one side only is visible.
//   THE DEVICE LABEL   `_parse_ua`'s browser order is load-bearing: every one of these
//                      user-agent strings contains "safari/" and most contain "chrome/",
//                      so Edge must be tested before Chrome and Chrome before Safari.
//                      Reorder them and every Edge user becomes a Chrome user.
//
// No database: nothing here reads a row, and a check that edited an account to prove it
// could would be a worse idea than the bug it looked for.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const P = await mod("supabase/functions/_shared/api/profile.ts");
const PERM = await mod("supabase/functions/_shared/api/permissions.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");
const py = (payload) => {
  try {
    return JSON.parse(execFileSync(python, [path.join(here, "profile_py.py")], {
      input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 1 << 26,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (e) {
    console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
    process.exit(2);
  }
};

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

// Real strings, plus the ones that break a naive order of tests.
const AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chromium/120.0 Safari/537.36",
  "curl/8.4.0",
  "",
  null,
];

const PASSWORDS = [
  "", "short", "abcdefgh", "ABCDEFGH", "12345678", "Password", "Password1",
  "Password1!", "aB3$efgh", "a".repeat(200), "correct horse battery staple",
  "Tr0ub4dor&3", "        ", null,
];

const want = py({ agents: AGENTS, passwords: PASSWORDS });

// 1. The device label.
same("_parse_ua", AGENTS.map((ua) => P.parseUserAgent(ua)), want.devices);
ok("Edge is not reported as Chrome",
  P.parseUserAgent(AGENTS[0]) === "Edge · Windows", P.parseUserAgent(AGENTS[0]));
ok("Chrome is not reported as Safari",
  P.parseUserAgent(AGENTS[1]) === "Chrome · Windows", P.parseUserAgent(AGENTS[1]));
ok("Opera is not reported as Chrome",
  P.parseUserAgent(AGENTS[6]).startsWith("Opera"), P.parseUserAgent(AGENTS[6]));
ok("Chromium is not reported as Chrome",
  !P.parseUserAgent(AGENTS[7]).startsWith("Chrome"), P.parseUserAgent(AGENTS[7]));
ok("an empty agent is a device, not a blank", P.parseUserAgent("") === "Unknown device");

// 2. The editable set, out of the Python's own UPDATE dict.
same("the columns a user may write on their own row", [...P.EDITABLE].sort(), want.editable);
ok("role is NOT self-editable", !P.EDITABLE.includes("role"),
  "it decides what every other screen allows; a self-service form that accepted it "
  + "would be a privilege-escalation endpoint.");
ok("neither is password_hash or any stamp",
  !["password_hash", "must_change_password", "password_changed_at", "id", "created_at"]
    .some((c) => P.EDITABLE.includes(c)));
ok("the read column list never includes the hash",
  !P.PROFILE_COLUMNS.split(",").includes("password_hash"), P.PROFILE_COLUMNS);

// 3. The password policy, one implementation.
same("password_problems", PASSWORDS.map((pw) => PERM.passwordProblems(pw)), want.password);
same("the rules text users are shown", PERM.PASSWORD_RULES_TEXT, want.rules);

// 4. The patch shape, which is where a blank must become NULL.
{
  const patch = P.buildPatch({
    name: "  Bernard  ", phone: "", job_title: "   ", program: "IDs - Malaria",
    email: "  B@Example.org  ",
  });
  same("a blank becomes null, not an empty string",
    [patch.phone, patch.job_title], [null, null]);
  ok("a value is trimmed", patch.name === "Bernard", J(patch.name));
  ok("email is trimmed but never nulled — it is the login username",
    patch.email === "B@Example.org", J(patch.email));
  ok("an absent key is not written at all",
    !("city" in patch) && !("country" in patch), J(Object.keys(patch)));
  ok("a key outside the editable set is dropped",
    !("role" in P.buildPatch({ role: "super_user", name: "x" })),
    "the server refuses it even when a client sends it.");
  ok("program blank becomes null rather than an empty declaration",
    P.buildPatch({ program: "  " }).program === null,
    "it feeds core.user_program_areas as evidence of expertise in MUST-2, and an empty "
    + "string there is a declared area of \"\" rather than no declaration.");
}

// 5. The validation, including the case-insensitive uniqueness the login lookup needs.
{
  same("a valid unchanged email passes", P.validate("me@x.org", "me@x.org", false), []);
  same("a blank email is refused", P.validate("  ", "me@x.org", false),
    ["Email must be a valid address."]);
  same("an address with no @ is refused", P.validate("nope", "me@x.org", false),
    ["Email must be a valid address."]);
  same("a taken address is refused", P.validate("you@x.org", "me@x.org", true),
    ["Another user already has that email."]);
  same("the uniqueness check does not fire when the address did not change",
    P.validate("ME@X.ORG", "me@x.org", true), []);
  ok("a change is detected case-insensitively, both ways",
    !P.emailChanged("ME@X.ORG", "me@x.org") && P.emailChanged("you@x.org", "me@x.org"),
    "the login lookup is case-insensitive too, so letting \"Ben@x.org\" past a check "
    + "that \"ben@x.org\" exists would create an account that collides at sign-in.");
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
