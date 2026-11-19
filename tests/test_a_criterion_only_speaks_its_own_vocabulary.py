"""No criterion may ever be labelled with another criterion's answer.

THE REPORT (owner, 2026-11-18): MUST 1 "Legal status & qualification" showing
"Yes, comfortably" — which is MUST 3's vocabulary, the capacity scale — alongside
"you build and mixed up the form pickers with redundant responses ... We had retained
4 responses for eligibility".

WHAT THE DATA ACTUALLY SAYS. Censused over all 271 `rfp_submissions` rows: there is no
`qualification` column holding a capacity answer, and no cross-criterion value anywhere.
The only out-of-list values are six `cofinancing` rows carrying "Yes, none required" and
"Yes/none required" — that criterion's OWN retired spellings, which `_SCORE_MAP` still
recognises on purpose so an old row keeps scoring. So the stored data is clean, and the
earlier diagnosis that blamed a corrupt stored value was wrong.

That leaves the LABEL PATH, which is where a cross-criterion answer could actually come
from, because the label on the page is never the stored column (`criteria_review`'s
module docstring is emphatic about this). It is produced by one of nine `ROLL_UP_RULES`
or by `criteria_derive`, each of which writes its label out as a string literal — and a
literal copied from the criterion above it is a one-character-invisible mistake that
nothing in the type system or the tests would have caught.

So this file exercises every rule over every combination of component scores it can be
given and asserts the answer is in that criterion's own `CRITERION_RESPONSES`. It is the
guard the reported symptom needs whether or not that symptom came from here: a rule that
starts answering in the wrong vocabulary fails a test instead of reaching a reviewer.

UNITTEST, NOT PYTEST, and that is not a style choice. `scripts/run_tests.py` is the
canonical runner — `.github/workflows/tests.yml` calls it — and line 70 invokes
`python -m unittest discover` per module. unittest collects TestCase subclasses; it
cannot see a bare `def test_x()` or a `@pytest.mark.parametrize`. Written in pytest
style, this module reported "Ran 0 tests ... NO TESTS RAN" and the suite still said OK,
so the guard below was not running anywhere except under a local `pytest` nobody's CI
invokes. Parametrisation is `subTest` here for the same reason.
"""
from __future__ import annotations

import itertools
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import criteria_review as crev                              # noqa: E402
from core.scorer import (                                             # noqa: E402
    CRITERIA, CRITERION_RESPONSES, criterion_score)


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", str(s).strip().lower()).replace("–", "-").replace("—", "-")


#: Every spelling a criterion may legitimately answer with: its own rich options, plus
#: the criterion-agnostic legacy words that mean the same thing on any scale.
GENERIC = {"yes", "y", "true", "1", "partial", "p", "partly", "no", "n", "false", "0",
           "not sure", ""}
OWN = {k: {norm(o) for o in CRITERION_RESPONSES[k]} | GENERIC for k in CRITERIA}

#: Which criterion each rich answer belongs to, so a failure can NAME the thief.
OWNER_OF: dict[str, list[str]] = {}
for _k in CRITERIA:
    for _o in CRITERION_RESPONSES[_k]:
        if norm(_o) in GENERIC:      # "Not sure" belongs to all nine, by design.
            continue
        OWNER_OF.setdefault(norm(_o), []).append(_k)

SCORES = (0.0, 0.5, 1.0)


def _facts(key: str, scores: tuple[float, ...]) -> list[dict]:
    """`n` active components for `key`, carrying the given scores."""
    return [{"key": f"{key}_c{i}", "name": f"component {i}", "active": True,
             "score": s, "met": s >= 1.0}
            for i, s in enumerate(scores)]


class TheRollUpRulesAnswerInTheirOwnVocabulary(unittest.TestCase):

    def test_every_roll_up_answers_in_its_own_vocabulary(self):
        """THE GUARD. Every component-score combination, one to four components.

        Four is past the widest criterion in the model and the rules are monotone in the
        scores, so this is exhaustive in practice rather than merely broad.
        """
        for key in CRITERIA:
            seen = set()
            for n in (1, 2, 3, 4):
                for combo in itertools.product(SCORES, repeat=n):
                    label = crev.roll_up(key, _facts(key, combo))
                    if label is None:
                        continue
                    seen.add(label)
                    thief = OWNER_OF.get(norm(label), [])
                    with self.subTest(criterion=key, scores=combo):
                        self.assertIn(
                            norm(label), OWN[key],
                            f"{key} answered {label!r} for component scores {combo}"
                            + (f" — that is {'/'.join(thief)}'s vocabulary" if thief
                               else " — that is in no criterion's vocabulary"))
            with self.subTest(criterion=key):
                self.assertTrue(seen, f"{key} produced no label for any component scores")

    def test_every_roll_up_answer_is_scorable(self):
        """A label outside `_SCORE_MAP` scores None, which now DROPS the criterion from
        the denominator (owner, 2026-11-18). Before that rule it quietly took half the
        weight, so an unrecognised label cost 7.5 points and said nothing; now it costs
        the criterion its whole say. Either way a rule must not produce one by accident —
        only "Not sure" may be unscorable, and only deliberately."""
        for key in CRITERIA:
            for n in (1, 2, 3):
                for combo in itertools.product(SCORES, repeat=n):
                    label = crev.roll_up(key, _facts(key, combo))
                    if label is None or norm(label) == "not sure":
                        continue
                    with self.subTest(criterion=key, scores=combo):
                        self.assertIsNotNone(
                            criterion_score(label),
                            f"{key} answered {label!r} for {combo}, which scores as "
                            "undetermined")

    def test_no_rich_answer_is_shared_between_two_criteria(self):
        """The condition that makes the whole guard meaningful.

        If two criteria legitimately offered the same rich answer, "is this label mine?"
        would have no answer and the test above would be vacuous for that string. They do
        not — every rich option names its own scale — and this keeps it that way, so a
        vocabulary reworded to collide fails HERE with a clear reason rather than making a
        different test silently weaker.

        "Moderate" is the deliberate exception: `funding_quality` and `competitiveness`
        both offer it and both mean the middle of their own scale. It is also why the fit
        BANDS stopped using the word on 2026-11-18 — see core/opportunity_scoring.
        """
        shared = {o: ks for o, ks in OWNER_OF.items() if len(ks) > 1}
        self.assertEqual(shared, {"moderate": ["funding_quality", "competitiveness"]})


class TheStoredColumnsStayInTheirVocabulary(unittest.TestCase):

    def test_stored_criteria_stay_in_their_vocabulary(self):
        """The data-side half: a value from the wrong criterion must not score.

        This is the defect the owner described — MUST 3's "Yes, comfortably" sitting in
        MUST 1 and scoring a full pass, because `criterion_score` is key-agnostic and
        simply recognises the string. The census says no live row is in that state, so
        this pins the RULE rather than a repair: the per-criterion table is what the
        TypeScript side scores through (`scorer.ts::criterionScore` takes the criterion as
        its first argument), and this asserts the Python vocabularies it is generated from
        stay disjoint enough for that lookup to mean something.
        """
        self.assertEqual(criterion_score("Yes, comfortably"), 2)   # on its OWN criterion
        self.assertIn(norm("Yes, comfortably"), OWN["capacity"])
        self.assertNotIn(norm("Yes, comfortably"), OWN["qualification"])
        # And the four the owner expects on MUST 1, no more.
        self.assertEqual(
            CRITERION_RESPONSES["qualification"],
            ["Yes, fully", "Mostly, one item unclear", "No, not eligible", "Not sure"])


if __name__ == "__main__":
    unittest.main()
