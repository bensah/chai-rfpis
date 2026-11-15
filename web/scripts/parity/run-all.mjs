// Every parity check, in order, all of them, whatever any one of them says.
//
//   npm run parity                 (from web/)
//   node scripts/parity/run-all.mjs shell scoring      (just those two)
//
// THE GATE USED TO STOP AT THE FIRST RED ONE. `npm run parity` was twelve commands chained
// with &&, so a single failure meant the checks after it never ran - and nobody could tell
// the difference between "the other nine pass" and "the other nine have not been run since
// Tuesday". check-shell went red on 2026-11-09 and took the six report checks with it,
// silently, for six days.
//
// So: run them all, stream each one's output as it goes, print a table at the end, and exit
// non-zero if ANY of them failed. One red check now costs you one red check.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// The order is the old chain's: cheapest and most foundational first, so that when several
// go red the first line of output is usually the one explaining the rest.
const CHECKS = [
  "permissions", "routing", "shell", "scoring", "rescore",
  "report", "names", "section1", "section2", "section3", "section4", "section5",
];

const pick = process.argv.slice(2).map((a) => a.replace(/^check-|\.mjs$/g, ""));
const unknown = pick.filter((p) => !CHECKS.includes(p));
if (unknown.length) {
  console.error(`unknown check(s): ${unknown.join(", ")}\nknown: ${CHECKS.join(", ")}`);
  process.exit(2);
}
const run = pick.length ? pick : CHECKS;

const results = [];
for (const name of run) {
  console.log(`\n── check-${name} ${"─".repeat(Math.max(0, 60 - name.length))}`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, `check-${name}.mjs`)],
    { stdio: "inherit", env: process.env });
  // A check killed by a signal, or one node could not start, is a failure like any other -
  // `status` is null in both cases and `null !== 0` would read as "passed" to a truthy test.
  const code = r.status == null ? 1 : r.status;
  if (r.error) console.error(`  could not run check-${name}: ${r.error.message}`);
  else if (r.signal) console.error(`  check-${name} was killed by ${r.signal}`);
  results.push({ name, code, ms: Date.now() - started });
}

const failed = results.filter((x) => x.code !== 0);
console.log(`\n── parity ${"─".repeat(60)}`);
for (const { name, code, ms } of results) {
  console.log(`  ${code === 0 ? "PASS" : "FAIL"}  check-${name.padEnd(12)} ${(ms / 1000).toFixed(1)}s` +
    (code === 0 ? "" : `  (exit ${code})`));
}
console.log(`  ${results.length - failed.length}/${results.length} green` +
  (failed.length ? `; failing: ${failed.map((x) => `check-${x.name}`).join(", ")}` : ""));
process.exit(failed.length ? 1 : 0);
