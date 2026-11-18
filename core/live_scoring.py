"""Per-row memoised live scoring for the record tables (Data / Screen).

Why this exists — PERFORMANCE. The record pages recompute a LIVE score per row (the same
core.assessment.assess_row path the Review gauge uses) so the table, its Probability
filter, and the View modal never disagree with Review. The previous approach cached the
WHOLE batch under one `@st.cache_data` key built from the full row JSON, which re-scored
all N rows whenever the key missed — and it missed constantly:

  * the delete/edit handlers call `st.cache_data.clear()`, which wipes the score cache;
  * the DB fetch has no stable tiebreaker, so re-fetches reorder equal-timestamp rows,
    churning the JSON key;
  * any unrelated column change rewrote the key.

So "Scoring rows…" ran on almost every delete, edit, pagination and page/tab switch.

This memoises PER ROW in a caller-owned dict (the page's `st.session_state`), keyed by
(profile signature, uid, row-content hash). Consequences:

  * `st.cache_data.clear()` does NOT touch session_state → surviving rows keep their scores;
  * row reordering is irrelevant (keyed by uid + content, not position);
  * only a genuinely NEW or EDITED row is (re)scored; navigation/pagination score nothing;
  * a profile/settings edit changes the signature → every row re-scores (correct).

Kept out of `core.assessment` so that module stays free of any Streamlit/session coupling —
the caller owns the memo dict and passes it in.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from core.assessment import assess_row

# Columns excluded from the per-row content hash: page-local helpers and the score OUTPUTS
# themselves (they're what we're computing / overwrite downstream, so they must not feed the
# key — otherwise every score write would invalidate its own cache).
_SKIP_KEYS = ("_search_dt", "_prob", "alignment_score", "auto_recommendation")


def profile_signature() -> str:
    """The AMBIENT tenant's score signature — profile, settings and the scoring rule.

    IT DID NOT EXIST UNTIL 2026-11-18, and two callers were already asking for it.
    `web/scripts/parity/rescore_py.py:165` imports it inside a try/except that falls back
    to `None`, so check-rescore has always been handed a null signature — and
    `check-rescore.mjs:120` reads `if (sig && stored !== sig) stale++`, which with a null
    `sig` never fires. Every stamped row therefore fell through to "claims to be current"
    and was compared against a fresh computation, with nothing able to class it as merely
    stale.

    That was invisible while stored scores happened to agree. The moment the scoring rule
    changed, 177 rows reported as current-but-wrong when the truthful answer was "stale,
    the job has not caught up" — a failure the check could not have avoided, because the
    one thing that distinguishes the two states was never reaching it.

    The caller must already be inside `set_tenant_override(...)` where a specific tenant
    is meant: `get_profile` and `get_org` read the ambient one, exactly as
    `scripts/rescore_existing.profile_signature` requires.
    """
    from core import org_profile as _orgp
    from core.score_stamp import profile_sig

    org = _orgp.get_profile()
    try:
        from core import settings as _settings
        org_set = _settings.get_org()
    except Exception:
        org_set = {}
    return profile_sig(org, org_set)


def _row_key(prof_sig: str, row: dict[str, Any]) -> str:
    payload = {k: v for k, v in row.items() if k not in _SKIP_KEYS}
    h = hashlib.sha1(
        json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:16]
    return f"{prof_sig}:{row.get('uid')}:{h}"


def scores_for(rows: list[dict[str, Any]], prof_sig: str,
               memo: dict[str, dict]) -> tuple[dict[str, dict], int]:
    """Return ({uid: score_dict}, n_scored).

    `rows` — the row dicts (e.g. df.to_dict("records")).
    `prof_sig` — a signature of the org profile + settings (busts every row on a profile edit).
    `memo` — a caller-owned cache that PERSISTS across reruns (pass st.session_state's dict);
             mutated in place: new rows are added, rows no longer present are evicted so it
             stays bounded by the current row count.

    Only rows whose (prof_sig, uid, content) key is absent from `memo` are scored — the return
    count `n_scored` lets the caller show a spinner only when real work happened."""
    keys: dict[str, str] = {}
    rowmap: dict[str, dict] = {}
    for r in rows:
        uid = r.get("uid")
        if not uid:
            continue
        uid = str(uid)
        keys[uid] = _row_key(prof_sig, r)
        rowmap[uid] = r

    valid = set(keys.values())
    n_scored = 0
    for uid, key in keys.items():
        if key not in memo:
            try:
                memo[key] = assess_row(rowmap[uid])
            except Exception:
                memo[key] = {}
            n_scored += 1

    # Evict stale entries (deleted/edited rows, previous profile signature) so the memo can't
    # grow without bound across a long session.
    for key in list(memo.keys()):
        if key not in valid:
            del memo[key]

    return {uid: memo.get(key, {}) for uid, key in keys.items()}, n_scored
