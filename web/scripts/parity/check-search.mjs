// Parity check for Search — core/site_search.py.
//
//   node scripts/parity/check-search.mjs    (from web/; reads the live database, read-only)
//
// A search box is a ranking, and a ranking is the easy thing to port wrong: get the
// SCORES right and the ORDER wrong and every query still "works" while the answer a
// reader sees first is somebody else's. Three things are therefore pinned:
//
//   the INDEX      the label and keyword strings are what a query is matched against, so
//                  a typo in either silently stops a page being findable
//   the RANKING    label match (100 - index) beats keyword match (40) beats all-words
//                  (20), the branches do not add, and equal scores keep registry order
//   the DATA       the two ilike searches and their de-duplication, over live rows
//
// WHAT IS DELIBERATELY NOT COMPARED: the nav TARGETS. The Python's registry carries
// Streamlit module paths and this port carries React routes — "Pipelines · Review" goes to
// app_pages/pipelines.py there and /pipelines?stage=reviewed here, which is the port being
// better rather than different. The labels still have to match exactly, because they are
// the index.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv } from "./_env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const S = await mod("supabase/functions/_shared/api/search.ts");
const D = await mod("supabase/functions/_shared/api/db.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");
const py = (payload) => {
  try {
    return JSON.parse(execFileSync(python, [path.join(here, "search_py.py")], {
      input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 1 << 28,
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

// Queries chosen to hit each ranking branch and each data column, plus the ones that
// break a naive port: a comma (the PostgREST delimiter), a single character (below the
// floor), a multi-word phrase (the only thing the 20-point branch exists for).
const NAV_QUERIES = [
  "blacklist", "manage users", "scan", "report", "donor", "pipelines", "settings",
  "review", "h", "", "users", "track", "proposal", "excel sync", "zzzz", "Home",
  "DONORS", "pending", "actions", "help",
];
const DATA_QUERIES = ["malaria", "health", "gates", "a", "", "fund, grant", "usaid", "(who)"];
const SANITIZE = ["plain", "a,b", "(x)", " padded ", "a,(b),c", ",,,", ""];

const want = py({
  nav: NAV_QUERIES.flatMap((q) => [{ q, admin: true }, { q, admin: false }]),
  queries: DATA_QUERIES,
  sanitize: SANITIZE,
});

// 1. The index itself.
same("the nav registry", S.navRegistry().map((r) => ({
  label: r.label, keywords: r.keywords, admin_only: r.adminOnly,
})), want.registry);

// 2. The ranking, for both roles.
let i = 0;
for (const q of NAV_QUERIES) {
  for (const admin of [true, false]) {
    same(`search_nav(${J(q)}, admin=${admin})`,
      S.searchNav(q, admin).map((h) => h.label), want.nav[i++]);
  }
}
ok("an admin-only page is invisible to a non-admin",
  S.searchNav("blacklist", false).length === 0 && S.searchNav("blacklist", true).length > 0);
{
  // The branches do not add, and the label branch ranks by WHERE the match is. "Pipelines"
  // is a prefix of its own label and a substring of four others, so the parent must come
  // first — a reader typing the section name wants the section.
  const hits = S.searchNav("pipelines", false);
  ok("a prefix match on the label outranks the same word later in a longer label",
    hits[0].label === "Pipelines", J(hits.map((h) => [h.label, h.score])));
  ok("every label hit beats every keyword hit",
    Math.min(...hits.filter((h) => h.label.toLowerCase().includes("pipelines")).map((h) => h.score)) > 40,
    J(hits.map((h) => [h.label, h.score])));
}
{
  // Equal scores keep registry order. Both languages sort stably, so this is a claim about
  // the port's data order rather than about either sort — and it is the claim that keeps
  // the two apps showing one list.
  const hits = S.searchNav("scan", true);
  const forties = hits.filter((h) => h.score === 40).map((h) => h.label);
  const order = S.navRegistry().map((r) => r.label);
  ok("ties keep registry order",
    forties.every((l, n) => n === 0 || order.indexOf(forties[n - 1]) < order.indexOf(l)),
    J(forties));
}
ok("a one-character query matches nothing in nav either way",
  S.searchNav("h", true).length === want.nav[NAV_QUERIES.indexOf("h") * 2].length,
  "the nav search has no length floor — only the DATA searches do, and that asymmetry is "
  + "the Python's. `h` legitimately matches labels containing it.");

// 3. `_sanitize`.
same("sanitize", SANITIZE.map((s) => S.sanitize(s)), want.sanitized);
// Replaced with spaces rather than removed: the value is wrapped in `%…%` either way, so
// a space is a wildcard once it is, and "a,b" must not silently become the word "ab".
ok("the PostgREST delimiters become spaces, not nothing",
  S.sanitize("a,(b)") === "a  b", J(S.sanitize("a,(b)")));

// 4. The data searches, against the live database.
const env = loadEnv(root);
const db = D.createDb({
  supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY,
  jwtSecret: env.SUPABASE_JWT_SECRET,
});
// The service role, because the Python half runs with no tenant override and so reads the
// same way. The ROUTE scopes to the reader's tenant; what is compared here is the query.
for (const [n, q] of DATA_QUERIES.entries()) {
  const got = await S.searchOpportunities(db.service, q);
  same(`search_opportunities(${J(q)})`,
    got.map((r) => ({
      title: r.title, funder: r.funder, deadline: r.deadline,
      decision: r.decision, source: r.source,
    })), want.opportunities[n]);
  const d = await S.searchDonors(db.service, q);
  same(`search_donors(${J(q)})`, d.map((x) => x.name), want.donors[n]);
}
ok("a query under two characters reads nothing at all",
  (await S.searchOpportunities(db.service, "a")).length === 0
  && (await S.searchDonors(db.service, "a")).length === 0,
  "the floor is the Python's, in both data functions, and it is what keeps a single "
  + "keystroke from ilike-ing four columns of every row.");
{
  // De-duplication is on (title, funder) lower-cased, keeping the FIRST — which is how the
  // same call found by two scans appears once. Asserted against live rows rather than a
  // fixture, since the duplicates here are real ones.
  const got = await S.searchOpportunities(db.service, "health");
  const keys = got.map((r) => `${r.title.toLowerCase()}\u0000${r.funder.toLowerCase()}`);
  ok("opportunity hits are unique on title and funder",
    new Set(keys).size === keys.length, `${keys.length} rows, ${new Set(keys).size} distinct`);
  ok("every hit carries the uid its link needs",
    got.every((r) => r.uid), "the Streamlit hit lands on the Pipelines page and leaves the "
    + "reader to find the row; this one opens the call, which needs the uid.");
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
