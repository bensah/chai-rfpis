"""The rescore job must produce what the screens show, by construction.

The whole point of the server owning the score (owner, 2026-10-28) is that there is ONE
answer. That only holds if the job computes it the same way the screens do.

It nearly did not. The job first called `scripts.rescore_existing.evaluate`, which looked
like the right thing — it is what the re-score CLI runs, and its own comment promises
parity with a fresh scan. It is not the same computation: `auto_score` runs
`_apply_criteria_keywords` over the candidate text after `derive_criteria`, and `evaluate`
does not, so the two derive different criteria from the same row. Measured on live data,
one row came out Park/77 through `auto_score` and Decline/54.5 through `evaluate`, and
10-17% of rows changed recommendation between the two paths.

These tests pin the choice rather than the numbers: the job reaches `assess_row`, and
`assess_row` is what the screens reach. A future edit that swaps it back for the
plausible-looking alternative fails here.
"""
from __future__ import annotations

import ast
import inspect
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _rescore_source() -> str:
    src = (ROOT / "scripts" / "run_web_job.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "_rescore":
            return ast.get_source_segment(src, node) or ""
    raise AssertionError("scripts/run_web_job.py has no _rescore handler")


class TestTheJobScoresLikeTheScreens(unittest.TestCase):
    def test_the_job_is_registered(self):
        from scripts.run_web_job import KINDS
        self.assertIn("rescore", KINDS)

    def test_the_job_scores_through_auto_score(self):
        body = _rescore_source()
        self.assertIn("auto_score", body,
                      "the job must score through core.auto_scorer.auto_score — the call "
                      "assess_row makes, so the job and the screens compute the same thing")

    def test_the_job_does_not_inherit_assess_rows_swallow(self):
        """assess_row returns the STORED score when auto_score raises.

        Right for a display, which must not crash. Wrong for a job: it would write back
        the number it just read, stamp scored_at and the current signature, and the row
        would claim to be freshly scored while nothing was computed — invisible to a
        checker comparing stored against fresh, because both would be that same value.
        """
        body = _rescore_source()
        self.assertNotIn("assess_row(", body,
                         "the job must not route through assess_row's fallback")
        self.assertIn("continue", body,
                      "a row that could not be scored must be skipped, not stamped")
        self.assertIn("failed", body, "and the skips must be counted")

    def test_the_job_does_not_use_the_other_derivation(self):
        body = _rescore_source()
        # `profile_signature` and `write_with_retry` from that module are fine — they do no
        # scoring. `evaluate` is the one that derives criteria differently.
        self.assertNotIn("evaluate(", body,
                         "rescore_existing.evaluate derives criteria differently from "
                         "auto_score; the job must not use it (see this module's docstring)")

    def test_assess_row_is_what_the_screens_reach(self):
        """If the screens stop going through assess_row, this choice stops being right."""
        from core.assessment import assess_row
        self.assertIn("auto_score", inspect.getsource(assess_row),
                      "assess_row is supposed to reach auto_score")
        screens = [ROOT / "views" / "screened_rfp.py", ROOT / "core" / "live_scoring.py"]
        for path in screens:
            self.assertIn("assess_row", path.read_text(encoding="utf-8"),
                          f"{path.name} no longer reaches assess_row")

    def test_the_job_writes_the_score_not_the_criteria(self):
        """Keeping the score current is a smaller claim than rewriting the assessment."""
        body = _rescore_source()
        self.assertIn("alignment_score", body)
        self.assertIn("auto_recommendation", body)
        for criterion in ("qualification", "strategic_fit", "bid_effort"):
            self.assertNotIn(criterion, body,
                             "the nine criteria stay the scan's to write")

    def test_the_job_stamps_when_and_under_what_profile(self):
        body = _rescore_source()
        self.assertIn("scored_at", body)
        self.assertIn("score_profile_sig", body)

    def test_the_job_scopes_to_one_tenant(self):
        """get_client, get_profile and get_org all read the ambient tenant."""
        body = _rescore_source()
        self.assertIn("set_tenant_override", body)
        self.assertIn("reset_tenant_override", body)
        self.assertIn("finally:", body, "the override must be released on every path")


if __name__ == "__main__":
    unittest.main()
