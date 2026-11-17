// Parity check for the deployment diagnostics — core/env_diag.py.
//
//   node scripts/parity/check-env-diag.mjs    (from web/; no database, no secrets)
//
// WHY THESE THREE FUNCTIONS, AND WHY THE AGREEMENT IS THE WHOLE VALUE. The diagnostics
// exist to answer "the published app behaves differently from my machine". Streamlit can
// only describe the Python process it runs in; the Edge Function is the runtime that
// actually serves React. The two panels are meant to be read SIDE BY SIDE — which only
// works if they compute the same facts the same way:
//
//   * A FINGERPRINT is the first eight hex of a sha256, and its only job is comparison.
//     Computed differently in the two runtimes, two correctly-configured deployments
//     would show a mismatch and somebody would hunt a problem that is not there.
//   * A KEY CLASS is expensive to get wrong in either direction. A publishable key
//     reported as service-role explains none of the RLS failures it causes; a
//     service-role key reported as publishable sends somebody looking for a permissions
//     problem that does not exist.
//   * A PROJECT REF is the single field that tells two deployments apart when they
//     disagree about the data. If the two sides parse a URL differently, the one field
//     that would have identified the mismatch is itself the mismatch.
//
// NO REAL SECRET IS INVOLVED: every fixture is invented, and the JWTs are unsigned
// payloads the Python assembles — they prove the `role` claim is read, not that anything
// is valid.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const E = await mod("supabase/functions/_shared/api/env_diag.ts");

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
  want = JSON.parse(execFileSync(python, [path.join(here, "env_diag_py.py")], {
    input: "{}", encoding: "utf8", maxBuffer: 1 << 26, stdio: ["pipe", "pipe", "pipe"],
  }));
} catch (e) {
  console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
  process.exit(2);
}

// 1. The key class, both formats and every unreadable shape.
for (const [i, c] of want.keys.entries()) {
  const got = E.keyClass(c.key);
  // The key itself is never printed, even in a failure: these are invented, but a
  // harness that prints keys teaches the habit of printing keys.
  const where = `key #${i} (${c.label})`;
  same(`${where} — label`, got.label, c.label);
  same(`${where} — is_service_role`, got.isServiceRole, c.is_service_role);
}

// 2. The project ref.
for (const [i, c] of want.urls.entries()) {
  same(`project ref #${i} ${J(c.url)}`, E.projectRef(c.url), c.ref);
}

// 3. The fingerprint, unicode included.
for (const [i, c] of want.fingerprints.entries()) {
  const got = await E.fingerprint(c.value);
  same(`fingerprint #${i} ${J(String(c.value ?? "").slice(0, 24))}`, got, c.fp);
}

// 4. The claims worth naming.
{
  ok("the three secrets described are the three the Python names",
    J((await E.secretRows({})).map((r) => r.name)) === J(want.secret_names));

  ok("a fingerprint is eight hex characters and nothing else",
    /^[0-9a-f]{8}$/.test(await E.fingerprint("sb_secret_abc123")),
    "it exists to be compared at a glance between two panels; anything longer invites "
    + "somebody to paste the whole thing somewhere.");

  const rows = await E.secretRows({
    supabaseUrl: "https://abc123.supabase.co",
    supabaseKey: "sb_secret_SUPERSECRETVALUE",
    jwtSecret: "another-secret-value",
  });
  const blob = JSON.stringify(rows);
  ok("no secret VALUE appears anywhere in the payload",
    !blob.includes("SUPERSECRETVALUE") && !blob.includes("another-secret-value"),
    "this panel is read over somebody's shoulder and screenshotted into tickets. It "
    + "reports lengths, fingerprints and a class — never a value.");

  ok("...but the length and class still describe it usefully",
    rows[1].length === "sb_secret_SUPERSECRETVALUE".length
    && rows[1].is_service_role === true,
    "a length catches a truncated paste, which is the commonest way a key is wrong.");

  ok("the URL row carries a project ref and NO fingerprint",
    rows[0].project_ref === "abc123" && rows[0].fingerprint === undefined,
    "the URL is not a secret, and the ref is the comparable fact. The Python drops the "
    + "fingerprint here for the same reason.");

  const bad = E.verdicts(await E.secretRows({
    supabaseUrl: "https://abc123.supabase.co",
    supabaseKey: "sb_publishable_abc",
    jwtSecret: "x",
  }), { dispatchConfigured: true, mailerConfigured: true, adminContact: true });
  ok("a publishable key is reported as the serious thing it is",
    bad.some((v) => v.level === "bad" && v.text.includes("publishable")),
    "it produces empty reads and refused writes, which look like missing data rather "
    + "than a misconfiguration — so it has to be named.");

  const fine = E.verdicts(await E.secretRows({
    supabaseUrl: "https://abc123.supabase.co", supabaseKey: "sb_secret_x", jwtSecret: "y",
  }), { dispatchConfigured: true, mailerConfigured: true, adminContact: true });
  ok("a healthy runtime says so rather than saying nothing",
    fine.length === 1 && fine[0].level === "good",
    "an empty verdict list reads as a panel that failed to run.");

  const missing = E.verdicts(await E.secretRows({}), {
    dispatchConfigured: false, mailerConfigured: false, adminContact: false,
  });
  ok("every missing secret is named, not summarised",
    want.secret_names.every((n) => missing.some((v) => v.text.startsWith(n))),
    "'something is missing' sends somebody to check all three.");
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
