"""Two calls that differ only by query string are two calls.

THE CASE THAT EXPOSED IT (owner, 2026-11-19, asking whether the Unitaid source was
correctly wired). Unitaid lists nine live calls and every one of them is

    https://unitaid.org/call-for-proposal/?sf_id=<salesforce id>

— same host, same path, differing only in the query. `core.deduplicator._norm_url`
dropped the query outright, and `compare` rule 2 treats an identical link as DISPOSITIVE
proof that two candidates are the same call. So nine calls collapsed into one.

The scan said so and it read as good news: `donor_sources.last_scrape_status` for
Unitaid was "ok: 1 candidate(s) in 3s", dated 2026-11-13, against a listing page
carrying nine. That is the worst shape a bug can take — not an error, not a zero, just a
smaller number than the truth, reported as success by a source that looks quiet.

It was never a Unitaid quirk. Any funder addressing records by query parameter rather
than by path had the same collapse, and the symptom is silent under-collection
everywhere.

So the query is KEPT now, minus visit-tracking parameters, which identify a visit and
not a page. The tracking list is deliberately short: `id`, `ref` and `source` all look
like tracking and all name real records somewhere.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.deduplicator import _norm_url                              # noqa: E402

#: The real nine, as the listing page served them on 2026-11-19.
UNITAID = [
    "https://unitaid.org/call-for-proposal/?sf_id=119TE000000bdC5YAI",
    "https://unitaid.org/call-for-proposal/?sf_id=119Vj000003ax1RIAQ",
    "https://unitaid.org/call-for-proposal/?sf_id=119Vj000003ax1SIAQ",
    "https://unitaid.org/call-for-proposal/?sf_id=119Vj000003ax1TIAQ",
    "https://unitaid.org/call-for-proposal/?sf_id=119Vj000003ax1UIAQ",
    "https://unitaid.org/call-for-proposal/?sf_id=119Vj000003ax1VIAQ",
    "https://unitaid.org/call-for-proposal/?sf_id=119Vj000003ax1WIAQ",
    "https://unitaid.org/call-for-proposal/?sf_id=119Vj000003ax1XIAQ",
    "https://unitaid.org/call-for-proposal/?sf_id=119Vj000003n2JuIAI",
]


class NineCallsStayNine(unittest.TestCase):

    def test_the_nine_unitaid_calls_do_not_collapse(self):
        """THE REGRESSION. Before the fix this was 1."""
        self.assertEqual(len({_norm_url(u) for u in UNITAID}), 9)

    def test_the_salesforce_id_survives_normalisation(self):
        """It is the only thing distinguishing one call from another."""
        for u in UNITAID:
            sf = u.split("sf_id=")[1]
            with self.subTest(sf_id=sf):
                self.assertIn(sf, _norm_url(u))


class WhatStillCollapses(unittest.TestCase):
    """The behaviour the old function got right, kept."""

    def test_scheme_and_www_still_do_not_distinguish_a_call(self):
        same = {
            _norm_url("https://unitaid.org/call-for-proposal/?sf_id=A"),
            _norm_url("http://unitaid.org/call-for-proposal/?sf_id=A"),
            _norm_url("https://www.unitaid.org/call-for-proposal/?sf_id=A"),
        }
        self.assertEqual(len(same), 1)

    def test_a_trailing_slash_and_a_fragment_still_do_not(self):
        same = {
            _norm_url("https://x.org/call?sf_id=A"),
            _norm_url("https://x.org/call/?sf_id=A"),
            _norm_url("https://x.org/call/?sf_id=A#apply"),
        }
        self.assertEqual(len(same), 1)

    def test_tracking_parameters_do_not_distinguish_a_call(self):
        """A link from a newsletter and the same link from a tweet are one call."""
        plain = _norm_url("https://x.org/call?sf_id=A")
        for junk in ("utm_source=newsletter", "utm_campaign=x&utm_medium=email",
                     "fbclid=abc", "gclid=abc", "mc_cid=1&mc_eid=2", "_ga=1.2.3"):
            with self.subTest(tracking=junk):
                self.assertEqual(_norm_url(f"https://x.org/call?sf_id=A&{junk}"), plain)

    def test_parameter_order_does_not_distinguish_a_call(self):
        self.assertEqual(_norm_url("https://x.org/c?a=1&b=2"),
                         _norm_url("https://x.org/c?b=2&a=1"))


class WhatMustStillDistinguish(unittest.TestCase):
    """Parameters that look like tracking and are not."""

    def test_id_like_names_are_kept(self):
        for key in ("id", "ref", "source", "noticeId", "opportunityId", "sf_id", "p"):
            with self.subTest(param=key):
                a = _norm_url(f"https://x.org/c?{key}=1")
                b = _norm_url(f"https://x.org/c?{key}=2")
                self.assertNotEqual(a, b, f"{key}= stopped distinguishing two calls")

    def test_a_url_with_no_query_is_unchanged_in_shape(self):
        self.assertEqual(_norm_url("https://x.org/call/"), "//x.org/call")

    def test_blank_and_broken_input_still_answer(self):
        self.assertEqual(_norm_url(None), "")
        self.assertEqual(_norm_url(""), "")
        self.assertTrue(isinstance(_norm_url("not a url at all"), str))


class TheSharedPageVetoDoesNotDependOnTheBug(unittest.TestCase):
    """The regression that keeping the query caused, and the rule that replaced it.

    The Global Fund lists every negotiation on ONE Oracle page, distinguished only by
    `&negotiation=`. Rule 2 used to separate them with a veto — identical link, different
    reference numbers, therefore different calls — and that veto WAS ONLY EVER REACHED
    BECAUSE `_norm_url` STRIPPED THE QUERY. The two links collided, so the veto ran.

    Keeping the query stopped them colliding, rule 2 stopped firing, and the pair fell
    through to title similarity, which matched them at 95%: "HIV - Long-term Support for
    Community Engagement" against "TB - Long-term Support for Community Engagement"
    differ by three characters. A correct fix to one rule silently un-fixed another.

    The veto is rule 1b now and keys on the PAGE (host + path), which is what it was
    always about: two calls listed on one page, carrying different portal numbers. These
    tests fail if anyone re-couples it to the query.
    """

    ORACLE = ("https://fa-enmo-saasfaprod1.fa.ocs.oraclecloud.com/fscmUI/faces/"
              "NegotiationAbstracts?prcBuId=300000003071579")

    def _row(self, uid, oid, title):
        return {"uid": uid, "opportunity_id": oid, "opportunity_title": title,
                "opportunity_link": f"{self.ORACLE}&negotiation={oid}",
                "funding_agency": "The Global Fund",
                "call_submission_deadline": None, "call_award_value": None}

    def test_near_identical_titles_on_one_page_stay_separate(self):
        """95% similar titles, same page, different numbers — different calls."""
        from core import deduplicator as D
        hiv = self._row("a", "TGF-26-37", "HIV - Long-term Support for Community Engagement")
        tb = self._row("b", "TGF-26-38", "TB - Long-term Support for Community Engagement")
        self.assertEqual(D.find_duplicates(hiv, [tb]), [])

    def test_their_links_no_longer_collide(self):
        """The condition the old veto relied on is gone, which is the whole point."""
        a = self._row("a", "TGF-26-37", "x")["opportunity_link"]
        b = self._row("b", "TGF-26-38", "y")["opportunity_link"]
        self.assertNotEqual(_norm_url(a), _norm_url(b))

    def test_but_they_are_still_recognised_as_the_same_page(self):
        from core.deduplicator import _norm_url_page
        a = self._row("a", "TGF-26-37", "x")["opportunity_link"]
        b = self._row("b", "TGF-26-38", "y")["opportunity_link"]
        self.assertEqual(_norm_url_page(a), _norm_url_page(b))

    def test_the_same_negotiation_is_still_one_call(self):
        from core import deduplicator as D
        a = self._row("a", "TGF-26-37", "HIV - Long-term Support")
        b = self._row("b", "TGF-26-37", "HIV - Long-term Support")
        self.assertEqual(len(D.find_duplicates(a, [b])), 1)

    def test_two_unitaid_calls_are_not_vetoed_into_oblivion(self):
        """Rule 1b must not swallow the case this change exists for.

        Unitaid's calls share a page too, so if they carried different opportunity_ids
        rule 1b would separate them — which is correct. With no ids at all they must
        still be separated, by their now-distinct links, rather than matched.
        """
        from core import deduplicator as D
        a = {"uid": "a", "opportunity_id": None, "opportunity_title": "Call A",
             "opportunity_link": UNITAID[0], "funding_agency": "Unitaid",
             "call_submission_deadline": None, "call_award_value": None}
        b = {"uid": "b", "opportunity_id": None, "opportunity_title": "Call B",
             "opportunity_link": UNITAID[1], "funding_agency": "Unitaid",
             "call_submission_deadline": None, "call_award_value": None}
        self.assertEqual(D.find_duplicates(a, [b]), [])


if __name__ == "__main__":
    unittest.main()
