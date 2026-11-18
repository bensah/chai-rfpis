"""Eligibility scoring engine.

Mirrors the Excel `Criteria_Reference` sheet. Each of the nine MUST/PREFER
criteria scores as Yes=1.0, Partial=0.5, No=0.0, None=0.0 (unscored).
`alignment_score` = sum(weight_i * value_i) * 100, clamped to [0, 100].
`auto_recommendation` follows the decline-flag override, then thresholds.
"""
from __future__ import annotations

from datetime import date, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

import yaml

CRITERIA = (
    "qualification",
    "strategic_fit",
    "capacity",
    "geographic_fit",
    "cofinancing",
    "funding_quality",
    "funder_relationship",
    "competitiveness",
    "bid_effort",
)

import re

# Canonical normalization for a criterion response → ordinal score 2/1/0 (None
# when unscored / "Not sure"). ONE place, used by the scorer, the decision tree
# (core.auto_scorer) and the model features (core.features) so old stored values
# (True/Partial/False, Yes/No) and the NEW MS-Form rich labels ("Yes, via a
# partner", "Strong - priorities + experience", "High", …) all normalise to the
# same scale (Bernard 2026-06-17: convert Yes=2, Partial=1, No=0).
_SCORE_MAP = {
    # legacy / canonical
    "yes": 2, "y": 2, "true": 2, "1": 2,
    "partial": 1, "p": 1, "partly": 1,
    "no": 0, "n": 0, "false": 0, "0": 0,
    # qualification
    "yes, fully": 2, "mostly, one item unclear": 1, "no, not eligible": 0,
    # strategic_fit — NEW labels (priorities-vs-donor-priorities) + legacy (kept so
    # old stored rows still score and map to the new label by score via match_response)
    "strongly aligns": 2, "limited priority": 1, "off-strategy": 0, "off-theme": 0,
    "strong - priorities + experience": 2, "priority area, limited experience": 1,
    "experienced but off-strategy": 1, "neither": 0,
    # capacity
    "yes, comfortably": 2, "yes, but a stretch": 1, "no, beyond us": 0,
    # geographic_fit
    "yes, our own presence": 2, "yes, via a partner": 1, "no presence there": 0,
    # cofinancing — MUST-5 now spans co-financing AND the funder's compliance gates
    # (SAM/tax-exempt/safeguarding/…), so the labels read Met / Not Met: fully met = 2,
    # partial with effort = 1, not met = 0. OLD labels kept as aliases so existing
    # stored rows still score and remap to the new label by score (match_response).
    "yes, fully met": 2, "partial, with effort": 1, "not met": 0,
    "yes, none required": 2, "no, required": 0, "yes / none required": 2,
    # funding_quality
    "high": 2, "moderate": 1, "low": 0,
    # funder_relationship
    "current/past grantee": 2, "some contact": 1, "none": 0,
    # competitiveness
    "strong (limited field / incumbent / clear edge)": 2, "weak (wide-open)": 0,
    # bid_effort (PREFER 9) — the score is the BANDED AVERAGE of its two components:
    # time-to-deadline (>14d=1 · 7-14d=0.5 · <7d=0) and has-BD-team (1/0). Each label
    # encodes one (time, team) combo; its 2/1/0 here = mean banded > 0.75 → full(2) ·
    # 0.5-0.75 → partial(1) · < 0.5 → none(0). So FULL needs BOTH ample time AND a team;
    # any single strong side is partial. (Owner 2026-07-20: replaced the old
    # time-dominant matrix so a BD team can offset a tight/short deadline.)
    "ample time, sufficient resources": 2,           # time 1  + team 1 -> 1.00
    "ample time, but no dedicated team": 1,          # time 1  + team 0 -> 0.50
    "tight but doable, with a team": 1,              # time .5 + team 1 -> 0.75
    "tight, and no dedicated team": 0,               # time .5 + team 0 -> 0.25
    "tight but doable, insufficient resources": 0,   # legacy 3-point label
    "not enough time, even with a team": 1,          # time 0  + team 1 -> 0.50
    "not enough time, no team": 0,                   # time 0  + team 0 -> 0.00
    "not enough": 0,                                 # legacy 3-point label
}
# Conservative fallback for minor MS-Form wording drift. First match wins; an
# unrecognised response stays None (treated as missing — never a guess).
_FALLBACK = (
    ("strong", 2), ("high", 2), ("ample", 2), ("comfortab", 2),
    ("moderate", 1), ("tight", 1), ("partial", 1), ("stretch", 1),
    ("limited experience", 1), ("via a partner", 1), ("with effort", 1),
    ("priority area", 1),
    ("low", 0), ("weak", 0), ("neither", 0), ("not enough", 0),
    ("no presence", 0), ("beyond", 0), ("not eligible", 0),
)


def criterion_score(value: Any) -> int | None:
    """Normalise any criterion response → 2 / 1 / 0, or None (unscored / Not sure)."""
    if value is None:
        return None
    s = re.sub(r"\s+", " ", str(value).strip().lower()).replace("–", "-").replace("—", "-")
    if not s or "not sure" in s:
        return None
    if s in _SCORE_MAP:
        return _SCORE_MAP[s]
    for kw, sc in _FALLBACK:
        if s.startswith(kw) or kw in s:
            return sc
    return None


_SCORE_TO_FLOAT = {2: 1.0, 1: 0.5, 0: 0.0}


# --- Bid effort (PREFER 9) — objective derivation ----------------------------
# A 5-point ordinal from TIME-to-deadline × RESOURCES (a Business-Development /
# fundraising / resource-mobilization team = "sufficient"). Time-dominant +
# monotone: a <7-day deadline caps the score low whether or not there's a team
# (it stresses the team either way). Tunable thresholds.
BID_EFFORT_AMPLE_DAYS = 14   # > this  -> Ample time
BID_EFFORT_TIGHT_DAYS = 7    # >= this -> Tight but doable; below -> Not enough


def days_until(deadline, *, today: date | None = None) -> int | None:
    """Whole days from today to a deadline (date / datetime / ISO string).
    None if missing or unparseable."""
    if deadline is None:
        return None
    if isinstance(deadline, datetime):
        d = deadline.date()
    elif isinstance(deadline, date):
        d = deadline
    else:
        try:
            d = datetime.strptime(str(deadline)[:10], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            return None
    return (d - (today or date.today())).days


def bid_effort_label(days_to_deadline: int | None, has_bd_team: bool) -> str | None:
    """Map (days-to-deadline, has-BD-team) → one of the 5 canonical bid-effort
    labels (None when the deadline is unknown — can't derive). Scores 4..0:
        4 Ample+team · 3 Ample-no-team · 3 Tight+team ·
        2 Tight-no-team · 1 NotEnough+team · 0 NotEnough-no-team."""
    if days_to_deadline is None:
        return None
    suff = bool(has_bd_team)
    if days_to_deadline > BID_EFFORT_AMPLE_DAYS:
        return ("Ample time, sufficient resources" if suff
                else "Ample time, but no dedicated team")
    if days_to_deadline >= BID_EFFORT_TIGHT_DAYS:
        return ("Tight but doable, with a team" if suff
                else "Tight, and no dedicated team")
    return ("Not enough time, even with a team" if suff
            else "Not enough time, no team")


# Canonical per-criterion response options (best → worst), reused by every form
# (Review, Submit, MS Form). Every label is recognised by criterion_score above.
# "Not sure" → null (missing), and ALL NINE carry it (owner, 2026-11-17).
#
# bid_effort is DERIVED on a time×resources scale and for that reason used to have no
# "Not sure" — the derivation always produces one of the six, so an unknown never arose
# on that path. But the forms ask a human all nine, and `views/submit_form.py::_crit`
# falls back to `opts[0]` when there is no "Not sure" to default to: best → worst, so an
# untouched PREFER-9 asserted "Ample time, sufficient resources" and scored a full 2. A
# submitter who filled in only the four required fields had told the scorer the bid was
# comfortably resourced. Measured before the change: an otherwise-untouched form scored
# 54.5 instead of the 50.0 nine unanswered criteria should give.
#
# Adding the option fixes it with no code change anywhere — `_crit` is
# `opts.index("Not sure") if "Not sure" in opts else 0`, and the React form asks the same
# question — and it moves no stored row: every value in the live table already maps, and
# the derivation never returns "Not sure". Same spirit as f32a52d, which stopped PREFER-9
# asserting a time verdict it never measured.
CRITERION_RESPONSES: dict[str, list[str]] = {
    "qualification": [
        "Yes, fully", "Mostly, one item unclear", "No, not eligible", "Not sure"],
    "strategic_fit": [
        "Strongly aligns", "Limited priority", "Off-strategy", "Not sure"],
    "capacity": [
        "Yes, comfortably", "Yes, but a stretch", "No, beyond us", "Not sure"],
    "geographic_fit": [
        "Yes, our own presence", "Yes, via a partner", "No presence there", "Not sure"],
    "cofinancing": [
        "Yes, fully met", "Partial, with effort", "Not met", "Not sure"],
    "funding_quality": ["High", "Moderate", "Low", "Not sure"],
    "funder_relationship": [
        "Current/past grantee", "Some contact", "None", "Not sure"],
    "competitiveness": [
        "Strong (limited field / incumbent / clear edge)", "Moderate",
        "Weak (wide-open)", "Not sure"],
    "bid_effort": [
        "Ample time, sufficient resources", "Ample time, but no dedicated team",
        "Tight but doable, with a team", "Tight, and no dedicated team",
        "Not enough time, even with a team", "Not enough time, no team", "Not sure"],
}


def default_response(key: str, stored) -> str:
    """Best matching response option for a criterion given a stored value —
    handles legacy True/Partial/False (maps by score) and already-new labels.
    Used to pre-select dropdowns without losing existing data."""
    opts = CRITERION_RESPONSES.get(key) or []
    if not opts:
        return ""
    if stored is not None and str(stored) in opts:
        return str(stored)
    sc = criterion_score(stored)
    if sc is None:
        if "Not sure" in opts:
            return "Not sure"
        # UNREACHABLE SINCE 2026-11-17, when bid_effort gained "Not sure" and all nine
        # criteria came to carry it — but kept, because it is the safe answer for any
        # vocabulary that loses the option again. Do NOT fall back to opts[-1]: the list
        # is ordered best→worst, so that made an UNDETERMINABLE criterion assert the
        # single most damaging verdict and score 0. For bid_effort that turned "we never
        # captured a deadline" into "Not enough time, no team", which then fed the gauge
        # and the auto-decision. Prefer the Park midpoint (score 1); the best option only
        # if the scale has no midpoint.
        mid = [o for o in opts if criterion_score(o) == 1]
        return mid[0] if mid else opts[0]
    for o in opts:
        if criterion_score(o) == sc:
            return o
    return opts[0]


@lru_cache(maxsize=1)
def _load_config() -> dict[str, Any]:
    path = Path(__file__).resolve().parent.parent / "config" / "scoring_weights.yaml"
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def _value(v: Any) -> float:
    return _SCORE_TO_FLOAT.get(criterion_score(v), 0.0)


# AN UNDETERMINED CRITERION LEAVES THE DENOMINATOR (owner, 2026-11-18). It used to be
# rated 0.5 — the Park midpoint — and kept its full weight, a rule set on 2026-06-29 so
# that an unknown criterion routed a bid to manual review instead of failing it. The
# owner has now reversed it twice in writing:
#
#     "if we are unsure we leave it as unsure and don't score it (drops from
#      denominator)" … "if there is a score, then a component is active."
#
# The old rule could not be told apart from a real answer on the page, and that is how it
# surfaced: MUST 1 printed "Not sure", printed "not scored", and printed 7.5 / 15 with a
# half-filled bar, all at once. 0.5 × 0.15 × 100 is exactly 7.5. The number was correct
# arithmetic for a rule nobody could see, sitting beside two statements that denied it.
#
# The rule now is match-to-match: a criterion scores only where the call (or the donor
# record) states the fact AND the tenant has recorded a preference to match it against.
# Where either side is silent the criterion contributes nothing and is not counted, so
# the score is the tenant's fit across what could actually be compared, not a number
# dragged toward 50 by everything we failed to read.
#
# WHAT MOVES. Scores spread away from 50: a thin call that happened to look average now
# reads as whatever its few determinable criteria say, and `scored_weight` (below) says
# how much of the model that was. A genuine detected failure is unaffected — it scores 0,
# stays in the denominator, and still gates through the MUST rule.
_NOT_SURE_FLOAT = 0.5    # retained for callers that still reference it; unused here.


def alignment_score(values: Mapping[str, Any]) -> float:
    """Compute alignment score 0-100 from a mapping keyed by the 9 criteria.

    ONLY DETERMINED CRITERIA COUNT. A response of "Not sure" / unscored
    (criterion_score → None) leaves BOTH the numerator and the denominator, so the score
    is the weighted fit across the criteria that could actually be judged. A clearly
    DETECTED failure scores 0, keeps its weight, and still gates (MUST rule).

    With nothing determinable at all the answer is 0.0 — there is no fit to report, and
    the caller's thresholds route it to Decline exactly as the old 50.0 midpoint did.
    Use `scored_weight` to tell "nothing could be judged" from "judged, and it failed"."""
    cfg = _load_config()
    total = 0.0
    weight_sum = 0.0
    for c in CRITERIA:
        sc = criterion_score(values.get(c))      # None → "Not sure" → not counted
        if sc is None:
            continue
        w = float(cfg.get(c, 0.0))
        weight_sum += w
        total += w * _SCORE_TO_FLOAT[sc]
    if weight_sum <= 0:
        return 0.0
    score = (total / weight_sum) * 100.0
    return max(0.0, min(100.0, round(score, 1)))


def scored_weight(values: Mapping[str, Any]) -> tuple[float, float, int, int]:
    """How much of the model actually got to speak: (counted, total, n_counted, n).

    `alignment_score` renormalises over the determined criteria, which means 100.0 off one
    criterion and 100.0 off nine are the same number. They are not the same claim, and a
    reader has to be able to tell them apart — so the page prints "scored on N of 9" from
    this, and `core.data_quality` already carries the separate question of how much SOURCE
    there was to read.
    """
    cfg = _load_config()
    counted = whole = 0.0
    n_counted = 0
    for c in CRITERIA:
        w = float(cfg.get(c, 0.0))
        whole += w
        if criterion_score(values.get(c)) is not None:
            counted += w
            n_counted += 1
    return counted, whole, n_counted, len(CRITERIA)


# The five MUSTs and four PREFERs, in the order `CRITERIA` declares them. The Review
# page labels them "MUST 1 · …" through "PREFER 9 · …" off these same slices.
MUST_KEYS = CRITERIA[:5]
PREFER_KEYS = CRITERIA[5:]


def decline_flags(values: Mapping[str, Any]) -> bool:
    """The OWNER'S RULE (2026-08-17) for whether a call carries a decline flag:

        any ONE failing MUST                        -> True
        all MUSTs pass, but >= 2 failing PREFERs    -> True
        otherwise                                   -> False

    The flag is about FAILURE, not the absence of success: only a measured 0 counts.
    "Not sure" and "Partial" are not failures, the same principle the rest of the model
    follows. See tests/test_decline_flags_rule.py for the reasoning and the measurement.

    THE CALLER CHOOSES THE VALUES, AND THAT IS THE WHOLE POINT. Scan-time scoring passes
    what it derived that day; a screen showing the LIVE derivation must pass the live
    values, or it prints a flag that contradicts the criteria directly above it. That is
    exactly what the Review page did: every MUST green on screen beside "Decline flags:
    Yes", because the grid was live and the flag was a column written at scan time.
    """
    musts_failed = sum(1 for m in MUST_KEYS if criterion_score(values.get(m)) == 0)
    if musts_failed:
        return True
    prefers_failed = sum(1 for p in PREFER_KEYS if criterion_score(values.get(p)) == 0)
    return prefers_failed >= 2


def auto_recommendation(score: float, decline_flags_present: bool) -> str:
    """Decline-flag override beats score; thresholds from scoring_weights.yaml.

    The defaults match the YAML and auto_scorer.recommend_from_composite deliberately: a
    missing or partial config must not quietly restore the old 70/45 banding, which is the
    discrepancy this function was half of. See the note in config/scoring_weights.yaml.

    This remains a COARSER rule than the canonical one — it has no fatal-factor gate and no
    below-award-floor cap, because it is not given the inputs those need. Both of those only
    ever downgrade, so with the thresholds aligned this answer is an upper bound on the
    canonical one rather than a contradiction of it.
    """
    if decline_flags_present:
        return "Decline"
    th = _load_config().get("thresholds", {}) or {}
    proceed = float(th.get("proceed", 90))
    park = float(th.get("park", 70))
    if score >= proceed:
        return "Proceed"
    if score >= park:
        return "Park"
    return "Decline"


def score_submission(
    values: Mapping[str, Any], decline_flags_present: bool
) -> tuple[float, str]:
    """One-shot convenience: returns (alignment_score, auto_recommendation)."""
    s = alignment_score(values)
    return s, auto_recommendation(s, decline_flags_present)
