"""How much of the schema does extraction actually come back with? Per source.

WHY THIS EXISTS
---------------
The owner's bar for extraction is "at least 80% of the schema populated at worst,
100% at best". Before 2026-11-18 there was no number to hold anything to: the only
coverage figure in the tree was `core.opportunity_detail.coverage()`, computed for
ONE opportunity at a time, on the page, for a reader. Nothing aggregated it, so
"extraction is poor" was an impression formed from whichever call someone last
opened, and a change to extraction could not be shown to have helped.

WHAT IT MEASURES
----------------
`core.opportunity_detail._COVERAGE_FIELDS` — the 41 fields of DATA_SCHEMA_ETL.md §4
that carry CALL CONTENT. That list is deliberately NOT re-derived here: coverage has
to mean the same thing on the page and in this report, and the page is what the owner
is looking at when they say a call lands empty.

Two populations, because they answer different questions:

  catalog   `extracted_solicitations` — what extraction produced. This is the number
            to move: it is the output of the pipeline this script exists to grade.
  pipeline  `rfp_submissions` resolved exactly as the opportunity page resolves it
            (`standard_view` over the row JOINED to its extraction by call URL). This
            is what a reviewer actually sees, and it can be WORSE than the catalogue
            for a reason that has nothing to do with extraction: a row whose URL finds
            no extraction shows only the dozen fields matching kept.

Blankness is `opportunity_detail._blank`, again on purpose — it already treats "[]",
"{}", "N/A", "not stated" and friends as empty, which a plain `is None` does not, and
a field that holds the string "unknown" is not populated in any sense the owner means.

READING THE OUTPUT
------------------
Per-source rows are sorted worst-first and that is the point of the report: "80%"
is an average that a handful of rich sources can carry while a long tail publishes
almost nothing. `--min-rows` keeps one-row sources from topping the worst list on
no evidence.

USAGE
-----
    python scripts/measure_extraction_coverage.py                  # both populations
    python scripts/measure_extraction_coverage.py --table catalog
    python scripts/measure_extraction_coverage.py --json before.json
    python scripts/measure_extraction_coverage.py --compare before.json

`--json` writes the full per-field / per-source breakdown so a later run can be
diffed against it with `--compare`; that pair is how a before/after is reported.
Read-only against the database — it writes nothing anywhere but the file you name.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import field_extract as fe  # noqa: E402
from core import opportunity_detail as od  # noqa: E402
from db.supabase_client import get_client  # noqa: E402

FIELDS: tuple[str, ...] = od._COVERAGE_FIELDS
_PAGE = 1000


def _fetch_all(table: str, columns: str = "*") -> list[dict[str, Any]]:
    """Every row of `table`, paged — PostgREST caps a single response at 1000."""
    sb = get_client()
    out: list[dict[str, Any]] = []
    start = 0
    while True:
        chunk = (sb.table(table).select(columns)
                 .range(start, start + _PAGE - 1).execute().data or [])
        out.extend(chunk)
        if len(chunk) < _PAGE:
            return out
        start += _PAGE


#: How `_source_of` groups. Set by `main` from --group; module-level because the
#: fetch/report split passes rows, not options, and threading a flag through four
#: call sites to pick a label is worse than one switch read in one place.
_GROUP_BY = "handler"


def _source_of(row: dict[str, Any]) -> str:
    """The source label to group by.

    `source` is free text and a donor-catalogue crawl writes "<Donor> - donor catalog"
    into it. Two groupings answer two different questions, and the default answers the
    wrong one on its own:

      handler (default)  the suffix — WHICH READER produced the row, which is what a
                         per-source extraction method would be written against. Keeps
                         the table short enough to read.
      donor              the full string — WHICH FUNDER's pages we are bad at.

    The donor grouping exists because the handler one has a blind spot that was pointed
    out, correctly, the day it was written: it drops 739 of 1687 rows into one bucket
    called "donor catalog". The owner's example call (FCDO, AS-261113-143730) is in
    that bucket, so the handler view could show a healthy average while the one call
    they were looking at sat well below it. An average that can hide the case someone
    is asking about is not evidence about that case.
    """
    s = str(row.get("source") or row.get("_source_origin") or "").strip()
    if not s:
        return "(no source)"
    if _GROUP_BY == "donor":
        return s
    low = s.lower()
    for marker in (" - donor catalog", " – donor catalog", " donor catalog"):
        if low.endswith(marker):
            return "donor catalog"
    return s


def _row_coverage(view: dict[str, Any]) -> tuple[int, list[str]]:
    filled, _total, missing = od.coverage(view)
    return filled, missing


def _catalog_views() -> list[tuple[str, dict[str, Any]]]:
    """(source, view) for every catalogue row. A catalogue row IS the schema already."""
    rows = _fetch_all("extracted_solicitations")
    return [(_source_of(r), od.standard_view(od.KIND_CATALOG, r, r)) for r in rows]


def _pipeline_views() -> list[tuple[str, dict[str, Any]]]:
    """(source, view) for every pipeline row, joined to its extraction the way the
    opportunity page joins it — by NORMALISED call URL, which is why the join is done
    here in Python over a full fetch rather than per-row in SQL."""
    subs = _fetch_all("rfp_submissions")
    cat = _fetch_all("extracted_solicitations")
    by_link: dict[str, dict[str, Any]] = {}
    for c in cat:
        for key in (c.get("opportunity_url"), c.get("apply_url")):
            k = od.normalise_link(key)
            if k:
                by_link.setdefault(k, c)
    out = []
    for r in subs:
        ext = by_link.get(od.normalise_link(r.get("opportunity_link")))
        out.append((_source_of(r) if r.get("source") not in (None, "", "auto")
                    else _source_of(ext or {}),
                    od.standard_view(od.KIND_PIPELINE, r, ext)))
    return out


def _report(label: str, views: list[tuple[str, dict[str, Any]]],
            min_rows: int) -> dict[str, Any]:
    n = len(views)
    total_fields = len(FIELDS)
    if not n:
        print(f"\n== {label}: no rows")
        return {"rows": 0}

    per_field_filled: dict[str, int] = defaultdict(int)
    per_source: dict[str, list[int]] = defaultdict(list)
    grand_filled = 0
    for source, view in views:
        filled, missing = _row_coverage(view)
        grand_filled += filled
        per_source[source].append(filled)
        missing_set = set(missing)
        for f in FIELDS:
            if f not in missing_set:
                per_field_filled[f] += 1

    overall = grand_filled / (n * total_fields) * 100
    at_80 = sum(1 for _s, v in views if _row_coverage(v)[0] / total_fields >= 0.8)

    print(f"\n== {label}: {n} rows x {total_fields} schema fields")
    print(f"   OVERALL COVERAGE  {overall:5.1f}%"
          f"   |  rows at or above 80%: {at_80}/{n} ({at_80 / n * 100:.1f}%)")

    print("\n   -- per field (worst first) --")
    for f in sorted(FIELDS, key=lambda f: per_field_filled[f]):
        pct = per_field_filled[f] / n * 100
        bar = "#" * int(pct / 5)
        print(f"     {pct:5.1f}%  {per_field_filled[f]:5d}/{n:<5d} {f:<30} {bar}")

    print(f"\n   -- per source (worst first, >= {min_rows} rows) --")
    scored = []
    for src, filled_list in per_source.items():
        if len(filled_list) < min_rows:
            continue
        pct = sum(filled_list) / (len(filled_list) * total_fields) * 100
        scored.append((pct, src, len(filled_list)))
    for pct, src, cnt in sorted(scored):
        flag = "  <-- below 80%" if pct < 80 else ""
        print(f"     {pct:5.1f}%  {cnt:4d} rows  {src[:58]:<58}{flag}")

    small = sum(1 for v in per_source.values() if len(v) < min_rows)
    if small:
        print(f"     ({small} source(s) with fewer than {min_rows} rows omitted)")

    return {
        "rows": n,
        "fields": total_fields,
        "overall_pct": round(overall, 2),
        "rows_at_80_pct": round(at_80 / n * 100, 2),
        "per_field_pct": {f: round(per_field_filled[f] / n * 100, 2) for f in FIELDS},
        "per_source_pct": {src: round(sum(v) / (len(v) * total_fields) * 100, 2)
                           for src, v in per_source.items()},
        "per_source_rows": {src: len(v) for src, v in per_source.items()},
    }


def _availability() -> None:
    """Is a blank field OUR gap, or a fact the funder never published?

    The owner's rule for the schema is "where a data point is found to be
    consistently unavailable across sources, propose removing it instead of
    continuing to extract it — measure before proposing". Fill rate alone cannot
    support that proposal: 0% is equally consistent with "nobody publishes this"
    and with "we never wrote the extractor", and those call for opposite actions.

    So for each field with a cue in `core.field_extract.AVAILABILITY_CUES` this
    reports, over the rows that HAVE source text to judge by:

        published   the source text mentions the subject at all
        filled      we have a value
        our gap     published and still blank  <- fix the extractor
        unavailable not published anywhere     <- the removal argument

    A field whose `published` rate is near zero across every source is the one to
    propose removing. A field with a large "our gap" is an extraction bug wearing
    the same 0%.
    """
    rows = _fetch_all("extracted_solicitations")
    with_text = [r for r in rows if len(str(r.get("raw_text") or "").strip()) >= 200]
    n = len(with_text)
    print(f"\n== availability: {n} of {len(rows)} catalogue rows carry enough source "
          f"text (>=200 chars) to judge")
    print(f"\n   {'field':<30} {'published':>10} {'filled':>8} {'our gap':>9} {'unavail':>9}")
    rank: list[tuple[float, str, str]] = []
    for field in sorted(fe.AVAILABILITY_CUES):
        pub = fil = gap = 0
        for r in with_text:
            p = fe.fact_is_published(field, r.get("raw_text"))
            f_ok = not od._blank(r.get(field))
            pub += bool(p)
            fil += f_ok
            gap += bool(p and not f_ok)
        unavail = n - pub
        print(f"   {field:<30} {pub / n * 100:9.1f}% {fil / n * 100:7.1f}% "
              f"{gap / n * 100:8.1f}% {unavail / n * 100:8.1f}%")
        rank.append((pub / n * 100, field, f"filled {fil / n * 100:.1f}%"))

    print("\n   -- removal candidates: the subject is absent from almost every source --")
    none_found = True
    for pub_pct, field, note in sorted(rank):
        if pub_pct < 10:
            none_found = False
            print(f"     {field:<30} mentioned on {pub_pct:.1f}% of rows with text, {note}")
    if none_found:
        print("     (none — every measured field's subject appears on at least 10% of rows)")


def _compare(before: dict[str, Any], after: dict[str, Any]) -> None:
    for label in ("catalog", "pipeline"):
        b, a = before.get(label), after.get(label)
        if not b or not a or not b.get("rows") or not a.get("rows"):
            continue
        print(f"\n== {label}: {b['overall_pct']:.1f}% -> {a['overall_pct']:.1f}% "
              f"({a['overall_pct'] - b['overall_pct']:+.1f} pts)   "
              f"rows >=80%: {b['rows_at_80_pct']:.1f}% -> {a['rows_at_80_pct']:.1f}%")
        moved = [(a["per_field_pct"][f] - b["per_field_pct"].get(f, 0.0), f)
                 for f in a["per_field_pct"]
                 if abs(a["per_field_pct"][f] - b["per_field_pct"].get(f, 0.0)) >= 0.5]
        for delta, f in sorted(moved, reverse=True):
            print(f"     {delta:+6.1f} pts  {f:<30} "
                  f"{b['per_field_pct'].get(f, 0.0):5.1f}% -> {a['per_field_pct'][f]:5.1f}%")
        if not moved:
            print("     (no field moved by 0.5pt or more)")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--table", choices=("catalog", "pipeline", "both"), default="both")
    p.add_argument("--group", choices=("handler", "donor"), default="handler",
                   help="group per-source rows by the READER (default) or by the funder")
    p.add_argument("--min-rows", type=int, default=5,
                   help="per-source rows needed before a source is listed (default 5)")
    p.add_argument("--json", metavar="PATH", help="write the full breakdown here")
    p.add_argument("--compare", metavar="PATH",
                   help="a --json file from an earlier run; print the deltas")
    p.add_argument("--availability", action="store_true",
                   help="is a blank field our gap, or a fact no funder publishes?")
    args = p.parse_args(argv)
    global _GROUP_BY
    _GROUP_BY = args.group

    if args.availability:
        _availability()
        return 0

    result: dict[str, Any] = {}
    if args.table in ("catalog", "both"):
        result["catalog"] = _report("catalog (extracted_solicitations)",
                                    _catalog_views(), args.min_rows)
    if args.table in ("pipeline", "both"):
        result["pipeline"] = _report("pipeline (rfp_submissions, as the page resolves it)",
                                     _pipeline_views(), args.min_rows)

    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(f"\nwrote {args.json}")
    if args.compare:
        print("\n" + "=" * 70 + "\nBEFORE -> AFTER")
        _compare(json.loads(Path(args.compare).read_text(encoding="utf-8")), result)
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    raise SystemExit(main())
