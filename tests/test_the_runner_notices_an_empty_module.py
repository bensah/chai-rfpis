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

# Genuinely empty: no TestCase and no test functions either. This is what
# `_ALLOWED_EMPTY` is for — a module holding loose test functions is not empty,
# it is broken, and the opt-out must not excuse it.
TRULY_EMPTY_MODULE = '''
"""Helpers only; this module defines no tests."""

SOME_CONSTANT = 1
'''

FAILING_MODULE = '''
import unittest


class AFailingTest(unittest.TestCase):
    def test_one(self):
        self.assertEqual(1, 2)
'''

# The worse shape: a real TestCase AND loose functions beside it. The class makes
# the module look collected and the count is non-zero, so neither a grep for
# "no TestCase" nor a count-based sweep notices that `test_loose_one` and
# `test_loose_two` never run.
MIXED_MODULE = '''
import unittest


class ARealTest(unittest.TestCase):
    def test_collected(self):
        self.assertTrue(True)


def test_loose_one():
    assert False, "never runs under unittest"


def test_loose_two():
    assert False, "never runs under unittest"
'''

# A module whose FIXTURES are Python source in a string. A regex for `^def test_`
# reads those as declarations; `ast` does not. This repo has one (this file).
STRING_FIXTURE_MODULE = '''
import unittest

SAMPLE = """
def test_this_is_a_string_not_a_declaration():
    pass
"""


class ARealTest(unittest.TestCase):
    def test_uses_the_sample(self):
        self.assertIn("def test_", SAMPLE)
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

    def test_a_whole_pytest_style_module_is_told_why_it_collected_nothing(self):
        """Both faults at once, which is what a pytest-style module is: zero
        collected AND every test function loose. The report leads with the louder
        fact and names the functions that explain it."""
        with _TempModule("zz_guardcheck_empty2", EMPTY_MODULE) as name:
            detail = runner.run_module(name)["detail"]
        self.assertIn("collected 0 tests", detail)
        self.assertIn("test_something_that_never_runs", detail)

    def test_the_report_says_what_is_wrong_not_just_that_it_failed(self):
        """"collected 0 tests" has to read differently from a failing assertion,
        because the fix is completely different."""
        with _TempModule("zz_guardcheck_empty3", EMPTY_MODULE) as name:
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
        with _TempModule("zz_guardcheck_allowed", TRULY_EMPTY_MODULE) as name:
            original = runner._ALLOWED_EMPTY
            try:
                runner._ALLOWED_EMPTY = frozenset({name})
                result = runner.run_module(name)
            finally:
                runner._ALLOWED_EMPTY = original
        self.assertTrue(result["ok"], result["detail"])
        self.assertEqual(result["tests"], 0)

    def test_the_opt_out_does_not_excuse_loose_test_functions(self):
        """`_ALLOWED_EMPTY` means "defines no tests". A module holding test
        functions unittest will not run is not empty, it is broken — and letting
        the list silence that would make the opt-out a way to hide the worse of
        the two faults."""
        with _TempModule("zz_guardcheck_allowed_but_loose", EMPTY_MODULE) as name:
            original = runner._ALLOWED_EMPTY
            try:
                runner._ALLOWED_EMPTY = frozenset({name})
                result = runner.run_module(name)
            finally:
                runner._ALLOWED_EMPTY = original
        self.assertFalse(result["ok"], result["detail"])
        self.assertIn("test_something_that_never_runs", result["detail"])

    def test_the_opt_out_list_is_empty_and_should_stay_that_way(self):
        """Nothing in this repo is legitimately empty today. If an entry appears
        here, it should be because someone deliberately added one — not because a
        broken module was quietened."""
        self.assertEqual(runner._ALLOWED_EMPTY, frozenset())


class TheRunnerNoticesLooseTestFunctionsTests(unittest.TestCase):
    """The second shape: a TestCase with loose `def test_*` beside it.

    Strictly worse than an empty module, because nothing about it looks wrong —
    the class makes it look collected, and the non-zero count passes a
    count-based sweep.
    """

    def test_a_module_mixing_a_testcase_with_loose_functions_fails(self):
        with _TempModule("zz_guardcheck_mixed", MIXED_MODULE) as name:
            result = runner.run_module(name)
        self.assertFalse(result["ok"],
                         "loose test functions must not pass merely because a "
                         "TestCase sits beside them")
        self.assertIn("module-level test function", result["detail"])
        self.assertIn("test_loose_one", result["detail"])

    def test_the_collected_test_still_ran(self):
        """The point is that the module is INCOMPLETE, not that it is empty — so
        the count is real and the failure is about what was skipped."""
        with _TempModule("zz_guardcheck_mixed2", MIXED_MODULE) as name:
            result = runner.run_module(name)
        self.assertEqual(result["tests"], 1)

    def test_source_in_a_string_is_not_a_declaration(self):
        """`^def test_` would read the fixture inside the triple-quoted string as
        a loose function. This module is itself the proof: the fixtures above are
        Python source in strings, and it must pass its own guard."""
        with _TempModule("zz_guardcheck_strings", STRING_FIXTURE_MODULE) as name:
            result = runner.run_module(name)
        self.assertTrue(result["ok"], result["detail"])
        self.assertEqual(result["tests"], 1)

    def test_this_very_file_is_clean_by_its_own_rule(self):
        """The regression that would have shipped if the check used a regex."""
        self.assertEqual(runner.loose_test_functions(Path(__file__)), [])

    def test_a_clean_module_reports_no_loose_functions(self):
        with _TempModule("zz_guardcheck_clean", REAL_MODULE) as name:
            path = REPO_ROOT / "tests" / f"{name}.py"
            self.assertEqual(runner.loose_test_functions(path), [])

    def test_an_unparseable_file_is_left_to_the_interpreter(self):
        """A syntax error is reported far better by the import that follows; this
        check must not pre-empt it with a confusing message of its own."""
        with _TempModule("zz_guardcheck_broken", "def test_x(:\n    pass\n") as name:
            path = REPO_ROOT / "tests" / f"{name}.py"
            self.assertEqual(runner.loose_test_functions(path), [])

    # NO WHOLE-SUITE SWEEP HERE, deliberately. An assertion that every module in
    # tests/ is clean would be a second red for a fault the runner already reports
    # per module, and it would fail in whichever session happens to be mid-
    # conversion rather than in the one that owns the file. The guard IS the
    # sweep; it just runs once per module, where the message belongs.


if __name__ == "__main__":
    unittest.main()
