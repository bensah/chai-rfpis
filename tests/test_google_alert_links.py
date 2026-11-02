"""Google Alert links: unwrap what we can, and never name the redirector as the funder.

Reported 2026-11-02. AS-261030-124802 was stored with funder "Google", no description,
no deadline, no value and no instrument type — an empty row presented on the Screen
table as a Google funding opportunity. Its link was

    https://www.google.com/goto?url=CAESyAEB6zswFapjERKaT0cQE00xniB7PK1NHYcNW3q0Zy5...

`_unwrap_google_url` only knew `google.com/url?`, so `/goto?` passed through untouched,
`_domain_to_funder` read the host, and the scan stored the redirector as the donor.
"""
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from core.scraper import (                                          # noqa: E402
    _domain_to_funder, _google_redirect_host, _is_google_alert_noise,
    _strip_www, _unwrap_google_url,
)

# The real link off the reported row, truncated — the token is opaque either way.
GOTO = ("https://www.google.com/goto?url=CAESyAEB6zswFapjERKaT0cQE00xniB7PK1NHYcNW3"
        "q0Zy5DI9rzdoWb7jxYBDzml6mxIqlaCdCvp")


class StripWwwTests(unittest.TestCase):
    def test_it_strips_the_prefix(self):
        self.assertEqual(_strip_www("www.gatesfoundation.org"), "gatesfoundation.org")

    def test_it_is_not_lstrip(self):
        # `"www.worldbank.org".lstrip("www.")` == "orldbank.org": lstrip takes a SET of
        # characters, so it keeps eating leading w's and dots into the real name.
        self.assertEqual(_strip_www("www.worldbank.org"), "worldbank.org")
        self.assertEqual("www.worldbank.org".lstrip("www."), "orldbank.org")

    def test_a_host_with_no_prefix_is_untouched(self):
        self.assertEqual(_strip_www("wellcome.org"), "wellcome.org")


class UnwrapTests(unittest.TestCase):
    def test_the_url_form_still_unwraps(self):
        self.assertEqual(
            _unwrap_google_url(
                "https://www.google.com/url?rct=j&url=https%3A%2F%2Fwellcome.org%2Fgrants"
                "&usg=AOv"),
            "https://wellcome.org/grants")

    def test_the_q_form_unwraps(self):
        self.assertEqual(
            _unwrap_google_url("https://www.google.com/url?q=https://gcgh.grandchallenges.org/x"),
            "https://gcgh.grandchallenges.org/x")

    def test_an_opaque_goto_token_is_not_decoded(self):
        # It is not a URL, so it is returned unchanged for the redirect check to reject.
        # Guessing at Google's internal encoding would be a different bug later.
        self.assertEqual(_unwrap_google_url(GOTO), GOTO)

    def test_a_non_google_link_is_untouched(self):
        url = "https://www.grandchallenges.ca/funding-opportunity-nexa-lighthouse/"
        self.assertEqual(_unwrap_google_url(url), url)

    def test_a_relative_or_javascript_target_is_refused(self):
        # Only an absolute http(s) target is accepted as the real destination.
        self.assertEqual(
            _unwrap_google_url("https://www.google.com/url?url=/search%3Fq%3Dgrants"),
            "https://www.google.com/url?url=/search%3Fq%3Dgrants")

    def test_empty_in_empty_out(self):
        self.assertEqual(_unwrap_google_url(""), "")


class RedirectHostTests(unittest.TestCase):
    def test_the_reported_link_is_still_a_google_host(self):
        self.assertTrue(_google_redirect_host(_unwrap_google_url(GOTO)))

    def test_an_unwrapped_link_is_not(self):
        self.assertFalse(_google_redirect_host(
            _unwrap_google_url("https://www.google.com/url?q=https://wellcome.org/x")))

    def test_a_real_funder_host_is_not(self):
        self.assertFalse(_google_redirect_host("https://www.grandchallenges.ca/x"))


class FunderNameTests(unittest.TestCase):
    def test_the_redirector_is_never_the_funder(self):
        # The whole point: this returned "google.com" (canonicalised to "Google").
        self.assertIsNone(_domain_to_funder(GOTO))

    def test_news_and_social_hosts_are_not_funders_either(self):
        for url in ("https://news.google.com/articles/abc",
                    "https://www.linkedin.com/posts/x",
                    "https://twitter.com/x/status/1"):
            with self.subTest(url=url):
                self.assertIsNone(_domain_to_funder(url))

    def test_a_real_host_still_becomes_a_label(self):
        self.assertEqual(
            _domain_to_funder("https://www.fondation-mma.org/calls"), "fondation-mma.org")

    def test_a_bare_host_with_no_scheme_does_not_crash(self):
        self.assertIsNone(_domain_to_funder("not a url at all"))


class NoiseTests(unittest.TestCase):
    def test_any_google_host_counts_as_noise(self):
        for url in (GOTO, "https://news.google.com/x", "https://scholar.google.com/x"):
            with self.subTest(url=url):
                self.assertTrue(_is_google_alert_noise(url))

    def test_a_donor_site_is_not_noise(self):
        self.assertFalse(_is_google_alert_noise("https://www.grandchallenges.ca/x"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
