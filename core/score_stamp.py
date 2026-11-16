"""Who is allowed to say a stored score is current.

Since 2026-10-28 the SERVER owns `alignment_score` / `auto_recommendation`:
`scripts/run_web_job.py::_rescore` runs `core.auto_scorer.auto_score` — the same call every
live screen makes through `core.assessment.assess_row` — and stamps the row with
`scored_at` and `score_profile_sig` (migration 101). Those two columns are a CLAIM: "this
number is what the current profile produces". `_rescore`'s own docstring is explicit that a
row must never claim to be freshly scored while holding a number nothing computed, which is
why it skips a row it could not score rather than stamping it.

The Streamlit editors compute a score too, and they do NOT compute that one. They call
`core.scorer.score_submission`, a weighted sum whose own docstring calls it coarser than
and an upper bound on the canonical rule: no fatal-factor gate, no below-award-floor cap.
That is deliberate — the editor shows a submitter the number their nine answers produce,
the instant they change one, with nothing to wait for. The two scorers are not reconcilable
by picking one; measured on live data they differ by about 4 points on every row and change
the recommendation on 8 of 40 chai-cameroon rows.

So an editor save writes a real number from the wrong author. Until 2026-11-16 it wrote it
over the job's number and left the stamps untouched, and 8 live rows ended up claiming to
be freshly scored under the current profile while holding the editor's coarser answer — the
exact state `web/scripts/parity/check-rescore.mjs` exists to fail on, and it had been red on
5 of them for weeks.

THE RULE, in one place so it cannot drift again: whoever writes a score they did not compute
through `auto_score` clears both stamps in the same write. The row then reads "unverified"
(migration 101's own word for a null signature) rather than "current and wrong", the
submitter still sees their number immediately, and the next `rescore` job picks the row up
and stamps it honestly.

WHY NOT THE OTHER SHAPE — the editor writing no score at all and waiting for the job, as the
React PATCH route does. Nothing on the Streamlit side reaches the job runner: `enqueue` lives
in `supabase/functions/_shared/api/`, there is no Python caller anywhere in this repo, and
dispatching a job from Streamlit would need the GitHub token the edge function holds. A
Streamlit save would leave the row with no score at all until something else happened to
re-score it. Immediate feedback is the whole reason the editor scores, so it keeps scoring —
honestly.
"""
from __future__ import annotations

from typing import Any

# The two columns only the scoring job has earned the right to set. Spelled once; the test
# in tests/test_editor_saves_do_not_stamp.py reads them from here.
STAMP_COLUMNS = ("scored_at", "score_profile_sig")


def editor_score_columns(score: float | None, rec: str | None) -> dict[str, Any]:
    """The score columns a HUMAN-FACING save writes: the number, and no claim about it.

    `score` / `rec` come from `core.scorer.score_submission` on the values the person is
    looking at. Both stamps go to None in the same update, so the row says "scored by the
    editor, not verified by the server" instead of inheriting the previous run's claim.

    Spread it into the update dict — never write `alignment_score` beside it by hand, or the
    clearing can be dropped without the write looking wrong:

        update = {..., **editor_score_columns(align, rec)}
    """
    return {
        "alignment_score": score,
        "auto_recommendation": rec,
        # NOT omitted. On an UPDATE these must overwrite whatever the last job wrote; on an
        # INSERT they are already null and writing them costs nothing, so every human write
        # path can use the same call and the rule has no exceptions to remember.
        "scored_at": None,
        "score_profile_sig": None,
    }
