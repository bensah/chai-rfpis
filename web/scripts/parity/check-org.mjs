// Parity check for My Organization — core/org_profile.py and core/profile_completeness.py.
//
//   node scripts/parity/check-org.mjs    (from web/; reads the live database, read-only)
//
// The page is read-only, which makes it sound low-stakes. It is not: what it shows is the
// profile THE MATCHING ENGINE READS, and the number at the top is the app telling a tenant
// how much they can trust their own scores. Three ways to get that wrong:
//
//   THE MERGE      a stored blob is merged onto DEFAULT_PROFILE, so a missing default
//                  silently changes what an unconfigured tenant is told about itself
//   THE RENAMES    a profile saved before the 2026 key renames is read through
//                  _RENAMED_KEYS. Miss one and a field that IS set reads as empty — the
//                  bar drops, the page says "not screening-ready", and nothing explains it
//   THE WEIGHTS    completeness is weighted, and the page prints the first SIX missing
//                  labels, so the order is part of the answer and not a detail
//
// Every live tenant's real blobs go through both implementations, and then a set of
// hand-built overlays covers what no live tenant happens to have: a legacy key, both keys
// at once, a JSON string instead of an object, and a zero where a number is expected.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv } from "./_env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const O = await mod("supabase/functions/_shared/api/org.ts");
const V = await mod("supabase/functions/_shared/api/org_vocab.ts");
const D = await mod("supabase/functions/_shared/api/db.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");
const py = (payload) => {
  try {
    return JSON.parse(execFileSync(python, [path.join(here, "org_py.py")], {
      input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 1 << 28,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (e) {
    console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
    process.exit(2);
  }
};

let diffs = 0, checks = 0;

/**
 * Compare by VALUE, not by key order.
 *
 * `DEFAULT_PROFILE` is generated with sorted keys and the Python's own dict keeps
 * insertion order, so a plain `JSON.stringify` reported all 42 fields as differing when
 * every value matched. Key order is not a fact about a profile — nothing reads these
 * objects positionally — so it is canonicalised away rather than asserted.
 */
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  }
  return v;
};
const J = (v) => JSON.stringify(canon(v));
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

const env = loadEnv(root);
const db = D.createDb({
  supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY,
  jwtSecret: env.SUPABASE_JWT_SECRET,
});

// Every real tenant, plus the hand-built overlays no live row happens to carry.
const live = await db.service.get("tenants", "select=id,name,org_identity,org_profile");
console.log(`${live.length} tenants`);

const SYNTH = [
  // A legacy key alone — it must be READ, under its new name.
  { id: "synth-legacy", name: "Legacy Co",
    org_profile: { countries_of_operation: ["Cameroon"], domains: ["IDs - Malaria"] } },
  // BOTH keys. The rename only fires when the new one is ABSENT, so the new one wins and
  // the old is dropped; a port that renamed unconditionally would show the stale value.
  { id: "synth-both", name: "Both Co",
    org_profile: {
      countries_of_operation: ["Chad"], org_operating_countries: ["Mali"],
    } },
  // Stored as a JSON STRING, which is what the single-tenant text column holds.
  { id: "synth-string", name: "String Co",
    org_profile: '{"org_operating_countries": ["Kenya"], "org_annual_budget": 500000}' },
  // ZERO where a number is expected. An org never has a $0 budget, so it counts as UNSET
  // and the completeness bar must not credit it.
  { id: "synth-zero", name: "Zero Co",
    org_profile: { org_annual_budget: 0, org_largest_grant: 0, org_max_target: 0 } },
  // Unparseable, and a non-object — both are "no overlay", not an error.
  { id: "synth-junk", name: "Junk Co", org_profile: "{not json" },
  { id: "synth-list", name: "List Co", org_profile: [1, 2, 3] },
  // No profile at all: the defaults, whole.
  { id: "synth-empty", name: "Empty Co", org_profile: null },
  // An identity blob whose org_name disagrees with tenants.name — the COLUMN wins,
  // because the editor's "Organization name" field is the tenant rename.
  { id: "synth-name", name: "Real Name",
    org_identity: { org_name: "Stale Name", org_country: "Mali" } },
  // A nested dict in the overlay: dicts deep-merge, lists replace wholesale.
  { id: "synth-nested", name: "Nested Co",
    org_profile: { org_domain_ratings: { "IDs - Malaria": 5 }, proposal_languages: ["French"] } },
];

const CODES = ["nonprofit", "government", "higher_ed", "for_profit", "individual", "tribal",
  "", "   ", "something_else", "grassroot_local", "multi_country", null];

const tenants = [...live, ...SYNTH];
const want = py({ tenants, codes: CODES });

// 1. The generated tables are the Python's.
same("DEFAULT_PROFILE", V.DEFAULT_PROFILE, want.defaults);
same("_ORG_DEFAULTS", V.ORG_DEFAULTS, want.org_defaults);
same("_RENAMED_KEYS", V.RENAMED_KEYS, want.renamed);

// 2. Every tenant, live and synthetic, through both implementations.
for (const [i, t] of tenants.entries()) {
  const w = want.tenants[i];
  const label = `${t.id === undefined ? "?" : String(t.id).slice(0, 12)} (${t.name ?? ""})`;
  const profile = O.mergeProfile(t.org_profile);
  const identity = O.mergeIdentity(t.name, t.org_identity);
  same(`profile ${label}`, profile, w.profile);
  same(`identity ${label}`, identity, w.identity);

  const { pct, missing } = O.completeness(identity, profile);
  same(`completeness ${label}`, [Math.round(pct * 1e9) / 1e9, missing],
    [Math.round(w.pct * 1e9) / 1e9, w.missing]);
  same(`band ${label}`, O.ragBand(pct), w.band);
  same(`readiness gap ${label}`, O.readinessGap(profile), w.gap);
  same(`domain ratings ${label}`, O.ratingRows(profile.org_domain_ratings), w.domain);
  same(`priority ratings ${label}`, O.ratingRows(profile.org_priority_ratings), w.priority);
}

// 3. The labels.
same("legal_type_label", CODES.map((c) => O.legalTypeLabel(c)), want.legal);
same("entity_type_label", CODES.map((c) => O.entityTypeLabel(c)), want.entity);

// 4. The claims worth naming, so a future change has to argue with them.
{
  // THE CLAIM THIS CHECK GOT WRONG FIRST TIME. The port was asserted to DROP the legacy
  // key once the new one wins. It does not, and neither does the Python: `_migrate_keys`
  // is `if old in overlay and new not in overlay`, so when both are present it pops
  // nothing, and `_deep_merge` then carries the legacy key into the merged profile as a
  // forty-third field.
  //
  // Asserted as it is rather than as it ought to be. Nothing reads the stray key — every
  // consumer asks for `org_operating_countries` — so it is inert rather than wrong, and
  // "tidy it up in the port" would be the port and the Python disagreeing about what a
  // profile contains. Tidying it belongs in `_migrate_keys`, for both.
  const both = O.mergeProfile({ countries_of_operation: ["Chad"], org_operating_countries: ["Mali"] });
  ok("when both keys are present the CURRENT one wins",
    J(both.org_operating_countries) === J(["Mali"]), J(both.org_operating_countries));
  ok("and the legacy key survives alongside it, inert, exactly as the Python leaves it",
    both.countries_of_operation !== undefined
    && J(both.countries_of_operation) === J(["Chad"]),
    "a port that dropped it would disagree with core/org_profile.py about what a profile "
    + "contains, for a key nothing reads.");

  const zero = O.mergeProfile({ org_annual_budget: 0 });
  ok("a stored zero counts as UNSET, not as a budget",
    !O.filled(zero.org_annual_budget)
    && O.completeness({}, zero).missing.includes("annual budget"),
    "an organisation never has a $0 budget, and crediting it would show a complete "
    + "profile the matching engine cannot use.");

  ok("an unconfigured tenant still gets every default",
    Object.keys(O.mergeProfile(null)).length === Object.keys(V.DEFAULT_PROFILE).length);

  const lists = O.mergeProfile({ proposal_languages: ["French"] });
  ok("a list REPLACES rather than merging",
    J(lists.proposal_languages) === J(["French"]),
    "the default is [\"English\"]; appending would tell the scorer we bid in a language "
    + "nobody chose.");

  ok("the column beats the blob for the display name",
    O.mergeIdentity("Real Name", { org_name: "Stale Name" }).org_name === "Real Name",
    "the editor's \"Organization name\" field IS the tenant rename, so the blob's copy "
    + "can be stale.");

  ok("a blank identity falls back to placeholders, never to another org's name",
    O.mergeIdentity("", {}).org_name === V.ORG_DEFAULTS.org_name);

  // The gap names only what is missing — telling somebody to add a country they have
  // already set is how a nudge becomes noise.
  same("the gap names only the missing half",
    O.readinessGap({ org_operating_countries: ["Mali"] }), ["at least one program area"]);
  same("and only the other half the other way",
    O.readinessGap({ org_domain_expertise: ["IDs - Malaria"] }),
    ["at least one country of operation"]);
  same("a ready profile has an empty gap",
    O.readinessGap({ org_operating_countries: ["Mali"], org_priority_areas: ["IDs - Malaria"] }), []);

  // The bands, at their exact edges — the product rule of 2026-08-01.
  same("the band edges", [0.5, 0.500001, 0.79, 0.8, 1].map((x) => O.ragBand(x)),
    ["red", "amber", "amber", "green", "green"]);

  ok("a rated area carries its category, not just its name",
    O.ratingRows({ "IDs - Malaria": 4 })[0].category === "Infectious Diseases",
    J(O.ratingRows({ "IDs - Malaria": 4 })));
  ok("an unknown prefix falls back to itself rather than vanishing",
    O.categoryFull("ZZZ - Something") === "ZZZ");
  ok("a key with no prefix is all sub-area",
    O.subareaLabel("Malaria") === "Malaria" && O.categoryFull("Malaria") === "Malaria");
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
