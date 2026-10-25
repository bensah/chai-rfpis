"""Viewing another tenant must show what that tenant's people see.

WHAT HAPPENED. A super_user opened CHAI Mali through the view-as flow and the header
said so, but Settings → Accounts still listed every account on the platform, donor
editing was still live, and the developer-only tabs were still there. The data pages
scoped correctly — `db.supabase_client.get_client()` already resolves su_view_tenant —
but everything gated on ROLE did not, because a super_user stayed a super_user inside
the lens. The point of view-as is to see the app as the tenant's own admins see it, and
a lens that keeps super powers shows a screen nobody else can reach.

The fix lowers the EFFECTIVE role for the duration, which drives ~34 call sites at once
instead of editing each page. That creates one trap worth naming: the view-as machinery
itself must keep reading the ACCOUNT's role. Gate "may I stay in this view-as?" on the
lowered role and it revokes itself on the next render — the super is ejected from the
tenant they just opened, every time.

These tests hold both halves: the lens closes what it should, and the machinery that
runs the lens is never gated on the role the lens lowers.
"""
from __future__ import annotations

import ast
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from auth import tenant_context as tc  # noqa: E402
from core import permissions  # noqa: E402

HOME = "home-tenant-aaaa"
OTHER = "other-tenant-bbbb"
SUPER = {"id": "u1", "email": "s@example.invalid", "role": "super_user"}
ADMIN = {"id": "u2", "email": "a@example.invalid", "role": "admin"}
_KEYS = ("tenant_id", "su_view_tenant", "app_user")


def _states():
    """Every session_state object the code under test might read, de-duplicated.

    There can be more than one. Other suites in this process swap
    `sys.modules["streamlit"]` for a fake AFTER `auth.tenant_context` bound its
    module-level `import streamlit as st`, so tenant_context keeps reading the real
    module while permissions.py — which imports lazily, inside the function — reads the
    fake. Writing to just one makes these tests pass alone and fail in the full run,
    which is a property of the pollution, not of the behaviour being tested. Set the
    keys on all of them and the assertions hold either way."""
    import streamlit

    out, seen = [], set()
    for mod in (streamlit, getattr(tc, "st", None)):
        ss = getattr(mod, "session_state", None)
        if ss is not None and id(ss) not in seen:
            seen.add(id(ss))
            out.append(ss)
    return out


def _ss():
    """The primary session_state — what assertions read back."""
    return _states()[0]


def _set(key, value):
    for ss in _states():
        ss[key] = value


def _clear(*keys):
    for ss in _states():
        for k in keys:
            ss.pop(k, None)


class ViewAsLens(unittest.TestCase):
    def setUp(self):
        # A headless per-tenant override (the cron screening loop sets one) outranks the
        # browser session in viewed_tenant_id, and a suite that leaves one behind would
        # silently answer every lookup here. Clear it, and put it back afterwards.
        self._ovr = tc.override_tenant_id()
        tc.set_tenant_override(None)
        self.addCleanup(lambda: tc.set_tenant_override(self._ovr))
        _clear(*_KEYS)
        self.addCleanup(_clear, *_KEYS)
        _set("tenant_id", HOME)

    def view(self, tid):
        _set("su_view_tenant", tid)

    # -- the lens closes what it should -----------------------------------------
    def test_effective_role_drops_to_admin_while_viewing_another_tenant(self):
        self.assertTrue(permissions.is_super_user(SUPER))
        self.view(OTHER)
        self.assertFalse(permissions.is_super_user(SUPER),
                         "a view-as must gate the session as the tenant's admin")
        self.assertTrue(permissions.is_admin(SUPER), "they are still an admin of it")

    def test_the_account_keeps_its_real_role(self):
        self.view(OTHER)
        self.assertTrue(permissions.is_account_super_user(SUPER))

    def test_viewing_your_own_tenant_is_not_a_lens(self):
        """A super_user's own account still carries ?tenant=<their slug>, so su_view_tenant
        equals the session tenant. That is not viewing somebody else and must change
        nothing — this is what made the org editor claim they were editing another org."""
        self.view(HOME)
        self.assertFalse(permissions.viewing_as_other_tenant())
        self.assertTrue(permissions.is_super_user(SUPER))

    def test_developer_surfaces_close_inside_the_lens(self):
        """Donor editing, Sources and Records → Verify hang off these. They key off the
        super's HOME tenant precisely so they survive a view-as, which is right for their
        own account and wrong for the lens."""
        self.view(OTHER)
        self.assertFalse(permissions.is_developer_super(SUPER))
        self.assertFalse(permissions.is_developer_admin(SUPER))
        self.assertFalse(permissions.is_developer_member(SUPER))

    def test_a_plain_admin_is_unaffected(self):
        self.view(OTHER)
        self.assertFalse(permissions.is_super_user(ADMIN))
        self.assertFalse(permissions.is_account_super_user(ADMIN))
        self.assertTrue(permissions.is_admin(ADMIN))

    def test_no_session_means_no_lens(self):
        """Scripts and cron have no browser session; the predicate must not explode or
        quietly lower a headless run's role."""
        _clear("tenant_id", "su_view_tenant")
        self.assertFalse(permissions.viewing_as_other_tenant())
        self.assertTrue(permissions.is_super_user(SUPER))

    # -- reads follow the tenant on screen ---------------------------------------
    def test_viewed_tenant_is_the_one_on_screen_not_the_session_identity(self):
        self.view(OTHER)
        self.assertEqual(tc.viewed_tenant_id(), OTHER)
        self.assertEqual(tc.current_tenant_id(), HOME,
                         "identity stays the super's own — only the view moves")

    def test_viewed_tenant_falls_back_to_your_own(self):
        self.assertEqual(tc.viewed_tenant_id(), HOME)

    # -- the machinery must not be gated on the role it lowers --------------------
    def test_view_as_machinery_uses_the_account_role(self):
        """The self-revoking trap. Each of these decides whether a view-as may start or
        continue, or which tenant a page edits; gate any of them on the EFFECTIVE role and
        the lens switches itself off on the next render."""
        offenders = []
        for rel in ("core/app_header.py", "app_pages/admin.py", "app_pages/organization.py"):
            path = os.path.join(_ROOT, *rel.split("/"))
            src = open(path, encoding="utf-8").read()
            tree = ast.parse(src)
            lines = src.splitlines()
            for node in ast.walk(tree):
                if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                    continue
                if node.func.attr != "is_super_user":
                    continue
                # Only the calls that decide the view-as itself matter. They sit on a line
                # mentioning su_view_tenant, or guard the branch that clears it.
                window = "\n".join(lines[max(0, node.lineno - 3):node.lineno + 2])
                if "su_view_tenant" in window:
                    offenders.append(f"{rel}:{node.lineno}")
        self.assertEqual(offenders, [], "these resolve the view-as and must call "
                                        "is_account_super_user, not is_super_user")


if __name__ == "__main__":
    unittest.main()
