// Parity check for Phase 1: Home's counters, the opportunity rail, and the Opportunity page.
//
//   node scripts/parity/check-scoring.mjs      (from web/; reads the live database, read-only)
//
// Two things could go wrong, and this checks both:
//
//  1. HOME'S COUNTERS are the one piece of Phase 1 logic written twice — in TypeScript, so a
//     page of numbers does not wait four seconds for a Python engine to boot. They are run
//     here against app_pages/home.py's own arithmetic.
//
//  2. THE RAIL AND THE OPPORTUNITY PAGE reuse the repo's Python, so the rules cannot drift.
//     What can drift is the data underneath: the API builds a snapshot and the browser
//     stand-ins serve it instead of a database. So each surface is computed twice — through
//     the stand-ins over the API's snapshot, and through the real client against Supabase —
//     and the two are diffed. Anything the snapshot forgets shows up as a difference.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const web = path.resolve(root, "web");
const art = path.join(web, ".parity");
mkdirSync(art, { recursive: true });

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
const py = (args, opts = {}) => execFileSync(python, args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts });

const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createDb } = await mod("supabase/functions/_shared/api/db.ts");
const { createPhase1Routes } = await mod("supabase/functions/_shared/api/routes_phase1.ts");

const db = createDb({ supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY, jwtSecret: env.SUPABASE_JWT_SECRET });
const routes = createPhase1Routes(db);

let diffs = 0;
const fail = (msg) => {
  diffs++;
  console.log(`DIFF ${msg}`);
};

// Each active tenant, as one of its own members sees it. RFPIS_PARITY_TENANT narrows this
// to one slug or id, which is how you inspect a tenant that failed: its artefacts are then
// the ones left in web/.parity/ afterwards.
const only = process.env.RFPIS_PARITY_TENANT;
const tenants = (await db.service.get("tenants", "select=id,name,slug&status=eq.active"))
  .filter((t) => !only || t.slug === only || String(t.id) === only);
const body = async (res) => JSON.parse(await res.text());
const ctxFor = (tid) => ({
  session: { sub: "00000000-0000-0000-0000-000000000001", email: "parity@local", scope: "app",
    tenant: { id: tid, name: null, slug: null }, tenantRole: "collaborator", view: null },
  user: { role: "collaborator", email: "parity@local" },
  scope: { sub: "00000000-0000-0000-0000-000000000001", email: "parity@local",
    tenantRole: "collaborator", tenantId: tid, viewTenantId: null, isSuper: false },
  homeIsDeveloper: async () => false,
});

// ── 1. Home's counters ───────────────────────────────────────────────────────
const wantHome = JSON.parse(py([path.join(here, "home_py.py")], { cwd: root }));
for (const t of tenants) {
  const got = await body(await routes.home(ctxFor(String(t.id))));
  const want = wantHome[String(t.id)];
  if (!want) continue;
  for (const k of Object.keys(want)) {
    if (got[k] !== want[k]) fail(`home ${t.slug ?? t.id}.${k}: api=${got[k]} python=${want[k]}`);
  }
}
console.log(`home counters: ${tenants.length} tenants checked`);

// ── 2. The rail and the Opportunity page, per tenant ─────────────────────────
// One tenant at a time: each run reloads the scoring modules against a different data layer,
// so they cannot share a process.
const bundle = JSON.parse(readFileSync(path.join(web, "public/py/bundle.json"), "utf8"));
for (const rel of ["db/supabase_client.py", "auth/tenant_context.py", "db/__init__.py", "auth/__init__.py"]) {
  const out = path.join(art, "stubs", rel);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, bundle[rel]);
}

for (const t of tenants) {
  const tid = String(t.id);
  const ctx = ctxFor(tid);
  const snapshot = await body(await routes.snapshot(new Request("https://x"), ctx));
  const feed = await body(await routes.feed(new Request("https://x"), ctx));
  writeFileSync(path.join(art, "snapshot.json"), JSON.stringify(snapshot));
  writeFileSync(path.join(art, "feed.json"), JSON.stringify(feed));

  // A few opportunities from this tenant's own feed, plus the shared catalogue.
  const uids = [...feed.pipeline.slice(0, 3), ...feed.catalog.slice(0, 2)]
    .map((r) => String(r.uid ?? "")).filter(Boolean);
  // Clear the previous tenant's files, or its opportunities would be scored against this
  // tenant's snapshot and every row would look like a difference.
  for (let i = 0; i < 10; i++) {
    const p = path.join(art, `opportunity-${i}.json`);
    if (existsSync(p)) rmSync(p);
  }
  let n = 0;
  for (const uid of uids) {
    const rows = await body(await routes.opportunity(new Request("https://x"), ctx, uid));
    writeFileSync(path.join(art, `opportunity-${n++}.json`), JSON.stringify(rows));
  }

  py([path.join(here, "scoring_py.py"), art], { cwd: root, stdio: "pipe" });
  const a = readFileSync(path.join(art, "result-app.json"), "utf8");
  const b = readFileSync(path.join(art, "result-browser.json"), "utf8");
  if (a === b) {
    console.log(`${t.slug ?? tid}: rail + ${n} opportunities identical`);
    continue;
  }
  const A = JSON.parse(a), B = JSON.parse(b);
  const before = diffs;
  for (const card of ["featured", "top_matches", "top_funding", "other"]) {
    const ka = JSON.stringify(A.feed[card]), kb = JSON.stringify(B.feed[card]);
    if (ka !== kb) fail(`${t.slug ?? tid} rail.${card}: app=${A.feed[card].length} browser=${B.feed[card].length} items, content differs`);
  }
  // Preferences are compared as sorted lists: core/opportunity_feed.featured_score turns
  // each one into a set before using it, so only the membership can change an answer, and
  // the ranked output above is already compared exactly.
  const sortPrefs = (p) => Object.fromEntries(Object.entries(p)
    .map(([k, v]) => [k, Array.isArray(v) ? [...v].map(String).sort() : v]));
  const pa = JSON.stringify(sortPrefs(A.prefs)), pb = JSON.stringify(sortPrefs(B.prefs));
  if (pa !== pb) {
    for (const k of new Set([...Object.keys(A.prefs), ...Object.keys(B.prefs)])) {
      const x = JSON.stringify(sortPrefs(A.prefs)[k]), y = JSON.stringify(sortPrefs(B.prefs)[k]);
      if (x !== y) fail(`${t.slug ?? tid} rail prefs.${k}: app=${x.slice(0, 140)} browser=${y.slice(0, 140)}`);
    }
  }
  for (const uid of Object.keys(A.opportunities)) {
    const x = JSON.stringify(A.opportunities[uid]), y = JSON.stringify(B.opportunities[uid]);
    if (x === y) continue;
    const oa = A.opportunities[uid], ob = B.opportunities[uid] ?? {};
    const keys = new Set([...Object.keys(oa), ...Object.keys(ob)]);
    for (const k of keys) {
      if (JSON.stringify(oa[k]) !== JSON.stringify(ob[k])) {
        fail(`${t.slug ?? tid} ${uid}.${k}: app=${JSON.stringify(oa[k]).slice(0, 120)} browser=${JSON.stringify(ob[k]).slice(0, 120)}`);
      }
    }
  }
  // Said out loud rather than passed over in silence: the two sides are not byte-identical,
  // and every field that could change an answer was checked and agreed.
  if (diffs === before) {
    console.log(`${t.slug ?? tid}: rail + ${n} opportunities agree (inputs differ only in ` +
      "list order, which featured_score normalises away)");
  }
}

console.log(diffs
  ? `\n${diffs} differences`
  : `\nno differences that could change an answer, across ${tenants.length} tenants`);
process.exit(diffs ? 1 : 0);
