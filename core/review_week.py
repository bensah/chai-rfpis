"""Review-week label helper.

Matches the Excel screener's week label format:
    "Week 22 (25 May - 31 May)"
ISO week numbering, Monday-anchored. The screener's review week is the
upcoming Monday's week (i.e. the week the Friday scan feeds into).
"""
from __future__ import annotations

from datetime import date, timedelta


def week_bounds(d: date) -> tuple[date, date]:
    """(Monday, Sunday) of the ISO week containing `d`."""
    monday = d - timedelta(days=d.weekday())
    return monday, monday + timedelta(days=6)


def _fmt_day(d: date) -> str:
    return d.strftime("%d %b").lstrip("0")


def review_week_label(d: date | None = None) -> str:
    """Return 'Week N (DD Mon - DD Mon)' for the week containing `d` (default today)."""
    d = d or date.today()
    mon, sun = week_bounds(d)
    return f"Week {mon.isocalendar().week} ({_fmt_day(mon)} - {_fmt_day(sun)})"


def upcoming_review_week_label(d: date | None = None) -> str:
    """Label for the *upcoming* review week.

    A Friday scan (or weekend submission) feeds the following Monday's review,
    so we advance to next Monday when called on Friday/Saturday/Sunday.
    """
    d = d or date.today()
    if d.weekday() >= 4:  # Fri/Sat/Sun -> next week
        d = d + timedelta(days=(7 - d.weekday()))
    return review_week_label(d)


def all_weeks_for_year(year: int) -> list[str]:
    """All 52 (or 53) ISO-week labels for the given year. Used in selectors."""
    labels: list[str] = []
    d = date(year, 1, 4)  # Jan 4 is always in week 1
    mon, _ = week_bounds(d)
    while mon.year <= year:
        labels.append(review_week_label(mon))
        mon = mon + timedelta(days=7)
        if mon.year > year and mon.isocalendar().week == 1:
            break
    return labels


def monday_from_week_label(label: str, year: int) -> date:
    """'Week 23 (1 Jun - 7 Jun)' → date(2026, 6, 1) for year=2026.

    Resolved by RELABELLING the year's Mondays and taking the one that renders as the
    label asked for, rather than by arithmetic on the week number.

    THE WEEK NUMBER IS NOT UNIQUE within a year's labels. `all_weeks_for_year` walks from
    the Monday of the week containing 4 January, which can belong to the PREVIOUS calendar
    year, and keeps going while that Monday's year is still `year` — so a year can both
    begin and end with a label reading "Week 1". 2025's list starts with
    "Week 1 (30 Dec - 5 Jan)" and ends with "Week 1 (29 Dec - 4 Jan)".

    Resolving "Week 1" by number therefore returned the FIRST one for both, and the last
    week of the year came back as a date twelve months earlier. Measured over 2023-2027,
    two labels failed to round-trip. It was invisible in a selector, which only ever turns
    back a label it just rendered, and wrong where a label is turned into a date to read
    data with: `summary_rfp` resolves the selected week to a start date, and `tracking_rfp`
    looks up the meeting note whose `meeting_date` equals that Monday. Both would have read
    the wrong week — and it is the week spanning the new year, when a team is reviewing
    what the year did.

    An unrecognised label (a stale one from another year) falls back to the old arithmetic,
    so a caller still gets a date rather than an exception.
    """
    d = date(year, 1, 4)          # 4 January is always in ISO week 1
    mon, _ = week_bounds(d)
    while mon.year <= year:
        if review_week_label(mon) == label:
            return mon
        mon = mon + timedelta(days=7)

    week_num = int(label.split()[1])
    jan4 = date(year, 1, 4)
    base_mon, _ = week_bounds(jan4)
    return base_mon + timedelta(days=(week_num - base_mon.isocalendar().week) * 7)
