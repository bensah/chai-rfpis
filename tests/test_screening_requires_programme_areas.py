"""A tenant with no programme areas must not be auto-screened.

THE REPORTED CASE. One review week filled with 31 rows nobody could use: a Finnish
trade-and-investment scheme, a UK anti-slavery fund, and a run of foreign procurement
notices, in a health organisation's pipeline. The owner's words: "all opportunities on
Week 33 seem to have leaked ... off theme ... they are all supposed to be rejected."

WHY. The tenant's profile declares no programme areas, so:

  * `_blank_policies()` sets `themes.required_any = []`
  * `_seed_themes_from_profile()` cannot repair it - there are no areas to seed from
  * `theme_eligible()` short-circuits an empty list to "no theme requirements set",
    which is an unconditional PASS

so the tenant had no sector filter at all and was screened on geography alone - which a
tier-open call ("LMICs", "Global South") satisfies for everyone. Roughly two thirds of
the leaked rows would have been rejected outright by a theme list.

Screening anyway asks a reviewer to hand-filter a list the system was supposed to filter,
and it hides the real cause. An empty pipeline that names the missing profile is more
useful than a full one that means nothing.

Run:  python -m unittest tests.test_screening_requires_programme_areas
"""
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from core import scan_pipeline as SP                                  # noqa: E402


class _Policies:
    """Stands in for core.policies.get_policies."""

    def __init__(self, value):
        self.value = value

    def __call__(self, tenant_id=None):
        if isinstance(self.value, Exception):
            raise self.value
        return self.value


class TheBlockTests(unittest.TestCase):
    def _with(self, policies):
        import core.policies as P
        orig = P.get_policies
        P.get_policies = _Policies(policies)
        self.addCleanup(lambda: setattr(P, "get_policies", orig))

    def test_a_tenant_with_no_programme_areas_is_blocked(self):
        self._with({"themes": {"required_any": [], "excluded_any": []}})
        reason = SP.tenant_screening_blocked("t1")
        self.assertTrue(reason)
        self.assertIn("programme areas", reason)

    def test_a_tenant_with_a_theme_list_is_screened(self):
        self._with({"themes": {"required_any": ["health", "malaria"]}})
        self.assertEqual(SP.tenant_screening_blocked("t1"), "")

    def test_a_shipped_exclusion_list_does_not_unblock(self):
        # The first version of this guard treated any exclusion list as a deliberate
        # choice. `excluded_any` ships pre-populated with ~20 terms, so that disabled the
        # guard for every tenant - including the one it was written for. Verified against
        # the live tenant: required_any [] and excluded_any 20 terms, and it reported
        # "screened".
        self._with({"themes": {"required_any": [],
                               "excluded_any": ["clinical trial", "preclinical",
                                                "anti-corruption"]}})
        self.assertTrue(SP.tenant_screening_blocked("t1"))

    def test_geography_alone_does_not_unblock(self):
        # The trap worth guarding: a tenant can have a perfectly good geography and still
        # have no sector filter, and a tier-open call satisfies any geography.
        self._with({"themes": {"required_any": []},
                    "countries": {"eligible": ["Kenya"]}})
        self.assertTrue(SP.tenant_screening_blocked("t1"))

    def test_a_policy_that_cannot_be_read_fails_closed(self):
        # get_setting returns the CODE default on a transient error, and for scan_policies
        # that default is an empty theme list - so a flaky read must not look like
        # "configured with no themes".
        self._with(RuntimeError("connection reset"))
        reason = SP.tenant_screening_blocked("t1")
        self.assertTrue(reason)
        self.assertIn("could not be read", reason)

    def test_the_reason_names_what_a_human_can_fix(self):
        self._with({"themes": {"required_any": []}})
        self.assertIn("set the tenant's programme areas",
                      SP.tenant_screening_blocked("t1"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
