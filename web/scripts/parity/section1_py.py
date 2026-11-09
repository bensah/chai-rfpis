"""The Python half of the Report Section 1 parity check.

WHAT THIS IS, AND WHAT IT IS NOT — read this before trusting a green run.

The period helpers could be LIFTED out of views/report.py by AST (see report_py.py), because
they are functions. Section 1's blocks are not: they are inline in the Streamlit script,
interleaved with `st.columns`, `px.bar` and the PDF hook, so there is no way to call them
without rendering a page and a database session.

So this harness is in two halves, and they carry different weight:

  * LIFTED / IMPORTED — the real code, byte for byte. `_bucket_start`, `_bucketed_count`,
    `_in_period`, `_submitted_mask`, `_programme_area_freq`, `_discovery_ts` come out of
    report.py itself; `funder_names`, `member_names` and `keyword_cloud` are imported. These
    are the parts where a re-implementation plausibly goes wrong, and they are pinned to the
    real thing.

  * TRANSCRIBED — the groupby/sum arithmetic around them. Each block below quotes the
    report.py line range it mirrors so the two can be diffed by eye. A mistake HERE would be
    a mistake in both this file and the TypeScript only if I made the same one twice, which
    is possible and is the honest limit of this check.

The rows are not fetched here. The Node side sends the ones it read, so both halves see
byte-identical input and "different data" cannot be mistaken for "different logic".

    python section1_py.py           payload as JSON on stdin, results as JSON on stdout
"""
from __future__ import annotations

import json
import sys
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

from core.records import clean_df                        # noqa: E402
from core import keyword_cloud, member_names             # noqa: E402
from core.funder_names import dominant_spelling, funder_key   # noqa: E402
from core.member_names import first_name_display_map, split_and_normalize_names  # noqa: E402

from report_py import NS   # the helpers lifted out of views/report.py  # noqa: E402

_DT_KW = dict(errors="coerce", format="ISO8601")


def _rfps_frame(rows: list[dict]) -> pd.DataFrame:
    """`_load_rfps`'s coercion, lines 526-559."""
    df = clean_df(pd.DataFrame(rows))
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


def _scans_frame(rows: list[dict]) -> pd.DataFrame:
    """`_load_scan_logs`'s coercion, lines 488-520. Note rfps_added is NOT fillna(0)."""
    df = clean_df(pd.DataFrame(rows))
    if df.empty:
        return df
    df["scan_date"] = pd.to_datetime(df["scan_date"], **_DT_KW)
    for c in ("rfps_found", "rfps_new", "rfps_duplicate", "rfps_rejected"):
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0).astype(int)
    if "rfps_added" in df.columns:
        df["rfps_added"] = pd.to_numeric(df["rfps_added"], errors="coerce")
    return df


# ── The blocks, each quoting the report.py lines it mirrors ──────────────────

def _intake(rfps: pd.DataFrame) -> dict:
    """report.py 1697-1712 — ALL-TIME, grouped on the LOWERCASED source."""
    labels = {"auto": "System eligibility auto-scan", "migration": "Excel imported",
              "manual": "Manually submitted via platform"}
    src = rfps["source"].fillna("(unknown)").astype(str).str.strip()
    dup = rfps["is_duplicate"].astype(bool)
    by = (pd.DataFrame({"src": src.str.lower(), "dup": dup})
          .groupby("src").agg(total=("dup", "size"), dups=("dup", "sum")))
    by["unique"] = by["total"] - by["dups"]
    by = by.sort_values("total", ascending=False)
    return {
        "total": int(by["total"].sum()),
        "duplicates": int(by["dups"].sum()),
        "bySource": [{"source": str(k), "label": labels.get(str(k), str(k).title()),
                      "unique": int(r["unique"]), "duplicates": int(r["dups"]),
                      "total": int(r["total"])}
                     for k, r in by.iterrows()],
    }


def _scan_kpis(scans: pd.DataFrame) -> dict | None:
    """report.py 1740-1755 — the seven tiles. `added` is None, not 0, when unrecorded."""
    if scans.empty:
        return None
    added_col = scans.get("rfps_added", pd.Series(dtype="float64"))
    n_added = (int(added_col.dropna().sum())
               if hasattr(added_col, "dropna") and not added_col.dropna().empty else None)
    return {
        "runs": int(scans["scan_date"].dt.normalize().nunique()),
        "found": int(scans["rfps_found"].sum()),
        "eligible": int(scans["rfps_new"].sum()),
        "added": n_added,
        "duplicates": int(scans["rfps_duplicate"].sum()),
        "rejected": int(scans.get("rfps_rejected", pd.Series(dtype=int)).sum()),
        "errorRuns": int((scans.get("errors", pd.Series(dtype=str)).fillna("") != "").sum()),
    }


def _discovery(disc: pd.DataFrame, view: str) -> dict:
    """report.py 1796-1865 — stacked by submitter, with the plain bucketed fallback.

    The stacked frame is a groupby with NO reindex, so an empty bucket is absent; the
    fallback goes through `_bucketed_count`, which DOES reindex. Both kept as they are.
    """
    if disc.empty or not disc["search_date"].notna().any():
        return {"buckets": [], "submitters": [], "zeroFilled": False}
    with_members = disc.assign(
        _members=disc["submitted_by"].apply(split_and_normalize_names),
        bucket=NS["_bucket_start"](disc["search_date"], view),
    )
    exp = with_members.explode("_members").dropna(subset=["_members"])
    exp = exp[exp["_members"] != ""]
    if not exp.empty:
        disp = first_name_display_map(exp["_members"])
        exp = exp.assign(submitter=exp["_members"].map(disp).fillna(exp["_members"]))
        stacked = exp.groupby(["bucket", "submitter"]).size().reset_index(name="n")
        buckets = []
        for b, grp in stacked.groupby("bucket"):
            buckets.append({
                "bucket": pd.Timestamp(b).date().isoformat(),
                "total": int(grp["n"].sum()),
                "bySubmitter": {str(k): int(v) for k, v in
                                sorted(zip(grp["submitter"], grp["n"]), key=lambda kv: kv[0])},
            })
        buckets.sort(key=lambda x: x["bucket"])
        return {"buckets": buckets,
                "submitters": sorted({str(x) for x in exp["submitter"]}),
                "zeroFilled": False}
    df = NS["_bucketed_count"](disc["search_date"].dropna(), "n")
    return {
        "buckets": [{"bucket": pd.Timestamp(r["bucket"]).date().isoformat(),
                     "total": int(r["n"]), "bySubmitter": {}}
                    for _, r in df.iterrows()],
        "submitters": [], "zeroFilled": True,
    }


def _donors(disc: pd.DataFrame) -> dict:
    """report.py 1870-1890 — grouped by funder IDENTITY, labelled by dominant spelling."""
    if disc.empty:
        return {"all": {}, "top": []}
    raw = (disc["funding_agency"].fillna("(unspecified)")
           .replace("", "(unspecified)").astype(str))
    grouped = pd.DataFrame({"raw": raw, "key": raw.map(funder_key)}).groupby("key")["raw"]
    full = pd.DataFrame({"donor": grouped.agg(dominant_spelling), "rfps": grouped.size()})
    counts = full.sort_values("rfps", ascending=False).head(15).reset_index(drop=True)
    return {
        # The COMPLETE grouping, order-free. This is where the real logic is: funder
        # identity and dominant spelling. Compared exactly.
        "all": {str(r["donor"]): int(r["rfps"]) for _, r in full.iterrows()},
        # The chart as report.py cuts it. Its tie ORDER is a numpy quicksort artefact —
        # see check-section1.mjs — so the harness compares the counts, not the order.
        "top": [{"donor": str(r["donor"]), "rfps": int(r["rfps"])} for _, r in counts.iterrows()],
    }


def _keyword_success(disc: pd.DataFrame) -> list[dict]:
    """report.py 2002-2053 — PRESENCE per call, sorted Approved→Submitted→Proceed→Hits."""
    if disc.empty:
        return []
    rows = []
    for _, r in disc.iterrows():
        text = " ".join([str(r.get("opportunity_title") or ""),
                         str(r.get("brief_description") or "")])
        if not text.strip():
            continue
        stems = set(keyword_cloud.extract_keyword_frequencies([text]).keys())
        if not stems:
            continue
        dec = str(r.get("decision") or "").lower()
        prog = str(r.get("progress_status") or "").lower()
        don = str(r.get("donor_decision") or "").lower()
        for kw in stems:
            rows.append({"keyword": kw,
                         "is_proceed": dec.startswith("proceed"),
                         "is_submitted": (prog == "completed"
                                          or don in {"approved", "under review", "not approved"}),
                         "is_approved": don == "approved"})
    if not rows:
        return []
    kw_df = pd.DataFrame(rows)
    agg = (kw_df.groupby("keyword").agg(
        hits=("keyword", "count"), proceed=("is_proceed", "sum"),
        submitted=("is_submitted", "sum"), approved=("is_approved", "sum"))
        .reset_index()
        .sort_values(["approved", "submitted", "proceed", "hits"],
                     ascending=[False, False, False, False]).head(50))
    return [{"keyword": str(r["keyword"]), "hits": int(r["hits"]), "proceed": int(r["proceed"]),
             "submitted": int(r["submitted"]), "approved": int(r["approved"])}
            for _, r in agg.iterrows()]


def _sources(scans: pd.DataFrame) -> dict:
    """report.py 2081-2097 — top 15 by new-call yield, with the replace(0, 1) guard."""
    if scans.empty or "source" not in scans.columns:
        return {"all": {}, "top": []}
    src = (scans.groupby("source")
           .agg(runs=("scan_date", "count"), found=("rfps_found", "sum"),
                new=("rfps_new", "sum"), rejected=("rfps_rejected", "sum"),
                avg_dur=("duration_sec", "mean"))
           .reset_index())
    full = src.copy()
    src = src.sort_values("new", ascending=False).head(15)
    for frame in (full, src):
        frame["avg_dur"] = frame["avg_dur"].round(1)
        frame["yield_pct"] = ((frame["new"] / frame["found"].replace(0, 1)) * 100).round(1)
    row = lambda r: {"source": str(r["source"]), "runs": int(r["runs"]), "found": int(r["found"]),
                     "added": int(r["new"]), "rejected": int(r["rejected"]),
                     "avgDur": None if pd.isna(r["avg_dur"]) else float(r["avg_dur"]),
                     "yieldPct": float(r["yield_pct"])}
    return {"all": {str(r["source"]): row(r) for _, r in full.iterrows()},
            "top": [row(r) for _, r in src.iterrows()]}


def _cycle(rfps: pd.DataFrame) -> dict | None:
    """report.py 2113-2127 — ALL-TIME, non-duplicates, negative spans dropped."""
    if rfps.empty:
        return None
    cyc_src = rfps[~rfps["is_duplicate"]].copy()
    cyc = cyc_src.dropna(subset=["search_date", "date_completed"]).copy()
    if cyc.empty:
        return None
    cyc["days"] = cyc.apply(lambda r: (r["date_completed"] - r["search_date"].date()).days, axis=1)
    cyc = cyc[cyc["days"] >= 0]
    if cyc.empty:
        return None
    return {"n": int(len(cyc)), "median": float(cyc["days"].median()),
            "mean": float(cyc["days"].mean()), "min": int(cyc["days"].min()),
            "max": int(cyc["days"].max())}


def _one(rfps: pd.DataFrame, scans: pd.DataFrame, case: dict) -> dict:
    view = case["view"]
    start = case["bounds"]["start"]
    end = case["bounds"]["end"]

    # The module globals the lifted helpers read.
    from datetime import date as _date
    NS["bucket_mode"] = view
    NS["_start"] = _date.fromisoformat(start) if start else None
    NS["_end"] = _date.fromisoformat(end) if end else None

    non_dup = rfps[~rfps["is_duplicate"]] if not rfps.empty else rfps
    if not rfps.empty:
        disc_ts = non_dup.apply(NS["_discovery_ts"], axis=1)
        disc = non_dup[disc_ts.apply(NS["_in_period"])] if NS["_start"] else non_dup
        proceed_all = non_dup[
            non_dup["decision"].fillna("").str.strip().str.lower().str.startswith("proceed")
        ] if "decision" in non_dup.columns else non_dup.iloc[0:0]
    else:
        disc = proceed_all = rfps

    freq = NS["_programme_area_freq"](proceed_all)
    focus = sorted(({"area": k, "calls": int(v)} for k, v in freq.items()),
                   key=lambda x: (-x["calls"], x["area"]))

    return {
        "intake": _intake(rfps) if not rfps.empty else {"total": 0, "duplicates": 0, "bySource": []},
        "scans": _scan_kpis(scans),
        "discovery": _discovery(disc, view),
        "donors": _donors(disc),
        "focusAreas": focus,
        "proceedCount": int(len(proceed_all)),
        "keywordSuccess": _keyword_success(disc),
        "sources": _sources(scans),
        "cycle": _cycle(rfps),
    }


def main() -> None:
    """One payload, many cases. Importing pandas and the core modules costs about four
    seconds; paying it once per period x view combination made the check take three minutes
    and nobody runs a three-minute check."""
    payload = json.loads(sys.stdin.read())
    rfps = _rfps_frame(payload["rfps"])
    out = []
    for case in payload["cases"]:
        out.append(_one(rfps, _scans_frame(case["scans"]), case))
    print(json.dumps(out, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
