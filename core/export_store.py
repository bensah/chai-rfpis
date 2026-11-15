"""Where a generated export file lives until somebody downloads it.

A Supabase Storage bucket, PRIVATE, reached over the storage REST API with the service
key. The browser never gets the key: it gets a short-lived signed URL, which is a bearer
capability for one object and expires.

WHY NOT THE JOB ROW. The obvious thing is to put the bytes in `web_jobs.result`, which is
already the channel the browser polls. A six-sheet workbook of a real tenant is megabytes,
base64 adds a third again, and every poll of that job would then ship the whole file — so
the row holds a URL and the bytes go somewhere a download can stream them from.

WHY PRIVATE. The workbook is every row behind the report: titles, funders, amounts,
decisions, the names of the people who wrote the bids. A public bucket would make that a
URL anyone could guess their way to. Private plus a signed URL means the link stops working
on its own, which matters for a file that gets pasted into chat threads.

Nothing here is a migration: the bucket is created on first use if it is missing, and
creating one changes no table and no row.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

log = logging.getLogger(__name__)

BUCKET = "report-exports"

# An hour. Long enough that a reader who wandered off before the job finished still gets
# their file, short enough that a link pasted into a thread stops working the same day.
SIGNED_URL_TTL_S = 3600

# Exports older than this are deleted when the next one for that tenant is built. Without
# it the bucket grows by one workbook per export for ever, on a free tier with a gigabyte
# in it — and nothing else ever looks at these files, because the signed URL that was the
# only way to reach one expired an hour after it was made.
KEEP_DAYS = 7

_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _base() -> tuple[str, dict]:
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_KEY"]
    return f"{url}/storage/v1", {"apikey": key, "Authorization": f"Bearer {key}"}


def ensure_bucket() -> None:
    """Create the private bucket if it is not there. A 409 means somebody already did."""
    base, headers = _base()
    r = requests.post(f"{base}/bucket", headers={**headers, "Content-Type": "application/json"},
                      json={"id": BUCKET, "name": BUCKET, "public": False}, timeout=30)
    if r.status_code in (200, 201) or r.status_code == 409:
        return
    # "already exists" arrives as a 400 with a message on some versions, so the text is
    # checked before this is called a failure.
    if "exist" in r.text.lower():
        return
    r.raise_for_status()


def prune(folder: str, keep_days: int = KEEP_DAYS) -> int:
    """Delete this folder's exports older than `keep_days`. Returns how many went.

    SCOPED TO ONE FOLDER AND ONE BUCKET, and the bucket is written by nothing but the
    export job, so there is no file here that is not an expired copy of something a reader
    already had the chance to download. A failure to prune is logged and swallowed: an
    export that built correctly must not be reported as failed because the housekeeping
    after it did not.
    """
    base, headers = _base()
    try:
        r = requests.post(f"{base}/object/list/{BUCKET}",
                          headers={**headers, "Content-Type": "application/json"},
                          json={"prefix": folder, "limit": 1000,
                                "sortBy": {"column": "created_at", "order": "asc"}}, timeout=30)
        r.raise_for_status()
        rows = r.json() or []
    except Exception as exc:                                     # noqa: BLE001
        log.warning("export prune: could not list %s (%s)", folder, type(exc).__name__)
        return 0

    cutoff = datetime.now(timezone.utc) - timedelta(days=keep_days)
    stale: list[str] = []
    for row in rows:
        name = str(row.get("name") or "")
        created = str(row.get("created_at") or "")
        if not name or not created:
            continue
        try:
            when = datetime.fromisoformat(created.replace("Z", "+00:00"))
        except ValueError:
            continue
        if when < cutoff:
            stale.append(f"{folder}/{name}")
    if not stale:
        return 0
    try:
        d = requests.delete(f"{base}/object/{BUCKET}",
                            headers={**headers, "Content-Type": "application/json"},
                            json={"prefixes": stale}, timeout=60)
        d.raise_for_status()
        return len(stale)
    except Exception as exc:                                     # noqa: BLE001
        log.warning("export prune: could not delete %d old files (%s)", len(stale), type(exc).__name__)
        return 0


def put(path: str, data: bytes, content_type: str = _XLSX) -> None:
    """Upload, replacing anything already at `path`."""
    base, headers = _base()
    r = requests.post(
        f"{base}/object/{BUCKET}/{path}",
        headers={**headers, "Content-Type": content_type, "x-upsert": "true",
                 "cache-control": "no-store"},
        data=data, timeout=180,
    )
    r.raise_for_status()


def signed_url(path: str, ttl_s: int = SIGNED_URL_TTL_S, download_as: str | None = None) -> str:
    """A time-limited URL for one object.

    `download_as` sets the name the browser saves it under. Without it the file downloads
    as the last segment of the storage path, which is a job id — so the reader ends up with
    a .xlsx named after a uuid and no way to tell two exports apart.
    """
    base, headers = _base()
    body: dict[str, Any] = {"expiresIn": int(ttl_s)}
    r = requests.post(f"{base}/object/sign/{BUCKET}/{path}",
                      headers={**headers, "Content-Type": "application/json"},
                      json=body, timeout=30)
    r.raise_for_status()
    signed = str((r.json() or {}).get("signedURL") or "")
    if not signed:
        raise RuntimeError("storage returned no signed URL")
    url = f"{base}{signed}" if signed.startswith("/") else signed
    if download_as:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}download={requests.utils.quote(download_as)}"
    return url
