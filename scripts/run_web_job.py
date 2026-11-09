"""Run one background job queued by the React app (a `web_jobs` row, migration 099).

    python scripts/run_web_job.py <job_id> [--runner github|local]

Started by `.github/workflows/web-job.yml` (production) or by the Vite dev server (local
review). The job row is the only channel back to the user: status, progress, message and
result are written there, and the browser polls them through the API.

THE ACTIONS LOG IS PUBLIC (the repository is public). This script prints the job id, its
kind and its status, and nothing else: no parameters, no tenant data, no exception text.
Errors go into the job row, which only the API can read.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from core.dotenv_compat import load_dotenv   # noqa: E402

import requests                               # noqa: E402


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobRow:
    """The job's row over PostgREST with the service key. Plain HTTP, so a light job does
    not import the whole app."""

    def __init__(self, job_id: str):
        url = os.environ["SUPABASE_URL"].rstrip("/")
        key = os.environ["SUPABASE_KEY"]
        self.endpoint = f"{url}/rest/v1/web_jobs"
        self.headers = {"apikey": key, "Authorization": f"Bearer {key}",
                        "Content-Type": "application/json", "Prefer": "return=representation"}
        self.id = job_id

    def get(self) -> dict | None:
        r = requests.get(self.endpoint, headers=self.headers, timeout=30,
                         params={"select": "*", "id": f"eq.{self.id}", "limit": "1"})
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    def update(self, values: dict, *, only_if_status: tuple[str, ...] | None = None) -> bool:
        params = {"id": f"eq.{self.id}"}
        if only_if_status:
            params["status"] = f"in.({','.join(only_if_status)})"
        r = requests.patch(self.endpoint, headers=self.headers, params=params, json=values, timeout=30)
        r.raise_for_status()
        return bool(r.json())

    def progress(self, pct: int | None, message: str) -> None:
        self.update({"progress": {"pct": pct, "message": message}})


# ── Job kinds ────────────────────────────────────────────────────────────────
# Each handler gets the row and the job's params and returns the result dict. Heavy app
# modules are imported inside the handler, so a light job stays light.

def _ping(job: JobRow, params: dict, runner: str) -> dict:
    job.progress(50, "Runner reached")
    time.sleep(1)
    return {"pong": True, "runner": runner}


def _rescore(job: JobRow, params: dict, runner: str) -> dict:
    """Recompute stored scores for one tenant — a row, or all of them.

    This is what "the server owns the score" means in practice (owner, 2026-10-28). The
    scoring itself does NOT move: this runs the same `auto_score` the scan and every live
    screen run. It changes host, not language, so there is still one implementation of the
    rule rather than two that agree until they don't.

    WHY auto_score DIRECTLY AND NOT assess_row, which is what the screens call: assess_row
    wraps it in a bare `except` that returns the row's STORED score, so a display never
    crashes on a scoring hiccup. That is right for a display and wrong here. If it fired
    inside this job, the job would write back the number it just read, stamp `scored_at`
    and the current signature, and the row would claim to be freshly scored while nothing
    was computed — and a checker comparing stored against fresh could not see it, because
    both would be the same stored value. A job must know when scoring failed. So the call
    is the one assess_row makes, and the swallow is not.

    params: {"tenant_id": required, "uid": optional}. With a uid, one row — what a save
    queues. Without, the tenant's whole table — what a profile edit or a schedule queues.

    Prints counts and nothing else: this log is public (the repository is).
    """
    from auth.tenant_context import reset_tenant_override, set_tenant_override
    from core.auto_scorer import auto_score
    from core.policies import get_policies
    from scripts.rescore_existing import profile_signature, write_with_retry

    tenant_id = str(params.get("tenant_id") or (job.get() or {}).get("tenant_id") or "").strip()
    if not tenant_id:
        raise ValueError("rescore needs a tenant_id")
    uid = str(params.get("uid") or "").strip()

    # Everything below reads the AMBIENT tenant — get_client, get_profile, get_org. Without
    # the override a job would score one tenant's rows against another's organisation,
    # which is both wrong and invisible, so the whole body runs inside it.
    token = set_tenant_override(tenant_id)
    try:
        from db.supabase_client import get_client
        sb = get_client()
        job.progress(5, "Loading")
        q = sb.table("rfp_submissions").select("*")
        if uid:
            q = q.eq("uid", uid)
        rows = q.execute().data or []
        if not rows:
            return {"rows": 0, "scored": 0, "changed": 0, "runner": runner}

        _org, _org_set, _donors, sig = profile_signature(sb, tenant_id)
        policies = get_policies()
        scored = changed = failed = 0
        for i, row in enumerate(rows):
            # auto_score, NOT rescore_existing.evaluate. Both reach composite_match, but
            # auto_score additionally runs _apply_criteria_keywords over the candidate text
            # and evaluate does not, so the two derive different criteria from the same row:
            # measured on live data, AS-260801-0001393 comes out Park/77 one way and
            # Decline/54.5 the other, and 30 of 266 rows change recommendation between them.
            #
            # This is the call assess_row makes, so a server-written score is identical BY
            # CONSTRUCTION to what the screens compute — see the docstring for why the
            # swallow around it is deliberately not copied.
            try:
                res = auto_score(dict(row), policies)
            except Exception as exc:
                # A row that could not be scored is LEFT ALONE. Stamping it would mark it
                # freshly scored under the current profile while holding whatever it held
                # before, which is a worse state than an obviously old one: nothing
                # downstream could tell the difference.
                failed += 1
                print(f"  row {i}: scoring failed ({type(exc).__name__}) — left unstamped")
                continue
            new_score = res.get("alignment_score")
            new_rec = res.get("auto_recommendation")
            if new_score is None and not new_rec:
                failed += 1
                print(f"  row {i}: scoring returned nothing — left unstamped")
                continue

            # The SCORE is what the server owns. The nine criteria stay the scan's to write:
            # re-deriving them here would rewrite columns the editor shows as the system's
            # assessment, which is a bigger claim than "keep the score current".
            upd: dict = {"scored_at": _now(), "score_profile_sig": sig}
            moved = False
            if new_score is not None and new_score != row.get("alignment_score"):
                upd["alignment_score"] = new_score
                moved = True
            if new_rec and new_rec != row.get("auto_recommendation"):
                upd["auto_recommendation"] = new_rec
                moved = True

            # Stamp every row it DID score, even one whose numbers did not move: "scored,
            # unchanged" and "never scored" are different states and only the stamp tells
            # them apart.
            if write_with_retry(sb, str(row.get("uid")), upd):
                scored += 1
                changed += 1 if moved else 0
            if len(rows) > 20 and i % 25 == 0:
                job.progress(5 + int(90 * i / len(rows)), f"Scored {i} of {len(rows)}")

        # `failed` is reported rather than swallowed: a run that scored most of a tenant
        # and quietly skipped the rest should not look like a clean run.
        job.progress(100, f"Scored {scored}" + (f", {failed} failed" if failed else ""))
        return {"rows": len(rows), "scored": scored, "changed": changed,
                "failed": failed, "runner": runner}
    finally:
        reset_tenant_override(token)


def _record_decision(job: JobRow, params: dict, runner: str) -> dict:
    """The two consequences of a human decision that the API cannot carry out itself.

    `decision_log.log_decision` writes the ML training LABEL to scan_decisions, which
    nothing reads at gate time. `seen_ledger.record_decision` writes the operational
    tombstone to rfp_seen, which the SCAN does read. The modules' own docstrings are
    emphatic that neither substitutes for the other, and the second one exists because a
    reviewer's Decline used to be forgotten and the call came back on the next run.

    WHY THIS IS A JOB AND NOT TYPESCRIPT IN THE ROUTE: seen_ledger.column_map() probes the
    live rfp_seen table to learn whether it carries the modern or the legacy column
    spelling, and falls back to identity-only columns when neither answers. Re-deriving
    that in the API would be guessing at a schema, and a wrong guess writes no tombstone
    while reporting success — the exact failure the ledger was built to end.

    params: {"tenant_id": required, "uid": required, "decision": required, "by": optional}

    Prints counts and nothing else: this log is public (the repository is).
    """
    from auth.tenant_context import reset_tenant_override, set_tenant_override

    tenant_id = str(params.get("tenant_id") or (job.get() or {}).get("tenant_id") or "").strip()
    uid = str(params.get("uid") or "").strip()
    decision = str(params.get("decision") or "").strip()
    if not tenant_id:
        raise ValueError("record_decision needs a tenant_id")
    if not uid or not decision:
        raise ValueError("record_decision needs a uid and a decision")

    # Both modules read the AMBIENT tenant through get_client, so the whole body runs
    # inside the override — a tombstone written against the wrong tenant would suppress
    # someone else's opportunity, which is worse than not writing one.
    token = set_tenant_override(tenant_id)
    try:
        from core import decision_log, seen_ledger
        from db.supabase_client import get_client
        sb = get_client()
        job.progress(10, "Loading")
        rows = sb.table("rfp_submissions").select("*").eq("uid", uid).execute().data or []
        if not rows:
            # The row is read back rather than passed in: it is the truth, and a decision
            # whose row has since gone is nothing to record.
            return {"found": False, "logged": False, "tombstoned": False, "runner": runner}
        row = dict(rows[0])

        job.progress(50, "Recording")
        logged = decision_log.log_decision(row, decision, by=params.get("by") or None)
        # Returns False for a decision that is not a closing one — Park and Proceed are
        # live work and must NOT be tombstoned. That is the module's call, not this job's.
        tombstoned = seen_ledger.record_decision(row, decision)

        job.progress(100, "Recorded")
        return {"found": True, "logged": bool(logged), "tombstoned": bool(tombstoned),
                "runner": runner}
    finally:
        reset_tenant_override(token)


KINDS: dict[str, Callable[[JobRow, dict, str], dict]] = {
    "ping": _ping,
    "rescore": _rescore,
    "record_decision": _record_decision,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("job_id")
    ap.add_argument("--runner", default="github", choices=["github", "local"])
    args = ap.parse_args()
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", args.job_id):
        print("job id is not a uuid")
        return 2

    # Locally the .env sits in the working directory (the main checkout) or the repo root.
    load_dotenv(Path.cwd() / ".env")
    load_dotenv(REPO_ROOT / ".env")

    job = JobRow(args.job_id)
    row = job.get()
    if not row:
        print(f"job {args.job_id}: not found")
        return 1
    kind = row.get("kind") or ""
    run_url = None
    if os.environ.get("GITHUB_RUN_ID"):
        run_url = (f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/"
                   f"{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/{os.environ['GITHUB_RUN_ID']}")
    # Claim it: only a queued or dispatched job starts, so a re-run of the workflow cannot
    # run the same job twice.
    if not job.update({"status": "running", "started_at": _now(), "run_url": run_url},
                      only_if_status=("queued", "dispatched")):
        print(f"job {args.job_id} ({kind}): not claimable, status={row.get('status')}")
        return 0
    print(f"job {args.job_id} ({kind}): running on {args.runner}")

    handler = KINDS.get(kind)
    try:
        if handler is None:
            raise ValueError(f"Unknown job kind {kind!r}")
        result = handler(job, row.get("params") or {}, args.runner)
        job.update({"status": "done", "result": result, "finished_at": _now(),
                    "progress": {"pct": 100, "message": "Done"}})
        print(f"job {args.job_id} ({kind}): done")
        return 0
    except Exception as exc:  # noqa: BLE001 — reported in the row, never in the log
        detail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
        try:
            job.update({"status": "failed", "message": detail[:2000], "finished_at": _now()})
        except Exception:
            pass
        print(f"job {args.job_id} ({kind}): failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
