"""A bulk listing gets its own deadline, and a feed that fails says so.

WHY THE TWO BELONG TOGETHER
---------------------------
`HTTP_TIMEOUT = 15` is deliberately aggressive, and right for the hundreds of
per-page fetches in a crawl: one slow donor page must not stall a scan, and
losing it costs one candidate.

A listing fetch is the opposite trade. It is ONE request per source, it returns
the whole feed, and losing it costs the ENTIRE SOURCE for that scan. Find a
Tender — 356 rows, the second largest source in the catalogue — answered in under
15s on one attempt and timed out on the next on 2026-11-19. The HTTP layer had
already retried (the error was "Max retries exceeded"), so the problem was the
deadline, not the retry count; the same feed completed comfortably at 60.

The second half matters as much. A source that fails its listing and a source
with nothing new both return zero candidates, and every other line of the scan
summary reads the same for both. `note_listing_failure` is what makes a bad day
distinguishable from a quiet one.

UNITTEST, NOT PYTEST — see the note in `tests/test_field_extract.py`. The suite's
own runner (`scripts/run_tests.py`) shells out to `unittest discover` per module
and pytest is not in `requirements.txt`, so a pytest-style module runs NO TESTS
here while passing locally for whoever has pytest installed.

Offline — no network, no database.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import scraper  # noqa: E402


class ListingDeadlineTests(unittest.TestCase):
    """The deadline itself."""

    def test_a_listing_gets_longer_than_a_page(self):
        """If these ever converge, the distinction this module draws has been lost."""
        self.assertGreater(scraper.LISTING_TIMEOUT, scraper.HTTP_TIMEOUT)

    def test_the_listing_deadline_is_long_enough_for_the_feed_that_prompted_it(self):
        """Find a Tender completed at 60s and failed at 15s."""
        self.assertGreaterEqual(scraper.LISTING_TIMEOUT, 60)

    def test_the_page_deadline_is_untouched(self):
        """Bumping this instead would have slowed every failing fetch in a crawl —
        hundreds of them — to fix one request per source."""
        self.assertEqual(scraper.HTTP_TIMEOUT, 15)

    def test_every_bulk_listing_fetch_uses_the_longer_deadline(self):
        """Read off the source rather than asserted per call site, so a NEW listing
        handler that reaches for HTTP_TIMEOUT is caught by the count going stale
        rather than by nobody noticing."""
        src = Path(scraper.__file__).read_text(encoding="utf-8")
        # Each recorded failure sits in the `except` of a listing fetch.
        recorders = src.count("note_listing_failure(") - 1      # minus the definition
        listing_timeouts = src.count("timeout=LISTING_TIMEOUT")
        self.assertGreaterEqual(recorders, 11, recorders)
        self.assertEqual(
            listing_timeouts, recorders,
            f"{recorders} listing handlers record a failure but {listing_timeouts} "
            "use LISTING_TIMEOUT — one of them is still on the per-page deadline")


class ListingFailureIsVisibleTests(unittest.TestCase):
    """A source that could not be read must not read like a source with nothing."""

    def setUp(self):
        scraper.reset_listing_failures()

    def tearDown(self):
        scraper.reset_listing_failures()

    def test_a_failure_is_recorded_against_its_source(self):
        scraper.note_listing_failure("UK Find a Tender Service",
                                     TimeoutError("read timed out"))
        failures = scraper.listing_failures()
        self.assertEqual(len(failures), 1)
        name, reason = failures[0]
        self.assertEqual(name, "UK Find a Tender Service")
        self.assertIn("TimeoutError", reason)
        self.assertIn("read timed out", reason)

    def test_several_failures_are_all_kept(self):
        scraper.note_listing_failure("TED", TimeoutError("a"))
        scraper.note_listing_failure("UNGM (page 1)", ValueError("b"))
        self.assertEqual([n for n, _ in scraper.listing_failures()],
                         ["TED", "UNGM (page 1)"])

    def test_a_reason_that_is_not_an_exception_is_still_recorded(self):
        scraper.note_listing_failure("Packard", "HTTP 503 from the origin")
        self.assertIn("503", scraper.listing_failures()[0][1])

    def test_a_runaway_reason_is_truncated(self):
        """A stack-trace-shaped reason must not turn the scan summary into a dump."""
        scraper.note_listing_failure("CHINNOVA", RuntimeError("x" * 5000))
        self.assertLessEqual(len(scraper.listing_failures()[0][1]), 300)

    def test_the_record_resets_between_scans(self):
        scraper.note_listing_failure("TED", TimeoutError("a"))
        scraper.reset_listing_failures()
        self.assertEqual(scraper.listing_failures(), [])

    def test_the_caller_cannot_mutate_the_record_by_accident(self):
        scraper.note_listing_failure("TED", TimeoutError("a"))
        got = scraper.listing_failures()
        got.append(("not real", "injected"))
        self.assertEqual(len(scraper.listing_failures()), 1)

    def test_no_failures_is_an_empty_list_not_none(self):
        """The scan summary branches on truthiness; None would read the same but
        break the iteration behind it."""
        self.assertEqual(scraper.listing_failures(), [])


if __name__ == "__main__":
    unittest.main()
