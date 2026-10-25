"""Add users: the stale-form bug, and adding several people at once.

Reported: after one user was added, Add User reopened with that person's details still in
it, and Create user then stalled until the page was refreshed. Closing a dialog with its X
does not rerun the app, so the open flag and every field survived; the fix forgets all
Add-user state on dismiss and on every Add User click. Bulk add creates each row through
the same routine as the one-user form, and refuses the whole batch while any row is wrong.

Run:  python -m unittest tests.test_add_users
"""
import os
import sys
import unittest
from unittest import mock

import pandas as pd

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from views import account_sections as acc      # noqa: E402


class ResetTests(unittest.TestCase):
    def test_every_add_user_key_is_forgotten_and_nothing_else(self):
        state = {"adu_open": True, "adu_email": "old@x.org", "adu_name": "Old",
                 "adu_program": ["malaria"], "adu_bulk_df": object(),
                 "mu_add_user_top": True, "app_user": {"email": "me@x.org"}}
        with mock.patch.object(acc.st, "session_state", state):
            acc._reset_add_user_form()
        self.assertEqual(sorted(state), ["app_user", "mu_add_user_top"])

    def test_the_dialog_resets_on_dismiss_and_on_open(self):
        with open(os.path.join(_ROOT, "views", "account_sections.py"), encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("on_dismiss=_reset_add_user_form", src)
        opener = src[src.index('key="mu_add_user_top"'):][:300]
        self.assertIn("_reset_add_user_form()", opener)
        self.assertLess(opener.index("_reset_add_user_form()"),
                        opener.index('st.session_state["adu_open"] = True'))


def _table(*rows):
    return pd.DataFrame(rows, columns=acc._BULK_COLS)


class BulkRowsTests(unittest.TestCase):
    def test_blank_rows_are_spare_capacity_not_errors(self):
        df = _table(["a@x.org", "Ann", "collaborator", "", []],
                    ["", "", "collaborator", "", []],
                    [None, None, "collaborator", None, None])
        rows = acc._bulk_rows(df)
        self.assertEqual([r["email"] for r in rows], ["a@x.org"])
        self.assertEqual(rows[0]["n"], 1)

    def test_values_are_trimmed_and_row_numbers_kept(self):
        df = _table(["", "", "collaborator", "", []],
                    ["  b@x.org ", " Bea ", "admin", " HSS ", ["malaria"]])
        (row,) = acc._bulk_rows(df)
        self.assertEqual((row["n"], row["email"], row["name"], row["dept"], row["areas"]),
                         (2, "b@x.org", "Bea", "HSS", ["malaria"]))

    def test_pasted_comma_text_in_the_areas_column_is_split(self):
        (row,) = acc._bulk_rows(_table(["c@x.org", "Cy", "", "", "malaria, hiv"]))
        self.assertEqual(row["areas"], ["malaria", "hiv"])


class BulkProblemsTests(unittest.TestCase):
    ROLES = ["collaborator", "reviewer"]

    def _rows(self, *specs):
        return [{"n": i, "email": e, "name": n, "role": r, "dept": "", "areas": []}
                for i, (e, n, r) in enumerate(specs, start=1)]

    def test_a_clean_batch_has_no_problems(self):
        rows = self._rows(("a@x.org", "Ann", "collaborator"), ("b@x.org", "Bea", ""))
        self.assertEqual(acc._bulk_problems(rows, self.ROLES, set()), [])

    def test_each_kind_of_problem_names_its_row(self):
        rows = self._rows(("a@x.org", "Ann", "collaborator"),
                          ("A@x.org", "Ann again", "collaborator"),   # duplicate in batch
                          ("taken@x.org", "Tom", "collaborator"),     # already a user
                          ("not-an-email", "", "collaborator"),       # bad email, no name
                          ("d@x.org", "Dee", "admin"))                # role not assignable
        probs = acc._bulk_problems(rows, self.ROLES, {"taken@x.org"})
        self.assertEqual(len(probs), 4)
        self.assertTrue(probs[0].startswith("Row 2") and "same email as row 1" in probs[0])
        self.assertTrue(probs[1].startswith("Row 3") and "already exists" in probs[1])
        self.assertTrue(probs[2].startswith("Row 4") and "valid email" in probs[2]
                        and "full name" in probs[2])
        self.assertTrue(probs[3].startswith("Row 5") and "admin" in probs[3])


class CreateAccountTests(unittest.TestCase):
    """The shared create routine, with the database and mailer faked."""

    def _svc(self, *, insert_error=None):
        svc = mock.MagicMock()
        users = mock.MagicMock()
        if insert_error:
            users.insert.return_value.execute.side_effect = insert_error
        else:
            users.insert.return_value.execute.return_value.data = [{"id": "u1"}]
        svc.table.side_effect = lambda name: users if name == "users" else mock.MagicMock()
        return svc, users

    def _run(self, svc, mailer=None):
        mailer = mailer or mock.MagicMock()
        with mock.patch.object(acc, "service_client", return_value=svc), \
             mock.patch.object(acc, "clear_credentials_cache"), \
             mock.patch.object(acc, "_forget_declared_areas"), \
             mock.patch.object(acc, "hash_password", return_value="h"), \
             mock.patch("core.password_tokens.issue_token", return_value=("raw", None)), \
             mock.patch("core.password_tokens.build_link", return_value="https://x/l"), \
             mock.patch("core.user_emails._app_url", return_value="https://x"), \
             mock.patch("core.user_emails.send_welcome_email", mailer):
            return acc._create_user_account(
                {"email": "me@x.org", "id": "me"}, email=" new@x.org ", name=" New ",
                role="collaborator", dept=" HSS ", program="malaria",
                tenant={"mt": False})

    def test_a_created_and_emailed_user_needs_no_manual_link(self):
        svc, users = self._svc()
        res = self._run(svc)
        self.assertTrue(res["ok"] and res["emailed"])
        self.assertIsNone(res["link"])
        row = users.insert.call_args[0][0]
        self.assertEqual((row["email"], row["name"], row["department"]),
                         ("new@x.org", "New", "HSS"))
        self.assertTrue(row["must_change_password"])

    def test_a_failed_send_hands_back_the_link_to_share(self):
        svc, _ = self._svc()
        res = self._run(svc, mailer=mock.MagicMock(side_effect=RuntimeError("smtp down")))
        self.assertTrue(res["ok"])
        self.assertFalse(res["emailed"])
        self.assertEqual(res["link"], "https://x/l")
        self.assertIn("smtp down", res["mail_error"])

    def test_an_insert_failure_is_reported_not_raised(self):
        svc, _ = self._svc(insert_error=RuntimeError("duplicate key"))
        res = self._run(svc)
        self.assertFalse(res["ok"])
        self.assertIn("duplicate key", res["error"])


if __name__ == "__main__":
    unittest.main()
