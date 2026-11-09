// Parity check for the Report foundations: funder identity, person names, the curated
// keyword vocabulary, and programme areas.
//
//   node scripts/parity/check-names.mjs     (from web/; reads the live database, read-only)
//
// These are not a section of the report — they are what several sections are BUILT from.
// "Which funders our calls come from" groups by funder identity; the whole of Team &
// Partners is person names; the focus-area cloud is programme areas. Each is a rule where a
// plausible re-implementation gets most rows right and splits one real person, or one real
// funder, across two bars, which reads as a smaller relationship than the organisation has.
//
// So the inputs are the LIVE COLUMNS, not invented examples: every funding_agency, every
// submitted_by / proposal_lead / contributors value, every title+brief, every
// call_domain_areas value in rfp_submissions. Hand-picked cases test what the author thought
// of; the real column tests what people actually typed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv, requireEnv } from "./_env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const D = await mod("supabase/functions/_shared/api/db.ts");
const N = await mod("supabase/functions/_shared/api/report_names.ts");
const K = await mod("supabase/functions/_shared/api/report_keywords.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");
const py = (what, cases) => {
  try {
    return JSON.parse(execFileSync(python, [path.join(here, "names_py.py"), what], {
      input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 1 << 26,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (e) {
    console.error(`\nThe Python side failed on "${what}":\n${e.stderr || e.message}`);
    process.exit(2);
  }
};

let diffs = 0, checks = 0;
// Key order is not a difference: Python dicts and JS objects both preserve insertion order,
// and the two sides insert in whatever order they happen to iterate. Arrays stay ordered.
const canon = (v) => (v === null || typeof v !== "object" ? v
  : Array.isArray(v) ? v.map(canon)
  : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])));
const J = (v) => JSON.stringify(canon(v));
const same = (label, ts, pyv) => {
  checks++;
  if (J(ts) !== J(pyv)) {
    diffs++;
    console.log(`DIFF ${label}\n   ts: ${J(ts)}\n   py: ${J(pyv)}`);
  }
};
/** For a long per-row comparison: report the first few differing rows, not all of them. */
const sameEach = (label, tsArr, pyArr, inputs) => {
  let bad = 0;
  for (let i = 0; i < Math.max(tsArr.length, pyArr.length); i++) {
    checks++;
    if (J(tsArr[i]) === J(pyArr[i])) continue;
    diffs++;
    if (++bad <= 5) {
      console.log(`DIFF ${label} [${i}] input=${J(inputs[i])}\n   ts: ${J(tsArr[i])}\n   py: ${J(pyArr[i])}`);
    }
  }
  if (bad > 5) console.log(`   … and ${bad - 5} more ${label} rows differ`);
};

// ── The live rows ────────────────────────────────────────────────────────────
const env = loadEnv(root);
if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
  console.log("No SUPABASE_URL / SUPABASE_KEY in .env — cannot run against live rows.");
  process.exit(2);
}
const db = D.createDb({
  supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY,
  jwtSecret: env.SUPABASE_JWT_SECRET ?? "",
});
const rows = await db.service.get("rfp_submissions",
  "select=funding_agency,submitted_by,proposal_lead,contributors,reviewers," +
  "opportunity_title,brief_description,call_domain_areas&limit=50000");
console.log(`${rows.length} live rows`);

// ── 1. The three name maps resolve from the same stores ──────────────────────
// The algorithm matters less than this: a roster read from the global store instead of the
// tenant's would canonicalise one organisation's names against another's team.
const cfg = py("config", null);
{
  // No tenant on either side: the Python's `_scoped_store` returns None, so BOTH read the
  // global app_settings row. That is the single-tenant deployment, and it is the case where
  // reading only tenant_settings would silently hand back an empty roster.
  const got = await N.loadNameConfig(db, null);
  same("nickname map", got.nicknames, cfg.nicknames);
  same("alias map", got.aliases, cfg.aliases);
  same("roster (no tenant → global store)", got.roster, cfg.roster);
  console.log(`name config: roster ${cfg.roster.length} (python, ambient tenant), `
    + `${Object.keys(cfg.nicknames).length} nicknames, ${Object.keys(cfg.aliases).length} aliases`);
}
// Every member comparison below uses the PYTHON's resolved config, so a roster difference
// cannot hide an algorithm difference behind it.
const names = N.createNames({
  roster: cfg.roster, nicknames: cfg.nicknames, aliases: cfg.aliases,
});

// ── 2. Funder identity over every funding_agency in the table ────────────────
{
  const values = rows.map((r) => r.funding_agency ?? "");
  const want = py("funders", values);
  sameEach("canonicalFunder", values.map((v) => N.canonicalFunder(v)), want.canonical, values);
  sameEach("funderKey", values.map((v) => N.funderKey(v)), want.key, values);
  same("dominantSpelling over the whole column", N.dominantSpelling(values), want.dominant);
  same("groupByFunder", N.groupByFunder(values), want.groups);
  const groups = N.groupByFunder(values);
  const merged = Object.values(groups).filter((g) => Object.keys(g.variants).length > 1).length;
  console.log(`funders checked: ${Object.keys(groups).length} identities from `
    + `${new Set(values.filter(Boolean)).size} spellings, ${merged} of them written more than one way`);
}

// ── 3. Person names over every column that holds one ─────────────────────────
{
  const raw = [];
  for (const r of rows) {
    for (const c of ["submitted_by", "proposal_lead", "contributors", "reviewers"]) {
      if (r[c] !== null && r[c] !== undefined) raw.push(r[c]);
    }
  }
  // Single values too: the comma-splitting path and the single-name path reach
  // normalize_member_name differently, and only the second exercises the alias map directly.
  const singles = [...new Set(raw.filter((v) => typeof v === "string").flatMap((v) => v.split(",").map((s) => s.trim())))]
    .filter(Boolean).slice(0, 2000);
  const want = py("members", { raw, singles, canonical: [] });
  sameEach("normalizeMemberName", singles.map((v) => names.normalizeMemberName(v)), want.normalized, singles);
  sameEach("splitAndNormalizeNames", raw.map((v) => names.splitAndNormalizeNames(v)), want.split, raw);

  // The display map runs over the canonical names the split actually produced — which is
  // where the "one person written two ways" rule either merges two bars or does not.
  const canonical = [...new Set(raw.flatMap((v) => names.splitAndNormalizeNames(v)))];
  const wantDisp = py("members", { raw: [], singles: [], canonical });
  same("firstNameDisplayMap", names.firstNameDisplayMap(canonical), wantDisp.display);
  const labels = new Set(Object.values(names.firstNameDisplayMap(canonical)));
  console.log(`members checked: ${raw.length} column values → ${canonical.length} canonical `
    + `names → ${labels.size - 1} chart labels`);
}

// ── 3b. The branches the live data never reaches ──────────────────────────
//
// Sections 2 and 3 run over the real columns, which is the right primary test — but today
// that data has every funder written exactly one way and no nicknames or aliases configured.
// The dash-folding rule and the nickname and alias paths are therefore EXECUTED by every
// call and DISTINGUISHED by none: a wrong implementation of them would pass.
//
// So: constructed inputs that reach those branches, with both sides given the same config.
// The names are obvious inventions; real ones are data and stay in the database.
{
  const FUNDERS = [
    "BMGF - Gates Foundation",            // ASCII hyphen
    "BMGF – Gates Foundation",            // en dash, what Excel autocorrect produces
    "BMGF — Gates Foundation",            // em dash
    "BMGF ‐ Gates Foundation",            // Unicode hyphen
    "BMGF − Gates Foundation",            // minus sign
    "BMGF -­ Gates Foundation",            // soft hyphen, invisible, pasted from a PDF
    "BMGF  -  Gates   Foundation",        // whitespace runs
    "  BMGF - Gates Foundation  ",        // outer whitespace
    "ＢＭＧＦ - Gates Foundation",            // full-width letters, folded by NFKC
    "bmgf - gates foundation",            // case: same KEY, different spelling
    "BMGF, Gates Foundation",             // punctuation: same key, different canonical form
    "Française", "Francaise",             // documented as deliberately NOT the same key
    "", "   ", null,
  ];
  const want = py("funders", FUNDERS);
  sameEach("canonicalFunder (constructed)", FUNDERS.map((v) => N.canonicalFunder(v)), want.canonical, FUNDERS);
  sameEach("funderKey (constructed)", FUNDERS.map((v) => N.funderKey(v)), want.key, FUNDERS);
  same("dominantSpelling (constructed)", N.dominantSpelling(FUNDERS), want.dominant);
  same("groupByFunder (constructed)", N.groupByFunder(FUNDERS), want.groups);
  // The point of the exercise, stated so a future reader can see it was actually reached.
  const keys = new Set(FUNDERS.filter(Boolean).map((v) => N.funderKey(v)).filter(Boolean));
  console.log(`constructed funders: ${FUNDERS.length} spellings → ${keys.size} identities `
    + `(the dash family, casing and punctuation all collapse; Française/Francaise stay apart)`);
}
{
  const CONFIG = {
    roster: ["Ada Nwosu", "Ada Okafor", "Drew Hall", "Kit Mensah", "Other"],
    nicknames: { kit: "christopher", drew: "andrew" },
    aliases: { "ada": "Ada Nwosu" },
  };
  const RAW = [
    "Ada", "ADA NWOSU", "ada nwosu", "Prof Ada Nwosu", "Dr. Drew Hall",
    "Kit Mensah", "Christopher Mensah", "Kit", "Drew", "Andrew Hall",
    "Ada Okafor", "Ada Nwosu, Drew Hall", "  Kit Mensah ,, Ada Okafor ",
    ["Ada Nwosu", "Drew Hall"], ["Ada Nwosu, Kit Mensah"],
    "Other", "Prof", "Dr", "", "   ", null,
  ];
  const singles = RAW.filter((v) => typeof v === "string");
  const names2 = N.createNames(CONFIG);
  const canonical = [...new Set(RAW.flatMap((v) => names2.splitAndNormalizeNames(v)))];
  const want = py("members_cfg", { config: CONFIG, raw: RAW, singles, canonical });
  sameEach("normalizeMemberName (configured)", singles.map((v) => names2.normalizeMemberName(v)),
    want.normalized, singles);
  sameEach("splitAndNormalizeNames (configured)", RAW.map((v) => names2.splitAndNormalizeNames(v)),
    want.split, RAW);
  same("firstNameDisplayMap (configured)", names2.firstNameDisplayMap(canonical), want.display);
  console.log(`configured members: alias, nickname, honorific, ALL-CAPS and list-with-commas `
    + `paths all exercised → ${canonical.length} canonical names`);
}

// ── 4. The curated keyword vocabulary over every title + brief ───────────────
{
  // Generated file first: an edit to core/keyword_cloud.py that was never regenerated would
  // otherwise pass here while the deployed API used the old word list.
  try {
    execFileSync(python, [path.join(root, "scripts/gen_keyword_vocab.py"), "--check"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    console.log("report_vocab.ts is current");
  } catch (e) {
    diffs++; checks++;
    console.log(`DIFF ${(e.stdout || e.message).trim()}`);
  }

  const texts = rows.map((r) => `${r.opportunity_title ?? ""} ${r.brief_description ?? ""}`);
  const want = py("keywords", texts);
  sameEach("tokenize", texts.map((t) => K.tokenize(t)), want.tokens, texts.map((t) => t.slice(0, 60)));
  sameEach("extractKeywordFrequencies (per row)",
    texts.map((t) => K.extractKeywordFrequencies([t])), want.freq_each, texts.map((t) => t.slice(0, 60)));
  same("extractKeywordFrequencies (whole corpus)", K.extractKeywordFrequencies(texts), want.freq_all);
  console.log(`keywords checked over ${texts.length} titles+briefs, `
    + `${Object.keys(want.freq_all).length} stems present in the corpus`);
}

// ── 5. Programme areas ───────────────────────────────────────────────────────
{
  const areaRows = rows.map((r) => ({ call_domain_areas: r.call_domain_areas ?? null }));
  const want = py("areas", areaRows);
  same("programmeAreaFreq", K.programmeAreaFreq(areaRows), want.freq);
  const canon = {};
  for (const k of Object.keys(want.canonical)) canon[k] = K.canonicalArea(k);
  same("canonicalArea", canon, want.canonical);
  console.log(`areas checked: ${Object.keys(want.freq).length} distinct areas over `
    + `${areaRows.filter((r) => r.call_domain_areas).length} rows that carry any`);
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
