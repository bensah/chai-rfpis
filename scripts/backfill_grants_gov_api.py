"""Re-read stored grants.gov rows from the funder's own API instead of its HTML.

RETIRED BEFORE IT EVER RAN — 2026-11-19. DO NOT `--apply`.
----------------------------------------------------------
The owner's rule from that date: "we are forward looking now. only new rfps
should be completed following the updated crawler and extractor so we don't end
up with extracted calls with low data." This script repairs stored rows, which is
exactly what is no longer wanted. It was never applied; only its dry run ran.

THE FIX IT PROVED IS IN THE CRAWLER INSTEAD. `scraper._scan_grants_gov` now puts
the API synopsis (and the eligibility paragraph) on the candidate as `_page_text`,
which is the field `extract.build_record` stores as `raw_text` and everything
downstream reads — so a NEW grants.gov row carries the real call text rather than
the rendered shell. `deep_read.enrich` no longer overwrites it with chrome.

Kept, not deleted, for two reasons: its dry run is the cheapest way to see what
the API holds for rows we already have, and `_updates_for` is the tested
definition of "what an API answer should change", which the crawler-side fix is
checked against.

WHAT IT WAS FOR
---------------
`grants.gov/search-results-detail/<id>` is a JavaScript single-page app: the
opportunity loads client-side, so a plain fetch gets the shell. Measured
2026-11-19 over the 469 live grants.gov catalogue rows, 168 of them hold nothing
but page chrome —

    "An official website of the United States government … Menu Search Site
     Content Help Register Login … Unsaved changes will be lost. Ok"

— and a further 35 hold under 400 characters, which is below the floor
`catalog_synthesis` will spend a model call on. Rendering the page does not help:
the content was never in the HTML.

It does not have to be. Grants.gov publishes `fetchOpportunity`, this repo
already calls it (`scraper._fetch_grants_gov_details`), and that function is
reused here rather than a second client being written. For the row the owner's
peer sampled it returns 980 characters of real synopsis and 712 of the funder's
own eligibility wording, against the 999 characters of chrome we stored.

WHAT IT WRITES
--------------
    raw_text               the synopsis — the grounding text synthesis reads
    eligibility_other      `applicantEligibilityDesc`, the funder's own words
    total_program_funding  `estimatedFunding`
    call_award_floor/_ceiling, expected_awards
    date_posted, deadline  the authoritative `postingDate` / `responseDate`

`raw_text` is REPLACED only when what we hold is chrome, or when the API text is
materially longer. Everything else fills a blank and never overwrites, so a value
a person corrected is safe and a re-run is idempotent.

It deliberately does NOT write `brief_description`. That column holds the
org-neutral SYNTHESISED brief, and `core/extract.py` is explicit that it must
never fall back to raw text — "empty beats ALL-CAPS legalese". The synopsis
belongs in `raw_text`, where synthesis can then read it. Run
`scripts/backfill_catalog_synthesis.py` afterwards to turn it into prose.

USAGE
-----
    python scripts/backfill_grants_gov_api.py                  # dry run
    python scripts/backfill_grants_gov_api.py --apply
    python scripts/backfill_grants_gov_api.py --only-thin --apply
    python scripts/backfill_grants_gov_api.py --limit 20 --verbose

DRY RUN BY DEFAULT. `db/supabase_client.py` talks to the real, hosted, shared
Supabase instance; there is no local throwaway database, so a write here is a
write for everybody, immediately.
"""
from __future__ import annotations

import argparse
import collections
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.scraper import _fetch_grants_gov_details  # noqa: E402
from db.supabase_client import get_client  # noqa: E402

_PAGE = 1000
_MIN_TEXT = 400          # catalog_synthesis._MIN_TEXT — below this it makes no call
_GAIN = 200              # replace stored text only if the API adds at least this much

#: Site furniture rather than a call. Deliberately keyed on phrases that cannot
#: occur in a funding synopsis, so a real call is never mistaken for chrome.
_CHROME = re.compile(
    r"official website of the United States government|"
    r"Unsaved changes will be lost|Vulnerability Disclosure Policy", re.I)

#: grants.gov/search-results-detail/<numeric id>  — the id fetchOpportunity wants.
_ID_RE = re.compile(r"/search-results-detail/(\d+)")


def _host(url: Any) -> str:
    return (urlsplit(str(url or "")).hostname or "").lower().removeprefix("www.")


def _numeric_id(row: dict[str, Any]) -> str | None:
    m = _ID_RE.search(str(row.get("opportunity_url") or ""))
    return m.group(1) if m else None


def _clean_html(v: Any) -> str:
    s = re.sub(r"<[^>]+>", " ", str(v or ""))
    return re.sub(r"\s+", " ", s).strip()


def _money(v: Any) -> float | None:
    """grants.gov returns "11165000", "none", "" or None."""
    s = str(v or "").strip().replace(",", "").replace("$", "")
    if not s or s.lower() in ("none", "null", "n/a"):
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return f if f > 0 else None


def _iso(v: Any) -> str | None:
    """`postingDate` / `responseDate` arrive as MMDDYYYY or ISO, depending on field."""
    s = str(v or "").strip()
    if not s:
        return None
    if re.fullmatch(r"\d{8}", s):                       # MMDDYYYY
        return f"{s[4:]}-{s[0:2]}-{s[2:4]}"
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    return m.group(0) if m else None


def _count(v: Any) -> str | None:
    try:
        n = int(float(str(v).strip()))
    except (TypeError, ValueError):
        return None
    return str(n) if n > 0 else None


#: What a funder types into a field it does not want to answer. Seen in the live
#: API: `applicantEligibilityDesc` of exactly "N/A". Writing that into a schema
#: column stores a value that says nothing — the fault this repo already guards
#: against for "Unspecified Program Area" — so it is refused at the door rather
#: than relied on being hidden later by a blank test that happens to know the word.
_PLACEHOLDER = {"n/a", "na", "none", "not applicable", "not specified", "tbd",
                "tbc", "unknown", "see above", "-", "--"}


def _meaningful(text: str) -> str:
    """`text`, or "" when it is a placeholder or too short to be a statement."""
    s = (text or "").strip()
    return "" if (len(s) < 12 or s.lower().strip(" .") in _PLACEHOLDER) else s


def _blank(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, (list, tuple, dict)):
        return len(v) == 0
    return str(v).strip() in ("", "[]", "{}", "none", "None")


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


def _updates_for(row: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """The columns this API answer should change on this row. Pure — no network."""
    data = (payload.get("data") or {}) if isinstance(payload, dict) else {}
    syn = data.get("synopsis") or {}
    out: dict[str, Any] = {}

    stored = str(row.get("raw_text") or "").strip()
    synopsis = _clean_html(syn.get("synopsisDesc"))
    if synopsis:
        # Replace only when what we hold is chrome, or the API genuinely adds text.
        # Never shrink a good stored read — a deep-read page can legitimately be
        # richer than the synopsis.
        if _CHROME.search(stored) or len(synopsis) >= len(stored) + _GAIN:
            out["raw_text"] = synopsis[:20000]

    elig = _meaningful(_clean_html(syn.get("applicantEligibilityDesc")))
    if elig and _blank(row.get("eligibility_other")):
        out["eligibility_other"] = elig[:2000]

    for column, value in (
        ("total_program_funding", _money(syn.get("estimatedFunding"))),
        ("call_award_floor", _money(syn.get("awardFloor"))),
        ("call_award_ceiling", _money(syn.get("awardCeiling"))),
        ("expected_awards", _count(syn.get("numberOfAwards"))),
        ("date_posted", _iso(syn.get("postingDate"))),
        ("deadline", _iso(syn.get("responseDate"))),
    ):
        if value is not None and _blank(row.get(column)):
            out[column] = value

    num = str(data.get("opportunityNumber") or "").strip()
    if num and _blank(row.get("funding_opportunity_number")):
        out["funding_opportunity_number"] = num
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--apply", action="store_true",
                   help="write to the live database (default: dry run)")
    p.add_argument("--only-thin", action="store_true",
                   help="only rows whose stored text is chrome or under 400 chars")
    p.add_argument("--limit", type=int, help="stop after this many rows")
    p.add_argument("--sleep", type=float, default=0.3,
                   help="seconds between API calls (default 0.3)")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args(argv)

    sb = get_client()
    rows = [r for r in _fetch_all("extracted_solicitations")
            if _host(r.get("opportunity_url")) == "grants.gov"]
    if args.only_thin:
        rows = [r for r in rows
                if _CHROME.search(str(r.get("raw_text") or ""))
                or len(str(r.get("raw_text") or "").strip()) < _MIN_TEXT]
    if args.limit:
        rows = rows[:args.limit]

    per_field: collections.Counter = collections.Counter()
    touched = no_id = no_data = failures = 0
    chars_before = chars_after = 0

    for row in rows:
        gid = _numeric_id(row)
        if not gid:
            no_id += 1
            continue
        payload = _fetch_grants_gov_details(gid)
        time.sleep(max(args.sleep, 0.0))
        if not payload:
            no_data += 1
            continue
        updates = _updates_for(row, payload)
        if not updates:
            continue
        touched += 1
        per_field.update(updates.keys())
        if "raw_text" in updates:
            chars_before += len(str(row.get("raw_text") or ""))
            chars_after += len(updates["raw_text"])
        if args.verbose:
            print(f"\n  {row.get('uid')}  {str(row.get('opportunity_name') or '')[:58]}")
            for k, v in sorted(updates.items()):
                shown = f"{len(v)} chars" if k == "raw_text" else str(v)[:80]
                print(f"      {k:<28} {shown}")
        if args.apply:
            try:
                sb.table("extracted_solicitations").update(updates) \
                    .eq("uid", row["uid"]).execute()
            except Exception as exc:
                failures += 1
                print(f"  ! {row.get('uid')}: {type(exc).__name__}: {exc}")

    verb = "updated" if args.apply else "would update"
    print(f"\n== grants.gov: {verb} {touched} of {len(rows)} rows"
          + (f"  ({failures} write failures)" if failures else ""))
    if no_id:
        print(f"   {no_id} row(s) had no numeric id in the URL — not a detail page")
    if no_data:
        print(f"   {no_data} row(s) returned no synopsis (withdrawn, or an id the API "
              f"no longer serves)")
    for field, n in per_field.most_common():
        print(f"     {n:5d}  {field}")
    if chars_after:
        print(f"\n   source text on the rows whose raw_text changed: "
              f"{chars_before:,} -> {chars_after:,} chars")
    if not args.apply:
        print("\nDRY RUN — nothing was written. Re-run with --apply.")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    raise SystemExit(main())
