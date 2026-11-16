"""The Python half of the Submit New Notice parity check.

Three rules, each taken from the module that owns it rather than retyped:

  * `core.uid_generator.generate_uid` — the submitter's identifier.
  * `core.scorer.score_submission` — alignment score and auto-recommendation, which the
    React route computes at insert because the re-score job cannot be dispatched on the
    live deployment (no RFPIS_GH_DISPATCH_TOKEN).
  * `core.criteria_derive.needs_submission_check` — the backdated-intake prompt.

Plus two SHAPE answers that are not rules but are the cheapest way to catch the class of
bug neither side's types can: the live `rfp_submissions` and `extracted_solicitations`
column lists, so a key the TypeScript writes that no column holds fails here rather than
at the first real submission.

READ ONLY. Nothing here writes a row.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from core.criteria_derive import needs_submission_check          # noqa: E402
from core.scorer import score_submission                         # noqa: E402
from core.uid_generator import generate_uid                      # noqa: E402


def _columns(table: str) -> list[str]:
    """Every column of a live table, read from one row.

    A table with no rows answers nothing, so the caller is told so explicitly rather than
    being handed an empty list it would read as "no columns match".
    """
    try:
        from db.supabase_client import get_client
        rows = get_client().table(table).select("*").limit(1).execute().data or []
        return sorted(rows[0].keys()) if rows else []
    except Exception as exc:                                     # pragma: no cover
        print(f"column read failed for {table}: {exc}", file=sys.stderr)
        return []


def main() -> None:
    payload = json.loads(sys.stdin.read())

    uids = [generate_uid(c["name"], datetime.fromisoformat(c["at"]))
            for c in payload["uids"]]

    # score_submission returns (float, str). The score is rounded to one decimal by
    # alignment_score, so it compares exactly.
    scores = [list(score_submission(c["values"], bool(c["decline"])))
              for c in payload["scores"]]

    checks = [bool(needs_submission_check(r)) for r in payload["rows"]]

    print(json.dumps({
        "uids": uids,
        "scores": scores,
        "checks": checks,
        "rfp_columns": _columns("rfp_submissions"),
        "pool_columns": _columns("extracted_solicitations"),
        "job_kinds": sorted(__import__(
            "scripts.run_web_job", fromlist=["KINDS"]).KINDS.keys()),
    }, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
