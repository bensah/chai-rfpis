"""Python half of check-scoring.mjs: app_pages/home.py's counters, per tenant.

A copy of the `_kpis` body — the page itself is a Streamlit script that cannot be imported
without rendering. Keep the two in step: if home.py's arithmetic changes, change it here and
the TypeScript will fail the check until it is changed too. Read-only.
"""
import json
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from core.dotenv_compat import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

import pandas as pd                          # noqa: E402

from auth import tenant_context as tc        # noqa: E402
from core.records import clean_df            # noqa: E402
from db.supabase_client import get_client, service_client  # noqa: E402

FIELDS = ("uid,decision,donor_decision,progress_status,"
          "call_submission_deadline,is_duplicate")


def kpis() -> dict:
    rfps = get_client().table("rfp_submissions").select(FIELDS).execute().data or []
    today = date.today()
    in_two_weeks = today + timedelta(days=14)

    def _to_date(v):
        if v is None:
            return None
        try:
            if pd.isna(v):
                return None
        except (TypeError, ValueError):
            pass
        try:
            ts = pd.to_datetime(v, errors="coerce")
            return None if pd.isna(ts) else ts.date()
        except Exception:
            return None

    df = clean_df(pd.DataFrame(rfps))
    total_submissions = int(len(df))
    if not df.empty:
        dup_count = int(df["is_duplicate"].fillna(False).sum())
        unique = df[~df["is_duplicate"].fillna(False)].copy()
        unique["_d"] = unique["call_submission_deadline"].apply(_to_date)
        dec_lower = unique["decision"].fillna("").astype(str).str.strip().str.lower()
        total_unique = int(len(unique))
        proceed = int(dec_lower.str.startswith("proceed").sum())
        park = int(dec_lower.eq("park").sum())
        decline = int(dec_lower.eq("decline").sum())
        proceed_df = unique[dec_lower.str.startswith("proceed").to_numpy()]
        overdue = int(proceed_df["_d"].apply(lambda d: d is not None and d < today).sum())
        due_soon = int(proceed_df["_d"].apply(
            lambda d: d is not None and today <= d <= in_two_weeks).sum())
        ps_lower = unique["progress_status"].fillna("").astype(str).str.strip().str.lower()
        submitted_count = int(ps_lower.eq("completed").sum())
        dd_lower = unique["donor_decision"].fillna("").astype(str).str.strip().str.lower()
        awarded_grants = int(dd_lower.eq("approved").sum())
    else:
        dup_count = total_unique = proceed = park = decline = overdue = due_soon = 0
        submitted_count = awarded_grants = 0

    return {"total_unique": total_unique, "total_found": total_submissions,
            "duplicates": dup_count, "proceed": proceed, "park": park, "decline": decline,
            "overdue": overdue, "due_soon": due_soon, "submitted": submitted_count,
            "awarded_grants": awarded_grants}


out = {}
for t in (service_client().table("tenants").select("id").eq("status", "active")
          .execute().data or []):
    tid = str(t["id"])
    tok = tc.set_tenant_override(tid)
    try:
        out[tid] = kpis()
    finally:
        tc.reset_tenant_override(tok)
sys.stdout.write(json.dumps(out))
