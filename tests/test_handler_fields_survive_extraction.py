"""A figure a source handler read off the funder's own API must reach the record.

WHY THIS EXISTS
---------------
`core/scraper._scan_grants_gov` calls grants.gov `fetchOpportunity` and maps four
structured money/count fields onto the candidate — `awardFloor`, `awardCeiling`,
`estimatedFunding`, `numberOfAwards` — plus `applicantEligibilityDesc`, the
funder's own statement of who may apply.

`core/extract.build_record` then dropped all five. `total_program_funding` and
`expected_awards` appeared nowhere in that file; the two award bounds were built
only from the LLM's `funding_tiers` or a synthesised range; and the eligibility
text went into free-text `notes`, which nothing reads structurally.

Measured 2026-11-19 over the 469 live grants.gov rows, every one of which went
through that handler:

    total_program_funding  0/469
    call_award_floor       1/469
    call_award_ceiling     3/469
    expected_awards        2/469

The data was always there. These tests pin the rule that fixes it — a handler
figure is authoritative, exactly as `build_record` already treats a handler's
`call_award_value` — so the next refactor of that dict cannot quietly undo it.

Offline: `build_record` is called with `use_llm=False`, so nothing here needs a
network, a model or the database.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import extract  # noqa: E402

# Enough of a call to clear the extraction gate: a real title, a primary source,
# a deadline in the future and some body text.
BASE = {
    "opportunity_title": "Emerging Mathematics in Biology (eMB)",
    "opportunity_link": "https://www.grants.gov/search-results-detail/363624",
    "funding_agency": "National Science Foundation",
    "source": "United States Federal Government",
    "_source_class": "primary",
    "call_submission_deadline": "2027-03-01",
    "brief_description": (
        "The Emerging Mathematics in Biology (eMB) program seeks to stimulate the "
        "development of innovative mathematical theories, techniques and approaches "
        "to investigate challenging questions of great interest to biologists and "
        "public health policy makers across low- and middle-income countries."
    ),
}


@pytest.fixture(scope="module")
def policies():
    from core.policies import get_policies
    return get_policies()


def _build(policies, **extra):
    cand = dict(BASE, **extra)
    rec, reason = extract.build_record(cand, policies, scan_year=2026, use_llm=False)
    assert rec is not None, f"the extraction gate rejected the fixture: {reason}"
    return rec


def test_the_gate_accepts_the_fixture(policies):
    """Guards the other tests: if the fixture stops passing the gate they would
    all fail for a reason that has nothing to do with handler fields."""
    assert _build(policies)["opportunity_name"] == BASE["opportunity_title"]


def test_total_program_funding_from_a_handler_reaches_the_record(policies):
    rec = _build(policies, total_program_funding=11_165_000)
    assert rec["total_program_funding"] == 11_165_000.0


def test_expected_awards_from_a_handler_reaches_the_record(policies):
    """grants.gov returns an int; the column is text because a call states a range
    as often as a number."""
    rec = _build(policies, expected_awards=8)
    assert rec["expected_awards"] == "8"


def test_a_published_range_is_kept_as_published(policies):
    rec = _build(policies, expected_awards="3-5")
    assert rec["expected_awards"] == "3-5"


@pytest.mark.parametrize("value", [0, -2, None, ""])
def test_no_award_count_is_not_a_count_of_none(policies, value):
    """0 means the funder did not state a number, not that it will fund nothing."""
    assert _build(policies, expected_awards=value)["expected_awards"] is None


def test_award_bounds_from_a_handler_reach_the_record(policies):
    rec = _build(policies, call_award_floor=50_000, call_award_ceiling=300_000)
    assert (rec["call_award_floor"], rec["call_award_ceiling"]) == (50_000.0, 300_000.0)


def test_a_handler_bound_is_not_subject_to_the_grounding_check(policies):
    """The anti-hallucination check drops an LLM amount that does not appear in the
    source text. A handler figure came from the funder's own JSON, not from the
    page prose, so it must survive even though the text never names it — the text
    in BASE mentions no money at all."""
    rec = _build(policies, call_award_ceiling=300_000)
    assert rec["call_award_ceiling"] == 300_000.0


def test_the_funders_own_eligibility_wording_reaches_the_record(policies):
    wording = ("Eligible applicants are institutions of higher education and "
               "non-profit organisations, including foreign institutions.")
    assert _build(policies, eligibility_other=wording)["eligibility_other"] == wording


def test_a_blank_handler_value_does_not_displace_the_derivation(policies):
    """An absent handler field must leave the normal path alone, not write a blank
    over it. With no handler value and no LLM, these are simply None."""
    rec = _build(policies)
    assert rec["total_program_funding"] is None
    assert rec["expected_awards"] is None
    assert rec["eligibility_other"] is None


def test_every_handler_field_is_a_column_the_store_will_write(policies):
    """A key the store's allow-list does not know is silently dropped on upsert,
    which is how a field reaches a record and still never reaches a row."""
    from core.extracted_store import _COLS
    rec = _build(policies, total_program_funding=1, expected_awards=2,
                 call_award_floor=3, call_award_ceiling=4, eligibility_other="x")
    for field in ("total_program_funding", "expected_awards", "call_award_floor",
                  "call_award_ceiling", "eligibility_other"):
        assert field in _COLS, field
        assert field in rec, field
