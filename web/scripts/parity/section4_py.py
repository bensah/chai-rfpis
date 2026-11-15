"""The Python half of the Report Section 4 parity check (section id 3, displayed 4th).

Lifted from views/report.py via `report_py.NS`: `_in_period`, `_bucket_start`,
`_bucket_range` and `_bucketed_count`. The last of those reads the module globals `_start`,
`_end` and `bucket_mode`, so each case sets them before calling it — that is the whole
reason the helpers are lifted rather than retyped.

The counts below ARE transcribed, with report.py's line ranges quoted, because they are a
handful of boolean masks and a transcription is readable. What is NOT transcribed is the
bucketing: it goes through the page's own `_bucketed_count`, because the reindex-against-
the-full-range behaviour (which drops as well as fills) is exactly where a port goes wrong.
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

from core.records import clean_df                # noqa: E402
from report_py import NS                         # noqa: E402

_DT_KW = dict(errors="coerce", format="ISO8601")


def _frame(rows: list[dict]) -> pd.DataFrame:
    """`_load_rfps`'s own coercions. `decision_date` is a DATE, `search_date` a TIMESTAMP —
    which is why `days_to_decide` has to call `.date()` on one side and not the other."""
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


def _one(rfps_all: pd.DataFrame, case: dict) -> dict:
    from datetime import date as _date
    NS["_start"] = _date.fromisoformat(case["bounds"]["start"]) if case["bounds"]["start"] else None
    NS["_end"] = _date.fromisoformat(case["bounds"]["end"]) if case["bounds"]["end"] else None
    NS["bucket_mode"] = case["view"]
    _start = NS["_start"]

    if rfps_all.empty:
        return {"kpis": {}, "distribution": [], "overTime": [], "autoRec": {}, "donor": {}}

    rfps_all = rfps_all.copy()
    rfps_all["_decided_in_period"] = rfps_all["decision_date"].apply(NS["_in_period"])

    # report.py 2663-2690
    decided = rfps_all[~rfps_all["is_duplicate"]].copy()
    if _start:
        decided = decided[decided["_decided_in_period"]]
    overridden = decided[decided["decision_overridden_by"].notna()]

    avg_days = med_days = None
    n_dated = 0
    if not decided.empty and "search_date" in decided.columns:
        dec_with_subm = decided.dropna(subset=["search_date", "decision_date"]).copy()
        if not dec_with_subm.empty:
            dec_with_subm["days_to_decide"] = dec_with_subm.apply(
                lambda r: (r["decision_date"] - r["search_date"].date()).days, axis=1)
            avg_days = float(dec_with_subm["days_to_decide"].mean())
            med_days = float(dec_with_subm["days_to_decide"].median())
            n_dated = int(len(dec_with_subm))

    kpis = {
        "decisions": int(len(decided)),
        "avgDays": avg_days, "medianDays": med_days,
        "overridden": int(len(overridden)),
        "dated": n_dated,
    }

    # report.py 2713-2724 — ALL-TIME, period ignored.
    _unique_all = rfps_all[~rfps_all["is_duplicate"]]
    _lower = _unique_all["decision"].fillna("").str.lower()
    _proceed = int(_lower.str.startswith("proceed").sum())
    _park = int((_lower == "park").sum())
    _decline = int((_lower == "decline").sum())
    _no_dec = int(len(_unique_all)) - (_proceed + _park + _decline)
    distribution = [
        {"decision": "Proceed", "count": _proceed},
        {"decision": "Park", "count": _park},
        {"decision": "Decline", "count": _decline},
        {"decision": "No decision", "count": _no_dec},
    ]

    # report.py 2694-2696, 2736-2740 — Proceed WITHIN the period's decisions.
    _proc_dec = decided[decided["decision"].fillna("").str.lower().str.startswith("proceed")]
    over_time = []
    if not _proc_dec.empty:
        dec_dates = pd.to_datetime(_proc_dec["decision_date"], errors="coerce").dropna()
        if not dec_dates.empty:
            ts_df = NS["_bucketed_count"](dec_dates, "decisions")
            over_time = [{"bucket": pd.Timestamp(b).date().isoformat(), "decisions": int(v)}
                         for b, v in zip(ts_df["bucket"], ts_df["decisions"])]

    # report.py 2760-2785
    _auto = decided["auto_recommendation"].fillna("").astype(str).str.strip().str.lower()
    _team = decided["decision"].fillna("").astype(str).str.strip().str.lower()
    auto_rows = []
    for _label in ("Proceed", "Park", "Decline"):
        _k = _label.lower()
        auto_rows.append({"decision": _label,
                          "auto": int(_auto.str.startswith(_k).sum()),
                          "team": int(_team.str.startswith(_k).sum())})
    # `.str.split().str[0]` on a blank yields NaN, and NaN != NaN — so two blanks do NOT
    # count as agreement. The port reproduces that rather than "fixing" it.
    _agreed = int((_auto.str.split().str[0] == _team.str.split().str[0]).sum())
    auto_rec = {"rows": auto_rows, "agreed": _agreed, "total": int(len(decided))}

    # report.py 2807-2845 — ALL-TIME and Proceed only, and this one STRIPS.
    _proc_dd = rfps_all[
        (~rfps_all["is_duplicate"])
        & rfps_all["decision"].fillna("").str.strip().str.lower().str.startswith("proceed")
    ]
    _AWAITING = ("", "not submitted", "submitted", "pending", "awaiting", "in review")
    _dd = _proc_dd["donor_decision"].fillna("").astype(str).str.strip()
    _pending = int(_dd.str.lower().isin(_AWAITING).sum())
    _dd = _dd[~_dd.str.lower().isin(_AWAITING)]
    _all = {str(k): int(v) for k, v in _dd.str.title().value_counts().items()}
    donor = {"all": _all, "pending": _pending}

    return {"kpis": kpis, "distribution": distribution, "overTime": over_time,
            "autoRec": auto_rec, "donor": donor}


def main() -> None:
    payload = json.loads(sys.stdin.read())
    rfps = _frame(payload["rfps"])
    print(json.dumps([_one(rfps, c) for c in payload["cases"]], ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
