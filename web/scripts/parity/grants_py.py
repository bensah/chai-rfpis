"""The Python half of the Bids Submitted parity check — views/outcomes.py.

THE CLASSIFICATION IS LIFTED, NOT RETYPED. `_fetch` is a nested function inside the page's
`with _main:` block, so it is not in `tree.body` — but `ast.walk` finds it, and its body is
exactly the part worth holding to the source: `_submitted`, `_approved`, `_pending`,
`_not_approved`, `_status_display` and the two USD columns. Those six rules decide which
applications the page counts at all, and a retype of them would agree with itself forever.

The KPI arithmetic that follows is inline page code with no function around it, so it IS
transcribed here, with report-page line numbers quoted beside each figure.

FX IS PINNED, as in check-section3 and check-section5: `usd_value` reaches
`core.dropdowns.usd_rate`, which does a live lookup, and two halves calling it seconds apart
can disagree because a rate moved. The Node side sends the rates it used and the Python
answers from them. What is under test is WHICH CURRENCY COLUMN each figure converts with.
"""
from __future__ import annotations

import ast
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

from core import dropdowns, pipeline as _pipeline       # noqa: E402
from core.records import (clean_df, requested_currency,  # noqa: E402
                          submission_weights)

OUTCOMES_PY = REPO_ROOT / "views" / "outcomes.py"


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


def _lift_classify():
    """`_fetch`'s body, minus its database read — the six classification rules.

    The function fetches and then classifies. Only the classification is wanted, so the
    statements are taken from the `if not rfps.empty:` block inside it and exec'd against a
    frame the caller supplies. Taking the whole function would mean a live query per case
    and a Streamlit cache decorator to satisfy.
    """
    tree = ast.parse(OUTCOMES_PY.read_text(encoding="utf-8"))
    fetch = next((n for n in ast.walk(tree)
                  if isinstance(n, ast.FunctionDef) and n.name == "_fetch"), None)
    if fetch is None:
        raise SystemExit("views/outcomes.py no longer defines _fetch")
    # The `if not rfps.empty:` guard inside it holds every rule under test.
    block = next((n for n in fetch.body if isinstance(n, ast.If)
                  and "empty" in ast.unparse(n.test)), None)
    if block is None:
        raise SystemExit("views/outcomes.py::_fetch no longer guards on rfps.empty")
    body = block.body
    # `ast.unparse` renders a string subscript with SINGLE quotes, so the wanted names are
    # written the same way rather than compared against the source's own spelling.
    names = {ast.unparse(t) for st in body if isinstance(st, ast.Assign) for t in st.targets}
    for want in ("rfps['_submitted']", "rfps['_approved']", "rfps['_pending']",
                 "rfps['_not_approved']", "rfps['_usd_requested']", "rfps['_usd_secured']"):
        if want not in names:
            raise SystemExit(
                f"views/outcomes.py::_fetch no longer assigns {want} — it assigns {sorted(names)}")
    code = compile(ast.Module(body=body, type_ignores=[]), str(OUTCOMES_PY), "exec")

    def classify(rfps: pd.DataFrame) -> pd.DataFrame:
        ns = {
            "pd": pd, "np": np, "rfps": rfps,
            "usd_value": _pipeline.usd_value,
            "_requested_currency": requested_currency,
            "__builtins__": __builtins__,
        }
        exec(code, ns)
        return ns["rfps"]

    return classify


CLASSIFY = _lift_classify()


def main() -> None:
    payload = json.loads(sys.stdin.read())
    _pin_rates(payload["rates"])
    rows = payload["rfps"]
    if not rows:
        print(json.dumps({"counts": {}, "money": {}, "byFunder": [], "rows": []}))
        return

    # `eq("is_duplicate", False)` is in the page's own fetch, before any of this.
    rfps = clean_df(pd.DataFrame(rows))
    rfps = rfps[rfps.get("is_duplicate", False).fillna(False) == False]      # noqa: E712
    rfps = CLASSIFY(rfps.copy())

    active = rfps[rfps["_submitted"]].copy()
    if active.empty:
        print(json.dumps({"counts": {}, "money": {}, "byFunder": [], "rows": []}))
        return

    # outcomes.py 126-144 — the KPI strip, submission-weighted throughout.
    active["_subs"] = submission_weights(active)
    total_submitted = int(active["_subs"].sum())
    approved = int(active.loc[active["_approved"], "_subs"].sum())
    pending = int(active.loc[active["_pending"], "_subs"].sum())
    not_approved = int(active.loc[active["_not_approved"], "_subs"].sum())
    total_requested = float(active["_usd_requested"].sum())
    total_secured = float(active.loc[active["_approved"], "_usd_secured"].sum())
    total_unsecured = float(active.loc[active["_not_approved"], "_usd_requested"].sum())
    requested_balance = max(0.0, total_requested - total_secured - total_unsecured)
    win_rate = (approved / total_submitted * 100) if total_submitted else 0

    # outcomes.py 424-443 — the by-funder table. `_submissions_int` is NOT the weight above:
    # no progress gate, so a row the KPI counts as zero still counts as one here.
    active["_submissions_int"] = active["submissions"].fillna(1).astype(int)
    by_funder = (
        active.groupby("funding_agency")
        .agg(
            RFPs=("uid", "count"),
            Submissions=("_submissions_int", "sum"),
            Approved=("_approved", "sum"),
            Pending=("_pending", "sum"),
            NotApproved=("_not_approved", "sum"),
            Requested=("_usd_requested", "sum"),
            Secured=("_usd_secured", lambda s: float(s[active.loc[s.index, "_approved"]].sum())),
        )
        .reset_index()
        .rename(columns={"funding_agency": "Funder"})
        .sort_values("Submissions", ascending=False)
    )

    print(json.dumps({
        "counts": {"submitted": total_submitted, "approved": approved, "pending": pending,
                   "notApproved": not_approved, "rows": int(len(active))},
        "money": {"requested": total_requested, "secured": total_secured,
                  "unsecured": total_unsecured, "balance": requested_balance},
        "winRate": win_rate,
        # Keyed by uid so the Node side can compare per row without depending on an order
        # that pandas does not promise.
        "rows": {str(r["uid"]): {
            "status": str(r.get("_status_display") or ""),
            "approved": bool(r["_approved"]), "pending": bool(r["_pending"]),
            "notApproved": bool(r["_not_approved"]),
            "applications": int(r["_subs"]), "submissions": int(r["_submissions_int"]),
            "usdRequested": float(r["_usd_requested"]), "usdSecured": float(r["_usd_secured"]),
        } for _, r in active.iterrows()},
        "byFunder": {str(r["Funder"]): {
            "rfps": int(r["RFPs"]), "submissions": int(r["Submissions"]),
            "approved": int(r["Approved"]), "pending": int(r["Pending"]),
            "notApproved": int(r["NotApproved"]),
            "requested": float(r["Requested"]), "secured": float(r["Secured"]),
        } for _, r in by_funder.iterrows()},
        "funderOrder": [str(r["Funder"]) for _, r in by_funder.iterrows()],
    }, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
