"""The Monday summary (core.pipeline_digest): the window, the split, the status.

Two things are easy to get wrong and invisible when they are: the week boundary,
where an off-by-one silently drops or double-reports a day, and the difference
between a decision the team made and a score the engine produced.
"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from core import pipeline_digest as pd


class _Q:
    def __init__(self, rows):
        self.rows, self.f = rows, []

    def select(self, *_a, **_k):
        return self

    def eq(self, c, v):
        self.f.append((c, "eq", v))
        return self

    def gte(self, c, v):
        self.f.append((c, "gte", v))
        return self

    def lt(self, c, v):
        self.f.append((c, "lt", v))
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        out = []
        for r in self.rows:
            ok = True
            for c, op, v in self.f:
                got = r.get(c)
                if op == "eq" and got != v:
                    ok = False
                elif op in ("gte", "lt"):
                    if got is None:
                        ok = False
                    elif op == "gte" and str(got) < str(v):
                        ok = False
                    elif op == "lt" and not str(got) < str(v):
                        ok = False
            if ok:
                out.append(dict(r))
        return mock.Mock(data=out)


class _Client:
    def __init__(self, submissions, tenants=None, members=None):
        self.t = {"rfp_submissions": submissions,
                  "tenants": tenants or [{"name": "Example Country", "slug": "ex"}],
                  "tenant_memberships": members or []}

    def table(self, name):
        return _Q(self.t.get(name, []))


MON = datetime(2026, 10, 26, 6, 0, tzinfo=timezone.utc)      # a Monday 06:00


def _row(uid, auto="Proceed", decision=None, submitted=None, decided=None, **kw):
    return {"uid": uid, "tenant_id": "t1", "opportunity_title": f"Call {uid}",
            "funding_agency": "A Funder", "auto_recommendation": auto,
            "decision": decision, "alignment_score": 70,
            "submitted_at": submitted, "decision_date": decided,
            "is_duplicate": False, **kw}


class WindowTests(unittest.TestCase):
    def test_it_is_the_previous_monday_to_this_monday(self):
        start, end = pd.week_window(MON)
        self.assertEqual(start, datetime(2026, 10, 19, tzinfo=timezone.utc))
        self.assertEqual(end, datetime(2026, 10, 26, tzinfo=timezone.utc))

    def test_the_window_is_the_same_whenever_the_cron_actually_fires(self):
        # A late or retried run must report the same week, not a sliding seven days.
        a = pd.week_window(MON)
        b = pd.week_window(MON + timedelta(hours=11))
        self.assertEqual(a, b)

    def test_consecutive_weeks_meet_exactly(self):
        _, end_prev = pd.week_window(MON)
        start_next, _ = pd.week_window(MON + timedelta(days=7))
        self.assertEqual(end_prev, start_next)      # no gap, no overlap

    def test_fridays_scan_falls_inside_it(self):
        start, end = pd.week_window(MON)
        friday = datetime(2026, 10, 23, 6, 0, tzinfo=timezone.utc)
        self.assertTrue(start <= friday < end)


class SplitTests(unittest.TestCase):
    def _data(self, rows):
        start, end = pd.week_window(MON)
        return pd.weekly_review_data(_Client(rows), "t1", start, end)

    def test_an_undecided_call_found_last_week_is_waiting(self):
        d = self._data([_row("A", submitted="2026-10-21T09:00:00+00:00")])
        self.assertEqual([r["uid"] for r in d["waiting"]["Proceed"]], ["A"])
        self.assertEqual(d["decided_total"], 0)

    def test_a_decided_call_is_reported_as_decided_not_waiting(self):
        d = self._data([_row("A", auto="Proceed", decision="Park",
                             submitted="2026-10-21T09:00:00+00:00",
                             decided="2026-10-22T09:00:00+00:00")])
        self.assertEqual(d["waiting"]["Proceed"], [])
        self.assertEqual([r["uid"] for r in d["settled"]["Park"]], ["A"])

    def test_a_call_found_earlier_but_decided_last_week_still_counts(self):
        # The team's work last week is the point, not when the call arrived.
        d = self._data([_row("A", decision="Proceed",
                             submitted="2026-09-01T09:00:00+00:00",
                             decided="2026-10-22T09:00:00+00:00")])
        self.assertEqual([r["uid"] for r in d["settled"]["Proceed"]], ["A"])
        self.assertEqual(d["found_total"], 0)

    def test_a_call_outside_the_window_is_ignored(self):
        d = self._data([_row("A", submitted="2026-10-18T23:59:00+00:00"),
                        _row("B", submitted="2026-10-26T00:01:00+00:00")])
        self.assertEqual(d["found_total"], 0)

    def test_system_declines_are_counted_not_listed(self):
        d = self._data([_row("A", auto="Decline", submitted="2026-10-21T09:00:00+00:00")])
        self.assertEqual(d["declined_untouched"], 1)
        self.assertEqual(sum(len(v) for v in d["waiting"].values()), 0)

    def test_duplicates_are_dropped(self):
        rows = [_row("A", submitted="2026-10-21T09:00:00+00:00")]
        rows[0]["is_duplicate"] = True
        self.assertEqual(self._data(rows)["found_total"], 0)

    def test_waiting_is_ordered_by_bid_strength(self):
        d = self._data([_row("A", submitted="2026-10-21T09:00:00+00:00", alignment_score=40),
                        _row("B", submitted="2026-10-21T09:00:00+00:00", alignment_score=90)])
        self.assertEqual([r["uid"] for r in d["waiting"]["Proceed"]], ["B", "A"])


class StatusTests(unittest.TestCase):
    def test_a_team_decision_and_a_suggestion_do_not_look_alike(self):
        # The distinction the email exists to make: scored is not agreed.
        decided = pd.status_badge("Proceed", decided=True)
        suggested = pd.status_badge("Proceed", decided=False)
        self.assertNotEqual(decided, suggested)
        self.assertIn("suggested", suggested)
        self.assertNotIn("suggested", decided)

    def test_each_status_has_its_own_colour(self):
        seen = {pd.status_badge(s, decided=True) for s in ("Proceed", "Park", "Decline")}
        self.assertEqual(len(seen), 3)

    def test_no_status_renders_nothing(self):
        self.assertEqual(pd.status_badge("", decided=True), "")


class RenderTests(unittest.TestCase):
    def _html(self, rows):
        start, end = pd.week_window(MON)
        data = pd.weekly_review_data(_Client(rows), "t1", start, end)
        return pd.render_weekly_review_html(
            recipient_name="Ada Lovelace", tenant_name="Example Country",
            product="RFPIS", base_url="https://app.example", slug="ex",
            data=data, start=start, end=end)

    def test_it_names_the_week_it_covers(self):
        html = self._html([])
        self.assertIn("October 19", html)
        self.assertIn("October 25", html)      # inclusive end, not the 26th

    def test_a_quiet_week_still_says_something_useful(self):
        html = self._html([])
        self.assertIn("No new calls and no decisions", html)
        self.assertIn("next scan runs Friday", html)

    def test_waiting_calls_are_listed_with_a_suggested_badge(self):
        html = self._html([_row("A", submitted="2026-10-21T09:00:00+00:00")])
        self.assertIn("Call A", html)
        self.assertIn("suggested", html)

    def test_decided_calls_show_the_decision(self):
        html = self._html([_row("A", auto="Proceed", decision="Decline",
                                submitted="2026-10-21T09:00:00+00:00",
                                decided="2026-10-22T09:00:00+00:00")])
        self.assertIn("Decided: Decline", html)

    def test_links_carry_the_tenant(self):
        html = self._html([_row("A", submitted="2026-10-21T09:00:00+00:00")])
        self.assertIn("/opportunity?uid=A&amp;tenant=ex", html)


class SubjectTests(unittest.TestCase):
    def test_it_leads_with_what_is_waiting(self):
        self.assertEqual(pd.weekly_subject("Example", 3, 5),
                         "Example: last week in the pipeline (3 awaiting review, 5 decided)")

    def test_a_quiet_week_says_so(self):
        self.assertIn("quiet week", pd.weekly_subject("Example", 0, 0))

    def test_nothing_waiting_omits_that_clause(self):
        self.assertNotIn("awaiting", pd.weekly_subject("Example", 0, 4))


class SendTests(unittest.TestCase):
    def _members(self):
        return [{"tenant_id": "t1", "status": "active",
                 "users": {"email": "ada@example.org", "name": "Ada",
                           "is_active": True, "is_blacklisted": False}}]

    def test_it_sends_from_the_alerts_address(self):
        sent = []
        cli = _Client([_row("A", submitted="2026-10-21T09:00:00+00:00")],
                      members=self._members())
        pd.send_weekly_review("t1", now=MON, client=cli,
                              send=lambda **kw: sent.append(kw))
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["purpose"], "alerts")

    def test_a_quiet_week_is_still_sent(self):
        # Unlike the Friday digest. Silence is indistinguishable from a dead cron.
        sent = []
        pd.send_weekly_review("t1", now=MON, client=_Client([], members=self._members()),
                              send=lambda **kw: sent.append(kw))
        self.assertEqual(len(sent), 1)

    def test_no_members_sends_nothing(self):
        out = pd.send_weekly_review("t1", now=MON, client=_Client([]),
                                    send=lambda **kw: None)
        self.assertIn("no active members", out["skipped"])

    def test_one_bad_address_does_not_stop_the_rest(self):
        members = self._members() + [
            {"tenant_id": "t1", "status": "active",
             "users": {"email": "bob@example.org", "name": "Bob",
                       "is_active": True, "is_blacklisted": False}}]
        calls = []

        def _send(**kw):
            calls.append(kw)
            if kw["to"] == ["ada@example.org"]:
                raise RuntimeError("bounced")

        out = pd.send_weekly_review("t1", now=MON, client=_Client([], members=members),
                                    send=_send)
        self.assertEqual(len(calls), 2)
        self.assertEqual((out["sent"], out["failed"]), (1, 1))


if __name__ == "__main__":
    unittest.main(verbosity=2)
