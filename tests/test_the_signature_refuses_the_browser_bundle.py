"""`profile_sig` must not be computed from the browser's bundled copy of core/.

THE TRAP, spotted by the stamp session on 2026-11-19 after the py-bundle staleness was
found. `web/scripts/build-py-bundle.mjs` copies core/ AND config/ into
`web/public/py/bundle.json`, ONCE, when the dev server starts — Vite's HMR rebuilds the
TSX and never touches it. `profile_sig` hashes `config/scoring_weights.yaml` along with
`SCORING_RULE_VERSION`, so a dev server left running across a scoring-rule change would
give a browser computing the OLD signature from the OLD YAML while the server computes
the new one.

That is two halves of the app disagreeing about which stored scores are current, with no
error raised and nothing on screen to suggest it — the same class of fault as the one
`profile_sig` was written to fix, one layer down. It is worse than the original because a
signature mismatch is invisible by design: a row simply reads as stale, or as current,
and nobody asks which copy decided.

NOTHING IN THE BROWSER PATH CALLS IT TODAY. `core/live_scoring` is the only importer
inside core/, and the Pyodide worker's inline Python imports `opportunity_detail`,
`opportunity_scoring`, `org_profile`, `settings` and `donor_intel` — none of which reach
it. "Today" is the entire strength of that guarantee, and the scoring work already runs
in that path through `core/scorer.py`, so the ingredients are assembled. A comment asking
future callers not to would be a comment; this raises.

The measured staleness that prompted it, from the same evening: the bundle on disk held
`profile_sig` and NOT `stamp_state`, a mixed snapshot of two different mains.
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


class TheServerIsUnaffected(unittest.TestCase):

    def test_the_signature_still_works_on_the_server(self):
        """The guard must be invisible everywhere the function is legitimately used."""
        self.assertEqual(len(ss.profile_sig(ORG, SETTINGS)), 12)

    def test_this_interpreter_is_not_the_browser(self):
        """If this ever fails, the detector is wrong rather than the environment."""
        self.assertFalse(ss._running_in_the_browser_bundle())
        self.assertNotEqual(sys.platform, "emscripten")


class TheBundleIsRefused(unittest.TestCase):

    def test_it_raises_under_pyodide(self):
        """Pyodide reports sys.platform == "emscripten" and nothing else in this project
        does, so the check needs no cooperation from the caller and a stale file cannot
        fake its way past it."""
        with mock.patch.object(sys, "platform", "emscripten"):
            self.assertTrue(ss._running_in_the_browser_bundle())
            with self.assertRaises(ss.BundledSignatureError):
                ss.profile_sig(ORG, SETTINGS)

    def test_the_message_says_what_to_do_instead(self):
        """A raise that does not name the bundle sends the next reader to the wrong file.

        The failure it guards against is subtle enough that "ask the server for it" has to
        be in the exception rather than in a docstring nobody reaches from a traceback.
        """
        with mock.patch.object(sys, "platform", "emscripten"):
            with self.assertRaises(ss.BundledSignatureError) as caught:
                ss.profile_sig(ORG, SETTINGS)
        msg = str(caught.exception)
        self.assertIn("bundle.json", msg)
        self.assertIn("server", msg)

    def test_it_is_a_runtime_error_subclass(self):
        """So a caller that catches broadly still catches it, rather than a bare raise
        escaping through a `except RuntimeError` that was meant to be thorough."""
        self.assertTrue(issubclass(ss.BundledSignatureError, RuntimeError))


class TheWeightsFileIsWhyThisMatters(unittest.TestCase):

    def test_the_signature_depends_on_a_file_the_bundle_copies(self):
        """The whole trap is that `config/scoring_weights.yaml` ships IN the bundle.

        If the signature stopped depending on that file this guard would be arguable; it
        does depend on it, so the guard is not. Asserted rather than described, because
        "does the hash still read the YAML" is exactly the kind of thing that changes
        without anyone revisiting a docstring.
        """
        before = ss.profile_sig(ORG, SETTINGS)
        with mock.patch.object(ss, "_weights_digest", lambda: "ffffffff"):
            self.assertNotEqual(ss.profile_sig(ORG, SETTINGS), before)

    def test_the_weights_file_is_in_the_bundle_manifest(self):
        """The build script's own filter, read rather than assumed.

        If `build-py-bundle.mjs` stops shipping config/, this test fails and whoever
        changed it learns that a guard elsewhere was justified by that behaviour.
        """
        script = ROOT / "web" / "scripts" / "build-py-bundle.mjs"
        if not script.exists():               # not a reason to fail the suite
            self.skipTest("build-py-bundle.mjs not present")
        src = script.read_text(encoding="utf-8")
        self.assertIn("config", src,
                      "the bundle no longer mentions config/ — if scoring_weights.yaml "
                      "has stopped shipping to the browser, re-read "
                      "core.score_stamp.profile_sig's guard, which exists because it did")


if __name__ == "__main__":
    unittest.main()
