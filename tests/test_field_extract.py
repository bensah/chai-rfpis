"""`core.field_extract` — the deterministic half of extraction.

Every case here is phrasing taken from, or modelled closely on, the live
catalogue. The negative cases matter more than the positive ones: each one pins a
FALSE POSITIVE that an earlier, looser version of the pattern actually produced
when it was sampled against the 1687 stored rows on 2026-11-18. A blank is a true
statement about a call; a wrong number is one a reviewer builds a budget on.

UNITTEST, NOT PYTEST, AND THAT IS NOT A STYLE CHOICE
----------------------------------------------------
`scripts/run_tests.py` is this repo's test runner, and it shells out to
`python -m unittest discover` once per module. `pytest` is not in
`requirements.txt`.

So a module written in pytest's idiom does one of two things here, both bad:
it raises `ModuleNotFoundError: No module named 'pytest'` at import, which
`discover` reports as a loader ERROR and which fails the WHOLE suite for
everyone; or, if it merely uses bare `def test_*` functions without importing
pytest, unittest collects nothing from it and reports OK — the tests silently do
not run at all.

This module and seven others were written in pytest's idiom on 2026-11-18/19 and
hit both failure modes: 160-odd tests that passed locally for whoever had pytest
installed and ran NOWHERE under the project's own runner. They are unittest now.
If you add a file here, give it `TestCase` classes; `self.subTest` is what
`@parametrize` was doing.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import field_extract as fe  # noqa: E402


class AwardRangeTests(unittest.TestCase):

    def test_award_bounds_reads_a_published_range(self):
        for text, expected in (
            ("Grants of between US$50,000 and US$150,000 are available.",
             (50000.0, 150000.0)),
            ("We will make awards of £50,000 – £150,000 per project.",
             (50000.0, 150000.0)),
            ("Budgets from €5,000 to €30,000 will be considered.", (5000.0, 30000.0)),
            ("Awards range from $1 million to $5 million.", (1000000.0, 5000000.0)),
            ("Applicants may request up to US$300,000 per award.", (None, 300000.0)),
        ):
            with self.subTest(text=text):
                self.assertEqual(fe.award_bounds(text), expected)

    def test_a_programme_envelope_is_not_an_award_ceiling(self):
        """The SRHR call stored £12,000,000 as its award value. The sentence it
        came from was about the whole programme, and the per-award qualifier is
        what tells the two apart — so this sentence must reach the award fields
        not at all."""
        text = "Up to £12 million is available for the programme."
        self.assertEqual(fe.award_bounds(text), (None, None))
        self.assertEqual(fe.total_program_funding(text), 12_000_000.0)

    def test_a_descending_pair_is_not_a_range(self):
        self.assertEqual(fe.award_bounds("see pages $500 - $100 of the annex"),
                         (None, None))


class TotalProgrammeFundingTests(unittest.TestCase):

    def test_total_program_funding(self):
        for text, expected in (
            ("A total of EUR 3,000,000 is available.", 3_000_000.0),
            ("The programme has an indicative budget of EUR 20 million.", 20_000_000.0),
            ("Total value (estimated) £1,100,000", 1_100_000.0),
            ("Overall budget: CAD $50,000,000", 50_000_000.0),
        ):
            with self.subTest(text=text):
                self.assertEqual(fe.total_program_funding(text), expected)


class ExpectedAwardsTests(unittest.TestCase):

    def test_expected_awards(self):
        for text, expected in (
            ("We expect to fund up to 8 projects.", "8"),
            ("The Fund anticipates making approximately 3-5 awards.", "3-5"),
            ("Up to three awards will be made.", "3"),
        ):
            with self.subTest(text=text):
                self.assertEqual(fe.expected_awards(text), expected)


class ExpectedAwardDateTests(unittest.TestCase):

    def test_expected_award_date_reads_a_decision_date(self):
        self.assertEqual(
            fe.expected_award_date("Successful applicants will be notified in "
                                   "March 2027."), "2027-03-01")
        self.assertEqual(
            fe.expected_award_date("Awards will be made no later than "
                                   "September 30, 2027."), "2027-09-30")

    def test_an_expected_outcome_heading_is_not_an_award_date(self):
        """The EU portal's standard heading. Five of six sampled hits were this,
        each paired with whatever date happened to follow — including 2021 dates
        on calls that had not opened yet."""
        text = ("Expected Outcome: Project results are expected to contribute to "
                "all of the following expected outcomes: extended service life by "
                "2021-07-07.")
        self.assertIsNone(fe.expected_award_date(text))

    def test_the_end_of_the_funded_work_is_not_the_award_date(self):
        text = ("The award period of performance is 24 months beginning September "
                "2026 through September 30, 2028.")
        self.assertIsNone(fe.expected_award_date(text))

    def test_an_award_cannot_be_announced_before_applications_close(self):
        text = "Awards will be announced in January 2026."
        self.assertIsNone(fe.expected_award_date(text, deadline="2026-11-30"))
        self.assertEqual(fe.expected_award_date(text, deadline="2025-06-01"),
                         "2026-01-01")

    def test_a_past_ceremony_is_not_a_forthcoming_award(self):
        text = "Awards, to be presented on 2 July 2018 during the annual ceremony."
        self.assertIsNone(fe.expected_award_date(text, not_before="2026-01-01"))

    def test_time_to_award_spans_closing_to_announcement(self):
        self.assertEqual(fe.time_to_award("2026-11-30", "2027-03-01"),
                         "about 3 months")
        self.assertIsNone(fe.time_to_award("2026-11-30", "2026-10-01"))  # before close
        self.assertIsNone(fe.time_to_award(None, "2027-03-01"))


class ProjectDurationTests(unittest.TestCase):

    def test_project_duration(self):
        for text, expected in (
            ("Projects may run for up to 24 months.", 24),
            ("The grant period is 12 months.", 12),
            ("Duration of 2 years.", 24),
            ("Awards are made for a maximum period of 24-36 months.", 36),
            ("This is a 5-year award.", 60),
        ):
            with self.subTest(text=text):
                self.assertEqual(fe.project_duration(text), expected)

    def test_a_duration_about_something_else_is_not_the_project_duration(self):
        """All three produced a stored duration under the first version of the
        pattern, which keyed on 'for'/'over'/'period' plus a number."""
        for text in (
            "People who have been homeless for over two years are the focus.",
            "The service must remain viable for at least one year after the "
            "project period.",
            "Applicants should have experience gained within the last 5 years.",
        ):
            with self.subTest(text=text):
                self.assertIsNone(fe.project_duration(text))


class CoFinancingTests(unittest.TestCase):
    """The call half of MUST-5."""

    def test_a_call_that_requires_co_financing_says_so(self):
        for text in (
            "Co-financing of at least 20% is required.",
            "Applicants must provide a 10% matching contribution.",
            "A counterpart contribution is mandatory for all applicants.",
            "Minimum co-financing of 25%.",
        ):
            with self.subTest(text=text):
                self.assertIs(fe.cost_share_required(text), True)

    def test_a_call_that_rules_co_financing_out_says_so(self):
        for text in ("No co-financing is required for this call.",
                     "Cost-sharing is not required."):
            with self.subTest(text=text):
                self.assertIs(fe.cost_share_required(text), False)

    def test_a_silent_call_is_not_a_no(self):
        """None and False are different answers and `_merge_rfp_compliance` treats
        them differently: a missing key leaves the donor record standing, while
        False CLEARS a donor record claiming the requirement applies."""
        self.assertIsNone(
            fe.cost_share_required("This call funds implementation research."))
        self.assertEqual(
            fe.call_compliance_flags("This call funds implementation research."), {})

    def test_call_compliance_flags_use_the_bare_key_vocabulary(self):
        """`criteria_derive._eff_column` prefixes a bare key with `donor_`, so the
        key emitted here has to be the bare one the criteria already read."""
        from core.criteria_derive import _eff_column
        flags = fe.call_compliance_flags("Co-financing of at least 20% is required.")
        self.assertEqual(flags, {"cofinancing_required": True})
        self.assertEqual(_eff_column("cofinancing_required"),
                         "donor_cofinancing_required")


# `funding_opportunity_number` was blank on 100% of the live Find a Tender, UNGM
# and Contracts Finder rows — 638 of them — while 183 Find a Tender notices carry
# "Notice identifier: 2026/S 000-074968" in their own text.
FTS = ("Act 2023 - view information about notice types Notice identifier: "
       "2026/S 000-074968 Procurement identifier (OCID): ocds-h6vhtk-06de5e")


class OpportunityNumberTests(unittest.TestCase):
    """The funder's own reference."""

    def test_a_labelled_reference_is_read_off_the_notice(self):
        self.assertEqual(
            fe.opportunity_number(FTS, not_equal_to="ocds-h6vhtk-06de5e"),
            "2026/S 000-074968")

    def test_the_value_may_carry_one_internal_space(self):
        """Find a Tender writes its reference as two tokens, and the pattern must
        stop at the second rather than eating the next heading."""
        got = fe.opportunity_number(FTS, not_equal_to="ocds-h6vhtk-06de5e")
        self.assertNotIn("Procurement", got)

    def test_a_sentence_about_references_is_not_a_reference(self):
        """UNGM talks ABOUT references far more often than it states one. A pattern
        trusting the label alone read "Number. 10" out of the first of these and
        stored it on 51 live rows."""
        for text in (
            "please contact UNGM Support, referencing the exact FAO Tender "
            "Reference Number. 10 working days before the deadline.",
            "Quote the reference number in all correspondence.",
            "A call for proposals on maternal health with no reference at all.",
        ):
            with self.subTest(text=text):
                self.assertIsNone(fe.opportunity_number(text))

    def test_a_reference_matching_the_header_id_is_not_a_second_one(self):
        """The schema and the page treat this as the SECOND reference; storing the
        same value twice prints the header id again under its own heading."""
        self.assertIsNone(
            fe.opportunity_number("Notice identifier: 2026/S 000-074968",
                                  not_equal_to="2026/S 000-074968"))

    def test_the_same_reference_spelled_differently_still_counts_as_the_same(self):
        """UNGM stores `19-2026` while its notice says "Tender 19/2026"; a literal
        comparison called those different and duplicated the id onto the page."""
        text = ("Renovation Works ITB Reference No.: Tender 19/2026 "
                "UNRWA Field Office: GFO")
        for stored_id in ("19-2026", "ITB Reference No: 19/2026"):
            with self.subTest(stored_id=stored_id):
                self.assertIsNone(fe.opportunity_number(text, not_equal_to=stored_id))

    def test_a_genuinely_different_reference_is_kept(self):
        text = ("Renovation Works ITB Reference No.: Tender 19/2026 "
                "UNRWA Field Office: GFO")
        self.assertEqual(fe.opportunity_number(text, not_equal_to="ocds-abc-123"),
                         "Tender 19/2026")

    def test_a_reference_must_contain_a_digit(self):
        self.assertIsNone(fe.opportunity_number("Solicitation Number: PENDING"))


class EligibilityTests(unittest.TestCase):

    def test_applicant_types_come_from_an_eligibility_passage(self):
        text = ("Eligibility: this call is open to NGOs, universities and research "
                "institutes registered in an eligible country.")
        got = fe.eligibility_applicant_types(text)
        self.assertIn("NGO / non-profit", got)
        self.assertIn("University / research institute", got)

    def test_a_mention_outside_an_eligibility_passage_does_not_count(self):
        """A call that thanks its university partners is not a call open to
        universities."""
        text = "We are grateful to the universities and NGOs that supported this work."
        self.assertEqual(fe.eligibility_applicant_types(text), [])


class DocumentTests(unittest.TestCase):

    def test_documents_split_files_from_other_links(self):
        text = ("Download the guidance at https://x.org/docs/guidelines.pdf and read "
                "more at https://x.org/about. Follow us on https://twitter.com/x")
        att, res = fe.documents(text, call_url="https://x.org/call")
        self.assertEqual([a["url"] for a in att],
                         ["https://x.org/docs/guidelines.pdf"])
        self.assertEqual(att[0]["doc_type"], "Guidelines")
        self.assertEqual([r["url"] for r in res], ["https://x.org/about"])  # social out

    def test_the_calls_own_url_is_not_one_of_its_resources(self):
        text = "See https://x.org/call for details."
        _att, res = fe.documents(text, call_url="https://x.org/call")
        self.assertEqual(res, [])


class DeriveFieldsContractTests(unittest.TestCase):
    """The orchestrator's contract."""

    def test_derive_fields_never_overwrites_a_value_already_on_the_row(self):
        row = {"raw_text": "Projects may run for up to 24 months.",
               "project_duration": 12}
        self.assertNotIn("project_duration", fe.derive_fields(row))

    def test_derive_fields_quotes_its_evidence(self):
        row = {"raw_text": "Projects may run for up to 24 months.",
               "opportunity_name": "A call"}
        got = fe.derive_fields(row)
        self.assertEqual(got["project_duration"], 24)
        self.assertIn("24 months",
                      got["field_provenance"]["project_duration"]["evidence"])

    def test_derive_fields_merges_into_existing_provenance(self):
        """`core/extract.py` writes the deadline's and the amount's method into the
        same column; this pass must add to it, not replace it."""
        row = {"raw_text": "Projects may run for up to 24 months.",
               "field_provenance": {"deadline": {"method": "handler"}}}
        prov = fe.derive_fields(row)["field_provenance"]
        self.assertEqual(prov["deadline"], {"method": "handler"})
        self.assertEqual(prov["project_duration"]["method"], "regex")

    def test_an_unclassifiable_call_stores_no_programme_area(self):
        """"Unspecified Program Area" reads as POPULATED to every blank test in the
        codebase, so storing it would raise the coverage number while telling a
        reviewer nothing."""
        row = {"raw_text": "Tender for the restoration of farm hunts on Moss Side.",
               "opportunity_name": "Moss Side Farm Hunts Restoration"}
        got = fe.derive_fields(row)
        self.assertNotIn("Unspecified Program Area",
                         str(got.get("call_domain_areas") or ""))

    def test_a_row_with_no_text_derives_nothing(self):
        self.assertEqual(fe.derive_fields({"raw_text": "", "opportunity_name": "x"}),
                         {})

    def test_fact_is_published_separates_our_gap_from_an_absent_fact(self):
        """The evidence behind a removal proposal: a cue that fires on a blank field
        is our gap; a cue that never fires is a fact the funder did not publish."""
        self.assertIs(fe.fact_is_published("project_duration",
                                           "The project period is 24 months."), True)
        self.assertIs(fe.fact_is_published("agency_code", "A call for proposals."),
                      False)
        self.assertIsNone(fe.fact_is_published("not_a_field", "anything"))


if __name__ == "__main__":
    unittest.main()
