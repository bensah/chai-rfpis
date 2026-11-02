"""Which donor name a registry host hands back, once who.int is a primary.

Owner, 2026-11-02: "Yes, add WHO."

Registering `who.int` fixes a page that could not name its own funder, but it
also puts a PARENT host in the primary list under a child that was already
there: `ahpsr.who.int` has been a confirmed primary since June, carrying the
Alliance for Health Policy and Systems Research. `primary_donor_name` walks
parents when the exact host is unknown, so the plausible regression is the
child quietly inheriting "World Health Organization" and every AHPSR call being
relabelled WHO. It does not, because the exact host is matched first — and that
ordering is the only thing standing between the two, so it is pinned here.
"""
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from core import source_registry                                    # noqa: E402

# The live registry's shape after the WHO row is confirmed.
HOSTS = {
    "who.int": "World Health Organization",
    "ahpsr.who.int": "Alliance for Health Policy and Systems Research",
    "theglobalfund.org": "The Global Fund",
    "worldbank.org": "",            # a primary with no curated name
}


class DonorNameTests(unittest.TestCase):
    def setUp(self):
        self._orig = source_registry.primary_hosts
        source_registry.primary_hosts = lambda force=False: HOSTS

    def tearDown(self):
        source_registry.primary_hosts = self._orig

    def test_a_who_call_page_names_who(self):
        self.assertEqual(
            source_registry.primary_donor_name(
                "https://www.who.int/news-room/articles-detail/call-for-proposals"),
            "World Health Organization")

    def test_the_www_prefix_does_not_hide_the_host(self):
        self.assertEqual(source_registry.primary_donor_name("https://www.who.int/x"),
                         "World Health Organization")

    def test_ahpsr_keeps_its_own_name(self):
        # THE REGRESSION THIS FILE EXISTS FOR. An exact host match must win over
        # the parent walk, or every AHPSR call is relabelled WHO.
        self.assertEqual(
            source_registry.primary_donor_name("https://ahpsr.who.int/call-for-proposals"),
            "Alliance for Health Policy and Systems Research")

    def test_an_unnamed_subdomain_inherits_the_parent(self):
        # This IS the parent walk doing its job: nobody has curated a name for
        # extranet.who.int, and WHO is a better answer than none.
        self.assertEqual(source_registry.primary_donor_name("https://extranet.who.int/a"),
                         "World Health Organization")

    def test_a_lookalike_does_not_inherit(self):
        # "notwho.int" ends with the registered host as a STRING but is a
        # different registrant; the dot in "." + host is what rules it out.
        self.assertIsNone(source_registry.primary_donor_name("https://notwho.int/a"))

    def test_a_primary_with_no_curated_name_yields_none(self):
        self.assertIsNone(source_registry.primary_donor_name("https://worldbank.org/x"))

    def test_an_unknown_host(self):
        self.assertIsNone(source_registry.primary_donor_name("https://example.org/x"))

    def test_nothing(self):
        self.assertIsNone(source_registry.primary_donor_name(None))
        self.assertIsNone(source_registry.primary_donor_name(""))


class IsRegistryPrimaryTests(unittest.TestCase):
    def setUp(self):
        self._orig = source_registry.primary_hosts
        source_registry.primary_hosts = lambda force=False: HOSTS

    def tearDown(self):
        source_registry.primary_hosts = self._orig

    def test_who_counts(self):
        self.assertTrue(source_registry.is_registry_primary("https://www.who.int/x"))

    def test_a_subdomain_counts(self):
        self.assertTrue(source_registry.is_registry_primary("https://cdn.who.int/a.pdf"))

    def test_a_lookalike_does_not(self):
        self.assertFalse(source_registry.is_registry_primary("https://notwho.int/a"))


if __name__ == "__main__":
    unittest.main()
