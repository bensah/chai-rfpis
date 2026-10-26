"""The named From: header (core.mailer), and the self-service reset link (auth)."""
from __future__ import annotations

import unittest
from unittest import mock

from core import mailer


class FromHeaderTests(unittest.TestCase):
    """What the recipient sees in their inbox list, rather than a no-reply mailbox."""

    def _named(self, sender, name="RFP Intelligence System"):
        with mock.patch.object(mailer, "_from_name", return_value=name):
            return mailer._from_header(sender)

    def test_a_bare_address_gains_the_display_name(self):
        self.assertEqual(self._named("no-reply@example.org"),
                         "RFP Intelligence System <no-reply@example.org>")

    def test_a_sender_that_is_already_named_is_left_alone(self):
        # Wrapping a second name around one produces a header the transport rejects.
        self.assertEqual(self._named("Someone Else <no-reply@example.org>"),
                         "Someone Else <no-reply@example.org>")

    def test_no_configured_name_sends_the_address_as_before(self):
        self.assertEqual(self._named("no-reply@example.org", name=""),
                         "no-reply@example.org")

    def test_something_that_is_not_an_address_is_not_dressed_up(self):
        # parseaddr hands back any bare string as an "address"; naming it would turn a
        # misconfiguration into a stranger-looking one.
        self.assertEqual(self._named("not-an-address"), "not-an-address")

    def test_empty_sender_is_untouched(self):
        self.assertEqual(self._named(""), "")

    def test_a_name_containing_a_comma_is_quoted(self):
        # Unquoted, the comma would split From: into two addresses.
        self.assertEqual(self._named("no-reply@example.org", name="Acme, Inc."),
                         '"Acme, Inc." <no-reply@example.org>')

    def test_a_non_ascii_name_is_encoded(self):
        got = self._named("no-reply@example.org", name="Zoë Ltd")
        self.assertTrue(got.startswith("=?utf-8?"), got)
        self.assertTrue(got.endswith("<no-reply@example.org>"), got)

    def test_the_product_name_is_reused_when_no_sender_name_is_set(self):
        def _setting(key, *a, **k):
            return {"email_from_name": "", "email_product_name": "Pipeline Tracker"}.get(key)

        with mock.patch("core.settings.get_setting", side_effect=_setting):
            self.assertEqual(mailer._from_name(), "Pipeline Tracker")

    def test_an_explicit_sender_name_wins_over_the_product_name(self):
        def _setting(key, *a, **k):
            return {"email_from_name": "Pipeline Alerts",
                    "email_product_name": "Pipeline Tracker"}.get(key)

        with mock.patch("core.settings.get_setting", side_effect=_setting):
            self.assertEqual(mailer._from_name(), "Pipeline Alerts")


class _Query:
    def __init__(self, data):
        self._data = data

    def __getattr__(self, _name):              # select / eq / limit … all chain
        return lambda *a, **k: self

    def execute(self):
        return mock.Mock(data=self._data)


class _Client:
    def __init__(self, rows):
        self._rows = rows

    def table(self, _name):
        return _Query(self._rows)


class SelfServiceResetTests(unittest.TestCase):
    """A person who has forgotten their password gets a link, not a queued request."""

    def _run(self, rows):
        """Returns (result, issued, sent) for one _email_reset_link call."""
        from auth import authenticator as auth
        issued, sent = [], []

        def _issue(**kw):
            issued.append(kw)
            return "RAWTOKEN", None

        with mock.patch.object(auth, "service_client", return_value=_Client(rows)), \
             mock.patch("core.password_tokens.issue_token", side_effect=_issue), \
             mock.patch("core.user_emails.send_password_reset_email",
                        side_effect=lambda **kw: sent.append(kw)):
            out = auth._email_reset_link("ada@example.org")
        return out, issued, sent

    def _user(self, **kw):
        base = {"id": "u1", "email": "ada@example.org", "name": "Ada",
                "is_active": True, "is_blacklisted": False}
        base.update(kw)
        return [base]

    def test_an_active_account_is_emailed_a_reset_link(self):
        out, issued, sent = self._run(self._user())
        self.assertTrue(out)
        self.assertEqual(len(sent), 1)
        self.assertEqual(issued[0]["purpose"], "reset")
        self.assertIn("RAWTOKEN", sent[0]["reset_link"])

    def test_an_unknown_address_sends_nothing_and_says_nothing(self):
        out, issued, sent = self._run([])
        self.assertFalse(out)
        self.assertEqual((issued, sent), ([], []))

    def test_a_deactivated_account_cannot_be_reopened_by_asking(self):
        out, issued, sent = self._run(self._user(is_active=False))
        self.assertFalse(out)
        self.assertEqual(sent, [])

    def test_a_blacklisted_account_cannot_be_reopened_by_asking(self):
        out, issued, sent = self._run(self._user(is_blacklisted=True))
        self.assertFalse(out)
        self.assertEqual(sent, [])

    def test_a_mail_failure_is_swallowed_so_the_form_cannot_leak_it(self):
        # The confirmation must read the same whether or not the send worked; a raised
        # error here would reach the screen and tell a stranger the account exists.
        from auth import authenticator as auth
        with mock.patch.object(auth, "service_client",
                               return_value=_Client(self._user())), \
             mock.patch("core.password_tokens.issue_token",
                        return_value=("RAWTOKEN", None)), \
             mock.patch("core.user_emails.send_password_reset_email",
                        side_effect=RuntimeError("smtp down")):
            self.assertFalse(auth._email_reset_link("ada@example.org"))


if __name__ == "__main__":
    unittest.main()
