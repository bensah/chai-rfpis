"""core/donor_fields.py — the donor vocabulary, and the page's aliases onto it.

WHAT THIS GUARDS. The vocabulary used to live inside app_pages/donors.py. It now lives
here, and the page keeps the old private names as thin aliases (`_label = _df.label`)
because they are used ~200 times in that file. Two things can rot:

  * An alias can point at a name that no longer exists. Python does not notice until the
    page runs, and the page only runs in Streamlit — so the first report would be a user
    opening Donor Intelligence and getting an AttributeError.
  * `flag_groups` can stop classifying the way the page did, which is worse than an
    error because it is silent. The classification is NEGATIVE: a column not named in
    one of the sets IS a flag. So a column dropped from a set does not remove a form
    field, it invents one — plus a completeness denominator that grows for every donor
    at once.

Run:  python -m unittest tests.test_donor_fields
"""
import os
import pathlib
import re
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from core import donor_fields as F                                   # noqa: E402

_PAGE = pathlib.Path(_ROOT) / "app_pages" / "donors.py"


class PageAliasesResolve(unittest.TestCase):
    def test_every_alias_in_donors_py_exists(self):
        """`_df.X` in the page must name something this module actually exports.

        The page cannot be imported in a test (Streamlit at module scope), so this is a
        source scan. A word boundary matters: `filtered_df.columns` is not a reference to
        this module, and without it four pandas attributes look like missing exports.
        """
        src = _PAGE.read_text(encoding="utf-8")
        refs = sorted(set(re.findall(
            r"(?<![A-Za-z0-9_])_df\.([A-Za-z_][A-Za-z0-9_]*)", src)))
        self.assertTrue(refs, "the page no longer references the module at all")
        missing = [r for r in refs if not hasattr(F, r)]
        self.assertEqual(missing, [], f"donors.py refers to names this module lacks: {missing}")

    def test_the_page_imports_the_module(self):
        src = _PAGE.read_text(encoding="utf-8")
        self.assertIn("from core import donor_fields as _df", src)


class NegativeClassification(unittest.TestCase):
    def test_an_unknown_column_becomes_a_flag(self):
        """The property a migration relies on: a new column shows up in the form."""
        flags, _fit, req, _groups = F.flag_groups(
            ["donor", "canonical_key", "donor_brand_new_requirement"])
        self.assertIn("donor_brand_new_requirement", flags)
        self.assertIn("donor_brand_new_requirement", req)

    def test_named_columns_are_not_flags(self):
        cols = (["donor", "notes", "donor_website", "donor_mission", "donor_hq_address",
                 "donor_verification_level", "id", "updated_at"])
        flags, _fit, _req, _groups = F.flag_groups(cols)
        self.assertEqual(flags, [], f"these are text/meta, not flags: {flags}")

    def test_fit_is_matched_by_suffix_and_elig_by_name(self):
        flags, fit, req, groups = F.flag_groups(
            ["donor_malaria_fit", "donor_ngo_eligible", "donor_some_requirement"])
        self.assertEqual(fit, ["donor_malaria_fit"])
        self.assertEqual(groups["Program-area fit"], ["donor_malaria_fit"])
        self.assertEqual(groups["Legal & registration requirements"], ["donor_ngo_eligible"])
        self.assertIn("donor_some_requirement", req)
        self.assertNotIn("donor_ngo_eligible", req)

    def test_cofinancing_and_prefinance_are_always_asked(self):
        """Both are appended even when the column does not exist yet.

        They are eligibility requirements and belong in the tri-state matrix with the
        rest (owner 2026-08-10). Co-financing had no plainly named column at all until
        migration 092 — it had to be inferred from three other fields, none of which a
        researcher would recognise as the question.
        """
        _flags, _fit, req, _groups = F.flag_groups(["donor", "notes"])
        self.assertIn("donor_cofinancing_required", req)
        self.assertIn("donor_prefinance_required", req)

    def test_no_duplicate_when_the_column_does_exist(self):
        _flags, _fit, req, _groups = F.flag_groups(
            ["donor_cofinancing_required", "donor_prefinance_required"])
        self.assertEqual(req.count("donor_cofinancing_required"), 1)
        # prefinance is in CHOICE, so it is NOT a flag and gets appended once.
        self.assertEqual(req.count("donor_prefinance_required"), 1)


class Completeness(unittest.TestCase):
    def test_an_empty_record_is_zero_and_a_denominator_still_exists(self):
        pct, have, total = F.completeness({}, flags=[], fit=[])
        self.assertEqual((pct, have), (0, 0))
        self.assertGreater(total, 0, "a zero denominator would make every record 0%")

    def test_not_sure_counts_as_answered_but_blank_does_not(self):
        """The distinction the whole tri-state exists for.

        Scoring cannot see it — core.criteria_derive._truthy fires only on yes/required —
        so completeness is the ONLY place "somebody looked and could not tell" differs
        from "nobody answered".
        """
        flags = ["donor_x_required"]
        _p, have_blank, _t = F.completeness({"donor_x_required": ""}, flags, [])
        _p, have_unsure, _t = F.completeness({"donor_x_required": "not_sure"}, flags, [])
        _p, have_no, _t = F.completeness({"donor_x_required": "no"}, flags, [])
        self.assertEqual(have_unsure, have_blank + 1)
        self.assertEqual(have_no, have_blank + 1)

    def test_fit_flags_are_excluded_from_the_denominator(self):
        """Program areas moved to the ratings matrix; the *_fit flags are deprecated."""
        _p, _h, with_fit = F.completeness({}, ["donor_a_fit"], ["donor_a_fit"])
        _p, _h, without = F.completeness({}, [], [])
        self.assertEqual(with_fit, without)

    def test_the_percentage_rounds_half_to_even(self):
        """Python's round(), which is what the browser's pyRound has to match."""
        self.assertEqual(round(100 * 1 / 8), 12)     # 12.5 down
        self.assertEqual(round(100 * 3 / 8), 38)     # 37.5 up
        self.assertEqual(round(100 * 5 / 8), 62)     # 62.5 down


class DisplayRules(unittest.TestCase):
    def test_a_prefix_is_stripped_but_an_override_wins(self):
        self.assertEqual(F.label("donor_ngo_eligible"), "NGO eligible")
        self.assertEqual(F.label("donor_type"), "Donor type (descriptive)")
        # The override is also matched on the BARE name, after the prefix comes off.
        self.assertEqual(F.label("org_stage_required"), "Org stage required")

    def test_to_list_does_not_split_on_a_slash(self):
        """"/" appears inside real values — "Procurement / contracts"."""
        self.assertEqual(F.to_list("Procurement / contracts"), ["Procurement / contracts"])
        self.assertEqual(F.to_list("a; b, c"), ["a", "b", "c"])
        self.assertEqual(F.to_list('["x", "y"]'), ["x", "y"])
        for blank in (None, "", "nan", "None", "NaT"):
            self.assertEqual(F.to_list(blank), [], f"{blank!r} should be empty")

    def test_deshout_keeps_acronyms(self):
        self.assertEqual(F.disp("HEALTH SYSTEMS STRENGTHENING"),
                         "Health systems strengthening")
        self.assertEqual(F.disp("MNCH"), "MNCH")

    def test_the_country_placeholder_is_retired(self):
        self.assertEqual(F.disp("work in {country} today"), "work in priority countries today")

    def test_category_folds_plurals_and_keeps_unknowns(self):
        self.assertEqual(F.normalize_category("Bilaterals"),
                         "Bilaterals / government development agencies")
        self.assertEqual(F.normalize_category("DFIs"), "Multilaterals & development banks")
        self.assertEqual(F.normalize_category("Foundations."),
                         "International philanthropies & foundations")
        self.assertEqual(F.normalize_category("Something nobody wrote before"),
                         "Something nobody wrote before")
        self.assertEqual(F.normalize_category(None), F.UNCATEGORISED)

    def test_title_name_does_not_repeat_the_short_code(self):
        self.assertEqual(
            F.title_name({"donor": "African Development Bank (AfDB)", "donor_short": "AfDB"}),
            "African Development Bank (AfDB)")
        self.assertEqual(
            F.title_name({"donor": "African Development Bank", "donor_short": "AfDB"}),
            "African Development Bank (AfDB)")


class NoHeavyDependencies(unittest.TestCase):
    def test_the_module_does_not_reach_streamlit_or_the_database(self):
        """It has to import from a page, a script, a job runner and a test.

        The whole point of moving it out of donors.py was that donors.py cannot be
        imported. Pulling Streamlit or a DB client back in here would undo that
        quietly — everything would still pass until the job runner tried to import it.
        """
        src = (pathlib.Path(_ROOT) / "core" / "donor_fields.py").read_text(encoding="utf-8")
        for banned in ("import streamlit", "supabase_client", "service_client"):
            self.assertNotIn(banned, src)


if __name__ == "__main__":
    unittest.main()
