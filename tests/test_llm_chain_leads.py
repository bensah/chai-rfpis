"""When a provider chain is set, the endpoint AND the model come from it.

THE BUG THIS PINS
-----------------
`RFPIS_LLM_PROVIDERS=cerebras,ollama` was set on 2026-11-19, after the owner
funded Cerebras because the Ollama account was out of credit. Every call still
went to Ollama first and took two 402s before falling through, because
`primary_endpoint` read the legacy `LLM_JUDGE_BASE_URL` — still ollama.com —
in preference to the chain. The owner's stated order was ignored and every
request paid two dead round-trips for it.

The model half is the same bug one step further on. `LLM_SYNTH_MODEL` is
`gpt-oss:120b`, Ollama's spelling; Cerebras publishes `gpt-oss-120b`. Pairing
the chain's endpoint with the legacy model name sends a vendor a model it does
not have, and the 404 reads exactly like an outage.

So endpoint and model must resolve from ONE source. These tests pin that, and
pin equally hard that an .env naming no chain behaves exactly as it did before —
which is the promise `core/llm_providers.py` was introduced on.

Offline: environment variables only, no network, no database.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import llm_client as LC  # noqa: E402

FAKE = "sk-test-not-a-real-key"

#: Every variable these tests touch, so each case starts from a known state
#: rather than from whatever the developer's .env happens to hold.
_VARS = ("RFPIS_LLM_PROVIDERS", "RFPIS_LLM_CEREBRAS_API_KEY",
         "RFPIS_LLM_CEREBRAS_MODEL", "RFPIS_LLM_OLLAMA_API_KEY",
         "LLM_JUDGE_BASE_URL", "LLM_JUDGE_API_KEY", "LLM_JUDGE_MODEL",
         "LLM_SYNTH_BASE_URL", "LLM_SYNTH_API_KEY", "LLM_SYNTH_MODEL",
         "LLM_FALLBACK_MODELS", "LLM_SYNTH_FALLBACK_MODELS")


class ChainLeadsTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in _VARS}
        for k in _VARS:
            os.environ.pop(k, None)
        # The live .env, as it stood when this was written.
        os.environ.update(
            LLM_JUDGE_BASE_URL="https://ollama.com/v1",
            LLM_JUDGE_API_KEY=FAKE,
            LLM_JUDGE_MODEL="gpt-oss:120b",
            LLM_SYNTH_MODEL="gpt-oss:120b",
            LLM_FALLBACK_MODELS="gpt-oss:20b",
        )

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    # -- the chain leads ----------------------------------------------------
    def test_the_chain_supplies_the_endpoint_not_the_legacy_variable(self):
        os.environ["RFPIS_LLM_PROVIDERS"] = "cerebras,ollama"
        os.environ["RFPIS_LLM_CEREBRAS_API_KEY"] = FAKE
        base, key = LC.primary_endpoint("LLM_SYNTH_BASE_URL", "LLM_JUDGE_BASE_URL")
        self.assertEqual(base, "https://api.cerebras.ai/v1")
        self.assertEqual(key, FAKE)

    def test_the_model_comes_from_the_same_provider_as_the_endpoint(self):
        """The spellings differ on purpose; a mismatch is a 404 that looks like an
        outage."""
        os.environ["RFPIS_LLM_PROVIDERS"] = "cerebras,ollama"
        os.environ["RFPIS_LLM_CEREBRAS_API_KEY"] = FAKE
        self.assertEqual(LC.model_chain("LLM_SYNTH_MODEL", "x"), ["gpt-oss-120b"])

    def test_the_legacy_vendors_other_models_are_not_tried_against_the_chain(self):
        """`LLM_FALLBACK_MODELS` is Ollama's other model. Trying it against
        Cerebras is a 404 per call for nothing — failover is the provider chain's
        job once there is one."""
        os.environ["RFPIS_LLM_PROVIDERS"] = "cerebras,ollama"
        os.environ["RFPIS_LLM_CEREBRAS_API_KEY"] = FAKE
        self.assertNotIn("gpt-oss:20b", LC.model_chain("LLM_SYNTH_MODEL", "x"))

    def test_a_model_named_against_its_own_vendor_still_wins(self):
        """The supported way to route one feature elsewhere: name the model on the
        provider that serves it, where the two are stated together."""
        os.environ["RFPIS_LLM_PROVIDERS"] = "cerebras"
        os.environ["RFPIS_LLM_CEREBRAS_API_KEY"] = FAKE
        os.environ["RFPIS_LLM_CEREBRAS_MODEL"] = "llama-3.3-70b"
        self.assertEqual(LC.model_chain("LLM_SYNTH_MODEL", "x"), ["llama-3.3-70b"])

    def test_a_feature_fallback_list_is_still_honoured(self):
        """Set for THIS feature, it is someone naming models on purpose."""
        os.environ["RFPIS_LLM_PROVIDERS"] = "cerebras"
        os.environ["RFPIS_LLM_CEREBRAS_API_KEY"] = FAKE
        os.environ["LLM_SYNTH_FALLBACK_MODELS"] = "qwen-3-32b"
        self.assertEqual(LC.model_chain("LLM_SYNTH_MODEL", "x"),
                         ["gpt-oss-120b", "qwen-3-32b"])

    def test_an_unconfigured_first_provider_does_not_lead(self):
        """Cerebras named but keyless: the chain must fall to the vendor that can
        actually answer, not hand out an endpoint that can only 401."""
        os.environ["RFPIS_LLM_PROVIDERS"] = "cerebras,ollama"
        base, _key = LC.primary_endpoint("LLM_SYNTH_BASE_URL", "LLM_JUDGE_BASE_URL")
        self.assertEqual(base, "https://ollama.com/v1")
        self.assertEqual(LC.model_chain("LLM_SYNTH_MODEL", "x"), ["gpt-oss:120b"])

    # -- and an .env with no chain is untouched -----------------------------
    def test_no_chain_means_exactly_the_old_behaviour(self):
        """The promise llm_providers was introduced on. Someone who adds nothing
        must see no change at all — same endpoint, same model, same fallback."""
        base, key = LC.primary_endpoint("LLM_SYNTH_BASE_URL", "LLM_JUDGE_BASE_URL")
        self.assertEqual(base, "https://ollama.com/v1")
        self.assertEqual(key, FAKE)
        self.assertEqual(LC.model_chain("LLM_SYNTH_MODEL", "x"),
                         ["gpt-oss:120b", "gpt-oss:20b"])

    def test_a_feature_specific_endpoint_still_wins_when_no_chain_is_set(self):
        os.environ["LLM_SYNTH_BASE_URL"] = "https://synth.example/v1"
        os.environ["LLM_SYNTH_API_KEY"] = "synth-key"
        base, key = LC.primary_endpoint("LLM_SYNTH_BASE_URL", "LLM_JUDGE_BASE_URL")
        self.assertEqual(base, "https://synth.example/v1")
        self.assertEqual(key, "synth-key")

    def test_nothing_configured_at_all_reads_as_disabled(self):
        for k in _VARS:
            os.environ.pop(k, None)
        self.assertEqual(LC.primary_endpoint("LLM_JUDGE_BASE_URL"), ("", ""))


if __name__ == "__main__":
    unittest.main()
