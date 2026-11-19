"""`--dry-run` does not write the catalogue.

WHAT HAPPENED
-------------
`scripts/run_scan.py` documents `--dry-run` as "log nothing, just print", and
`core/scan_pipeline.py` gates its `rfp_submissions` writes on the flag at line
487 — `sb = None if dry_run else get_client()`. But it called
`extraction.extract_and_store` at two places with no guard at all, and that
function writes straight to `extracted_solicitations`.

On 2026-11-19 a run advertised as dry added 26 TED rows to the live shared
catalogue, 1687 -> 1713. The person who ran it was at that moment arguing
AGAINST an unapproved production write, had read line 487, and took the one gate
that supported what they wanted to believe as proof of the whole. Three sessions
share this tree; any of them could have reached for the same flag for the same
reason.

WHAT IS PINNED HERE
-------------------
That the guard exists at the only place it can be complete — inside
`extract_and_store`, not at each call site, because a call site is exactly what
was missed — and that a dry run still does all the WORK. A dry run that skipped
extraction would report a result the real path would not produce, which is a
different way of lying about the same thing.

Offline: `build_record` is exercised for real, the store is a stub that records
whether it was called.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import extract  # noqa: E402

CANDIDATE = {
    "opportunity_title": "Call for Proposals: Maternal and Newborn Health Research",
    "opportunity_link": "https://example.org/calls/mnh-2027",
    "funding_agency": "Wellcome",
    "source": "Wellcome",
    "_source_class": "primary",
    "call_submission_deadline": "2027-03-01",
    "_page_text": (
        "Eligibility: open to NGOs, universities and research institutes. Grants of "
        "between USD 50,000 and USD 150,000 are available per project. Projects may "
        "run for up to 24 months. Applications must be submitted through the online "
        "portal. "
    ) * 3,
}


class ADryRunWritesNothingTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        from core.policies import get_policies
        cls.policies = get_policies()

    def _run(self, dry_run: bool):
        """Returns (uid, reason, was_the_store_called)."""
        with mock.patch.object(extract.extracted_store, "upsert_extracted",
                               return_value="es_written") as upsert:
            uid, reason = extract.extract_and_store(
                dict(CANDIDATE), self.policies, scan_year=2026, use_llm=False,
                dry_run=dry_run)
        return uid, reason, upsert.called

    def test_a_dry_run_does_not_touch_the_store(self):
        """The whole point. This is what wrote 26 live rows."""
        _uid, _reason, called = self._run(dry_run=True)
        self.assertFalse(called, "extract_and_store wrote to the catalogue on a dry run")

    def test_a_real_run_still_writes(self):
        """The guard must not have turned the scan into a no-op."""
        uid, _reason, called = self._run(dry_run=False)
        self.assertTrue(called)
        self.assertEqual(uid, "es_written")

    def test_a_dry_run_still_returns_the_record_uid(self):
        """So the caller's counters describe the rehearsal rather than reporting
        every row as a failure. "new=26" on a dry run means 26 that WOULD be
        written — which is why run_scan now prints that in words."""
        uid, _reason, _called = self._run(dry_run=True)
        self.assertTrue(uid and str(uid).startswith("es_"))

    def test_a_dry_run_still_does_the_extraction(self):
        """A dry run that skipped the work would report a result the real path
        would not produce — a different way of lying about the same thing."""
        seen = {}
        real_build = extract.build_record

        def spy(candidate, policies, **kw):
            rec, reason = real_build(candidate, policies, **kw)
            seen["rec"] = rec
            return rec, reason

        with mock.patch.object(extract, "build_record", side_effect=spy):
            self._run(dry_run=True)
        rec = seen.get("rec") or {}
        self.assertTrue(rec, "build_record was not called on a dry run")
        # the deterministic pass ran too, not just the gate
        self.assertEqual(rec.get("project_duration"), 24)
        self.assertEqual(rec.get("call_award_ceiling"), 150000.0)

    def test_a_rejected_candidate_is_unaffected_by_the_flag(self):
        """A gate decline returns the gate's verdict either way, and writes
        nothing either way."""
        junk = {"opportunity_title": "Home", "opportunity_link": "https://x.org/",
                "source": "x", "_source_class": "primary"}
        for dry in (True, False):
            with self.subTest(dry_run=dry):
                with mock.patch.object(extract.extracted_store, "upsert_extracted",
                                       return_value="es_written") as upsert:
                    uid, reason = extract.extract_and_store(
                        dict(junk), self.policies, scan_year=2026, use_llm=False,
                        dry_run=dry)
                self.assertIsNone(uid)
                self.assertTrue(reason)
                self.assertFalse(upsert.called)


class TheScanPassesTheFlagDownTests(unittest.TestCase):
    """The guard lives in `extract_and_store`, but it only helps if the scan
    passes the flag. Both call sites were unguarded, and a third added later
    would be just as silent — so this reads the source rather than trusting it."""

    def test_no_call_site_in_the_scan_omits_dry_run(self):
        src = (Path(__file__).resolve().parent.parent
               / "core" / "scan_pipeline.py").read_text(encoding="utf-8")
        calls = src.count("extract_and_store(")
        guarded = src.count("dry_run=dry_run")
        self.assertGreaterEqual(calls, 2, "call sites moved; re-check this test")
        self.assertGreaterEqual(
            guarded, calls,
            f"{calls} call(s) to extract_and_store but only {guarded} pass "
            "dry_run — an unguarded one writes the catalogue on a dry run")


if __name__ == "__main__":
    unittest.main()
