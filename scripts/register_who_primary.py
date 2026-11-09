"""Register who.int as a confirmed primary source so its pages can name their donor.

Owner, 2026-11-02: "Yes, add WHO."

Repairing AS-261030-124802 / -124902 turned up the gap. `_funder_from_page` asks
the registry first, then `og:site_name`, then the <title>'s site-name tail — and
who.int answers none of them: no `og:site_name`, a <title> that is the headline
with no tail, and a registry row sitting at status='pending', classification
='unknown', source_class=NULL. So the page could not say whose it was, and the
funder "Google" that a Google Alert redirect had left on the row survived the
repair untouched. The name had to be hand-carried in the repair script instead.

The row already EXISTS (source_uid 143, 2 hits, first seen 2026-06-25), so this
updates it rather than adding one — and uses `update_row`, not `add_row`, so the
listings URL, notes and sample title a human put there are not overwritten by an
upsert's defaults.

REGISTRY ONLY. This does not put who.int in `donor_sources`, so nothing starts
crawling it: the ask was that WHO pages name their funder, which is the registry
row's job. Adding it to the scan catalogue is a separate decision, and a real one
— who.int is a very large site whose call pages have no single listing index.

Two consequences worth knowing before running it, both deliberate:

  * `_registry_bonus` gives any who.int URL +4.0 when the resolver ranks
    candidates, which is exactly the acceptance threshold — enough for a who.int
    page to be accepted on its own, never enough to outrank a better name match.
    That calibration is documented at `_REGISTRY_PRIMARY_BONUS`, and WHO is the
    kind of large portal it was calibrated FOR.
  * `confirmed_class()` makes the row authoritative for the aggregator detector.
    That is the point: WHO publishes its own calls, so it must never be read as
    a republisher.

`ahpsr.who.int` keeps its own name (Alliance for Health Policy and Systems
Research): `primary_donor_name` matches the exact host before it walks parents,
and there is a test pinning that.

    python scripts/register_who_primary.py            # dry-run
    python scripts/register_who_primary.py --commit   # apply
"""
from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import requests                                              # noqa: E402
from bs4 import BeautifulSoup                                 # noqa: E402

from core import scraper, source_registry, source_resolver    # noqa: E402

HOST = "who.int"
# The call the repair ran through — a live page that proves the gap.
SAMPLE = ("https://www.who.int/news-room/articles-detail/call-for-proposals--"
          "development--implementation-and-monitoring-of-norms-and-standards-"
          "for-advanced-hiv-disease")
DONOR_NAME = "World Health Organization"


def verify() -> dict:
    """Fetch the sample page and show what the code can read off it today."""
    r = requests.get(SAMPLE, headers={"User-Agent": scraper.USER_AGENT}, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    og = soup.find("meta", attrs={"property": "og:site_name"})
    return {
        "status": r.status_code,
        "og_site_name": (og.get("content") if og else None),
        "page_title": source_resolver._page_title(soup),
        "funder_now": source_resolver._funder_from_page(SAMPLE, soup),
    }


def main(argv: list[str]) -> int:
    commit = "--commit" in argv
    print(f"=== who.int → confirmed primary {'(COMMIT)' if commit else '(DRY RUN)'} ===")

    ev = verify()
    print(f"  sample page       HTTP {ev['status']}")
    print(f"  og:site_name      {ev['og_site_name']!r}   <- why the page cannot name itself")
    print(f"  page title        {ev['page_title']!r}")
    print(f"  funder today      {ev['funder_now']!r}")

    before = source_registry.get_all(force=True).get(HOST) or {}
    rows = {r.get("host"): r for r in source_registry.list_rows()}
    cur = rows.get(HOST, {})
    print(f"\n  registry row now  status={cur.get('status')!r} "
          f"classification={cur.get('classification')!r} "
          f"source_class={cur.get('source_class')!r} "
          f"donor_name={cur.get('donor_name')!r}")
    if not cur:
        print("  !! no existing row — this script only UPDATES one. Add it in the "
              "registry UI first, so the add is a human's.")
        return 1

    today = _dt.date.today().isoformat()
    fields = {
        "classification": "primary",
        "status": "confirmed",
        "source_class": "Primary source",
        "access_model": "Free",
        "ingestion_method": "Page crawl",
        "has_api": False,
        "donor_name": DONOR_NAME,
        "donor_code": "WHO",
        "sample_url": SAMPLE,
        "notes": (f"[verify {today}] Confirmed primary: WHO publishes its own calls "
                  f"for proposals. Registered so _funder_from_page can name the donor — "
                  f"who.int serves no og:site_name and its <title> has no site-name "
                  f"tail. Registry only; NOT in the scan catalogue. "
                  f"prev: {(cur.get('notes') or '')[:200]}")[:600],
    }
    for k, v in fields.items():
        if k == "notes":
            print(f"      {k:18} -> {v[:90]}…")
        else:
            print(f"      {k:18} {cur.get(k)!r}  ->  {v!r}")

    if not commit:
        print("\nDRY RUN — re-run with --commit to apply.")
        return 0

    ok = source_registry.update_row(HOST, fields, by="nbernard@clintonhealthaccess.org")
    if not ok:
        print("\n  !! update_row refused — nothing written.")
        return 1
    source_registry.clear_cache()
    name = source_registry.primary_donor_name(SAMPLE)
    print(f"\n  primary_donor_name(sample) = {name!r}")
    print(f"  ahpsr.who.int keeps        = "
          f"{source_registry.primary_donor_name('https://ahpsr.who.int/call')!r}")
    if name != DONOR_NAME:
        print("  !! the registry still does not name it — check the row by hand.")
        return 1
    print("  COMMITTED.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
