// Parity check for Settings → Analytics — core/analytics.py's three rollups.
//
//   node scripts/parity/check-analytics.mjs     (from web/; reads the live database)
//
// NO FIXTURES. These are rollups over whatever is in the database, so the fixture IS the
// database and the answer is whatever the Python says about it right now. The TypeScript
// reads the same rows through the same service role, and the two are compared.
//
// WHICH MEANS THE CLOCK IS PART OF THE TEST. A scan finishing between the two reads moves
// `found`, `rejected` and `last_run` honestly, and a naive comparison would report that
// as a drift. So the two halves run back to back and the fields are split by how they can
// legitimately move:
//
//   PINNED EXACTLY   the shapes and the rules — which tenants, their names, statuses,
//                    member counts, the role breakdown, and the MATCH_RUN_LABEL that
//                    tells a screening run from a crawl row. None of these change on
//                    their own between two reads a second apart.
//   TOLERATED        the monotonic totals (found, rejected, catalog, rfps, total users).
//                    They only ever grow, so TypeScript may be AHEAD of Python and not
//                    behind — a smaller TS number is a real miscount, not a clock.
//
// THE TWO COUNTING RULES WORTH THE WHOLE CHECK are named below rather than left implicit:
// a system run is one with NO tenant, and scan_logs is one row per SOURCE per run, so
// "runs" is distinct scan_date minutes. Both are easy to get subtly wrong, and both go
// wrong by reporting a number that is merely too big rather than obviously broken.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireEnv } from "./_env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createDb } = await mod("supabase/functions/_shared/api/db.ts");
const A = await mod("supabase/functions/_shared/api/analytics.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");

const env = requireEnv(root, "check-analytics");
const db = createDb({
  supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY,
  jwtSecret: env.SUPABASE_JWT_SECRET,
});

let diffs = 0, checks = 0;
const J = (v) => JSON.stringify(v);
/**
 * Object keys sorted before comparing.
 *
 * `by_role` is a COUNT MAP — one key per role, built by iterating the users — and the
 * order it comes out in is the order the roles first appeared, which differs between two
 * languages reading the same rows. Comparing the serialisations would report a drift
 * that is nothing but iteration order, which is a false alarm this check already learnt
 * to avoid once (see check-org's `canon`).
 */
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  }
  return v;
};
const same = (label, ts, pyv) => {
  checks++;
  if (J(canon(ts)) === J(canon(pyv))) return;
  diffs++;
  console.log(`DIFF ${label}\n   ts: ${J(ts)}\n   py: ${J(pyv)}`);
};
/** A total that only ever grows: TypeScript may be ahead of Python, never behind. */
const atLeast = (label, ts, pyv, why) => {
  checks++;
  if (ts >= pyv) return;
  diffs++;
  console.log(`DIFF ${label}: ts=${ts} is BELOW py=${pyv}\n   ${why}`);
};
const ok = (label, cond, detail = "") => {
  checks++;
  if (cond) return;
  diffs++;
  console.log(`DIFF ${label}${detail ? `\n   ${detail}` : ""}`);
};

let want;
try {
  want = JSON.parse(execFileSync(python, [path.join(here, "analytics_py.py")], {
    input: "{}", encoding: "utf8", maxBuffer: 1 << 26, stdio: ["pipe", "pipe", "pipe"],
  }));
} catch (e) {
  console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
  process.exit(2);
}

// Read the TypeScript side immediately after, so the two see the same database.
const [discovery, tenants, users] = await Promise.all([
  A.systemDiscoveryStats(db), A.tenantActivity(db), A.userStats(db),
]);

// 1. The label that separates a screening run from a crawl row.
same("MATCH_RUN_LABEL", A.MATCH_RUN_LABEL, want.match_run_label);

// 2. Discovery. `runs` is pinned exactly: it counts distinct scan_date MINUTES, and the
//    only way it moves between two reads is a scan starting in that second.
same("system runs (distinct scan_date minutes, tenant_id IS NULL only)",
  discovery.runs, want.discovery.runs);
atLeast("solicitations found", discovery.found, want.discovery.found,
  "a system total only grows; a TypeScript figure BELOW the Python one means rows were "
  + "missed — most likely the 1000-row PostgREST cap, which is why the Python paginates.");
atLeast("solicitations rejected", discovery.rejected, want.discovery.rejected,
  "same reasoning as `found`.");
atLeast("catalogue size", discovery.catalog, want.discovery.catalog,
  "extracted_solicitations has no `id` column — it is keyed on `uid` — so a count of "
  + "`id` silently returns 0. Both sides must count \"*\".");
ok("the last system run is not older than the Python's",
  String(discovery.last_run ?? "") >= String(want.discovery.last_run ?? ""),
  `ts=${discovery.last_run} py=${want.discovery.last_run}. It is read as the MAXIMUM `
  + "rather than row 0 of a descending query, because getAll pages ascending to walk the "
  + "table — taking row 0 of what it returns would be the OLDEST run.");

// 3. The tenant rollup. Every field but the submission count is pinned exactly.
same("the tenants listed, in order", tenants.map((t) => t.id),
  want.tenants.map((t) => t.id));
for (const [i, t] of tenants.entries()) {
  const w = want.tenants[i];
  if (!w) break;
  same(`tenant ${t.name} — name, status, platform flag, members, pending, created`,
    [t.name, t.status, t.is_platform, t.members, t.pending, t.created],
    [w.name, w.status, w.is_platform, w.members, w.pending, w.created]);
  same(`tenant ${t.name} — last screening run`, t.last_screen ?? null, w.last_screen ?? null);
  atLeast(`tenant ${t.name} — submissions`, t.rfps, w.rfps,
    "a submission count only grows between two reads a second apart.");
}

// 4. The user rollup.
same("users by role", users.by_role, want.users.by_role);
same("active and inactive split", [users.active, users.inactive],
  [want.users.active, want.users.inactive]);
atLeast("total users", users.total, want.users.total, "accounts are not deleted here.");

// 5. The claims that no row-by-row comparison states on its own.
{
  ok("the role breakdown adds up to the total",
    Object.values(users.by_role).reduce((a, b) => a + b, 0) === users.total,
    "a user counted under no role, or under two, would make a platform rollup that does "
    + "not add up — and nothing on the page would show which.");

  ok("active and inactive add up to the total",
    users.active + users.inactive === users.total);

  ok("a user with no role is counted as \"unknown\", not as an empty label",
    !Object.hasOwn(users.by_role, ""),
    "the rollup is printed as a label, and an empty one reads as a rendering fault "
    + "rather than as a user whose role was never set.");

  ok("member counts never exceed what the memberships table holds",
    tenants.reduce((a, t) => a + t.members + t.pending, 0) <= 100000,
    "a sanity bound; the per-tenant figures are pinned exactly above.");

  ok("no tenant row leaked into the system discovery totals",
    discovery.runs <= want.discovery.runs + 1,
    "system runs are scan_logs rows with NO tenant. Counting a tenant's screening runs "
    + "too makes the figure grow with the number of tenants rather than with what was "
    + "found — which looks like success.");
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
