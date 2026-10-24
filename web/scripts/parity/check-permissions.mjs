// Parity check: every function in supabase/functions/_shared/api/permissions.ts against its
// Python original (core/permissions.py, core/suggestions.can_suggest, core/password_policy),
// over every role × developer-tenant flag × override combination.
//
//   node scripts/parity/check-permissions.mjs        (from web/; needs the repo's Python)
//
// Exits 1 on any difference and prints each one.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const P = await import(pathToFileURL(path.join(root, "supabase/functions/_shared/api/permissions.ts")).href);

const ROLES = [null, "", "collaborator", "reviewer", "admin", "super_user", "owner", "constructor"];
const OVERRIDES = [
  undefined, null, {}, { Report: "edit" }, { Donors: "hidden", "Settings → Sources": "edit" },
  { Report: "" }, { "Settings → Manual Scan": "trigger", Home: "view" }, "not-a-dict",
];
const SURFACES = [...Object.keys(P.ACCESS_MATRIX), "Nonexistent", "toString"];
const CAPS = [...P.OVERRIDE_OPTIONS, "self", "all", "weird"];

const users = [null, {}];
for (const role of ROLES) {
  for (const ov of OVERRIDES) {
    const u = { role, email: "a@x.org" };
    if (ov !== undefined) u.access_overrides = ov;
    users.push(u);
  }
}
const people = ROLES.flatMap((role) => [{ role, email: "a@x.org" }, { role, email: "b@x.org" }]);

const cases = [];
const add = (fn, args, dev = false) => cases.push({ fn, args, dev });
for (const dev of [false, true]) {
  for (const u of users) {
    for (const fn of ["isSuperUser", "isAdmin", "canEditStatus", "roleGroup", "isDeveloperSuper",
      "isDeveloperAdmin", "isDeveloperMember", "canSuggest", "roleLabel", "assignableRoles"]) add(fn, [u], dev);
  }
}
for (const u of users) {
  for (const s of SURFACES) {
    add("access", [u, s]);
    add("canView", [u, s]);
    add("canEdit", [u, s]);
    for (const cur of [null, "edit", "all", "weird"]) {
      add("assignableOverrideOptions", [u, s, cur]);
      for (const cap of CAPS) add("canAssignOverride", [u, s, cap, cur]);
    }
  }
}
for (const a of [null, {}, ...people]) for (const t of [null, {}, ...people]) add("canManageUser", [a, t]);
for (const pw of ["", "short1", "abcdefgh", "12345678", "abcd1234", "pass word 1", "ñandú123",
  "パスワード12345", "Ａｂｃ１２３４５", "²³⁴abcdefg", "        ", "a1"]) add("passwordProblems", [pw]);

// Python's evaluation
const dir = mkdtempSync(path.join(tmpdir(), "rfpis-perm-"));
const casesFile = path.join(dir, "cases.json");
writeFileSync(casesFile, JSON.stringify(cases));
const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python = process.env.RFPIS_PYTHON || (existsSync(venv) ? venv : "python");
const py = JSON.parse(execFileSync(python, [path.join(here, "permissions_py.py"), casesFile],
  { encoding: "utf8", maxBuffer: 1 << 28 }));

// TypeScript's evaluation — the dev flag is the extra trailing argument of the dev-aware fns.
const DEV_FNS = new Set(["isDeveloperSuper", "isDeveloperAdmin", "isDeveloperMember", "canSuggest"]);
let diffs = 0;
cases.forEach((c, i) => {
  let ts;
  try {
    ts = DEV_FNS.has(c.fn) ? P[c.fn](...c.args, c.dev) : P[c.fn](...c.args);
  } catch (e) {
    ts = { error: e.constructor.name };
  }
  if (JSON.stringify(ts) !== JSON.stringify(py[i])) {
    if (diffs++ < 40) console.log(`DIFF ${c.fn}(${JSON.stringify(c.args)}) dev=${c.dev}: py=${JSON.stringify(py[i])} ts=${JSON.stringify(ts)}`);
  }
});
console.log(`${cases.length} cases, ${diffs} differences`);
process.exit(diffs ? 1 : 0);
