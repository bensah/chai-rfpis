"""`scripts/run_tests.py` fails a module that collects no tests.

WHY THE GUARD EXISTS
--------------------
`unittest discover` only collects `TestCase` subclasses. A module of bare
`def test_*` functions — pytest's idiom — raises nothing, prints OK and runs none
of its tests. So the runner could not tell a module that PASSED from a module it
could not COLLECT: both arrived as rc=0 with no failures.

Over 2026-11-18/19 eleven modules across two sessions were in that state, about
190 tests, among them the guard against stored scores falsely claiming to be
current — the test protecting a defect that had just shipped was itself running
nowhere. Three sessions reported "the suite is green" while it was false, and the
suite agreed with them every time.

WHY THIS FILE IS THE AWKWARD ONE
--------------------------------
It tests the thing that runs it. `run_module` shells out to a real interpreter,
so these cases drive it against REAL temporary modules written to the tests
directory rather than mocking the subprocess — a mock would be asserting that
this file's idea of unittest's output matches the parser, which is the half
already known to work. What was wrong was the VERDICT, so the verdict is what is
exercised end to end.

Each case cleans up its own file. The names are deliberately outside the
`test_*.py` pattern until the moment they are run, so a parallel full-suite run
cannot collect them by accident.
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

_spec = importlib.util.spec_from_file_location(
    "run_tests_under_test", REPO_ROOT / "scripts" / "run_tests.py")
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

EMPTY_MODULE = '''
"""A module unittest cannot collect: bare functions, no TestCase."""


def test_something_that_never_runs():
    assert False, "if this ever executes, unittest learned to collect bare functions"
'''

REAL_MODULE = '''
import unittest


class ARealTest(unittest.TestCase):
    def test_one(self):
        self.assertTrue(True)
'''

FAILING_MODULE = '''
import unittest


class AFailingTest(unittest.TestCase):
    def test_one(self):
        self.assertEqual(1, 2)
'''


class _TempModule:
    """Write a module into tests/ for the duration of one case."""

    def __init__(self, stem: str, body: str):
        self.stem = stem
        self.path = REPO_ROOT / "tests" / f"{stem}.py"
        self.body = body

    def __enter__(self) -> str:
        self.path.write_text(self.body, encoding="utf-8")
        return self.stem

    def __exit__(self, *_exc):
        self.path.unlink(missing_ok=True)


class TheRunnerNoticesAnEmptyModuleTests(unittest.TestCase):

    def test_a_module_with_no_testcase_is_reported_as_a_failure(self):
        """The whole point. Before the guard this returned ok=True, 0 tests."""
        with _TempModule("zz_guardcheck_empty", EMPTY_MODULE) as name:
            result = runner.run_module(name)
        self.assertEqual(result["tests"], 0)
        self.assertFalse(result["ok"],
                         "a module unittest could not collect must not read as passing")
        self.assertIn("collected 0 tests", result["detail"])

    def test_the_report_says_what_is_wrong_not_just_that_it_failed(self):
        """"collected 0 tests" has to read differently from a failing assertion,
        because the fix is completely different."""
        with _TempModule("zz_guardcheck_empty2", EMPTY_MODULE) as name:
            detail = runner.run_module(name)["detail"]
        self.assertNotIn("failures=", detail)
        self.assertIn("TestCase", detail)

    def test_a_real_module_still_passes(self):
        with _TempModule("zz_guardcheck_real", REAL_MODULE) as name:
            result = runner.run_module(name)
        self.assertTrue(result["ok"], result["detail"])
        self.assertEqual(result["tests"], 1)

    def test_a_failing_module_keeps_its_own_explanation(self):
        """The guard runs only on a module that otherwise PASSED. A real failure
        must keep its failure count rather than being relabelled."""
        with _TempModule("zz_guardcheck_failing", FAILING_MODULE) as name:
            result = runner.run_module(name)
        self.assertFalse(result["ok"])
        self.assertIn("failures=", result["detail"])
        self.assertNotIn("collected 0 tests", result["detail"])

    def test_an_opt_out_is_honoured(self):
        """A module that is legitimately empty can be named in `_ALLOWED_EMPTY`."""
        with _TempModule("zz_guardcheck_allowed", EMPTY_MODULE) as name:
            original = runner._ALLOWED_EMPTY
            try:
                runner._ALLOWED_EMPTY = frozenset({name})
                result = runner.run_module(name)
            finally:
                runner._ALLOWED_EMPTY = original
        self.assertTrue(result["ok"], result["detail"])
        self.assertEqual(result["tests"], 0)

    def test_the_opt_out_list_is_empty_and_should_stay_that_way(self):
        """Nothing in this repo is legitimately empty today. If an entry appears
        here, it should be because someone deliberately added one — not because a
        broken module was quietened."""
        self.assertEqual(runner._ALLOWED_EMPTY, frozenset())


if __name__ == "__main__":
    unittest.main()
