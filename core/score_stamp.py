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

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

# The two columns only the scoring job has earned the right to set. Spelled once; the test
# in tests/test_editor_saves_do_not_stamp.py reads them from here.
STAMP_COLUMNS = ("scored_at", "score_profile_sig")


# ── The signature, and the clause it was missing ─────────────────────────────
#
# `score_profile_sig` is a CLAIM that a stored number is what the current rules produce.
# Three places built it by hand — `scripts/rescore_existing.profile_signature`,
# `views/screened_rfp.py` and `views/rfp_records.py` — and all three carried a comment
# saying the stored score "goes stale when org profile, donor intel, OR SCORING LOGIC
# change". Only the first two were ever in the hash.
#
# So a change to the scoring ARITHMETIC left every stamped row claiming to be current
# while holding a number the engine no longer computes, and nothing in the app could tell.
# On 2026-11-18, when an undetermined criterion stopped taking half its weight, that was
# 177 of 211 stamped rows, and `check-rescore` caught it — which is the only reason this
# is a fixed bug rather than a silent one. The same gap had already produced 11 bad rows
# in an earlier rule change, swept by hand at the time instead of being closed.
#
# It is closed here, in the module that exists to own who may call a score current, and
# the three builders now call this instead of restating the hash.

#: Bump when the scoring ARITHMETIC changes — what a criterion is worth, what counts
#: toward the denominator, how the composite is assembled. Every stamped row then reads
#: as stale and the re-score job picks it up; nothing is written to say so.
#:
#: NOT bumped for a reworded label, a comment, or a change that cannot move a number.
#: Marking every row stale costs a full re-score run, which on this project's free tiers
#: is a real cost rather than a theoretical one.
SCORING_RULE_VERSION = "2026-11-18.unsure-leaves-the-denominator"


def _weights_digest() -> str:
    """config/scoring_weights.yaml, hashed as bytes.

    The weights and the 90/70 bands are the half of the rule that lives in data rather
    than in code, so they need no one to remember a bump: edit the YAML and every stamp
    goes stale by itself. Unreadable → "nofile", which simply holds the signature steady
    rather than inventing one.
    """
    try:
        path = Path(__file__).resolve().parent.parent / "config" / "scoring_weights.yaml"
        return hashlib.sha1(path.read_bytes()).hexdigest()[:8]
    except OSError:
        return "nofile"


class BundledSignatureError(RuntimeError):
    """Raised when `profile_sig` is called from the browser's bundled copy of core/."""


def _running_in_the_browser_bundle() -> bool:
    """Is this the Pyodide copy of core/ rather than the server's working tree?

    Pyodide reports `sys.platform == "emscripten"`, which nothing else in this project
    does, so it needs no cooperation from the caller and cannot be faked by a stale file.
    """
    return sys.platform == "emscripten"


def profile_sig(org_profile: Any, org_settings: Any) -> str:
    """THE signature, for every caller. 12 hex characters, as migration 101 expects.

    Takes the org profile and settings already in hand rather than fetching them: two of
    the three callers are mid-render with the profile loaded, and reading it again inside
    a Streamlit page would cost a round trip per rerun.

    IT REFUSES TO ANSWER FROM THE BROWSER BUNDLE, and the reason is specific rather than
    defensive. `web/scripts/build-py-bundle.mjs` copies core/ AND config/ into
    `web/public/py/bundle.json` once, when the dev server starts — Vite's HMR never
    rebuilds it. This function hashes `config/scoring_weights.yaml` along with
    SCORING_RULE_VERSION, so a server left running across a rule change would give a
    browser computing the OLD signature from the OLD YAML while the server computes the
    new one: two halves of the app disagreeing about which stored scores are current, with
    no error anywhere and nothing on screen to suggest it.

    Nothing in the browser path calls this today — `core/live_scoring` is the only
    importer inside core/ and the Pyodide worker does not reach it. "Today" is the whole
    of that guarantee, which is why this is a raise and not a comment asking people not
    to. A signature is a claim about freshness; computing one from a snapshot of unknown
    age is the one thing it must never do.

    The server is unaffected: `sys.platform` is "emscripten" only under Pyodide.
    """
    if _running_in_the_browser_bundle():
        raise BundledSignatureError(
            "profile_sig must not be computed in the browser: core/ and "
            "config/scoring_weights.yaml reach it through web/public/py/bundle.json, "
            "which is built once at dev-server start and never refreshed. The signature "
            "it produced would describe whatever the bundle was built from, not the "
            "current rules. Ask the server for it.")
    basis = (json.dumps(org_profile, sort_keys=True, default=str)
             + json.dumps(org_settings, sort_keys=True, default=str)
             + "|" + SCORING_RULE_VERSION + "|" + _weights_digest())
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:12]

# The columns `human_assessed` reads. NOT an any-of list — see the rule in the function.
# Pinned against the TypeScript copy in `supabase/functions/_shared/api/pipeline_writes.ts`
# by check-rescore, so the two halves of the app cannot drift on what "assessed" means.
ASSESSED_BY_A_HUMAN = ("decision_date", "decision_overridden_by", "decision")


def human_assessed(row: dict[str, Any]) -> bool:
    """Has a person assessed this row, as opposed to the scan having scored it?

    The rule this answers (owner, 2026-11-16): the re-score job does not re-derive a row a
    human has assessed. `auto_scorer.auto_score` bases all nine criteria to None and
    re-derives them from org profile x donor intel x call text — it never reads the nine
    stored columns — so on a reviewed row it is not correcting the number, it is answering
    "what would this score if nobody had looked at it". Measured on live data: 48 of 56
    reviewed rows hold criteria it does not reproduce, and 30 of those come out with a
    different recommendation.

    `core/scan_pipeline.py:307` has deferred to human review all along ("Refresh
    auto-scoring only when the existing row has no alignment_score ... Otherwise human
    work wins"); this restores the same rule on the job that took scoring over.

    THE RULE: a decision date, or a person's save on a row that carries a decision.

        decision_date                              -> assessed
        decision_overridden_by AND decision        -> assessed
        anything else                              -> not

    NEITHER COLUMN WORKS ALONE, and the first draft of this used `decision_overridden_by`
    on its own and was wrong. Measured over 271 live rows on 2026-11-16:

        decision_date alone        exempts 31, and covers 2 of the 5 rows this rule was
                                   written for. It is stamped by POST /pipelines/decision
                                   and by the Review screen, but NOT by `views/rfp_editor.py`
                                   — so an assessment recorded in the editor, which is where
                                   three of those five came from, looks like a scan row.
        decision_overridden_by     exempts 56, covers all five, and decays: BOTH apps stamp
        alone                      it on every save of any field (pipeline_writes.ts:343,
                                   rfp_editor.py:616), so it means "somebody edited this
                                   once". 29 rows are exempt on the strength of a save
                                   rather than a decision, and that number grows with every
                                   edit anyone makes.
        decision alone             exempts 92, but 33 of those carry no human marker at
                                   all: the engine writes this column too, which is why
                                   `web/src/api.ts` warns that a decision without a date is
                                   the engine's, not a person's.

    The conjunction keeps all five and bounds the decay: a save only confers the exemption
    on a row that already holds a decision, so an untouched scan row cannot drift into it,
    and `views/rfp_editor.py` now stamps `decision_date` the first time a reviewer records
    a decision. As that reaches the rows people actually edit, `decision_date` becomes the
    whole answer and the second clause can go.

    THE PROXY IS THE DECISION, NOT THE CRITERIA, and that is the real limitation: nothing
    records WHO set a criterion. `scan_pipeline` writes the nine columns at scan time and
    both Streamlit editors write them on save, so a reader cannot tell a human answer from
    the scan's own earlier output. The one unambiguous human channel is
    `criteria_component_overrides`, which only the Review screen writes — 5 rows of 271.
    Until a human answer carries provenance, a recorded decision is the best available
    evidence that a person has been through this row.
    """
    row = row or {}

    def _set(column: str) -> bool:
        return bool(str(row.get(column) or "").strip())

    return _set("decision_date") or (_set("decision_overridden_by") and _set("decision"))


def stamp_state(row: dict[str, Any] | None, current_sig: str | None) -> str:
    """What the stamps on this row actually say. One of five words.

        current     stamped, and the signature is the one in force
        stale       stamped under an older signature — a re-score fixes it
        unverified  no stamp, and nobody has assessed it — the job has not reached it yet
        deferred    no stamp, and a human HAS assessed it — the job will never touch it
        unknown     stamped, but the caller could not say what the current signature is

    WHY `deferred` IS NOT `unverified`, which is the whole reason this exists.
    `scripts/run_web_job.py::_rescore` skips a row a human has assessed and clears its
    stamps, so it lands among the unstamped rows and gets reported as "the job has not run
    on this yet". That is a different fact from "the job will never run on this", and only
    the first one is actionable: waiting fixes an unverified row and does nothing at all
    for a deferred one. Measured 2026-11-18 by the react-migration session: 39 rows sit in
    the second group, permanently outside anything `check-rescore` asserts.

    WHY `unknown` EXISTS AND IS NOT FOLDED INTO `current`. Because that fold is the bug
    this session spent a day on. `web/scripts/parity/rescore_py.py` imported a
    `profile_signature` that did not exist, caught the ImportError, and passed None;
    `check-rescore` guarded its staleness branch with `if (sig && ...)`, so every stamped
    row fell through to "current" and the check silently stopped being able to tell a
    stale score from a wrong one. A missing signature is not evidence that a row is
    current — it is the absence of evidence, and this returns a word that says so.

    DERIVED, NEVER STORED. Every input is already on the row; a column holding this would
    be a second copy that can disagree with the one that determines it, which is the same
    failure as a stamp claiming a number nothing computed.

    `deferred` INHERITS `human_assessed`'s DECAY BOUND. That predicate is deliberately
    temporary — a conjunction holding the line until `decision_date` reaches the rows
    people edit, after which its second clause is meant to go. Deleting that clause moves
    rows between `deferred` and `unverified` without anyone touching this function or the
    check that counts its buckets. Whoever simplifies it is also resizing a report.
    """
    row = row or {}
    stamped = bool(str(row.get("score_profile_sig") or "").strip())
    if not stamped:
        return "deferred" if human_assessed(row) else "unverified"
    if not str(current_sig or "").strip():
        return "unknown"
    return "current" if row.get("score_profile_sig") == current_sig else "stale"


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
