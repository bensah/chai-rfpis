"""The Python half of the Report Section 3 parity check (section id 2, displayed 3rd).

Lifted from views/report.py: `_submitted_mask`, `_series_to_usd`, `_to_usd`, `_in_period`
and `_discovery_ts`. `_to_usd` reaches `core.dropdowns.usd_rate`, which does a LIVE FX
lookup — so this half and the TypeScript half must be given the same rates or they will
disagree for a reason that has nothing to do with the funnel. The Node side therefore sends
the rates it used, and `usd_rate` is monkeypatched to answer from them.

The counts are transcribed with report.py's line ranges quoted; the money is not, because
the money is where a re-implementation actually goes wrong.
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
    df["is_duplicate"] = df.get("is_duplicate", False).fillna(False)
    return df


def _pin_rates(resolved: dict) -> None:
    """Answer usd_rate from a rate the Node side already resolved, keyed by the LITERAL
    cell value.

    The harness deliberately holds no lookup logic of its own. An earlier version
    re-implemented the code/label/alias/first-token search in `money.ts::staticRate` and got
    it wrong — it read the static table's field as `usd_rate` where it is `usdRate`, so every
    static rate silently became 1.0 and two funnel stages differed by about 900,000 dollars.
    The check reported a port difference that was entirely its own.

    So now the Node side resolves each distinct currency string through its own `usdRate` and
    sends the answers; this just looks the string up. What is under test is which COLUMN PAIR
    each funnel stage converts, not the rate table, which check-scoring covers.
    """
    def usd_rate(currency, *a, **k):
        cur = str(currency or "").strip()
        if not cur or cur.upper() == "USD":
            return 1.0
        return float(resolved.get(cur, 1.0))
    dropdowns.usd_rate = usd_rate
    NS["dropdowns"] = dropdowns


def _one(rfps: pd.DataFrame, case: dict) -> dict:
    from datetime import date as _date
    NS["_start"] = _date.fromisoformat(case["bounds"]["start"]) if case["bounds"]["start"] else None
    NS["_end"] = _date.fromisoformat(case["bounds"]["end"]) if case["bounds"]["end"] else None

    if rfps.empty:
        return {"counts": {}, "values": {}, "progress": [], "proceedRows": 0}

    # report.py 2513-2529
    unique_all = rfps[~rfps["is_duplicate"]].copy()
    disc_ts = unique_all.apply(NS["_discovery_ts"], axis=1)
    unique_all["_discovered_in_period"] = disc_ts.apply(NS["_in_period"])
    in_period = unique_all[unique_all["_discovered_in_period"]]

    total_all = int(len(unique_all))
    _dec_all = unique_all["decision"].fillna("").str.lower()
    proceed_df_all = unique_all[_dec_all.str.startswith("proceed")]
    proceed_all = int(len(proceed_df_all))
    park_all = int((_dec_all == "park").sum())
    decline_all = int((_dec_all == "decline").sum())
    no_decision_all = total_all - (proceed_all + park_all + decline_all)

    _sub_proc = proceed_df_all[NS["_submitted_mask"](proceed_df_all)]
    submitted_all = int(len(_sub_proc))
    _appr = _sub_proc[_sub_proc["donor_decision"].fillna("").str.lower() == "approved"]
    approved_all = int(len(_appr))

    # report.py 2563-2574 — a different column pair per stage.
    to_usd = NS["_series_to_usd"]
    disc_v = float(to_usd(unique_all["call_award_value"],
                          unique_all.get("currency", pd.Series(dtype=str))).sum())
    proc_v = float(to_usd(proceed_df_all["call_award_value"],
                          proceed_df_all.get("currency", pd.Series(dtype=str))).sum())
    sub_v = float(to_usd(_sub_proc["amount_requested"],
                         _sub_proc.get("currency", pd.Series(dtype=str))).sum())
    appr_v = float(to_usd(_appr["amount_secured"],
                          _appr.get("currency_secured", pd.Series(dtype=str))).sum())

    # report.py 2602-2627
    order = ["Not Started", "In Progress", "Completed", "Discontinued", "Missed"]
    canon = {"not started": "Not Started", "in progress": "In Progress",
             "completed": "Completed", "discontinued": "Discontinued",
             "missed": "Missed", "missing": "Missed"}
    _proc_ps = unique_all[
        unique_all["decision"].fillna("").str.lower().str.startswith("proceed")].copy()
    if _proc_ps.empty:
        progress = [{"status": s, "rfps": 0} for s in order]
    else:
        ps = (_proc_ps["progress_status"]
              .apply(lambda v: canon.get(str(v or "").strip().lower(), "Not Started"))
              .value_counts().reindex(order, fill_value=0))
        progress = [{"status": str(k), "rfps": int(v)} for k, v in ps.items()]

    return {
        "counts": {
            "total": total_all, "proceed": proceed_all, "park": park_all,
            "decline": decline_all, "noDecision": no_decision_all,
            "submitted": submitted_all, "approved": approved_all,
            "discoveredInPeriod": int(len(in_period)),
        },
        "values": {"discovered": disc_v, "proceed": proc_v,
                   "submitted": sub_v, "approved": appr_v},
        "progress": progress,
        "proceedRows": proceed_all,
    }


def main() -> None:
    payload = json.loads(sys.stdin.read())
    _pin_rates(payload["rates"])
    rfps = _frame(payload["rfps"])
    print(json.dumps([_one(rfps, c) for c in payload["cases"]], ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
