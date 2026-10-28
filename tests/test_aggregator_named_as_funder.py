"""An aggregator's BRAND may not be stored as the donor, whichever list first knew it.

WHAT WENT WRONG. The pipeline has always had two defences against a republisher being
recorded as a funder: `aggregators.classify` knows non-primary HOSTS, and
`source_resolver.is_aggregator_funder` rejects a non-primary NAME. They were built at
different times from different hand-written lists, and the lists drifted — forty hosts on
one side, eleven brands on the other.

So a host could be correctly identified as an aggregator while its own name sailed through
the funder gate. `globalscholardesk.com` republished the Pandemic Fund's fourth call and
the store recorded a $244M opportunity as funded by "Globalscholardesk". The guess had no
dot in it, so the bare-host test could not see it either, and nothing else in the pipeline
has an opinion about what a funder's name looks like.

The fix is not a longer list. It is ONE list: the name check is derived from the hosts
`classify` already knows, so adding a republisher in one place covers both axes.
"""
from __future__ import annotations

import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from core import aggregators as AG                     # noqa: E402
from core import search_discovery as SD                # noqa: E402
from core import source_resolver as SR                 # noqa: E402


class TheNameCheckKnowsEveryHostTheClassifierKnowsTests(unittest.TestCase):
    """The guarantee that replaces the second list: no host may be an aggregator by URL
    and a legitimate donor by name."""

    def test_every_known_aggregator_brand_is_rejected_as_a_funder(self):
        for host in AG._KNOWN_AGGREGATORS:
            label = host.rsplit(".", 1)[0] if "." in host else host
            name = label.replace("-", " ").title()      # exactly the domain guess
            with self.subTest(host=host, name=name):
                self.assertTrue(SR.is_aggregator_funder(name),
                                f"{name!r} would be stored as the donor")

    def test_the_row_that_started_this_is_rejected(self):
        self.assertTrue(SR.is_aggregator_funder("Globalscholardesk"))
        self.assertTrue(SR.is_aggregator_funder("Grantedai"))
        self.assertTrue(SR.is_aggregator_funder("Advance Africa"))

    def test_a_siblings_domain_is_caught_by_the_brand_stem(self):
        # fundsforngos.org's paywalled sibling put four rows into the pipeline.
        self.assertTrue(SR.is_aggregator_funder("Fundsforngospremium"))

    def test_a_real_funder_name_still_passes(self):
        for name in ("The Pandemic Fund", "Wellcome", "A National Research Council",
                     "Ministry of Health", "Grand Challenges Canada",
                     "An Example Health Foundation"):
            with self.subTest(name=name):
                self.assertFalse(SR.is_aggregator_funder(name))

    def test_a_short_brand_stem_cannot_swallow_a_longer_name(self):
        # 'Candid' is six characters; prefix-matching it would reject a real funder
        # whose name merely begins the same way.
        self.assertTrue(SR.is_aggregator_funder("Candid"))
        self.assertFalse(SR.is_aggregator_funder("Candidature Health Trust"))

    def test_the_old_guarantees_are_unchanged(self):
        self.assertTrue(SR.is_aggregator_funder("DevelopmentAid Aggregator"))
        self.assertTrue(SR.is_aggregator_funder("www2.fundsforngos.org"))
        for blank in (None, "", "   "):
            self.assertFalse(SR.is_aggregator_funder(blank))

    def test_a_detector_failure_does_not_block_a_scan(self):
        import unittest.mock as mock
        with mock.patch.object(AG, "is_aggregator_name", side_effect=RuntimeError("x")):
            self.assertFalse(SR.is_aggregator_funder("Globalscholardesk"))


class TheDomainGuessIsNotMadeOnARepublishersSiteTests(unittest.TestCase):
    """On a non-primary host the guess is not unconfirmed, it is known to be wrong."""

    def test_no_funder_is_guessed_from_an_aggregator_domain(self):
        self.assertIsNone(SD._provisional_funder(
            "https://globalscholardesk.com/pandemic-fund-fourth-call-for-proposals-2026"))
        self.assertIsNone(SD._provisional_funder("https://grantedai.com/grants/x"))

    def test_no_funder_is_guessed_from_a_blog_platform(self):
        self.assertIsNone(SD._provisional_funder("https://grants-gov.blogspot.com/p/x"))

    def test_an_unknown_host_is_still_guessed_from(self):
        # The guess is what keeps dedup and the donor-intel join working, and a microsite
        # is the whole reason this channel exists. Only KNOWN republishers lose it.
        self.assertEqual(SD._provisional_funder("https://outcomesaccelerator.org/x"),
                         "Outcomesaccelerator")

    def test_a_classifier_failure_leaves_the_guess_in_place(self):
        import unittest.mock as mock
        with mock.patch.object(AG, "is_non_primary", side_effect=RuntimeError("x")):
            self.assertEqual(SD._provisional_funder("https://example.org/x"), "Example")


if __name__ == "__main__":
    unittest.main(verbosity=2)
