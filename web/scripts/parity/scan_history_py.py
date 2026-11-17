"""The Python half of the scan-history parity check.

ONE ANSWER KEY, and this one is lifted rather than imported: `_run_summary` and
`_pretty_trigger` are defined INSIDE `app_pages/admin.py`'s tab body, which runs
Streamlit widgets at import time. They are pulled out of the syntax tree and executed
with the one name they close over — pandas, for the timestamp arithmetic.

THE CASES ARE THE INTERESTING PART. scan_logs is one row per SOURCE per run, so every
figure is a sum over a group, and choosing the group wrongly reports a number that is
merely too big — which looks like a good scan. The fixtures cover:

  * the modern path: group by the newest row's run_id;
  * the legacy path: contiguous rows under fifteen minutes apart with the same trigger;
  * the STOP that matters: a legacy tail must not be merged into a run that has a run_id;
  * `added` absent on every row of a group, which must stay None rather than become 0.

READ ONLY. No database, no Streamlit session.
"""
from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ADMIN = REPO_ROOT / "app_pages" / "admin.py"


def _lift(*names: str) -> dict:
    """The named nested functions, executed with the globals they close over."""
    import pandas as pd

    tree = ast.parse(ADMIN.read_text(encoding="utf-8"))
    defs = [n for n in ast.walk(tree)
            if isinstance(n, ast.FunctionDef) and n.name in names]
    missing = set(names) - {d.name for d in defs}
    if missing:
        raise SystemExit(f"app_pages/admin.py no longer defines {sorted(missing)}")
    ns: dict = {"pd": pd}
    exec(compile(ast.Module(body=defs, type_ignores=[]), str(ADMIN), "exec"), ns)
    return ns


_NS = _lift("_run_summary", "_pretty_trigger")
_run_summary = _NS["_run_summary"]
_pretty_trigger = _NS["_pretty_trigger"]


def row(ts, *, run_id=None, trigger="manual:ada@example.org",
        found=0, new=0, added=None, rejected=0, source="Some Funder") -> dict:
    return {"scan_date": ts, "run_id": run_id, "triggered_by": trigger,
            "rfps_found": found, "rfps_new": new, "rfps_added": added,
            "rfps_rejected": rejected, "source": source}


CASES: list[list[dict]] = [
    [],
    # One modern run: three source rows sharing a run_id, summed.
    [row("2026-11-17T10:00:00", run_id="r1", found=5, new=2, added=2, rejected=3),
     row("2026-11-17T09:59:00", run_id="r1", found=4, new=1, added=1, rejected=3),
     row("2026-11-17T09:58:00", run_id="r1", found=1, new=0, added=0, rejected=1),
     # An OLDER run that must not be counted, even though it is minutes away.
     row("2026-11-17T09:50:00", run_id="r0", found=99, new=99, added=99, rejected=99)],
    # Legacy: no run_id anywhere, contiguous and same trigger.
    [row("2026-11-17T10:00:00", found=5, new=2, rejected=1),
     row("2026-11-17T09:58:00", found=3, new=1, rejected=1),
     row("2026-11-17T09:57:00", found=2, new=0, rejected=0)],
    # Legacy with a >15-minute gap: the older rows are a different run.
    [row("2026-11-17T10:00:00", found=5),
     row("2026-11-17T09:40:00", found=50)],
    # Legacy with a DIFFERENT trigger in the window: skipped, not merged.
    [row("2026-11-17T10:00:00", found=5),
     row("2026-11-17T09:59:00", trigger="match:bob@example.org", found=50)],
    # THE STOP: a legacy newest row followed by rows that DO have a run_id.
    [row("2026-11-17T10:00:00", found=5),
     row("2026-11-17T09:59:00", run_id="r9", found=500),
     row("2026-11-17T09:58:00", run_id="r9", found=500)],
    # `added` absent on every row of the group → None, not 0.
    [row("2026-11-17T10:00:00", run_id="r2", found=7, added=None),
     row("2026-11-17T09:59:00", run_id="r2", found=3, added=None)],
    # `added` on SOME rows → the sum of those that have it.
    [row("2026-11-17T10:00:00", run_id="r3", found=7, added=4),
     row("2026-11-17T09:59:00", run_id="r3", found=3, added=None)],
    # A single row.
    [row("2026-11-17T10:00:00", run_id="r4", found=1, new=1, added=1, rejected=0)],
]

TRIGGER_CASES = [
    "manual:ada@example.org", "extraction:ada@example.org", "match:ada@example.org",
    "cron", "", None, "manual:", "something:else@example.org",
]


def main() -> None:
    sys.stdin.read()
    print(json.dumps({
        "runs": [{"rows": c, "want": _run_summary(c)} for c in CASES],
        "triggers": [{"raw": t, "want": _pretty_trigger(t)} for t in TRIGGER_CASES],
    }, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
