"""A row is made complete when it is written, not repaired afterwards.

THE RULE (owner, 2026-11-19)
---------------------------
    "we are forward looking now. only new rfps should be completed following the
     updated crawler and extractor so we don't end up with extracted calls with
     low data."

That makes the ingest path the only path. There is no second pass to catch what
extraction misses, so anything the deterministic extractor can read has to be
read before `build_record` returns — and a row that still lands thin has to say
so at the time, because nobody is going to come back and look.

WHAT WENT WRONG BEFORE
----------------------
`core/field_extract.py` and its backfill were written together, and only the
backfill ever called `derive_fields`. The backfill's docstring said the extractor
"now runs inside extraction, so every NEW row arrives with these fields"; it did
not, and every row scanned between then and 2026-11-19 arrived without any of it.
These tests exist so that cannot be true again without a failure.

Offline: `use_llm=False` throughout, so no model, no network, no database.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import extract  # noqa: E402

CALL_TEXT = (
    "Eligibility: this call is open to NGOs, universities and research institutes "
    "registered in an eligible country. Grants of between USD 50,000 and USD 150,000 "
    "are available per project. Projects may run for up to 24 months. Applicants must "
    "provide a 10% matching contribution. Applications must be submitted through the "
    "online portal. Successful applicants will be notified in September 2027. The following "
    "are not eligible: capital works, individual scholarships and retrospective costs. "
)

CANDIDATE = {
    "opportunity_title": "Call for Proposals: Maternal and Newborn Health Research",
    "opportunity_link": "https://example.org/calls/mnh-2027",
    "funding_agency": "Wellcome",
    "source": "Wellcome",
    "_source_class": "primary",
    "call_submission_deadline": "2027-03-01",
    "_page_text": CALL_TEXT * 2,
}


@pytest.fixture(scope="module")
def policies():
    from core.policies import get_policies
    return get_policies()


@pytest.fixture
def record(policies):
    rec, reason = extract.build_record(dict(CANDIDATE), policies,
                                       scan_year=2026, use_llm=False)
    assert rec is not None, f"the extraction gate rejected the fixture: {reason}"
    return rec


# ---------------------------------------------------------------------------
# the deterministic pass runs on the way in
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("field,expected", [
    ("project_duration", 24),
    ("submission_format", "Online portal"),
    ("expected_award_date", "2027-09-01"),
    ("time_to_award", "about 6 months"),
])
def test_a_field_a_pattern_can_read_is_read_before_the_record_returns(
        record, field, expected):
    assert record[field] == expected


def test_applicant_types_are_read_from_the_eligibility_passage(record):
    assert "NGO / non-profit" in record["eligibility_applicant_types"]
    assert "University / research institute" in record["eligibility_applicant_types"]


def test_the_award_range_is_read_from_the_call(record):
    assert (record["call_award_floor"], record["call_award_ceiling"]) == (50000.0, 150000.0)


def test_the_exclusions_are_read_from_the_call(record):
    assert "capital works" in (record["what_is_not_funded"] or "")


def test_programme_areas_are_classified_on_the_way_in(record):
    assert record["call_domain_areas"]
    assert "Unspecified" not in str(record["call_domain_areas"])


def test_every_derived_value_carries_its_evidence(record):
    """A number a reviewer queries has to be answerable from the row itself."""
    prov = record["field_provenance"]
    assert "24 months" in prov["project_duration"]["evidence"]
    assert prov["project_duration"]["method"] == "regex"


def test_the_deterministic_pass_cannot_regress_a_handler_value(policies):
    """It fills blanks only, so a figure the handler read off the funder's API
    still wins over anything a pattern finds in the prose."""
    rec, _ = extract.build_record(
        dict(CANDIDATE, call_award_ceiling=999_000), policies,
        scan_year=2026, use_llm=False)
    assert rec["call_award_ceiling"] == 999_000.0


def test_a_pattern_failure_never_costs_the_scan_the_row(policies, monkeypatch):
    """Best-effort by construction: the row is worth more than the extra fields."""
    from core import field_extract
    monkeypatch.setattr(field_extract, "derive_fields",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    rec, reason = extract.build_record(dict(CANDIDATE), policies,
                                       scan_year=2026, use_llm=False)
    assert rec is not None and rec["opportunity_name"]


# ---------------------------------------------------------------------------
# a thin row is visible when it lands
# ---------------------------------------------------------------------------
def test_a_thin_row_is_counted_and_a_full_one_is_not(policies):
    extract.reset_thin_rows()
    extract.build_record(dict(CANDIDATE), policies, scan_year=2026, use_llm=False)
    thin_after_good, scored = extract.thin_rows()
    assert scored == 1
    assert thin_after_good == 0

    # The same call with almost nothing to read: a title, a link and a deadline.
    extract.build_record(
        {"opportunity_title": "Request for Proposals: Supply of Laboratory Reagents",
         "opportunity_link": "https://example.org/t/1",
         "funding_agency": "A Funder", "source": "A Funder",
         "_source_class": "primary", "call_submission_deadline": "2027-03-01",
         "_page_text": "Tender notice. See the portal for details."},
        policies, scan_year=2026, use_llm=False)
    thin, scored = extract.thin_rows()
    assert scored == 2
    assert thin == 1, "a row that lands below the floor must be counted"


def test_the_counter_resets_per_scan(policies):
    extract.reset_thin_rows()
    assert extract.thin_rows() == (0, 0)


def test_counting_never_raises_on_an_odd_record():
    """It is a log line; it must not be able to fail an extraction."""
    extract._note_completeness({})
    extract._note_completeness({"raw_text": None, "uid": None})
