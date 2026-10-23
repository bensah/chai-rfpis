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


if __name__ == "__main__":
    unittest.main()
