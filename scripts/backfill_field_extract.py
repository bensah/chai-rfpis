"""Fill the schema fields `core.field_extract` can read, over the rows already stored.

RETIRED 2026-11-19 — DO NOT RUN THIS AGAINST THE LIVE DATABASE.
---------------------------------------------------------------
The owner's rule from that date: "we are forward looking now. only new rfps
should be completed following the updated crawler and extractor so we don't end
up with extracted calls with low data."

So repairing stored rows is no longer the plan, and this script is kept for its
measurement value — `--limit N` with no `--apply` still prints exactly what the
deterministic pass would find on real rows, which is a cheap way to check the
extractor against the live corpus without writing anything. Running it with
`--apply` is contrary to a standing instruction.

The work it used to do now happens at ingest: `core/extract.build_record` calls
`field_extract.derive_fields` before the record is returned, so a new row carries
these fields when it is first written.

A NOTE ON WHAT THIS DOCSTRING USED TO SAY, because it misled someone once: it
claimed "`core/field_extract.py` now runs inside extraction, so every NEW row
arrives with these fields". That was an intention written as a fact — the wiring
did not exist until 2026-11-19, and every row scanned in between arrived without
it. The wiring is real now; the lesson is that a docstring is not evidence.

WHAT IT USED TO BE FOR
----------------------
The 1687 rows already in the catalogue — including the SRHR call the owner opened
to show that a discovered call lands almost empty.

The source material is already paid for: `raw_text` is present on 96.7% of
catalogue rows. Nothing here fetches a page, calls a model or spends anything.

WHAT IT WRITES
--------------
Only fields that are BLANK on the row. A value a handler read, a model answered or
a person corrected is never touched, which is what makes a re-run safe and makes
this script idempotent: the second run writes nothing.

It also writes the DONOR LINK (`donor_key`, `donor_intel_id`), which is NULL on
every catalogue row today. That link is what "extraction complements the call with
stored donor data" means in the record rather than only at score time: the scorer
already resolves the donor by funder name on every scoring pass, but the row
itself has never said which donor it resolved to, so nothing downstream — the
opportunity page, a report, an audit of why MUST-5 activated — can see it.

The link uses EXACT matching only (`match_donor(fuzzy=False)`). The fuzzy fallback
would raise coverage from 10.4% to 37.3% of rows, and `core/donor_intel.py` says
plainly why that is the wrong trade on a gate path: "a wrong substring match there
injects the wrong donor's HQ / ceiling / priorities and can force a FALSE
auto-Decline". A stored link is read by exactly those paths.

USAGE
-----
    python scripts/backfill_field_extract.py                 # dry run, prints a plan
    python scripts/backfill_field_extract.py --apply
    python scripts/backfill_field_extract.py --apply --table pipeline
    python scripts/backfill_field_extract.py --limit 50 --verbose

DRY RUN BY DEFAULT, like every other bulk script here, and for a sharper reason
than usual: `db/supabase_client.py` talks to the REAL, HOSTED, SHARED Supabase
instance. There is no local throwaway database — a write here is a write for
everybody, immediately.
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import field_extract as fe  # noqa: E402
from db.supabase_client import get_client  # noqa: E402

_PAGE = 1000

#: Catalogue columns `derive_fields` may write. `core/extracted_store.py` has its
#: own allow-list; this one exists so a typo here fails loudly rather than being
#: silently dropped by PostgREST.
_CATALOG_COLUMNS = frozenset({
    "call_award_floor", "call_award_ceiling", "total_program_funding",
    "expected_awards", "expected_award_date", "time_to_award", "project_duration",
    "eligibility_applicant_types", "eligibility_countries", "what_is_not_funded",
    "attachments", "resource_links", "submission_format", "call_domain_areas",
    "focus_themes", "instrument_type", "solicitation_type", "field_provenance",
    "donor_key", "donor_intel_id",
})

#: The pipeline table names some of the same facts differently, and does not have
#: the rest at all. Mapping rather than writing blind: an unknown column makes the
#: whole PostgREST request fail, taking the valid fields with it.
_PIPELINE_RENAME = {
    "eligibility_countries": None,       # no column on rfp_submissions
    "what_is_not_funded": None,
    "attachments": None,
    "resource_links": None,
    "focus_themes": "focus_theme",       # text, not a list — handled below
    "eligibility_applicant_types": None,
    "field_provenance": None,
    "donor_key": None,
    "donor_intel_id": None,
}


def _fetch_all(table: str) -> list[dict[str, Any]]:
    sb = get_client()
    out: list[dict[str, Any]] = []
    start = 0
    while True:
        chunk = (sb.table(table).select("*")
                 .range(start, start + _PAGE - 1).execute().data or [])
        out.extend(chunk)
        if len(chunk) < _PAGE:
            return out
        start += _PAGE


def _donor_link(row: dict[str, Any]) -> dict[str, Any]:
    """`{donor_key, donor_intel_id}` for this row's funder, or {} — exact match only."""
    if row.get("donor_intel_id") or row.get("donor_key"):
        return {}
    try:
        from core.donor_intel import match_donor
        donor = match_donor(row.get("funder_name") or row.get("funding_agency"),
                            fuzzy=False)
    except Exception:
        return None or {}
    if not donor:
        return {}
    out: dict[str, Any] = {}
    if donor.get("id"):
        out["donor_intel_id"] = donor["id"]
    if donor.get("canonical_key"):
        out["donor_key"] = donor["canonical_key"]
    return out


def _for_pipeline(updates: dict[str, Any]) -> dict[str, Any]:
    """The catalogue-shaped updates, translated to `rfp_submissions` columns."""
    out: dict[str, Any] = {}
    for field, value in updates.items():
        if field in _PIPELINE_RENAME:
            target = _PIPELINE_RENAME[field]
            if target is None:
                continue
            if target == "focus_theme":
                # The pipeline column is a single text value; the catalogue's is a
                # list. Taking the first keeps the column's meaning rather than
                # JSON-encoding a list into a text field, which is how
                # `project_stages` was broken once already.
                value = value[0] if isinstance(value, (list, tuple)) and value else value
            out[target] = value
        else:
            out[field] = value
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--apply", action="store_true",
                   help="write to the live database (default: dry run)")
    p.add_argument("--table", choices=("catalog", "pipeline", "both"), default="catalog")
    p.add_argument("--limit", type=int, help="stop after this many rows")
    p.add_argument("--verbose", action="store_true",
                   help="print every row's updates, with the evidence quoted")
    args = p.parse_args(argv)

    sb = get_client()
    tables = (["extracted_solicitations"] if args.table == "catalog"
              else ["rfp_submissions"] if args.table == "pipeline"
              else ["extracted_solicitations", "rfp_submissions"])

    for table in tables:
        catalog = table == "extracted_solicitations"
        rows = _fetch_all(table)
        if args.limit:
            rows = rows[:args.limit]
        touched = 0
        per_field: collections.Counter = collections.Counter()
        failures = 0

        for row in rows:
            updates = fe.derive_fields(row)
            if catalog:
                updates.update(_donor_link(row))
            else:
                updates = _for_pipeline(updates)
            updates = {k: v for k, v in updates.items()
                       if (k in _CATALOG_COLUMNS if catalog else True)}
            if not updates:
                continue
            touched += 1
            per_field.update(updates.keys())
            if args.verbose:
                prov = updates.get("field_provenance") or {}
                print(f"\n  {row.get('uid')}  {str(row.get('opportunity_name') or row.get('opportunity_title') or '')[:60]}")
                for k, v in sorted(updates.items()):
                    if k == "field_provenance":
                        continue
                    quote = (prov.get(k) or {}).get("evidence", "") if isinstance(prov, dict) else ""
                    shown = json.dumps(v)[:90] if isinstance(v, (list, dict)) else str(v)[:90]
                    print(f"      {k:<30} = {shown}" + (f"   <<{quote[:70]}>>" if quote else ""))
            if args.apply:
                try:
                    sb.table(table).update(updates).eq("uid", row["uid"]).execute()
                except Exception as exc:
                    failures += 1
                    print(f"  ! {row.get('uid')}: {type(exc).__name__}: {exc}")

        verb = "updated" if args.apply else "would update"
        print(f"\n== {table}: {verb} {touched} of {len(rows)} rows"
              + (f"  ({failures} write failures)" if failures else ""))
        for field, n in per_field.most_common():
            print(f"     {n:5d}  {field}")
    if not args.apply:
        print("\nDRY RUN — nothing was written. Re-run with --apply.")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    raise SystemExit(main())
