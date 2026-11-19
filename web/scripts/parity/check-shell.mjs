// Parity check: the notification feed the API builds (routes_shell.ts) against
// core/notifications.recent_feed, for every active tenant, as a member of it sees it.
//
//   node scripts/parity/check-shell.mjs      (from web/; reads the live database, read-only)
//
// TWO CHECKS, BECAUSE THE TWO FEEDS ARE NO LONGER THE SAME FEED.
//
// a4f25fa gave the React Alerts screen a third kind of item: an auto-sourced row the engine
// rated Proceed or Park appears in its own right ("New Proceed call" / "New Park call"),
// because that is the alert the owner actually wants and the Friday scan_logs line could
// never carry it. core/notifications.py has no such concept and will not get one - the
// Streamlit bell is retiring with the rest of the Streamlit app. So the React feed is ahead
// of it by design, and a check that demands they match element for element is asserting
// something nobody wants to be true.
//
// Comparing less is not the answer either: that would leave the newest feature in the feed
// as the only part of it nothing tests. So the check splits.
//
//   1. The kinds BOTH sides build - scan runs and manually-added opportunities - are still
//      compared whole, element by element, on every field. Both halves now read the same
//      window (routes_shell.ts's own exported limits, passed to recent_feed's parameters),
//      so a difference here is a difference in the rule, not in which rows each one saw.
//
//   2. The verdict items, which only React builds, are checked against the DATABASE: that
//      every one of them is an auto row the engine rated Proceed or Park, that the rating
//      picked the icon and the title, that the detail is the row's own title, that the four
//      facts carry the row's own funder, rating, score and deadline - and, in the other
//      direction, that no row the feed should have raised is missing. The harness asserts
//      the rendering; it does not re-derive the rule, so it cannot agree with itself.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireEnv } from "./_env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const D = await mod("supabase/functions/_shared/api/db.ts");
const S = await mod("supabase/functions/_shared/api/routes_shell.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python = process.env.RFPIS_PYTHON || (existsSync(venv) ? venv : "python");
// The limits come from routes_shell.ts, so the Python half reads the window the API reads.
const want = JSON.parse(execFileSync(python,
  [path.join(here, "shell_py.py"), String(S.SCAN_FEED_LIMIT), String(S.RFP_FEED_LIMIT)],
  { encoding: "utf8", maxBuffer: 1 << 26 }));

const FACT_LABELS = ["Funder", "System rating", "Score", "Deadline"];

/** How routes_shell.ts reads one row's verdict. Null when the row is not a verdict row. */
function rating(row) {
  if (String(row.source ?? "").toLowerCase() !== "auto") return null;
  const v = String(row.auto_recommendation ?? "").trim().toLowerCase();
  return v.startsWith("proceed") ? "Proceed" : v === "park" ? "Park" : null;
}

/**
 * Every verdict item, against the row it claims to be about.
 *
 * `cutoff` is the oldest timestamp in the window. Two reads of "the newest 40 by
 * search_date" can tie-break differently when several rows share a timestamp, so rows AT
 * the boundary are not held against either side; everything newer is in both windows.
 */
function verdictProblems(items, rows, cutoff) {
  const out = [];
  const byUid = new Map(rows.filter((r) => String(r.uid ?? "").trim())
    .map((r) => [String(r.uid).trim(), r]));
  for (const it of items) {
    const uid = String(it.uid ?? "").trim();
    if (!uid) {
      out.push(`verdict item "${it.title}": no uid - an alert that names a call must open it`);
      continue;
    }
    const at = `verdict ${uid}`;
    if (it.nav !== "opportunity") out.push(`${at}: nav=${JSON.stringify(it.nav)}, expected "opportunity"`);
    const r = byUid.get(uid);
    if (!r) {
      if (it.ts > cutoff) out.push(`${at}: no such row in the feed window`);
      continue;                       // at the boundary: which tied rows were read is arbitrary
    }
    const rated = rating(r);
    if (!rated) {
      out.push(`${at}: source=${JSON.stringify(r.source)} recommendation=` +
        `${JSON.stringify(r.auto_recommendation)} - only auto rows rated Proceed or Park ` +
        `may appear as verdicts`);
      continue;
    }
    const icon = rated === "Proceed" ? "✅" : "🟡";
    const title = `New ${rated} call`;
    if (it.icon !== icon) out.push(`${at}: icon=${it.icon}, expected ${icon} for ${rated}`);
    if (it.title !== title) out.push(`${at}: title=${JSON.stringify(it.title)}, expected ${JSON.stringify(title)}`);
    const detail = [...String(r.opportunity_title || "Untitled opportunity").trim()].slice(0, 64).join("");
    if (it.detail !== detail) out.push(`${at}: detail=${JSON.stringify(it.detail)}, expected ${JSON.stringify(detail)}`);
    const facts = Array.isArray(it.facts) ? it.facts : null;
    if (!facts) {
      out.push(`${at}: no facts - the Alerts screen would open on an empty card`);
      continue;
    }
    const labels = facts.map((f) => f?.label);
    if (JSON.stringify(labels) !== JSON.stringify(FACT_LABELS)) {
      out.push(`${at}: facts ${JSON.stringify(labels)}, expected ${JSON.stringify(FACT_LABELS)}`);
      continue;
    }
    const score = r.alignment_score == null ? "—" : String(Math.round(Number(r.alignment_score)));
    const values = [String(r.funding_agency || "—"), rated, score, String(r.call_submission_deadline || "—")];
    facts.forEach((f, i) => {
      if (typeof f.value !== "string") out.push(`${at}: ${f.label} is ${typeof f.value}, not a string`);
      else if (f.value !== values[i]) out.push(`${at}: ${f.label}=${JSON.stringify(f.value)}, expected ${JSON.stringify(values[i])}`);
    });
  }
  return out;
}

/** The other direction: every row in the window is represented the way its own fields say. */
function membershipProblems(feed, rows, cutoff) {
  const out = [];
  const seen = new Map();
  for (const it of feed) {
    const uid = String(it.uid ?? "").trim();
    if (uid) seen.set(uid, it.kind);
  }
  for (const r of rows) {
    const uid = String(r.uid ?? "").trim();
    const ts = S.parseTs(r.search_date);
    if (!uid || ts == null || ts <= cutoff) continue;
    const auto = String(r.source ?? "").toLowerCase() === "auto";
    const expect = auto ? (rating(r) ? "verdict" : null) : "opportunity";
    const got = seen.get(uid) ?? null;
    if (expect !== got) {
      out.push(`row ${uid} (source=${r.source ?? "—"}, recommendation=${r.auto_recommendation ?? "—"}): ` +
        `feed has ${got ?? "no item"}, expected ${expect ?? "no item"}`);
    }
  }
  return out;
}

const env = requireEnv(root, "check-shell");
const db = D.createDb({ supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY, jwtSecret: env.SUPABASE_JWT_SECRET });
const shell = S.createShellRoutes(db);
let diffs = 0, bad = 0, verdictsChecked = 0, sharedChecked = 0;
for (const [tid, py] of Object.entries(want)) {
  const t = tid.slice(0, 8);
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
  const feed = (await res.json()).feed;

  // ── 1. the kinds both sides build, compared whole ──────────────────────────
  const shared = feed.filter((it) => it.kind !== "verdict");
  const key = (it) => JSON.stringify([it.ts, it.icon, it.title, it.detail, it.nav, it.uid]);
  const a = shared.map(key), b = py.map(key);
  sharedChecked += a.length;
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    diffs++;
    console.log(`DIFF tenant ${t}: scan+opportunity items ts=${a.length} py=${b.length}`);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) console.log(`  [${i}] ts=${a[i]}\n       py=${b[i]}`);
    }
  }

  // ── 2. the verdict items, which React builds alone, against the rows ───────
  const rows = await db.as(ctx.scope).get("rfp_submissions",
    "select=uid,opportunity_title,source,search_date,auto_recommendation," +
    `alignment_score,funding_agency,call_submission_deadline&order=search_date.desc&limit=${S.RFP_FEED_LIMIT}`)
    .catch(() => []);
  const cutoff = rows.length < S.RFP_FEED_LIMIT
    ? -Infinity : (S.parseTs(rows[rows.length - 1]?.search_date) ?? -Infinity);
  const verdicts = feed.filter((it) => it.kind === "verdict");
  verdictsChecked += verdicts.length;
  const problems = [
    ...verdictProblems(verdicts, rows, cutoff),
    ...membershipProblems(feed, rows, cutoff),
  ];
  // Newest first, across the whole feed: a verdict item inserted out of order would push a
  // scan line below a call older than it.
  for (let i = 1; i < feed.length; i++) {
    if (feed[i].ts > feed[i - 1].ts) problems.push(`item ${i} (${feed[i].title}) is newer than the one above it`);
  }
  if (problems.length) {
    bad++;
    console.log(`BAD tenant ${t}: ${problems.length} verdict problem(s)`);
    for (const p of problems) console.log(`  ${p}`);
  }
}
console.log(`${Object.keys(want).length} tenants checked: ${sharedChecked} scan/opportunity items ` +
  `compared against Python (${diffs} tenants differ), ${verdictsChecked} React-only verdict items ` +
  `checked against the database (${bad} tenants with problems)`);
process.exit(diffs || bad ? 1 : 0);
