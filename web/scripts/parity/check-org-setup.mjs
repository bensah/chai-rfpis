// Parity check for Settings → Setup — views/org_setup.py's three saves.
//
//   node scripts/parity/check-org-setup.mjs    (from web/; no database, no writes)
//
// WHY THIS ONE MATTERS MORE THAN A READ CHECK. `check-org.mjs` guards the My Organization
// page, which only displays these two blobs; this guards the only place either is
// AUTHORED, and `core.auto_scorer` reads the result. A value stored outside its
// vocabulary raises nothing anywhere — it matches no call's rule, the criterion scores as
// though the organisation had answered nothing, and the organisation is marked down for a
// field it filled in. Nobody is told, on any screen, ever.
//
// Three claims are worth more than all the case-by-case comparisons:
//
//   1. THE PROFILE SAVE COVERS EVERY PERSISTABLE KEY. `set_profile` REPLACES
//      tenants.org_profile — it is an update, not a merge — so a key the Python sends and
//      this side does not is not a missing feature. It is a field that gets WIPED the
//      first time anybody saves from React, reverting to DEFAULT_PROFILE with no error.
//   2. THE IDENTITY SAVE IS FILTERED BY THE SAME SET. `set_org` ignores unknown keys, so
//      a client cannot invent an identity field — and a key this side sends that the
//      Python would drop is a field the React app believes it saved and did not.
//   3. "Not recorded" and 0 STAY APART. Blank indirect cost leaves MUST-5's component out
//      of the denominator; 0 is a scored answer meaning "we recover no overhead".
//      Collapsing them passes an organisation that never said.
//
// ONE ANSWER KEY. Every expectation comes from the Python, which runs the real
// `set_org` / `set_profile` with their tenant store stubbed and `set_setting` captured —
// so the answers are what those functions decided to persist, not a predicate retyped
// for the test. Adding a case needs no edit here.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const S = await mod("supabase/functions/_shared/api/org_setup.ts");
const V = await mod("supabase/functions/_shared/api/org_vocab.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");

let diffs = 0, checks = 0;
const J = (v) => JSON.stringify(v);
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
const ok = (label, cond, detail = "") => {
  checks++;
  if (cond) return;
  diffs++;
  console.log(`DIFF ${label}${detail ? `\n   ${detail}` : ""}`);
};

let want;
try {
  want = JSON.parse(execFileSync(python, [path.join(here, "org_setup_py.py")], {
    input: "{}", encoding: "utf8", maxBuffer: 1 << 26, stdio: ["pipe", "pipe", "pipe"],
  }));
} catch (e) {
  console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
  process.exit(2);
}

// ── 1. The payload SHAPES, which is where a wipe hides ───────────────────────

same("the identity save writes the editor's nine fields",
  [...S.IDENTITY_FIELDS], want.identity_keys);

same("the fit tab's derived identity keys", [...S.DERIVED_IDENTITY_FIELDS],
  want.derived_identity_keys);

same("the fields re-read after an identity save", [...S.VERIFIED_FIELDS],
  want.verified_fields);

{
  // The profile payload, built from a deliberately EMPTY form. Shape only: what matters
  // is which keys exist, because the ones that don't are the ones that get wiped.
  const keys = Object.keys(S.profileFields({})).sort();
  same("a profile save writes exactly the keys the Python save writes",
    keys, [...want.profile_keys].sort());
  same("...and that is every persistable key in DEFAULT_PROFILE",
    keys, want.persistable_profile_keys);
  ok("the derived key is never among them",
    !keys.includes(S.DERIVED_PROFILE_KEY),
    "org_user_declared_areas is recomputed from the users table on every read. Writing "
    + "it back would freeze one moment's answer into the profile and then go stale the "
    + "next time somebody edits their own account — looking exactly like an admin's "
    + "choice.");
}

// ── 2. `set_org`, against what the real function persisted ───────────────────

for (const [i, c] of want.identity.entries()) {
  same(`set_org #${i} ${J(c.fields)}`, S.setOrgFields(c.fields), c.want);
}

// ── 3. `set_profile`, likewise ───────────────────────────────────────────────

for (const [i, c] of want.profile.entries()) {
  same(`set_profile #${i} strips and stores ${J(Object.keys(c.profile))}`,
    S.stripDerived(c.profile), c.want);
}

// ── 4. The cell and status coercions, lifted out of the view and run ─────────

for (const [i, c] of want.status.entries()) {
  same(`status #${i} ${J(c.value)}`, S.statusList(c.value), c.want);
}
for (const [i, c] of want.cell.entries()) {
  same(`cell #${i} ${J(c.value)}`, S.cell(c.value), c.want);
}

// ── 5. The roster textarea ───────────────────────────────────────────────────

for (const [i, c] of want.team.entries()) {
  same(`team #${i} ${J(c.text)}`, S.teamNames(c.text), c.want);
}
for (const [i, c] of want.roster.entries()) {
  same(`roster #${i} ${J(c.names)}`, S.cleanTeam(c.names), c.want);
}
for (const [i, c] of want.portal.entries()) {
  same(`portal #${i} ${J(c.url)}`, S.cleanPortalUrl(c.url), c.want);
}

// ── 6. The rename failure split ──────────────────────────────────────────────

for (const [i, c] of want.rename.entries()) {
  same(`rename #${i} duplicate? ${J(c.error)}`,
    S.renameOutcome("Acme", c.error).duplicate, c.want);
}

// ── 7. The claims worth naming ───────────────────────────────────────────────

{
  same("the board labels and their stored values", V.BOARD_OPTIONS, want.board_options);

  ok("an unrecognised board answer leaves the MUST-4 gate OFF",
    S.boardValue("something nobody offered") === "",
    '"no" makes a donor requiring a local board a hard disqualifier and "" leaves the '
    + "gate off, so the fallback has to be the one that disqualifies nobody. The "
    + "selectbox falls back to index 0 for the same reason.");

  ok("a board answer sent back as its stored value round-trips",
    S.boardValue("no") === "no" && S.boardValue("yes") === "yes",
    "the page is given the stored value on the read, so a client that echoes it must not "
    + "have it silently reset to unknown.");

  ok("0 is unset for the money fields",
    S.profileFields({ annualBudget: 0, largestGrant: 0 }).org_annual_budget === null,
    "`int(x) or None` in the Python: the widget's own 'unset' is 0, so storing it would "
    + "claim an organisation manages nothing.");

  ok("0 is an ANSWER for the indirect-cost rate",
    S.profileFields({ indirectCostRate: 0 }).org_indirect_cost_rate === 0,
    "blank leaves the MUST-5 component out of the denominator; 0 means 'we recover no "
    + "overhead' and is scored. Collapsing them passes an organisation that never said.");

  ok("...and blank is still null there",
    S.profileFields({ indirectCostRate: "" }).org_indirect_cost_rate === null);

  ok("a legal type outside the vocabulary falls back rather than being stored",
    S.profileFields({ legalType: "Nonprofit" }).org_legal_type === "nonprofit",
    "a client is not a form. Storing 'Nonprofit' matches no call's eligible-applicant "
    + "rule, so MUST-1 scores as though nobody answered — and nothing says so.");

  ok("an entity type the legal type forbids is refused",
    S.profileFields({ legalType: "individual", entityType: "multi_country" })
      .org_entity_type === "individual"
    && S.profileFields({ legalType: "nonprofit", entityType: "individual" })
      .org_entity_type === "",
    "the editor's data-validation rule, from both sides: an individual is offered only "
    + "'individual', and everybody else is not offered it at all.");

  ok("a funding route that is not a stored token is dropped",
    J(S.profileFields({ fundingRoutes: ["grant", "Grants", "subrecipient"] })
      .org_funding_routes) === J(["grant", "subrecipient"]),
    "the editor shows labels and stores tokens. A label stored where a token belongs "
    + "matches no call's offered routes and the MUST-5 gate scores 0.");

  ok("a nameless partner row is dropped, not stored blank",
    S.partnerRows([{ name: "  ", country: "Kenya" }, { name: "Acme" }]).length === 1);

  ok("the flat partner list is written from the table",
    J(S.profileFields({ partners: [{ name: "Acme" }, { name: "Beta" }] }).trusted_partners)
      === J(["Acme", "Beta"]),
    "trusted_partners is what the geographic 'via a partner' check reads. Leaving it "
    + "alone would let the two representations drift the first time somebody edits the "
    + "table.");

  ok("a legacy partner survives into the table it will be saved from",
    S.seedPartners({ partners: [], trusted_academic_institutions: ["Oxford"] })
      .some((p) => p.name === "Oxford"),
    "the save writes `partners` FROM the table, so a legacy name the table never showed "
    + "is gone the first time anybody presses save.");

  ok("...and is not duplicated when it is already structured",
    S.seedPartners({
      partners: [{ name: "Oxford", type: "Academic / research institutions" }],
      trusted_academic_institutions: ["oxford"],
    }).length === 1,
    "matched case-insensitively, as the Python's `_seen` set is.");

  ok("a save that cleared a field is not reported as a failed write",
    S.notPersisted({ org_team: "" }, { org_team: "Business Development Team" }).length === 0,
    "`get_org` substitutes placeholders for blanks, so a deliberately cleared field reads "
    + "back as its default. Checking it would report a phantom failure on a save that did "
    + "exactly what was asked.");

  ok("a field that really did not land IS reported",
    J(S.notPersisted({ org_name: "Acme" }, { org_name: "Your Organization" }))
      === J(["org_name"]),
    "the common failure here is not an exception: an RLS or wrong-key write returns "
    + "success and changes nothing.");

  ok("a blank organisation name implies no rename",
    S.renameImplied({ org_name: "   " }) === null
    && S.renameImplied({ org_short: "A" }) === null);

  ok('"Other" is never stored as a team member',
    !S.cleanTeam(["Jane", "Other"]).includes("Other"),
    "core/dropdowns.py APPENDS Other to the roster when it builds the Proposal lead / "
    + "Contributors / Reviewers lists, so a roster that stores it offers it twice — and "
    + "picking the stored one files the work under a person who does not exist.");

  ok("the generated portal seed is already clean by this rule",
    V.DONOR_PORTAL_SEED.every((p) => S.cleanPortalUrl(p) === p),
    "the editor UNIONS the seed with the live donor_intel hosts. If the TypeScript "
    + "cleaner disagreed with the Python one that produced the seed, the same portal "
    + "would appear twice — and ticking the wrong one records a registration against a "
    + "host no donor matches.");

  ok("a partial identity save keeps the stored keys it did not touch",
    S.mergedIdentity({ org_name: "Acme", org_short: "A" }, { org_country: "Kenya" })
      .org_short === "A",
    "set_org is a partial upsert onto the stored blob — the FIT tab writes three "
    + "competitiveness keys through it and must not blank the branding.");

  ok("...including the logo, which lives in the same blob",
    S.mergedIdentity({ org_logo_b64: "iVBORw0KGgo=", org_logo_mime: "image/png" },
      { org_name: "Acme" }).org_logo_b64 === "iVBORw0KGgo=",
    "org_logo_b64 is a key on org_identity, not a column. Writing the merged-with-"
    + "defaults identity back would make Save the only control on the page that deletes "
    + "a logo, and nothing would say it had.");
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
