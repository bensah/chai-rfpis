"""Which of the nine criteria a PERSON answered, so the scorer can stop discarding them.

`core.auto_scorer.auto_score` derives all nine criteria from org profile x donor intel x
call text. It is right to: a scanned row has no human answers, and a derivation that reads
the stored columns would freeze the scan's own guesses and stop a profile edit propagating.
The cost was that it could not tell a human answer from its own earlier output either,
because nothing recorded who set a criterion — so on a reviewed row it discarded the
reviewer's work and, after scoring moved to the server on 2026-10-28, wrote the result over
their number. Measured 2026-11-16: 48 of 56 human-assessed rows held criteria the
derivation does not reproduce, 30 of them on a different recommendation.

Migration 102 adds `rfp_submissions.criteria_provenance`. This module is the rule for
reading and writing it.

    {"qualification": {"by": "a@b.org", "at": "2026-11-16T12:00:00+00:00"}, ...}

TWO CHANNELS, ONE QUESTION. A criterion counts as human-set if EITHER names it:

  * `criteria_provenance` — the editors' whole-criterion dropdown answers.
  * `criteria_component_overrides` — the Review screen's per-COMPONENT verdicts, which
    already mean "a reviewer decided this" and whose own docstring says the reviewer's
    verdict wins over the derivation. It never reached the score: `matching.composite_match`
    reads the nine labels off the row and never calls `apply_component_overrides`. Reading
    it here is what finally connects it, because the Review screen saves the
    override-adjusted LABEL into the stored column — so the label this module hands the
    scorer already carries the reviewer's verdict.

WHAT IS NOT RECORDED, and this is the whole reason the column is trustworthy: an editor
save round-trips all nine criteria whether or not the reviewer touched them. Recording
those would stamp the scan's own values as human judgement within one save of every row —
the same decay that made `decision_overridden_by` useless as an assessment marker
(see `core.score_stamp.human_assessed`). `record` compares against what the row HELD and
writes only what actually changed.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Mapping

from core.scorer import CRITERIA

COLUMN = "criteria_provenance"
OVERRIDES_COLUMN = "criteria_component_overrides"


def _as_dict(value: Any) -> dict:
    """The column, whichever way the client hands it back (dict, or JSON text)."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except Exception:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _empty(value: Any) -> bool:
    """Nothing stored at all. Distinct from "Not sure", which is a stored non-answer."""
    return value is None or not str(value).strip()


def _no_answer(value: Any) -> bool:
    """Blank, or the explicit unknown — neither is an answer worth overriding a derivation.

    "Not sure" is how the form says "I cannot tell", and `core.scorer` rates it at the Park
    midpoint rather than 0. A stored label can also be a STALE "Not sure" left behind when
    a reviewer moved the components underneath it (AS-260828-184240 on 2026-11-16: the
    override raised every funding_quality component to 1.0 while the saved label still read
    "Not sure"). Treating either as a human answer would let the weakest possible value
    outrank a derivation that actually determined something, in the name of a person who
    did not say it.
    """
    if value is None:
        return True
    text = str(value).strip()
    return not text or text.lower() == "not sure"


def human_set(row: Mapping[str, Any] | None) -> set[str]:
    """The criteria on this row that a person answered, from either channel.

    A key with a falsy value still counts: the record says a human was here, and
    `answers` is what decides whether there is a usable label to hand the scorer.
    """
    row = row or {}
    named = set(_as_dict(row.get(COLUMN))) | set(_as_dict(row.get(OVERRIDES_COLUMN)))
    return {c for c in CRITERIA if c in named}


def answers(row: Mapping[str, Any] | None) -> dict[str, Any]:
    """{criterion: the stored label} for the criteria a person answered.

    The LABEL comes from the row's own column, not from the provenance record: provenance
    says who answered, the column says what they answered. Keeping them apart means a later
    correction through any path is picked up without rewriting the provenance, and means
    this module never has to hold a second copy of a value that already exists.

    A criterion whose provenance is recorded but whose column is now blank is left out — a
    blank is not an answer, and handing the scorer None would score it as "Not sure" while
    claiming a human said so.
    """
    row = row or {}
    out = {}
    for criterion in human_set(row):
        value = row.get(criterion)
        if not _no_answer(value):
            out[criterion] = value
    return out


def record(
    row: Mapping[str, Any] | None,
    values: Mapping[str, Any],
    by: str | None,
    at: str | None = None,
) -> dict | None:
    """The new provenance column for a save, or None when there is nothing to change.

    `values` is what the save is about to write for the nine criteria; `row` is what the
    row holds now. Only criteria whose value actually MOVES are recorded — see the module
    docstring for why round-tripped values must not be.

    Existing entries are kept: a criterion a reviewer answered last week is still theirs
    when somebody edits a different one today. An entry is dropped only when this save
    clears that criterion, because an answer that no longer exists has no author.

    Returns None when nothing moved, so a caller can leave the column out of the update
    entirely rather than rewriting it to its own value on every save.
    """
    row = row or {}
    before = _as_dict(row.get(COLUMN))
    after = dict(before)
    stamp = at or datetime.now(timezone.utc).isoformat()
    changed = False

    for criterion in CRITERIA:
        if criterion not in values:
            continue
        new, old = values.get(criterion), row.get(criterion)
        if str(new or "").strip() == str(old or "").strip():
            continue                      # round-tripped, or genuinely unchanged
        if _empty(old):
            # THE ROW HELD NOTHING, so this is the form filling a gap rather than a person
            # contradicting anything. `views/rfp_editor.py::_elig` pre-selects a stored
            # value through `default_response`, and where there is none to map it falls to
            # the option at index 0 — so a save of any OTHER field writes a default into a
            # blank criterion. Recording that would put a reviewer's name on an answer the
            # form chose, which is the whole failure this column exists to avoid. The cost
            # is a false negative: a reviewer genuinely answering a blank criterion is not
            # recorded until they change it again. That is the safe direction to be wrong
            # in, and "Not sure" is NOT empty, so answering one of those still counts.
            continue
        changed = True
        if _empty(new):
            after.pop(criterion, None)    # cleared: nobody is the author of a blank
        else:
            after[criterion] = {"by": by or "unknown", "at": stamp}

    return after if changed else None
