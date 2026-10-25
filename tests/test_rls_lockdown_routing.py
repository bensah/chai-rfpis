"""Migration 098 closes the shared tables to the anon and authenticated roles. These tests
pin the code side of that: a live session's get_client() must send the SERVICE-ONLY tables
(users, password_reset_requests, …) to the service-role client, send writes to the
READ-ONLY tables (donor_intel, scan_logs, …) there too, and keep their reads on the
session's tenant JWT client. If a table is in the migration but not in the Python sets (or
the other way round), a logged-in user gets "permission denied" — so the lists are compared.

Pure unit tests: no network. A fake `streamlit` supplies session_state for each test.

Run:  python -m unittest tests.test_rls_lockdown_routing   (from the repo root)
"""
import os
import re
import sys
import types
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


os.environ["SUPABASE_JWT_SECRET"] = "test-secret"
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

import db.supabase_client as sc            # noqa: E402
import auth.tenant_context as tc           # noqa: E402

ORG_A = "28b17088-4d52-4546-85fb-5a14ba9ae22c"
_MIGRATION = os.path.join(_ROOT, "db", "migrations", "098_rls_lockdown_shared_tables.sql")


class _Builder:
    """Records which client a builder came from and which verb was called on it."""

    def __init__(self, tag, name):
        self.tag, self.name = tag, name

    def _verb(self, verb):
        return lambda *a, **k: (self.tag, self.name, verb)

    def __getattr__(self, verb):
        return self._verb(verb)


class _FakeBase:
    def __init__(self, tag):
        self.tag = tag

    def table(self, name):
        return _Builder(self.tag, name)


def _migration_array(var: str) -> set[str]:
    with open(_MIGRATION, encoding="utf-8") as f:
        sql = f.read()
    m = re.search(var + r"\s+text\[\]\s*:=\s*array\[(.*?)\];", sql, re.S)
    assert m, f"{var} not found in {_MIGRATION}"
    return set(re.findall(r"'([a-z_]+)'", m.group(1)))


class RlsLockdownRoutingTests(unittest.TestCase):
    def setUp(self):
        self._svc = _FakeBase("SERVICE")
        self._jwt = _FakeBase("JWT")
        self._orig = (sc.service_client, sc._session_tenant_client)
        sc.service_client = lambda: self._svc
        sc._session_tenant_client = lambda: self._jwt
        tc._TENANT_OVERRIDE.set(None)
        os.environ["SUPABASE_JWT_SECRET"] = "test-secret"
        # A fake `streamlit` for THIS test only (get_client resolves it lazily), restored in
        # tearDown — leaving a bare stub installed would break later-collected modules that
        # use st.cache_data at import.
        self._orig_st = sys.modules.get("streamlit")
        fake = types.ModuleType("streamlit")
        fake.session_state = {"app_user": {"role": "collaborator"}, "tenant_id": ORG_A,
                              "_tenant_jwt": "jwt"}
        sys.modules["streamlit"] = fake

    def tearDown(self):
        sc.service_client, sc._session_tenant_client = self._orig
        if self._orig_st is None:
            sys.modules.pop("streamlit", None)
        else:
            sys.modules["streamlit"] = self._orig_st

    def test_service_only_tables_never_use_the_jwt_client(self):
        c = sc.get_client()
        for t in sorted(sc._SERVICE_ONLY_TABLES):
            for verb in ("select", "insert", "upsert", "update", "delete"):
                self.assertEqual(getattr(c.table(t), verb)(), ("SERVICE", t, verb), (t, verb))

    def test_read_only_tables_read_on_jwt_and_write_on_service(self):
        c = sc.get_client()
        for t in sorted(sc._SERVICE_WRITE_TABLES):
            self.assertEqual(c.table(t).select("*"), ("JWT", t, "select"), t)
            for verb in ("insert", "upsert", "update", "delete"):
                self.assertEqual(getattr(c.table(t), verb)({}), ("SERVICE", t, verb), (t, verb))

    def test_tenant_tables_still_go_through_the_jwt_client(self):
        b = sc.get_client().table("rfp_submissions")
        self.assertIsInstance(b, sc._ScopedTable)
        self.assertEqual(b._b.tag, "JWT")

    def test_python_sets_match_migration_098(self):
        self.assertEqual(sc._SERVICE_ONLY_TABLES, _migration_array("_service_only"))
        self.assertEqual(sc._SERVICE_WRITE_TABLES, _migration_array("_read_only"))

    def test_no_locked_table_is_also_tenant_scoped(self):
        locked = sc._SERVICE_ONLY_TABLES | sc._SERVICE_WRITE_TABLES
        self.assertFalse(locked & sc._TENANT_SCOPED_TABLES)


if __name__ == "__main__":
    unittest.main(verbosity=2)
