"""The Python half of the export parity check.

Two comparisons, both against `views/report.py`'s own source text:

  1. THE FIVE LOADERS. `scripts/report_export_job.load_*` is a transcription of
     `_load_scan_logs`, `_load_rfps`, `_load_meetings`, `_load_engagements` and
     `_load_grants` — report.py is a Streamlit script that renders a page on import, so the
     job cannot call them. Here they ARE called: lifted out with `ast`, stripped of their
     `@st.cache_data` decorator, and run against the same live database the job's copies
     read, frame for frame.

     That is the whole point. A transcription that is merely reviewed agrees with the
     original until the original changes; one that is executed side by side does not.

  2. `_safe_for_excel` AND `_slug` / `_export_filename`, the same way.

READ ONLY. Nothing here writes a row, builds a workbook or touches the storage bucket.
"""
from __future__ import annotations

import ast
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from core.records import clean_df                       # noqa: E402
from db.supabase_client import fetch_all, get_client    # noqa: E402
from scripts import report_export_job as JOB            # noqa: E402

REPORT_PY = REPO_ROOT / "views" / "report.py"

_WANT = ["_load_scan_logs", "_load_rfps", "_load_meetings", "_load_engagements",
         "_load_grants", "_safe_for_excel", "_excel_cell_value", "_slug"]


def _lift(sb) -> dict:
    """Exec the wanted definitions out of report.py into a namespace of our own.

    The `@st.cache_data(ttl=120)` decorator is DROPPED rather than satisfied: it would
    memoise on `scope`, and two calls in one process would then compare a frame against
    itself. Everything the bodies read from report.py's module scope — `sb`, `fetch_all`,
    `clean_df`, `_DT_KW` — is injected, so the code is the page's and only its surroundings
    are ours.
    """
    tree = ast.parse(REPORT_PY.read_text(encoding="utf-8"))
    ns: dict = {
        "pd": pd, "np": np, "json": json, "date": date, "timedelta": timedelta,
        "sb": sb, "fetch_all": fetch_all, "clean_df": clean_df,
        "_DT_KW": dict(errors="coerce", format="ISO8601"),
        "re": __import__("re"),
        "__builtins__": __builtins__,
    }
    picked: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in _WANT:
            node.decorator_list = []
            picked.append(node)
    missing = set(_WANT) - {n.name for n in picked}
    if missing:
        raise SystemExit(f"views/report.py no longer defines: {sorted(missing)}")
    exec(compile(ast.Module(body=picked, type_ignores=[]), str(REPORT_PY), "exec"), ns)
    return ns


def _describe(df) -> dict:
    """A frame reduced to what a comparison can carry over JSON.

    Columns, dtypes, row count and a hash of the whole thing — rather than the rows
    themselves, which for scan_logs is megabytes and for RFPs is the data the export exists
    to protect. The hash is over the frame rendered as sorted CSV, so column ORDER differing
    is reported by the column list while the contents still compare.
    """
    import hashlib
    if df is None:
        return {"rows": None}
    if getattr(df, "empty", True):
        return {"rows": 0, "cols": sorted(map(str, getattr(df, "columns", [])))}
    cols = sorted(map(str, df.columns))
    body = df[sorted(df.columns, key=str)].astype(str)
    body = body.sort_values(by=list(body.columns), kind="stable")
    digest = hashlib.sha256(body.to_csv(index=False).encode("utf-8")).hexdigest()[:16]
    return {
        "rows": int(len(df)),
        "cols": cols,
        "dtypes": {str(c): str(df[c].dtype) for c in cols},
        "hash": digest,
    }


def main() -> None:
    payload = json.loads(sys.stdin.read())
    tenant_id = payload["tenantId"]
    windows = payload["windows"]

    from auth.tenant_context import reset_tenant_override, set_tenant_override
    token = set_tenant_override(tenant_id)
    try:
        sb = get_client()
        P = _lift(sb)
        out: dict = {"windows": [], "slug": [], "safe": {}}

        for w in windows:
            start, end = w["start"], w["end"]
            # `scope` is report.py's cache key and is unused by the bodies themselves.
            page = {
                "scans": P["_load_scan_logs"]("x", start, end),
                "rfps": P["_load_rfps"]("x"),
                "meetings": P["_load_meetings"]("x", start, end),
                "engagements": P["_load_engagements"]("x", start, end),
                "grants": P["_load_grants"]("x"),
            }
            # unfiltered=False is the ordinary member's view — the one with the tenant
            # filter on it, and so the one where getting it wrong leaks another
            # organisation's scan runs into a downloadable file.
            job = {
                "scans": JOB.load_scans(sb, start, end, tenant_id, False),
                "rfps": JOB.load_rfps(sb),
                "meetings": JOB.load_meetings(sb, start, end),
                "engagements": JOB.load_engagements(sb, start, end),
                "grants": JOB.load_grants(sb),
            }
            entry = {"label": w["label"],
                     "page": {k: _describe(v) for k, v in page.items()},
                     "job": {k: _describe(v) for k, v in job.items()}}
            # The super_user view: NO tenant filter at all. The page applies that rule from
            # Streamlit session state, which does not exist here, so what is asserted on the
            # Node side is the RELATIONSHIP — the wider set is the narrow one plus the
            # untenanted crawl plus every other tenant's runs, and nothing else.
            wide = JOB.load_scans(sb, start, end, tenant_id, True)
            entry["wideScans"] = _describe(wide)
            entry["wideExtra"] = int(len(wide) - len(job["scans"])) if not wide.empty else 0
            if not wide.empty and "tenant_id" in wide.columns:
                tid = wide["tenant_id"].astype(str)
                blank = wide["tenant_id"].isna() | tid.str.strip().eq("") | tid.eq("None")
                entry["untenanted"] = int(blank.sum())
                entry["otherTenants"] = int((~blank & tid.ne(str(tenant_id))).sum())
            else:
                entry["untenanted"] = 0
                entry["otherTenants"] = 0
            # The RFPs sheet's period filter.
            entry["page"]["rfpsPeriod"] = _describe(_page_period(page["rfps"], start, end))
            entry["job"]["rfpsPeriod"] = _describe(JOB.discovered_in_period(page["rfps"], start, end))
            out["windows"].append(entry)

        # `_slug` and the filename, as report.py spells them.
        for case in payload["slugs"]:
            out["slug"].append(P["_slug"](case["text"], case["limit"]))

        # `_safe_for_excel` over a frame built to carry every case it exists for.
        awkward = pd.DataFrame({
            "tz": pd.to_datetime(["2026-01-01T00:00:00+00:00", "2026-06-30T23:59:59+02:00"], utc=True),
            "naive": pd.to_datetime(["2026-01-01", "2026-06-30"]),
            "num": [np.inf, -np.inf],
            "arr": [["a", "b"], []],
            "obj": [{"k": 1}, None],
            "txt": ["Française", ""],
        })
        page_safe = P["_safe_for_excel"](awkward)
        job_safe = JOB.safe_for_excel(awkward)
        out["safe"] = {"page": _describe(page_safe), "job": _describe(job_safe),
                       "pageCells": [str(v) for v in page_safe.to_numpy().ravel()],
                       "jobCells": [str(v) for v in job_safe.to_numpy().ravel()]}
        print(json.dumps(out, ensure_ascii=False, default=str))
    finally:
        reset_tenant_override(token)


def _page_period(rfps, start_iso, end_iso):
    """report.py's `_discovered_in_period`, as the page builds it around line 1139.

    It is not a function there — it is three statements inside the page body
    (`_disc_ts`, then `.apply(_in_period)`) — so this is the one piece that cannot be
    lifted and is written out instead. What it must agree with is `_in_period`, which IS
    lifted and parity-checked by check-report.mjs: both ends inclusive, and a row with no
    date at all kept.
    """
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


if __name__ == "__main__":
    main()
