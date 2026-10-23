"""The new-opportunity email (core.pipeline_digest): who gets it, when, and what it says."""
from __future__ import annotations

import unittest
from unittest import mock

from core import pipeline_digest as pd


class _Query:
    def __init__(self, data):
        self._data = data

    def __getattr__(self, _name):          # select / eq / gte / limit … all chain
        return lambda *a, **k: self

    def execute(self):
        return mock.Mock(data=self._data)


class _Client:
    def __init__(self, tables):
        self.tables = tables

    def table(self, name):
        return _Query(self.tables.get(name, []))


def _row(uid, rec, decision=None, **kw):
    return {"uid": uid, "opportunity_title": f"Call {uid}", "funding_agency": "Funder",
            "auto_recommendation": rec, "decision": decision, "alignment_score": 80, **kw}


def _member(email, active=True, blocked=False, name="Ada Lovelace"):
    return {"status": "active", "users": {"email": email, "name": name,
                                          "is_active": active, "is_blacklisted": blocked}}


def _client(rows, members):
    return _Client({"rfp_submissions": rows, "tenant_memberships": members,
                    "tenants": [{"name": "RFPIS APP", "slug": "rfpis"}]})


class VerdictTests(unittest.TestCase):
    def test_the_team_decision_outranks_the_system(self):
        self.assertEqual(pd.verdict(_row("A", "Decline", decision="Proceed")), "Proceed")

    def test_the_system_suggestion_is_used_while_undecided(self):
        self.assertEqual(pd.verdict(_row("A", "Park")), "Park")


class FormattingTests(unittest.TestCase):
    def test_millions_are_written_out(self):
        self.assertEqual(pd.amount_text(15_000_000, "USD"), "US$15 million")
        self.assertEqual(pd.amount_text(1_500_000, "USD"), "US$1.5 million")
        self.assertEqual(pd.amount_text(300_000, None), "US$300,000")

    def test_a_missing_amount_says_so(self):
        self.assertEqual(pd.amount_text(None, "USD"), "Amount not stated")
        self.assertEqual(pd.amount_text(0, "USD"), "Amount not stated")

    def test_dates_are_month_day_year(self):
        self.assertEqual(pd.date_text("2026-10-30"), "October 30, 2026")

    def test_a_long_note_is_cut_at_a_word(self):
        note = pd.brief_note("word " * 100)
        self.assertTrue(note.endswith("…"))
        self.assertLessEqual(len(note), 222)

    def test_the_link_lands_on_the_opportunity_in_its_tenant(self):
        self.assertEqual(pd.opportunity_url("https://x.app/", "AS-1", "rfpis"),
                         "https://x.app/opportunity?uid=AS-1&tenant=rfpis")


class SendTests(unittest.TestCase):
    def setUp(self):
        self.send = mock.Mock()

    def _run(self, rows, members):
        with mock.patch("core.user_emails._app_url", return_value="https://x.app"), \
             mock.patch("core.user_emails._short_name", return_value="RFPIS"):
            return pd.send_pipeline_digest("t1", "2026-10-23", client=_client(rows, members),
                                           send=self.send)

    def test_nothing_is_sent_when_only_declines_arrived(self):
        out = self._run([_row("A", "Decline")], [_member("a@example.com")])
        self.send.assert_not_called()
        self.assertEqual(out["declined"], 1)

    def test_each_active_member_gets_their_own_email(self):
        rows = [_row("A", "Proceed", call_award_value=2_000_000, currency="USD"),
                _row("B", "Park"), _row("C", "Decline")]
        members = [_member("a@example.com"), _member("b@example.com"),
                   _member("off@example.com", active=False),
                   _member("blocked@example.com", blocked=True)]
        out = self._run(rows, members)
        self.assertEqual(self.send.call_count, 2)
        self.assertEqual({c.kwargs["to"][0] for c in self.send.call_args_list},
                         {"a@example.com", "b@example.com"})
        self.assertEqual((out["proceed"], out["park"], out["declined"], out["sent"]), (1, 1, 1, 2))
        body = self.send.call_args.kwargs["html"]
        self.assertIn("https://x.app/opportunity?uid=A&amp;tenant=rfpis", body)
        self.assertIn("US$2 million", body)
        self.assertNotIn("Call C", body)          # declined calls are counted, not listed
        self.assertEqual(self.send.call_args.kwargs["subject"],
                         "RFPIS APP: 2 new funding opportunities to review (1 Proceed, 1 Park)")

    def test_duplicates_are_not_news(self):
        out = self._run([_row("A", "Proceed", is_duplicate=True)], [_member("a@example.com")])
        self.send.assert_not_called()
        self.assertEqual(out["new"], 0)

    def test_a_test_list_limits_who_receives_it(self):
        with mock.patch.dict("os.environ", {"RFPIS_PIPELINE_DIGEST_TO": " b@example.com , "}):
            only = pd.test_recipients()
        self.assertEqual(only, ["b@example.com"])
        with mock.patch("core.user_emails._app_url", return_value="https://x.app"), \
             mock.patch("core.user_emails._short_name", return_value="RFPIS"):
            pd.send_pipeline_digest("t1", "2026-10-23", send=self.send, only_to=only,
                                    client=_client([_row("A", "Proceed")],
                                                   [_member("a@example.com"),
                                                    _member("b@example.com")]))
        self.assertEqual([c.kwargs["to"] for c in self.send.call_args_list], [["b@example.com"]])

    def test_one_failing_address_does_not_stop_the_rest(self):
        self.send.side_effect = [RuntimeError("bounce"), None]
        out = self._run([_row("A", "Proceed")],
                        [_member("a@example.com"), _member("b@example.com")])
        self.assertEqual((out["sent"], out["failed"]), (1, 1))


if __name__ == "__main__":
    unittest.main()
