"""A super_user editing another tenant must write to THAT tenant.

WHAT HAPPENED. A super_user opened Settings → Setup while viewing CHAI Mali and saved the
organization profile. The form wrote to the super_user's OWN tenant (RFPIS APP) instead,
because `app_pages/admin.py` called `render_org_setup(user, sb)` with no tenant_id while
every other page honoured the sticky view-as (`su_view_tenant`). The live database still
shows the dent: the RFPIS APP tenant carries `org_identity.org_name = "CHAI Mali"`.

It then reported the wrong cause. `get_org()` returns `tenants.name` as org_name, and
`set_org()` swallowed the tenant rename in a bare `except: pass` — so when the new name
collided with the real CHAI Mali tenant's UNIQUE name, the verification read back the old
name and blamed RLS and the service-role key. Both were fine.

Three rules, enforced mechanically:

  1. Per-tenant config (identity, team roster, scan policies) reads and writes the tenant
     the caller NAMES, not the session's.
  2. A failed rename is reported as a failed rename, never swallowed.
  3. Every caller of `render_org_setup` passes a tenant_id. Rule 3 is the one that bit,
     and it is the one a reviewer cannot see by reading the form.
"""
from __future__ import annotations

import ast
import json
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core import policies as pol  # noqa: E402
from core import settings  # noqa: E402

SESSION_TENANT = "session-tenant-aaaa"
OTHER_TENANT = "other-tenant-bbbb"


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    """The fluent slice of postgrest the settings layer actually uses."""

    def __init__(self, table: "_Table", op: str, payload=None):
        self._t, self._op, self._payload, self._f = table, op, payload, {}

    def eq(self, col, val):
        self._f[col] = val
        return self

    def limit(self, _n):
        return self

    def execute(self):
        rows = self._t.rows
        match = [r for r in rows if all(r.get(k) == v for k, v in self._f.items())]
        if self._op == "select":
            return _Result(list(match))
        if self._op == "update":
            # Only the rename fails: the UNIQUE constraint is on tenants.name, so the
            # org_identity write in the same save goes through. That asymmetry IS the bug
            # — identity stored, name silently dropped.
            if self._t.fail_update is not None and "name" in (self._payload or {}):
                raise RuntimeError(self._t.fail_update)
            for r in match:
                r.update(self._payload)
            return _Result(list(match))
        if self._op == "upsert":
            key = self._t.conflict_key
            for r in rows:
                if all(r.get(k) == self._payload.get(k) for k in key):
                    r.update(self._payload)
                    return _Result([r])
            rows.append(dict(self._payload))
            return _Result([rows[-1]])
        raise AssertionError(self._op)


class _Table:
    def __init__(self, rows, conflict_key=()):
        self.rows, self.conflict_key, self.fail_update = rows, conflict_key, None

    def select(self, _cols):
        return _Query(self, "select")

    def update(self, payload):
        return _Query(self, "update", payload)

    def upsert(self, payload, on_conflict=""):
        self.conflict_key = tuple(c.strip() for c in on_conflict.split(",") if c.strip())
        return _Query(self, "upsert", payload)


class _Client:
    def __init__(self, tenants, tenant_settings):
        self._tables = {"tenants": _Table(tenants), "tenant_settings": _Table(tenant_settings)}

    def table(self, name):
        return self._tables[name]


class TenantScopedEditing(unittest.TestCase):
    def setUp(self):
        self.tenants = [
            {"id": SESSION_TENANT, "name": "RFPIS APP", "org_identity": {}},
            {"id": OTHER_TENANT, "name": "CHAI Mali", "org_identity": {}},
        ]
        self.tenant_settings: list = []
        self.client = _Client(self.tenants, self.tenant_settings)

        # Stand in for auth.tenant_context.tenant_store: an explicit tenant wins, else
        # the session's own — exactly the resolution the real one performs.
        def _ctx(tenant_id=None):
            return (self.client, tenant_id or SESSION_TENANT)

        # Restore on the way out: core.settings is module state shared by the whole test
        # process, and a stub left behind would silently re-point every later test's
        # tenant lookups at this fake.
        _real_ctx = settings._tenant_ctx
        settings._tenant_ctx = _ctx
        self.addCleanup(setattr, settings, "_tenant_ctx", _real_ctx)
        settings.clear_cache()
        self.addCleanup(settings.clear_cache)

    def row(self, tid):
        return next(t for t in self.tenants if t["id"] == tid)

    def setting(self, tid, key):
        for r in self.tenant_settings:
            if r["tenant_id"] == tid and r["key"] == key:
                return r["value"]
        return None

    # -- Rule 1: the named tenant is the one written ------------------------------
    def test_identity_writes_to_the_named_tenant(self):
        settings.set_org({"org_country": "Mali", "org_team": "BD"}, tenant_id=OTHER_TENANT)
        self.assertEqual(self.row(OTHER_TENANT)["org_identity"]["org_country"], "Mali")
        self.assertEqual(self.row(SESSION_TENANT)["org_identity"], {},
                         "the session tenant must be untouched when another is named")

    def test_identity_without_a_tenant_uses_the_session(self):
        settings.set_org({"org_country": "Cameroon"})
        self.assertEqual(self.row(SESSION_TENANT)["org_identity"]["org_country"], "Cameroon")
        self.assertEqual(self.row(OTHER_TENANT)["org_identity"], {})

    def test_team_roster_follows_the_named_tenant(self):
        settings.set_team_members(["Amina Bello"], tenant_id=OTHER_TENANT)
        self.assertEqual(json.loads(self.setting(OTHER_TENANT, "team_members_json")),
                         ["Amina Bello"])
        self.assertIsNone(self.setting(SESSION_TENANT, "team_members_json"))
        self.assertEqual(settings.get_team_members(tenant_id=OTHER_TENANT), ["Amina Bello"])
        self.assertIsNone(settings.get_team_members())

    def test_policies_follow_the_named_tenant(self):
        pol.set_policies({"countries": {"eligible": ["Mali"]}}, tenant_id=OTHER_TENANT)
        self.assertIn("Mali", self.setting(OTHER_TENANT, "scan_policies"))
        self.assertIsNone(self.setting(SESSION_TENANT, "scan_policies"))
        self.assertEqual(
            pol.get_policies(OTHER_TENANT).get("countries", {}).get("eligible"), ["Mali"])

    def test_a_named_tenant_never_inherits_the_shipped_country_defaults(self):
        """_is_scoped_tenant must treat an explicitly named tenant as scoped — otherwise an
        unconfigured tenant silently inherits the deployment's own countries/themes."""
        self.assertTrue(pol._is_scoped_tenant(OTHER_TENANT))

    # -- Rule 2: a failed rename says so ------------------------------------------
    def test_duplicate_name_is_reported_as_a_name_clash(self):
        self.client.table("tenants").fail_update = (
            'duplicate key value violates unique constraint "tenants_name_key" (23505)')
        with self.assertRaises(settings.OrgRenameError) as caught:
            settings.set_org({"org_name": "CHAI Mali"}, tenant_id=SESSION_TENANT)
        msg = str(caught.exception)
        self.assertIn("CHAI Mali", msg)
        self.assertNotIn("SUPABASE_KEY", msg, "the key was never the problem")
        self.assertNotIn("072", msg)
        # The rest of the profile really did land — the message must not imply otherwise.
        self.assertEqual(self.row(SESSION_TENANT)["org_identity"]["org_name"], "CHAI Mali")
        self.assertEqual(self.row(SESSION_TENANT)["name"], "RFPIS APP")

    def test_rename_failure_is_never_silent(self):
        """The bug's shape: identity saved, rename dropped, caller told nothing."""
        self.client.table("tenants").fail_update = "connection reset"
        with self.assertRaises(settings.OrgRenameError):
            settings.set_org({"org_name": "Anything"}, tenant_id=SESSION_TENANT)

    # -- Rule 3: no caller may forget the tenant ----------------------------------
    def test_every_render_org_setup_call_passes_a_tenant(self):
        missing = []
        for rel in ("app_pages/admin.py", "app_pages/organization.py"):
            path = os.path.join(_ROOT, *rel.split("/"))
            tree = ast.parse(open(path, encoding="utf-8").read())
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                fn = node.func
                name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", "")
                if name != "render_org_setup":
                    continue
                passes_tenant = (any(k.arg == "tenant_id" for k in node.keywords)
                                 or len(node.args) >= 3)
                if not passes_tenant:
                    missing.append(f"{rel}:{node.lineno}")
        self.assertEqual(missing, [], "render_org_setup without a tenant_id edits the "
                                      "caller's own tenant, whatever the page is showing")


if __name__ == "__main__":
    unittest.main()
