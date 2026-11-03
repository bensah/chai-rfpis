"""A staged call labels every stage "Deadline for …". Only one of them is actionable.

Owner, 2026-11-03: "Fix the SRHR date."

FCDO's SRHR Applied Research Centre call closed its Expressions of Interest on 30
November 2026. RFPIS read it as 16 April 2027 — five months of runway that does not
exist, on the only date a reader could still act on. Three separate faults, all on the
one page, and each is pinned below:

  1. THE PAGE SAYS IT IN PROSE, AND WE COULD NOT READ IT.
         "The deadline for Expressions of Interest is 17:00 GMT on Monday,
          30 November 2026."
     ":" was not a capture character, so the capture stopped at "is 17" and this
     sentence — the plainest statement of the deadline anywhere on the page — yielded
     no date at all.

  2. A QUESTIONS DEADLINE IS NOT A SUBMISSION DEADLINE.
         "Deadline for submitting questions 6 November 2026"
     Nothing is submitted by it and it falls BEFORE the real one, so if it won it would
     shorten the call rather than merely mislabel it.

  3. THE LAST STAGE IS NOT THE DEADLINE.
         "Deadline for Expressions of Interest 30 November 2026"   <- stage 1
         "Deadline for Full Proposals 16 April 2027"               <- stage 2
     Taking the latest labelled date is right for an EXTENSION, which replaces what came
     before, and wrong for a STAGE, which does not. Only applicants who made stage 1 ever
     see stage 2.

No network: the text below is the live page's, verbatim.
"""
from __future__ import annotations

import os
import sys
import unittest
from datetime import date, timedelta

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from core.scraper import _extract_deadline_from_text as extract   # noqa: E402

PROSE = ("Applicants must be an academic or non-profit research institution registered "
         "as a legal entity in the respective country. The deadline for Expressions of "
         "Interest is 17:00 GMT on Monday, 30 November 2026. At a glance Background")

TIMETABLE = (
    "Indicative timeline Date Competition (EOI) launched 30 September 2026 "
    "Virtual Q&A webinar 6 October 2026, 11:00 BST (10:00 GMT) "
    "Deadline for submitting questions 6 November 2026 "
    "Deadline for Expressions of Interest 30 November 2026, 17:00 GMT "
    "Applicants notified of shortlisting decisions 8 January 2027 "
    "Completion of due diligence and contracting for proposal development grants "
    "26 January 2027 Full Proposal phase launched 1 February 2027 "
    "Deadline for Full Proposals 16 April 2027, 17:00 GMT "
    "Funding decision to preferred bidder 28 May 2027 "
    "Accountable grant signed Early June 2027")


class TheProseSentenceTests(unittest.TestCase):
    def test_a_clock_time_no_longer_truncates_the_phrase(self):
        self.assertEqual(extract(PROSE), date(2026, 11, 30))

    def test_the_time_itself_is_not_read_as_a_date(self):
        self.assertNotEqual(extract(PROSE), date(2026, 11, 17))

    def test_a_bare_colon_still_ends_the_capture(self):
        # The reason ":" is allowed only inside a TIME: a loose colon would let the
        # capture swallow the next label, and the extension would stop being seen.
        nxt = date.today().year + 1
        self.assertEqual(
            extract(f"deadline: 23 march {nxt}. extended deadline: 30 march {nxt}."),
            date(nxt, 3, 30))


class TheQuestionsDeadlineTests(unittest.TestCase):
    def test_on_its_own_it_yields_nothing(self):
        self.assertIsNone(extract("Deadline for submitting questions 6 November 2026"))

    def test_the_other_spellings_too(self):
        for text in ("Deadline for queries: 6 November 2026",
                     "Deadline for clarification 6 November 2026",
                     "Deadline for submitting enquiries 6 November 2026"):
            with self.subTest(text=text):
                self.assertIsNone(extract(text))

    def test_a_real_deadline_in_the_same_breath_still_wins(self):
        self.assertEqual(
            extract("Deadline for submitting questions 6 November 2026. "
                    "Submission deadline: 30 November 2026."),
            date(2026, 11, 30))


class TheStagedTimetableTests(unittest.TestCase):
    """Today is after the EOI stage opened and before it closes."""

    def test_stage_one_wins_over_stage_two(self):
        self.assertEqual(extract(TIMETABLE), date(2026, 11, 30))

    def test_the_full_proposal_stage_is_not_returned(self):
        # The answer before the fix, and the one that invented five months of runway.
        self.assertNotEqual(extract(TIMETABLE), date(2027, 4, 16))

    def test_the_whole_page_agrees_with_the_timetable(self):
        self.assertEqual(extract(PROSE + " " + TIMETABLE), date(2026, 11, 30))

    def test_a_later_stage_alone_is_still_a_deadline(self):
        # Nothing here says there was an earlier stage, so this IS the date to meet.
        self.assertEqual(extract("Deadline for Full Proposals 16 April 2027, 17:00 GMT"),
                         date(2027, 4, 16))


class WhenEveryStageHasPassedTests(unittest.TestCase):
    """A closed call must report its real last date, not an older stage — otherwise it
    reads as longer dead than it is, and a reviewer checking whether it has reopened is
    looking at the wrong date."""

    def test_the_latest_is_reported(self):
        self.assertEqual(
            extract("Deadline for Expressions of Interest 3 February 2024. "
                    "Deadline for Full Proposals 16 April 2024."),
            date(2024, 4, 16))

    def test_a_past_stage_does_not_hide_a_future_one(self):
        past = date.today() - timedelta(days=30)
        ahead = date.today() + timedelta(days=30)
        text = (f"Deadline for concept notes {past.strftime('%d %B %Y')}. "
                f"Deadline for full proposals {ahead.strftime('%d %B %Y')}.")
        self.assertEqual(extract(text), ahead)


if __name__ == "__main__":
    unittest.main(verbosity=2)
