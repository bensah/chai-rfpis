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


KINDS: dict[str, Callable[[JobRow, dict, str], dict]] = {
    "ping": _ping,
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
