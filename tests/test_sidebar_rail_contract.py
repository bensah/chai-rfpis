"""The sidebar rail depends on Streamlit DOM details. Pin the ones we rely on.

WHAT HAPPENED. The whole icon rail hangs off one attribute. Older Streamlit marked a
collapsed sidebar `aria-expanded="false"`; 1.66 marks it `data-collapsed="true"` and
drops aria-expanded entirely. Every rail rule was written for the old spelling, so after
a routine reinstall they matched NOTHING — not "less specifically", nothing — and the
sidebar fell back to Streamlit's native collapse, which slides it fully off-screen.
It vanished at sign-in with no way back, and no code had changed.

The floating » that reopens it was unreachable for a second, independent reason: the app
positioned it with top/left/z-index while Streamlit laid it out STATICALLY, where those
three properties do nothing. It rendered at the top of the page under the fixed app bar.
Fixing that exposed a third: the button lives inside `stHeader`, a positioned element with
a z-index and therefore a STACKING CONTEXT, so its own z-index could never lift it past
the sidebar — Streamlit gives the sidebar 999991 and stHeader 999990, one apart, and the
rail painted over the only control that reopens it.

These tests assert the contract, not the appearance: both spellings are addressed, the
button is positioned and stacked above the sidebar, and the login screen hides it by its
current name. `requirements.txt` does not pin Streamlit, so the DOM can move under this
stylesheet again; these fail loudly if someone "tidies" the duplication away.
"""
from __future__ import annotations

import os
import re
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# Streamlit's own z-index for the sidebar, observed in 1.66. The expand button's
# containing stacking context has to beat this or the rail covers the button.
STREAMLIT_SIDEBAR_Z = 999991
# The fixed app bar this stylesheet draws; Streamlit's chrome must stay below it.
APP_BAR_Z = 1000000

COLLAPSED_OLD = '[aria-expanded="false"]'
COLLAPSED_NEW = '[data-collapsed="true"]'


class SidebarRailContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from core.app_header import _GLOBAL_CSS
        cls.css = _GLOBAL_CSS

    def test_both_collapsed_spellings_are_addressed(self):
        """Neither spelling may be dropped: one covers today's Streamlit, one covers the
        build this app ran on before, and nobody notices the loss until the rail is gone."""
        old, new = self.css.count(COLLAPSED_OLD), self.css.count(COLLAPSED_NEW)
        self.assertGreater(old, 0, "no rule targets the old collapsed spelling")
        self.assertEqual(old, new,
                         f"{old} rules use {COLLAPSED_OLD} but {new} use {COLLAPSED_NEW} — "
                         "every collapsed-sidebar rule must name both")

    def test_expanded_spellings_match_too(self):
        self.assertEqual(self.css.count('[aria-expanded="true"]'),
                         self.css.count('[data-collapsed="false"]'))

    def test_the_rail_rule_itself_names_both(self):
        """The rule that puts the collapsed sidebar back on screen — the one whose failure
        made it disappear. Its selector list must carry both spellings."""
        m = re.search(r'([^{}]*\[data-collapsed="true"\][^{}]*)\{\s*transform: none', self.css)
        self.assertIsNotNone(m, "no rule restores the collapsed sidebar with transform:none")
        self.assertIn(COLLAPSED_OLD, m.group(1))

    def test_expand_button_is_positioned_not_static(self):
        """top/left/z-index are inert on a statically laid-out element, which is how
        Streamlit 1.66 renders this button."""
        rule = self._rule_for('[data-testid="stExpandSidebarButton"]')
        self.assertRegex(rule, r"position:\s*fixed",
                         "the expand button sets offsets but never positions itself")

    def test_expand_buttons_stacking_context_clears_the_sidebar(self):
        """The button cannot escape stHeader's stacking context, so stHeader is what has
        to out-stack the sidebar — and still sit below the app bar."""
        rule = self._rule_for('[data-testid="stHeader"]')
        m = re.search(r"z-index:\s*(\d+)", rule)
        self.assertIsNotNone(m, "stHeader has no z-index, so the rail paints over the "
                                "expand button it contains")
        z = int(m.group(1))
        self.assertGreater(z, STREAMLIT_SIDEBAR_Z, "stHeader must out-stack the sidebar")
        self.assertLess(z, APP_BAR_Z, "stHeader must stay below the fixed app bar")

    def test_login_screen_hides_the_expand_button_by_its_current_name(self):
        """Hiding the sidebar alone leaves its » on the login screen, offering an
        anonymous visitor the page nav. 'collapsedControl' is Streamlit's retired name."""
        import inspect

        from auth import authenticator
        src = inspect.getsource(authenticator._hide_sidebar_on_login)
        self.assertIn("stExpandSidebarButton", src)

    def _rule_for(self, selector: str) -> str:
        """The declaration block of the first rule whose selector list contains `selector`
        and which is NOT inside a media query (i.e. the base, desktop rule)."""
        base = self.css.split("@media")[0]
        idx = base.find(selector)
        self.assertNotEqual(idx, -1, f"no base rule for {selector}")
        start = base.index("{", idx)
        return base[start:base.index("}", start)]


if __name__ == "__main__":
    unittest.main()
