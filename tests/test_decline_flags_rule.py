"""The decline flag is about FAILURE, not about the absence of success.

OWNER'S RULE (2026-08-17):
  * any ONE failing MUST                       -> Decline flags = Yes
  * all MUSTs pass, but >= 2 failing PREFERs   -> Yes
  * otherwise                                  -> No

WHY IT MATTERED. The flag is not a badge: `scorer.auto_recommendation` returns "Decline"
whenever it is set, whatever the score. The old rule was
`not (all 5 MUSTs green AND >= 3 of 4 PREFERs green)`, so a call with every MUST green, two
PREFERs green and two merely UNCERTAIN was flagged - and a 92/100 call was recommended
Decline because of two questions nobody could answer. Nothing had failed.

"Not sure" and "Partial" are therefore not failures here, which is the same principle the
rest of the model follows: an unstated value is excluded from a criterion's count rather
than scored zero. A partial MUST still costs points through the weighted score - the
proportionate instrument - instead of overriding the verdict entirely.

MEASURED over the 286 scored live rows: 70 flags change, all Yes -> No, producing 40
Decline->Park and 27 Decline->Proceed. On the rows a human had already decided, the new rule
agrees with the team on 11 where the old rule did not, and loses agreement on 5.

Run:  python -m unittest tests.test_decline_flags_rule
"""
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from core.auto_scorer import _MUST_KEYS, _PREFER_KEYS                 # noqa: E402
from core.scorer import criterion_score                              # noqa: E402
from core.scorer import decline_flags as _flag                       # noqa: E402

# `_flag` IS the shipped function now. It used to be a copy of the rule written out
# again here, which tested that the rule was what this file said it was — not that the
# app computed it that way. The app has two callers (scan-time scoring and the Review
# page's live recompute); a copy here would have told us nothing about either.


def _values(musts, prefers):
    v = {k: musts[i] for i, k in enumerate(_MUST_KEYS)}
    v.update({k: prefers[i] for i, k in enumerate(_PREFER_KEYS)})
    return v


YES, NO, PARTIAL, UNSURE = "Yes", "No", "Partial", "Not sure"
ALL_MUST_OK = [YES] * len(_MUST_KEYS)
ALL_PREFER_OK = [YES] * len(_PREFER_KEYS)


class TheOwnersRuleTests(unittest.TestCase):
    def test_all_green_raises_no_flag(self):
        self.assertFalse(_flag(_values(ALL_MUST_OK, ALL_PREFER_OK)))

    def test_a_single_failing_must_raises_the_flag(self):
        for i in range(len(_MUST_KEYS)):
            musts = list(ALL_MUST_OK)
            musts[i] = NO
            self.assertTrue(_flag(_values(musts, ALL_PREFER_OK)),
                            "MUST %s failing must flag" % _MUST_KEYS[i])

    def test_one_failing_prefer_does_not_raise_the_flag(self):
        prefers = list(ALL_PREFER_OK)
        prefers[0] = NO
        self.assertFalse(_flag(_values(ALL_MUST_OK, prefers)))

    def test_two_failing_prefers_raise_the_flag(self):
        prefers = list(ALL_PREFER_OK)
        prefers[0] = prefers[1] = NO
        self.assertTrue(_flag(_values(ALL_MUST_OK, prefers)))


class UncertaintyIsNotFailureTests(unittest.TestCase):
    def test_the_reported_row_no_longer_flags(self):
        # Every MUST green; PREFER 6 and 7 uncertain, 8 and 9 green. Scored 92/100 and was
        # recommended Decline purely because only two PREFERs were affirmatively green.
        prefers = [UNSURE, UNSURE] + [YES] * (len(_PREFER_KEYS) - 2)
        self.assertFalse(_flag(_values(ALL_MUST_OK, prefers)))

    def test_two_uncertain_prefers_are_not_two_failures(self):
        prefers = [UNSURE] * 2 + [YES] * (len(_PREFER_KEYS) - 2)
        self.assertFalse(_flag(_values(ALL_MUST_OK, prefers)))

    def test_an_uncertain_must_does_not_flag_on_its_own(self):
        # A behaviour CHANGE, stated plainly: an unanswered MUST used to force Decline.
        # It now leaves the verdict to the score, which parks a middling row for a human.
        musts = list(ALL_MUST_OK)
        musts[0] = UNSURE
        self.assertFalse(_flag(_values(musts, ALL_PREFER_OK)))

    def test_a_partial_must_does_not_flag_on_its_own(self):
        musts = list(ALL_MUST_OK)
        musts[0] = PARTIAL
        self.assertFalse(_flag(_values(musts, ALL_PREFER_OK)))

    def test_but_a_failing_must_still_flags_however_uncertain_the_rest(self):
        musts = [NO, UNSURE] + [YES] * (len(_MUST_KEYS) - 2)
        self.assertTrue(_flag(_values(musts, [UNSURE] * len(_PREFER_KEYS))))


class TheDifferenceFromTheOldRuleTests(unittest.TestCase):
    def _old(self, values):
        return not (all(criterion_score(values.get(m)) == 2 for m in _MUST_KEYS)
                    and sum(1 for p in _PREFER_KEYS
                            if criterion_score(values.get(p)) == 2) >= 3)

    def test_the_old_rule_flagged_the_92_point_call_and_the_new_one_does_not(self):
        v = _values(ALL_MUST_OK, [UNSURE, UNSURE] + [YES] * (len(_PREFER_KEYS) - 2))
        self.assertTrue(self._old(v))
        self.assertFalse(_flag(v))

    def test_both_rules_agree_when_something_actually_failed(self):
        v = _values([NO] + ALL_MUST_OK[1:], ALL_PREFER_OK)
        self.assertTrue(self._old(v))
        self.assertTrue(_flag(v))

    def test_both_rules_agree_on_an_all_green_call(self):
        v = _values(ALL_MUST_OK, ALL_PREFER_OK)
        self.assertFalse(self._old(v))
        self.assertFalse(_flag(v))


class TheReviewPageMustRecomputeFromWhatItShowsTests(unittest.TestCase):
    """Reported 2026-11-02 on AS-261030-1248172 (Grand Challenges Canada): five green
    MUSTs on screen and "Decline flags: Yes" underneath them.

    The grid rendered the LIVE derivation while the flag printed the stored column, so
    the page contradicted itself. These are that row's real values, measured."""

    STORED = {"qualification": "No, not eligible", "strategic_fit": "Strongly aligns",
              "capacity": "Yes, comfortably", "geographic_fit": "Yes, our own presence",
              "cofinancing": "Yes, fully met", "funding_quality": "High",
              "funder_relationship": "Some contact",
              "competitiveness": "Strong (limited field / incumbent / clear edge)",
              "bid_effort": "Ample time, sufficient resources"}
    # What derive_criteria returns for the same row today.
    LIVE = {**STORED, "qualification": "Yes, fully", "funder_relationship": "None",
            "bid_effort": "Ample time, but no dedicated team"}

    def test_the_stored_values_really_did_flag(self):
        # The column was not wrong when it was written — qualification was a failing MUST.
        self.assertTrue(_flag(self.STORED))

    def test_the_live_values_do_not_flag(self):
        # One failing PREFER (funder_relationship) is not two, and no MUST fails.
        self.assertFalse(_flag(self.LIVE))

    def test_so_the_two_disagree_which_is_the_bug(self):
        self.assertNotEqual(_flag(self.STORED), _flag(self.LIVE))

    def test_a_single_failing_prefer_is_still_not_enough(self):
        # Guards the specific near-miss: drop funder_relationship only and nothing flags.
        self.assertEqual(
            sum(1 for p in _PREFER_KEYS if criterion_score(self.LIVE.get(p)) == 0), 1)
        self.assertFalse(_flag(self.LIVE))


class TheFlagStillOverridesTheScoreTests(unittest.TestCase):
    def test_a_flagged_call_is_declined_whatever_it_scored(self):
        from core.scorer import auto_recommendation
        self.assertEqual(auto_recommendation(95.0, True), "Decline")
        self.assertEqual(auto_recommendation(95.0, False), "Proceed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
