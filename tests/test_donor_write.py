"""core/donor_write.py — the donor save rules, away from any user interface.

These rules used to live inside `_edit_dialog` in app_pages/donors.py, so they could only
run from Streamlit and could only be tested by a human clicking Save. They now also run in
the background job that serves the React app, which is the whole reason they had to come
out: `donor_intel` is shared cross-tenant data, and two implementations of its write rules
produce "a quietly wrong donor record" rather than an error.

Every test below pins behaviour that is easy to get wrong and hard to see afterwards.
Nothing here touches the network: the Supabase client is a recorder.

Run:  python -m unittest tests.test_donor_write
"""
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from core import donor_write as W                                    # noqa: E402


# --------------------------------------------------------------------------
# A recording stand-in for the Supabase client.
# --------------------------------------------------------------------------
class _Resp:
    def __init__(self, data):
        self.data = data


class _Table:
    def __init__(self, log, name, upsert_data, raise_on=None):
        self._log, self._name = log, name
        self._upsert_data, self._raise_on = upsert_data, raise_on
        self._filters = {}

    def upsert(self, payload, on_conflict=None):
        self._log.append(("upsert", self._name, payload, on_conflict))
        return self

    def insert(self, records):
        if self._raise_on == "insert":
            raise RuntimeError("insert exploded")
        self._log.append(("insert", self._name, records))
        return self

    def delete(self):
        if self._raise_on == "delete":
            raise RuntimeError("delete exploded")
        self._log.append(("delete", self._name))
        return self

    def eq(self, col, val):
        self._log.append(("eq", col, val))
        return self

    def in_(self, col, vals):
        self._log.append(("in", col, list(vals)))
        return self

    def execute(self):
        return _Resp(self._upsert_data)


class _Client:
    def __init__(self, upsert_data=({"canonical_key": "x"},), raise_on=None):
        self.log = []
        self._upsert_data = list(upsert_data)
        self._raise_on = raise_on

    def table(self, name):
        return _Table(self.log, name, self._upsert_data, self._raise_on)


class CleanPayload(unittest.TestCase):
    def test_strings_are_stripped(self):
        self.assertEqual(W.clean_payload({"a": "  x  "}), {"a": "x"})

    def test_blank_becomes_none(self):
        self.assertEqual(W.clean_payload({"a": "", "b": "   ", "c": None}),
                         {"a": None, "b": None, "c": None})

    def test_false_and_zero_also_become_none(self):
        """`or None` applies to the WHOLE value, not just to strings.

        This is surprising and it is deliberate — it is what the Streamlit form has
        always stored. "Fixing" it would start writing `false` where the page writes
        nothing, and the tri-state's four states (blank / yes / no / not_sure) would
        quietly become five.
        """
        self.assertEqual(W.clean_payload({"flag": False, "n": 0, "empty": []}),
                         {"flag": None, "n": None, "empty": None})

    def test_real_values_survive(self):
        self.assertEqual(W.clean_payload({"a": "yes", "n": 3, "t": True}),
                         {"a": "yes", "n": 3, "t": True})


class SplitColumns(unittest.TestCase):
    def test_unknown_columns_are_dropped(self):
        kept, _dropped = W.split_columns({"donor": "X", "nope": "v"}, ["donor"])
        self.assertEqual(kept, {"donor": "X"})

    def test_a_filled_unknown_column_is_reported_by_its_label(self):
        """Otherwise the user fills a field, saves successfully, and it vanishes."""
        _kept, dropped = W.split_columns(
            {"donor_fund_use_conditions": "no sub-granting"}, ["donor"])
        self.assertEqual(dropped, ["Conditions on use of funds"])

    def test_a_blank_unknown_column_is_not_worth_mentioning(self):
        _kept, dropped = W.split_columns({"donor_whatever": None, "x": ""}, ["donor"])
        self.assertEqual(dropped, [])

    def test_canonical_key_is_always_allowed(self):
        kept, _d = W.split_columns({"canonical_key": "k"}, [])
        self.assertEqual(kept, {"canonical_key": "k"})


class SlugKey(unittest.TestCase):
    def test_a_name_becomes_a_slug(self):
        self.assertEqual(W.slug_key("Gates Foundation", []), "gates_foundation")
        self.assertEqual(W.slug_key("  U.S. AID!  ", []), "u_s_aid")

    def test_collisions_get_a_suffix(self):
        self.assertEqual(W.slug_key("Gates", ["gates"]), "gates_2")
        self.assertEqual(W.slug_key("Gates", ["gates", "gates_2"]), "gates_3")

    def test_an_unusable_name_does_not_produce_an_empty_key(self):
        """An empty key would upsert onto whatever row already has one."""
        self.assertEqual(W.slug_key("!!!", []), "donor")
        self.assertEqual(W.slug_key("", []), "donor")
        self.assertEqual(W.slug_key("!!!", ["donor"]), "donor_2")


class ContactRecords(unittest.TestCase):
    def test_blank_rows_are_dropped(self):
        self.assertEqual(W.contact_records([{"contact_name": "  "}], "k"), [])

    def test_a_row_with_only_the_official_tick_is_not_a_contact(self):
        """Ticking a box on an empty row should not create a nameless contact."""
        self.assertEqual(W.contact_records([{"is_official": True}], "k"), [])

    def test_a_real_row_is_normalised_and_keyed(self):
        out = W.contact_records(
            [{"contact_name": " Ada ", "email": "", "is_official": True}], "k")
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["contact_name"], "Ada")
        self.assertIsNone(out[0]["email"])
        self.assertIs(out[0]["is_official"], True)
        self.assertEqual(out[0]["canonical_key"], "k")


class SaveVerifiesTheWrite(unittest.TestCase):
    def test_an_empty_result_is_a_refusal_not_a_success(self):
        """PostgREST answers 200 with [] when RLS refuses or a column is missing.

        Trusting the status code is how a save looks successful while nothing changed,
        which is the most expensive failure this table has.
        """
        sb = _Client(upsert_data=[])
        with self.assertRaises(W.WriteRefused):
            W.save_donor(sb, {"canonical_key": "k"})

    def test_a_row_coming_back_is_a_success(self):
        sb = _Client(upsert_data=[{"canonical_key": "k"}])
        self.assertEqual(W.save_donor(sb, {"canonical_key": "k"}),
                         [{"canonical_key": "k"}])
        self.assertEqual(sb.log[0][:2], ("upsert", "donor_intel"))
        self.assertEqual(sb.log[0][3], "canonical_key")


class ContactsAreReconciledSeparately(unittest.TestCase):
    def test_a_contacts_failure_is_a_warning_not_an_exception(self):
        """The donor row is the valuable half; a contacts hiccup must not fail the save."""
        sb = _Client(raise_on="insert")
        warn = W.reconcile_contacts(sb, "k", [{"contact_name": "Ada"}])
        self.assertIsNotNone(warn)
        self.assertIn("contacts couldn't be updated", warn)

    def test_success_returns_no_warning(self):
        self.assertIsNone(W.reconcile_contacts(_Client(), "k", []))

    def test_apply_edit_saves_the_donor_before_touching_contacts(self):
        """Ordering matters: contacts are replaced only once the donor row has landed."""
        sb = _Client(upsert_data=[{"canonical_key": "k"}])
        W.apply_edit(sb, canonical_key="k", edited={"donor": "X"}, row={},
                     columns=["donor", "canonical_key"], req_cols=[],
                     contacts=[{"contact_name": "Ada"}])
        kinds = [e[0] for e in sb.log]
        self.assertLess(kinds.index("upsert"), kinds.index("delete"))

    def test_apply_edit_reports_dropped_fields_as_a_warning(self):
        sb = _Client(upsert_data=[{"canonical_key": "k"}])
        res = W.apply_edit(sb, canonical_key="k",
                           edited={"donor": "X", "donor_fund_use_conditions": "v"},
                           row={}, columns=["donor", "canonical_key"], req_cols=[])
        self.assertEqual(res["dropped"], ["Conditions on use of funds"])
        self.assertTrue(any("different data-model migrations" in w
                            for w in res["warnings"]))

    def test_apply_edit_propagates_a_refused_write(self):
        sb = _Client(upsert_data=[])
        with self.assertRaises(W.WriteRefused):
            W.apply_edit(sb, canonical_key="k", edited={"donor": "X"}, row={},
                         columns=["donor", "canonical_key"], req_cols=[])
        # Nothing should have touched contacts after a refused donor write.
        self.assertNotIn("delete", [e[0] for e in sb.log])


class DeleteDonors(unittest.TestCase):
    def test_keys_are_deleted_in_one_statement(self):
        """One `in` rather than a loop of `eq`s — a partial failure used to leave half
        the selection deleted with nothing said about it."""
        sb = _Client(upsert_data=[{"canonical_key": "a"}, {"canonical_key": "b"}])
        self.assertEqual(W.delete_donors(sb, ["a", "b"]), 2)
        self.assertIn(("in", "canonical_key", ["a", "b"]), sb.log)

    def test_blank_keys_are_ignored_and_nothing_is_sent(self):
        """A delete with no filter would empty the table."""
        sb = _Client()
        self.assertEqual(W.delete_donors(sb, ["", "   ", None]), 0)
        self.assertEqual(sb.log, [])


class Provenance(unittest.TestCase):
    def test_nothing_is_tagged_when_the_column_does_not_exist(self):
        out = W.mark_reviewed({"a": "yes"}, {}, ["a"], ["a"])
        self.assertNotIn("field_provenance", out)

    def test_only_non_blank_requirements_are_marked_verified(self):
        """Nobody verified a question nobody answered."""
        out = W.mark_reviewed(
            {"r1": "yes", "r2": None, "r3": "not_sure"}, {},
            ["r1", "r2", "r3"], ["r1", "r2", "r3", "field_provenance"])
        import json
        fp = json.loads(out["field_provenance"])
        self.assertIn("r1", fp)
        self.assertIn("r3", fp, "an explicit 'not sure' was still reviewed")
        self.assertNotIn("r2", fp)


class Normalise(unittest.TestCase):
    def test_the_category_is_canonicalised_on_the_way_in(self):
        out = W.normalise({"donor_category": "bilaterals"}, "k")
        self.assertEqual(out["donor_category"],
                         "Bilaterals / government development agencies")

    def test_the_key_is_forced(self):
        out = W.normalise({"canonical_key": "wrong"}, "right")
        self.assertEqual(out["canonical_key"], "right")

    def test_a_blank_category_is_left_alone(self):
        self.assertIsNone(W.normalise({"donor_category": None}, "k")["donor_category"])


class NoUserInterface(unittest.TestCase):
    def test_the_module_does_not_use_streamlit(self):
        """It has to run in a background job with no session and no page.

        Checked on the AST, not on the text: a substring search for "st." also matches
        every "exist." and "list." in the prose, which is a test that fails for reasons
        having nothing to do with Streamlit.
        """
        import ast
        import pathlib
        src = (pathlib.Path(_ROOT) / "core" / "donor_write.py").read_text(encoding="utf-8")
        tree = ast.parse(src)
        imported = {
            (a.asname or a.name).split(".")[0]
            for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))
            for a in n.names
        }
        self.assertNotIn("streamlit", imported)
        self.assertNotIn("st", imported)
        used = {n.id for n in ast.walk(tree)
                if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
        self.assertNotIn("st", used, "a bare `st.` call would only fail inside a job")


if __name__ == "__main__":
    unittest.main()
