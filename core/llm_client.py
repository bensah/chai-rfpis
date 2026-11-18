"""Shared model-chain + fallback helper for the LLM call sites (judge, synthesis).

WHY a chain: every LLM call is one-shot (max_retries=0) and, on failure, drops
straight to the deterministic regex path. That is fine for a transient blip, but
when the free-tier weekly QUOTA runs out mid-scan, EVERY remaining call fails and
the rest of the scan silently extracts less — the "burns through the allocation
before we've extracted everything" symptom. Ollama Cloud's free tier exposes
several models (gpt-oss:120b / gpt-oss:20b / gemma3 / nemotron-3 …); a fallback
chain lets an exhausted or unavailable primary degrade to ANOTHER free model
instead of to regex. It also enables cost routing: point a feature's primary at a
cheaper model and keep the big one only as a fallback (or vice-versa) — all via
env, no code change.

WHY THAT WAS NOT ENOUGH, and what `_provider_fallback` adds
-----------------------------------------------------------
Every model in the chain above is served by ONE endpoint — the base URL and key
the caller built its client from. So the chain survives "this model is
unavailable" and nothing else. On 2026-11-18 that endpoint answered

    402 — Add usage credits or subscribe

to every model in the chain, and the LLM half of extraction had been silently
off for some time: measured the same day, `full_description` was populated on
36.6% of catalogue rows and `what_is_funded` on 36.8% — the rows written while
the credit lasted — with nothing since.

So once the MODELS are exhausted, the fallback continues across PROVIDERS
(`core.llm_providers`), which is the design Opportunova already runs and this is
carried back from. Every call site gains it without changing: the endpoint the
caller built is tried first and in full, exactly as before, and the chain is
consulted only after it has failed. With `RFPIS_LLM_PROVIDERS` unset the chain
is that same single endpoint, so nothing changes until an .env names a second
vendor.
"""
from __future__ import annotations

import logging
import os

log = logging.getLogger(__name__)

_LAST_PROVIDER = ""


def last_provider() -> str:
    """Which provider answered the most recent successful call ("" if none).

    A separate accessor rather than a fourth return value: `chat_with_fallback`'s
    (content, model, response) triple has three call sites that unpack it
    positionally, and provenance is not worth breaking them for.
    """
    return _LAST_PROVIDER


def model_chain(model_env: str, default: str) -> list[str]:
    """Ordered list of models to try for a feature.

    Resolution (de-duplicated, order preserved):
      primary   = $<model_env>  or  $LLM_JUDGE_MODEL  or  <default>
      fallbacks = $<feature>_FALLBACK_MODELS (csv)  or  $LLM_FALLBACK_MODELS (csv)

    where <feature> is model_env without its trailing ``_MODEL`` (so
    ``LLM_JUDGE_MODEL`` → ``LLM_JUDGE_FALLBACK_MODELS``)."""
    primary = os.environ.get(model_env) or os.environ.get("LLM_JUDGE_MODEL") or default
    fb_env = model_env[:-6] + "_FALLBACK_MODELS" if model_env.endswith("_MODEL") \
        else model_env + "_FALLBACK_MODELS"
    raw = os.environ.get(fb_env) or os.environ.get("LLM_FALLBACK_MODELS") or ""
    chain = [primary] + [m.strip() for m in raw.split(",") if m.strip()]
    seen: set[str] = set()
    out: list[str] = []
    for m in chain:
        if m and m not in seen:
            seen.add(m)
            out.append(m)
    return out


def chat_with_fallback(client, models, **create_kwargs):
    """Call ``client.chat.completions.create`` against each model in ``models`` until
    one returns non-empty content. Any exception (quota / rate-limit / timeout /
    unknown model) or an empty reply advances to the next model.

    Returns ``(content, model_used, response)``; ``("", "", None)`` if all fail.
    ``create_kwargs`` are forwarded verbatim (do NOT include ``model``)."""
    global _LAST_PROVIDER
    last_exc: Exception | None = None
    for m in models:
        try:
            resp = client.chat.completions.create(model=m, **create_kwargs)
            content = (resp.choices[0].message.content or "") if resp.choices else ""
            if content:
                if last_exc is not None:
                    log.info("llm fell back to model %s after earlier failure", m)
                _LAST_PROVIDER = "(caller)"
                return content, m, resp
            last_exc = RuntimeError("empty response")
        except Exception as exc:  # noqa: BLE001 — try the next model on ANY failure
            last_exc = exc
            log.warning("llm model %s failed: %s: %s; trying next fallback",
                        m, type(exc).__name__, exc)
            continue
    if last_exc is not None:
        log.warning("all llm models failed %s: %s", models, last_exc)
    return _provider_fallback(client, last_exc, **create_kwargs)


def _client_base(client) -> str:
    """The base URL a caller's client points at, normalised for comparison.

    Best-effort by design: this is only ever used to avoid re-trying an endpoint
    that has just failed, so an SDK that stops exposing `base_url` costs one
    wasted call, not correctness.
    """
    try:
        return str(getattr(client, "base_url", "") or "").rstrip("/").lower()
    except Exception:
        return ""


def _provider_fallback(client, last_exc, **create_kwargs):
    """Continue the fallback across PROVIDERS once the caller's own endpoint is
    exhausted. Same return contract as `chat_with_fallback`.

    The caller's endpoint is skipped — it is what just failed. Everything else in
    `RFPIS_LLM_PROVIDERS` is tried in order, one model each: a provider that is
    down does not deserve a second model's worth of latency when another vendor
    is sitting behind it, and per-provider model chains can be added the day
    someone has two models with one key worth trying.
    """
    global _LAST_PROVIDER
    try:
        from core import llm_providers
        from openai import OpenAI
    except Exception:
        return "", "", None

    already = _client_base(client)
    for p in llm_providers.configured_chain():
        if p.base_url.rstrip("/").lower() == already:
            continue
        try:
            alt = OpenAI(base_url=p.base_url, api_key=p.key_or_placeholder(),
                         timeout=_timeout(), max_retries=0)
            resp = alt.chat.completions.create(model=p.model, **create_kwargs)
            content = (resp.choices[0].message.content or "") if resp.choices else ""
            if content:
                log.info("llm fell back to provider %s (%s) after %s",
                         p.name, p.model, type(last_exc).__name__ if last_exc else "exhaustion")
                _LAST_PROVIDER = p.name
                return content, p.model, resp
            log.warning("llm provider %s returned an empty response", p.name)
        except Exception as exc:  # noqa: BLE001 — try the next PROVIDER on ANY failure
            log.warning("llm provider %s failed: %s: %s; trying next provider",
                        p.name, type(exc).__name__, exc)
            continue
    return "", "", None


def _timeout() -> float:
    try:
        return float(os.environ.get("LLM_JUDGE_TIMEOUT") or 90)
    except ValueError:
        return 90.0


def primary_endpoint(*base_env_names: str) -> tuple[str, str]:
    """(base_url, api_key) for a feature's FIRST endpoint, legacy names first.

    `base_env_names` are the feature's own variables in priority order, e.g.
    ("LLM_SYNTH_BASE_URL", "LLM_JUDGE_BASE_URL"); the key is read from the same
    name with `_BASE_URL` replaced by `_API_KEY`. When none of them is set, the
    first configured provider in `RFPIS_LLM_PROVIDERS` is used instead.

    Legacy first, deliberately: an .env that already works must keep working and
    must keep calling the same endpoint it calls today. The chain is what makes
    a feature available when those variables are ABSENT — a provider-only
    configuration — and what `chat_with_fallback` walks once this endpoint has
    failed.

    Returns ("", "") when nothing is configured; callers treat that as disabled.
    """
    for name in base_env_names:
        base = (os.environ.get(name) or "").strip()
        if base:
            key_name = name.replace("_BASE_URL", "_API_KEY")
            return base, (os.environ.get(key_name) or "").strip()
    try:
        from core import llm_providers
        p = llm_providers.primary()
    except Exception:
        p = None
    return (p.base_url, p.key_or_placeholder()) if p else ("", "")
