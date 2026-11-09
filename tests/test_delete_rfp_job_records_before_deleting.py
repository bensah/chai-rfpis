"""The delete job's ORDER is the feature. Everything else about it is bookkeeping.

`views/rfp_editor.py` tombstones, labels and only then deletes, and its comment says what
happened when it did not: deleting removed the live row the deduplicator matches against,
so the next scan re-found the call and inserted it afresh — the reported "we keep
declining this and it keeps coming back". The React editor's delete goes through
`DELETE /pipelines/rfp/:uid`, which queues this job rather than deleting anything itself,
precisely so the three steps stay in one place and in that order.

So these tests run the handler against fakes and assert the SEQUENCE. A refactor that
keeps all three calls but moves the delete up passes every other kind of test in this
repo and reintroduces the bug, because by then there is no row left to tombstone from.

The second thing pinned here is the tolerance, which runs the other way: a tombstone or a
label that RAISES must not stop the delete. That is the Streamlit button's behaviour
(`seen_ledger.record_human_close`: "a failed tombstone must never block … the delete the
user actually asked for") and it is deliberate — the alternative is a reviewer who cannot
remove an opportunity because a telemetry table is down.
"""
from __future__ import annotations

import unittest
from unittest import mock

TENANT = "11111111-1111-1111-1111-111111111111"
UID = "AS-260801-0001393"


class FakeQuery:
    """Just enough of the Supabase builder for one select and one delete."""

    def __init__(self, log, verb, rows):
        self._log, self._verb, self._rows = log, verb, rows

    def select(self, *_a, **_k):
        return self

    def delete(self):
        self._verb = "delete"
        return self

    def eq(self, *_a, **_k):
        return self

    def execute(self):
        self._log.append(self._verb)
        return mock.Mock(data=list(self._rows))


class FakeClient:
    def __init__(self, log, rows):
        self._log, self._rows = log, rows

    def table(self, name):
        assert name == "rfp_submissions", name
        return FakeQuery(self._log, "select", self._rows)


class FakeJob:
    id = "job-1"

    def get(self):
        return {"tenant_id": TENANT}

    def progress(self, _pct, _message):
        return None


def run_delete(*, rows=None, tombstone_raises=False, label_raises=False):
    """Run the handler against fakes; return (ordered call log, result dict)."""
    from scripts import run_web_job

    log: list[str] = []
    row = {"uid": UID, "opportunity_title": "Expired TB call", "decision": "Decline"}

    def tombstone(_row, *, reason):
        log.append(f"tombstone:{reason}")
        if tombstone_raises:
            raise RuntimeError("rfp_seen is unreachable")

    def label(rows_in, by=None):
        log.append(f"label:{by}")
        if label_raises:
            raise RuntimeError("scan_decisions is unreachable")
        return len(rows_in)

    client = FakeClient(log, rows if rows is not None else [row])
    with mock.patch("core.seen_ledger.record_human_close", tombstone), \
            mock.patch("core.decision_log.log_human_reject", label), \
            mock.patch("db.supabase_client.get_client", lambda: client), \
            mock.patch("auth.tenant_context.set_tenant_override",
                       lambda tid: log.append(f"scope:{tid}") or "tok"), \
            mock.patch("auth.tenant_context.reset_tenant_override",
                       lambda tok: log.append("unscope")):
        result = run_web_job._delete_rfp(
            FakeJob(), {"tenant_id": TENANT, "uid": UID, "by": "ada@chai.org"}, "local")
    return log, result


class TestTheDeleteJobRecordsFirst(unittest.TestCase):
    def test_the_job_is_registered(self):
        from scripts.run_web_job import KINDS
        self.assertIn("delete_rfp", KINDS)

    def test_tombstone_then_label_then_delete(self):
        log, result = run_delete()
        self.assertEqual(
            log,
            ["scope:" + TENANT, "select", "tombstone:human_reject",
             "label:ada@chai.org", "delete", "unscope"],
            "the order IS the fix: the row must still exist when the tombstone and the "
            "label are made from it, and the delete must come last",
        )
        self.assertEqual(
            result,
            {"found": True, "tombstoned": True, "logged": 1, "deleted": 1,
             "runner": "local"},
        )

    def test_the_tombstone_reason_is_the_one_the_python_uses(self):
        """`human_reject`, not `human_decline`.

        `views/rfp_editor.py` passes `reason="human_reject"` for a delete and
        `seen_ledger.record_decision` defaults to `human_decline` for a Decline. They are
        different acts and the ledger records which it was; a delete filed as a decline
        loses the distinction the ledger exists to keep.
        """
        log, _ = run_delete()
        self.assertIn("tombstone:human_reject", log)
        self.assertNotIn("tombstone:human_decline", log)

    def test_a_failed_tombstone_does_not_block_the_delete(self):
        log, result = run_delete(tombstone_raises=True)
        self.assertEqual(log.index("tombstone:human_reject"), log.index("delete") - 2)
        self.assertIn("delete", log, "the removal the reviewer asked for still happens")
        self.assertFalse(result["tombstoned"], "but it is reported, not hidden")
        self.assertEqual(result["deleted"], 1)

    def test_a_failed_label_does_not_block_the_delete(self):
        log, result = run_delete(label_raises=True)
        self.assertIn("delete", log)
        self.assertEqual(result["logged"], 0)
        self.assertTrue(result["tombstoned"], "the tombstone went first and is unaffected")

    def test_a_row_already_gone_deletes_nothing_and_does_not_raise(self):
        """A re-run, or someone else's delete. Not a failure: there is nothing to do.

        And nothing to tombstone FROM, which is the point — this is what the API would
        hand the runner every time if it deleted the row itself.
        """
        log, result = run_delete(rows=[])
        self.assertNotIn("delete", log)
        self.assertNotIn("tombstone:human_reject", log)
        self.assertEqual(result, {"found": False, "tombstoned": False, "logged": False,
                                  "deleted": 0, "runner": "local"})

    def test_everything_runs_inside_the_tenant_override(self):
        """Both modules read the ambient tenant through get_client.

        A delete is the one job that cannot be undone by running it again, so scoping it
        to the wrong tenant does not merely produce a wrong number.
        """
        log, _ = run_delete()
        self.assertEqual(log[0], "scope:" + TENANT)
        self.assertEqual(log[-1], "unscope")

    def test_the_job_refuses_work_it_cannot_scope(self):
        from scripts import run_web_job
        for params in ({"uid": UID}, {"tenant_id": TENANT}):
            with self.assertRaises(ValueError):
                run_web_job._delete_rfp(
                    mock.Mock(get=lambda: {}, progress=lambda *a: None), dict(params), "local")


if __name__ == "__main__":
    unittest.main()
