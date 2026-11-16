"""A person's answer to a criterion survives the derivation, and only a person's does.

`core.auto_scorer.auto_score` derives all nine criteria from org profile x donor intel x
call text and, before migration 102, never read the nine stored columns. That is correct
for a scanned row and was destructive for a reviewed one: 48 of 56 human-assessed rows
held criteria the derivation does not reproduce, 30 of them on a different recommendation,
and since scoring moved to the server the derived answer was what got stored.

The column records WHICH criteria a person answered. These tests pin the two halves that
make it trustworthy:

  * it records an answer a person gave, and nothing else — not the eight criteria an
    editor save round-trips untouched, and not a form default landing in a blank column,
    because either would put a reviewer's name on the scan's own output within one save of
    every row and leave the scorer deferring to itself;
  * the scorer overlays those answers and ONLY those, so a profile edit still reaches
    every criterion nobody has answered.
"""
from __future__ import annotations

import ast
import json
import unittest
from pathlib import Path

from core import criteria_provenance as prov
from core.auto_scorer import auto_score

ROOT = Path(__file__).resolve().parents[1]


class TestRecordingAnAnswer(unittest.TestCase):
    ROW = {"qualification": "Yes, fully", "strategic_fit": "Not sure",
           "capacity": None, "geographic_fit": "Yes, our own presence"}

    def test_a_changed_answer_is_recorded_with_its_author(self):
        out = prov.record(self.ROW, {"qualification": "No, not eligible"}, "a@b.org")
        self.assertIn("qualification", out)
        self.assertEqual(out["qualification"]["by"], "a@b.org")
        self.assertTrue(out["qualification"]["at"])

    def test_answering_a_not_sure_counts(self):
        """"Not sure" is a stored non-answer, so moving off it IS the person answering."""
        out = prov.record(self.ROW, {"strategic_fit": "Strongly aligns"}, "a@b.org")
        self.assertIn("strategic_fit", out)

    def test_a_round_trip_records_nothing(self):
        """An editor save carries all nine whether or not the reviewer touched them."""
        unchanged = {k: v for k, v in self.ROW.items() if v is not None}
        self.assertIsNone(prov.record(self.ROW, unchanged, "a@b.org"))

    def test_a_form_default_landing_in_a_blank_column_is_not_an_answer(self):
        """`_elig` falls back to the first option when nothing maps, on every save.

        Recording that would put the reviewer's name on an answer the widget chose.
        """
        self.assertIsNone(prov.record(self.ROW, {"capacity": "Yes, comfortably"}, "a@b.org"))

    def test_clearing_an_answer_removes_its_author(self):
        row = {**self.ROW, prov.COLUMN: {"qualification": {"by": "a@b.org", "at": "x"}}}
        out = prov.record(row, {"qualification": None}, "b@c.org")
        self.assertNotIn("qualification", out)

    def test_an_earlier_answer_survives_a_later_unrelated_edit(self):
        row = {**self.ROW, prov.COLUMN: {"geographic_fit": {"by": "old@b.org", "at": "x"}}}
        out = prov.record(row, {"qualification": "No, not eligible"}, "new@b.org")
        self.assertEqual(out["geographic_fit"]["by"], "old@b.org")
        self.assertEqual(out["qualification"]["by"], "new@b.org")

    def test_a_missing_author_is_recorded_rather_than_crashing(self):
        out = prov.record(self.ROW, {"qualification": "No, not eligible"}, None)
        self.assertEqual(out["qualification"]["by"], "unknown")


class TestReadingTheTwoChannels(unittest.TestCase):
    def test_the_review_screens_component_overrides_count(self):
        """They already mean "a reviewer decided this" and never reached the score.

        `matching.composite_match` reads the nine labels and never calls
        `apply_component_overrides`, so a verdict recorded there moved the Review panel
        and nothing else. The Review screen saves the override-adjusted LABEL, so reading
        the column here is what connects it.
        """
        row = {"capacity": "No, beyond us",
               prov.OVERRIDES_COLUMN: {"capacity": {"experience": 0.0}}}
        self.assertEqual(prov.human_set(row), {"capacity"})
        self.assertEqual(prov.answers(row), {"capacity": "No, beyond us"})

    def test_both_channels_together(self):
        row = {"capacity": "No, beyond us", "qualification": "Yes, fully",
               prov.OVERRIDES_COLUMN: {"capacity": {"experience": 0.0}},
               prov.COLUMN: {"qualification": {"by": "a@b.org", "at": "x"}}}
        self.assertEqual(prov.human_set(row), {"capacity", "qualification"})

    def test_json_text_is_accepted(self):
        """PostgREST hands jsonb back as a dict; a CSV round-trip hands back text."""
        row = {"qualification": "Yes, fully",
               prov.COLUMN: json.dumps({"qualification": {"by": "a@b.org", "at": "x"}})}
        self.assertEqual(prov.human_set(row), {"qualification"})

    def test_rubbish_in_the_column_is_ignored_rather_than_fatal(self):
        for junk in ("", "not json", "[]", 7, None):
            self.assertEqual(prov.human_set({prov.COLUMN: junk}), set(), junk)

    def test_a_key_that_is_not_a_criterion_is_ignored(self):
        self.assertEqual(prov.human_set({prov.COLUMN: {"decision": {"by": "a@b.org"}}}),
                         set())

    def test_a_recorded_answer_that_is_now_blank_is_not_an_answer(self):
        for value in (None, "", "   ", "Not sure"):
            row = {"qualification": value,
                   prov.COLUMN: {"qualification": {"by": "a@b.org", "at": "x"}}}
            self.assertEqual(prov.answers(row), {}, value)

    def test_a_stale_not_sure_label_cannot_outrank_the_derivation(self):
        """AS-260828-184240 on 2026-11-16: every funding_quality component overridden to
        1.0 while the saved label still read "Not sure". Handing that to the scorer would
        pin the criterion to the weakest reading in the reviewer's name."""
        row = {"funding_quality": "Not sure",
               prov.OVERRIDES_COLUMN: {"funding_quality": {"fq_value": 1.0}}}
        self.assertIn("funding_quality", prov.human_set(row))
        self.assertEqual(prov.answers(row), {})


class TestTheScorerHonoursThem(unittest.TestCase):
    CANDIDATE = {
        "opportunity_title": "Health systems strengthening in Cameroon",
        "brief_description": ("A call for proposals to strengthen primary health care "
                              "delivery across several regions. " * 4),
        "funding_agency": "Example Donor",
        "call_award_value": 500000,
    }

    def test_an_answered_criterion_comes_back_as_the_person_answered_it(self):
        res = auto_score({**self.CANDIDATE, "qualification": "No, not eligible",
                          prov.COLUMN: {"qualification": {"by": "a@b.org", "at": "x"}}}, {})
        self.assertEqual(res.get("qualification"), "No, not eligible")

    def test_an_unanswered_criterion_is_still_derived(self):
        """The failure mode on the other side: seeding the scorer from the stored columns
        freezes the scan's own guesses and stops a profile edit reaching the score —
        measured at 178 of 271 rows moving, 16 onto a different recommendation."""
        stored = {"qualification": "No, not eligible", "capacity": "No, beyond us"}
        res = auto_score({**self.CANDIDATE, **stored}, {})
        for criterion, planted in stored.items():
            self.assertNotEqual(
                res.get(criterion), planted,
                f"{criterion} was taken from the row without a provenance record — the "
                "scan writes those columns too, so this is the scorer deferring to itself")

    def test_the_answer_actually_moves_the_score(self):
        bare = auto_score(dict(self.CANDIDATE), {})
        answered = auto_score({**self.CANDIDATE, "qualification": "No, not eligible",
                               prov.COLUMN: {"qualification": {"by": "a@b.org", "at": "x"}}},
                              {})
        self.assertNotEqual(bare.get("alignment_score"), answered.get("alignment_score"))

    def test_a_row_with_no_provenance_scores_exactly_as_before(self):
        """What makes this safe to land: no row carries the column on day one."""
        self.assertEqual(auto_score(dict(self.CANDIDATE), {}).get("alignment_score"),
                         auto_score({**self.CANDIDATE, prov.COLUMN: None}, {})
                         .get("alignment_score"))


class TestTheEditorRecordsIt(unittest.TestCase):
    def test_the_editor_calls_record_with_the_row_and_the_new_values(self):
        src = (ROOT / "views" / "rfp_editor.py").read_text(encoding="utf-8")
        self.assertIn("criteria_provenance.record", src,
                      "the editor's nine dropdowns are the one place a person answers a "
                      "whole criterion; if it stops recording that, the scorer goes back "
                      "to re-deriving over them")
        for node in ast.walk(ast.parse(src)):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "record"):
                self.assertEqual(len(node.args), 3,
                                 "record(row, values, by) — the row is what makes a "
                                 "round-tripped value distinguishable from an answer")
                return
        self.fail("no criteria_provenance.record call found in views/rfp_editor.py")

    def test_the_submit_form_does_not(self):
        """An insert has nothing to compare against, so every field would look answered.

        The form's own defaults would be recorded as the submitter's answers — including
        `_crit`'s, which pre-selects the BEST option for bid_effort because that criterion
        has no "Not sure". A submitter who filled in four fields would be on record as
        asserting the bid is comfortably resourced, and the scorer would defer to it.
        """
        src = (ROOT / "views" / "submit_form.py").read_text(encoding="utf-8")
        self.assertNotIn("criteria_provenance", src)


if __name__ == "__main__":
    unittest.main()
