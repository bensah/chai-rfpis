"""The Python half of check-extraction. Reads the live stores; writes nothing.

Prints one JSON object:

    schema_fields    core.opportunity_detail._COVERAGE_FIELDS — the schema the
                     opportunity page measures itself against
    derived_fields   core.field_extract.DERIVED_FIELDS — what the deterministic
                     pass claims it can produce
    catalog_columns  the real column names on extracted_solicitations, from a
                     live row (there is no DDL to read through PostgREST)
    allowed_columns  core.extracted_store's own write allow-list
    coverage         per-field fill rate over the catalogue, plus the overall
                     figure and the share of rows at or above 80%
    placeholders     fields whose stored value is a placeholder string on any
                     row ("unspecified program area" and friends) — a value that
                     reads as populated to every blank test and tells a reviewer
                     nothing
    sample           one row's derived output, so the .mjs can assert the
                     blank-only contract against real data rather than a fixture
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from core import field_extract as fe  # noqa: E402
from core import extracted_store  # noqa: E402
from core import opportunity_detail as od  # noqa: E402
from db.supabase_client import get_client  # noqa: E402

_PAGE = 1000
#: Values a blank test counts as present and a reader cannot act on. Kept here
#: rather than in `opportunity_detail._PLACEHOLDERS` on purpose: that list is what
#: the PAGE hides, and this one is what EXTRACTION must never write. They overlap
#: but they are not the same question.
_PLACEHOLDER_VALUES = {"unspecified program area", "unspecified", "not stated",
                       "not specified", "unknown", "n/a", "na", "none", "tbd", "tbc"}


def _all(table: str) -> list[dict]:
    sb = get_client()
    out: list[dict] = []
    start = 0
    while True:
        chunk = (sb.table(table).select("*")
                 .range(start, start + _PAGE - 1).execute().data or [])
        out.extend(chunk)
        if len(chunk) < _PAGE:
            return out
        start += _PAGE


def _is_placeholder(v) -> bool:
    items = v if isinstance(v, (list, tuple)) else [v]
    return any(str(i or "").strip().lower() in _PLACEHOLDER_VALUES for i in items)


def main() -> int:
    rows = _all("extracted_solicitations")
    fields = list(od._COVERAGE_FIELDS)
    n = len(rows) or 1

    per_field = {f: sum(1 for r in rows if not od._blank(r.get(f))) for f in fields}
    filled = sum(per_field.values())
    at80 = sum(1 for r in rows
               if sum(1 for f in fields if not od._blank(r.get(f))) / len(fields) >= 0.8)

    placeholders = sorted({f for f in fields for r in rows
                           if not od._blank(r.get(f)) and _is_placeholder(r.get(f))})

    # The blank-only contract, asserted against a REAL row rather than a fixture:
    # re-deriving a row that has already been backfilled must produce nothing, and
    # that is what makes the backfill idempotent.
    sample = {}
    for r in rows:
        if str(r.get("raw_text") or "").strip():
            sample = {"uid": r.get("uid"),
                      "derived": sorted(fe.derive_fields(r).keys()),
                      "already_set": sorted(f for f in fe.DERIVED_FIELDS
                                            if not od._blank(r.get(f)))}
            break

    print(json.dumps({
        "schema_fields": fields,
        "derived_fields": list(fe.DERIVED_FIELDS),
        "catalog_columns": sorted(rows[0].keys()) if rows else [],
        "allowed_columns": sorted(extracted_store._COLS),
        "rows": len(rows),
        "coverage": {
            "overall_pct": round(filled / (n * len(fields)) * 100, 2),
            "rows_at_80_pct": round(at80 / n * 100, 2),
            "per_field_pct": {f: round(c / n * 100, 2) for f, c in per_field.items()},
        },
        "placeholders": placeholders,
        "sample": sample,
    }))
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    raise SystemExit(main())
