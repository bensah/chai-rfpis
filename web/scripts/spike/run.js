// The scoring trial. Answers three questions, in order:
//   1. do the repo's scoring modules import and run under Pyodide at all?
//   2. do they give the SAME answers as Python, row for row?
//   3. how long does it take — to load once, and per row after that?
const el = document.getElementById("log");
const lines = [];
const log = (s, cls) => {
  lines.push(cls ? `<span class="${cls}">${s}</span>` : s);
  el.innerHTML = lines.join("\n");
  console.log(s.replace(/<[^>]+>/g, ""));
};
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

const t = (() => {
  let last = performance.now();
  return (label) => {
    const now = performance.now();
    const d = now - last;
    last = now;
    log(`  ${label}: ${(d / 1000).toFixed(1)}s`);
    return d;
  };
})();

try {
  log("fetching the fixture…");
  const [pyfiles, snapshot, rows, expected] = await Promise.all(
    ["pyfiles.json", "fixture/snapshot.json", "fixture/rows.json", "fixture/expected.json"]
      .map((f) => fetch(f.startsWith("fixture/") ? f : `fixture/${f}`).then(async (r) => {
        if (!r.ok) throw new Error(`${f}: ${r.status} — run make_fixture.py and build_bundle.mjs first`);
        return r.json();
      })),
  );
  log(`  ${Object.keys(pyfiles).length} python files, ${rows.length} rows, ` +
    `${snapshot.donor_intel.length} donors`);
  t("fetch");

  log("loading pyodide…");
  const { loadPyodide } = await import("https://cdn.jsdelivr.net/pyodide/v0.28.3/full/pyodide.mjs");
  const py = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/" });
  const tPyodide = t("pyodide runtime");

  log("loading packages (pyyaml, pandas)…");
  await py.loadPackage(["pyyaml", "pandas"]);
  const tPackages = t("packages");

  log("writing the repo modules into the runtime…");
  for (const [p, src] of Object.entries(pyfiles)) {
    const dir = p.split("/").slice(0, -1).join("/");
    if (dir) py.FS.mkdirTree(`/app/${dir}`);
    py.FS.writeFile(`/app/${p}`, src);
  }
  py.FS.mkdirTree("/app");
  const tFiles = t("mount");

  log("importing the scoring modules…");
  py.globals.set("snapshot_json", JSON.stringify(snapshot));
  await py.runPythonAsync(`
import sys, json
sys.path.insert(0, "/app")
import db.supabase_client as sc
sc.SNAPSHOT = json.loads(snapshot_json)
_seeded = sc.seed_fx()
from core.assessment import assess_row
`);
  log(`  seeded ${py.globals.get("_seeded")} exchange rates from the snapshot`);
  const tImport = t("import");

  log("scoring…");
  py.globals.set("rows_json", JSON.stringify(rows));
  const warm = await py.runPythonAsync(`
import json, time
_rows = json.loads(rows_json)
t0 = time.perf_counter()
assess_row(dict(_rows[0]))
(time.perf_counter() - t0) * 1000
`);
  log(`  first row (cold): ${warm.toFixed(0)} ms`);
  const out = await py.runPythonAsync(`
t0 = time.perf_counter()
_scores = {str(r["uid"]): assess_row(dict(r)) for r in _rows}
_ms = (time.perf_counter() - t0) * 1000
json.dumps({"scores": _scores, "ms": _ms})
`);
  const { scores, ms } = JSON.parse(out);
  t("scoring");
  log(`  ${rows.length} rows in ${(ms / 1000).toFixed(2)}s (${(ms / rows.length).toFixed(1)} ms/row)`);

  log("\ncomparing with Python…");
  let diffs = 0;
  const keys = new Set();
  for (const v of Object.values(expected)) Object.keys(v).forEach((k) => keys.add(k));
  for (const [uid, want] of Object.entries(expected)) {
    const got = scores[uid];
    if (!got) {
      log(`  MISSING ${uid}`, "bad");
      diffs++;
      continue;
    }
    for (const k of keys) {
      const a = JSON.stringify(want[k] ?? null);
      const b = JSON.stringify(got[k] ?? null);
      if (a !== b) {
        if (diffs < 12) log(`  DIFF ${uid}.${k}: python=${a} browser=${b}`, "bad");
        diffs++;
      }
    }
  }
  log(diffs ? `\n${diffs} differences` : `\nidentical on all ${rows.length} rows`, diffs ? "bad" : "ok");

  // Scoring converts non-USD amounts through core/fx.py, which calls a live rate API over
  // the network. That cannot work here, so check WHICH rate the browser ended up using:
  // if it silently falls back to the static table, a browser score can differ from Python's
  // whenever a band boundary sits between the two rates.
  const fx = JSON.parse(await py.runPythonAsync(`
import json
from core import fx as _fx
try:
    import httpx          # noqa: F401
    _has_httpx = True
except Exception:
    _has_httpx = False
json.dumps({"httpx": _has_httpx,
            "EUR": _fx.to_usd(1000, "EUR"), "GBP": _fx.to_usd(1000, "GBP"),
            "XAF": _fx.to_usd(1000, "XAF")}, default=str)
`));
  log(`\nFX in the browser: httpx available = ${fx.httpx}`);
  for (const c of ["EUR", "GBP", "XAF"]) {
    log(`  ${c}: rate=${fx[c].rate} source=${fx[c].source}`, fx[c].source === "open.er-api.com" ? null : "bad");
  }

  const first = (tPyodide + tPackages + tFiles + tImport) / 1000;
  log(`\nfirst load: ${first.toFixed(1)}s (runtime ${(tPyodide / 1000).toFixed(1)}s, ` +
    `packages ${(tPackages / 1000).toFixed(1)}s, mount ${(tFiles / 1000).toFixed(1)}s, ` +
    `import ${(tImport / 1000).toFixed(1)}s)`);
  log(`per row after that: ${(ms / rows.length).toFixed(1)} ms`);
  log(`python bundle: ${mb(new Blob([JSON.stringify(pyfiles)]).size)}`);
  window.__spike = { diffs, msPerRow: ms / rows.length, firstLoadS: first };
} catch (e) {
  log(`FAILED: ${e.message}\n${e.stack ?? ""}`, "bad");
  window.__spike = { error: String(e.message) };
}
