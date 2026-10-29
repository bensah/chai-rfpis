"""The Python half of the Report parity check — views/report.py's own period helpers.

`views/report.py` is a Streamlit script: importing it renders the page, hits the database and
reads `st.session_state`, so the helpers cannot simply be imported. They are LIFTED OUT OF THE
FILE instead — parsed with `ast`, and exec'd with the module globals they read (`today`,
`period_mode`, `year_override`, `month_override`, `_start`, `_end`) injected per case.

That matters: the check runs the real source text. A copy retyped into this file would agree
with itself forever while report.py drifted underneath it, which is the failure mode the
check exists to prevent.

Usage (driven by check-report.mjs):
    python report_py.py <what>        cases as JSON on stdin, results as JSON on stdout
"""
from __future__ import annotations

import ast
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[3]
REPORT_PY = REPO_ROOT / "views" / "report.py"

# BOTH ENDS, EXPLICITLY. On Windows the default codec for stdin and stdout is cp1252, and
# the two errors cancelled: the harness read UTF-8 JSON as cp1252 (so "Française" became
# "FranÃ§aise" INSIDE the Python), then wrote it back as cp1252 bytes that Node decoded as
# UTF-8, landing on "Française" again. The check passed while the Python side had been
# computing on mojibake throughout — and any rule that reads a non-ASCII character, which is
# every rule in this file, was being compared on the wrong input.
#
# Fixing only the output end is worse than fixing neither: it breaks the cancellation and
# turns a silent wrong-input bug into a loud wrong-output one. Both, or the test is a lie.
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# The helpers under test, and the module-level lists they read.
WANT_FUNCS = [
    "_last_day_of_month", "_period_bounds", "_period_label", "_period_slug",
    "_period_phrase", "_bucket_start", "_bucket_range", "_bucket_label",
    "_cadence_word", "_in_period", "_opt_index", "_slug",
    # The focus-area cloud's own helpers, lifted for check-names.mjs.
    "_canonical_area", "_programme_area_freq",
]
WANT_ASSIGNS = ["_PERIOD_OPTS", "_VIEW_OPTS", "_MONTH_NAMES", "_AREA_NON_VALUES"]


def _lift() -> tuple[dict, dict]:
    """Exec the wanted definitions out of report.py into a fresh namespace.

    Returns (namespace, widget_defaults). `widget_defaults` holds the `index=` expressions
    from the three selectboxes and the year clamp, as source text — the defaults a snapshot
    with a missing or unrecognised value falls back to. They live in widget arguments rather
    than in a function, so they are read as expressions and evaluated, not re-typed.
    """
    src = REPORT_PY.read_text(encoding="utf-8")
    tree = ast.parse(src)
    ns: dict = {
        "pd": pd, "np": np, "re": re, "json": json, "date": date, "timedelta": timedelta,
        "__builtins__": __builtins__,
    }
    picked: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in WANT_FUNCS:
            picked.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id in WANT_ASSIGNS for t in node.targets
        ):
            picked.append(node)
    missing = set(WANT_FUNCS) - {n.name for n in picked if isinstance(n, ast.FunctionDef)}
    if missing:
        raise SystemExit(f"views/report.py no longer defines: {sorted(missing)}")
    exec(compile(ast.Module(body=picked, type_ignores=[]), str(REPORT_PY), "exec"), ns)

    # The widget defaults: `index=` on each selectbox, keyed by the widget's label.
    defaults: dict[str, str] = {}
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "selectbox"):
            continue
        label = node.args[0].value if node.args and isinstance(node.args[0], ast.Constant) else None
        for kw in node.keywords:
            if kw.arg == "index" and isinstance(label, str):
                defaults[label] = ast.unparse(kw.value)
    # The year seed's clamp, written as a bare min(max(...)) statement.
    for node in tree.body:
        if (isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id == "_year_seed"
                and isinstance(node.value, ast.Call)):
            defaults["_year_seed"] = ast.unparse(node.value)
    return ns, defaults


NS, DEFAULTS = _lift()


def _set_case(case: dict) -> None:
    """Point the lifted helpers at one selection."""
    NS["today"] = date.fromisoformat(case["today"])
    NS["period_mode"] = case["period"]
    NS["year_override"] = case["year"]
    NS["month_override"] = case["month"]
    NS["bucket_mode"] = case["view"]
    start, end = NS["_period_bounds"]()
    NS["_start"], NS["_end"] = start, end
    NS["_period_label_str"] = NS["_period_label"]()


def _iso(d) -> str | None:
    return d.isoformat() if d is not None else None


def do_selection(cases: list[dict]) -> list[dict]:
    """Bounds, labels and the bucket range, for one selection each."""
    out = []
    for case in cases:
        _set_case(case)
        start, end = NS["_start"], NS["_end"]
        rng = None
        if start is not None and end is not None:
            rng = [pd.Timestamp(x).date().isoformat()
                   for x in NS["_bucket_range"](start, end, case["view"])]
        out.append({
            "start": _iso(start), "end": _iso(end),
            "label": NS["_period_label"](),
            "phrase": NS["_period_phrase"](),
            "slug": NS["_period_slug"](),
            "cadence": NS["_cadence_word"](),   # reads the bucket_mode global
            "bucketLabel": NS["_bucket_label"](case["view"]),
            "buckets": rng,
        })
    return out


def do_bucket_start(cases: list[dict]) -> list[dict]:
    """Each probe date snapped to its bucket, per view mode.

    Returns {"buckets": [...]} or {"error": "..."}. The error branch is not defensive
    tidiness: `_bucket_start` RAISES for Semestrial when the series carries a NaT, and the
    check needs to see that rather than die on it. See check-report.mjs section 3.
    """
    out = []
    for case in cases:
        s = pd.Series(pd.to_datetime(pd.Series(case["dates"]), errors="coerce"))
        try:
            snapped = NS["_bucket_start"](s, case["view"])
        except Exception as exc:  # noqa: BLE001 — reported to the harness, not swallowed
            out.append({"error": f"{type(exc).__name__}: {exc}"})
            continue
        out.append({"buckets": [None if pd.isna(x) else pd.Timestamp(x).date().isoformat()
                                for x in snapped]})
    return out


def do_in_period(cases: list[dict]) -> list[list[bool]]:
    """_in_period over probe values, including None — the NULL-date asymmetry."""
    out = []
    for case in cases:
        _set_case(case)
        row = []
        for v in case["values"]:
            ts = pd.NaT if v is None else pd.to_datetime(v, errors="coerce")
            row.append(bool(NS["_in_period"](ts)))
        out.append(row)
    return out


def do_defaults(_cases) -> dict:
    """The widget fallbacks, evaluated from report.py's own `index=` expressions."""
    opts = {"_PERIOD_OPTS": NS["_PERIOD_OPTS"], "_VIEW_OPTS": NS["_VIEW_OPTS"],
            "_MONTH_NAMES": NS["_MONTH_NAMES"]}
    # `_opt_index(opts, _sel(...), N)` with a value that is NOT in the options returns N —
    # the fallback. Evaluate each expression with `_sel` answering None, which is what a
    # snapshot missing that key does.
    env = dict(NS)
    env.update(opts)
    env["_sel"] = lambda *_a, **_k: None
    env["today"] = date(2026, 7, 15)   # a fixed day: the month default reads today.month
    out = {}
    for label, expr in DEFAULTS.items():
        try:
            out[label] = eval(expr, env)  # noqa: S307 — report.py's own source, not input
        except Exception as exc:          # noqa: BLE001
            out[label] = f"ERROR {type(exc).__name__}: {exc}"
    out["periods"] = list(NS["_PERIOD_OPTS"])
    out["views"] = list(NS["_VIEW_OPTS"])
    out["months"] = list(NS["_MONTH_NAMES"])
    out["defaultExprs"] = DEFAULTS
    return out


HANDLERS = {
    "selection": do_selection,
    "bucket_start": do_bucket_start,
    "in_period": do_in_period,
    "defaults": do_defaults,
}

if __name__ == "__main__":
    what = sys.argv[1]
    payload = json.loads(sys.stdin.read() or "[]")
    print(json.dumps(HANDLERS[what](payload)))
