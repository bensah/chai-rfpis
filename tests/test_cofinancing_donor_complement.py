"""Co-financing, end to end: the call, the donor record, and the tenant profile.

THE RULE THIS PINS (the owner's words, 2026-11-18)
--------------------------------------------------
    Extraction complements the call with stored donor data. "Does this donor
    require co-financing?" may not appear on the call page but is in donor
    intelligence. If the donor requires it, check the tenant profile for whether
    they can co-finance; match = 1, no match = 0. If the donor does NOT require
    it, that component drops out of the scoring entirely rather than scoring zero.

Each half of that already existed and the two were not connected on a scanned row:

  * `criteria_derive.compliance_factors` implements the matrix correctly, and has
    since 2026-08-10 — a requirement with no recorded capacity, or a capacity with
    no requirement, leaves the component INACTIVE and out of the denominator.
  * The CALL's own statement reached it only through
    `rfp_submissions.call_compliance_flags`, whose sole writer was the LLM
    synthesis. With no model answering, every scanned row carried NULL there and
    MUST-5 fell back to donor intel alone — on a corpus where 10 of 190 donor
    records answer the co-financing question at all.

`field_extract.call_compliance_flags` is the call half. These tests assert the
whole chain, not the regex: call text (or donor record) in, factor state out.

Nothing here touches the database. `compliance_factors` is a pure function of
(org profile, rfp row, donor record, org settings).
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import criteria_derive as cd  # noqa: E402
from core import field_extract as fe  # noqa: E402

CAN_COFINANCE = {"org_cofinancing_capacity": "strong"}
CANNOT_COFINANCE = {"org_cofinancing_capacity": "none"}
UNRECORDED = {}

DONOR_REQUIRES = {"donor_cofinancing_required": "yes"}
DONOR_DOES_NOT = {"donor_cofinancing_required": "no"}
DONOR_SILENT: dict = {}

SILENT_CALL = {"brief_description": "A call for implementation research proposals."}


def _cofinance_factor(org, rfp, donor, rfp_compliance=None):
    """The 'cofinance' component of MUST-5, as the Review card and the score see it."""
    eff = cd._merge_rfp_compliance(donor, rfp_compliance)
    for f in cd.compliance_factors(org, rfp, eff, {}, None):
        if f["key"] == "cofinance":
            return f
    raise AssertionError("MUST-5 has no co-financing component at all")


# ---------------------------------------------------------------------------
# the donor record supplies what the call does not say
# ---------------------------------------------------------------------------
def test_donor_requires_and_we_can_scores_one():
    f = _cofinance_factor(CAN_COFINANCE, SILENT_CALL, DONOR_REQUIRES)
    assert f["active"] is True
    assert f["score"] == 1.0


def test_donor_requires_and_we_cannot_scores_zero():
    f = _cofinance_factor(CANNOT_COFINANCE, SILENT_CALL, DONOR_REQUIRES)
    assert f["active"] is True
    assert f["score"] == 0.0


def test_donor_does_not_require_so_the_component_drops_out():
    """Not a zero — OUT. A funder that asks for no match cannot fail us on one,
    so the component must leave the denominator rather than score against us."""
    f = _cofinance_factor(CANNOT_COFINANCE, SILENT_CALL, DONOR_DOES_NOT)
    assert f["active"] is False
    assert f["score"] is None


def test_an_unrecorded_capacity_is_not_a_partial():
    """Both sides must be known. Absence of a profile answer is not a measurement
    of a partial ability to co-finance (owner, 2026-08-07)."""
    f = _cofinance_factor(UNRECORDED, SILENT_CALL, DONOR_REQUIRES)
    assert f["active"] is False
    assert f["score"] is None


def test_a_limited_capacity_is_a_half():
    f = _cofinance_factor({"org_cofinancing_capacity": "limited"},
                          SILENT_CALL, DONOR_REQUIRES)
    assert f["active"] is True
    assert f["score"] == 0.5


# ---------------------------------------------------------------------------
# the CALL reaches the same component, with no model and no donor record
# ---------------------------------------------------------------------------
def test_a_call_stating_co_financing_activates_must5_with_no_donor_record():
    """The gap this work closed. Before `field_extract.call_compliance_flags`,
    this call text reached MUST-5 only if a model had read it and written
    `call_compliance_flags`; with the provider out of credit, it reached nothing
    and the component stayed inactive."""
    text = ("Applicants are required to provide co-financing of at least 20% of "
            "the total project cost.")
    flags = fe.call_compliance_flags(text)
    assert flags == {"cofinancing_required": True}

    f = _cofinance_factor(CANNOT_COFINANCE, {"brief_description": text},
                          DONOR_SILENT, rfp_compliance=flags)
    assert f["active"] is True
    assert f["score"] == 0.0


def test_the_call_wins_over_a_donor_record_that_disagrees():
    """`_merge_rfp_compliance`'s stated precedence: the call is the specific,
    current statement for THIS opportunity; donor intel is standing guidance."""
    flags = fe.call_compliance_flags("No co-financing is required for this call.")
    assert flags == {"cofinancing_required": False}

    f = _cofinance_factor(CANNOT_COFINANCE, SILENT_CALL, DONOR_REQUIRES,
                          rfp_compliance=flags)
    assert f["active"] is False, "a call saying 'not required' must clear the donor record"


def test_a_silent_call_leaves_the_donor_record_standing():
    """Silence emits NO KEY, which is why it must not be spelled False: False
    would clear a donor record that correctly says the requirement applies."""
    flags = fe.call_compliance_flags(SILENT_CALL["brief_description"])
    assert flags == {}

    f = _cofinance_factor(CAN_COFINANCE, SILENT_CALL, DONOR_REQUIRES,
                          rfp_compliance=flags)
    assert f["active"] is True
    assert f["score"] == 1.0


# ---------------------------------------------------------------------------
# and the label the row stores
# ---------------------------------------------------------------------------
def test_the_criterion_label_follows_the_component():
    assert cd.derive_cofinancing(CAN_COFINANCE, SILENT_CALL, DONOR_REQUIRES,
                                 org_settings={}) == "Yes, fully met"
    assert cd.derive_cofinancing(CANNOT_COFINANCE, SILENT_CALL, DONOR_REQUIRES,
                                 org_settings={}) == "Not met"


def test_a_donor_that_requires_nothing_does_not_cost_us_the_criterion():
    """The point of "drops out of the scoring entirely rather than scoring zero",
    stated at the level a reviewer reads.

    MUST-5 is a gate over its ACTIVE components. With the donor requiring no
    co-financing and the tenant unable to provide any, the co-financing component
    is inactive and `compliance_all_clear` — `_settle_all_clear`'s stand-in for
    "nothing is imposed here" — is the only thing left active, at 1.0. So the
    criterion reads "Yes, fully met": there is nothing to meet.

    This is the assertion worth having, because the failure mode it rules out is
    the expensive one. A tenant that cannot co-finance would otherwise score 0 on
    every call in the pipeline, including the overwhelming majority whose funders
    never asked for a match, and 10% of the composite would be a standing penalty
    for a requirement nobody made.
    """
    assert cd.derive_cofinancing(CANNOT_COFINANCE, SILENT_CALL, DONOR_DOES_NOT,
                                 org_settings={}) == "Yes, fully met"
    # …and it is a genuine all-clear, not an unmet requirement scored as met.
    f = _cofinance_factor(CANNOT_COFINANCE, SILENT_CALL, DONOR_DOES_NOT)
    assert f["active"] is False and f["score"] is None

    num, den = cd.cofinancing_bid_strength(CANNOT_COFINANCE, SILENT_CALL,
                                           DONOR_DOES_NOT, org_settings={})
    assert (num, den) == (1.0, 1), "the co-financing component must not be in the denominator"
