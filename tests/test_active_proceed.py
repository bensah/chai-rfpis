"""`is_active_proceed` — the set the Meetings note-taker offers and the Tracking
page lists.

Regression guard for the note-taker dropdown that filtered on decision +
is_duplicate alone. Against the live database on 2026-11-02 that offered 36
options of which 1 was live, oldest first, defaulting to a proposal submitted in
November 2025 and already Approved.

The rows below are shaped on real ones from that measurement.
"""
import unittest
from datetime import date

from core.pipeline import deadline_passed, is_active_proceed, is_submitted

TODAY = date(2026, 11, 2)


def row(**kw) -> dict:
    """A live, actionable Proceed row — the one the dropdown should offer. Shaped on
    SH-260504-0525 (The Pandemic Fund), the single active row on 2026-11-02."""
    base = {
        "uid": "SH-260504-0525",
        "decision": "Proceed",
        "is_duplicate": False,
        "call_submission_deadline": "2027-05-31",
        "progress_status": "Not Started",
        "donor_decision": "Not submitted",
        "date_completed": None,
    }
    base.update(kw)
    return base


class TestActiveProceed(unittest.TestCase):
    def test_the_live_row_qualifies(self):
        self.assertTrue(is_active_proceed(row(), on=TODAY))

    # ---- decision ---------------------------------------------------------
    def test_not_proceed_is_excluded(self):
        for dec in ("Park", "Decline", None, "", "nan"):
            with self.subTest(dec=dec):
                self.assertFalse(is_active_proceed(row(decision=dec), on=TODAY))

    def test_any_proceed_variant_qualifies(self):
        # The old query named two variants explicitly; the rest of the app matches on
        # the prefix, so a third one added to the dropdown must not silently vanish.
        for dec in ("Proceed", "Proceed as sub", "proceed", "Proceed as lead"):
            with self.subTest(dec=dec):
                self.assertTrue(is_active_proceed(row(decision=dec), on=TODAY))

    def test_duplicate_row_is_excluded(self):
        self.assertFalse(is_active_proceed(row(is_duplicate=True), on=TODAY))

    # ---- deadline ---------------------------------------------------------
    def test_passed_deadline_is_excluded(self):
        # MI-260421-0020 — what the broken dropdown selected by default.
        self.assertFalse(
            is_active_proceed(row(call_submission_deadline="2025-11-11"), on=TODAY))

    def test_deadline_today_still_qualifies(self):
        # The deadline has not passed until the day is over; a note taken on the
        # morning of the deadline is exactly the note worth taking.
        self.assertTrue(
            is_active_proceed(row(call_submission_deadline="2026-11-02"), on=TODAY))

    def test_missing_deadline_is_not_a_passed_deadline(self):
        for dl in (None, "", "nan", "not a date"):
            with self.subTest(dl=dl):
                self.assertFalse(deadline_passed(dl, on=TODAY))
                self.assertTrue(
                    is_active_proceed(row(call_submission_deadline=dl), on=TODAY))

    # ---- submitted --------------------------------------------------------
    def test_completed_progress_is_submitted(self):
        self.assertTrue(is_submitted(row(progress_status="Completed")))
        self.assertFalse(is_active_proceed(row(progress_status="Completed"), on=TODAY))

    def test_discontinued_is_excluded(self):
        # Not submitted — dropped on purpose. Either way it is not actionable.
        self.assertFalse(is_active_proceed(row(progress_status="Discontinued"), on=TODAY))

    def test_any_donor_decision_means_submitted(self):
        # An allowlist, not an exclusion list: a value nobody has seen yet still means
        # the donor received something to decide on.
        for dd in ("Approved", "Under Review", "Not Approved", "Submitted",
                   "Shortlisted"):
            with self.subTest(dd=dd):
                self.assertTrue(is_submitted(row(donor_decision=dd)))
                self.assertFalse(is_active_proceed(row(donor_decision=dd), on=TODAY))

    def test_blank_donor_decision_is_unsubmitted(self):
        for dd in (None, "", "nan", "Not submitted", "not submitted"):
            with self.subTest(dd=dd):
                self.assertFalse(is_submitted(row(donor_decision=dd)))

    def test_date_completed_means_submitted(self):
        # Backdated Excel intake: progress and donor_decision can both still read as
        # unsubmitted while a submission date sits on the row.
        r = row(date_completed="2026-08-07")
        self.assertTrue(is_submitted(r))
        self.assertFalse(is_active_proceed(r, on=TODAY))

    def test_nan_string_date_completed_is_blank(self):
        # Excel-migrated rows carry the literal "nan" where the cell was empty; a plain
        # truth test reads that as a submission date and hides a live call.
        self.assertFalse(is_submitted(row(date_completed="nan")))
        self.assertTrue(is_active_proceed(row(date_completed="nan"), on=TODAY))

    # ---- the measured case ------------------------------------------------
    def test_the_dropdown_narrows_to_the_live_row(self):
        """36 Proceed rows in, 1 out — the shape of the bug, in miniature."""
        rows = [
            row(),                                                    # live
            row(uid="MI-260421-0020", call_submission_deadline="2025-11-11",
                progress_status="Completed", donor_decision="Approved",
                date_completed="2025-11-14"),                         # submitted, won
            row(uid="AB-260220-1316", call_submission_deadline="2026-04-01",
                progress_status="Discontinued"),                      # dropped
            row(uid="MI-260508-1647", call_submission_deadline="2026-06-24"),  # overdue
            row(uid="DUP-1", is_duplicate=True),                      # duplicate
        ]
        live = [r["uid"] for r in rows if is_active_proceed(r, on=TODAY)]
        self.assertEqual(live, ["SH-260504-0525"])


if __name__ == "__main__":
    unittest.main()
