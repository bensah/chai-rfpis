// Parity check: run the React page's donor model (src/donors/model.ts) over saved donor rows
// and compare it with the Python page's own helpers (output of a reference run over the
// same rows). Usage: node scripts/compare-with-python.mjs <donors.json> <python_out.json>
import { readFileSync } from "node:fs";
import { createServer } from "vite";

const [donorsPath, pyPath] = process.argv.slice(2);
const donors = JSON.parse(readFileSync(donorsPath, "utf8"));
const py = JSON.parse(readFileSync(pyPath, "utf8"));

const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const m = await server.ssrLoadModule("/src/donors/model.ts");
const schema = m.buildSchema(donors);

const diffs = [];
const flagsTs = new Set(schema.flags);
const flagsPy = new Set(py.flags);
for (const f of flagsPy) if (!flagsTs.has(f)) diffs.push(`flag only in Python: ${f}`);
for (const f of flagsTs) if (!flagsPy.has(f)) diffs.push(`flag only in React: ${f}`);
for (const [col, lbl] of Object.entries(py.labels)) {
  if (m.label(col) !== lbl) diffs.push(`label ${col}: py=${JSON.stringify(lbl)} ts=${JSON.stringify(m.label(col))}`);
}
for (const r of donors) {
  const want = py.rows[r.canonical_key];
  const c = m.completeness(r, schema);
  if (JSON.stringify([c.pct, c.have, c.total]) !== JSON.stringify(want.c)) {
    diffs.push(`completeness ${r.canonical_key}: py=${want.c} ts=${[c.pct, c.have, c.total]}`);
  }
  if (m.normalizeCategory(r.donor_category) !== want.cat) diffs.push(`category ${r.canonical_key}: py=${want.cat} ts=${m.normalizeCategory(r.donor_category)}`);
  if (m.titleName(r) !== want.title) diffs.push(`title ${r.canonical_key}: py=${want.title} ts=${m.titleName(r)}`);
  if (m.disp(r.donor_summary_description) !== want.summary) diffs.push(`summary text differs: ${r.canonical_key}`);
}
if (py.filters) {
  const keys = (rows) => rows.map((r) => r.canonical_key).sort();
  const base = { ...m.EMPTY_FILTERS };
  for (const [cat, want] of Object.entries(py.filters.areas)) {
    const got = keys(m.applyFilters(donors, { ...base, areas: [cat] }, schema));
    if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(`area filter "${cat}": py=${want.length} ts=${got.length}`);
  }
  for (const [g, want] of Object.entries(py.filters.geo)) {
    const got = keys(m.applyFilters(donors, { ...base, fundsIn: [g] }, schema));
    if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(`geo filter "${g}": py=${want.length} ts=${got.length}`);
  }
  console.log(`${Object.keys(py.filters.areas).length} area filters, ${Object.keys(py.filters.geo).length} geo filters checked`);
}
await server.close();
console.log(`${donors.length} donors, ${schema.flags.length} flags, ${Object.keys(py.labels).length} labels checked`);
console.log(diffs.length ? `${diffs.length} differences:\n` + diffs.slice(0, 40).join("\n") : "no differences");
process.exit(diffs.length ? 1 : 0);
