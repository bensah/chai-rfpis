"""Repairing the stored rows a Google Alert redirect poisoned.

Owner, 2026-11-02: "Re-resolve them."

The danger in this repair is not the two broken rows, it is the four it must NOT
touch. Five live rows carried a google.com link and only two were redirects:

    AS-261030-124802  www.google.com/goto?url=CAESyAEB…    broken
    AS-261030-124902  www.google.com/goto?url=CAESyAEB…    broken
    AB-260320-1308    docs.google.com/document/…           GiveWell's own RFI
    MI-260508-1647    docs.google.com/document/…           GiveWell's own RFI
    MI-260508-1657    docs.google.com/document/…           GiveWell's own RFI

and a sixth, SH-260301-1747, is google.org's AI Impact Challenge, where the funder
reads "Google" because Google IS the funder. A host test would have rewritten all
four of those over working links and a human's curation, so the tests below pin
the discrimination rather than the repair.
"""
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from bs4 import BeautifulSoup                                       # noqa: E402

from core import source_resolver                                    # noqa: E402
from scripts.fix_google_redirect_rows import (                      # noqa: E402
    VERIFIED, is_redirect, title_key,
)

# The real values off the reported rows.
GOTO = ("https://www.google.com/goto?url=CAESyAEB6zswFapjERKaT0cQE00xniB7PK1NHYcNW3"
        "q0Zy5DI9rzdoWb7jxYBDzml6mxIqlaCdCvp")
GIVEWELL_DOC = ("https://docs.google.com/document/d/"
                "1VDnsa9yD2ORStPkbeR-c2GkxvP88CEQaMrCx7belbyg/edit?tab=t.0")
IMPACT_CHALLENGE = "https://www.google.org/impact-challenges/ai-government-innovation/"
FEED_TITLE = "\U0001f4a1 Call for Proposals — Advanced HIV Disease (AHD) ..."


class WhatCountsAsARedirectTests(unittest.TestCase):
    def test_the_reported_goto_link(self):
        self.assertTrue(is_redirect(GOTO))

    def test_the_older_url_form(self):
        self.assertTrue(is_redirect("https://www.google.com/url?rct=j&url=https://x.org/a"))

    def test_a_bare_host_without_the_www(self):
        self.assertTrue(is_redirect("https://google.com/url?url=https://x.org/a"))

    def test_a_givewell_rfi_published_as_a_google_doc_is_not_one(self):
        # THE ONE THAT MATTERS. The Doc IS the call: GiveWell published it there,
        # the row is hand-migrated, filled and human-reviewed, and "repairing" it
        # would trade a working link for a search result.
        self.assertFalse(is_redirect(GIVEWELL_DOC))

    def test_googles_own_impact_challenge_is_not_one(self):
        self.assertFalse(is_redirect(IMPACT_CHALLENGE))

    def test_a_google_page_with_an_unrelated_query_is_not_one(self):
        self.assertFalse(is_redirect("https://www.google.com/search?q=grants"))

    def test_a_non_google_host_carrying_a_url_query_is_not_one(self):
        self.assertFalse(is_redirect("https://example.org/out?url=https://x.org/a"))

    def test_a_lookalike_host_is_not_one(self):
        # "notgoogle.com" ends with the brand but is a different registrant.
        self.assertFalse(is_redirect("https://notgoogle.com/url?url=https://x.org/a"))

    def test_nothing(self):
        self.assertFalse(is_redirect(None))
        self.assertFalse(is_redirect(""))


class TitleKeyTests(unittest.TestCase):
    def test_the_feeds_truncated_title_reaches_the_verified_entry(self):
        # Emoji, an em dash and the feed's trailing ellipsis all have to fall away
        # or the hand-verified WHO URL is never found.
        self.assertIn(title_key(FEED_TITLE), VERIFIED)

    def test_case_and_punctuation_do_not_matter(self):
        self.assertEqual(title_key("Call for Proposals: AHD!"),
                         title_key("call for proposals ahd"))


class PageTitleTests(unittest.TestCase):
    def test_it_prefers_og_title(self):
        soup = BeautifulSoup(
            '<html><head><meta property="og:title" content="Call for proposals: '
            'norms and standards for advanced HIV disease">'
            "<title>Something else entirely</title></head></html>", "html.parser")
        self.assertEqual(
            source_resolver._page_title(soup),
            "Call for proposals: norms and standards for advanced HIV disease")

    def test_it_drops_the_site_name_tail(self):
        soup = BeautifulSoup(
            "<html><head><title>Daylight Research Grant | Velux Stiftung</title>"
            "</head></html>", "html.parser")
        self.assertEqual(source_resolver._page_title(soup), "Daylight Research Grant")

    def test_it_returns_none_for_a_fragment(self):
        soup = BeautifulSoup("<html><head><title>Home</title></head></html>",
                             "html.parser")
        self.assertIsNone(source_resolver._page_title(soup))

    def test_it_returns_none_for_no_soup(self):
        self.assertIsNone(source_resolver._page_title(None))


class ForceFunderTests(unittest.TestCase):
    """`is_aggregator_funder` cannot condemn "Google", and must not learn to."""

    def test_google_is_not_an_aggregator_name(self):
        # google.org funds the AI Impact Challenge, so the name alone is innocent.
        # This is why `enrich_from_source` takes `force_funder` from the caller
        # instead of widening the name test.
        self.assertFalse(source_resolver.is_aggregator_funder("Google"))

    def test_a_bare_host_still_is(self):
        self.assertTrue(source_resolver.is_aggregator_funder("www2.fundsforngos.org"))


class ResolveAndEnrichStillDelegatesTests(unittest.TestCase):
    """The split must not change the scan path."""

    def test_it_returns_false_without_resolving(self):
        calls = []
        orig_resolve = source_resolver.resolve
        orig_enrich = source_resolver.enrich_from_source
        source_resolver.resolve = lambda *a, **k: None
        source_resolver.enrich_from_source = lambda *a, **k: calls.append(a) or True
        try:
            self.assertFalse(source_resolver.resolve_and_enrich({"opportunity_title": "x"}))
            self.assertEqual(calls, [])
        finally:
            source_resolver.resolve = orig_resolve
            source_resolver.enrich_from_source = orig_enrich

    def test_it_hands_the_resolved_url_straight_to_enrich(self):
        seen = {}
        orig_resolve = source_resolver.resolve
        orig_enrich = source_resolver.enrich_from_source

        def fake_enrich(cand, src, **kw):
            seen["src"], seen["kw"] = src, kw
            return True

        source_resolver.resolve = lambda *a, **k: "https://who.int/call"
        source_resolver.enrich_from_source = fake_enrich
        try:
            self.assertTrue(source_resolver.resolve_and_enrich({"opportunity_title": "x"}))
            self.assertEqual(seen["src"], "https://who.int/call")
            # The scan must NOT force the funder — that is the repair script's
            # privilege, and only because it knows the name came off a redirector.
            self.assertEqual(seen["kw"], {})
        finally:
            source_resolver.resolve = orig_resolve
            source_resolver.enrich_from_source = orig_enrich


if __name__ == "__main__":
    unittest.main()
