"""A scoring-rule change must invalidate every stored score's claim to be current.

`score_profile_sig` is a claim: "this number is what the current rules produce". It was
built by hand in three places — `scripts/rescore_existing.profile_signature`,
`views/screened_rfp.py` and `views/rfp_records.py` — and all three carried the same
comment saying the stored score goes stale when the org profile, donor intel **or
scoring logic** change. Only the profile and the settings were ever hashed.

So a change to the arithmetic left every stamped row claiming currency while holding a
number the engine no longer computed. On 2026-11-18, when an undetermined criterion
stopped taking half its weight, that was **177 of 211 stamped rows** —
`web/scripts/parity/check-rescore.mjs` failed on exactly that, which is the only reason
it was noticed. An earlier rule change had already produced 11 such rows, swept by hand
instead of being closed.

The cure is a signature that covers the rule, not a sweep. `check-rescore` tolerates a
STALE row ("the job has not caught up") and fails a CURRENT-BUT-WRONG one, so widening
the signature moves those rows from the second state to the first and writes nothing to
the database at all.

UNITTEST, NOT BARE FUNCTIONS. `scripts/run_tests.py` — which `.github/workflows/tests.yml`
calls — runs `python -m unittest discover` per module, and unittest collects TestCase
subclasses only. Written as module-level `def test_*` functions with a `monkeypatch`
fixture, this file reported "Ran 0 tests ... NO TESTS RAN" while the suite still said OK:
the guard against the exact defect above was pinned nowhere CI could see it. That is a
quieter version of the same failure the file is about, so it is worth naming here.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import score_stamp as ss                                    # noqa: E402

ORG = {"name": "An Org", "countries": ["Cameroon"]}
SETTINGS = {"has_bd_team": True}


class TheSignatureShape(unittest.TestCase):

    def test_the_signature_is_twelve_hex_characters(self):
        """Migration 101's column, and the three call sites, all assume this shape."""
        sig = ss.profile_sig(ORG, SETTINGS)
        self.assertEqual(len(sig), 12)
        self.assertTrue(all(c in "0123456789abcdef" for c in sig))

    def test_the_same_inputs_give_the_same_signature(self):
        self.assertEqual(ss.profile_sig(ORG, SETTINGS),
                         ss.profile_sig(dict(ORG), dict(SETTINGS)))


class WhatMovesTheSignature(unittest.TestCase):

    def test_a_profile_change_still_moves_it(self):
        """The clause that always worked, kept working."""
        self.assertNotEqual(ss.profile_sig(ORG, SETTINGS),
                            ss.profile_sig({**ORG, "countries": ["Mali"]}, SETTINGS))

    def test_a_settings_change_still_moves_it(self):
        self.assertNotEqual(ss.profile_sig(ORG, SETTINGS),
                            ss.profile_sig(ORG, {**SETTINGS, "has_bd_team": False}))

    def test_the_scoring_rule_version_moves_it(self):
        """THE CLAUSE THAT WAS MISSING. Same org, same settings, different arithmetic."""
        before = ss.profile_sig(ORG, SETTINGS)
        with mock.patch.object(ss, "SCORING_RULE_VERSION", "9999-01-01.some-later-rule"):
            self.assertNotEqual(ss.profile_sig(ORG, SETTINGS), before)

    def test_the_weights_file_moves_it(self):
        """The half of the rule that lives in data needs nobody to remember a bump.

        Editing `config/scoring_weights.yaml` — a weight, or the 90/70 bands — changes the
        digest by itself, so that half of the rule can never drift out of the signature
        the way the arithmetic did.
        """
        before = ss.profile_sig(ORG, SETTINGS)
        with mock.patch.object(ss, "_weights_digest", lambda: "deadbeef"):
            self.assertNotEqual(ss.profile_sig(ORG, SETTINGS), before)

    def test_the_weights_digest_reads_the_real_file(self):
        """Not "nofile" — the path must actually resolve from this module's location."""
        self.assertNotEqual(ss._weights_digest(), "nofile")
        self.assertEqual(len(ss._weights_digest()), 8)

    def test_the_version_names_the_rule_it_belongs_to(self):
        """A bare counter tells a later reader nothing about what moved.

        The convention is `<date>.<what-changed>`, so `git log -S` on the string finds the
        commit that bumped it and the reasoning that came with it.
        """
        v = ss.SCORING_RULE_VERSION
        self.assertIn(".", v)
        date, _, slug = v.partition(".")
        self.assertEqual(len(date), 10)
        self.assertEqual(date.count("-"), 2)
        self.assertTrue(slug)
        self.assertEqual(slug, slug.lower())
        self.assertNotIn(" ", slug)


class EveryCallerUsesTheSharedFunction(unittest.TestCase):

    def test_live_scoring_exposes_the_signature_the_parity_check_imports(self):
        """It did not exist, and the one caller swallowed the ImportError.

        `web/scripts/parity/rescore_py.py` does `from core.live_scoring import
        profile_signature` inside a try/except that falls back to None, and
        `check-rescore.mjs` guards its staleness branch with `if (sig && ...)`. A null
        signature therefore made every stamped row read as "claims to be current", with no
        way to class one as stale — which is what turned a routine rule change into 177
        reported faults.
        """
        from core import live_scoring
        self.assertTrue(
            callable(getattr(live_scoring, "profile_signature", None)),
            "web/scripts/parity/rescore_py.py imports this; without it check-rescore "
            "compares every stored score against a null signature")

    def test_every_caller_uses_the_shared_function(self):
        """The three hand-rolled copies are what let the clause go missing for months.

        Asserted by reading the sources rather than by calling them: two are Streamlit
        pages that execute at import and cannot be imported in a test, which is precisely
        why the drift was invisible to the suite before.
        """
        for rel in ("scripts/rescore_existing.py",
                    "views/screened_rfp.py",
                    "views/rfp_records.py"):
            with self.subTest(module=rel):
                src = (ROOT / rel).read_text(encoding="utf-8")
                self.assertIn("profile_sig", src,
                              f"{rel} does not use the shared signature")
                self.assertNotIn(
                    "hexdigest()[:12]", src,
                    f"{rel} builds a 12-char signature of its own again — that is the "
                    "copy this test exists to stop. Call core.score_stamp.profile_sig.")


if __name__ == "__main__":
    unittest.main()
