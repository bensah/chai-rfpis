"""The Python half of the My Organization parity check.

Four rules, each imported from the module that owns it rather than retyped:

  * `core.org_profile.get_profile`'s MERGE — `_deep_merge(DEFAULT_PROFILE,
    _migrate_keys(overlay))`. Called on the raw overlay directly, not through
    `get_profile`, so the comparison is the merge and not a database round trip.
  * `core.settings.get_org`'s merge onto `_ORG_DEFAULTS`, with the display name taken
    from `tenants.name`.
  * `core.profile_completeness` — the weighted score, the missing labels, the RAG band
    and the screening-readiness gap. A pure module with its own unit tests.
  * `legal_type_label` / `entity_type_label`, and `rating_bars_html`'s sort order.

READ ONLY. It reads every tenant's stored blobs and writes nothing.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from core import org_profile as op                               # noqa: E402
from core import settings as st                                  # noqa: E402
from core.profile_completeness import (                          # noqa: E402
    completeness, rag_band, readiness_gap)
from core.program_area_classifier import category_full, subarea_label  # noqa: E402
from core.program_area_select import RATING_WORD, _as_rating_map       # noqa: E402


def merge_profile(overlay):
    """`get_profile`'s merge, without the database or the derived user-areas key.

    `org_user_declared_areas` is deliberately excluded: `get_profile` fills it from the
    users table on every read and never persists it, and the React page neither shows nor
    reads it. Including it here would compare a value the port does not claim to have.
    """
    o = op._coerce_overlay(overlay)
    if not o:
        return dict(op.DEFAULT_PROFILE)
    import copy
    return op._deep_merge(op.DEFAULT_PROFILE, op._migrate_keys(copy.deepcopy(o)))


def merge_identity(tenant_name, identity):
    """`get_org`'s merge. The display name is `tenants.name`, not the blob's own copy."""
    ident = op._coerce_overlay(identity) or {}
    out = {}
    for key, default in st._ORG_DEFAULTS.items():
        v = ident.get(key)
        out[key] = v if v not in (None, "") else default
    out["org_name"] = (tenant_name or ident.get("org_name")
                       or st._ORG_DEFAULTS["org_name"])
    return out


def rating_rows(ratings):
    """`rating_bars_html`'s DATA — the same sort, the same labels, no HTML."""
    rmap = _as_rating_map(ratings)
    return [{"key": k, "label": subarea_label(k), "category": category_full(k),
             "value": int(v), "word": RATING_WORD.get(v, "")}
            for k, v in sorted(rmap.items(), key=lambda kv: (-kv[1], kv[0]))]


def main() -> None:
    payload = json.loads(sys.stdin.read())

    out = []
    for t in payload["tenants"]:
        prof = merge_profile(t.get("org_profile"))
        ident = merge_identity(t.get("name"), t.get("org_identity"))
        pct, missing = completeness(ident, prof)
        out.append({
            "id": t.get("id"),
            "identity": {k: ("" if v is None else str(v)) for k, v in ident.items()},
            # Compared as JSON, so key ORDER does not matter but every value does.
            "profile": prof,
            "pct": pct,
            "missing": missing,
            "band": rag_band(pct),
            "gap": readiness_gap(prof),
            "domain": rating_rows(prof.get("org_domain_ratings")),
            "priority": rating_rows(prof.get("org_priority_ratings")),
        })

    print(json.dumps({
        "tenants": out,
        "legal": [op.legal_type_label(c) for c in payload["codes"]],
        "entity": [op.entity_type_label(c) for c in payload["codes"]],
        "defaults": op.DEFAULT_PROFILE,
        "org_defaults": st._ORG_DEFAULTS,
        "renamed": op._RENAMED_KEYS,
    }, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
