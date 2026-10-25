// Collect the Python the browser needs into one JSON file: {path: source}.
//
//   node web/scripts/spike/build_bundle.mjs
//
// Everything under core/ and config/ goes in as-is — the scoring modules must be the SAME
// code Streamlit runs — plus the two stand-ins from browser_stubs/ that replace the database
// layer. The result is written to fixture/pyfiles.json (gitignored: it is a copy of the repo).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

function walk(dir, filter, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__pycache__") continue;
      walk(p, filter, out);
    } else if (filter(name)) {
      out.push(p);
    }
  }
  return out;
}

const files = {};
const add = (abs, as) => {
  files[as.split(path.sep).join("/")] = readFileSync(abs, "utf8");
};

for (const f of walk(path.join(root, "core"), (n) => n.endsWith(".py"))) {
  add(f, path.relative(root, f));
}
for (const f of walk(path.join(root, "config"), (n) => n.endsWith(".yaml") || n.endsWith(".yml"))) {
  add(f, path.relative(root, f));
}
// The stand-ins come last, so they shadow the real db/ and auth/ modules.
for (const f of walk(path.join(here, "browser_stubs"), (n) => n.endsWith(".py"))) {
  add(f, path.relative(path.join(here, "browser_stubs"), f));
}
files["db/__init__.py"] = "";
files["auth/__init__.py"] = "";

const out = path.join(here, "fixture", "pyfiles.json");
writeFileSync(out, JSON.stringify(files));
const bytes = Buffer.byteLength(JSON.stringify(files));
console.log(`${Object.keys(files).length} files, ${(bytes / 1e6).toFixed(1)} MB → ${out}`);
