// Parity check: the notification feed the API builds (routes_shell.ts) against
// core/notifications.recent_feed, for every active tenant, as a member of it sees it.
//
//   node scripts/parity/check-shell.mjs      (from web/; reads the live database, read-only)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const D = await mod("supabase/functions/_shared/api/db.ts");
const S = await mod("supabase/functions/_shared/api/routes_shell.ts");

const env = {};
for (const dir of [process.cwd(), root]) {
  const f = path.join(dir, ".env");
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python = process.env.RFPIS_PYTHON || (existsSync(venv) ? venv : "python");
const want = JSON.parse(execFileSync(python, [path.join(here, "shell_py.py")], { encoding: "utf8", maxBuffer: 1 << 26 }));

const db = D.createDb({ supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY, jwtSecret: env.SUPABASE_JWT_SECRET });
const shell = S.createShellRoutes(db);
let diffs = 0;
for (const [tid, py] of Object.entries(want)) {
  // A collaborator of this tenant: the tenant JWT path, like a real member.
  const ctx = {
    session: { sub: "00000000-0000-0000-0000-000000000001", email: "parity@local", scope: "app",
      tenant: { id: tid, name: null, slug: null }, tenantRole: "collaborator", view: null },
    user: { role: "collaborator", email: "parity@local" },
    scope: { sub: "00000000-0000-0000-0000-000000000001", email: "parity@local", tenantRole: "collaborator",
      tenantId: tid, viewTenantId: null, isSuper: false },
    homeIsDeveloper: async () => false,
  };
  const res = await shell.shell(ctx);
  const ts = (await res.json()).feed;
  const key = (it) => JSON.stringify([it.ts, it.icon, it.title, it.detail, it.nav, it.uid]);
  const a = ts.map(key), b = py.map(key);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    diffs++;
    console.log(`DIFF tenant ${tid.slice(0, 8)}: ts=${a.length} py=${b.length}`);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) console.log(`  [${i}] ts=${a[i]}\n       py=${b[i]}`);
    }
  }
}
console.log(`${Object.keys(want).length} tenants checked, ${diffs} with differences`);
process.exit(diffs ? 1 : 0);
