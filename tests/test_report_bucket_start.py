"""Report's bucket snapping must survive a row with no date.

Semestrial was the only mode that built its date from STRINGS, and the only one that
raised on a missing date: `s.dt.year` becomes float64 the moment one value is NaT, so
2026 renders as "2026.0", the concatenation produces "2026.0-01-01", and pd.to_datetime
raised rather than coercing. Report with "View by = Semestrial" crashed outright whenever
a row without a search_date was in scope — the Excel-migrated ones — and only at the one
call site that does not dropna() first.

These tests are written across ALL the modes rather than only the one that broke, because
the fault was being the odd one out.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

# `views/report.py` is a Streamlit PAGE SCRIPT, not a library: `render_view` exec's it on
# every rerun and its body queries the database at the top level. `from views.report import
# _bucket_start` therefore ran the whole page at import. Alone that reached the real
# Supabase and (slowly) succeeded; under the full suite an earlier module had already done
# `os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")`, so dotenv's
# non-overriding load left the dummy host in place and the import died on a DNS failure,
# taking all six tests with it as a loader error.
#
# So lift the function out of the file instead of importing it, exactly as
# web/scripts/parity/report_py.py already does for the same reason. This still exercises
# the REAL source text — a copy retyped here would agree with itself forever while
# report.py drifted underneath it — and it needs no network, no Streamlit and no change to
# a page another session is actively porting.
_REPORT_PY = Path(__file__).resolve().parents[1] / "views" / "report.py"


def _lift(name: str):
    """Exec just `name`'s def out of views/report.py and return the function."""
    tree = ast.parse(_REPORT_PY.read_text(encoding="utf-8"))
    picked = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name]
    if not picked:
        raise AssertionError(f"views/report.py no longer defines {name}()")
    ns: dict = {"pd": pd, "np": np}
    exec(compile(ast.Module(body=picked, type_ignores=[]), str(_REPORT_PY), "exec"), ns)
    return ns[name]


_bucket_start = _lift("_bucket_start")

MODES = ("Weekly", "Monthly", "Quarterly", "Semestrial", "Annually")


class TestBucketStartHandlesMissingDates(unittest.TestCase):
    def test_no_mode_raises_on_a_missing_date(self):
        s = pd.Series(["2026-02-10", None, "2026-08-03"])
        for mode in MODES:
            with self.subTest(mode=mode):
                out = _bucket_start(s, mode)          # must not raise
                self.assertTrue(pd.isna(out.iloc[1]),
                                "a missing date stays missing, it does not become a bucket")

    def test_a_missing_date_does_not_disturb_its_neighbours(self):
        with_gap = pd.Series(["2026-02-10", None, "2026-08-03"])
        without = pd.Series(["2026-02-10", "2026-08-03"])
        for mode in MODES:
            with self.subTest(mode=mode):
                a = _bucket_start(with_gap, mode)
                b = _bucket_start(without, mode)
                self.assertEqual(a.iloc[0], b.iloc[0])
                self.assertEqual(a.iloc[2], b.iloc[1])

    def test_every_date_is_missing(self):
        s = pd.Series([None, None], dtype="object")
        for mode in MODES:
            with self.subTest(mode=mode):
                self.assertTrue(_bucket_start(s, mode).isna().all())

    def test_an_empty_series_is_fine(self):
        s = pd.Series([], dtype="object")
        for mode in MODES:
            with self.subTest(mode=mode):
                self.assertEqual(len(_bucket_start(s, mode)), 0)

    def test_semestrial_snaps_to_january_and_july(self):
        """The behaviour itself, so the NaT fix cannot quietly change the buckets."""
        s = pd.Series(["2026-01-01", "2026-06-30", "2026-07-01", "2026-12-31"])
        got = [str(d.date()) for d in _bucket_start(s, "Semestrial")]
        self.assertEqual(got, ["2026-01-01", "2026-01-01", "2026-07-01", "2026-07-01"])

    def test_semestrial_keeps_the_year_whole(self):
        """The actual bug: a float year rendered as "2026.0" and could not be parsed."""
        s = pd.Series(["2026-02-10", None])
        first = _bucket_start(s, "Semestrial").iloc[0]
        self.assertEqual(first.year, 2026)
        self.assertEqual(first.month, 1)


if __name__ == "__main__":
    unittest.main()
