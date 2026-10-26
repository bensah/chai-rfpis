"""Browser stand-in for db/supabase_client.py.

The scoring code reads its inputs through `get_client().table(...)`. In the browser there is
no database connection and no service key: the API has already fetched those rows (RLS
applied, permissions checked) and handed them over as a snapshot. This serves the snapshot
through the same tiny query interface, so NOT ONE LINE of the scoring modules changes.

Only the handful of queries the scoring path actually makes are supported; anything else
returns no rows, exactly as a failed lookup would, and the caller falls back as it already
does for a database hiccup.
"""
from __future__ import annotations

from typing import Any

# Filled by the host before any scoring module is imported (see web/src/scoring/worker.ts).
SNAPSHOT: dict[str, Any] = {}


def seed_fx() -> int:
    """Put the snapshot's exchange rates into core.fx's cache.

    core/fx.py converts non-USD amounts with a LIVE rate fetched over the network. There is
    no httpx in the browser, so that call fails and the code silently falls back to the
    static table in config/dropdowns.yaml — a different rate, which can push a converted
    amount into a different scoring band. Seeding the cache with the rates the server used
    keeps the browser's arithmetic identical to Python's. Returns how many were seeded."""
    import time

    from core import fx
    rates = SNAPSHOT.get("fx_rates") or {}
    for cur, val in rates.items():
        rate, rdate = (val + [None, None])[:2] if isinstance(val, list) else (None, None)
        fx._RATE_CACHE[str(cur).upper()] = (time.monotonic(), (rate, rdate))
    return len(rates)


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    """A postgrest-shaped builder that filters the snapshot in memory."""

    def __init__(self, rows: list[dict]):
        self._rows = rows
        self._limit = None

    # -- filters -----------------------------------------------------------
    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        self._rows = [r for r in self._rows if str(r.get(col)) == str(val)]
        return self

    def neq(self, col, val):
        self._rows = [r for r in self._rows if str(r.get(col)) != str(val)]
        return self

    def in_(self, col, vals):
        wanted = {str(v) for v in (vals or [])}
        self._rows = [r for r in self._rows if str(r.get(col)) in wanted]
        return self

    def is_(self, col, val):
        if val is None or str(val).lower() == "null":
            self._rows = [r for r in self._rows if r.get(col) is None]
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, n):
        self._limit = n
        return self

    def range(self, start, end):
        self._rows = self._rows[start:end + 1]
        return self

    # -- writes: the browser never writes through this client --------------
    def insert(self, *_a, **_k):
        return _Noop()

    def upsert(self, *_a, **_k):
        return _Noop()

    def update(self, *_a, **_k):
        return _Noop()

    def delete(self, *_a, **_k):
        return _Noop()

    def execute(self):
        rows = self._rows if self._limit is None else self._rows[:self._limit]
        return _Result(list(rows))


class _Noop:
    def __getattr__(self, _name):
        return lambda *_a, **_k: self

    def execute(self):
        return _Result([])


def _table_rows(name: str) -> list[dict]:
    snap = SNAPSHOT
    tid = snap.get("tenant_id")
    if name == "donor_intel":
        return snap.get("donor_intel") or []
    if name == "tenants":
        # The graph, plus this tenant's own profile/identity columns.
        out = []
        for t in snap.get("tenants") or []:
            row = dict(t)
            if str(row.get("id")) == str(tid):
                row["org_profile"] = snap.get("org_profile")
                ident = snap.get("org_identity") or {}
                row["org_identity"] = ident.get("org_identity")
                row.setdefault("name", ident.get("name"))
            out.append(row)
        return out
    if name == "tenant_settings":
        settings = dict(snap.get("settings") or {})
        if snap.get("scan_policies") is not None:
            settings.setdefault("scan_policies", snap["scan_policies"])
        return [{"tenant_id": tid, "key": k, "value": v} for k, v in settings.items()]
    if name == "app_settings":
        return [{"key": k, "value": v} for k, v in (snap.get("app_settings") or {}).items()]
    if name == "users":
        return [{"program": p, "is_active": True} for p in (snap.get("user_programs") or [])]
    return []


class _Client:
    def table(self, name):
        return _Query(_table_rows(name))

    def from_(self, name):
        return self.table(name)


_CLIENT = _Client()


def get_client():
    return _CLIENT


def service_client():
    return _CLIENT


def safe_execute(query, *_a, **_k):
    return query.execute()


def is_connectivity_error(_exc) -> bool:
    return False


def secret_lookup(_name: str):
    return (None, None)


_TRANSIENT_EXC: set[str] = set()
