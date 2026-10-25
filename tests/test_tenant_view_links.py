"""Super_user view-as must survive the trip into a new tab.

Two regressions, one symptom ("clicking a tenant opens my own account"):

* The Settings → Tenants LinkColumn opened its link with
  ``window.open(url, "_blank", "noopener,noreferrer")`` — a non-empty features string, which
  Chrome/Edge treat as a POPUP request, so the tenant opened in a separate WINDOW. The
  links are now plain anchors (`new_tab_link`), which open a tab.
* A new tab is a new session. Where the session cookie is unreadable behind the host's
  proxy, App.py bounces through /login and resumes the page afterwards — with a bare
  `st.switch_page`, which CLEARS the query string. ?tenant=<slug> went with it and the
  super_user landed on their own tenant. `switch_with_params` carries the query across.
"""
from __future__ import annotations

import os
import sys
import types
import unittest
from unittest import mock

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core import ui_links  # noqa: E402


def _fake_streamlit(switch_page):
    return types.SimpleNamespace(switch_page=switch_page, query_params={},
                                 session_state={})


class NewTabLinkTests(unittest.TestCase):
    def test_plain_anchor_opens_a_tab_not_a_popup(self):
        with mock.patch.dict(sys.modules, {"streamlit": _fake_streamlit(None)}):
            html = ui_links.new_tab_link("CHAI Mali", "organization", tenant="chai-mali")
        self.assertIn("href='/organization?tenant=chai-mali'", html)
        self.assertIn("target='_blank'", html)
        self.assertNotIn("window.open", html)
        self.assertIn(">CHAI Mali</a>", html)

    def test_label_is_escaped(self):
        with mock.patch.dict(sys.modules, {"streamlit": _fake_streamlit(None)}):
            html = ui_links.new_tab_link("<b>x</b>", "organization", tenant="t")
        self.assertIn("&lt;b&gt;x&lt;/b&gt;", html)


class SwitchWithParamsTests(unittest.TestCase):
    def test_query_travels_with_the_switch(self):
        calls = []

        def switch_page(script, *, query_params=None):
            calls.append((script, query_params))

        with mock.patch.dict(sys.modules, {"streamlit": _fake_streamlit(switch_page)}):
            ui_links.switch_with_params(
                "app_pages/organization.py",
                {"tenant": "chai-mali", "label": "CHAI Mali", "empty": ""})
        self.assertEqual(calls, [("app_pages/organization.py",
                                  {"tenant": "chai-mali", "label": "CHAI Mali"})])

    def test_older_streamlit_falls_back_to_setting_the_query(self):
        calls = []

        def switch_page(script):           # no query_params argument
            calls.append(script)

        fake = _fake_streamlit(switch_page)
        with mock.patch.dict(sys.modules, {"streamlit": fake}):
            ui_links.switch_with_params("app_pages/organization.py", {"tenant": "x"})
        self.assertEqual(calls, ["app_pages/organization.py"])
        self.assertEqual(fake.query_params, {"tenant": "x"})


def _grid_app():
    import os
    import sys

    import streamlit as st
    sys.path.insert(0, os.environ["RFPIS_ROOT"])
    from views.account_sections import _render_tenant_grid

    def row(name, slug):
        return {"id": slug, "slug": slug, "name": name, "Kind": "🏢 Org", "Dev": "🙂 Regular",
                "Parent": "—", "Sharing": "—", "Status": "🟢 Active", "Members": 1,
                "Pending": 0, "Profile": "set", "Created": "2026-10-22"}

    picked = _render_tenant_grid([row("CHAI Cameroon", "chai-cameroon"),
                                  row("CHAI Mali", "chai-mali")])
    st.text("picked=" + ",".join(r["name"] for r in picked))


class TenantGridTests(unittest.TestCase):
    """The manage-tenants table keeps the NAME as the link (a tab, not a popup window)
    and still lets rows be ticked for the bulk actions."""

    @classmethod
    def setUpClass(cls):
        # Another module installs a fake `streamlit` and does not restore it; AppTest needs
        # the real one (same guard as test_opportunity_page_renders).
        #
        # The app modules the script imports have to go with it. `views.account_sections`
        # binds `import streamlit as st` at ITS import, so a copy already in sys.modules
        # still points at the streamlit object being dropped here. AppTest then runs the
        # script against the FRESH streamlit while _render_tenant_grid renders through the
        # stale one, whose per-thread state this thread never initialised —
        # "FragmentThreadState not initialized", and only when some earlier suite happened
        # to import account_sections first. Dropping it too makes the script's own import
        # re-bind it to the streamlit AppTest is using.
        import importlib
        _APP_MODULES = ("views.account_sections",)
        cls._saved = {n: sys.modules.pop(n) for n in list(sys.modules)
                      if n == "streamlit" or n.startswith("streamlit.")
                      or n in _APP_MODULES}
        importlib.import_module("streamlit")
        os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
        os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")
        os.environ["RFPIS_ROOT"] = _ROOT

    @classmethod
    def tearDownClass(cls):
        for n in [n for n in list(sys.modules)
                  if n == "streamlit" or n.startswith("streamlit.")
                  or n in cls._saved]:
            del sys.modules[n]
        sys.modules.update(cls._saved)

    def _run(self):
        from streamlit.testing.v1 import AppTest
        at = AppTest.from_function(_grid_app, default_timeout=60)
        at.run()
        self.assertFalse(at.exception, [e.value for e in at.exception])
        return at

    def test_name_is_a_new_tab_link_in_the_table(self):
        at = self._run()
        links = [m.value for m in at.markdown if "<a href=" in m.value]
        self.assertEqual(len(links), 2)
        self.assertIn("href='/organization?tenant=chai-mali'", links[1])
        self.assertIn("target='_blank'", links[1])
        self.assertFalse(at.dataframe, "the manage view must not fall back to a LinkColumn")

    def test_ticking_a_row_selects_it(self):
        at = self._run()
        at.checkbox(key="tn_sel_chai-mali").check().run()
        self.assertIn("picked=CHAI Mali", [t.value for t in at.text])


if __name__ == "__main__":
    unittest.main()
