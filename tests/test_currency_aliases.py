"""Currency aliases are read from the key the data actually uses.

THE BUG THIS PINS. `config/dropdowns.yaml` writes `aliases`, `app_settings.currencies_json`
stores `aliases`, and the TypeScript port (`supabase/functions/_shared/api/money.ts`) reads
`aliases`. Three Python readers — `core/dropdowns.usd_rate`, `usd_rate_known` and
`core/currency._resolve_currency` — looked for `donor_aliases`, which appears nowhere in a
currency row. So alias lookup was DEAD: a call quoting "£" or "FCFA" matched no entry, fell
through to the first-whitespace-token fallback (which cannot match a bare symbol), and was
converted at 1.0 — a British pound counted as a dollar, silently.

It was invisible because every path has that fallback, and the fallback works for the
common "GBP £" spelling. Only a bare symbol or a legacy label failed, and it failed by
returning a plausible number.

The Settings currency editor compounded it: it read AND wrote `donor_aliases`, so it showed
an empty Aliases column for stored rows and, on save, rewrote them into a shape the
TypeScript could not read either. It now writes `aliases`, and the readers accept both so a
deployment that already pressed Save keeps working until its rows are re-saved.

NOT TO BE CONFUSED WITH `donor_intel.donor_aliases`, which is a real and different column —
a donor's alternate NAMES, free text. Nothing here touches it.

Run:  python -m unittest tests.test_currency_aliases
"""
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from core import dropdowns                                              # noqa: E402


class AliasesAreReadFromBothKeys(unittest.TestCase):
    def test_the_canonical_key_is_read(self):
        self.assertEqual(["£", "GBP £"],
                         dropdowns.currency_aliases({"aliases": ["£", "GBP £"]}))

    def test_the_legacy_key_is_still_read(self):
        """A deployment that pressed Save in the old editor holds rows in this shape.
        Refusing them would turn a dead path into a broken one."""
        self.assertEqual(["£"], dropdowns.currency_aliases({"donor_aliases": ["£"]}))

    def test_the_canonical_key_wins_when_both_are_present(self):
        self.assertEqual(["new"], dropdowns.currency_aliases(
            {"aliases": ["new"], "donor_aliases": ["old"]}))

    def test_a_row_with_neither_gives_an_empty_list(self):
        self.assertEqual([], dropdowns.currency_aliases({"code": "USD"}))

    def test_a_non_dict_is_not_an_error(self):
        """`load()` returns whatever the YAML or the stored JSON holds, and a malformed
        entry must not take down every currency lookup on the page."""
        for junk in (None, "USD", 42, ["aliases"]):
            with self.subTest(entry=junk):
                self.assertEqual([], dropdowns.currency_aliases(junk))


class TheYamlUsesTheCanonicalKey(unittest.TestCase):
    def test_every_shipped_currency_declares_aliases_not_donor_aliases(self):
        """The YAML is the source the stored overrides were first copied from. If it ever
        used `donor_aliases`, the readers above would be matching the wrong key again."""
        rows = dropdowns.load().get("currencies") or []
        self.assertTrue(rows, "config/dropdowns.yaml declares no currencies")
        for row in rows:
            with self.subTest(code=row.get("code")):
                self.assertNotIn("donor_aliases", row)

    def test_a_bare_symbol_resolves_through_an_alias(self):
        """The end the bug was actually felt at. "£" is in GBP's alias list and in no
        code or label, and the first-token fallback cannot match it — so before the fix
        this returned the 1.0 default and a pound was counted as a dollar."""
        rows = dropdowns.load().get("currencies") or []
        gbp = next((r for r in rows if r.get("code") == "GBP"), None)
        if gbp is None:
            self.skipTest("this deployment ships no GBP entry")
        self.assertIn("£", dropdowns.currency_aliases(gbp))
        rate = dropdowns.usd_rate_known("£")
        self.assertIsNotNone(rate, "a bare £ still resolves to no rate")
        self.assertNotEqual(1.0, rate, "£ resolved to the USD default, not GBP's rate")


if __name__ == "__main__":
    unittest.main()
