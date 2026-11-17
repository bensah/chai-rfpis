// Parity check for Settings → Accounts → Users.
//
//   node scripts/parity/check-users-admin.mjs    (from web/; no database, no writes)
//
// WHAT A DRIFT COSTS HERE. Everywhere else in this port a wrong answer is a wrong score
// or a wrong number on a page. On this surface it is ACCESS, in a direction nothing
// reports: a role assigned one step above what the actor holds, an override granted past
// the grantor's own ceiling, an account that reads "Active" when nobody has ever signed
// into it. The three gates — can-manage, the self lock, the override ceiling — are the
// only thing between a request and somebody else's account, and a client is not bound by
// whatever the dialog happened to disable.
//
// `accountStatus` gets the longest case list because its bug ALREADY HAPPENED: a None
// last_login_at arrives from pandas as the float nan, whose string is "nan" — truthy —
// so the first inline version never reported anybody as Pending, and a structural test
// grepping the source for "Pending" passed happily. core/user_lifecycle exists as its own
// module for that reason, and the blank set is carried over verbatim.
//
// ONE ANSWER KEY: every expectation is Python's, from the modules that own the rules.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const U = await mod("supabase/functions/_shared/api/users_admin.ts");
const P = await mod("supabase/functions/_shared/api/permissions.ts");

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
  want = JSON.parse(execFileSync(python, [path.join(here, "users_admin_py.py")], {
    input: "{}", encoding: "utf8", maxBuffer: 1 << 26, stdio: ["pipe", "pipe", "pipe"],
  }));
} catch (e) {
  console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
  process.exit(2);
}

// 1. The labels themselves. They are printed verbatim, emoji included, so a mismatch is
//    visible to a reader as two apps describing the same account differently.
same("the three status labels",
  [U.STATUS_PENDING, U.STATUS_ACTIVE, U.STATUS_INACTIVE],
  [want.labels.pending, want.labels.active, want.labels.inactive]);

// 2. account_status, over every shape a blank can take.
for (const [i, c] of want.status.entries()) {
  same(`accountStatus #${i} ${J(c.args)}`, U.accountStatus(...c.args), c.want);
}

// 3. can_manage_user, across every role pairing and both self cases.
let manageDiffs = 0;
for (const c of want.manage) {
  checks++;
  const got = P.canManageUser(c.actor, c.target);
  if (got === c.want) continue;
  diffs++; manageDiffs++;
  if (manageDiffs <= 8) {
    console.log(`DIFF canManageUser ${c.actor.role || "(none)"} -> ${c.target.role || "(none)"}`
      + `${c.actor.email === c.target.email ? " (self)" : ""}: py=${c.want} ts=${got}`);
  }
}

// 4. The roles each actor may assign.
for (const [role, roles] of Object.entries(want.assignable)) {
  same(`assignableRoles(${role || "(none)"})`, P.assignableRoles({ role }), roles);
}

// 5. The override ceiling, per surface and capability.
let ovDiffs = 0;
for (const c of want.override) {
  checks++;
  const got = P.canAssignOverride(c.actor, c.surface, c.cap, c.current);
  if (got === c.want) continue;
  diffs++; ovDiffs++;
  if (ovDiffs <= 8) {
    console.log(`DIFF canAssignOverride ${c.actor.role} ${c.surface} -> ${c.cap} `
      + `(current ${J(c.current)}): py=${c.want} ts=${got}`);
  }
}

// 6. The new-user validation.
for (const [i, c] of want.new_user.entries()) {
  same(`newUserProblems #${i} ${J([c.email, c.name])}`,
    U.newUserProblems(c.email, c.name), c.want);
}

// 7. The surfaces and the option list, which the override editor renders one row per.
same("the access surfaces", Object.keys(P.ACCESS_MATRIX), want.surfaces);
same("the override options", [...P.OVERRIDE_OPTIONS], want.override_options);
same("the use-default sentinel", P.USE_DEFAULT, want.use_default);

// 8. The claims worth naming — the ones no case list states on its own.
{
  const superUser = { role: "super_user", email: "me@x.org" };
  const admin = { role: "admin", email: "me@x.org" };

  ok("a super_user may not change their OWN role or active flag",
    (() => {
      const r = U.editRights(superUser, { role: "super_user", email: "me@x.org" });
      return r.profile && r.overrides && !r.role && !r.reset && !r.remove;
    })(),
    "canManageUser lets a super_user manage a super_user, so the self lock is a SECOND "
    + "gate — without it the last super_user can demote themselves out of the product "
    + "and nobody can put them back.");

  ok("...and the email comparison is case-insensitive",
    !U.editRights({ role: "super_user", email: "Me@X.org" },
      { role: "super_user", email: "me@x.org" }).role,
    "addresses are stored as typed. A self-edit that differed only in case would unlock "
    + "exactly what this guard exists to lock.");

  ok("a self-edit still saves the profile and the overrides",
    (() => {
      const r = U.editRights(admin, { role: "admin", email: "me@x.org" });
      return r.profile && r.overrides;
    })(),
    "refusing the whole request would break the page's own promise — 'You can edit your "
    + "profile + access overrides; role, active, reset, and delete are locked'.");

  ok("a locked role is DROPPED from the patch, not refused",
    (() => {
      const r = U.editRights(admin, { role: "admin", email: "me@x.org" });
      const patch = U.editPatch({ name: "Me", role: "super_user", is_active: false }, r);
      return patch.name === "Me" && !("role" in patch) && !("is_active" in patch);
    })(),
    "a client can send role and is_active whatever the dialog disabled. Silently "
    + "dropping them saves what the actor may change, which is what the Python does.");

  ok("an empty optional field becomes null, never the empty string",
    (() => {
      const r = U.editRights(superUser, { role: "admin", email: "t@x.org" });
      const patch = U.editPatch({ department: "  ", phone: "", name: " Jane " }, r);
      return patch.department === null && patch.phone === null && patch.name === "Jane";
    })(),
    "`or None` in the Python. '' and null group differently, so a cleared department "
    + "would show up in the roster's filters as a department named nothing.");

  ok("the email is kept as a trimmed string even when blank-ish",
    (() => {
      const r = U.editRights(superUser, { role: "admin", email: "t@x.org" });
      return U.editPatch({ email: "  a@b.org " }, r).email === "a@b.org";
    })(),
    "it is the login username; nulling it would lock the account out of the product.");

  ok("'Use role default' is dropped rather than stored",
    (() => {
      const { overrides } = U.overridesFor(superUser,
        { Home: P.USE_DEFAULT, Grants: "view" }, {});
      return !("Home" in overrides) && overrides.Grants === "view";
    })(),
    "it is an ABSENCE. Storing the words would make a later change to ACCESS_MATRIX "
    + "invisible to everybody who had ever opened this dialog.");

  ok("a surface this build does not know is dropped",
    (() => {
      const { overrides, refused } = U.overridesFor(superUser,
        { "Settings → Nonexistent": "edit" }, {});
      return !Object.keys(overrides).length && !refused.length;
    })(),
    "`access()` reads the overrides BEFORE the matrix, so a typo'd surface would sit on "
    + "the row forever, matching nothing and explaining nothing.");

  ok("a capability outside the option list is REFUSED, not dropped quietly",
    U.overridesFor(superUser, { Home: "sudo" }, {}).refused.includes("Home"),
    "an invented capability is a client trying something, not a stale vocabulary.");

  ok("an actor cannot grant beyond their own ceiling",
    (() => {
      const surface = Object.keys(P.ACCESS_MATRIX).find(
        (sf) => !P.canAssignOverride({ role: "collaborator", email: "c@x.org" }, sf, "edit", null));
      if (!surface) return false;
      const { overrides, refused } = U.overridesFor(
        { role: "collaborator", email: "c@x.org" }, { [surface]: "edit" }, {});
      return refused.includes(surface) && !(surface in overrides);
    })(),
    "the Python calls this 'defense in depth vs the filtered dropdown'. Here it is the "
    + "ONLY defence: there is no dropdown between a client and the route.");

  ok("keeping a role the actor could not newly assign is allowed",
    U.roleAllowed(admin, "super_user", "super_user")
    && !U.roleAllowed(admin, "super_user", "admin"),
    "an admin editing a super_user's department must not silently demote them, and must "
    + "not be able to promote anybody either.");

  ok("a blacklisted account is never listed",
    U.visibleUsers(
      [{ id: "1", is_blacklisted: true }, { id: "2" }], superUser, null).length === 1,
    "they are hard-blocked and managed under their own tab; listing them here would "
    + "offer actions that do not apply.");

  ok("a non-super sees only the tenant on screen",
    U.visibleUsers([{ id: "1" }, { id: "2" }], admin, new Set(["2"]))
      .map((u) => u.id).join() === "2");

  ok("a pending membership is labelled as pending",
    U.tenantLabels([
      { user_id: "u1", status: "active", tenants: { name: "Alpha" } },
      { user_id: "u1", status: "pending", tenants: { name: "Beta" } },
      { user_id: "u1", status: "revoked", tenants: { name: "Gamma" } },
    ]).u1 === "Alpha, Beta (pending)",
    "and a revoked one is not listed at all.");

  ok("the whitespace-name hole is closed at the ROUTE, not in the shared rule",
    U.newUserProblems("a@b.org", "   ").length === 0
    && U.newUserProblems("a@b.org", U.cleanNewUser({ email: "a@b.org", name: "   " }).name)
      .length === 1,
    "the Python tests `if not name`, so pure whitespace passes it. `_bulk_rows` strips "
    + "every cell first and never reaches that case; the single-user dialog does not. "
    + "Tightening the shared rule would make the two apps disagree about one input, so "
    + "the route cleans its form the way the bulk path cleans a cell and the rule stays "
    + "identical in both.");

  ok("re-saving a form without touching the email is not a collision with yourself",
    U.editProblems({ email: "ME@x.org" }, "me@x.org", ["other@x.org"]).length === 0
    && U.editProblems({ email: "other@x.org" }, "me@x.org", ["other@x.org"]).length === 1);

  ok("a request that carries no email is not judged on one",
    U.editProblems({ department: "BD" }, "me@x.org", ["other@x.org"]).length === 0,
    "the Streamlit dialog is a FORM and always submits every input, so its check can "
    + "assume an email is there. A PATCH cannot. Validating an absent key rejected "
    + "\"change this person's department\" with \"Email must be a valid address\", which "
    + "is both wrong and impossible to act on.");

  ok("...but an email that IS carried and empty is still refused",
    U.editProblems({ email: "   " }, "me@x.org", []).length === 1,
    "it is the login username; saving a blank one locks the account out.");
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
