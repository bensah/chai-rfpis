// Parity check for the report snapshot store — the `?r=YYYYMMDD-NNNNNN` link.
//
//   node scripts/parity/check-snapshots.mjs    (from web/)
//
// THE ONLY CHECK IN THIS DIRECTORY THAT TOUCHES NO DATABASE, and deliberately so. The real
// store is a single live `app_settings` row holding every report link anyone has generated,
// shared by every tenant and pruned to the newest 100. A check that saved into it would
// quietly evict a hundred real links per run. Both halves run against an in-memory store
// instead, and the Python half asserts the settings key it is asked for so a mistake there
// is an error rather than a write.
//
// There is no live data to lean on either, which is the point: the store's whole behaviour
// is in its edges — a snapshot older than a metric, a store at exactly the cap, a `created_at`
// that is missing, an id that collides. None of those occur in the live row today, so every
// case here is hand-built, one per rule, named for the rule it covers.
//
// The CATALOGUE is checked against `views/report.py`'s own `_REPORT_SECTIONS`, lifted with
// `ast`. The server now owns that list — a snapshot records which metric keys were ON, and
// restoring it compares that against the keys that exist NOW, so the two copies going out of
// step is exactly the bug `restoreItems` was written to fix, arriving by a different door.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const S = await mod("supabase/functions/_shared/api/report_snapshots.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");
const py = (payload) => {
  try {
    return JSON.parse(execFileSync(python, [path.join(here, "snapshots_py.py")], {
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

const KEYS = [...S.ALL_KEYS];
const SECS = [...S.ALL_SEC_IDS];

// ── restore_items: which metrics come back on ────────────────────────────────
//
// Each case is named for the rule it exercises, because the three inputs look
// interchangeable and are not: `items` is what was ON, `universe` is what EXISTED, and the
// gap between them is every behaviour below.
const ITEM_CASES = [
  { name: "no items saved at all", items: null, universe: null },
  { name: "items saved as a string, not a list", items: "s1_donor", universe: null },
  // The one that surprises people: an EMPTY selection with no recorded universe restores as
  // everything, because "nothing was on" and "nothing existed yet" are the same list.
  { name: "empty selection, no universe", items: [], universe: null },
  { name: "empty selection WITH a universe", items: [], universe: KEYS },
  { name: "one metric, no universe", items: ["s1_donor"], universe: null },
  { name: "one metric WITH a universe", items: ["s1_donor"], universe: KEYS },
  // The bug this function exists for: a metric added after the snapshot was saved is not in
  // its universe, so it comes back ON rather than silently missing.
  {
    name: "a metric added after the snapshot",
    items: ["s1_donor", "s5_conv"],
    universe: KEYS.filter((k) => k !== "s5_cumusd"),
  },
  { name: "a metric REMOVED since the snapshot", items: ["gone_key", "s1_donor"], universe: KEYS },
  { name: "a removed metric that was its own universe", items: ["gone_key"], universe: ["gone_key"] },
  { name: "universe stored as something other than a list", items: ["s1_donor"], universe: "all" },
  { name: "duplicate keys in items", items: ["s1_donor", "s1_donor"], universe: KEYS },
  { name: "non-strings in items", items: ["s1_donor", 5, null, true], universe: KEYS },
  { name: "non-strings in the universe", items: ["s1_donor"], universe: [1, "s1_donor"] },
  { name: "no keys exist at all", items: ["s1_donor"], universe: null, allKeys: [] },
];

// ── _restored_secs: which SECTIONS come back on ──────────────────────────────
const SEC_CASES = [
  { name: "no sections saved", secs: null },
  { name: "sections saved as a string", secs: "2" },
  { name: "empty section list", secs: [] },
  { name: "sections in the snapshot's own order", secs: ["2", "1"] },
  { name: "a section id that no longer exists", secs: ["9", "1"] },
  { name: "a duplicated section id", secs: ["1", "1"] },
  { name: "non-strings among the ids", secs: ["1", 4, null] },
  { name: "every section", secs: SECS },
];

// ── "✎ Selections changed" ───────────────────────────────────────────────────
const CUR = {
  period: "Year to date", year: 2026, month: "June", view: "Monthly",
  secs: [...SECS].sort(), items: [...KEYS].sort(),
};
const snap = (o) => ({ ...CUR, all_items: [...KEYS].sort(), all_secs: [...SECS].sort(), ...o });
const CHANGED_CASES = [
  { name: "the link holds exactly what is on screen", snap: snap({}), cur: CUR },
  { name: "a different period", snap: snap({ period: "All time" }), cur: CUR },
  { name: "a different year", snap: snap({ year: 2025 }), cur: CUR },
  { name: "a different view", snap: snap({ view: "Quarterly" }), cur: CUR },
  { name: "the same sections in a different order", snap: snap({ secs: [...SECS].reverse() }), cur: CUR },
  { name: "one section switched off", snap: snap({ secs: SECS.slice(1) }), cur: CUR },
  { name: "one metric deliberately switched off", snap: snap({ items: KEYS.filter((k) => k !== "s5_cumusd").sort() }), cur: CUR },
  // A snapshot from before that metric existed: its `all_items` predates it too, which is
  // what makes the restore widen the selection — see the claim below.
  {
    name: "a snapshot predating a metric",
    snap: snap({
      items: KEYS.filter((k) => k !== "s5_cumusd").sort(),
      all_items: KEYS.filter((k) => k !== "s5_cumusd").sort(),
    }),
    cur: CUR,
  },
  { name: "a snapshot with no recorded universe", snap: (() => { const s = snap({}); delete s.all_items; return s; })(), cur: CUR },
  // `int(_sel("year", 0))` has no except around it in report.py, so this takes the page
  // down rather than falling back. The port answers "changed" instead.
  { name: "a stored year of null", snap: snap({ year: null }), cur: CUR },
  { name: "no snapshot at all", snap: null, cur: CUR },
  { name: "an empty snapshot object", snap: {}, cur: CUR },
];

// ── save_snapshot: the id, the merge and the prune ───────────────────────────
const SEL = { period: "All time", year: 2026, month: "June", view: "Monthly", secs: ["1"], items: ["s1_donor"] };
const entry = (ts) => ({ created_at: ts, selection: SEL });
/** A store of `n` entries, oldest first, one minute apart. */
const storeOf = (n, from = 0) => {
  const d = {};
  for (let i = 0; i < n; i++) {
    const mm = String(from + i).padStart(2, "0");
    d[`20260101-${String(100000 + from + i)}`] = entry(`2026-01-01T00:${mm}:00`);
  }
  return d;
};
const full = storeOf(S.SNAPSHOT_MAX);
const tied = (() => {
  const d = storeOf(S.SNAPSHOT_MAX);
  // Five entries sharing one timestamp, at the boundary the prune cuts on.
  const keys = Object.keys(d).slice(0, 5);
  for (const k of keys) d[k] = entry("2026-01-01T00:00:00");
  return d;
})();
const noStamp = (() => {
  const d = storeOf(S.SNAPSHOT_MAX);
  delete d[Object.keys(d)[40]].created_at;      // an entry with no created_at at all
  return d;
})();

const SAVE_CASES = [
  { name: "the very first snapshot", before: null, rand: [42] },
  { name: "a store that is not JSON", before: "{{{", rand: [42] },
  { name: "a few saved already", before: JSON.stringify(storeOf(5)), rand: [7] },
  { name: "the random id needs zero padding", before: null, rand: [7] },
  { name: "the id collides once", before: JSON.stringify({ "20261115-000042": entry("2026-11-15T00:00:00") }), rand: [42, 77] },
  // 21 candidates, all colliding: the Python stops retrying and uses the last one, which
  // OVERWRITES the snapshot already there. Vanishingly unlikely, but it has an answer.
  { name: "the id collides every time", before: JSON.stringify({ "20261115-000042": entry("2026-11-15T00:00:00") }), rand: [42] },
  { name: "exactly at the cap", before: JSON.stringify(full), rand: [55] },
  { name: "a tie on created_at at the cut", before: JSON.stringify(tied), rand: [55] },
  { name: "an entry with no created_at", before: JSON.stringify(noStamp), rand: [55] },
  { name: "over the cap already", before: JSON.stringify(storeOf(S.SNAPSHOT_MAX + 7)), rand: [55] },
].map((c) => ({ ...c, today: "2026-11-15", now: "2026-11-15T09:30:15", selection: SEL, by: "a@b.c" }));

// ── _load / get_snapshot over a stored value that may be anything ────────────
const GOOD = JSON.stringify({ a: entry("2026-01-01T00:00:00"), b: { created_at: "x" }, c: { created_at: "x", selection: [1, 2] } });
const LOAD_CASES = [
  { name: "never saved", raw: null },
  { name: "empty string", raw: "" },
  { name: "not JSON", raw: "{{{" },
  { name: "a JSON array, not an object", raw: "[]" },
  { name: "a JSON number", raw: "5" },
  { name: "a JSON string", raw: '"hello"' },
  { name: "JSON null", raw: "null" },
  { name: "a real store", raw: GOOD },
].map((c) => ({ ...c, get: ["a", "b", "c", "missing", ""] }));

const want = py({
  restoreItems: ITEM_CASES,
  restoreSecs: SEC_CASES,
  changed: CHANGED_CASES,
  saves: SAVE_CASES,
  loads: LOAD_CASES,
});

// ── The catalogue, against report.py's own ───────────────────────────────────
same("the section/metric catalogue matches views/report.py", JSON.parse(J(S.REPORT_SECTIONS)), want.catalog);
same("_ALL_KEYS", KEYS, want.allKeys);
same("_ALL_SEC_IDS", SECS, want.allSecIds);

for (const [i, c] of ITEM_CASES.entries()) {
  const ts = S.restoreItems(c.items, c.allKeys ?? KEYS, c.universe).sort();
  same(`restoreItems — ${c.name}`, ts, want.restoreItems[i]);
}
for (const [i, c] of SEC_CASES.entries()) {
  same(`restoreSecs — ${c.name}`, S.restoreSecs(c.secs, SECS), want.restoreSecs[i]);
}
for (const [i, c] of CHANGED_CASES.entries()) {
  const tsChanged = S.signatureOf(c.cur) !== S.signatureOf(c.snap);
  const p = want.changed[i];
  if (p.crash) {
    ok(`changed — ${c.name}: the Python raises ${p.err}, the port answers "changed"`, tsChanged === true);
  } else {
    same(`changed — ${c.name}`, tsChanged, p.changed);
  }
}
for (const [i, c] of SAVE_CASES.entries()) {
  const p = want.saves[i];
  let n = 0;
  const store = S.parseStore(c.before);
  const rid = S.mintRid(store, c.today.replace(/-/g, ""), () => c.rand[Math.min(n++, c.rand.length - 1)]);
  const after = S.insertSnapshot(store, rid, "2026-11-15T09:30:15", c.selection);
  same(`save — ${c.name}: rid`, rid, p.rid);
  same(`save — ${c.name}: ids kept, in order`, Object.keys(after), p.keys);
  same(`save — ${c.name}: the stored object`, JSON.parse(J(after)), p.after);
  same(`save — ${c.name}: random draws`, n, p.randCalls);
}
for (const [i, c] of LOAD_CASES.entries()) {
  const store = S.parseStore(c.raw);
  const p = want.loads[i];
  same(`load — ${c.name}: ids`, Object.keys(store).sort(), p.keys);
  same(`load — ${c.name}: get_snapshot`, c.get.map((r) => S.getSelection(store, r)), p.get);
  same(`load — ${c.name}: get_snapshot(null)`, S.getSelection(store, null), p.getNone);
}

// ── Claims about the store itself ────────────────────────────────────────────
//
// Each of these is a property somebody will reasonably want to change one day. They are
// asserted by name so that changing one is a decision with a failing test attached, rather
// than something a refactor can do by accident.

ok("the store is ONE app_settings key, shared by every tenant",
  S.SNAPSHOT_KEY === "report_snapshots_json",
  `report_snapshots_json is not in core.settings._TENANT_SCOPED_KEYS, so a link minted in one `
  + `tenant resolves in another and one tenant's Generates evict another's. Scoping it would `
  + `break every ?r= link in circulation.`);

ok("the window is the newest 100", S.SNAPSHOT_MAX === 100,
  "which is what \"that link says the report wasn't found\" means.");

{
  // Proof, not a restatement of the constant: 101 in, 100 out, and the one that goes is the
  // oldest by created_at rather than the oldest key or the one just added.
  const store = S.parseStore(JSON.stringify(full));
  const oldest = Object.keys(store)[0];
  const after = S.insertSnapshot(store, "20261115-000055", "2026-11-15T09:30:15", SEL);
  ok("a save at the cap drops the OLDEST, and keeps the new one",
    Object.keys(after).length === S.SNAPSHOT_MAX
    && !(oldest in after) && "20261115-000055" in after);
}

{
  // The asymmetry between the two restores. It has not bitten yet because no section has
  // been added since the feature shipped; it will the day one is.
  const olderSecs = SECS.filter((s) => s !== "5");
  const olderItems = KEYS.filter((k) => !k.startsWith("s5_"));
  ok("a metric added later comes back ON, a SECTION added later stays OFF",
    S.restoreItems(olderItems, KEYS, olderItems).includes("s5_cumusd")
    && !S.restoreSecs(olderSecs, SECS).includes("5"),
    "restore_items treats an unknown key as new-and-on; _restored_secs simply filters, so a "
    + "whole new section is invisible on every older snapshot — including the metrics inside "
    + "it that restore_items just switched on.");
}

{
  // Why a restored older link shows "✎ Selections changed" the moment it opens: the
  // signature is built from what was SAVED, and the restore legitimately widens it. The
  // distinction that makes this case real is `all_items` — a snapshot from BEFORE the
  // metric existed does not list it there either.
  const old = KEYS.filter((k) => k !== "s5_cumusd").sort();
  const older = snap({ items: old, all_items: old });
  const deliberate = snap({ items: old });                 // same items, but it knew the key
  const restore = (s) => ({ ...s, items: S.restoreItems(s.items, KEYS, s.all_items).sort() });
  ok("restoring a snapshot that PREDATES a metric reports \"changed\" immediately",
    S.signatureOf(restore(older)) !== S.signatureOf(older)
    && S.signatureOf(restore(deliberate)) === S.signatureOf(deliberate),
    "not a port difference — the banner is telling the truth, because re-Generating really "
    + "would save a different selection from the one the link holds. A metric switched off "
    + "ON PURPOSE is left off, and that link opens clean.");
}

ok("an empty selection with no recorded universe restores as EVERYTHING on",
  S.restoreItems([], KEYS, null).length === KEYS.length,
  "a pre-all_items snapshot saved with every metric unticked cannot be told from one saved "
  + "before any metric existed, and the tie is broken towards showing content.");

{
  // Why POST /report/snapshot filters what it stores. An unknown key is dropped by
  // `restoreItems` but kept by `signatureOf`, which reads the raw saved list — so the
  // restored selection can never equal the saved one and the "✎ Selections changed" banner
  // never goes away, on a link whose selection is in fact exactly what was asked for.
  const junk = { ...CUR, items: [...KEYS, "not_a_metric"].sort(), all_items: [...KEYS, "not_a_metric"].sort() };
  const clean = { ...CUR, items: [...KEYS].sort(), all_items: [...KEYS].sort() };
  const restore = (s) => ({ ...s, items: S.restoreItems(s.items, KEYS, s.all_items).sort() });
  ok("storing a key that does not exist would strand the link on \"changed\" for ever",
    S.signatureOf(restore(junk)) !== S.signatureOf(junk)
    && S.signatureOf(restore(clean)) === S.signatureOf(clean),
    "restoreItems drops the unknown key, signatureOf keeps it, and the two can never agree "
    + "again — which is what the route's filter is for.");
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
