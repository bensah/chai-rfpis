"""The review screens open on the week that ENDED last Sunday.

Owner, 2026-11-02: "preceding week ends on sunday, monday is a first day of the week
till sunday. so friday scans will show in the same week but when viewed on Monday, it is
the previous week … load the selector to that week instead of us doing this manually all
the time when we are reviewing on Monday the following week."

Stamping is NOT changed by this: a row still records the week it was found in. Only the
selector's starting position moved.
"""
import os
import sys
import unittest
from datetime import date, timedelta

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.review_week import (                                       # noqa: E402
    all_weeks_for_year, monday_from_week_label, previous_review_week_label,
    review_week_label, week_bounds,
)


class TheReportedMondayTests(unittest.TestCase):
    """2026-11-02 is a Monday. Week 45 runs 2-8 Nov; Week 44 ran 26 Oct - 1 Nov, and the
    RFPs under review that morning were found by the Friday 30 Oct scan."""

    MONDAY = date(2026, 11, 2)

    def test_the_current_week_is_45(self):
        self.assertEqual(review_week_label(self.MONDAY), "Week 45 (2 Nov - 8 Nov)")

    def test_the_selector_opens_on_44(self):
        self.assertEqual(previous_review_week_label(self.MONDAY),
                         "Week 44 (26 Oct - 1 Nov)")

    def test_that_is_where_the_friday_scan_landed(self):
        # The scan stamps review_week_label() at scan time — Friday 30 Oct is in Week 44,
        # which is exactly the week the selector now opens on. This is the whole fix.
        friday = date(2026, 10, 30)
        self.assertEqual(friday.weekday(), 4, "30 Oct 2026 should be a Friday")
        self.assertEqual(review_week_label(friday), previous_review_week_label(self.MONDAY))


class EveryDayOfTheWeekTests(unittest.TestCase):
    def test_it_is_the_same_answer_all_week(self):
        # Reviewing on Tuesday or Thursday must not shift the window: the week under
        # review is the one that ended, whichever day you open the page.
        week = {previous_review_week_label(date(2026, 11, 2) + timedelta(days=i))
                for i in range(7)}
        self.assertEqual(week, {"Week 44 (26 Oct - 1 Nov)"})

    def test_it_moves_on_the_next_monday(self):
        self.assertEqual(previous_review_week_label(date(2026, 11, 9)),
                         "Week 45 (2 Nov - 8 Nov)")

    def test_it_is_always_exactly_seven_days_earlier(self):
        d = date(2026, 1, 1)
        while d < date(2028, 1, 1):
            cur, _ = week_bounds(d)
            prev = monday_from_week_label(previous_review_week_label(d), cur.year) \
                if previous_review_week_label(d) in all_weeks_for_year(cur.year) else None
            if prev is not None:
                self.assertEqual((cur - prev).days, 7, f"failed on {d}")
            d += timedelta(days=11)


class YearBoundaryTests(unittest.TestCase):
    """The label must stay resolvable when the previous week sits in the old year — the
    week spanning the new year is precisely when a team reviews what the year did."""

    def test_the_first_monday_of_2027_points_back_into_2026(self):
        # 2027-01-04 is a Monday; the week before it ends Sunday 2027-01-03.
        monday = date(2027, 1, 4)
        self.assertEqual(monday.weekday(), 0)
        label = previous_review_week_label(monday)
        self.assertEqual(label, review_week_label(date(2026, 12, 28)))

    def test_a_january_label_still_round_trips_to_its_monday(self):
        label = previous_review_week_label(date(2027, 1, 4))
        self.assertEqual(monday_from_week_label(label, 2026), date(2026, 12, 28))

    def test_the_default_is_offerable_by_the_pages(self):
        # The pages do `all_weeks.index(default_week)` after prepending it when absent,
        # so the only hard requirement is that it is a well-formed label.
        for d in (date(2026, 1, 4), date(2026, 6, 15), date(2027, 1, 4)):
            with self.subTest(d=d):
                self.assertRegex(previous_review_week_label(d),
                                 r"^Week \d{1,2} \(\d{1,2} \w{3} - \d{1,2} \w{3}\)$")


if __name__ == "__main__":
    unittest.main(verbosity=2)
