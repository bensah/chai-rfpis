"""The Python half of the report snapshot parity check — the `?r=` store.

Two sources, both read rather than retyped:

  * `core.report_snapshots` is a plain module, so `restore_items`, `save_snapshot`,
    `get_snapshot` and `_load` are imported and called directly. Its `_settings` is
    redirected at an in-memory dict first — THE REAL STORE IS A LIVE, SHARED
    `app_settings` ROW HOLDING EVERY REPORT LINK ANYONE HAS GENERATED, and a parity check
    that writes to it would prune a hundred real links per run. Nothing here touches the
    network.

  * The rest lives in `views/report.py`, which is a Streamlit script and cannot be
    imported. Its catalogue comes through `report_py.NS` (lifted with `ast`), and the three
    statements that are neither function nor plain assignment — `_restored_secs`, `_cur_sig`
    and `_snap_sig` — are unparsed out of the source and `eval`'d with their inputs injected.
    So the check runs report.py's own text; a copy retyped here would agree with itself
    forever while the page drifted underneath it.

`save_snapshot` is made deterministic by pinning `random.randint` and the module's `date` /
`datetime`, which is what lets the whole resulting store be compared key for key instead of
only its size.
"""
from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from core import report_snapshots                 # noqa: E402
from report_py import NS, REPORT_PY               # noqa: E402

# ── The statements lifted as source text ────────────────────────────────────
# `_restored_secs`, `_cur_sig` and `_snap_sig` are module-level assignments whose
# right-hand sides read page state (`_snap`, `_picked_secs`, …). They cannot be exec'd the
# way report_py lifts a function, so the expression is unparsed and evaluated per case with
# exactly the names it reads bound. A rename or a rewrite in report.py raises here rather
# than quietly leaving the check testing nothing.
_WANT_EXPRS = ["_restored_secs", "_cur_sig", "_snap_sig"]


def _lift_exprs() -> dict[str, str]:
    tree = ast.parse(REPORT_PY.read_text(encoding="utf-8"))
    out: dict[str, str] = {}
    for node in tree.body:
        if (isinstance(node, ast.Assign) and node.targets
                and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id in _WANT_EXPRS):
            out[node.targets[0].id] = ast.unparse(node.value)
    missing = set(_WANT_EXPRS) - set(out)
    if missing:
        raise SystemExit(f"views/report.py no longer assigns: {sorted(missing)}")
    return out


EXPRS = _lift_exprs()


def _sel_for(snap):
    """report.py's `_sel`: a field from the restored snapshot, or the default.

    `if _snap and key in _snap` — an EMPTY snapshot dict is falsy, so it answers with the
    defaults for every key exactly as a missing one does.
    """
    def _sel(key, default=None):
        if snap and key in snap:
            return snap[key]
        return default
    return _sel


# ── The store, in memory ────────────────────────────────────────────────────

class _Store:
    """Stands in for `core.settings`. One key, one value, no network."""

    def __init__(self) -> None:
        self.value: str | None = None
        self.updated_by: str | None = None

    def get_setting(self, key, default=None, tenant_id=None):
        assert key == report_snapshots._KEY, f"unexpected settings key {key!r}"
        return self.value if self.value is not None else default

    def set_setting(self, key, value, updated_by=None, tenant_id=None):
        assert key == report_snapshots._KEY, f"unexpected settings key {key!r}"
        self.value, self.updated_by = value, updated_by


class _FixedDate:
    """`date.today()` pinned, so the `YYYYMMDD` half of the id is ours to choose."""

    def __init__(self, today: str) -> None:
        self._today = today

    def today(self):
        from datetime import date as _d
        return _d.fromisoformat(self._today)


class _FixedDateTime:
    """`datetime.now()` pinned, so `created_at` is ours to choose."""

    def __init__(self, stamp: str) -> None:
        self._stamp = stamp

    def now(self):
        from datetime import datetime as _dt
        return _dt.fromisoformat(self._stamp)


def _save(case: dict) -> dict:
    """Run the REAL `save_snapshot` against an in-memory store, deterministically."""
    store = _Store()
    store.value = case["before"] if case["before"] is not None else None

    seq = list(case["rand"])
    pulled = {"n": 0}

    class _Random:
        """A stand-in for the `random` MODULE, not a patch of `randint` on it: the real one
        is process-global and shared with everything else the interpreter is doing."""

        @staticmethod
        def randint(_lo, _hi):
            i = pulled["n"]
            pulled["n"] += 1
            return seq[min(i, len(seq) - 1)]

    old = (report_snapshots._settings, report_snapshots.random,
           report_snapshots.date, report_snapshots.datetime)
    report_snapshots._settings = store
    report_snapshots.random = _Random
    report_snapshots.date = _FixedDate(case["today"])
    report_snapshots.datetime = _FixedDateTime(case["now"])
    try:
        rid = report_snapshots.save_snapshot(case["selection"], updated_by=case.get("by"))
    finally:
        (report_snapshots._settings, report_snapshots.random,
         report_snapshots.date, report_snapshots.datetime) = old

    after = json.loads(store.value) if store.value else {}
    return {
        "rid": rid,
        # Key ORDER is part of the answer: the prune keeps a dict, and the order it leaves
        # behind decides which entries a later prune calls equal-and-older.
        "keys": list(after.keys()),
        "after": after,
        "updatedBy": store.updated_by,
        "randCalls": pulled["n"],
    }


def _load_case(case: dict) -> dict:
    """`_load` and `get_snapshot` over a stored string that may be anything at all."""
    store = _Store()
    store.value = case["raw"]
    old = report_snapshots._settings
    report_snapshots._settings = store
    try:
        loaded = report_snapshots._load()
        return {
            "keys": sorted(loaded.keys()),
            # get_snapshot over the ids the Node side asks about — a hit, a miss, and the
            # two falsy ids that short-circuit before the store is even read.
            "get": [report_snapshots.get_snapshot(r) for r in case["get"]],
            "getNone": report_snapshots.get_snapshot(None),
        }
    finally:
        report_snapshots._settings = old


def main() -> None:
    payload = json.loads(sys.stdin.read())
    all_keys = list(NS["_ALL_KEYS"])
    all_sec_ids = list(NS["_ALL_SEC_IDS"])

    out: dict = {
        # The catalogue as report.py actually spells it, so the server's copy is checked
        # against the source rather than against a second transcription.
        "catalog": [
            {"id": sid, "label": label, "items": [{"key": k, "label": lbl} for k, lbl in items]}
            for sid, label, items in NS["_REPORT_SECTIONS"]
        ],
        "allKeys": all_keys,
        "allSecIds": all_sec_ids,
        "restoreItems": [],
        "restoreSecs": [],
        "changed": [],
        "saves": [],
        "loads": [],
    }

    for c in payload["restoreItems"]:
        keys = c.get("allKeys", all_keys)
        got = report_snapshots.restore_items(c["items"], keys, c.get("universe"))
        out["restoreItems"].append(sorted(got))

    for c in payload["restoreSecs"]:
        ids = c.get("allSecIds", all_sec_ids)
        got = eval(EXPRS["_restored_secs"],  # noqa: S307 — report.py's own text
                   {"_secs_saved": c["secs"], "_ALL_SEC_IDS": ids, "list": list})
        out["restoreSecs"].append(list(got))

    # "✎ Selections changed" — the two signatures compared as report.py compares them.
    # The TUPLES themselves are not comparable across the two languages (a Python tuple of
    # mixed types against a JSON array), so what is checked is the verdict they produce,
    # which is the only thing the page reads them for.
    for c in payload["changed"]:
        snap = c["snap"]
        g = {"_snap": snap, "_sel": _sel_for(snap), "int": int, "sorted": sorted,
             "period_mode": c["cur"]["period"], "year_override": c["cur"]["year"],
             "month_override": c["cur"]["month"], "bucket_mode": c["cur"]["view"],
             "_picked_secs": c["cur"]["secs"], "_selected_items": c["cur"]["items"]}
        try:
            cur = eval(EXPRS["_cur_sig"], dict(g))       # noqa: S307
            snp = eval(EXPRS["_snap_sig"], dict(g))      # noqa: S307
            out["changed"].append({"changed": cur != snp, "crash": False})
        except (TypeError, ValueError) as exc:
            # `int(_sel("year", 0))` on a stored null. The page has no except around it, so
            # this is a 500 in Streamlit; recorded rather than smoothed over.
            out["changed"].append({"changed": None, "crash": True, "err": type(exc).__name__})

    for c in payload["saves"]:
        out["saves"].append(_save(c))

    for c in payload["loads"]:
        out["loads"].append(_load_case(c))

    print(json.dumps(out, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
