// Where the parity checks find SUPABASE_URL / SUPABASE_KEY.
//
// This was copy-pasted into five checks, each looking only in the working directory and the
// repo root. That is fine in the main checkout and wrong in a git WORKTREE, where `.env` is
// not tracked and therefore does not exist: check-routing and check-shell both died with
// "Cannot read properties of undefined (reading 'replace')" — a message that says nothing
// about the actual problem, from a check that should have said "no credentials here".
//
// Two sessions then independently patched it by hard-coding an absolute path, which works
// on exactly one machine. So: one helper, and it DERIVES the main checkout rather than
// naming it. In a worktree `.git` is a FILE reading `gitdir: <main>/.git/worktrees/<name>`,
// so the main checkout is the grandparent of that gitdir's parent.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** The main checkout, when `dir` is a git worktree; otherwise null. */
export function mainCheckout(dir) {
  try {
    const dotGit = path.join(dir, ".git");
    if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) return null;
    const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    // <main>/.git/worktrees/<name>  →  <main>
    const gitdir = path.resolve(dir, m[1].trim());
    const idx = gitdir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
    return idx === -1 ? null : gitdir.slice(0, idx);
  } catch {
    return null;
  }
}

/**
 * `.env` as a plain object, from the first of these that has one: the working directory,
 * the repo root, and — when the root is a worktree — the main checkout it was cut from.
 * Later files do not override earlier ones.
 */
export function loadEnv(root) {
  const env = {};
  const dirs = [process.cwd(), root];
  const main = mainCheckout(root);
  if (main) dirs.push(main);
  env.__searched = dirs.join(path.delimiter);
  for (const dir of dirs) {
    const f = path.join(dir, ".env");
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return env;
}

/**
 * The env, or a clear exit. A check that needs credentials and has none should say so in
 * one line naming where it looked — not crash inside `createDb` on an undefined URL.
 */
export function requireEnv(root, what = "this check") {
  const env = loadEnv(root);
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
    console.log(`No SUPABASE_URL / SUPABASE_KEY in any .env — ${what} needs the live database.`);
    console.log(`Looked in: ${env.__searched}`);
    process.exit(2);
  }
  return env;
}
