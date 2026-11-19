"""The Report's six-sheet data export, as a background job.

`views/report.py`'s "📥 Export Data" button: Summary, Scan logs, RFPs, Meeting logs,
Engagement logs, Applied Funding. The workbook holds the ROWS the report's figures are
computed from, so it is the audit trail behind the charts rather than a second copy of them.

It is a job rather than an API response because the workbook is written with `openpyxl`
over every row in the period — well past an Edge Function's 2s CPU budget on a tenant with
a few thousand scan runs. `scripts/run_web_job.py` dispatches to `run()` here.

THE FIVE QUERIES ARE THE PAGE'S, transcribed from `_load_scan_logs`, `_load_rfps`,
`_load_meetings`, `_load_engagements` and `_load_grants`. They cannot be imported — report.py
is a Streamlit script that renders a page on import — so the transcription is held to the
original by `web/scripts/parity/check-export.mjs`, which lifts those five functions out of
the source with `ast` and runs both halves against the live database. Three details a
retype loses, each of which that check would catch:

  * scan_logs' end bound is `lte(end + 1 day)` because `scan_date` is a TIMESTAMP, where
    meeting_logs and engagement_logs take a bare `lte(end)` on a DATE column. The bare bound
    on scan_logs drops the final day's runs.
  * `rfps_added` is coerced but NOT filled with zero. `.fillna(0)` turns "this run never
    recorded a created count" into "this run created nothing", the exact conflation
    migration 094 exists to end — which is why the Summary sheet can say "not recorded".
  * `fetch_all`, never `.limit(n)`. PostgREST caps a response at 1000 rows and says nothing
    about the rest, so an export built on a plain select would ship a third of a tenant's
    scan log and look complete.

THIS MODULE CHOOSES NOTHING ABOUT WHOSE ROWS IT READS. The tenant, whether the shared
discovery crawl is included, and the filename all arrive in `params`, settled by
`POST /report/export` from the session — see `supabase/functions/_shared/api/report_export.ts`.
"""
from __future__ import annotations

import io
import json
from datetime import date, datetime, timedelta, timezone
from typing import Any

# `_load_rfps`'s projection, kept verbatim. EVERY MONETARY FIELD HAS ITS OWN CURRENCY
# COLUMN, and both halves of each pair have to be here: an earlier version of this select in
# report.py dropped `currency_secured`, and every secured amount silently became dollars —
# a 200,000 GBP grant exported as 200,000 USD.
RFP_COLUMNS = (
    "uid,source,opportunity_title,brief_description,funding_agency,"
    "submitted_at,search_date,"
    "submitted_by,submitted_by_email,"
    "call_submission_deadline,date_completed,decision_date,date_of_approval,"
    "decision,auto_recommendation,donor_decision,progress_status,stage,"
    "alignment_score,call_award_value,currency,"
    "amount_requested,amount_secured,currency_secured,submissions,"
    "call_geographic_scope,call_domain_areas,decision_overridden_by,"
    "proposal_lead,contributors,reviewers,"
    "lead_applicant,sub_applicant,"
    "is_duplicate,review_week,applicant_role"
)

SHEET_ORDER = ["Summary", "Scan logs", "RFPs", "Meeting logs", "Engagement logs", "Applied Funding"]

_DT_KW: dict[str, Any] = dict(errors="coerce", format="ISO8601")


# ── The frames ───────────────────────────────────────────────────────────────
# Split out one per sheet so the parity check can compare them one at a time: a single
# build() returning everything would report "the export differs" and leave the reader to
# find out which of five queries drifted.

def load_scans(sb, start_iso: str | None, end_iso: str | None,
               tenant_id: str | None, unfiltered: bool):
    import pandas as pd
    from core.records import clean_df
    from db.supabase_client import fetch_all

    def _q():
        q = sb.table("scan_logs").select("*")
        if start_iso:
            q = q.gte("scan_date", start_iso)
        if end_iso:
            # +1 DAY, unlike the two date columns below — scan_date is a timestamp.
            q = q.lte("scan_date", (date.fromisoformat(end_iso) + timedelta(days=1)).isoformat())
        return q

    df = clean_df(pd.DataFrame(fetch_all(_q)))
    if df.empty:
        return df
    df["scan_date"] = pd.to_datetime(df["scan_date"], **_DT_KW)
    for c in ("rfps_found", "rfps_new", "rfps_duplicate", "rfps_rejected"):
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0).astype(int)
    if "rfps_added" in df.columns:
        df["rfps_added"] = pd.to_numeric(df["rfps_added"], errors="coerce")
    # Filter to the tenant, unless the API said this caller sees the log unfiltered — a
    # super_user, or a deployment with no tenants. Unfiltered is genuinely EVERYTHING: the
    # untenanted discovery crawl AND other tenants' runs, which is what report.py does for a
    # super_user and what check-export.mjs pins. A client cannot ask for the wider set.
    if tenant_id and not unfiltered and "tenant_id" in df.columns:
        df = df[df["tenant_id"].astype(str) == str(tenant_id)]
    return df


def load_rfps(sb):
    import pandas as pd
    from core.records import clean_df
    from db.supabase_client import fetch_all

    df = clean_df(pd.DataFrame(fetch_all(
        lambda: sb.table("rfp_submissions").select(RFP_COLUMNS), order="uid")))
    if df.empty:
        return df
    for c in ("submitted_at", "search_date"):
        if c in df.columns:
            df[c] = pd.to_datetime(df[c], **_DT_KW)
    for c in ("call_submission_deadline", "date_completed", "decision_date", "date_of_approval"):
        if c in df.columns:
            df[c] = pd.to_datetime(df[c], **_DT_KW).dt.date
    df["is_duplicate"] = df.get("is_duplicate", False).fillna(False)
    return df


def load_meetings(sb, start_iso: str | None, end_iso: str | None):
    import pandas as pd
    df = _range_frame(sb, "meeting_logs", "meeting_date", start_iso, end_iso)
    if not df.empty and "meeting_date" in df.columns:
        df["meeting_date"] = pd.to_datetime(df["meeting_date"], **_DT_KW)
        df["is_resolved"] = df.get("is_resolved", False).fillna(False)
    return df


def load_engagements(sb, start_iso: str | None, end_iso: str | None):
    import pandas as pd
    df = _range_frame(sb, "engagement_logs", "engagement_date", start_iso, end_iso)
    if not df.empty and "engagement_date" in df.columns:
        df["engagement_date"] = pd.to_datetime(df["engagement_date"], **_DT_KW)
    return df


def load_grants(sb):
    import pandas as pd
    from core.records import clean_df
    from db.supabase_client import fetch_all

    df = clean_df(pd.DataFrame(fetch_all(lambda: sb.table("applied_funding").select("*"))))
    if df.empty:
        return df
    for c in ("award_date", "end_date", "submitted_date", "report_due_date"):
        if c in df.columns:
            df[c] = pd.to_datetime(df[c], **_DT_KW).dt.date
    return df


def _range_frame(sb, table: str, col: str, start_iso: str | None, end_iso: str | None):
    """A whole-day range on a DATE column — `lte(end)`, with no +1. Both columns this is
    used for are dates, so the day is whole; if either becomes a timestamp, this bound
    starts dropping the final day."""
    import pandas as pd
    from core.records import clean_df
    from db.supabase_client import fetch_all

    def _q():
        q = sb.table(table).select("*")
        if start_iso:
            q = q.gte(col, start_iso)
        if end_iso:
            q = q.lte(col, end_iso)
        return q

    return clean_df(pd.DataFrame(fetch_all(_q)))


def discovered_in_period(rfps, start_iso: str | None, end_iso: str | None):
    """The page's `_discovered_in_period` filter for the RFPs sheet.

    A row was FOUND inside the window, by `search_date` where it has one and `submitted_at`
    otherwise. ROWS WITH NEITHER ARE KEPT: the Excel-migrated rows carry no find date at
    all, and dropping them would make a period export differ from an all-time one by the
    whole pre-migration pipeline — the same reason Section 3's funnel is all-time.
    """
    import pandas as pd
    if not start_iso or rfps is None or rfps.empty:
        return rfps
    disc = rfps["search_date"] if "search_date" in rfps.columns else pd.Series(pd.NaT, index=rfps.index)
    if "submitted_at" in rfps.columns:
        disc = disc.fillna(rfps["submitted_at"])
    day = pd.to_datetime(disc, errors="coerce").dt.date
    lo = date.fromisoformat(start_iso)
    hi = date.fromisoformat(end_iso) if end_iso else None
    keep = day.isna() | ((day >= lo) & ((day <= hi) if hi else True))
    return rfps[keep]


# ── Writing it out ───────────────────────────────────────────────────────────

def excel_cell_value(v):
    """One cell: lists and dicts become JSON, primitives pass through."""
    if v is None:
        return None
    if isinstance(v, (list, tuple, set)):
        try:
            return json.dumps(list(v), default=str, ensure_ascii=False)
        except (TypeError, ValueError):
            return ", ".join(str(x) for x in v)
    if isinstance(v, dict):
        try:
            return json.dumps(v, default=str, ensure_ascii=False)
        except (TypeError, ValueError):
            return str(v)
    return v


def safe_for_excel(df):
    """`views/report.py::_safe_for_excel` — make a frame writable by openpyxl.

    Excel cannot store a timezone-aware datetime (pandas raises), inf (openpyxl raises), or
    a list/dict (which is what a Postgres array column round-trips as). All three occur
    here: `timestamptz` columns are most of these rows, and call_geographic_scope and
    call_domain_areas are arrays.
    """
    import numpy as np
    import pandas as pd
    if df is None or df.empty:
        return df
    out = df.copy()
    for col in out.columns:
        s = out[col]
        if pd.api.types.is_datetime64_any_dtype(s) and getattr(s.dt, "tz", None) is not None:
            out[col] = s.dt.tz_localize(None)
    num_cols = out.select_dtypes(include=["float", "int"]).columns
    if len(num_cols):
        out[num_cols] = out[num_cols].replace([np.inf, -np.inf], np.nan)
    for col in out.select_dtypes(include="object").columns:
        out[col] = out[col].apply(excel_cell_value)
    return out


def summary_rows(params: dict, scans, rfps_period, meetings, engagements, grants,
                 start_iso: str | None, end_iso: str | None) -> list[tuple[str, Any]]:
    """The Summary sheet — the same top-line figures the Streamlit export writes."""
    n_scans = int(scans["scan_date"].dt.normalize().nunique()) if not scans.empty else 0
    col = (lambda c: int(scans[c].sum()) if (not scans.empty and c in scans.columns) else 0)
    # "not recorded" rather than 0: a run that never wrote a created count is not a run that
    # created nothing, and the Summary is the one place that distinction is visible.
    added: Any = "not recorded"
    if not scans.empty and "rfps_added" in scans and not scans["rfps_added"].dropna().empty:
        added = int(scans["rfps_added"].dropna().sum())
    unique_rfps = (int(len(rfps_period[~rfps_period["is_duplicate"]]))
                   if (rfps_period is not None and not rfps_period.empty) else 0)
    return [
        ("Period", f"{params.get('period_label') or params.get('period') or ''} "
                   f"({start_iso or 'the beginning'} to {end_iso or 'today'})"),
        ("View by", str(params.get("view") or "")),
        ("Report generated", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")),
        ("Exported by", str(params.get("by") or "")),
        ("", ""),
        ("Scan runs", n_scans),
        ("RFPs found (scans)", col("rfps_found")),
        ("Eligible (admitted)", col("rfps_new")),
        ("Added to pipeline", added),
        ("Duplicates filtered", col("rfps_duplicate")),
        ("Rejected at gate", col("rfps_rejected")),
        ("Unique RFPs (period)", unique_rfps),
        ("Meeting items", int(len(meetings)) if meetings is not None else 0),
        ("Engagement entries", int(len(engagements)) if engagements is not None else 0),
        ("Applied Funding", int(len(grants)) if grants is not None else 0),
        ("", ""),
        ("FX policy",
         "The report converts monetary values row by row to USD, using the FX rates in "
         "Admin -> Settings (fallback: config/dropdowns.yaml); a row with no currency is "
         "treated as USD. THIS WORKBOOK HOLDS THE ORIGINAL AMOUNTS AND CURRENCIES, not the "
         "converted ones, so a total taken from these columns will not match the report "
         "unless every row is already in dollars."),
    ]


def workbook_bytes(params: dict, frames: dict) -> tuple[bytes, dict]:
    """The .xlsx, and how many rows went on each sheet.

    An empty frame is SKIPPED rather than written as a bare header row, which is what the
    Streamlit export does — so the sheet list in the result says what the period actually
    held, and a workbook with no "Meeting logs" tab means there were none.
    """
    import pandas as pd
    buf = io.BytesIO()
    sheets: dict[str, int] = {}
    rows = summary_rows(params, frames["scans"], frames["rfps_period"], frames["meetings"],
                        frames["engagements"], frames["grants"],
                        params.get("start"), params.get("end"))
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        pd.DataFrame(rows, columns=["Metric", "Value"]).to_excel(
            writer, sheet_name="Summary", index=False)
        sheets["Summary"] = len(rows)
        for name, key in (("Scan logs", "scans"), ("RFPs", "rfps_period"),
                          ("Meeting logs", "meetings"), ("Engagement logs", "engagements"),
                          ("Applied Funding", "grants")):
            frame = frames.get(key)
            if frame is None or frame.empty:
                continue
            # The page's private columns (`_disc_ts`, `_discovered_in_period`) are workings,
            # not data, and are dropped exactly as the Streamlit export drops them.
            out = frame.drop(columns=[c for c in frame.columns if str(c).startswith("_")],
                             errors="ignore")
            safe_for_excel(out).to_excel(writer, sheet_name=name, index=False)
            sheets[name] = int(len(out))
    return buf.getvalue(), sheets


# ── The job ──────────────────────────────────────────────────────────────────

def run(job, params: dict, runner: str) -> dict:
    """Build the workbook, put it in the private bucket, return a signed URL."""
    from auth.tenant_context import reset_tenant_override, set_tenant_override
    from core import export_store
    from db.supabase_client import get_client

    row = job.get() or {}
    tenant_id = str(params.get("tenant_id") or row.get("tenant_id") or "").strip()
    start_iso = str(params.get("start") or "").strip() or None
    end_iso = str(params.get("end") or "").strip() or None
    filename = str(params.get("filename") or "RFPIS_report.xlsx")
    unfiltered = bool(params.get("unfiltered_scans"))

    # Every read below goes through the AMBIENT tenant, exactly as the page does. Without
    # the override an export would be built from whichever tenant the runner happened to
    # default to and handed to somebody who asked for their own — a cross-tenant leak with
    # a download link attached. A job with no tenant is a single-tenant deployment, which
    # has none to set.
    token = set_tenant_override(tenant_id) if tenant_id else None
    try:
        sb = get_client()
        job.progress(10, "Reading scan logs")
        scans = load_scans(sb, start_iso, end_iso, tenant_id or None, unfiltered)
        job.progress(30, "Reading calls")
        rfps = load_rfps(sb)
        job.progress(45, "Reading meetings and engagements")
        meetings = load_meetings(sb, start_iso, end_iso)
        engagements = load_engagements(sb, start_iso, end_iso)
        job.progress(55, "Reading applied funding")
        grants = load_grants(sb)

        job.progress(65, "Building the workbook")
        frames = {"scans": scans, "rfps_period": discovered_in_period(rfps, start_iso, end_iso),
                  "meetings": meetings, "engagements": engagements, "grants": grants}
        data, sheets = workbook_bytes(params, frames)

        job.progress(85, "Uploading")
        export_store.ensure_bucket()
        folder = tenant_id or "shared"
        pruned = export_store.prune(folder)
        path = f"{folder}/{job.id}/{filename}"
        export_store.put(path, data)
        url = export_store.signed_url(path, download_as=filename)

        job.progress(100, "Ready")
        # The URL is a bearer capability for one object and it goes in the job row, which
        # the API serves only to whoever started the job, an admin of their tenant, or a
        # super_user. It expires on its own; nothing has to revoke it.
        return {"url": url, "filename": filename, "bytes": len(data),
                "expiresInS": export_store.SIGNED_URL_TTL_S, "sheets": sheets,
                "pruned": pruned, "runner": runner}
    finally:
        if token is not None:
            reset_tenant_override(token)
