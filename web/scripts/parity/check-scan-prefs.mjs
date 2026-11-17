// Parity check for Settings → Setup → Scan Preferences.
//
//   node scripts/parity/check-scan-prefs.mjs     (from web/; no database, no writes)
//
// WHAT THESE RULES DECIDE. They run at SCAN time, before scoring: an opportunity that
// fails the country or theme gate is never inserted, so it is not a low score somebody
// can argue with — it does not exist, and nothing on any screen explains a call that was
// never captured. That is why the shape of the saved document matters more here than the
// value of any one field.
//
// THE SAVE REPLACES THE WHOLE DOCUMENT. `set_policies` "stores the FULL blob (not a
// delta) for simplicity", so a key the Python writes and this side does not is a field
// WIPED on the first React save. The one key the editor deliberately omits —
// `scoring_rules` — survives only because `_blank_policies()` carries the same
// funding-quality tiers. Both halves of that are asserted: that it is omitted, and that
// the base rescues it. If anybody ever makes the base truly blank, every save silently
// resets the tiers and this check is the only thing that would notice.
//
// ONE ANSWER KEY: the key set is lifted from the editor's own `new_pol` dict, the
// defaults from DEFAULT_POLICIES, the aliases from core/dropdowns.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const S = await mod("supabase/functions/_shared/api/scan_prefs.ts");

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
  want = JSON.parse(execFileSync(python, [path.join(here, "scan_prefs_py.py")], {
    input: "{}", encoding: "utf8", maxBuffer: 1 << 26, stdio: ["pipe", "pipe", "pipe"],
  }));
} catch (e) {
  console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
  process.exit(2);
}

// ── 1. The payload SHAPE, which is where a wipe hides ────────────────────────

{
  const built = S.policyPayload({});
  same("a policy save writes exactly the keys the editor writes",
    Object.keys(built), want.saved_top_keys);
  same("...and the nine criteria it writes under `criteria`",
    Object.keys(built.criteria), want.saved_criteria_keys);
  same("the criteria are the scorer's own nine", want.saved_criteria_keys, want.criteria);

  same("the one DEFAULT_POLICIES key the editor omits", want.omitted, ["scoring_rules"]);
  ok("...and it is the key this side omits too",
    !Object.hasOwn(built, S.POLICY_KEY_NOT_WRITTEN)
    && S.POLICY_KEY_NOT_WRITTEN === want.omitted[0]);

  ok("the omitted key survives ONLY because the merge base carries it",
    want.blank_has_scoring_rules
    && J(want.blank_scoring_rules) === J(want.default_scoring_rules),
    "`_blank_policies()` holds the same funding-quality tiers as DEFAULT_POLICIES, which "
    + "is what makes omitting scoring_rules from every save harmless. Make the base truly "
    + "blank and every save silently resets the tiers — with nothing else to notice.");

  same("POLICY_KEYS matches what is written", [...S.POLICY_KEYS], want.saved_top_keys);
}

// ── 2. The defaults, which decide what an omitted flag means ─────────────────

{
  const built = S.policyPayload({});
  ok("every reject flag defaults TRUE",
    built.exclusions.reject_training_only === true
    && built.exclusions.reject_loans === true
    && built.exclusions.reject_consultancies === true
    && built.exclusions.reject_reimbursement === true
    && built.eligibility.reject_applicant_type_mismatch === true
    && built.countries.permissive_when_silent === true,
    "these are REJECT rules. A missing value defaulting to false would quietly admit the "
    + "thing the rule exists to exclude, and a client is not a form — it can omit "
    + "anything.");

  ok("a flag explicitly sent false IS false",
    S.policyPayload({ exclusions: { reject_loans: false } })
      .exclusions.reject_loans === false);

  ok("an empty applicant-type list becomes [\"nonprofit\"]",
    J(S.policyPayload({ eligibility: { org_applicant_types: [] } })
      .eligibility.org_applicant_types) === J(["nonprofit"]),
    "the Python's `or [\"nonprofit\"]`. An empty list matches no call's "
    + "eligible-applicant rule at all, so it rejects EVERYTHING rather than nothing — "
    + "the opposite of what clearing a field looks like it should do.");

  ok("terms are trimmed and blanks dropped, order kept",
    J(S.policyPayload({ countries: { eligible: ["  Mali  ", "", "Cameroon"] } })
      .countries.eligible) === J(["Mali", "Cameroon"]));

  ok("every criterion gets both term lists, even when the form sends none",
    want.criteria.every((c) => {
      const r = S.policyPayload({}).criteria[c];
      return Array.isArray(r.positive) && Array.isArray(r.negative);
    }),
    "a criterion missing from the document is a criterion whose crawl assist silently "
    + "stops working.");
}

// ── 3. The geo seed, which decides whether the gate is on at all ─────────────

{
  const withScope = { countries: { eligible: ["Mali"], broad_terms: [] } };
  same("the seeder no-ops on an explicit country scope",
    S.seedGeo(withScope, { org_registered_countries: ["Kenya"] }), withScope);

  const regionOnly = { countries: { eligible: [], broad_terms: ["Sub-Saharan Africa"] } };
  same("...and on a deliberate region-only scope",
    S.seedGeo(regionOnly, { org_registered_countries: ["Kenya"] }), regionOnly);

  ok("an empty scope IS seeded from the profile",
    J(S.seedGeo({ countries: { eligible: [], broad_terms: [] } },
      { org_registered_countries: ["Kenya"], org_operating_countries: ["Mali"] })
      .countries.eligible) !== J([]),
    "the Python's reason, verbatim: \"Never PERSIST a geo-empty policy for a tenant that "
    + "HAS a geography in its profile — a saved blank scope would otherwise read as 'see "
    + "everything'.\" An empty scope is PERMISSIVE, so leaving the form blank would turn "
    + "the hard gate off for exactly the tenants most likely to leave it blank.");

  same("an empty scope with an empty profile stays empty",
    S.seedGeo({ countries: { eligible: [], broad_terms: [] } }, {}),
    want.seed_noop_when_no_profile);
}

// ── 4. The currency table, where a dropped field is a dead rate ──────────────

// Row for row, against `core/dropdowns.currency_aliases` itself — not against whatever
// survived the filter, which would let a comparison pass by dropping the rows it could
// not answer for.
for (const [i, c] of want.currency.entries()) {
  const inputs = (c.rows ?? []).filter((r) => r && typeof r === "object");
  same(`currency aliases #${i} ${J(c.rows)}`, inputs.map((r) => S.aliasesOf(r)), c.want);
}
{
  const { rows, dropped } = S.currencyRows([
    { code: "gbp", label: "GBP", symbol: "£", aliases: ["GBP £", "£"], usd_rate: 1.33 },
    { code: "EUR", usd_rate: 0 },
    { code: "", usd_rate: 1 },
    { code: "GBP", usd_rate: 9 },
  ]);
  ok("a code is upper-cased", rows[0]?.code === "GBP",
    "it is matched against a call's own currency field, which is written \"USD\". "
    + "\"usd\" would match nothing while looking right.");
  ok("the whole row survives — label, symbol, aliases, rate",
    rows[0]?.label === "GBP" && rows[0]?.symbol === "£"
    && J(rows[0]?.aliases) === J(["GBP £", "£"]) && rows[0]?.usd_rate === 1.33,
    "the stored list REPLACES the YAML wholesale, so a field this forgets is a field "
    + "gone from the deployment. Aliases are how \"£\" and \"FCFA\" are matched to a rate "
    + "at all — neither appears in any code or label.");
  ok("a non-positive, missing or unparseable rate drops the row", dropped === 3,
    `dropped=${dropped}. A zero or negative rate converts every amount in that currency `
    + "to zero or to nonsense, and every award-size comparison downstream agrees without "
    + "complaint.");
  ok("a duplicate code keeps the first", rows.length === 1);

  ok("the legacy alias key is still read",
    J(S.currencyRows([{ code: "XAF", donor_aliases: ["FCFA"], usd_rate: 1 }])
      .rows[0].aliases) === J(["FCFA"]),
    "the Settings editor spent a while writing `donor_aliases`, so a deployment that "
    + "pressed Save holds rows in that shape. Refusing them would turn a dead lookup into "
    + "a broken one.");

  ok("...but only `aliases` is written back",
    Object.hasOwn(S.currencyRows([{ code: "X", donor_aliases: ["a"], usd_rate: 1 }])
      .rows[0], "aliases"),
    "canonical in the YAML, in the stored JSON and in money.ts.");

  ok("a blank symbol is null, not an empty string",
    S.currencyRows([{ code: "XAF", symbol: "", usd_rate: 1 }]).rows[0].symbol === null,
    "what the Python writes and what the stored rows hold; \"\" reads as a symbol that is "
    + "nothing.");
}

// ── 5. The search terms ──────────────────────────────────────────────────────

for (const [i, c] of want.terms.entries()) {
  same(`search terms #${i} ${J(c.value)}`, S.searchTerms(c.value), c.want);
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
