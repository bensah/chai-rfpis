"""The re-score job does not re-derive a row a human has assessed.

`core.auto_scorer.auto_score` bases all nine criteria to None and re-derives them from org
profile x donor intel x call text. It never reads the nine stored columns. On a row nobody
has reviewed that is exactly right — it is what the scan is for. On a reviewed row it
answers a different question: what this call would score if nobody had looked at it.
Measured on live data when this landed: of 56 rows carrying a human decision, 48 held
criteria `auto_score` does not reproduce and 30 came out with a different recommendation.

`core/scan_pipeline.py:307` has deferred to human review all along — "Refresh auto-scoring
only when the existing row has no alignment_score ... Otherwise human work wins". The job
that took scoring over in October did not know about the rule. This restores it, and these
tests pin it by BEHAVIOUR: the job is run against stub rows and what it did is inspected.

The skip clears the row's stamps rather than leaving them. That is the half worth a test of
its own: a stamp left behind says the server verified a number it has stopped maintaining,
and the reviewer's next edit makes that claim false — which is `check-rescore` going red on
exactly the rows the skip exists to protect.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path
from unittest import mock

from core.score_stamp import STAMP_COLUMNS, human_assessed


class TestWhatCountsAsAssessed(unittest.TestCase):
    def test_a_decision_date_counts(self):
        self.assertTrue(human_assessed({"decision_date": "2026-11-09"}))

    def test_an_editor_save_on_a_decided_row_counts(self):
        """The editor stamps the author and records a decision, with no decision date.

        Three of the five rows this rule was written for look exactly like this.
        """
        self.assertTrue(human_assessed({"decision_overridden_by": "a@example.org",
                                        "decision": "Proceed"}))

    def test_a_bare_save_does_not_count(self):
        """THE BUG THIS REPLACES, caught by the react-migration session.

        Both apps stamp `decision_overridden_by` on every save of any field
        (pipeline_writes.ts:343, rfp_editor.py:616), so on its own it means "somebody
        edited this once". Taking it as an assessment exempted a row from re-scoring for
        ever the first time anyone touched one field on it — measured at 29 of 271 live
        rows, and growing with every edit.
        """
        self.assertFalse(human_assessed({"decision_overridden_by": "a@example.org"}))
        self.assertFalse(human_assessed({"decision_overridden_by": "a@example.org",
                                         "remarks": "fixed a typo in the title"}))

    def test_a_decision_the_engine_made_does_not_count(self):
        """A decision without a date or an author is the engine's, not a person's.

        `web/src/api.ts` says so, and 33 of 271 live rows carry one: the engine writes
        this column too, so it cannot stand alone either.
        """
        self.assertFalse(human_assessed({"decision": "Proceed"}))
        self.assertFalse(human_assessed({"decision": "Decline",
                                         "auto_recommendation": "Decline"}))

    def test_a_scanned_row_does_not(self):
        for row in ({}, {"decision_date": None}, {"decision_overridden_by": ""},
                    {"decision_date": "   ", "decision_overridden_by": None},
                    {"alignment_score": 92.0, "auto_recommendation": "Proceed"}):
            self.assertFalse(human_assessed(row), row)

    def test_the_predicate_reads_only_the_columns_it_declares(self):
        """ASSESSED_BY_A_HUMAN is pinned against the TypeScript copy by check-rescore."""
        from core.score_stamp import ASSESSED_BY_A_HUMAN
        self.assertEqual(set(ASSESSED_BY_A_HUMAN),
                         {"decision_date", "decision_overridden_by", "decision"})


class TestTheEditorStampsTheDateItAssesses(unittest.TestCase):
    """`views/rfp_editor.py` records decisions, so it must leave the flag that says so.

    Without it an assessment made in the editor is invisible to everything that reads
    `decision_date` as "a person has reviewed this" — the Review screen, both halves of
    the API, and `human_assessed` here. That is why the predicate still needs its second
    clause; as this stamp reaches the rows people edit, `decision_date` becomes the whole
    answer.
    """

    @staticmethod
    def _save_block() -> ast.If:
        src = (Path(__file__).resolve().parents[1] / "views" / "rfp_editor.py").read_text(
            encoding="utf-8")
        for node in ast.walk(ast.parse(src)):
            if not isinstance(node, ast.If):
                continue
            test = ast.dump(node.test)
            if "'decision'" in test and "'decision_date'" in test:
                return node
        raise AssertionError(
            "views/rfp_editor.py no longer stamps decision_date on first capture — an "
            "assessment made there goes back to looking like a scan row")

    def test_it_stamps_only_when_a_decision_is_being_recorded(self):
        test = ast.dump(self._save_block().test)
        self.assertIn("'decision'", test)

    def test_it_never_overwrites_a_date_the_team_set(self):
        """A system date may stand in at a row's FIRST capture and nowhere else."""
        test = ast.dump(self._save_block().test)
        self.assertIn("Not", test,
                      "the stamp must be conditional on the row having NO decision_date: "
                      "re-dating an existing one from a screen with no date field is the "
                      "silent re-dating the owner ruled out on 2026-11-09")

    def test_it_writes_a_date_into_the_update(self):
        body = ast.dump(ast.Module(body=self._save_block().body, type_ignores=[]))
        self.assertIn("decision_date", body)
        self.assertIn("today", body)


class _FakeTable:
    def __init__(self, rows, writes):
        self._rows, self._writes = rows, writes

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        if col == "uid":
            self._rows = [r for r in self._rows if r.get("uid") == val]
        return self

    def execute(self):
        return mock.Mock(data=list(self._rows))


class _FakeClient:
    def __init__(self, rows, writes):
        self.rows, self.writes = rows, writes

    def table(self, _name):
        return _FakeTable(self.rows, self.writes)


class TestTheJobSkipsThem(unittest.TestCase):
    """Run `_rescore` over two stub rows and look at what it did."""

    REVIEWED = {"uid": "REVIEWED-1", "alignment_score": 100.0,
                "auto_recommendation": "Proceed",
                "decision_overridden_by": "reviewer@example.org",
                "decision": "Proceed",
                "scored_at": "2026-11-03T05:06:25+00:00", "score_profile_sig": "abc123"}
    SCANNED = {"uid": "SCANNED-1", "alignment_score": 40.0,
               "auto_recommendation": "Decline"}

    def _run(self, rows):
        from scripts import run_web_job

        writes: list[tuple[str, dict]] = []
        scored_uids: list[str] = []

        def fake_auto_score(row, _policies):
            scored_uids.append(str(row.get("uid")))
            return {"alignment_score": 55.5, "auto_recommendation": "Park"}

        def fake_write(_sb, uid, upd):
            writes.append((uid, dict(upd)))
            return True

        job = mock.Mock()
        job.get.return_value = {"tenant_id": "t-1"}
        with mock.patch("db.supabase_client.get_client",
                        return_value=_FakeClient([dict(r) for r in rows], writes)), \
             mock.patch("core.auto_scorer.auto_score", side_effect=fake_auto_score), \
             mock.patch("scripts.rescore_existing.write_with_retry", side_effect=fake_write), \
             mock.patch("scripts.rescore_existing.profile_signature",
                        return_value=({}, {}, [], "sig-now")), \
             mock.patch("core.policies.get_policies", return_value={}), \
             mock.patch("auth.tenant_context.set_tenant_override", return_value="tok"), \
             mock.patch("auth.tenant_context.reset_tenant_override"):
            result = run_web_job._rescore(job, {"tenant_id": "t-1"}, "local")
        return result, writes, scored_uids

    def test_a_reviewed_row_is_never_handed_to_the_scorer(self):
        _result, _writes, scored = self._run([self.REVIEWED])
        self.assertEqual(scored, [],
                         "auto_score must not run on a row a human has assessed — it "
                         "cannot see their assessment, so its answer is about a different "
                         "row than the one on screen")

    def test_a_reviewed_row_loses_its_stamps(self):
        _result, writes, _scored = self._run([self.REVIEWED])
        self.assertEqual(len(writes), 1, "the skip must still clear the stale claim")
        uid, upd = writes[0]
        self.assertEqual(uid, "REVIEWED-1")
        self.assertEqual(set(upd), set(STAMP_COLUMNS),
                         "the skip writes the two stamps and nothing else — the score "
                         "stays exactly as the reviewer left it")
        for column in STAMP_COLUMNS:
            self.assertIsNone(upd[column])

    def test_an_unstamped_reviewed_row_is_not_written_at_all(self):
        row = {k: v for k, v in self.REVIEWED.items() if k not in STAMP_COLUMNS}
        _result, writes, scored = self._run([row])
        self.assertEqual(writes, [], "nothing to clear, so nothing to write")
        self.assertEqual(scored, [])

    def test_an_unreviewed_row_is_still_scored_and_stamped(self):
        """The skip must not turn the job off: that is what the job is for."""
        result, writes, scored = self._run([self.SCANNED])
        self.assertEqual(scored, ["SCANNED-1"])
        self.assertEqual(len(writes), 1)
        _uid, upd = writes[0]
        self.assertEqual(upd.get("alignment_score"), 55.5)
        self.assertEqual(upd.get("score_profile_sig"), "sig-now")
        self.assertIsNotNone(upd.get("scored_at"))
        self.assertEqual(result.get("scored"), 1)

    def test_the_counts_say_which_rows_were_left_alone(self):
        """A save that comes back "scored 0" has to say why: deferred, not broken."""
        result, _writes, _scored = self._run([self.REVIEWED, self.SCANNED])
        self.assertEqual(result.get("rows"), 2)
        self.assertEqual(result.get("scored"), 1)
        self.assertEqual(result.get("skipped_human_assessed"), 1)
        self.assertEqual(result.get("failed"), 0)

    def test_the_skip_applies_to_a_single_row_job_too(self):
        """A save on a reviewed row is the reviewer editing their own assessment.

        That is the last thing that should trigger a re-derivation of it, so the uid path
        defers as well — and because it clears the stamps rather than leaving them, the
        row reads unverified instead of spinning on `scoreIsBehind` forever.
        """
        from scripts import run_web_job

        writes: list[tuple[str, dict]] = []
        scored: list[str] = []
        job = mock.Mock()
        job.get.return_value = {"tenant_id": "t-1"}
        with mock.patch("db.supabase_client.get_client",
                        return_value=_FakeClient([dict(self.REVIEWED), dict(self.SCANNED)],
                                                 writes)), \
             mock.patch("core.auto_scorer.auto_score",
                        side_effect=lambda r, _p: scored.append(str(r.get("uid")))), \
             mock.patch("scripts.rescore_existing.write_with_retry",
                        side_effect=lambda _s, u, d: writes.append((u, dict(d))) or True), \
             mock.patch("scripts.rescore_existing.profile_signature",
                        return_value=({}, {}, [], "sig-now")), \
             mock.patch("core.policies.get_policies", return_value={}), \
             mock.patch("auth.tenant_context.set_tenant_override", return_value="tok"), \
             mock.patch("auth.tenant_context.reset_tenant_override"):
            result = run_web_job._rescore(
                job, {"tenant_id": "t-1", "uid": "REVIEWED-1"}, "local")
        self.assertEqual(scored, [], "the uid path must defer too")
        self.assertEqual(result.get("skipped_human_assessed"), 1)
        self.assertEqual(result.get("rows"), 1, "and must still scope to the one row")


if __name__ == "__main__":
    unittest.main()
