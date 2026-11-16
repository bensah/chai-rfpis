"""A save must not leave behind a freshness stamp it did not earn.

`scored_at` and `score_profile_sig` (migration 101) are a claim about WHO computed the
stored score: the `rescore` job, through `core.auto_scorer.auto_score`, under the profile
signature named. The Streamlit editors compute a different, coarser number
(`core.scorer.score_submission` — no fatal-factor gate, no below-award-floor cap) and are
right to, because a submitter needs their score the moment they answer. What they must not
do is write that number and leave the previous run's stamp standing over it.

They did, until 2026-11-16, and 8 live rows (all chai-cameroon) ended up claiming to be
freshly scored under the current profile while holding the editor's answer. Five of them
disagreed with a fresh computation by up to 38 points and on the recommendation itself —
`Proceed/100` stored where `auto_score` says `Decline/62`. `web/scripts/parity/
check-rescore.mjs` had been failing on exactly those five for weeks.

These tests pin the RULE rather than the numbers, in the shape
`test_rescore_job_matches_the_screens.py` uses: one place computes the columns, every human
write path goes through it, and nothing outside the job writes a stamp.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Every module that writes a score from a human's edit. Each must go through the helper.
EDITOR_WRITERS = (
    Path("views") / "rfp_editor.py",
    Path("views") / "review_rfp.py",
    Path("views") / "submit_form.py",
)

# The one place allowed to claim a score is current, and the one place that spells the
# cleared columns. Everything else under core/, views/, app_pages/ and scripts/ may read
# the stamps but not write them.
THE_JOB = Path("scripts") / "run_web_job.py"
THE_HELPER = Path("core") / "score_stamp.py"


def _py_files(folders=("core", "views", "app_pages", "scripts")):
    for folder in folders:
        for path in sorted((ROOT / folder).rglob("*.py")):
            yield path.relative_to(ROOT), path


def _as_keys(node: ast.Dict) -> dict:
    """A dict literal's string keys, mapped to their value nodes."""
    return {k.value: v for k, v in zip(node.keys, node.values)
            if isinstance(k, ast.Constant) and isinstance(k.value, str)}


def _dicts_with(source: str, key: str):
    """Every dict literal in `source` that sets `key`."""
    return [keys for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.Dict) and key in (keys := _as_keys(node))]


def _persisted_dicts(source: str):
    """Dict literals that reach the database: the payload of an update/insert/upsert.

    A screen is full of dicts carrying an `alignment_score` that are never written — the
    raw-values diagnostic in review_rfp, a display row, a dataframe column map. Only the
    ones handed to a write matter here, inline or through the name they were built under.
    """
    tree = ast.parse(source)
    out, payload_names = [], set()
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr in {"update", "insert", "upsert"} and node.args):
            arg = node.args[0]
            if isinstance(arg, ast.Dict):
                out.append(_as_keys(arg))
            elif isinstance(arg, ast.Name):
                payload_names.add(arg.id)
    for node in ast.walk(tree):
        if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Dict)
                and any(isinstance(t, ast.Name) and t.id in payload_names
                        for t in node.targets)):
            out.append(_as_keys(node.value))
    return out


class TestTheHelperClearsWhatItCannotClaim(unittest.TestCase):
    def test_it_returns_the_score_and_no_claim_about_it(self):
        from core.score_stamp import editor_score_columns
        cols = editor_score_columns(92.0, "Proceed")
        self.assertEqual(cols["alignment_score"], 92.0)
        self.assertEqual(cols["auto_recommendation"], "Proceed")
        self.assertIsNone(cols["scored_at"],
                          "an editor save must not leave a scored_at it did not earn")
        self.assertIsNone(cols["score_profile_sig"],
                          "nor a profile signature — that is the job's claim to make")

    def test_both_stamps_are_always_present_in_the_update(self):
        """Omitting them would leave the previous run's stamp standing on an UPDATE."""
        from core.score_stamp import STAMP_COLUMNS, editor_score_columns
        for score, rec in ((None, None), (0.0, "Decline"), (100.0, "Proceed")):
            cols = editor_score_columns(score, rec)
            for column in STAMP_COLUMNS:
                self.assertIn(column, cols,
                              f"{column} must be written, not omitted — an absent key "
                              "leaves whatever the job last stamped")


class TestEveryHumanWritePathGoesThroughIt(unittest.TestCase):
    def test_the_editors_use_the_helper(self):
        for rel in EDITOR_WRITERS:
            src = (ROOT / rel).read_text(encoding="utf-8")
            self.assertIn("editor_score_columns", src,
                          f"{rel.as_posix()} writes a score from a human edit and must "
                          "write it through core.score_stamp.editor_score_columns")

    def test_no_screen_writes_a_score_beside_a_stamp_it_kept(self):
        """A screen's dict that sets alignment_score must also clear both stamps.

        Spreading the helper leaves no literal `alignment_score` key, so a screen that
        passes this is either using the helper or clearing the stamps by hand — and a
        future edit that goes back to writing the bare column fails here.

        Screens only. `core/` and `scripts/` build plenty of dicts that carry an
        `alignment_score` and never reach the database (assess_row's display payload, the
        model's feature vectors, the decision log's label row), and the one core writer
        that does reach it — `core/scan_pipeline.py` — scores through `auto_score` and only
        on a row that has no score at all, so it is not writing one scorer's answer over
        another's. The stamp rule below still covers every folder.
        """
        from core.score_stamp import STAMP_COLUMNS
        for rel, path in _py_files(("views", "app_pages")):
            if rel in (THE_JOB, THE_HELPER):
                continue
            for literal in _persisted_dicts(path.read_text(encoding="utf-8")):
                if "alignment_score" not in literal:
                    continue
                missing = [c for c in STAMP_COLUMNS if c not in literal]
                self.assertFalse(
                    missing,
                    f"{rel.as_posix()} writes alignment_score in a dict that does not set "
                    f"{', '.join(missing)}. If that dict reaches rfp_submissions the row "
                    "keeps a stamp claiming the job computed a number the job did not "
                    "compute - use core.score_stamp.editor_score_columns.")

    def test_only_the_job_stamps(self):
        """Anything else writing a stamp must be writing None to clear it."""
        from core.score_stamp import STAMP_COLUMNS
        for rel, path in _py_files():
            if rel in (THE_JOB, THE_HELPER):
                continue
            src = path.read_text(encoding="utf-8")
            for column in STAMP_COLUMNS:
                for literal in _dicts_with(src, column):
                    value = literal[column]
                    self.assertTrue(
                        isinstance(value, ast.Constant) and value.value is None,
                        f"{rel.as_posix()} sets {column} to something other than None. "
                        "Only scripts/run_web_job.py::_rescore may claim a score is "
                        "current, because only it computes one through auto_score.")


class TestTheEditorStillShowsAScore(unittest.TestCase):
    """Clearing the stamps must not have cost the submitter their immediate feedback."""

    def test_the_editors_still_compute_one(self):
        for rel in EDITOR_WRITERS:
            src = (ROOT / rel).read_text(encoding="utf-8")
            self.assertIn("score_submission", src,
                          f"{rel.as_posix()} must still compute a score to show — "
                          "immediate feedback is why these screens score at all")

    def test_the_helper_carries_the_computed_number_through(self):
        """Not None-ing the score itself: the row keeps a usable number, just no claim."""
        from core.scorer import score_submission
        from core.score_stamp import editor_score_columns
        values = {"qualification": "Yes", "strategic_fit": "Yes", "capacity": "Partial",
                  "geographic_fit": "Yes", "cofinancing": "Partial",
                  "funding_quality": "High", "funder_relationship": "Partial",
                  "competitiveness": "Partial", "bid_effort": "Moderate"}
        score, rec = score_submission(values, False)
        cols = editor_score_columns(score, rec)
        self.assertIsNotNone(cols["alignment_score"])
        self.assertEqual(cols["alignment_score"], score)
        self.assertEqual(cols["auto_recommendation"], rec)


if __name__ == "__main__":
    unittest.main()
