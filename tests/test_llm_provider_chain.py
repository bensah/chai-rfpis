"""core/llm_providers.py — which vendor answers, and in what order.

WHY THIS FILE EXISTS. The module was written because one endpoint ran out of credit
and the LLM half of extraction stopped without anything logging an error a human
would see: every call site treats a model failure as a normal fall-back-to-regex
day. The whole point of a provider chain is that the NEXT vendor picks it up. That
promise is worth exactly as much as the ordering and the "is this callable at all"
test, and until now neither had a test.

Nothing here touches the network or reads the real .env — `provider()` resolves from
`os.environ` at call time, so the environment is the only fixture needed. The keys
below are obvious fakes; a real one must never appear in this repo.

Run:  python -m unittest tests.test_llm_provider_chain
"""
import importlib
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core import llm_providers as P                                  # noqa: E402

FAKE = "test-not-a-real-key"

# Every variable the module reads. Cleared around each test so a developer's own
# .env — which pytest may have loaded — cannot make a test pass that would fail on
# a clean machine, or fail one that would pass.
_VARS = [
    "RFPIS_LLM_PROVIDERS",
    *[f"RFPIS_LLM_{n.upper()}_{k}"
      for n in (*P.DEFAULTS, "nosuchvendor")
      for k in ("BASE_URL", "API_KEY", "MODEL")],
    *[f"LLM_{s}_{k}" for s in ("SYNTH", "EXTRACT", "JUDGE")
      for k in ("BASE_URL", "API_KEY", "MODEL")],
]


class ChainTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.pop(k, None) for k in _VARS}
        importlib.reload(P)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        importlib.reload(P)

    def env(self, **kw):
        for k, v in kw.items():
            os.environ[k] = v

    # -- the defaults -------------------------------------------------------
    def test_cerebras_needs_only_a_key(self):
        """A name in DEFAULTS brings its own URL and model.

        The owner's actual task was "wire the key alongside ollama". If that took
        three variables instead of one, the module has not done its job.
        """
        self.env(RFPIS_LLM_PROVIDERS="cerebras", RFPIS_LLM_CEREBRAS_API_KEY=FAKE)
        p = P.primary()
        self.assertIsNotNone(p)
        self.assertEqual(p.name, "cerebras")
        self.assertEqual(p.base_url, "https://api.cerebras.ai/v1")
        self.assertEqual(p.model, "gpt-oss-120b")

    def test_cerebras_runs_the_same_model_family_as_ollama(self):
        """Spelled their way — a hyphen where Ollama uses a colon.

        Not cosmetic. Every figure in docs/EXTRACTION_COVERAGE_REPORT.md was
        measured on gpt-oss-120b, so a failover that quietly changed model family
        would move the coverage numbers as well as the vendor and nobody could say
        which did it.
        """
        self.assertEqual(P.DEFAULTS["ollama"]["model"].replace(":", "-"),
                         P.DEFAULTS["cerebras"]["model"])

    # -- the ordering, which is the promise ---------------------------------
    def test_the_chain_is_tried_in_the_order_written(self):
        self.env(RFPIS_LLM_PROVIDERS="cerebras,ollama",
                 RFPIS_LLM_CEREBRAS_API_KEY=FAKE, LLM_JUDGE_API_KEY=FAKE)
        self.assertEqual([p.name for p in P.chain()], ["cerebras", "ollama"])
        self.assertEqual(P.primary().name, "cerebras")

    def test_the_spent_vendor_behind_it_still_takes_over(self):
        """The failure this module was built for: the first vendor has no key
        (or, live, no credit) and the second answers without an edit."""
        self.env(RFPIS_LLM_PROVIDERS="cerebras,ollama", LLM_JUDGE_API_KEY=FAKE)
        self.assertEqual(P.primary().name, "ollama")
        self.assertEqual([p.name for p in P.configured_chain()], ["ollama"])

    def test_an_unnamed_provider_is_never_called(self):
        """`glm` is in DEFAULTS and has a key, and is still not reached: a vendor
        absent from the chain stays absent however badly the others fail."""
        self.env(RFPIS_LLM_PROVIDERS="cerebras", RFPIS_LLM_GLM_API_KEY=FAKE)
        self.assertNotIn("glm", [p.name for p in P.chain()])

    # -- "configured" has to mean callable ----------------------------------
    def test_a_remote_vendor_without_a_key_is_not_configured(self):
        """Otherwise a bare chain reports every vendor in DEFAULTS as callable and
        a scan spends its latency budget on calls that can only 401."""
        self.env(RFPIS_LLM_PROVIDERS="cerebras")
        self.assertFalse(P.chain()[0].configured)
        self.assertIsNone(P.primary())

    def test_an_unconfigured_entry_stays_visible_in_the_chain(self):
        """It is kept so `status()` can answer "why did nothing happen". Dropping
        it hides the question."""
        self.env(RFPIS_LLM_PROVIDERS="cerebras,ollama")
        self.assertEqual([p.name for p in P.chain()], ["cerebras", "ollama"])
        self.assertEqual(P.configured_chain(), [])

    def test_an_unknown_name_must_bring_its_own_url_and_model(self):
        self.env(RFPIS_LLM_PROVIDERS="nosuchvendor",
                 RFPIS_LLM_NOSUCHVENDOR_API_KEY=FAKE)
        self.assertFalse(P.chain()[0].configured)
        self.env(RFPIS_LLM_NOSUCHVENDOR_BASE_URL="https://example.org/v1",
                 RFPIS_LLM_NOSUCHVENDOR_MODEL="some-model")
        self.assertTrue(P.chain()[0].configured)

    # -- the existing .env must keep working --------------------------------
    def test_an_untouched_env_still_resolves_exactly_as_before(self):
        """With RFPIS_LLM_PROVIDERS unset the chain is the single legacy endpoint.
        Someone who adds nothing must see no change at all."""
        self.env(LLM_JUDGE_API_KEY=FAKE)
        self.assertEqual([p.name for p in P.chain()], ["ollama"])
        self.assertTrue(P.primary().configured)

    def test_only_the_legacy_slot_reads_the_old_variable_names(self):
        """`LLM_JUDGE_API_KEY` is ollama's inheritance, not a global default — if
        cerebras picked it up, a key for one vendor would be sent to another."""
        self.env(RFPIS_LLM_PROVIDERS="cerebras", LLM_JUDGE_API_KEY=FAKE)
        self.assertEqual(P.provider("cerebras").api_key, "")
        self.assertEqual(P.provider("ollama").api_key, FAKE)

    def test_an_explicit_model_overrides_the_default(self):
        self.env(RFPIS_LLM_PROVIDERS="cerebras", RFPIS_LLM_CEREBRAS_API_KEY=FAKE,
                 RFPIS_LLM_CEREBRAS_MODEL="llama-3.3-70b")
        self.assertEqual(P.primary().model, "llama-3.3-70b")

    # -- shape --------------------------------------------------------------
    def test_every_default_ships_a_url_and_a_model(self):
        for name, d in P.DEFAULTS.items():
            with self.subTest(provider=name):
                self.assertTrue(d.get("base_url"), f"{name} has no base_url")
                self.assertTrue(d.get("model"), f"{name} has no model")
                self.assertTrue(d["base_url"].startswith("https://"),
                                f"{name} is not https")

    def test_no_default_carries_a_key(self):
        """A credential in the source is a credential in the repository, and this
        one is public."""
        for name, d in P.DEFAULTS.items():
            with self.subTest(provider=name):
                self.assertNotIn("api_key", d)


if __name__ == "__main__":
    unittest.main()
