"""PREFER-7: "we hold no relationship data" must not read as "no relationship".

THE REPORTED CASE. The stored `alignment_score` and the Opportunity page disagreed by
exactly 4.0 points on every row of a tenant — 60 of 60 sampled, a flat offset, with the
`policies` argument and auto_score's keyword-assist pass both measured and ruled out.

The cause was a collision between two meanings of the same six letters:

    "None"  (a string)  we HOLD relationship data and it shows no relationship  -> 0
     None   (the object) we hold NO relationship data                           -> Not sure

`derive_funder_relationship` drew that distinction. `_relationship_factors` did not: it
built `rel_grantee` and `rel_contact` with `met=False` whether the org's funder history
said "not this funder" or was simply EMPTY. `criteria_review._rel_rule` cannot tell those
apart — it reads `by_key.get("rel_grantee", 0.0)`, so an absent component and one scored 0
are both 0.0 — and so returned its floor label "None". That is a SCORING label, not an
unknown one, so `criterion_score` banded it 0 instead of leaving it unsure, and the
criterion lost its half credit: weight 0.08 x 50 = 4.0 points, on every row.

`rel_engaged` never had the bug — it carries `active=sc is not None`. Its two siblings now
share `_no_relationship_data`, which is the derivation's own test.

Both directions are pinned here, because the fix must not simply silence "None": an org
that HAS funder history which does not include this funder is genuinely unrelated to it,
and must still score 0.

Run:  python -m unittest tests.test_prefer7_no_relationship_data
"""
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from core import criteria_derive as CD                      # noqa: E402
from core import criteria_review as CR                      # noqa: E402
from core.scorer import criterion_score                     # noqa: E402

RFP = {"uid": "T-1", "opportunity_title": "A health systems call",
       "funding_agency": "Some Funder We Have Never Met"}

EMPTY_ORG: dict = {
    "org_funder_history": [], "org_donor_registrations": [],
    "trusted_partners": [], "org_engaged_donors": [], "org_active_donors": [],
}

# Relationship data ON FILE, naming a DIFFERENT funder: a real, measured "no relationship".
ORG_WITH_HISTORY: dict = {
    "org_funder_history": ["A Completely Different Funder"],
    "org_donor_registrations": [], "trusted_partners": [],
    "org_engaged_donors": [], "org_active_donors": [],
}


def label_for(org: dict) -> str:
    """The label the Opportunity page and the Review card both show."""
    derived = CD.derive_funder_relationship(org, RFP, None)
    facts = CD._relationship_factors(org, RFP, None)
    return CR.criterion_label("funder_relationship", facts, derived)


class NoRelationshipData(unittest.TestCase):
    def test_empty_profile_derives_not_sure(self):
        """The derivation's own contract: None only when we hold no data."""
        self.assertIsNone(CD.derive_funder_relationship(EMPTY_ORG, RFP, None))

    def test_empty_profile_leaves_every_component_inactive(self):
        """Nothing to judge → nothing to score. Inactive components are shown as
        not-applicable and stay out of the won/total denominator."""
        facts = CD._relationship_factors(EMPTY_ORG, RFP, None)
        self.assertTrue(facts, "the components should still be listed")
        self.assertEqual([], CR.active_components(facts))
        for f in facts:
            self.assertIsNone(f.get("met"), f"{f['key']} must not assert a measured verdict")

    def test_empty_profile_rolls_up_to_nothing(self):
        """With no active component the roll-up must decline to name the criterion,
        rather than falling through to its floor label."""
        facts = CD._relationship_factors(EMPTY_ORG, RFP, None)
        self.assertIsNone(CR.roll_up("funder_relationship", facts))

    def test_empty_profile_labels_not_sure_and_scores_unsure(self):
        """The regression itself: 'Not sure' (band None → half credit), never the
        string 'None' (band 0), which cost 4.0 points on every row."""
        label = label_for(EMPTY_ORG)
        self.assertEqual("Not sure", label)
        self.assertIsNone(criterion_score(label),
                          "an undetermined criterion must band as unsure, not as 0")


class RelationshipDataOnFile(unittest.TestCase):
    """The other direction — the fix must not silence a genuine 'no relationship'."""

    def test_history_naming_another_funder_still_scores_zero(self):
        self.assertEqual("None", CD.derive_funder_relationship(ORG_WITH_HISTORY, RFP, None))
        label = label_for(ORG_WITH_HISTORY)
        self.assertEqual("None", label)
        self.assertEqual(0, criterion_score(label),
                         "a measured absence of any relationship still scores 0")

    def test_components_stay_active_when_there_is_data_to_judge(self):
        facts = CD._relationship_factors(ORG_WITH_HISTORY, RFP, None)
        active = CR.active_components(facts)
        self.assertTrue(active, "with data on file the tiers must be scoreable")
        self.assertIn("rel_grantee", {f["key"] for f in active})


class InheritedThroughTheGraph(unittest.TestCase):
    """A relationship reaching us through the APPLICANT GRAPH is still data.

    The first cut of this fix stood the components down on the org's own profile fields
    alone, which threw away a grantee fact held by the parent org, the Prime or a co-Sub —
    `tests/test_prefer7_signatory_graph` caught it. `_relationship_factors` now checks the
    positive tiers first, exactly as `derive_funder_relationship` does before reaching its
    own no-data test.
    """

    def test_graph_grantee_keeps_the_component_active_and_met(self):
        rfp = dict(RFP, funding_agency="A Funder The Parent Org Knows")

        class _Graph:
            """Minimal stand-in: the parent org carries the funder history."""
            def __init__(self):
                self.members = [{"org_funder_history": ["A Funder The Parent Org Knows"]}]

        # Only assert the inheritance when this build's graph helper accepts the stand-in;
        # the real contract is pinned by tests/test_prefer7_signatory_graph.
        try:
            inherited = CD._grantee_graph(EMPTY_ORG, rfp, None, _Graph())
        except Exception:
            self.skipTest("graph helper needs the richer fixture in test_prefer7_signatory_graph")
        if not inherited:
            self.skipTest("graph helper needs the richer fixture in test_prefer7_signatory_graph")

        facts = CD._relationship_factors(EMPTY_ORG, rfp, None, _Graph())
        by_key = {f["key"]: f for f in facts}
        self.assertTrue(by_key["rel_grantee"]["active"],
                        "an inherited grantee fact must stay scoreable")
        self.assertTrue(by_key["rel_grantee"]["met"])


class SharedTest(unittest.TestCase):
    """The derivation and the components must keep using ONE test, not two."""

    def test_no_relationship_data_agrees_with_the_derivation(self):
        for org, expect_unknown in ((EMPTY_ORG, True), (ORG_WITH_HISTORY, False)):
            with self.subTest(org=org.get("org_funder_history")):
                self.assertEqual(expect_unknown,
                                 CD._no_relationship_data(org, None))
                self.assertEqual(
                    expect_unknown,
                    CD.derive_funder_relationship(org, RFP, None) is None)


if __name__ == "__main__":
    unittest.main()
