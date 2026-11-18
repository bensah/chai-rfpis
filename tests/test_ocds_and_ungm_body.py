"""The UK OCDS feeds carry their notice; UNGM stops carrying its boilerplate.

TWO SOURCES, TWO OPPOSITE FAULTS, measured over the live catalogue on 2026-11-19.

OCDS (Find a Tender 356 rows, Contracts Finder 98) — `_scan_ocds` has fetched
`tender.description` since it was written and put it in the candidate's
`brief_description`, which reaches nothing downstream. `extract.build_record`
reads `_page_text` and stores it as `raw_text`; that is what the extractors and
the synthesis work from. So the notice was fetched and discarded, the same trap
the grants.gov and TED handlers were in. The feeds also publish the contract
value, the contract period, how to submit and the documents, none of which were
mapped.

UNGM (184 rows) — the opposite problem: too much text, none of it the call. 99 of
those rows have a `raw_text` that STARTS with an attachment marker and 57 name a
boilerplate document in their first 200 characters, because the document picker
fell back to "whatever PDF is first" when nothing looked like the call, and the
first attachment on a UN notice is the generic pack every notice carries. Worse,
its text was written into `brief_description` — the one column `core/extract.py`
says must NEVER hold raw attachment text.

UNITTEST, NOT PYTEST — see the note in `tests/test_field_extract.py`.

Offline: every payload is the shape the live feeds return. No network.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import scraper  # noqa: E402

DESC = ("Coventry and Warwickshire Pathology Services is seeking a partner to "
        "implement a dedicated Pathology Transport Service.")


class OcdsBodyTests(unittest.TestCase):
    """The notice becomes readable text."""

    def test_the_description_is_the_body(self):
        self.assertIn(DESC, scraper._ocds_body({"description": DESC}))

    def test_how_to_submit_is_labelled_not_concatenated(self):
        """The body is read by a model and by a person; a label is the difference
        between a record and a paste."""
        body = scraper._ocds_body(
            {"description": DESC,
             "submissionMethodDetails": "Register on the Jaggaer portal to access."})
        self.assertIn("How to submit: Register on the Jaggaer portal", body)

    def test_lot_award_criteria_are_pulled_in(self):
        """Find a Tender puts the real substance under the lots; the top-level
        description is often one sentence."""
        body = scraper._ocds_body({
            "description": DESC,
            "lots": [{"awardCriteria": {"criteria": [
                {"name": "Technical and Quality",
                 "description": "Evaluated across two stages against the requirements."}]}}],
        })
        self.assertIn("Award criterion — Technical and Quality", body)
        self.assertIn("Evaluated across two stages", body)

    def test_a_true_suitability_flag_is_stated_and_a_false_one_is_not(self):
        """{"sme": false, "vcse": false} is the DEFAULT on most Contracts Finder
        notices and means "not stated", not "these may not apply"."""
        self.assertIn("small and medium", scraper._ocds_body(
            {"description": DESC, "suitability": {"sme": True, "vcse": False}}))
        self.assertNotIn("Suitable for", scraper._ocds_body(
            {"description": DESC, "suitability": {"sme": False, "vcse": False}}))

    def test_document_links_ride_along_but_an_unpublished_one_does_not(self):
        body = scraper._ocds_body({
            "description": DESC,
            "documents": [
                {"documentType": "conflictOfInterest", "description": "Not published"},
                {"documentType": "tenderNotice", "description": "Tender notice",
                 "url": "https://find-tender.example/notice/1"},
            ],
        })
        self.assertIn("https://find-tender.example/notice/1", body)
        self.assertNotIn("Not published", body)

    def test_a_placeholder_procedure_is_not_stated_as_one(self):
        """Contracts Finder writes "Not specified" into procurementMethodDetails on
        most notices; printing it back is noise dressed as a fact."""
        self.assertNotIn("Procedure", scraper._ocds_body(
            {"description": DESC, "procurementMethodDetails": "Not specified"}))

    def test_an_empty_tender_yields_no_body_rather_than_whitespace(self):
        self.assertEqual(scraper._ocds_body({}), "")


class OcdsStructuredFieldTests(unittest.TestCase):
    """The value and the contract period."""

    def test_the_net_value_is_preferred_over_the_gross(self):
        """`amount` is net and `amountGross` includes VAT; a bidder prices the net."""
        self.assertEqual(
            scraper._ocds_value(
                {"value": {"amountGross": 30000000, "amount": 25000000,
                           "currency": "GBP"}}),
            (25000000.0, "GBP"))

    def test_a_lot_value_is_used_when_the_tender_has_none(self):
        self.assertEqual(
            scraper._ocds_value(
                {"lots": [{"value": {"amount": 25000000, "currency": "GBP"}}]}),
            (25000000.0, "GBP"))

    def test_no_value_anywhere_reports_none(self):
        self.assertEqual(scraper._ocds_value({"value": None, "lots": []}), (None, None))

    def test_the_contract_period_becomes_whole_months(self):
        self.assertEqual(
            scraper._ocds_duration(
                {"contractPeriod": {"startDate": "2026-11-20T00:00:00Z",
                                    "endDate": "2027-07-31T23:59:59+01:00"}}), 8)

    def test_an_unusable_contract_period_yields_no_duration(self):
        for period in (
            {},
            {"startDate": "2026-11-20T00:00:00Z"},
            {"startDate": "2027-07-31T00:00:00Z",
             "endDate": "2026-11-20T00:00:00Z"},                 # backwards
            {"startDate": "2000-01-01T00:00:00Z",
             "endDate": "2030-01-01T00:00:00Z"},                 # 30 years
        ):
            with self.subTest(period=period):
                self.assertIsNone(scraper._ocds_duration({"contractPeriod": period}))


class UngmBoilerplateTests(unittest.TestCase):
    """Boilerplate stops being the call."""

    def test_an_attachment_every_notice_carries_is_recognised_as_boilerplate(self):
        for name in (
            "UNGM_Bidders_Instructions_EN-FR-ES__2026.pdf",
            "Instructions to Bidders.pdf",
            "General Conditions of Contract.pdf",
            "General_Terms_and_Conditions.pdf",
            "Supplier Code of Conduct.pdf",
            "How to register on UNGM.pdf",
            "UN Privacy Notice.pdf",
        ):
            with self.subTest(name=name):
                self.assertTrue(scraper._UNGM_BOILERPLATE.search(name), name)

    def test_a_real_call_document_is_not_blocked(self):
        for name in (
            "RFP_Section_I_Statement of Requirements.pdf",
            "ITB 2026-138154 Forestry Equipment.pdf",
            "Request for Proposal - Health Systems Strengthening.pdf",
            "Tender dossier.pdf",
        ):
            with self.subTest(name=name):
                self.assertFalse(scraper._UNGM_BOILERPLATE.search(name), name)

    def test_the_terms_hint_and_the_blocklist_do_not_contradict_each_other(self):
        """`_UNGM_TERMS_HINT` deliberately selects a general-terms document as the
        SECOND pick. The blocklist removes those from the pool first, so the two
        must not be read as a disagreement: the blocklist wins, and the terms hint
        now only matches a conditions document specific to the notice."""
        generic = "General Conditions of Contract.pdf"
        self.assertTrue(scraper._UNGM_TERMS_HINT.search(generic))
        self.assertTrue(scraper._UNGM_BOILERPLATE.search(generic))


if __name__ == "__main__":
    unittest.main()
