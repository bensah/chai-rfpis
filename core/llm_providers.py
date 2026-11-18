"""The provider chain — which vendor answers an LLM call, and in what order.

WHY THIS EXISTS
---------------
Every LLM call in RFPIS — the judge, store synthesis, catalogue synthesis, the
extractor — resolves its endpoint from ONE pair of environment variables,
`LLM_JUDGE_BASE_URL` / `LLM_JUDGE_API_KEY`. `core.llm_client.model_chain` adds a
fallback, but every model in it is served by that same endpoint. So the chain
protects against "this model is unavailable" and against nothing else.

On 2026-11-18 that endpoint answered every request with

    402 — Add usage credits or subscribe

for `gpt-oss:120b` AND `gpt-oss:20b`, the whole configured chain. The failure is
handled correctly everywhere (one-shot, no retries, fall back to regex), and the
result is that the LLM half of extraction had simply stopped running. Measured
over the live catalogue the same day: `full_description` 36.6%, `what_is_funded`
36.8%, `applicant_fit_profile` 39.0% — rows written while the credit lasted —
and nothing since. Nothing logged an error a human would see, because each call
site treats a model failure as a normal fall-back-to-regex day.

A chain of models behind one dead key cannot recover from that. A chain of
PROVIDERS can, and that is what Opportunova (forked from this codebase) already
runs: `OPPORTUNOVA_LLM_PROVIDERS=gemini,zai,ollama,claude`, resolved by
`services/api/app/llm/providers.py`. This module is that design carried back,
with RFPIS's own env names and its existing configuration kept working.

WHAT IS CARRIED, AND WHAT IS NOT
--------------------------------
Carried: the order is DATA, not branches; per-provider env resolution by NAME;
built-in defaults so a chain entry needs only a key; aliases so `gemini` and
`google` are the same thing; and a provider that is not named is never called,
however badly the others fail.

Not carried: Opportunova's usage ledger, cost accounting and circuit breaker.
They belong with its per-call budget tracking, which RFPIS does not have, and
bringing them would be a second system rather than a fix for this one.

CONFIGURATION
-------------
    RFPIS_LLM_PROVIDERS=google,ollama,glm        # order; first configured wins
    RFPIS_LLM_<NAME>_BASE_URL / _API_KEY / _MODEL

Nothing is required. With `RFPIS_LLM_PROVIDERS` unset the chain is exactly
today's single endpoint and today's behaviour: the `ollama` slot reads the
legacy `LLM_JUDGE_*` / `LLM_EXTRACT_*` variables, so an existing .env keeps
working with no edit at all. Adding a second vendor is one line of .env.

ANTHROPIC is reachable but is NOT in the default chain, deliberately — it is the
only provider here that bills per token with no free tier, and the owner has said
more than once that this project runs on free and cheap tiers. It is used when it
is named.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

#: Order used when RFPIS_LLM_PROVIDERS is unset.
#:
#: `ollama` alone, because that is what this repo has been configured with since
#: the LLM work started and a default that silently started calling a different
#: vendor would be a surprise, not a fix. The point of the module is that adding
#: `google,` in front of it is now an .env edit rather than a code change.
DEFAULT_CHAIN: tuple[str, ...] = ("ollama",)

#: Per-provider defaults. A name absent from here still works — it just has to
#: supply its own base URL and model.
DEFAULTS: dict[str, dict[str, str]] = {
    "google": {
        # Google AI Studio speaks the OpenAI chat-completions dialect at this
        # path, so it needs no client of its own. The native
        # `generativelanguage` endpoint is a DIFFERENT dialect — do not point
        # this at it.
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        # Flash, not Pro: the free tier's daily request allowance is far larger
        # on Flash, and extraction is high-volume and shallow.
        "model": "gemini-3.6-flash",
    },
    "ollama": {
        "base_url": "https://ollama.com/v1",
        "model": "gpt-oss:120b",
    },
    "glm": {
        "base_url": "https://api.z.ai/api/paas/v4",
        "model": "glm-4.7-flash",
    },
    "deepseek": {
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-chat",
    },
    "anthropic": {
        "base_url": "https://api.anthropic.com/v1",
        "model": "claude-haiku-4-5",
    },
}

#: Other spellings of the same provider. `glm` names the MODEL FAMILY and the
#: vendor is Z.ai, so both spellings resolve to one configuration rather than
#: leaving it as tribal knowledge.
ALIASES: dict[str, str] = {"zai": "glm", "z.ai": "glm", "gemini": "google",
                           "claude": "anthropic"}

#: The slot that inherits the pre-existing single-endpoint configuration. Those
#: variables hold working credentials; renaming them to suit this refactor is
#: how an evening gets lost.
LEGACY_SLOT = "ollama"


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str
    api_key: str
    model: str

    @property
    def configured(self) -> bool:
        """Can this provider be called at all?

        Base URL, model, and — for a REMOTE host — a key.

        The existing `is_enabled()` probes require only a base URL, on the
        reasoning that a local Ollama ignores the key. That reasoning is sound
        and is kept, but only for a local host: every entry in `DEFAULTS` ships
        a base URL and a model, so without the key test a bare chain would
        report every vendor as callable and a scan would spend its latency
        budget on calls that can only 401. A loopback host still needs no key.
        """
        if not (self.base_url and self.model):
            return False
        if self.api_key:
            return True
        host = self.base_url.split("//")[-1].split("/")[0].split(":")[0].lower()
        return host in ("localhost", "127.0.0.1", "[::1]", "::1")

    def key_or_placeholder(self) -> str:
        """The OpenAI SDK refuses to construct a client with an empty key, and a
        local endpoint does not read it. Every call site in this repo already
        passes a placeholder for that reason; it lives here now instead."""
        return self.api_key or "not-needed"


def _env(name: str, key: str, legacy: bool) -> str:
    """RFPIS_LLM_<NAME>_<KEY>, falling back to the legacy names for one slot."""
    v = os.environ.get(f"RFPIS_LLM_{name.upper()}_{key}")
    if v and v.strip():
        return v.strip()
    if legacy:
        for legacy_name in (f"LLM_SYNTH_{key}", f"LLM_EXTRACT_{key}",
                            f"LLM_JUDGE_{key}"):
            v = os.environ.get(legacy_name)
            if v and v.strip():
                return v.strip()
    return ""


def provider(name: str) -> Provider:
    """One named provider, resolved from the environment right now.

    Resolved at CALL time, never at import, so a .env edit during a Streamlit
    hot-reload is picked up without a restart — the rule the rest of the LLM
    modules already follow.
    """
    name = ALIASES.get((name or "").strip().lower(), (name or "").strip().lower())
    legacy = name == LEGACY_SLOT
    d = DEFAULTS.get(name, {})
    return Provider(
        name=name,
        base_url=_env(name, "BASE_URL", legacy) or d.get("base_url", ""),
        api_key=_env(name, "API_KEY", legacy),
        model=_env(name, "MODEL", legacy) or d.get("model", ""),
    )


def chain() -> list[Provider]:
    """The providers to try, in order.

    Unconfigured entries are KEPT in the list rather than filtered out, so
    `status()` can say "deepseek: not configured" — which is the answer to "why
    did nothing happen", and dropping it would hide the question.
    """
    raw = (os.environ.get("RFPIS_LLM_PROVIDERS") or "").strip()
    names = [n.strip() for n in raw.split(",") if n.strip()]
    return [provider(n) for n in (names or DEFAULT_CHAIN)]


def configured_chain() -> list[Provider]:
    """Only the providers that can actually be called, in order."""
    return [p for p in chain() if p.configured]


def primary() -> Provider | None:
    """The first provider in the chain that can be called, or None."""
    got = configured_chain()
    return got[0] if got else None


def any_configured() -> bool:
    """True when at least one provider in the chain can be called."""
    return bool(configured_chain())


def status() -> dict[str, dict]:
    """Which providers are configured right now, in chain order — for
    `scripts/env_report.py` and the env-diagnostics page. Never includes a key."""
    return {p.name: {"configured": p.configured, "model": p.model,
                     "base_url": p.base_url, "has_key": bool(p.api_key),
                     "position": i + 1}
            for i, p in enumerate(chain())}
