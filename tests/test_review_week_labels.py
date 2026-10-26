"""Every week label must resolve back to the week it names.

A label is only meaningful if turning it into a date and rendering that date gives the
label back. Two places turn a label into a date and then READ DATA with it — the Summary
page's selected week, and the Track card's meeting-note lookup — so a label that resolves
to the wrong Monday does not look like a bug, it looks like a week with no activity in it.
"""
from __future__ import annotations

import unittest
from datetime import date, timedelta

from core.review_week import (
    all_weeks_for_year, monday_from_week_label, review_week_label, week_bounds,
)


class TestLabelsRoundTrip(unittest.TestCase):
    # 2024 and 2025 are the interesting ones: each has a year that both begins and ends
    # with a label reading "Week 1". Resolving by week number returned the first for both.
    YEARS = (2022, 2023, 2024, 2025, 2026, 2027, 2028)

    def test_every_label_resolves_to_the_week_it_names(self):
        for year in self.YEARS:
            for label in all_weeks_for_year(year):
                monday = monday_from_week_label(label, year)
                self.assertEqual(
                    review_week_label(monday), label,
                    f"{year}: {label!r} resolved to {monday}, which is "
                    f"{review_week_label(monday)!r}")

    def test_a_year_may_carry_two_week_one_labels_and_they_differ(self):
        """The case the arithmetic could not express."""
        for year in self.YEARS:
            labels = all_weeks_for_year(year)
            week_ones = [lab for lab in labels if lab.split()[1] == "1"]
            if len(week_ones) < 2:
                continue
            mondays = {monday_from_week_label(lab, year) for lab in week_ones}
            self.assertEqual(
                len(mondays), len(week_ones),
                f"{year}: {week_ones} collapsed onto {mondays}")
            # And they are a year apart, not a week.
            self.assertGreater(max(mondays) - min(mondays), timedelta(days=300))

    def test_every_label_is_a_monday(self):
        for year in self.YEARS:
            for label in all_weeks_for_year(year):
                monday = monday_from_week_label(label, year)
                self.assertEqual(monday.weekday(), 0, f"{year}: {label!r} → {monday}")

    def test_labels_are_in_order_and_one_week_apart(self):
        for year in self.YEARS:
            mondays = [monday_from_week_label(lab, year) for lab in all_weeks_for_year(year)]
            for earlier, later in zip(mondays, mondays[1:]):
                self.assertEqual(
                    later - earlier, timedelta(days=7),
                    f"{year}: {earlier} then {later} is not one week")

    def test_an_unknown_label_still_returns_a_date(self):
        """A stale label from another year must not raise on a page that is only reading."""
        got = monday_from_week_label("Week 9 (1 Jan - 7 Jan)", 2026)
        self.assertIsInstance(got, date)

    def test_the_current_week_resolves_to_this_monday(self):
        today = date.today()
        monday, _ = week_bounds(today)
        label = review_week_label(today)
        # The label belongs to whichever year list contains it; try the Monday's own year.
        self.assertEqual(monday_from_week_label(label, monday.year), monday)


if __name__ == "__main__":
    unittest.main()
