"""Shared pipeline-status helpers.

Deadline-status thresholds match the original Excel:
    Overdue          deadline < today
    Due Soon         today <= deadline <= today + 14
    On Track         deadline > today + 14

Probability-tier thresholds (single source of truth — used by Data page,
Highlights, and any future consumer):
    High        alignment_score >  90
    Medium      70 <= alignment_score <= 90
    Low         alignment_score <  70

`is_active_proceed` is the single source of truth for "an opportunity the team can
still act on" — used by the Tracking pipeline and the Meetings note-taker.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pandas as pd

from core import dropdowns


DUE_SOON_DAYS = 14

# Probability tier thresholds
PROB_HIGH_MIN = 90   # > 90 → High
PROB_MED_MIN = 70    # >= 70 → Medium; < 70 → Low
PROB_LABEL_HIGH = "High (>90%)"
PROB_LABEL_MED = "Medium (70-90%)"
PROB_LABEL_LOW = "Low (<70%)"


def prob_tier(score: Any, short: bool = False) -> str | None:
    """Return the probability tier label for a given alignment_score.

    Returns None for null/non-numeric scores. When `short=True`, returns
    "High" / "Medium" / "Low" without the percentage band.
    """
    if score is None:
        return None
    try:
        s = float(score)
        if pd.isna(s):
            return None
    except (TypeError, ValueError):
        return None
    if s > PROB_HIGH_MIN:
        return "High" if short else PROB_LABEL_HIGH
    if s >= PROB_MED_MIN:
        return "Medium" if short else PROB_LABEL_MED
    return "Low" if short else PROB_LABEL_LOW


def deadline_status(d: Any, submitted: bool = False,
                    decision: str | None = None) -> str | None:
    """Deadline chip for a call/grant.

    Once a proposal has been SUBMITTED, a passed deadline is no longer "Overdue" — the
    window closing is expected. Instead we report the state-accurate outcome:
      * decision Approved  → "Awarded"
      * decision Not Approved → "Not approved"
      * otherwise (awaiting a decision) → "Submitted"
    Not-yet-submitted calls keep the discovery semantics (Overdue / Due Soon / On Track)."""
    if d is None or (isinstance(d, float) and pd.isna(d)):
        return None
    try:
        dt = pd.to_datetime(d, errors="coerce")
        if pd.isna(dt):
            return None
        deadline = dt.date()
    except Exception:
        return None
    today = date.today()
    if deadline < today:
        if submitted:
            dec = (decision or "").strip().lower()
            if dec == "approved":
                return "Awarded"
            if dec == "not approved":
                return "Not approved"
            return "Submitted"
        return "Overdue"
    if deadline <= today + timedelta(days=DUE_SOON_DAYS):
        return "Due Soon"
    return "On Track"


def days_to_deadline(d: Any) -> int | None:
    if d is None or (isinstance(d, float) and pd.isna(d)):
        return None
    try:
        dt = pd.to_datetime(d, errors="coerce")
        if pd.isna(dt):
            return None
        return (dt.date() - date.today()).days
    except Exception:
        return None


# ---------------------------------------------------------------------------
# "Active Proceed" — the single source of truth for an opportunity the team can
# still act on. The Tracking page has carried this rule since it was written; the
# Meetings note-taker carried its own shorter version and drifted, which is why it
# lives here now and both import it.
#
# A row is ACTIVE when all four hold:
#   * decision starts with "Proceed" — post-screening, the team agreed to pursue it;
#   * it is the canonical row, not a duplicate;
#   * nothing records a submission (see `_submitted` below);
#   * the deadline has not passed (a NULL deadline is not a passed one — an
#     open-ended or unrecorded deadline keeps the row active rather than hiding it).
#
# Anything that fails one of these is history: it belongs on the Data page and in
# the Report, not in a dropdown of things to do something about this week.
# ---------------------------------------------------------------------------

# The ONLY donor_decision values that still mean "in our hands". Deliberately an
# allowlist, not a list of decisions to exclude: a donor can only decide on a proposal
# it received, so ANY other value — Approved, Under Review, Not Approved, Submitted, or
# a word added to the dropdown next year — proves the proposal went in. The Report
# counts submissions with the inverse list (views/report.py::_submitted_mask), which is
# right for a historical total but would read a value it has never seen as unsubmitted.
_UNSUBMITTED_DONOR_DECISIONS = {"", "not submitted"}

# Progress states that take a row off the active pipeline whatever its decision says.
# Completed = the proposal went in; Discontinued = the team dropped it on purpose.
_CLOSED_PROGRESS = {"completed", "discontinued"}


def _txt(v: Any) -> str:
    """Lower-cased text for comparison, with the Excel-import 'nan' treated as blank.

    Rows migrated from the workbook carry the literal string "nan" where the cell was
    empty, and `str(float('nan'))` produces the same thing — so a plain `or ""` leaves
    a truthy "nan" that no comparison here would match."""
    if v is None:
        return ""
    if isinstance(v, float) and pd.isna(v):
        return ""
    s = str(v).strip()
    return "" if s.lower() == "nan" else s.lower()


def is_submitted(row: Any) -> bool:
    """True when anything on the row records that the proposal reached the donor."""
    if _txt(row.get("progress_status")) == "completed":
        return True
    if _txt(row.get("donor_decision")) not in _UNSUBMITTED_DONOR_DECISIONS:
        return True
    return bool(_txt(row.get("date_completed")))


def deadline_passed(d: Any, *, on: date | None = None) -> bool:
    """True only when a deadline EXISTS and is in the past. A missing or unparseable
    deadline returns False: we do not know that it passed, and dropping the row would
    hide a live call because one cell is blank."""
    if d is None or (isinstance(d, float) and pd.isna(d)):
        return False
    try:
        dt = pd.to_datetime(d, errors="coerce")
    except Exception:
        return False
    if pd.isna(dt):
        return False
    return dt.date() < (on or date.today())


def is_active_proceed(row: Any, *, on: date | None = None) -> bool:
    """True when `row` is an opportunity the team can still act on — see the block
    comment above. Takes anything with `.get()`: a Supabase dict or a DataFrame row."""
    if not _txt(row.get("decision")).startswith("proceed"):
        return False
    # bool() rather than a truth test: a pandas NaN in this column is truthy and would
    # read a canonical row as a duplicate.
    dup = row.get("is_duplicate")
    if dup is True or (isinstance(dup, str) and dup.strip().lower() == "true"):
        return False
    if _txt(row.get("progress_status")) in _CLOSED_PROGRESS:
        return False
    if is_submitted(row):
        return False
    return not deadline_passed(row.get("call_submission_deadline"), on=on)


def usd_value(estimated: Any, currency: str | None) -> float:
    if estimated is None or (isinstance(estimated, float) and pd.isna(estimated)):
        return 0.0
    try:
        return float(estimated) * dropdowns.usd_rate(currency)
    except (TypeError, ValueError):
        return 0.0
