"""core/donor_share.py — the one donor document that leaves the product.

A user copies this summary into an email, or sends the PDF to a colleague who has no
login. Nobody on the receiving end can compare it against the app, so a section that goes
missing or a figure that rounds the wrong way is read as fact and never questioned. That
is what these tests are for.

The line-by-line agreement with `web/src/donors/model.ts` is pinned elsewhere, by
`web/scripts/parity/check-donors.mjs` against the live table. What is pinned HERE is the
behaviour that has no second implementation to disagree with: what the summary does with
absent data, with data of the wrong shape, and at the boundaries the parity fixture
cannot reach because no donor has ever stored such a value.

Nothing here touches the network or Streamlit. `donor_pdf` is exercised only where
reportlab is installed, and skipped loudly where it is not.

Run:  python -m unittest tests.test_donor_share
"""
import json
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from core import donor_fields as F                                   # noqa: E402
from core import donor_share as S                                    # noqa: E402

# The derived flag classification, over a column list that names one column from each
# group. The classification is NEGATIVE — anything not in donor_fields' sets is a flag —
# so the groups have to be derived rather than written out, or these tests would pin a
# snapshot of today's table instead of the rule.
COLUMNS = [
    "canonical_key", "donor", "donor_short", "donor_category", "donor_website",
    "donor_summary_description", "donor_priority_areas", "donor_priority_ratings",
    "donor_past_projects_json", "donor_funding_tiers_json", "donor_geographic_scope",
    "donor_ngo_eligible", "donor_registration_required", "donor_audited_accounts_required",
    "donor_tb_fit", "donor_cofinancing_required", "donor_prefinance_required",
]
_FLAGS, _FIT, _REQ, GROUPS = F.flag_groups(COLUMNS)


def lines(row, groups=None):
    return S.summary_lines(row, GROUPS if groups is None else groups)


class TestEmptiness(unittest.TestCase):
    """A donor nobody has filled in must share as a NAME, not as a form."""

    def test_a_bare_row_is_a_title_and_nothing_else(self):
        # Every section is skipped when it has no populated pairs, so the document is the
        # heading and the blank line under it. A page of empty headings would read as a
        # donor who refuses to answer rather than one nobody has researched.
        self.assertEqual(lines({"donor": "Empty Fund"}), ["# Empty Fund", ""])

    def test_a_row_with_no_donor_at_all_still_has_a_title(self):
        self.assertEqual(lines({})[0], "# Donor")

    def test_blank_fields_do_not_become_empty_bullets(self):
        out = lines({"donor": "X", "donor_website": "", "donor_mission": None,
                     "donor_type": "nan"})
        self.assertEqual(out, ["# X", ""])

    def test_one_populated_field_brings_its_section_and_no_other(self):
        out = lines({"donor": "X", "donor_website": "https://x.org"})
        self.assertIn("Overview", out)
        self.assertIn("- **Website:** https://x.org", out)
        self.assertNotIn("Funding", out)
        self.assertNotIn("Eligibility & process", out)


class TestScopeAndRatings(unittest.TestCase):
    """The Scope & fit block, which is the only hand-built section in the summary."""

    def test_ratings_alone_print_nothing_without_areas_or_scope(self):
        # The section is gated on areas or a scope pair, so a row carrying ratings and
        # nothing else shows no priorities. Surprising, and true of both apps — pinned
        # here so a change to it is a decision rather than an accident.
        out = lines({"donor": "X",
                     "donor_priority_ratings": json.dumps({"IDs - Malaria": 5})})
        self.assertEqual(out, ["# X", ""])

    def test_ratings_sort_by_value_then_by_raw_key(self):
        out = lines({
            "donor": "X", "donor_priority_areas": json.dumps(["IDs - Malaria"]),
            "donor_priority_ratings": json.dumps({
                "IDs - Hepatitis": 5, "IDs - HIV/AIDS": 5, "IDs - TB": 3}),
        })
        prio = [ln for ln in out if ln.startswith("- **Priority:**")]
        # "HIV/AIDS" before "Hepatitis": Python compares the RAW KEY, and 'I' < 'e' by
        # codepoint. A locale-aware comparison puts Hepatitis first, which is what the
        # TypeScript port did until the parity check caught it.
        self.assertEqual(len(prio), 3)
        self.assertIn("HIV/AIDS", prio[0])
        self.assertIn("Hepatitis", prio[1])
        self.assertIn("TB", prio[2])

    def test_a_rating_outside_one_to_five_is_printed_as_stored(self):
        # int() does not clamp. A 7 left by a bad import reads "7/5" and sorts first —
        # which is how somebody notices the import was wrong.
        out = lines({
            "donor": "X", "donor_priority_areas": json.dumps(["IDs - Malaria"]),
            "donor_priority_ratings": json.dumps({"IDs - Malaria": 7, "IDs - TB": 4}),
        })
        prio = [ln for ln in out if ln.startswith("- **Priority:**")]
        self.assertTrue(prio[0].endswith("7/5"), prio[0])

    def test_a_fractional_rating_truncates_toward_zero(self):
        out = lines({
            "donor": "X", "donor_priority_areas": json.dumps(["IDs - Malaria"]),
            "donor_priority_ratings": json.dumps({"IDs - Malaria": 3.9}),
        })
        self.assertTrue(
            any(ln.endswith("3/5") for ln in out if ln.startswith("- **Priority:**")))

    def test_an_unrated_area_prints_under_a_different_bullet(self):
        out = lines({
            "donor": "X",
            "donor_priority_areas": json.dumps(["IDs - Malaria", "IDs - TB"]),
            "donor_priority_ratings": json.dumps({"IDs - Malaria": 4}),
        })
        self.assertTrue(any(ln.startswith("- **Priority:**") and "Malaria" in ln
                            for ln in out))
        self.assertTrue(any(ln.startswith("- **Priority area:**") and "TB" in ln
                            for ln in out))

    def test_unparseable_ratings_fall_back_to_none_rather_than_failing(self):
        # A broken blob must not cost the reader the whole profile.
        out = lines({"donor": "X", "donor_priority_areas": json.dumps(["IDs - TB"]),
                     "donor_priority_ratings": "{not json"})
        self.assertIn("Scope & fit", out)
        self.assertFalse([ln for ln in out if ln.startswith("- **Priority:**")])

    def test_ratings_of_the_wrong_shape_are_ignored(self):
        out = lines({"donor": "X", "donor_priority_areas": json.dumps(["IDs - TB"]),
                     "donor_priority_ratings": json.dumps([1, 2, 3])})
        self.assertIn("Scope & fit", out)
        self.assertFalse([ln for ln in out if ln.startswith("- **Priority:**")])


class TestFlagsComeFromTheGroups(unittest.TestCase):
    """The eligibility answers are DERIVED, so the groups argument decides them."""

    def test_only_yes_flags_are_listed(self):
        out = lines({"donor": "X", "donor_ngo_eligible": "yes",
                     "donor_registration_required": "no",
                     "donor_audited_accounts_required": "not_sure"})
        legal = [ln for ln in out if ln.startswith("- **Legal & registration")]
        self.assertEqual(len(legal), 1)
        self.assertIn("NGO eligible", legal[0])
        # "no" and "not_sure" are ANSWERS, but they are not requirements, so the shared
        # summary must not list them as things the donor demands.
        self.assertNotIn("Registration", legal[0])
        self.assertNotIn("Audited", "".join(out))

    def test_an_empty_groups_map_produces_no_eligibility_answers(self):
        # Proof the flags really come from the argument. If this still printed them, the
        # function would be reading a module-level snapshot of the columns instead.
        out = lines({"donor": "X", "donor_ngo_eligible": "yes"}, groups={})
        self.assertNotIn("Eligibility & process", out)

    def test_a_column_the_groups_do_not_know_is_not_invented(self):
        out = lines({"donor": "X", "donor_some_future_flag": "yes"})
        self.assertNotIn("future", "".join(out).lower())


class TestBulletHelpers(unittest.TestCase):
    def test_a_project_amount_rounds_half_to_even(self):
        # The format is f"{float(amt):,.0f}". 1500.5 is 1,500 and 2500.5 is 2,500 —
        # half-to-EVEN. JavaScript's Math.round is half-up and printed 1,501.
        self.assertEqual(S.project_line({"title": "P", "amount": 1500.5}),
                         "- P — 1,500")
        self.assertEqual(S.project_line({"title": "P", "amount": 2500.5}),
                         "- P — 2,500")

    def test_a_non_numeric_amount_is_passed_through(self):
        self.assertEqual(S.project_line({"title": "P", "amount": "about 3m",
                                         "currency": "GBP"}),
                         "- P — GBP about 3m")

    def test_a_zero_amount_still_prints(self):
        # 0 is a FACT about an award, not a missing value. `if amt not in (None, "")`
        # is what keeps it; a truthiness test would drop it.
        self.assertEqual(S.project_line({"title": "P", "amount": 0}), "- P — 0")

    def test_a_project_with_only_a_title_has_no_dangling_dash(self):
        self.assertEqual(S.project_line({"title": "P"}), "- P")

    def test_a_tier_with_neither_amount_nor_duration_has_no_dangling_dash(self):
        self.assertEqual(S.tier_line({"name": "Seed"}), "- **Seed**")

    def test_projects_and_tiers_without_their_key_field_are_dropped(self):
        row = {
            "donor": "X",
            "donor_past_projects_json": json.dumps(
                [{"title": "Kept"}, {"amount": 10}]),
            "donor_funding_tiers_json": json.dumps(
                [{"name": "Kept"}, {"amount": "10"}]),
        }
        self.assertEqual(len(S.past_projects(row)), 1)
        self.assertEqual(len(S.funding_tiers(row)), 1)
        # The count in the heading has to agree with the bullets under it.
        out = lines(row)
        self.assertIn("Past Projects — funded projects (1)", out)


class TestContactLine(unittest.TestCase):
    def test_a_nameless_contact_is_named_as_such(self):
        self.assertEqual(S.contact_line({}), "**(unnamed)**")

    def test_dollars_are_escaped_for_streamlit(self):
        # st.markdown reads $…$ as LaTeX, so an amount in a note would render as maths.
        self.assertIn(r"\$5,000", S.contact_line({"contact_name": "A",
                                                  "notes": "Budget $5,000"}))

    def test_details_follow_a_two_space_hard_break(self):
        out = S.contact_line({"contact_name": "A", "email": "a@b.c"})
        self.assertIn("  \n", out)

    def test_a_bare_linkedin_handle_is_not_made_into_a_link(self):
        self.assertIn("LinkedIn: in/x",
                      S.contact_line({"contact_name": "A", "linkedin_url": "in/x"}))
        self.assertIn("[LinkedIn](https://x/y)",
                      S.contact_line({"contact_name": "A", "linkedin_url": "https://x/y"}))


class TestShareLines(unittest.TestCase):
    def test_no_contacts_means_no_contacts_heading(self):
        out = S.share_lines({"donor": "X"}, GROUPS, [])
        self.assertNotIn("Contacts — focal persons", out)
        self.assertEqual(out, ["# X", ""])

    def test_none_is_treated_as_no_contacts(self):
        self.assertEqual(S.share_lines({"donor": "X"}, GROUPS, None), ["# X", ""])

    def test_the_streamlit_formatting_is_undone_for_the_shared_copy(self):
        md = S.share_markdown({"donor": "X"}, GROUPS,
                              [{"contact_name": "A", "notes": "Budget $5,000"}])
        # Neither the hard break nor the LaTeX escape belongs in a file or an email.
        self.assertNotIn("\\$", md)
        self.assertIn("$5,000", md)
        self.assertNotIn("  \n", md)
        self.assertIn(" — ", md)

    def test_the_contacts_block_comes_last(self):
        md = S.share_markdown(
            {"donor": "X", "donor_website": "https://x.org"}, GROUPS,
            [{"contact_name": "A"}])
        self.assertLess(md.index("Overview"), md.index("Contacts — focal persons"))


class TestShareFilename(unittest.TestCase):
    def test_the_short_code_wins_and_spaces_become_underscores(self):
        self.assertEqual(
            S.share_filename({"donor_short": "GATES", "donor": "Gates Foundation"}),
            "GATES.pdf")
        self.assertEqual(S.share_filename({"donor": "Open Society Foundations"}),
                         "Open_Society_Foundations.pdf")

    def test_an_empty_short_code_falls_through_to_the_name(self):
        self.assertEqual(S.share_filename({"donor_short": "", "donor": "Wellcome"}),
                         "Wellcome.pdf")

    def test_a_row_with_neither_still_produces_a_filename(self):
        # A download with an empty name is a file the browser refuses to save.
        self.assertEqual(S.share_filename({}), "donor.pdf")
        self.assertEqual(S.share_filename({"donor": "   "}, "md"), "donor.md")

    def test_the_extension_is_the_caller_s(self):
        self.assertEqual(S.share_filename({"donor_short": "X"}, "md"), "X.md")


class TestNoStreamlitOrDatabase(unittest.TestCase):
    """The module exists so a JOB can call it. A Streamlit import would undo that."""

    def test_the_module_imports_neither_streamlit_nor_the_db_client(self):
        import ast
        src = os.path.join(_ROOT, "core", "donor_share.py")
        with open(src, encoding="utf-8") as fh:
            tree = ast.parse(fh.read(), filename=src)
        # An AST check, not a substring search: "exist." and "list." in prose both
        # contain "st.", and a comment mentioning the database is not an import.
        banned = {"streamlit", "db.supabase_client"}
        found = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                found |= {a.name.split(".")[0] for a in node.names}
            elif isinstance(node, ast.ImportFrom) and node.module:
                found.add(node.module)
                found.add(node.module.split(".")[0])
        self.assertFalse(found & banned, f"forbidden imports: {found & banned}")

    def test_summary_lines_reads_nothing_it_was_not_given(self):
        # No default for `groups`: a caller that forgot the live columns must fail
        # loudly rather than print a profile with no eligibility answers.
        import inspect
        sig = inspect.signature(S.summary_lines)
        self.assertIs(sig.parameters["groups"].default, inspect.Parameter.empty)


class TestPdf(unittest.TestCase):
    """Rendering, where reportlab is available. Skipped loudly where it is not."""

    @classmethod
    def setUpClass(cls):
        try:
            import reportlab  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("reportlab is not installed in this environment")

    def test_it_returns_a_pdf(self):
        data = S.donor_pdf(["# A Donor", "", "Overview", "- **Website:** https://x.org"])
        self.assertTrue(data.startswith(b"%PDF"))
        self.assertGreater(len(data), 800)

    def test_emoji_and_symbols_do_not_break_the_render(self):
        # reportlab's base fonts are WinAnsi. The summary carries ✅ ✉ ☎ from the
        # contacts block and em-dashes everywhere, so a cp1252 failure here would be a
        # crash on the donors who happen to have focal persons.
        data = S.donor_pdf([
            "# Donor ✅", "", "Contacts — focal persons",
            "- **Ada** — ✉ a@b.c · ☎ +1 555 · 日本語 · emoji 🎉",
            "- **Bold **inside** a line**",
        ])
        self.assertTrue(data.startswith(b"%PDF"))

    def test_an_empty_document_still_renders(self):
        self.assertTrue(S.donor_pdf([]).startswith(b"%PDF"))

    def test_one_donor_does_not_open_on_a_blank_page(self):
        # The page break goes before every "# " EXCEPT the first. Breaking before the
        # first would put an empty page under the letterhead of every single-donor PDF,
        # which is the common case.
        one = S.donor_pdf(["# Only Donor", "", "Overview", "- **Website:** https://x"])
        self.assertEqual(one.count(b"/Type /Page\n"), 1, "a single profile is one page")

    def test_each_donor_in_a_combined_pdf_starts_its_own_page(self):
        # A profile that begins two thirds down somebody else's page cannot be printed,
        # filed or handed over on its own, which is what a donor PDF is for.
        three = S.donor_pdf([
            "# First Donor", "", "Overview", "- **Website:** https://a", "",
            "# Second Donor", "", "Overview", "- **Website:** https://b", "",
            "# Third Donor", "", "Overview", "- **Website:** https://c",
        ])
        self.assertEqual(three.count(b"/Type /Page\n"), 3)

    def test_the_org_lookup_failing_does_not_fail_the_pdf(self):
        # get_org() is a database read and the only one in this module. A settings
        # outage must cost the letterhead, not the document.
        import core.settings as settings
        orig_org, orig_logo = settings.get_org, settings.get_org_logo
        settings.get_org = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down"))
        settings.get_org_logo = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down"))
        try:
            self.assertTrue(S.donor_pdf(["# X"]).startswith(b"%PDF"))
        finally:
            settings.get_org, settings.get_org_logo = orig_org, orig_logo


if __name__ == "__main__":
    unittest.main()
