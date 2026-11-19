"""`scripts/backfill_grants_gov_api._updates_for` — what an API answer may change.

The script's only risky decision is WHEN to overwrite `raw_text`, because that
column is the grounding text every later synthesis reads. Overwrite too eagerly
and a rich deep-read page is replaced by a two-line synopsis; too timidly and the
168 rows holding nothing but page chrome stay useless.

`_updates_for` is pure — an API payload and a stored row in, a dict of columns
out — so every rule below is tested with no network and no database.

The script itself is RETIRED (owner, 2026-11-19: no more repairing stored rows),
but this module is not. `_updates_for` is the tested definition of "what an API
answer should change", and the crawler-side fix in `scraper._scan_grants_gov` is
checked against it.

UNITTEST, NOT PYTEST — see the note in `tests/test_field_extract.py`.
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# The script is not a package module; load it by path so the test can reach its
# internals without turning `scripts/` into one.
_spec = importlib.util.spec_from_file_location(
    "backfill_grants_gov_api", ROOT / "scripts" / "backfill_grants_gov_api.py")
bf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bf)

CHROME = ("An official website of the United States government Here's how you know "
          "Menu Search Site Content Help Register Login Unsaved changes will be lost. Ok")

REAL_SYNOPSIS = ("The Emerging Mathematics in Biology programme seeks innovative "
                 "mathematical theories and approaches to investigate questions of "
                 "interest to biologists and public health policy makers. ") * 6


def payload(**syn):
    return {"data": {"opportunityNumber": syn.pop("_number", ""), "synopsis": syn}}


class RawTextIsTheOneOverwriteTests(unittest.TestCase):

    def test_chrome_is_replaced_by_the_synopsis(self):
        got = bf._updates_for({"raw_text": CHROME}, payload(synopsisDesc=REAL_SYNOPSIS))
        self.assertTrue(got["raw_text"].startswith("The Emerging Mathematics"))

    def test_a_richer_stored_read_is_not_replaced_by_a_shorter_synopsis(self):
        """A deep-read page can legitimately be fuller than the API synopsis.
        Shrinking it would lose the better text to no purpose."""
        got = bf._updates_for({"raw_text": "A" * 5000},
                              payload(synopsisDesc=REAL_SYNOPSIS))
        self.assertNotIn("raw_text", got)

    def test_a_materially_longer_synopsis_does_replace_a_short_stored_read(self):
        got = bf._updates_for({"raw_text": "A" * 100},
                              payload(synopsisDesc=REAL_SYNOPSIS))
        self.assertTrue(got["raw_text"].startswith("The Emerging Mathematics"))

    def test_a_marginally_longer_synopsis_does_not_churn_the_row(self):
        got = bf._updates_for({"raw_text": "A" * 800}, payload(synopsisDesc="B" * 900))
        self.assertNotIn("raw_text", got)

    def test_an_empty_synopsis_never_clears_stored_text(self):
        got = bf._updates_for({"raw_text": CHROME}, payload(synopsisDesc=""))
        self.assertNotIn("raw_text", got)


class EverythingElseFillsABlankTests(unittest.TestCase):

    def test_structured_money_and_counts_fill_blanks(self):
        got = bf._updates_for(
            {}, payload(estimatedFunding="6000000", awardFloor="1500000",
                        awardCeiling="6000000", numberOfAwards="15"))
        self.assertEqual(got["total_program_funding"], 6_000_000.0)
        self.assertEqual(got["call_award_floor"], 1_500_000.0)
        self.assertEqual(got["call_award_ceiling"], 6_000_000.0)
        self.assertEqual(got["expected_awards"], "15")

    def test_a_value_already_on_the_row_is_left_alone(self):
        row = {"total_program_funding": 123, "expected_awards": "2-3"}
        got = bf._updates_for(row, payload(estimatedFunding="6000000",
                                           numberOfAwards="15"))
        self.assertNotIn("total_program_funding", got)
        self.assertNotIn("expected_awards", got)

    def test_the_apis_own_nulls_are_not_values(self):
        """grants.gov returns the literal string "none" for an unset money field."""
        got = bf._updates_for({}, payload(estimatedFunding="none", awardCeiling="",
                                          numberOfAwards="0"))
        self.assertEqual(got, {})

    def test_a_placeholder_eligibility_is_refused(self):
        """Seen live: `applicantEligibilityDesc` of exactly "N/A". Storing it would
        put a value that says nothing into a schema column."""
        self.assertNotIn("eligibility_other",
                         bf._updates_for({}, payload(applicantEligibilityDesc="N/A")))
        self.assertNotIn("eligibility_other",
                         bf._updates_for({}, payload(applicantEligibilityDesc="  none ")))

    def test_real_eligibility_wording_is_kept(self):
        wording = ("Proposals may only be submitted by institutions of higher "
                   "education accredited in and having a campus in the United States.")
        got = bf._updates_for({}, payload(applicantEligibilityDesc=wording))
        self.assertEqual(got["eligibility_other"], wording)

    def test_html_is_stripped_from_the_apis_prose(self):
        got = bf._updates_for(
            {"raw_text": CHROME},
            payload(synopsisDesc="<p>Funding for <b>health</b> research.</p>"
                                 + REAL_SYNOPSIS))
        self.assertNotIn("<", got["raw_text"])


class DateTests(unittest.TestCase):

    def test_mmddyyyy_dates_are_normalised(self):
        got = bf._updates_for({}, payload(postingDate="09302026",
                                          responseDate="11302026"))
        self.assertEqual(got["date_posted"], "2026-09-30")
        self.assertEqual(got["deadline"], "2026-11-30")

    def test_iso_dates_pass_through(self):
        got = bf._updates_for({}, payload(postingDate="2026-09-30T00:00:00Z"))
        self.assertEqual(got["date_posted"], "2026-09-30")


class UrlToIdTests(unittest.TestCase):

    def test_the_numeric_id_comes_off_the_detail_url(self):
        self.assertEqual(
            bf._numeric_id({"opportunity_url":
                            "https://www.grants.gov/search-results-detail/363624"}),
            "363624")

    def test_a_non_detail_url_yields_no_id(self):
        self.assertIsNone(bf._numeric_id(
            {"opportunity_url": "https://www.grants.gov/search"}))
        self.assertIsNone(bf._numeric_id({}))


if __name__ == "__main__":
    unittest.main()
