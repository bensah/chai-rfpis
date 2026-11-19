"""An undetermined criterion is not scored, and does not sit in the denominator.

THE DEFECT THIS PINS, in the owner's words (2026-11-18):

    Note "MUST 1", it shows "Not sure" + not scored, but we note a bar read, and
    7.5 / 15. This is contradictory ... if there is a score, then a component is
    active.

7.5 is exactly 0.15 (MUST 1's weight) x 0.5 (the retired "Not sure" rating) x 100. The
arithmetic was right for a rule the page never stated, printed beside two statements
that denied it: the label said "Not sure" and the count slot said "not scored".

The rule now is the owner's own, stated twice:

    if we are unsure we leave it as unsure and don't score it (drops from
    denominator) ... if there is a score, then a component is active.

So this file holds the rule in both places it lives — `core.scorer.alignment_score`, the
engine, and `core.opportunity_scoring.analyse`, the page's view of it — and in the one
test that matters most, the internal consistency of a criterion row: there is no state in
which a row can print points for something it did not count.

The TypeScript mirror (`supabase/functions/_shared/api/scorer.ts`) is held to the same
rule by `web/scripts/parity/check-submit.mjs`, which runs the two implementations against
each other over the same inputs.

UNITTEST, NOT PYTEST, and that is not a style choice. `scripts/run_tests.py` is the
canonical runner — `.github/workflows/tests.yml` calls it — and line 70 invokes
`python -m unittest discover` per module, which collects TestCase subclasses only. In
pytest style this module reported "Ran 0 tests ... NO TESTS RAN" while the suite still
said OK, so the rule below was pinned nowhere CI could see. `parametrize` is `subTest`
and `approx` is `assertAlmostEqual` for the same reason.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.scorer import (                                              # noqa: E402
    CRITERIA, CRITERION_RESPONSES, alignment_score, criterion_score, scored_weight)

# The best answer in each criterion's own vocabulary, and the worst. Taken from
# CRITERION_RESPONSES by SCORE rather than by position, so this file keeps working if a
# vocabulary is reworded.
BEST = {k: next(o for o in v if criterion_score(o) == 2)
        for k, v in CRITERION_RESPONSES.items()}
WORST = {k: next(o for o in v if criterion_score(o) == 0)
         for k, v in CRITERION_RESPONSES.items()}

ALL_YES = {k: BEST[k] for k in CRITERIA}


class TheEngineDropsWhatItCannotJudge(unittest.TestCase):

    def test_all_nine_answered_best_is_one_hundred(self):
        """The baseline, unchanged by this rule: everything judged, everything passed."""
        self.assertEqual(alignment_score(ALL_YES), 100.0)

    def test_one_unsure_does_not_dilute_a_perfect_score(self):
        """THE HEADLINE. Eight criteria judged and passed, one undeterminable.

        Under the retired rule the unknown one took half of its 0.15 and the score read
        92.5 — a call marked down for a fact nobody could read. It is the eight that were
        judged, and all eight passed, so the answer is 100.
        """
        values = {**ALL_YES, "qualification": "Not sure"}
        self.assertEqual(alignment_score(values), 100.0)
        # And the retired rule's answer is NOT what comes back.
        self.assertNotEqual(alignment_score(values), 92.5)

    def test_a_detected_failure_still_carries_its_weight(self):
        """The rule is about what we could not READ, never about what we read and failed.

        MUST 1 answered "No, not eligible" is a determination. It scores zero, keeps its
        0.15, and drags the score to 85 exactly as it always did.
        """
        values = {**ALL_YES, "qualification": WORST["qualification"]}
        self.assertEqual(alignment_score(values), 85.0)

    def test_unsure_and_failed_are_no_longer_the_same_arithmetic(self):
        """They used to be distinguishable only by 7.5 points. Now they are different
        kinds."""
        unsure = alignment_score({**ALL_YES, "qualification": "Not sure"})
        failed = alignment_score({**ALL_YES, "qualification": WORST["qualification"]})
        self.assertEqual(unsure, 100.0)
        self.assertEqual(failed, 85.0)

    def test_nothing_determinable_scores_zero_not_fifty(self):
        """Nine unknowns used to average to the Park midpoint and read as a real 50."""
        self.assertEqual(alignment_score({k: "Not sure" for k in CRITERIA}), 0.0)

    def test_an_unrecognised_value_is_undetermined_not_a_guess(self):
        """Free text nobody's dropdown offered is not an answer, so it is not counted."""
        values = {**ALL_YES, "capacity": "mumble"}
        self.assertIsNone(criterion_score("mumble"))
        self.assertEqual(alignment_score(values), 100.0)

    def test_partial_is_still_a_half_mark_and_still_counted(self):
        """0.5 did not disappear from the model — it is what a PARTIAL answer is worth.

        What went away is 0.5 standing in for "we could not tell". A criterion answered
        "Mostly, one item unclear" was judged, scores half of its weight, and counts.
        """
        partial = next(o for o in CRITERION_RESPONSES["qualification"]
                       if criterion_score(o) == 1)
        values = {**ALL_YES, "qualification": partial}
        self.assertEqual(alignment_score(values), 92.5)       # 0.85 + 0.15*0.5
        _c, _w, n, _of = scored_weight(values)
        self.assertEqual(n, 9)


class TheAnalysisSaysHowMuchItJudged(unittest.TestCase):

    def test_scored_weight_reports_what_was_judged(self):
        counted, whole, n, of = scored_weight({**ALL_YES, "qualification": "Not sure"})
        self.assertEqual((n, of), (8, 9))
        self.assertAlmostEqual(whole, 1.0, places=6)
        self.assertAlmostEqual(counted, 0.85, places=6)

        counted, _whole, n, of = scored_weight(ALL_YES)
        self.assertEqual((n, of), (9, 9))
        self.assertAlmostEqual(counted, 1.0, places=6)

    def test_scored_weight_is_zero_when_nothing_can_be_judged(self):
        counted, whole, n, of = scored_weight({k: "Not sure" for k in CRITERIA})
        self.assertEqual((counted, n, of), (0.0, 0, 9))
        self.assertAlmostEqual(whole, 1.0, places=6)


def _analysis():
    """A real `analyse` run over a deliberately thin call.

    Thin is the point: a call with almost nothing in it is where undetermined criteria
    actually arise, and it is the SRHR call the owner was reading when he reported the
    contradiction.
    """
    from core import opportunity_scoring as osc
    rfp = {
        "uid": "TEST-000000-000000",
        "opportunity_name": "A call that says almost nothing",
        "funder_name": "Unknown Funder",
    }
    return osc.analyse(rfp, {}, None, {})


class ACriterionRowNeverContradictsItself(unittest.TestCase):

    def test_a_criterion_row_never_contradicts_itself(self):
        """THE INVARIANT. One answer to "is this scored", not three.

        `scored`, `counted` and `points` were independent: `scored` asked whether any
        COMPONENT was counted, `points` awarded half the weight for an unreadable
        criterion, and `band` was the only one that knew there was no answer. Every
        pairing of them could disagree, and on MUST 1 all three did at once.
        """
        for c in _analysis()["criteria"]:
            with self.subTest(criterion=c["key"]):
                self.assertEqual(c["scored"], c["band"] is not None)
                self.assertEqual(c["counted"], c["scored"])
                if not c["counted"]:
                    self.assertEqual(c["points"], 0.0,
                                     f"{c['key']} printed points it did not count")
                else:
                    self.assertLessEqual(c["points"], c["weight"] * 100.0 + 1e-9)
                    self.assertGreaterEqual(c["points"], 0.0)

    def test_no_criterion_is_awarded_half_its_weight_for_being_unreadable(self):
        """The specific number the owner saw: 7.5 out of 15 on an unanswered MUST 1."""
        for c in _analysis()["criteria"]:
            if c["band"] is None:
                with self.subTest(criterion=c["key"]):
                    self.assertNotAlmostEqual(
                        c["points"], c["weight"] * 50.0, places=6,
                        msg=f"{c['key']} still takes half its weight for being "
                            "undetermined")

    def test_the_analysis_says_how_much_of_the_model_it_judged(self):
        a = _analysis()
        on = a["scored_on"]
        self.assertEqual(on["of"], 9)
        self.assertGreaterEqual(on["n"], 0)
        self.assertLessEqual(on["n"], 9)
        self.assertEqual(on["n"], sum(1 for c in a["criteria"] if c["counted"]))
        self.assertAlmostEqual(
            on["weight"], sum(c["weight"] for c in a["criteria"] if c["counted"]),
            places=4)

    def test_unscored_list_and_the_counted_flag_agree(self):
        a = _analysis()
        self.assertEqual({c["key"] for c in a["unscored"]},
                         {c["key"] for c in a["criteria"] if not c["counted"]})


class AThinAssessmentCannotSuggestProceed(unittest.TestCase):
    """Renormalising without a floor would let two criteria read as 100 and Proceed.

    "Of what could be assessed, this is the fit" is the right number, and it stops being
    a basis for committing a bid team somewhere below half the model. The floor is 5 of 9
    including 3 of the 5 MUSTs, and it is a downgrade only — the same shape as
    `core.data_quality.confidence_adjusted`, which parks a Proceed on thin SOURCE data
    where this parks one on a thin ASSESSMENT.
    """

    CASES = [
        # (counted, musts counted, engine decision, what the reader is shown)
        # Enough assessed: the suggestion stands as the engine computed it.
        (9, 5, "Proceed", "Proceed"),
        (5, 3, "Proceed", "Proceed"),
        # Too few criteria, or too few HARD ones: a Proceed is parked.
        (4, 3, "Proceed", "Park"),
        (5, 2, "Proceed", "Park"),
        (2, 2, "Proceed", "Park"),
        # The guard only ever downgrades — it never promotes a Park or a Decline.
        (2, 1, "Park", "Park"),
        (2, 1, "Decline", "Decline"),
    ]

    def test_a_thin_assessment_cannot_suggest_proceed(self):
        for n_counted, n_must, decision, want in self.CASES:
            with self.subTest(counted=n_counted, musts=n_must, decision=decision):
                criteria = []
                for i, _k in enumerate(CRITERIA):
                    is_must = i < 5
                    counted = (i < n_must) if is_must else (i - 5 < n_counted - n_must)
                    criteria.append({"counted": counted, "is_must": is_must})
                counted_n = sum(1 for c in criteria if c["counted"])
                must_n = sum(1 for c in criteria if c["counted"] and c["is_must"])
                self.assertEqual((counted_n, must_n), (n_counted, n_must),
                                 "the fixture itself is wrong")

                adjusted = decision
                if (counted_n < 5 or must_n < 3) and adjusted.lower() == "proceed":
                    adjusted = "Park"
                self.assertEqual(adjusted, want)

    def test_the_floor_is_live_in_analyse(self):
        """The rule above, exercised through the real function rather than restated.

        A call with nothing in it determines almost nothing, so if `analyse` ever returns
        "Proceed" on one, the floor is not wired in.
        """
        a = _analysis()
        if a["scored_on"]["n"] < 5:
            self.assertNotEqual(
                a["suggested_decision"].lower(), "proceed",
                f"assessed on {a['scored_on']['n']} of 9 and still suggesting "
                f"{a['suggested_decision']}")
            # And the audit trail keeps the unguarded answer.
            self.assertIn("system_decision", a)


if __name__ == "__main__":
    unittest.main()
