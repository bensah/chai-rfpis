"""The Python half of the Report Section 2 parity check (section id 4, displayed 2nd).

Same two-halves arrangement as section1_py.py, and the same honest limit:

  * LIFTED / IMPORTED — `_bucketed_count` and `_submitted_mask` come out of views/report.py
    itself; `core.partner_names`, `core.member_names` and `core.settings` are imported. These
    are the parts a re-implementation plausibly gets wrong.
  * TRANSCRIBED — the groupby/stack arithmetic, with report.py's line ranges quoted beside
    each block so the two can be diffed by eye.

The rows are not fetched here. The Node side sends the ones it read, so both halves see
byte-identical input.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import re                                                        # noqa: E402
from core import partner_names                                   # noqa: E402
from core.member_names import first_name_display_map, split_and_normalize_names  # noqa: E402
from core.records import clean_df                                # noqa: E402

from report_py import NS                                         # noqa: E402

_DT_KW = dict(errors="coerce", format="ISO8601")


def _frame(rows: list[dict], date_cols: tuple[str, ...] = ()) -> pd.DataFrame:
    df = clean_df(pd.DataFrame(rows))
    if df.empty:
        return df
    for c in date_cols:
        if c in df.columns:
            df[c] = pd.to_datetime(df[c], **_DT_KW)
    return df


# ── The blocks, quoting the report.py lines they mirror ─────────────────────

def _meetings(meetings: pd.DataFrame) -> dict:
    """report.py 2188-2206 — logged / open / resolved / % unresolved."""
    total = int(len(meetings))
    resolved = int(meetings["is_resolved"].fillna(False).astype(bool).sum()) if not meetings.empty else 0
    open_ = total - resolved
    return {"logged": total, "open": open_, "resolved": resolved,
            "pctUnresolved": (open_ / total * 100) if total > 0 else 0.0}


def _donors(eng: pd.DataFrame) -> dict:
    """report.py 2210-2229 — count, distinct donors, depth, tied to an RFP."""
    n = int(len(eng))
    donors = int(eng["donor"].nunique()) if (not eng.empty and "donor" in eng.columns) else 0
    tied = int(eng["linked_rfp_uid"].notna().sum()) if (not eng.empty and "linked_rfp_uid" in eng.columns) else 0
    return {"engagements": n, "donors": donors,
            "avgPerDonor": (n / donors) if donors > 0 else 0.0, "tiedToRfp": tied}


def _engagement_series(eng: pd.DataFrame) -> list[dict]:
    """report.py 2231-2238 — _bucketed_count over engagement_date."""
    if eng.empty or "engagement_date" not in eng.columns or not eng["engagement_date"].notna().any():
        return []
    df = NS["_bucketed_count"](eng["engagement_date"].dropna(), "count")
    return [{"bucket": pd.Timestamp(r["bucket"]).date().isoformat(), "count": int(r["count"])}
            for _, r in df.iterrows()]


def _top_donors(eng: pd.DataFrame) -> dict:
    """report.py 2240-2250 — top 10 by touchpoints, types joined and cut to 80 chars."""
    if eng.empty or "donor" not in eng.columns:
        return {"all": {}, "top": []}
    grouped = (eng.groupby("donor")
               .agg(touchpoints=("engagement_date", "count"),
                    types=("engagement_type",
                           lambda x: ", ".join(sorted(set(filter(None, x))))[:80]))
               .reset_index())
    top = grouped.sort_values("touchpoints", ascending=False).head(10)
    row = lambda r: {"donor": str(r["donor"]), "touchpoints": int(r["touchpoints"]),
                     "types": str(r["types"])}
    return {"all": {str(r["donor"]): row(r) for _, r in grouped.iterrows()},
            "top": [row(r) for _, r in top.iterrows()]}


def _people_stack(activity: pd.DataFrame, col: str) -> dict:
    """report.py 2282-2325 and 2336-2352 — per-RFP dedupe, display map, top 15 by total,
    both stack halves forced to exist."""
    if activity.empty or col not in activity.columns:
        return {"all": {}, "top": []}
    rows = activity[[col, "progress_status", "donor_decision"]].copy()
    rows["is_submitted"] = NS["_submitted_mask"](rows).to_numpy()
    rows["_members"] = rows[col].apply(lambda v: sorted(set(split_and_normalize_names(v))))
    rows = rows.explode("_members").dropna(subset=["_members"])
    rows = rows[rows["_members"] != ""]
    if rows.empty:
        return {"all": {}, "top": []}
    disp = first_name_display_map(rows["_members"])
    rows = rows.assign(display=rows["_members"].map(disp).fillna(rows["_members"]))
    agg = (rows.assign(Status=rows["is_submitted"].map({True: "Submitted", False: "Unsubmitted"}))
           .groupby(["display", "Status"]).size().reset_index(name="RFPs"))
    totals = agg.groupby("display")["RFPs"].sum().sort_values(ascending=False)
    out_all = {}
    for name, grp in agg.groupby("display"):
        sub = int(grp[grp["Status"] == "Submitted"]["RFPs"].sum())
        uns = int(grp[grp["Status"] == "Unsubmitted"]["RFPs"].sum())
        out_all[str(name)] = {"name": str(name), "submitted": sub, "unsubmitted": uns,
                              "total": sub + uns}
    top = [out_all[str(n)] for n in totals.head(15).index.tolist()]
    return {"all": out_all, "top": top}


def _partners(activity: pd.DataFrame, col: str, org_full: str, org_short: str) -> dict:
    """report.py 2424-2466 — _norm_org / _split_orgs, then value_counts().head(10)."""
    if activity.empty or col not in activity.columns:
        return {"all": {}, "top": []}
    na = partner_names.NA_VALUES
    org_full_key = re.sub(r"\s+", " ", org_full.replace("-", " ")).strip().lower()
    org_first = org_full.split()[0].lower() if org_full else ""

    def norm_org(raw) -> str:
        s = re.sub(r"\s+", " ", str(raw or "").replace("-", " ")).strip()
        if not s or s.strip().lower() in na:
            return ""
        low = partner_names.strip_trailing_acronym(s).lower()
        if org_short and low == org_short.lower():
            return org_full or s
        if org_full and low == org_full_key:
            return org_full
        if org_first and low == org_first:
            return org_full
        return s

    def split_orgs(v) -> list[str]:
        return sorted({o for o in (norm_org(p) for p in partner_names.split_pieces(v)) if o})

    rows = activity[[col]].copy()
    rows["_orgs"] = rows[col].apply(split_orgs)
    rows = rows.explode("_orgs").dropna(subset=["_orgs"])
    rows = rows[rows["_orgs"].astype(str).str.strip() != ""]
    if rows.empty:
        return {"all": {}, "top": []}
    counts = rows["_orgs"].value_counts()
    return {"all": {str(k): int(v) for k, v in counts.items()},
            "top": [{"org": str(k), "rfps": int(v)} for k, v in counts.head(10).items()]}


def _one(rfps: pd.DataFrame, case: dict) -> dict:
    from datetime import date as _date
    NS["bucket_mode"] = case["view"]
    NS["_start"] = _date.fromisoformat(case["bounds"]["start"]) if case["bounds"]["start"] else None
    NS["_end"] = _date.fromisoformat(case["bounds"]["end"]) if case["bounds"]["end"] else None

    meetings = _frame(case["meetings"], ("meeting_date",))
    eng = _frame(case["engagements"], ("engagement_date",))

    # report.py 2268-2271. NOTE: no .strip() before .lower(), unlike Section 1's Proceed
    # filter. Transcribed exactly, including the inconsistency.
    if rfps.empty:
        activity = rfps
    else:
        ded = rfps[~rfps["is_duplicate"]]
        activity = ded[ded["decision"].fillna("").str.lower().str.startswith("proceed")].copy()

    return {
        "meetings": _meetings(meetings),
        "donors": _donors(eng),
        "engagements": _engagement_series(eng),
        "topDonors": _top_donors(eng),
        "leads": _people_stack(activity, "proposal_lead"),
        "contributors": _people_stack(activity, "contributors"),
        "partners": {
            "lead": _partners(activity, "lead_applicant", case["org"]["full"], case["org"]["short"]),
            "sub": _partners(activity, "sub_applicant", case["org"]["full"], case["org"]["short"]),
        },
        "proceedRows": int(len(activity)),
    }


def main() -> None:
    payload = json.loads(sys.stdin.read())
    rfps = _frame(payload["rfps"])
    if not rfps.empty:
        rfps["is_duplicate"] = rfps.get("is_duplicate", False).fillna(False)
    print(json.dumps([_one(rfps, c) for c in payload["cases"]], ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
