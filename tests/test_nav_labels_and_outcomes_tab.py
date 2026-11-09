"""The rail says what the work is called, and carries nothing that is not work.

Owner, 2026-11-09. Two changes.

1. RENAMES, and "Grants" moved. It was its own rail page; it is the last stage of the
   same lifecycle the Pipeline tabs already walk - screened, reviewed, tracked, then what
   came of it - so it is now the "Outcomes" tab, placed BEFORE Summary so the summary
   stays the closing read of the whole pipeline.

2. LEFTOVERS IN THE COLLAPSED RAIL. Seven pages are registered only so their URLs
   resolve (an emailed activation link, a feed item's /opportunity deep link, the
   top-right menu). They were hidden by a CSS rule matching the href suffix, and they
   still appeared in the COLLAPSED rail as a row of unexplained icons. Matching the
   LABEL instead works in both states and does not depend on how Streamlit spells the
   href - slug vs title, trailing slash, or a base path in front of it.

Run:  python -m unittest tests.test_nav_labels_and_outcomes_tab
"""
import io
import os
import re
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


def _src(rel):
    return io.open(os.path.join(_ROOT, rel), encoding="utf-8").read()


class TheRailLabelsTests(unittest.TestCase):
    def setUp(self):
        self.app = _src("App.py")

    def test_every_renamed_page_carries_its_new_title(self):
        for title, page in (("Dashboard", "home.py"),
                            ("Funding Pipeline", "pipelines.py"),
                            ("Meeting Actions", "actions.py"),
                            ("Funding Report", "report.py"),
                            ("Donor Intelligence", "donors.py"),
                            ("My Organization", "organization.py"),
                            ("Submit new notice", "submit_rfp.py")):
            self.assertRegex(self.app, r'title="%s"' % re.escape(title),
                             "%s should be titled %r" % (page, title))

    def test_the_old_labels_are_gone(self):
        # Two rounds of renames, both the owner's: 2026-11-09 morning (the first seven)
        # and the same day (Home, Fundraising Report, Submit New RFP). A superseded label
        # left behind in one place is how a rail and a breadcrumb start disagreeing.
        for old in ('title="Pipelines"', 'title="Grants"', 'title="Actions"',
                    'title="Report"', 'title="Donors"', 'title="Tenant"',
                    'title="Submit"', 'title="Home"',
                    'title="Fundraising Report"', 'title="Submit New RFP"'):
            self.assertNotIn(old, self.app)

    def test_the_breadcrumb_titles_match_the_rail(self):
        # core/ui_links.py::PAGE_TITLES is a second copy of these names, and a rename that
        # updates one and not the other shows a page called two things in one session.
        #
        # Asserted against the MAPPING, not the file text. The first draft of this grepped
        # the source and failed on a COMMENT that happened to mention another app's label
        # for the same page — a test that cannot tell a value from prose about a value.
        from core.ui_links import PAGE_TITLES
        for slug, name in (("home", "Dashboard"), ("pipelines", "Funding Pipeline"),
                           ("actions", "Meeting Actions"), ("report", "Funding Report"),
                           ("donors", "Donor Intelligence"),
                           ("organization", "My Organization"),
                           ("submit-new-rfp", "Submit new notice")):
            self.assertEqual(PAGE_TITLES[slug], name)
        for gone in ("Fundraising Report", "Submit New RFP", "Home"):
            self.assertNotIn(gone, PAGE_TITLES.values())

    def test_outcomes_keeps_its_own_name_here(self):
        # The one place the two apps deliberately differ. This is a TAB inside Funding
        # Pipeline, where the stages around it supply the context; React still has it as a
        # standalone rail page and calls it "Proposals submitted". Owner, 2026-11-09:
        # "do not change for streamlit as it is now moved to pipeline screen as a tab".
        from core.ui_links import PAGE_TITLES
        self.assertEqual(PAGE_TITLES["grants"], "Outcomes")
        self.assertEqual(PAGE_TITLES["outcomes"], "Outcomes")
        self.assertNotIn("Proposals submitted", PAGE_TITLES.values())

    def test_the_breadcrumb_root_is_not_a_hard_coded_word(self):
        # The crumb fallback said "Home" and survived two renames of the page it names.
        # Both apps now fall back to whatever the root page is actually called.
        from core.ui_links import PAGE_TITLES, _ROOT_PAGE
        self.assertNotIn('or "Home"', _src("core/ui_links.py"))
        self.assertEqual(PAGE_TITLES[_ROOT_PAGE], "Dashboard")

    def test_the_url_slugs_are_unchanged(self):
        # Renaming a label must not break a bookmark or an emailed link.
        for slug in ("pipelines", "actions", "report", "donors", "organization",
                     "submit-new-rfp"):
            self.assertIn('url_path="%s"' % slug, self.app)

    def test_grants_is_no_longer_a_rail_page(self):
        self.assertNotIn("app_pages/grants.py", self.app)


class TheOutcomesTabTests(unittest.TestCase):
    def test_the_view_exists_where_render_view_looks_for_it(self):
        self.assertTrue(os.path.exists(os.path.join(_ROOT, "views", "outcomes.py")))
        self.assertFalse(os.path.exists(os.path.join(_ROOT, "app_pages", "grants.py")))

    def test_outcomes_sits_before_summary(self):
        s = _src("app_pages/pipelines.py")
        self.assertIn('["Screen", "Review", "Track", "Outcomes", "Summary"]', s)
        self.assertLess(s.index('render_view("outcomes")'),
                        s.index('render_view("summary_rfp")'))

    def test_the_old_slug_still_resolves(self):
        # A saved /grants link must land somewhere real rather than 404.
        s = _src("core/ui_links.py")
        self.assertIn('"grants": "app_pages/pipelines.py"', s)
        self.assertNotIn('"grants": "app_pages/grants.py"', s)

    def test_nothing_still_points_at_the_moved_file(self):
        for rel in ("App.py", "app_pages/home.py", "core/ui_links.py",
                    "core/site_search.py"):
            self.assertNotIn("app_pages/grants.py", _src(rel), rel)


class TheHiddenLeftoversTests(unittest.TestCase):
    """The seven registered-but-not-rail pages."""

    LEFTOVERS = ("opportunity", "profile", "help", "search",
                 "sign in", "activate", "reset password")

    def setUp(self):
        self.hdr = _src("core/app_header.py")

    def test_every_leftover_is_named_in_the_label_hide_list(self):
        m = re.search(r"const HIDE = \[(.*?)\];", self.hdr, re.S)
        self.assertIsNotNone(m, "the HIDE list should be emitted into the nav script")
        listed = {t.strip().strip("'\"").lower() for t in m.group(1).split(",")}
        for name in self.LEFTOVERS:
            self.assertIn(name, listed)

    def test_the_hide_runs_again_after_streamlit_rerenders(self):
        # The rail is rebuilt on every rerun and when it collapses, which is exactly the
        # state the icons were surviving in - a one-shot pass would not hold.
        self.assertIn("MutationObserver(apply)", self.hdr)
        self.assertIn("hideLeftovers()", self.hdr)

    def test_it_hides_the_row_not_only_the_anchor(self):
        self.assertIn("stSidebarNavLinkContainer", self.hdr)

    def test_the_href_css_is_kept_as_well(self):
        # Belt and braces: the CSS still covers the expanded rail.
        for slug in ("/profile", "/help", "/search", "/opportunity", "/login",
                     "/activate-account", "/password-reset"):
            self.assertIn('a[href$="%s" i]' % slug, self.hdr)

    def test_the_script_has_no_escape_that_python_would_eat(self):
        # A non-raw triple-quoted payload once ate a newline escape here and silently
        # broke the whole script - the JS never ran and the button it wired did nothing.
        # This payload is only safe because it contains no backslash at all, so assert
        # that on the emitted text rather than trusting the source to stay that way.
        m = re.search(r"const HIDE = \[.*?MutationObserver\(apply\)", self.hdr, re.S)
        self.assertIsNotNone(m)
        self.assertNotIn(chr(92), m.group(0),
                         "no backslash in the payload, or a non-raw string may eat it")

    def test_settings_is_not_hidden(self):
        m = re.search(r"const HIDE = \[(.*?)\];", self.hdr, re.S)
        self.assertNotIn("settings", m.group(1).lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
