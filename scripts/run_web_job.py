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
    scoring itself does NOT move: `rescore_existing.evaluate` is the same Python the
    Streamlit app and the scan run. It changes host, not language, so there is still one
    implementation of the rule rather than two that agree until they don't.

    params: {"tenant_id": required, "uid": optional}. With a uid, one row — what a save
    queues. Without, the tenant's whole table — what a profile edit or a schedule queues.

    Prints counts and nothing else: this log is public (the repository is).
    """
    from auth.tenant_context import reset_tenant_override, set_tenant_override
    from core.assessment import assess_row
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
        scored = changed = 0
        for i, row in enumerate(rows):
            # assess_row, NOT rescore_existing.evaluate. Both reach composite_match, but
            # auto_score additionally runs _apply_criteria_keywords over the candidate text
            # and evaluate does not, so the two derive different criteria from the same row:
            # measured on live data, AS-260801-0001393 comes out Park/77 one way and
            # Decline/54.5 the other, and 10-17% of rows change recommendation between them.
            #
            # assess_row is the path every live screen already uses and calls itself the
            # single source of truth for these numbers. Using it here means a server-written
            # score is identical BY CONSTRUCTION to what the screens compute, rather than
            # agreeing only while two derivations are kept in step by hand.
            res = assess_row(dict(row))
            new_score = res.get("alignment_score")
            new_rec = res.get("auto_recommendation")

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

            # Stamp every row, even one whose numbers did not move: "scored, unchanged" and
            # "never scored" are different states and only the stamp tells them apart.
            if write_with_retry(sb, str(row.get("uid")), upd):
                scored += 1
                changed += 1 if moved else 0
            if len(rows) > 20 and i % 25 == 0:
                job.progress(5 + int(90 * i / len(rows)), f"Scored {i} of {len(rows)}")

        job.progress(100, f"Scored {scored}")
        return {"rows": len(rows), "scored": scored, "changed": changed, "runner": runner}
    finally:
        reset_tenant_override(token)


KINDS: dict[str, Callable[[JobRow, dict, str], dict]] = {
    "ping": _ping,
    "rescore": _rescore,
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
