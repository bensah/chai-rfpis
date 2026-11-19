"""The Python half of the Meeting Actions parity check.

Four rules, each taken from its own source rather than retyped:

  * `core.review_week.week_bounds` and `review_week_label` are an ordinary module — imported.
  * `core.schedule._clean` likewise, so the rota's "first entry per date wins, sorted"
    comes from the module that actually stores it.
  * `_first_name` and `_owner_summary` are functions inside `views/pending_actions.py`,
    which is a Streamlit view — lifted with `ast`.
  * The open/resolved predicates are inline page code with no function around them, so they
    are written out here with their line numbers quoted. The one that matters is the
    engagement rule: `fillna(False)`, with the "outcome non-empty" proxy reachable ONLY
    through the `except` around a select that fails for want of the column.

READ ONLY. Nothing here writes a row.
"""
from __future__ import annotations

import ast
import json
import sys
from datetime import date
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from core import schedule as _sched                           # noqa: E402
from core.review_week import review_week_label, week_bounds    # noqa: E402

PENDING_PY = REPO_ROOT / "views" / "pending_actions.py"
_WANT = ["_first_name", "_owner_summary"]


def _lift() -> dict:
    tree = ast.parse(PENDING_PY.read_text(encoding="utf-8"))
    ns: dict = {"pd": pd, "__builtins__": __builtins__}
    picked = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in _WANT]
    missing = set(_WANT) - {n.name for n in picked}
    if missing:
        raise SystemExit(f"views/pending_actions.py no longer defines: {sorted(missing)}")
    exec(compile(ast.Module(body=picked, type_ignores=[]), str(PENDING_PY), "exec"), ns)
    return ns


P = _lift()


def main() -> None:
    payload = json.loads(sys.stdin.read())

    weeks = []
    for d in payload["days"]:
        mon, sun = week_bounds(date.fromisoformat(d))
        weeks.append({"monday": mon.isoformat(), "sunday": sun.isoformat(),
                      "label": review_week_label(date.fromisoformat(d))})

    # `_owner_summary` returns a markdown STRING; what the port holds is the (name, count)
    # list behind it. Both are produced so the check can compare the data and then confirm
    # the port's list renders back to the page's own line.
    owners = []
    for case in payload["owners"]:
        series = pd.Series(case, dtype=object)
        exploded: list[str] = []
        for v in series.dropna():
            for piece in str(v).split(","):
                p = piece.strip()
                if p:
                    exploded.append(p)
        counts = (pd.Series(exploded).map(P["_first_name"]).value_counts()
                  if exploded else pd.Series(dtype=int))
        owners.append({
            "summary": P["_owner_summary"](series),
            # value_counts sorts by count descending and breaks ties arbitrarily, so the
            # NAMES per count are compared rather than the order within a tie.
            "counts": [[str(k), int(v)] for k, v in counts.items()],
        })

    # core/schedule.py::_clean — the rota's own cleaning.
    schedules = [_sched._clean(items) for items in payload["schedules"]]

    # pending_actions.py 166 and 287 — both tables fill a NULL with False, so a NULL is
    # OPEN. 179: the open set is `~is_resolved`.
    engagements = []
    for rows in payload["engagements"]:
        df = pd.DataFrame(rows)
        if df.empty:
            engagements.append({"open": [], "resolved": []})
            continue
        res = df["is_resolved"].fillna(False).astype(bool)
        engagements.append({
            "open": sorted(str(x) for x in df.loc[~res, "id"]),
            "resolved": sorted(str(x) for x in df.loc[res, "id"]),
        })

    print(json.dumps({"weeks": weeks, "owners": owners, "schedules": schedules,
                      "engagements": engagements}, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
