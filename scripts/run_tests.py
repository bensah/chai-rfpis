"""Run the test suite with one process per test module.

WHY THIS EXISTS. `python -m unittest discover -s tests -t tests` runs all 126 modules in a
single interpreter, and the suite is not safe there. Whichever module imports
`auth.tenant_context` first binds `st` for the whole process, so the result depends on
alphabetical order: modules that install a fake `streamlit` into `sys.modules` and modules
that need the real library for `AppTest` cannot both be satisfied in one process. That left
15 tests failing in two modules (`test_session_identity_isolation`, `test_workbook_isolation`)
even though BOTH pass on their own. The alternative was a refactor across ~12 modules to make
the stubbing uniform; this runner fixes the whole class of problem instead, by giving every
module a fresh interpreter with a clean `sys.modules`.

Usage:
    python scripts/run_tests.py                     # every module
    python scripts/run_tests.py test_tenant_url     # just these (names or paths)
    python scripts/run_tests.py --jobs 1            # serial, for a definitive answer

Measured on 2026-10-24, 126 modules / 2122 tests: 118s at the default --jobs 8, 579s serial.
A fresh interpreter per module costs about 3.8x serially, which is why the default is
concurrent -- at 118s this is still faster than the old single-process `discover` run (153s),
and unlike that run it is correct.

Some modules talk to the shared Supabase instance, so concurrency is not provably free: both
settings were verified green here, but if a module fails in a way that looks unrelated to
your change, re-run it with `--jobs 1` before believing it.

Exit code is 0 only when every module passes — and a module that collects NO
tests counts as a failure, because this runner cannot otherwise tell a module
that passed from a module it could not collect. See `_ALLOWED_EMPTY`.
"""
from __future__ import annotations

import argparse
import ast
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TESTS_DIR = REPO_ROOT / "tests"

# `.sync-conflict-*.py` duplicates are written by Syncthing into this tree. They match
# test_*.py, so discovery would run stale copies of real tests beside the live ones.
_CONFLICT = "sync-conflict"

_RAN = re.compile(r"^Ran (\d+) tests? in ([\d.]+)s", re.M)
_COUNT = re.compile(r"(failures|errors|skipped)=(\d+)")

# A MODULE THAT COLLECTS NOTHING IS A FAILURE, and the reason is not that zero is
# suspicious.
#
# `unittest discover` only collects `TestCase` subclasses. A module of bare
# `def test_*` functions — pytest's idiom — raises nothing, prints OK and runs
# none of its tests, so this runner could not tell a module that PASSED from a
# module it could not COLLECT. Both arrived here as rc=0 with no failures.
#
# That is not hypothetical. Over 2026-11-18/19 eleven modules across two sessions
# were in that state, about 190 tests, among them the guard against stored scores
# falsely claiming to be current — the test protecting a defect that had just
# shipped was itself running nowhere. Three sessions said "the suite is green"
# while it was false, and the suite agreed with them every time.
#
# So: a module reporting 0 tests fails, and says "collected 0 tests" rather than
# counting failures it never ran.
#
#: Modules that are legitimately empty. An explicit list HERE rather than a
#: marker inside the file, because an empty module is rare enough to be worth
#: naming in one place, and a per-file marker is one more thing that can be
#: pasted into a file that should not have it.
_ALLOWED_EMPTY: frozenset[str] = frozenset()


def loose_test_functions(path: Path) -> list[str]:
    """Module-level `def test_*` in `path` — the tests unittest will NOT run.

    THE SECOND SHAPE, AND THE WORSE ONE. The zero-test guard above catches a
    module unittest could not collect at all. It cannot catch a module that has a
    `TestCase` AND loose `def test_*` functions beside it: the class makes the
    module look collected, the count is non-zero so a count-based sweep passes it,
    and the loose functions silently never run. Nothing about it looks wrong.

    Once the runner is unittest, a test file has no business holding a loose test
    function at all, so this is a flat rule rather than a heuristic — there is no
    legitimate case to carve out, which is why it has no opt-out list.

    PARSED, NOT GREPPED. `^def test_` finds the same thing far more cheaply and is
    wrong here: this very repo has a module whose fixtures are Python source in
    triple-quoted strings, and a regex reads those as declarations. `ast` sees
    only what is actually defined, and `tree.body` is module level by
    construction. A file that does not parse returns nothing — a syntax error is
    the interpreter's to report, and it will, loudly.
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, SyntaxError):
        return []
    return [node.name for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name.startswith("test_")]


def module_names(selected: list[str]) -> list[str]:
    """Test modules to run: everything discoverable, or just what was asked for."""
    if selected:
        return [Path(s).stem for s in selected]
    found = (p.stem for p in TESTS_DIR.glob("test_*.py") if _CONFLICT not in p.name)
    return sorted(found)


def run_module(name: str) -> dict:
    """Run one module in its own interpreter. Returns a result dict; never raises."""
    env = dict(os.environ)
    env["PYTHONPATH"] = str(REPO_ROOT)
    # Child output is parsed here, so pin it to UTF-8: several tests print symbols that
    # the console codepage cannot encode, and the child would die writing them.
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    started = time.time()
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "unittest", "discover",
             "-s", str(TESTS_DIR), "-t", str(TESTS_DIR), "-p", f"{name}.py"],
            cwd=str(REPO_ROOT), env=env, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=900,
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        rc = proc.returncode
    except subprocess.TimeoutExpired:
        return {"name": name, "ok": False, "tests": 0, "detail": "TIMEOUT after 900s",
                "elapsed": time.time() - started, "output": ""}

    ran = _RAN.search(out)
    counts = {k: int(v) for k, v in _COUNT.findall(out)}
    bad = counts.get("failures", 0) + counts.get("errors", 0)
    tests = int(ran.group(1)) if ran else 0
    detail = ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "ok"
    ok = rc == 0 and bad == 0
    # See `_ALLOWED_EMPTY`. Keyed on the COUNT, not on the exit code, because the
    # exit code for this case is a moving target: Python 3.12+ returns 5 for "no
    # tests ran" while older interpreters return 0, so on one machine an empty
    # module already failed — with `detail` reading "ok", which is its own small
    # lie — and on another it passed outright. The count is the same everywhere.
    #
    # Skipped when the module reported real failures or errors: those already have
    # a better explanation than this one, and relabelling an import traceback as
    # "collected 0 tests" would bury the traceback.
    # The second shape — see `loose_test_functions`. Checked even when the module
    # passed with a healthy count, because that is exactly how this one hides.
    #
    # `_ALLOWED_EMPTY` does NOT excuse it. That list means "this module
    # legitimately defines no tests"; a module holding test functions unittest
    # will not run is not empty, it is broken, and silencing it would make the
    # opt-out a way to hide the worse of the two faults.
    loose = loose_test_functions(TESTS_DIR / f"{name}.py")
    shown = ", ".join(loose[:4]) + (f" (+{len(loose) - 4} more)" if len(loose) > 4
                                    else "")
    if bad == 0 and (loose or tests == 0):
        if loose and tests == 0:
            # Both at once, which is what a whole pytest-style module looks like.
            # Lead with the louder fact and let the loose functions explain it.
            ok = False
            detail = (f"collected 0 tests — all {len(loose)} of its test functions "
                      f"are module-level, which unittest does not collect: {shown}. "
                      "Move them into a TestCase; see loose_test_functions in "
                      "scripts/run_tests.py")
        elif loose:
            ok = False
            detail = (f"{len(loose)} module-level test function(s) that unittest "
                      f"will NOT run, beside {tests} that it did: {shown}. Move "
                      "them into a TestCase; see loose_test_functions in "
                      "scripts/run_tests.py")
        elif name in _ALLOWED_EMPTY:
            # Named as legitimately empty, so forgive the exit code too: Python
            # 3.12+ returns 5 for "no tests ran", which would otherwise fail the
            # module the list exists to permit.
            ok = True
            detail = "collected 0 tests (allowed)"
        else:
            ok = False
            detail = ("collected 0 tests — unittest found no TestCase here; see "
                      "the note above _ALLOWED_EMPTY in scripts/run_tests.py")
    return {
        "name": name,
        "ok": ok,
        "tests": tests,
        "detail": detail,
        "elapsed": time.time() - started,
        "output": out,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("modules", nargs="*", help="module names or paths; default is all")
    ap.add_argument("--jobs", "-j", type=int, default=8,
                    help="modules to run at once (default 8; use 1 to rule out DB races)")
    ap.add_argument("--quiet", "-q", action="store_true",
                    help="only print failing modules as they finish")
    args = ap.parse_args()

    names = module_names(args.modules)
    if not names:
        print("No test modules found.")
        return 1

    print(f"Running {len(names)} modules, one process each, jobs={args.jobs}\n")
    started = time.time()
    results: list[dict] = []

    def report(r: dict) -> None:
        results.append(r)
        if r["ok"] and args.quiet:
            return
        mark = "ok  " if r["ok"] else "FAIL"
        print(f"  {mark} {r['name']:<52} {r['tests']:>4} tests  "
              f"{r['elapsed']:>6.1f}s  {r['detail']}")

    if args.jobs > 1:
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            for r in pool.map(run_module, names):
                report(r)
    else:
        for name in names:
            report(run_module(name))

    failed = [r for r in results if not r["ok"]]
    total_tests = sum(r["tests"] for r in results)

    print(f"\n{'-' * 70}")
    print(f"{len(results)} modules, {total_tests} tests, {time.time() - started:.1f}s")

    if failed:
        print(f"\n{len(failed)} MODULE(S) FAILED:\n")
        for r in failed:
            print(f"=== {r['name']} ({r['detail']}) ===")
            tail = [ln for ln in r["output"].splitlines() if ln.strip()][-25:]
            print("\n".join(tail))
            print()
        return 1

    print("All modules passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
