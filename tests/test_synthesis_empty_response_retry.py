"""An over-long page must not come back as "no summary".

THE REPORTED CASE. A Week-45 call with a rich funder page showed only "Summary not yet
available - open the call for full details", while the extractor had happily pulled a
value, a budget, focus areas and a geography off the same page. The owner's point: it is
hard to claim the page could not be read when other fields clearly were.

They were read by regex and by the source handler. The SUMMARY comes from the LLM, and
the LLM was never given a usable prompt.

Measured against the live endpoint on that page's own stored text (13421 chars):

    2000 chars  -> clean 1000-char brief
    4000 chars  -> clean 1000-char brief
    8000 chars  -> clean 1000-char brief
    13421 chars -> EMPTY response from every model in the chain

An over-long prompt does not come back as an error. It comes back as "", which reads
downstream as "nothing to say about this call" when it means "ask me less". The excerpt
cap was 20000, so a 13421-char page was sent whole and failed - and the brief is
deliberately left NULL on failure, with no backfill wired into the cron to try again. The
richest pages were the ones that silently produced nothing: 467 store rows held page text
and no summary.

Run:  python -m unittest tests.test_synthesis_empty_response_retry
"""
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from core import llm_synthesis as L                                   # noqa: E402

PAGE = ("Purpose of the call. " + ("The funder supports vaccine impact work. " * 600))


class TheExcerptCapTests(unittest.TestCase):
    def test_the_first_attempt_is_a_size_the_provider_accepts(self):
        # 20000 was above what the endpoint accepts; 8000 is the largest size proven to
        # return a brief for the reported page.
        self.assertLessEqual(L._MAX_INPUT_CHARS, 8000)

    def test_the_ladder_shrinks(self):
        self.assertEqual(L._RETRY_SHRINK[0], 1.0)
        self.assertTrue(all(b < a for a, b in zip(L._RETRY_SHRINK, L._RETRY_SHRINK[1:])))

    def test_the_excerpt_honours_a_per_call_cap(self):
        out = L._build_excerpt(PAGE, {"opportunity_title": "T"}, cap=2000)
        self.assertLessEqual(len(out), 2000)
        smaller = L._build_excerpt(PAGE, {"opportunity_title": "T"}, cap=1000)
        self.assertLessEqual(len(smaller), 1000)

    def test_text_that_already_fits_is_sent_whole(self):
        short = "A short call page."
        self.assertEqual(L._build_excerpt(short, {}, cap=8000), short)


class TheRetryTests(unittest.TestCase):
    def setUp(self):
        self.sizes = []
        self._orig = L._synthesize_once
        L.is_enabled = lambda: True
        self.addCleanup(lambda: setattr(L, "_synthesize_once", self._orig))

    def _record(self, result_at=None):
        def fake(candidate, org, auto, criteria=None, cap=None):
            self.sizes.append(cap)
            if result_at is not None and cap == result_at:
                return {"brief_description": "ok"}
            return None
        L._synthesize_once = fake

    def test_an_empty_response_is_retried_smaller(self):
        self._record(result_at=None)
        self.assertIsNone(L.synthesize({"_page_text": PAGE}, {}, None))
        self.assertEqual(len(self.sizes), len(L._RETRY_SHRINK))
        self.assertTrue(all(b < a for a, b in zip(self.sizes, self.sizes[1:])),
                        "each retry should ask for less: %s" % self.sizes)

    def test_it_stops_as_soon_as_one_size_works(self):
        half = max(1000, int(L._MAX_INPUT_CHARS * L._RETRY_SHRINK[1]))
        self._record(result_at=half)
        self.assertIsNotNone(L.synthesize({"_page_text": PAGE}, {}, None))
        self.assertEqual(len(self.sizes), 2, "no attempt after the one that succeeded")

    def test_a_success_first_time_makes_no_second_call(self):
        self._record(result_at=L._MAX_INPUT_CHARS)
        self.assertIsNotNone(L.synthesize({"_page_text": PAGE}, {}, None))
        self.assertEqual(len(self.sizes), 1)


class TheReportedReasonTests(unittest.TestCase):
    """The owner's rule: if it cannot read the source, it should say so."""

    def setUp(self):
        self._orig = L._synthesize_once
        self.addCleanup(lambda: setattr(L, "_synthesize_once", self._orig))

    def test_a_page_with_no_text_says_that(self):
        L.is_enabled = lambda: True
        self.assertIsNone(L.synthesize({"_page_text": "tiny"}, {}, None))
        self.assertIn("almost no readable text", L.last_failure())

    def test_a_model_that_returns_nothing_says_that_instead(self):
        L.is_enabled = lambda: True
        L._synthesize_once = lambda *a, **k: None
        self.assertIsNone(L.synthesize({"_page_text": PAGE}, {}, None))
        self.assertIn("returned nothing", L.last_failure())
        self.assertNotIn("almost no readable text", L.last_failure())

    def test_an_unconfigured_endpoint_is_not_blamed_on_the_page(self):
        L.is_enabled = lambda: False
        self.assertIsNone(L.synthesize({"_page_text": PAGE}, {}, None))
        self.assertIn("not configured", L.last_failure())

    def test_a_success_clears_the_reason(self):
        L.is_enabled = lambda: True
        L._synthesize_once = lambda *a, **k: {"brief_description": "ok"}
        self.assertIsNotNone(L.synthesize({"_page_text": PAGE}, {}, None))
        self.assertEqual(L.last_failure(), "")


class TheDisplayedBlankTests(unittest.TestCase):
    def test_the_view_separates_unread_from_unwritten(self):
        import io
        src = io.open(os.path.join(_ROOT, "views", "review_rfp.py"),
                      encoding="utf-8").read()
        self.assertIn("could not read a usable description", src)
        self.assertIn("Summary not written yet", src)
        # The old one-size-fits-all line is gone.
        self.assertNotIn("Summary not yet available", src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
