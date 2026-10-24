// Parity check for the API's data routing and tenant resolution.
//
//   node scripts/parity/check-routing.mjs     (from web/; reads the live database, read-only)
//
// 1. The table sets in supabase/functions/_shared/api/db.ts must equal db/supabase_client.py's
//    _SERVICE_ONLY_TABLES / _SERVICE_WRITE_TABLES / _TENANT_SCOPED_TABLES, and the first two
//    must equal migration 098's arrays.
// 2. For EVERY user in the database, the TypeScript membership list and the tenant a new
//    session lands in must equal auth/tenant_context.py's answer.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const D = await mod("supabase/functions/_shared/api/db.ts");
const T = await mod("supabase/functions/_shared/api/tenants.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python = process.env.RFPIS_PYTHON || (existsSync(venv) ? venv : "python");
const py = (what) => JSON.parse(execFileSync(python, [path.join(here, "routing_py.py"), what],
  { encoding: "utf8", maxBuffer: 1 << 26, cwd: process.cwd() }));

let diffs = 0;
const same = (label, a, b) => {
  const x = JSON.stringify([...a].sort()), y = JSON.stringify([...b].sort());
  if (x !== y) {
    diffs++;
    console.log(`DIFF ${label}: ts=${x} py=${y}`);
  }
};

// 1. Sets
const s = py("sets");
same("service-only vs Python", D.SERVICE_ONLY_TABLES, s.service_only);
same("service-write vs Python", D.SERVICE_WRITE_TABLES, s.service_write);
same("tenant-scoped vs Python", D.TENANT_SCOPED_TABLES, s.tenant_scoped);
same("service-only vs migration 098", D.SERVICE_ONLY_TABLES, s.mig_service_only);
same("service-write vs migration 098", D.SERVICE_WRITE_TABLES, s.mig_read_only);
console.log("routing sets checked");

// 2. Tenants, for every user
function loadEnv() {
  const env = {};
  for (const dir of [process.cwd(), root]) {
    const f = path.join(dir, ".env");
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return env;
}
const env = loadEnv();
const db = D.createDb({ supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY, jwtSecret: env.SUPABASE_JWT_SECRET });
const tenants = T.createTenants(db);
const want = py("tenants");
const users = await db.service.get("users", "select=id,email,role,last_tenant_id");
for (const u of users) {
  const mems = await tenants.activeMemberships(String(u.id));
  const chosen = await tenants.defaultMembership(u, mems);
  const w = want[String(u.id)];
  same(`memberships of user ${String(u.id).slice(0, 8)}`, mems.map((m) => m.tenant_id), w.memberships);
  const got = chosen ? chosen.tenant_id : null;
  if (got !== w.tenant || (got && (chosen.role ?? null) !== w.tenant_role)) {
    diffs++;
    console.log(`DIFF tenant of user ${String(u.id).slice(0, 8)}: ts=${got}/${chosen?.role} py=${w.tenant}/${w.tenant_role}`);
  }
}
console.log(`${users.length} users checked, ${diffs} differences`);
process.exit(diffs ? 1 : 0);
