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
from db.supabase_client import service_client              # noqa: E402
from scripts.rescore_existing import _evaluate             # noqa: E402

LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 120


def both_paths(row: dict, org: dict, org_set: dict, donors: list[dict]) -> dict:
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


def main() -> None:
    sb = service_client()
    donors = sb.table("donor_intel").select("*").limit(5000).execute().data or []
    tenants = (sb.table("tenants").select("id,slug").eq("status", "active")
               .execute().data or [])
    report: dict = {}
    report_sig: dict = {}
    for t in tenants:
        tid = str(t["id"])
        tok = tc.set_tenant_override(tid)
        try:
            rows = (sb.table("rfp_submissions").select("*")
                    .eq("tenant_id", tid).limit(LIMIT).execute().data or [])
            # The signature the current profile would produce. A stored score tagged with
            # this one claims to be current; if it then disagrees with a fresh computation,
            # that is a fault rather than staleness. Absent until migration 101 is applied.
            try:
                from core.live_scoring import profile_signature  # type: ignore[attr-defined]
                report_sig[t.get("slug") or tid] = profile_signature()
            except Exception:
                report_sig[t.get("slug") or tid] = None
            org = orgp.get_profile()
            try:
                org_set = _settings.get_org()
            except Exception:
                org_set = {}
            report[t.get("slug") or tid] = [both_paths(r, org, org_set, donors) for r in rows]
        finally:
            tc.reset_tenant_override(tok)
    sys.stdout.write(json.dumps({"rows": report, "current_profile_sig": report_sig},
                                default=str))


if __name__ == "__main__":
    main()
