"""The scoring analysis for ONE opportunity, whichever store it came from.

The opportunity page has to answer a decision question — "should this go into our pipeline
or not?" — for calls that have NEVER been screened for this tenant (the shared catalogue
that the Featured card ranks). So the same nine criteria have to be computable from a raw
extraction, not only from an already-screened row.

Everything authoritative is reused, never re-implemented:
  * `criteria_derive.derive_criteria` / `factor_breakdown` / `fatal_decline` — the criteria
  * `matching.composite_match`                                              — Bid Strength
  * `criteria_review.criterion_label` / `count_text`                        — the wording
  * `data_quality`                                                         — confidence
so this page and the Review screen cannot disagree about the same opportunity.

Bid Strength here is COMPUTED LIVE, not read from `alignment_score`. A stored score is a
snapshot from whenever the row was last scanned, and after any scoring fix it drifts from
what Review shows for the same row — which is the class of bug the criteria rework existed
to kill.
"""
from __future__ import annotations

from typing import Any

from core import applicant_graph as _ag
from core import criteria_derive as _cd
from core import criteria_review as _crev
from core import data_quality as _dq
from core import matching as _matching
from core.scorer import CRITERIA, criterion_score

# Per-criterion weight of Bid Strength: MUST .65 + PREFER .35 = 1.0. Mirrors the Review
# screen's breakdown so the two show the same contribution for the same criterion.
WEIGHTS = {"qualification": .15, "strategic_fit": .15, "capacity": .15,
           "geographic_fit": .10, "cofinancing": .10, "funding_quality": .08,
           "funder_relationship": .08, "competitiveness": .10, "bid_effort": .09}

LABELS = {
    "qualification": "MUST 1 · Legal status & qualification",
    "strategic_fit": "MUST 2 · Strategic fit",
    "capacity": "MUST 3 · Implementation capacity",
    "geographic_fit": "MUST 4 · Geographic fit",
    # The criterion spans co-financing AND the compliance gates, but "Compliance requirements"
    # is the phrase the calls themselves use and the one a reviewer recognises; co-financing is
    # one requirement among them rather than a separate heading.
    "cofinancing": "MUST 5 · Compliance requirements",
    "funding_quality": "PREFER 6 · Funding quality",
    "funder_relationship": "PREFER 7 · Donor relationship",
    "competitiveness": "PREFER 8 · Competitiveness",
    "bid_effort": "PREFER 9 · Bid effort",
}


#: The fit bands, as the owner stated them on 2026-11-18: "81+ strong · 51-80 fair ·
#: 50 or less weak". Two changes from what preceded them, and both matter.
#:
#: THE BOUNDARY MOVED from 80 to 81. A composite of exactly 80 used to read "Strong fit";
#: it is Fair now. 80 was the only value the old wording could not express — "80+ strong,
#: 51-79 moderate" left 80 named by the first band and unnamed by the second, which is the
#: ambiguity that prompted the question in the first place. The bands are now contiguous
#: and exhaustive over the integers: 0-50, 51-80, 81-100.
#:
#: THE WORDS CHANGED. "Moderate" also names the midpoint of two CRITERION vocabularies
#: (funding_quality and competitiveness), so the same word meant a whole-opportunity band
#: in one place and a single criterion's answer in another. "Fair" is unused elsewhere.
#: "Low" became "Weak" to match: low/high reads as a measurement, strong/weak as a verdict,
#: and this is a verdict.
#:
#: These are NOT the suggestion bands. `decide` (and auto_scorer.recommend_from_composite)
#: band the recommendation at 90 and 70, which is why a call can read "Strong fit" and
#: still be suggested as Park. Both scales are printed under the tiles for that reason.
FIT_STRONG_AT = 81
FIT_FAIR_AT = 51


def fit_label(composite: float) -> str:
    """Overall match strength only — it does NOT set the decision."""
    return ("Strong fit" if composite >= FIT_STRONG_AT
            else "Fair fit" if composite >= FIT_FAIR_AT else "Weak fit")


def decide(composite: float, *, fatal: bool = False,
           below_award_floor: bool = False) -> str:
    """Mirror auto_scorer.recommend_from_composite: a fatal gate → Decline; else >=90
    Proceed · 70-89 Park · <70 Decline, with a below-floor award capping Proceed at Park."""
    if fatal:
        return "Decline"
    rec = "Proceed" if composite >= 90 else "Park" if composite >= 70 else "Decline"
    return "Park" if (rec == "Proceed" and below_award_floor) else rec


def failing_components(criterion: dict) -> list[str]:
    """The names of the ACTIVE components a criterion did not meet.

    "What's against it: Compliance requirements, Donor relationship" named the criteria but not
    the reason, so a reviewer had to open each one to learn what actually failed. The component
    names are the actionable part — "Authorized signatory (this donor)" tells you what to go and
    get; the criterion title does not.
    """
    out: list[str] = []
    for f in (criterion or {}).get("components") or []:
        if not f.get("active"):
            continue
        sc, met = f.get("score"), f.get("met")
        failed = (sc is not None and float(sc) <= 0.0) or (sc is None and met is False)
        name = str(f.get("name") or f.get("key") or "").strip()
        if failed and name and name not in out:
            out.append(name)
    return out


def analyse(rfp: dict, org: dict | None, donor: dict | None,
            org_settings: dict | None = None, *,
            rfp_compliance: dict | None = None,
            overrides: dict | None = None) -> dict:
    """The full scoring analysis for one opportunity-shaped dict.

    `rfp` may be a screened `rfp_submissions` row OR a candidate built from a raw
    extraction (see opportunity_detail.to_candidate) — the derivation reads the same
    `call_*` fields either way, so an unscreened catalogue call gets a real analysis rather
    than a blank.

    Returns a dict the page renders directly; every number in it is computed here so the
    page holds no scoring logic of its own.
    """
    org = org or {}
    donor_eff = _cd._merge_rfp_compliance(donor, rfp_compliance)
    # Applicant graph (Sub/parent/consortium proxy). Fail-closed to self-only.
    try:
        graph = _ag.resolve(rfp, org)
    except Exception:
        graph = None
    derived = _cd.derive_criteria(rfp, org, donor_eff, org_settings, graph=graph)
    bd = _cd.factor_breakdown(rfp, org, donor_eff, org_settings,
                              overrides=overrides or {}, graph=graph)
    try:
        fatal, trigger = _cd.fatal_decline(org, rfp, donor_eff, org_settings)
    except Exception:
        fatal, trigger = False, None

    criteria: list[dict] = []
    labels: dict[str, Any] = {}
    for key in CRITERIA:
        facts = bd.get(key) or []
        label = _crev.criterion_label(key, facts, derived.get(key))
        labels[key] = label
        unsure = criterion_score(label) is None
        num, total, pct = _crev.criterion_count(key, facts, label)
        sc = criterion_score(label)
        # ONE ANSWER TO "IS THIS CRITERION SCORED", not three (owner, 2026-11-18: 'it
        # shows "Not sure" + not scored, but we note a bar read, and 7.5 / 15. This is
        # contradictory ... if there is a score, then a component is active.').
        #
        # The row used to carry three independent notions of scored-ness and print all
        # of them side by side:
        #
        #   band      criterion_score(label) — None when the label is "Not sure"
        #   scored    bool(total) — whether any COMPONENT was counted, which is a
        #             different question entirely and can be False while an answer exists
        #   points    weight × 0.5 × 100 for an undetermined criterion, so MUST 1 was
        #             awarded half of fifteen for being unreadable
        #
        # Now `scored` IS `band is not None` — we have an answer or we do not — and an
        # unanswered criterion scores nothing and is not counted. `count_text` still
        # reports the COMPONENT tally, which is its own fact and labelled as such.
        scored = sc is not None
        criteria.append({
            "key": key,
            "title": LABELS[key],
            "label": label,
            "band": sc,                                  # 2 / 1 / 0 / None
            "count_text": _crev.count_text(key, facts, label, unsure),
            "scored": scored,
            # In the denominator or not. Equal to `scored` today; named separately
            # because it is what the renormalisation below reads, and the page prints
            # "not counted" off it rather than inferring it from a zero.
            "counted": scored,
            "pct": pct,
            "weight": WEIGHTS[key],
            "points": (WEIGHTS[key] * (sc / 2.0) * 100.0) if scored else 0.0,
            "note": _crev.label_source_note(key, facts, label),
            "components": facts,
            "is_must": key in CRITERIA[:5],
        })

    # How much of the model got to speak. `composite` is renormalised over the counted
    # criteria, so 100 off two criteria and 100 off nine are the same number and not the
    # same claim; the page prints this beside the gauge so a reader can tell them apart.
    _counted_w = sum(c["weight"] for c in criteria if c["counted"])
    _n_counted = sum(1 for c in criteria if c["counted"])

    try:
        match = _matching.composite_match({**rfp, **labels}, org, donor_eff, org_settings)
        composite = round(match["composite"], 1)
    except Exception:
        # RENORMALISED, like `scorer.alignment_score` itself. Summing the points was
        # right while every criterion carried its weight; now that an undetermined one
        # carries none, a bare sum reports a call scored on half the model as if it had
        # failed the other half.
        composite = round(
            (sum(c["points"] for c in criteria) / _counted_w) if _counted_w else 0.0, 1)
    try:
        below_floor = _cd.below_award_floor(rfp, org)
    except Exception:
        below_floor = False

    # SAME-ENGINE screening reason (owner 2026-08-31): run the pipeline's own eligibility gate
    # so the catalogue / sidebar view can EXPLAIN why a call is (or would be) kept out of the
    # pipeline, not merely score it. This is the exact `is_eligible` the scan uses. Cheap
    # (regex/text, no LLM); fail-OPEN so a policy/gate hiccup never blanks the page.
    _screened_out, _screen_reason = False, ""
    try:
        from core.auto_scorer import is_eligible
        from core.policies import get_policies
        _ok, _reason = is_eligible(rfp, get_policies(), geo_org_gates=True, theme_gate=True)
        _screened_out, _screen_reason = (not _ok), (_reason or "")
    except Exception:
        pass

    system = decide(composite, fatal=fatal, below_award_floor=below_floor)
    dpct = _dq.donor_completeness(donor)[0]
    cpct = _dq.call_completeness(rfp)[0]
    band, bpct = _dq.confidence_band(dpct, cpct)
    adjusted, conf_note = _dq.confidence_adjusted(system, band)

    # THE GUARD THAT MAKES RENORMALISATION HONEST. Dropping an undetermined criterion
    # from the denominator is the right rule, and on its own it would let two criteria
    # both scoring full marks read as 100 and suggest Proceed. The score is now "of what
    # could be assessed, this is the fit", and a fit measured on a quarter of the model
    # is not a basis for committing a bid team.
    #
    # Same shape as `_dq.confidence_adjusted` directly above, which parks a Proceed on
    # thin SOURCE data: this parks one on a thin ASSESSMENT. Both only ever downgrade,
    # neither invents a new word for the decision, and `system_decision` keeps the
    # unguarded answer for the audit trail.
    #
    # The floor is 5 of 9 criteria including 3 of the 5 MUSTs — a bid whose eligibility,
    # strategy and capacity are all unreadable has not been assessed, whatever the
    # arithmetic over what is left says.
    _n_must_counted = sum(1 for c in criteria if c["counted"] and c["is_must"])
    if (_n_counted < 5 or _n_must_counted < 3) and str(adjusted).lower() == "proceed":
        adjusted = "Park"
        conf_note = (f"assessed on only {_n_counted} of {len(criteria)} criteria "
                     f"({_n_must_counted} of 5 hard requirements) — read the call "
                     "before Proceeding")

    return {
        "bid_strength": int(composite + 0.5),            # half-up, as the gauge shows it
        "composite": composite,
        "fit": fit_label(composite),
        "system_decision": system,
        "suggested_decision": adjusted,
        "confidence_note": conf_note,
        "fatal": bool(fatal),
        "fatal_trigger": trigger,
        "below_award_floor": below_floor,
        # Would the pipeline's screening gate keep this out, and why (for the catalogue view).
        "screened_out": _screened_out,
        "screen_reason": _screen_reason,
        "confidence": {
            "band": band, "pct": bpct, "call_pct": cpct,
            "donor_pct": dpct, "donor_matched": _dq.donor_matched(donor),
        },
        "criteria": criteria,
        "labels": labels,
        "blockers": [c for c in criteria if c["band"] == 0],
        "unscored": [c for c in criteria if not c["scored"]],
        # What the composite was actually judged on. `weight` is the share of the model
        # that could be compared at all (0.0–1.0); `n` of `of` is the same thing counted
        # in criteria, which is what the page says out loud.
        "scored_on": {
            "weight": round(_counted_w, 4),
            "n": _n_counted,
            "of": len(criteria),
        },
        # The fit bands, so the page's legend states the rule rather than a copy of it.
        # The legend used to carry the numbers as literal text and went stale the moment
        # the owner moved the boundary from 80 to 81.
        "fit_bands": {"strong_at": FIT_STRONG_AT, "fair_at": FIT_FAIR_AT},
    }
