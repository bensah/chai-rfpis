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

Exit code is 0 only when every module passes.
"""
from __future__ import annotations

import argparse
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
    detail = ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "ok"
    return {
        "name": name,
        "ok": rc == 0 and bad == 0,
        "tests": int(ran.group(1)) if ran else 0,
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
