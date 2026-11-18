// Parity check for extraction coverage — core/field_extract.py + the catalogue it writes.
//
//   node scripts/parity/check-extraction.mjs    (from web/; reads the live stores, writes nothing)
//
// WHAT THIS GUARDS, AND WHY IT IS NOT THE USUAL SHAPE
// ---------------------------------------------------
// Most checks here compare a TypeScript port against the Python it was ported from. There
// is no port to compare for this one: `web/src/pages/OpportunityPage.tsx` runs
// `core/opportunity_detail.py` itself, in the browser's Python engine, so the page's layout
// and the Python's are one implementation and cannot drift.
//
// What CAN drift is the data behind it, and that is what the owner was looking at when they
// said a discovered call lands almost empty. So this check guards the extraction contract
// instead:
//
//   1. COVERAGE DOES NOT REGRESS. A floor over the live catalogue, per the measurement in
//      `scripts/measure_extraction_coverage.py`. A change that quietly stops filling a
//      field fails here rather than being noticed on a page weeks later.
//   2. NOTHING CLAIMS A COLUMN THAT DOES NOT EXIST. `field_extract.DERIVED_FIELDS` names
//      columns; a typo makes PostgREST reject the whole update, taking the valid fields in
//      the same request with it, and the backfill reports it per row rather than failing.
//   3. NO PLACEHOLDER IS EVER STORED. "Unspecified Program Area" reads as POPULATED to
//      every blank test in the codebase, `opportunity_detail.coverage` included. Storing it
//      would raise the number this check defends while telling a reviewer nothing, which is
//      the one way to pass criterion 1 dishonestly.
//   4. THE PASS IS IDEMPOTENT. `derive_fields` fills blanks only, so re-deriving a field a
//      row already carries must produce nothing. That is what makes the backfill safe to
//      re-run and what stops it overwriting a value a person corrected.
//
// ONE ANSWER KEY, as everywhere in this directory: `extraction_py.py` reads the stores and
// the field lists, and this side asserts over what it returns. Adding a derived field needs
// no edit here.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");

// THE FLOOR, and why it is set where it is.
//
// Measured 2026-11-18 over 1687 live catalogue rows: 41.6% of the 41-field schema, 0 rows
// at the owner's 80% bar. `scripts/backfill_field_extract.py` was applied the same day and
// the measurement then read 48.3%, matching its dry run to a tenth of a point. The
// deterministic pass also runs inside extraction, so new rows arrive with those fields.
//
// The floor is a point under that, not at it. It is a REGRESSION guard rather than a
// target: its job is to fail when a change stops filling fields, and a floor set exactly
// at the current reading would go red on the ordinary churn of the catalogue — a week of
// thin new rows moves the average without anything being wrong.
//
// It is NOT the owner's 80%, and should not be raised towards it on principle. Seven of
// the 41 fields name facts the sources do not publish (measured — see
// `measure_extraction_coverage.py --availability` and docs/EXTRACTION_COVERAGE_REPORT.md),
// which caps this number around 83% even if everything else were perfect. Raise the floor
// when a change earns it, and say in the commit which change.
const COVERAGE_FLOOR = 47.0;

let diffs = 0, checks = 0;
const ok = (label, cond, detail = "") => {
  checks++;
  if (cond) return;
  diffs++;
  console.log(`DIFF ${label}${detail ? `\n   ${detail}` : ""}`);
};

let got;
try {
  got = JSON.parse(execFileSync(python, [path.join(here, "extraction_py.py")], {
    encoding: "utf8", maxBuffer: 1 << 26, stdio: ["pipe", "pipe", "pipe"],
  }));
} catch (e) {
  console.log(`check-extraction: could not run the Python half: ${e.message}`);
  process.exit(1);
}

if (!got.rows) {
  console.log("check-extraction: the catalogue is empty — nothing to check");
  process.exit(0);
}

// 1. coverage floor
ok(`coverage.overall >= ${COVERAGE_FLOOR}%`,
  got.coverage.overall_pct >= COVERAGE_FLOOR,
  `measured ${got.coverage.overall_pct}% over ${got.rows} rows x ${got.schema_fields.length} fields`);

// 2. every derived field is a real column, and one the store will actually write
const missingColumns = got.derived_fields.filter((f) => !got.catalog_columns.includes(f));
ok("every DERIVED_FIELD is a column on extracted_solicitations",
  missingColumns.length === 0, `not columns: ${missingColumns.join(", ")}`);

const notAllowed = got.derived_fields.filter((f) => !got.allowed_columns.includes(f));
ok("every DERIVED_FIELD is in core/extracted_store._COLS",
  notAllowed.length === 0,
  `extracted_store would silently drop: ${notAllowed.join(", ")}`);

// 3. no placeholder is stored in a field the schema measures
ok("no schema field stores a placeholder value",
  got.placeholders.length === 0,
  `these read as populated and say nothing: ${got.placeholders.join(", ")}`);

// 4. blanks only — a field already on the row is never re-derived
const sample = got.sample || {};
const clash = (sample.derived || []).filter((f) => (sample.already_set || []).includes(f));
ok("derive_fields fills blanks only",
  clash.length === 0,
  `row ${sample.uid} would overwrite: ${clash.join(", ")}`);

// A field the schema measures but nothing can ever derive or synthesise is the
// schema-removal question, not a failure. Reported, never failed on.
const dead = got.schema_fields.filter((f) => (got.coverage.per_field_pct[f] ?? 0) === 0);
if (dead.length) {
  console.log(`NOTE ${dead.length} schema field(s) are populated on NO row: ${dead.join(", ")}`);
  console.log("     `scripts/measure_extraction_coverage.py --availability` says whether");
  console.log("     that is our gap or a fact no funder publishes.");
}

console.log(`check-extraction: ${checks - diffs}/${checks} checks passed over ` +
  `${got.rows} catalogue rows (coverage ${got.coverage.overall_pct}%, ` +
  `${got.coverage.rows_at_80_pct}% of rows at 80%)`);
process.exit(diffs ? 1 : 0);
