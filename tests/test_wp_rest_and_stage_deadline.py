"""WordPress call listings, and the close date a stage qualifier used to hide.

Owner, 2026-11-02, after finding a Coefficient Giving RFP on LinkedIn instead of in
RFPIS: "verify how to access the rfps and add the sources along their method".

Two defects came out of wiring WCRF and FCDO GRTD, and both are pinned here.

THE DEADLINE. WCRF publishes a two-stage call as

    Grant calls close (Letter of Intent stage): 13 November 2026, 5pm GMT

The label alternation required the separator to follow "close" immediately, so the
stage qualifier in brackets broke the match and the page parsed as having NO
deadline at all — on a call that is open and closes in eleven days. A candidate with
no deadline is rejected as "not-an-rfp: no valid RFP signal", so this silently lost
the whole source.

THE ENDPOINT. GRTD's /funding/ page says "Showing 37 opportunities" and ships two
links, because JetEngine renders the cards client-side. The obvious REST endpoint is
the wrong one too: the `funding-opportunitie` post type's permalinks are stubs with
no body. `_scan_wp_rest` therefore fetches the detail page whenever an item's
`content.rendered` is thin — without that, every candidate fails the gate for having
no readable text.
"""
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from core import scraper                                             # noqa: E402

# The live WCRF timeline, verbatim.
WCRF = ("Timelines Grant calls open (Letter of Intent stage): 5 October 2026, 9am BST "
        "(UK time) Grant calls close (Letter of Intent stage): 13 November 2026, 5pm "
        "GMT (UK time) Outcomes of the Letter of Intent (LOI) stage will be "
        "communicated in February 2027.")


class StageQualifiedCloseDateTests(unittest.TestCase):
    def test_the_wcrf_timeline(self):
        self.assertEqual(str(scraper._extract_deadline_from_text(WCRF)), "2026-11-13")

    def test_the_open_date_does_not_win(self):
        # "Grant calls open (…): 5 October" sits earlier in the same sentence; the
        # CLOSE date is the deadline, and February 2027 is an outcome, not a close.
        self.assertNotEqual(str(scraper._extract_deadline_from_text(WCRF)), "2026-10-05")

    def test_a_bare_parenthetical_still_needs_a_date(self):
        # The qualifier must not turn prose about closed calls into a deadline.
        self.assertIsNone(scraper._extract_deadline_from_text(
            "Our closed calls (previous rounds) are listed in the archive."))

    def test_shapes_that_already_worked(self):
        for text, want in (
            ("Applications close on 1 June 2026.", "2026-06-01"),
            ("Closes: 10 May 2026", "2026-05-10"),
            ("Date Closed May 21, 2026", "2026-05-21"),
            ("Closing date 30 November 2026", "2026-11-30"),
            ("Deadline: 23 March 2026. Extended deadline: 30 March 2026", "2026-03-30"),
            ("We have closed calls in other areas. Submission deadline: 4 July 2026",
             "2026-07-04"),
        ):
            with self.subTest(text=text):
                self.assertEqual(str(scraper._extract_deadline_from_text(text)), want)


class WpRestRoutingTests(unittest.TestCase):
    def test_a_collection_url_is_recognised(self):
        for url in ("https://www.grtd.fcdo.gov.uk/wp-json/wp/v2/pages",
                    "https://www.grtd.fcdo.gov.uk/wp-json/wp/v2/funding-opportunitie/",
                    "https://example.org/wp-json/wp/v1/calls"):
            with self.subTest(url=url):
                self.assertTrue(scraper._WP_REST_COLLECTION_RE.search(url))

    def test_a_single_item_or_query_url_is_not(self):
        # A numbered item is one post, not a collection to walk.
        self.assertFalse(scraper._WP_REST_COLLECTION_RE.search(
            "https://example.org/wp-json/wp/v2/pages/7111"))

    def test_a_non_wp_endpoint_is_not(self):
        self.assertFalse(scraper._WP_REST_COLLECTION_RE.search(
            "https://api.grants.gov/v1/api/search2"))


class WpTextTests(unittest.TestCase):
    def test_it_strips_markup_and_unescapes(self):
        self.assertEqual(
            scraper._wp_text("<p>Call for Expressions of Interest &#8211; SRHR</p>"),
            "Call for Expressions of Interest – SRHR")

    def test_empty(self):
        self.assertEqual(scraper._wp_text(None), "")
        self.assertEqual(scraper._wp_text(""), "")


class WpRestScanTests(unittest.TestCase):
    """No network: the feed and the detail fetch are both stubbed."""

    def setUp(self):
        self._get = scraper._http.get
        self._page = scraper._cg_page

    def tearDown(self):
        scraper._http.get = self._get
        scraper._cg_page = self._page

    def _serve(self, items, *, total_pages="1"):
        class R:
            status_code = 200
            headers = {"X-WP-TotalPages": total_pages}

            def raise_for_status(self):
                pass

            def json(self_inner):
                return items
        scraper._http.get = lambda *a, **k: R()

    def test_it_builds_candidates_from_the_feed(self):
        self._serve([{
            "link": "https://x.org/call-a/",
            "title": {"rendered": "Call for Proposals: Malaria"},
            "content": {"rendered": "<p>" + ("Applications close on 1 June 2026. " * 20)
                        + "</p>"},
            "date": "2026-09-30T14:55:31",
        }])
        out = scraper._scan_wp_rest("FCDO GRTD", "https://x.org/wp-json/wp/v2/pages")
        self.assertEqual(len(out), 1)
        c = out[0]
        self.assertEqual(c["opportunity_title"], "Call for Proposals: Malaria")
        self.assertEqual(c["opportunity_link"], "https://x.org/call-a/")
        self.assertEqual(c["funding_agency"], "FCDO GRTD")
        self.assertEqual(c["call_submission_deadline"], "2026-06-01")
        self.assertEqual(c["date_posted"], "2026-09-30")

    def test_an_empty_body_is_filled_from_the_detail_page(self):
        # THE GRTD CASE. content.rendered is empty on a page-builder site, and a
        # candidate with no text is rejected as "no readable description".
        self._serve([{
            "link": "https://x.org/call-b/",
            "title": {"rendered": "Call for Expressions of Interest: SRHR"},
            "content": {"rendered": ""},
            "date": "2026-09-14T14:55:31",
        }])
        body = "The centre will be funded for five years. Deadline: 30 November 2026. "
        scraper._cg_page = lambda url, headers: ("", body * 6)
        out = scraper._scan_wp_rest("FCDO GRTD", "https://x.org/wp-json/wp/v2/pages")
        self.assertEqual(len(out), 1)
        self.assertIn("funded for five years", out[0]["_page_text"])
        self.assertEqual(out[0]["call_submission_deadline"], "2026-11-30")

    def test_an_item_with_no_link_or_title_is_dropped(self):
        self._serve([{"link": "", "title": {"rendered": "No link"}},
                     {"link": "https://x.org/c/", "title": {"rendered": ""}}])
        self.assertEqual(scraper._scan_wp_rest(
            "X", "https://x.org/wp-json/wp/v2/pages"), [])

    def test_a_non_list_payload_does_not_raise(self):
        class R:
            status_code = 200
            headers: dict = {}

            def raise_for_status(self):
                pass

            def json(self):
                return {"code": "rest_no_route"}
        scraper._http.get = lambda *a, **k: R()
        self.assertEqual(scraper._scan_wp_rest(
            "X", "https://x.org/wp-json/wp/v2/nope"), [])

    def test_a_transport_failure_is_survivable(self):
        def boom(*a, **k):
            raise RuntimeError("connection reset")
        scraper._http.get = boom
        self.assertEqual(scraper._scan_wp_rest(
            "X", "https://x.org/wp-json/wp/v2/pages"), [])

    def test_rest_json_routes_a_wp_collection_here(self):
        self._serve([{"link": "https://x.org/c/",
                      "title": {"rendered": "Call for Proposals: X"},
                      "content": {"rendered": "<p>" + ("body text " * 40) + "</p>"},
                      "date": "2026-01-01T00:00:00"}])
        out = scraper._scan_rest_json("X", "https://x.org/wp-json/wp/v2/pages")
        self.assertEqual(len(out), 1)

    def test_rest_json_still_returns_nothing_for_an_unknown_endpoint(self):
        self.assertEqual(
            scraper._scan_rest_json("X", "https://api.example.org/v1/opportunities"), [])


if __name__ == "__main__":
    unittest.main()
