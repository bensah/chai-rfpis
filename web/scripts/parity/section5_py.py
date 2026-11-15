"""The Python half of the Report Section 5 parity check — Our Results.

Section 5 is the money section: four tiles of dollars, a cumulative curve, a signed
per-call chart and a table. Every one of those passes through `_to_usd`, which reaches
`core.dropdowns.usd_rate` and does a LIVE lookup — so the two halves are given the same
rates, exactly as check-section3 does, and `usd_rate` is answered from them. What is under
test is WHICH CURRENCY COLUMN each figure converts with, which is where this section
actually disagrees with itself.

`_bucketed_sum` is used from report.py rather than transcribed, because the cumulative
curve's reindex-then-cumsum is the part a port gets wrong: dropping a bucket does not just
leave a gap, it removes that money from the running total for every bucket after it.
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

from core import dropdowns                       # noqa: E402
from core.records import clean_df                # noqa: E402
from report_py import NS                         # noqa: E402

_DT_KW = dict(errors="coerce", format="ISO8601")


def _frame(rows: list[dict]) -> pd.DataFrame:
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


def _pin_rates(resolved: dict) -> None:
    """Answer `usd_rate` from the rate the Node side already resolved for that literal cell
    value. The harness holds no lookup logic of its own — see section3_py.py for the bug
    that rule exists to prevent."""
    def usd_rate(currency, *a, **k):
        cur = str(currency or "").strip()
        if not cur or cur.upper() == "USD":
            return 1.0
        return float(resolved.get(cur, 1.0))
    dropdowns.usd_rate = usd_rate
    NS["dropdowns"] = dropdowns


def _one(rfps_all: pd.DataFrame, case: dict) -> dict:
    from datetime import date as _date
    NS["_start"] = _date.fromisoformat(case["bounds"]["start"]) if case["bounds"]["start"] else None
    NS["_end"] = _date.fromisoformat(case["bounds"]["end"]) if case["bounds"]["end"] else None
    NS["bucket_mode"] = case["view"]
    _series_to_usd = NS["_series_to_usd"]

    if rfps_all.empty:
        return {"kpis": {}, "money": {}, "missingCurrency": {}, "conversion": {},
                "outcomes": [], "grants": [], "cumulative": []}

    # report.py 2878-2890
    unique = rfps_all[~rfps_all["is_duplicate"]]
    _dec_l = unique["decision"].fillna("").str.lower()
    proceed_track = unique[_dec_l.str.startswith("proceed")]
    _pc = proceed_track[
        proceed_track["progress_status"].fillna("").str.lower().eq("completed")].copy()
    _subs = (_pc["submissions"].fillna(1).astype(int) if "submissions" in _pc.columns
             else pd.Series(1, index=_pc.index, dtype=int))
    n_submitted = int(_subs.sum())
    approved_period = _pc[_pc["donor_decision"].fillna("").str.lower() == "approved"]
    n_approved = int(len(approved_period))
    win_rate = (n_approved / n_submitted * 100) if n_submitted > 0 else 0.0

    # report.py 2894-2924 — the request converts with currency_secured, the award with it too,
    # and the fallback to `currency` fires only on an EXACTLY blank value.
    usd_view = unique.copy()
    usd_view["req_usd"] = _series_to_usd(
        usd_view["amount_requested"],
        usd_view.get("currency_secured", pd.Series(dtype=str)).fillna("")
        .replace("", pd.NA).fillna(usd_view.get("currency", pd.Series(dtype=str))))
    usd_view["sec_usd"] = _series_to_usd(
        usd_view["amount_secured"], usd_view.get("currency_secured", pd.Series(dtype=str)))
    _ddl = usd_view["donor_decision"].fillna("").str.strip().str.lower()
    outcome_df = usd_view[_ddl.isin({"approved", "under review", "not approved"})].copy()
    _od = outcome_df["donor_decision"].str.strip().str.lower()
    total_req = float(outcome_df["req_usd"].sum())
    amt_secured = float(outcome_df.loc[_od.eq("approved"), "sec_usd"].sum())
    total_unsec = float(outcome_df.loc[_od.eq("not approved"), "req_usd"].sum())
    sec_ratio = (amt_secured / total_req * 100) if total_req > 0 else 0.0
    _sec_nocur = outcome_df[(_od.eq("approved")) & (outcome_df["amount_secured"].fillna(0) > 0)]
    n_missing_secured_cur = int(
        _sec_nocur.get("currency_secured", pd.Series(dtype=str)).fillna("").str.strip().eq("").sum())

    if not proceed_track.empty:
        amt_pipeline = float(_series_to_usd(
            proceed_track["call_award_value"],
            proceed_track.get("currency", pd.Series(dtype=str))).sum())
        n_missing_pipe_cur = int(proceed_track[
            proceed_track["call_award_value"].fillna(0) > 0
        ].get("currency", pd.Series(dtype=str)).fillna("").str.strip().eq("").sum())
    else:
        amt_pipeline = 0.0
        n_missing_pipe_cur = 0

    # report.py 2971-2990 — the only period-aware block.
    cumulative = []
    if not approved_period.empty and "amount_secured" in approved_period.columns:
        ts = approved_period.dropna(subset=["date_of_approval", "amount_secured"]).copy()
        if not ts.empty:
            ts["date_of_approval"] = pd.to_datetime(ts["date_of_approval"])
            ts["_usd"] = _series_to_usd(
                ts["amount_secured"], ts.get("currency_secured", pd.Series(dtype=str)))
            agg_df = NS["_bucketed_sum"](ts["date_of_approval"], ts["_usd"], "secured")
            agg_df["cumulative"] = agg_df["secured"].cumsum()
            cumulative = [{"bucket": pd.Timestamp(b).date().isoformat(),
                           "secured": float(v), "cumulative": float(c)}
                          for b, v, c in zip(agg_df["bucket"], agg_df["secured"],
                                             agg_df["cumulative"])]

    # report.py 3011-3034 — the signed per-call chart.
    outcomes = []
    out_df = outcome_df[(outcome_df["req_usd"] > 0) | (outcome_df["sec_usd"] > 0)].copy()
    if not out_df.empty:
        _d = out_df["donor_decision"].str.strip().str.lower()

        def _signed(row):
            d = str(row.get("donor_decision") or "").strip().lower()
            if d == "approved":
                return row["sec_usd"] or row["req_usd"]
            if d == "not approved":
                return -row["req_usd"]
            return row["req_usd"]

        out_df["signed_usd"] = out_df.apply(_signed, axis=1)
        _STATE = {"approved": "Secured", "under review": "Requested (pending)",
                  "not approved": "Unsecured (declined)"}
        out_df["Outcome"] = _d.map(_STATE)
        out_df["label"] = (out_df["opportunity_title"].fillna("(untitled)")
                           .astype(str).str.slice(0, 42))
        outcomes = [{
            "uid": str(r.get("uid") or ""), "label": str(r["label"]),
            "funder": "" if r.get("funding_agency") is None else str(r.get("funding_agency")),
            "outcome": str(r["Outcome"]),
            "donorDecision": str(r.get("donor_decision") or "").strip(),
            "reqUsd": float(r["req_usd"]), "secUsd": float(r["sec_usd"]),
            "signedUsd": float(r["signed_usd"]),
        } for _, r in out_df.iterrows()]

    # report.py 3064-3077 — the shared submitted mask, NOT the submissions weight.
    proceeded = unique[unique["decision"].fillna("").str.lower().str.startswith("proceed")]
    if proceeded.empty:
        n_proc = n_sub_conv = n_app_conv = 0
    else:
        submitted_conv = proceeded[NS["_submitted_mask"](proceeded).to_numpy()]
        approved_conv = submitted_conv[
            submitted_conv["donor_decision"].fillna("").str.lower() == "approved"]
        n_proc, n_sub_conv, n_app_conv = (
            int(len(proceeded)), int(len(submitted_conv)), int(len(approved_conv)))

    # report.py 3091-3107 — `_req` converts with `currency`, unlike `req_usd` above.
    grants = []
    if not _pc.empty:
        _sg = _pc.copy()
        _sg["_req"] = _series_to_usd(
            _sg["amount_requested"], _sg.get("currency", pd.Series(dtype=str)))
        _sg["_sec"] = _series_to_usd(
            _sg["amount_secured"], _sg.get("currency_secured", pd.Series(dtype=str)))
        _sg["_subs"] = (_sg["submissions"].fillna(1).astype(int)
                        if "submissions" in _sg.columns else 1)
        _sg["_grant"] = _sg["opportunity_title"].fillna("(untitled)").astype(str).str.slice(0, 70)
        _sg["_funder"] = _sg["funding_agency"].fillna("—")
        _sg["_dd"] = (_sg["donor_decision"].fillna("").astype(str).str.strip()
                      .replace("", "Under Review"))
        _sg["_on"] = pd.to_datetime(_sg["date_completed"], errors="coerce").dt.date
        grants = [{
            "uid": str(r.get("uid") or ""), "grant": str(r["_grant"]),
            "funder": str(r["_funder"]),
            "requestedUsd": float(r["_req"]), "securedUsd": float(r["_sec"]),
            "donorDecision": str(r["_dd"]), "submissions": int(r["_subs"]),
            "submittedOn": None if pd.isna(r["_on"]) else r["_on"].isoformat(),
        } for _, r in _sg.iterrows()]

    return {
        "kpis": {"submitted": n_submitted, "approved": n_approved,
                 "winRate": win_rate, "securedRatio": sec_ratio},
        "money": {"requested": total_req, "secured": amt_secured, "unsecured": total_unsec,
                  "pipeline": amt_pipeline, "pipelineRfps": int(len(proceed_track))},
        "missingCurrency": {"approved": n_missing_secured_cur, "pipeline": n_missing_pipe_cur},
        "conversion": {
            "proceeded": n_proc, "submitted": n_sub_conv, "approved": n_app_conv,
            "proceededToSubmitted": (n_sub_conv / n_proc * 100) if n_proc else 0.0,
            "submittedToApproved": (n_app_conv / n_sub_conv * 100) if n_sub_conv else 0.0,
            "endToEnd": (n_app_conv / n_proc * 100) if n_proc else 0.0,
        },
        "outcomes": outcomes,
        "grants": grants,
        "cumulative": cumulative,
    }


def main() -> None:
    payload = json.loads(sys.stdin.read())
    _pin_rates(payload["rates"])
    rfps = _frame(payload["rfps"])
    print(json.dumps([_one(rfps, c) for c in payload["cases"]], ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
