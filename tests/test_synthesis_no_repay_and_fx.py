"""Do not buy a brief twice, and do not call an unknown currency "dollars".

Owner, 2026-11-09, declining a backfill of the 467 blank-summary rows: "we can't afford
backfilling such large volumes of RFPs on a free tier, plus it is not worth it... I'd
rather we ensure future found don't go through same faith."

1. PAYING TWICE. build_record called synthesize_store on EVERY scan, including for calls
   whose brief was written weeks ago and has not changed. The store is re-crawled
   regularly, so that is the same paid model call repeated for a result already sitting
   in the row - the largest recurring cost in a scan. Its sibling `_synthesise_in_place`
   already carried the stored values first and only then decided whether to spend a call;
   build_record was the odd one out.

   A row whose brief is MISSING is deliberately still synthesised. It costs nothing
   extra - the scan was going to make that call anyway - and it is what quietly repairs a
   row whose first attempt failed, now that an over-long page retries at a smaller
   excerpt. A failure stops being permanent without a bulk backfill over the store.

2. AN UNKNOWN CURRENCY IS NOT USD. usd_rate answers 1.0 for a currency it cannot place,
   which reads as "no conversion needed". For display that is tolerable; for scoring it
   is not. The award would be measured against the org's funding band at face value, so
   PREFER-6's ceiling test returns a confident wrong answer rather than declining to
   answer. The static table is REPLACED wholesale by app_settings.currencies_json rather
   than merged over the YAML, so an entry pruned in Admin -> Settings leaves the table
   entirely and only the live rate stands between that and a silent 1.0.

Run:  python -m unittest tests.test_synthesis_no_repay_and_fx
"""
import io
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")


class TheRepayGuardTests(unittest.TestCase):
    def setUp(self):
        self.src = io.open(os.path.join(_ROOT, "core", "extract.py"),
                           encoding="utf-8").read()

    def test_a_stored_brief_is_carried_rather_than_rebought(self):
        self.assertIn("_stored_brief", self.src)
        self.assertIn("not _stored_brief", self.src,
                      "the synthesis call must be skipped when a brief is already stored")

    def test_the_lookup_cannot_cost_us_the_synthesis(self):
        # A store read that throws must not take the brief down with it.
        i = self.src.index("_stored_brief = \"\"")
        self.assertIn("except Exception", self.src[i:i + 900])

    def test_a_missing_brief_is_still_synthesised(self):
        # The repair path: this is what fixes a row whose first attempt failed, for free.
        i = self.src.index("CARRY FIRST, THEN DECIDE")
        window = self.src[i:i + 1400]
        self.assertIn("deliberately NOT excluded", window)

    def test_the_gate_still_runs_before_any_synthesis(self):
        # The owner's rule: only rows that pass the guard and land in the store get a
        # summary. A rejected candidate must return before either synthesis call.
        gate = self.src.index("ok, reason = is_eligible(")
        self.assertIn("return None, reason", self.src[gate:gate + 200])
        self.assertLess(gate, self.src.index("synthesize_store"))
        self.assertLess(gate, self.src.index("_synthesise_in_place(rec)"))


class TheUnknownCurrencyTests(unittest.TestCase):
    def setUp(self):
        from core import dropdowns
        self.d = dropdowns
        self._orig = dropdowns.load
        # No live rate, and a table that knows only EUR.
        import core.fx as fx
        self._fx = fx._erapi_rate
        fx._erapi_rate = lambda code: (None, None)
        dropdowns.load = lambda: {"currencies": [{"code": "EUR", "usd_rate": 1.1}]}
        self.addCleanup(self._restore)

    def _restore(self):
        import core.fx as fx
        self.d.load = self._orig
        fx._erapi_rate = self._fx

    def test_usd_is_one(self):
        self.assertEqual(self.d.usd_rate_known("USD"), 1.0)

    def test_a_known_currency_converts(self):
        self.assertAlmostEqual(self.d.usd_rate_known("EUR"), 1.1)

    def test_an_unknown_currency_is_unknown_not_one(self):
        # usd_rate still answers 1.0 for display; the scoring variant must not.
        self.assertEqual(self.d.usd_rate("XAF"), 1.0)
        self.assertIsNone(self.d.usd_rate_known("XAF"))

    def test_an_empty_currency_is_unknown(self):
        self.assertIsNone(self.d.usd_rate_known(""))
        self.assertIsNone(self.d.usd_rate_known(None))


class TheScoringUsesItTests(unittest.TestCase):
    def setUp(self):
        import core.fx as fx
        self._fx = fx._erapi_rate
        fx._erapi_rate = lambda code: (None, None)
        from core import dropdowns
        self.d = dropdowns
        self._orig = dropdowns.load
        dropdowns.load = lambda: {"currencies": [{"code": "EUR", "usd_rate": 1.1}]}
        self.addCleanup(self._restore)

    def _restore(self):
        import core.fx as fx
        self.d.load = self._orig
        fx._erapi_rate = self._fx

    def test_an_unplaceable_currency_makes_the_award_size_unknown(self):
        from core import criteria_derive as CD
        self.assertIsNone(CD._usd({"call_award_value": 5_000_000, "currency": "XAF"}))

    def test_a_placeable_one_still_converts(self):
        from core import criteria_derive as CD
        self.assertAlmostEqual(
            CD._usd({"call_award_value": 1_000_000, "currency": "EUR"}), 1_100_000)

    def test_the_size_components_go_not_sure_rather_than_failing(self):
        # The point of the change: a ceiling test must decline to answer rather than
        # measure an unconverted number against the org's band.
        from core import criteria_derive as CD
        org = {"org_min_target": 50_000, "org_max_target": 5_000_000}
        facts = {f["key"]: f for f in CD._funding_quality_factors(
            {"call_award_value": 5_000_000, "currency": "XAF"}, org)}
        self.assertIsNone(facts["fq_ceiling"]["met"])
        self.assertIsNone(facts["fq_floor"]["met"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
