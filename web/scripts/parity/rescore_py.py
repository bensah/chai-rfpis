"""Python half of check-rescore.mjs — the two paths to a recommendation, over the same rows.

A row's `alignment_score` and `auto_recommendation` can be written by two different pieces of
code:

  * `core.auto_scorer.auto_score` — what the scan runs when a call is first found, and what
    every live screen recomputes through `core.assessment.assess_row`;
  * `scripts.rescore_existing._evaluate` — what a re-score runs over rows already stored.

They share their helpers but not their sequence, and `_evaluate`'s own comment promises
parity: "Parity with auto_score's post-rules so a re-score never diverges from a fresh scan".
A promise kept by hand in two places is where drift lives — the 70/45 banding bug was exactly
that. This runs both over the same live rows and reports every row where they disagree.

That matters more now than it did: moving scoring to a server-side job makes the re-score
path authoritative for what a reader sees, so a divergence here stops being theoretical and
becomes the number on the screen.

    python rescore_py.py [rows_per_tenant]      → JSON on stdout. Read-only.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from core.dotenv_compat import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

from auth import tenant_context as tc                      # noqa: E402
from core import org_profile as orgp                       # noqa: E402
from core import settings as _settings                     # noqa: E402
from core.assessment import assess_row                     # noqa: E402
from core.policies import get_policies                     # noqa: E402
from core.score_stamp import stamp_state                   # noqa: E402
from db.supabase_client import service_client              # noqa: E402
from scripts.rescore_existing import _evaluate             # noqa: E402

# BOTH ENDS, EXPLICITLY. On Windows the default codec for stdin and stdout is cp1252, so a
# harness reads UTF-8 JSON as cp1252 and writes its answer back as cp1252 bytes. Node then
# decodes those as UTF-8. Sometimes the two errors cancel and the check passes while
# comparing mojibake; sometimes they do not and it reports differences that are not there —
# check-permissions spent this session reporting 39 false diffs on a single em dash, which
# is how a check stops being read.
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 120


def both_paths(row: dict, org: dict, org_set: dict, donors: list[dict],
               current_sig: str | None = None) -> dict:
    """What each path would store for this row.

    The re-score runs TWICE, because the two runs answer different questions and only one of
    them is about code drift:

      * `rederive=True` re-derives the nine criteria exactly as `auto_score` does, so any
        remaining difference is the two code paths genuinely disagreeing — the thing this
        check exists to catch.
      * `rederive=False` keeps the criteria columns as they are stored, so a difference means
        the STORED criteria have gone stale against the current profile and donor data. Real,
        worth knowing, but a data fact rather than a code fault — and the reason
        `rescore_existing` has the flag at all.

    Reporting only the second would have raised a false alarm about drift.
    """
    out: dict = {
        "uid": str(row.get("uid") or ""),
        # What the database holds — after the scoring move this is what a reader sees,
        # because nothing recomputes at read time any more.
        "stored": {
            "rec": row.get("auto_recommendation"),
            "score": None if row.get("alignment_score") is None
            else round(float(row["alignment_score"]), 1),
            # Present only once migration 101 is applied. `has_stamp` separates the two
            # cases a bare None cannot: the COLUMN is absent (101 unapplied, the check
            # cannot run) versus the column exists and is null (101 applied, the job has
            # simply not reached this row yet, which is unverified rather than stale).
            "has_stamp": "score_profile_sig" in row,
            "scored_at": row.get("scored_at"),
            "profile_sig": row.get("score_profile_sig"),
            # THE VERDICT, DECIDED IN PYTHON. `core.score_stamp.stamp_state` is the one
            # definition of what the stamps mean, and the TypeScript side now reads it
            # rather than re-deriving it from `profile_sig` and a signature — which is
            # exactly what it used to do, and exactly how it came to report every stamped
            # row as "current" for weeks when the signature it compared against was null.
            #
            # Five words, and two of them did not exist before: `deferred` (unstamped
            # because a human assessed the row, so the job will NEVER re-stamp it — 39
            # rows, permanently outside what this check asserts) and `unknown` (stamped,
            # but we could not say what the current signature is, which is the absence of
            # evidence rather than evidence of currency).
            "state": stamp_state(row, current_sig),
        },
    }

    # The scan / live-screen path. assess_row is how every screen reaches auto_score, and
    # as of 2026-10-28 it is also the path the scoring job runs, so this is the answer the
    # server is supposed to be storing.
    try:
        a = assess_row(dict(row), get_policies())
        out["scan"] = {"rec": a.get("auto_recommendation"),
                       "score": None if a.get("alignment_score") is None
                       else round(float(a["alignment_score"]), 1)}
    except Exception as exc:
        out["scan"] = {"error": f"{type(exc).__name__}: {exc}"}

    # The re-score path. It returns only what it would CHANGE, so fall back to the stored
    # value for anything it leaves alone — that is what the row would hold afterwards.
    for key, rederive in (("rescore", True), ("rescore_stored_criteria", False)):
        try:
            _uid, upd, _label = _evaluate(dict(row), org, org_set, donors, rederive)
            upd = upd or {}
            score = upd.get("alignment_score", row.get("alignment_score"))
            out[key] = {"rec": upd.get("auto_recommendation", row.get("auto_recommendation")),
                        "score": None if score is None else round(float(score), 1)}
        except Exception as exc:
            out[key] = {"error": f"{type(exc).__name__}: {exc}"}
    return out


# The row shapes the TypeScript side asks about. Kept HERE so both halves are answering
# about the same bytes, and answered by the Python's own predicate rather than by a list
# of expectations written down twice — a shared fixture with two hand-written answer keys
# is two things to keep in step, which is the problem this check exists to solve.
HUMAN_CASES = [
    {"decision_date": "2026-11-16"},
    {"decision_date": "2026-11-16", "decision": "Proceed"},
    {"decision_overridden_by": "ben@x.org"},
    {"decision_overridden_by": "ben@x.org", "decision": "Proceed"},
    {"decision_overridden_by": "ben@x.org", "decision": ""},
    {"decision": "Proceed"},
    {"decision_date": "", "decision_overridden_by": "   ", "decision": "Proceed"},
    {"decision_date": None, "decision_overridden_by": None, "decision": None},
    {},
]


def human_cases() -> list[bool]:
    """What `core.score_stamp.human_assessed` answers for each shape above."""
    from core.score_stamp import human_assessed
    return [bool(human_assessed(r)) for r in HUMAN_CASES]


def human_markers() -> list[str]:
    """`core.score_stamp.ASSESSED_BY_A_HUMAN` — the columns the re-score job's skip is
    keyed on, which `pipeline_writes.ts` must answer the same question with. Read from the
    module rather than retyped: a column added on one side only would have the job
    declining a row the API has just told the editor is being recalculated."""
    from core.score_stamp import ASSESSED_BY_A_HUMAN
    return sorted(ASSESSED_BY_A_HUMAN)


def main() -> None:
    sb = service_client()
    donors = sb.table("donor_intel").select("*").limit(5000).execute().data or []
    tenants = (sb.table("tenants").select("id,slug").eq("status", "active")
               .execute().data or [])
    report: dict = {}
    report_sig: dict = {}
    report_markers = human_markers()
    report_cases = human_cases()
    for t in tenants:
        tid = str(t["id"])
        tok = tc.set_tenant_override(tid)
        try:
            rows = (sb.table("rfp_submissions").select("*")
                    .eq("tenant_id", tid).limit(LIMIT).execute().data or [])
            # The signature the current profile would produce. A stored score tagged with
            # this one claims to be current; if it then disagrees with a fresh computation,
            # that is a fault rather than staleness.
            #
            # THE IMPORT IS NO LONGER SWALLOWED, and that is the fix for this check's own
            # longest-running defect. This was `try: from core.live_scoring import
            # profile_signature / except Exception: None` — and the function DID NOT EXIST.
            # So the except fired on every run, every tenant got a null signature, and
            # `check-rescore.mjs`'s `if (sig && ...)` sent every stamped row to "current".
            # The check could not tell a stale score from a wrong one and said nothing
            # about it for as long as that import had been there.
            #
            # A missing signature is a fault in THIS harness, not a condition to tolerate:
            # it silently removes the check's ability to distinguish its two outcomes. So
            # it raises now, and the only thing caught is the per-tenant failure to read a
            # profile, which is reported as a null signature and shows up as `unknown`.
            from core.live_scoring import profile_signature
            _sig = profile_signature()
            report_sig[t.get("slug") or tid] = _sig
            org = orgp.get_profile()
            try:
                org_set = _settings.get_org()
            except Exception:
                org_set = {}
            report[t.get("slug") or tid] = [
                both_paths(r, org, org_set, donors, _sig) for r in rows]
        finally:
            tc.reset_tenant_override(tok)
    sys.stdout.write(json.dumps({"rows": report, "current_profile_sig": report_sig,
                                 "human_markers": report_markers,
                                 "human_cases": HUMAN_CASES,
                                 "human_answers": report_cases},
                                default=str))


if __name__ == "__main__":
    main()
