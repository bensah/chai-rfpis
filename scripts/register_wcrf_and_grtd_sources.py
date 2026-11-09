"""Register the WCRF and FCDO GRTD call listings, and check Coefficient Giving.

Owner, 2026-11-02, after finding a Coefficient Giving RFP on LinkedIn rather than in
RFPIS: "verify how to access the rfps and add the sources along their method".

Each of the three needed a different answer, and the reason is worth keeping:

COEFFICIENT GIVING — already registered (source_uid 44, html, active, dedicated
handler `_scan_coefficient_giving`). NOTHING WAS WRONG WITH IT. Measured 2026-11-02:
the handler walks /funds/ → 16 fund pages → their RFP tabs and returns the vaccine
RFP with the right title, link and a 2026-12-21 deadline, and the eligibility gate
ACCEPTS it. It was absent only because the page did not exist yet: its own metadata
says datePublished 2026-11-02T14:00:49Z, three days after the last scan (30 Oct), and
the web archive holds no capture of it. The scan runs Fridays 06:00 UTC
(.github/workflows/scan.yml), so this one lands on 6 Nov. This script only verifies
it, and changes nothing.

WCRF — plain server-rendered HTML. The generic html crawl of the grant-programmes
index already returns "INSPIRE Research Challenge" as its first candidate. The call
is OPEN, closing 13 November 2026, and it needed the deadline-label fix that ships
with this change: WCRF writes "Grant calls close (Letter of Intent stage): 13
November 2026", and the parenthetical stage qualifier used to break the label match,
so the page parsed as having no deadline at all.

FCDO GRTD — the one that cannot be crawled as HTML. /funding/ says "Showing 37
opportunities" and serves TWO links in static HTML, because JetEngine renders the
cards client-side. It is WordPress, so the REST API is the honest way in — but NOT
the obvious endpoint:

  * /wp-json/wp/v2/funding-opportunitie  — 37 items, but each `link` is a JetEngine
    stub carrying 1,034 characters of nav and footer and NO body, and only 10 of the
    37 correspond to a page on the site at all (the rest are other funders' calls
    that GRTD lists). Candidates built from it fail the gate as "no readable
    description", which is the correct verdict on an empty page.
  * /wp-json/wp/v2/pages  — 52 items, 18 of them call-shaped, each with the full body
    in `content.rendered` and a parseable deadline. The owner's SRHR call is here,
    and it is the one of the 18 that is still open; the other 17 closed between 2024
    and 2026 and the gate rejects them as expired.

So the source points at `pages`. The limitation that buys: GRTD's listings of OTHER
funders' calls are not picked up, because their records carry no text we could judge.

DRY-RUN by default.

    python scripts/register_wcrf_and_grtd_sources.py            # preview
    python scripts/register_wcrf_and_grtd_sources.py --commit   # apply
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

from core import scraper                                   # noqa: E402
from core.auto_scorer import is_eligible                   # noqa: E402
from core.policies import get_policies                     # noqa: E402
from db.supabase_client import get_client, service_client  # noqa: E402

CG_LISTING = "https://coefficientgiving.org/funds/"

SOURCES = [
    {
        "host": "wcrf.org",
        "donor_name": "World Cancer Research Fund International",
        "donor_code": "WCRF",
        "base_url": "https://www.wcrf.org/",
        # The index both grant programmes hang off; the crawl picks up each
        # programme page, which is where the call and its timeline live.
        "rfp_listing_url": "https://www.wcrf.org/research-policy/our-grant-programmes/",
        "human_listing_url": "https://www.wcrf.org/research-policy/our-grant-programmes/",
        "scrape_method": "html",
        "ingestion_method": "Page crawl",
        "expect_title": "INSPIRE",
        "solicitation_types": ["CFP"],
        "instrument_types": ["Grant"],
        "opportunity_types": ["Grant"],
        "note": ("Grant programmes index → INSPIRE Research Challenge + Regular Grant "
                 "Programme. Two-stage: the Letter of Intent close date is the deadline."),
    },
    {
        "host": "grtd.fcdo.gov.uk",
        "donor_name": "FCDO Global Research and Technology Development",
        "donor_code": "FCDO GRTD",
        "base_url": "https://www.grtd.fcdo.gov.uk/",
        # NOT /funding/ (JetEngine renders its cards client-side) and NOT the
        # funding-opportunitie post type (its permalinks are empty stubs).
        "rfp_listing_url": "https://www.grtd.fcdo.gov.uk/wp-json/wp/v2/pages",
        "human_listing_url": "https://www.grtd.fcdo.gov.uk/funding/",
        "scrape_method": "rest_json",
        "ingestion_method": "API (JSON)",
        "expect_title": "Sexual and Reproductive Health",
        "solicitation_types": ["CFP", "EOI"],
        "instrument_types": ["Grant"],
        "opportunity_types": ["Grant"],
        "note": ("WordPress REST. /funding/ is JS-rendered and the funding-opportunitie "
                 "post type has empty permalinks — wp/v2/pages carries the call bodies."),
    },
]


def verify(src: dict) -> dict:
    """Scan the source live and report what the gate makes of it."""
    cands = scraper.scan_source({"name": src["donor_name"],
                                 "method": src["scrape_method"],
                                 "url": src["rfp_listing_url"]})
    pol = get_policies()
    passed = []
    for c in cands:
        try:
            ok, _ = is_eligible(c, pol)
        except Exception:
            ok = False
        if ok:
            passed.append(c)
    expected = [c for c in cands
                if src["expect_title"].lower() in (c.get("opportunity_title") or "").lower()]
    return {"found": len(cands), "passed": passed, "expected": expected}


def main(commit: bool) -> int:
    print(f"=== sources {'(COMMIT)' if commit else '(DRY RUN)'} ===\n")

    # --- Coefficient Giving: verify only -----------------------------------
    sb_ro = service_client()
    cg = (sb_ro.table("donor_sources")
          .select("source_uid,donor_name,rfp_listing_url,scrape_method,is_active,"
                  "last_scraped_at")
          .ilike("rfp_listing_url", "%coefficientgiving%").execute().data or [])
    print("Coefficient Giving (verify only, nothing changed)")
    for r in cg:
        print(f"  uid {r['source_uid']}  method={r['scrape_method']!r} "
              f"active={r['is_active']}  last scraped {r.get('last_scraped_at')}")
    cgv = verify({"donor_name": "Coefficient Giving", "scrape_method": "html",
                  "rfp_listing_url": CG_LISTING, "expect_title": "Vaccine Impact"})
    print(f"  live crawl: {cgv['found']} candidates, {len(cgv['passed'])} pass the gate")
    for c in cgv["expected"]:
        print(f"  ✓ the owner's RFP IS found: {c['opportunity_title']}")
        print(f"      {c['opportunity_link']}")
    if not cgv["expected"]:
        print("  !! the vaccine RFP was NOT returned — the handler needs a look")

    sb = get_client()
    for src in SOURCES:
        print(f"\n{'-' * 70}\n{src['donor_name']}  [{src['scrape_method']}]")
        print(f"  listing: {src['rfp_listing_url']}")
        ev = verify(src)
        print(f"  live crawl: {ev['found']} candidates, "
              f"{len(ev['passed'])} pass the gate")
        for c in ev["expected"]:
            print(f"  ✓ expected call found: {c['opportunity_title'][:70]}")
            print(f"      deadline {c.get('call_submission_deadline')}  "
                  f"{c['opportunity_link'][:96]}")
        if not ev["expected"]:
            print(f"  !! '{src['expect_title']}' not returned — NOT registering it")
            continue

        existing = (sb_ro.table("donor_sources").select("id,source_uid,scrape_method")
                    .eq("host", src["host"]).execute().data or [])
        print(f"  catalogue rows for {src['host']}: {len(existing)}")

        today = _dt.date.today().isoformat()
        evidence = (f"[verify {today}] {ev['found']} candidates, "
                    f"{len(ev['passed'])} eligible. {src['note']}")
        cat_fields = {
            "host": src["host"],
            "donor_name": src["donor_name"],
            "donor_code": src["donor_code"],
            "base_url": src["base_url"],
            "rfp_listing_url": src["rfp_listing_url"],
            "scrape_method": src["scrape_method"],
            "is_active": True,
            "source_class": "Primary source",
            "access_model": "Free",
            "solicitation_types": src["solicitation_types"],
            "instrument_types": src["instrument_types"],
            "opportunity_types": src["opportunity_types"],
            "notes": evidence[:300],
        }
        reg_fields = {
            "host": src["host"], "classification": "primary", "status": "confirmed",
            "source_class": "Primary source", "access_model": "Free",
            "ingestion_method": src["ingestion_method"], "has_api":
                src["scrape_method"] == "rest_json",
            "donor_name": src["donor_name"], "donor_code": src["donor_code"],
            "listings_url": src["human_listing_url"],
            "sample_url": (ev["expected"][0]["opportunity_link"])[:600],
            "sample_title": (ev["expected"][0]["opportunity_title"])[:300],
            "solicitation_types": src["solicitation_types"],
            "instrument_types": src["instrument_types"],
            "opportunity_types": src["opportunity_types"],
            "in_catalogue": True, "notes": evidence[:600],
            "verified_by": "nbernard@clintonhealthaccess.org",
            "verified_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        }
        if not commit:
            print("  would UPDATE catalogue" if existing else "  would INSERT catalogue")
            print(f"  would upsert registry {src['host']} → confirmed primary")
            continue
        if existing:
            for e in existing:
                sb.table("donor_sources").update(cat_fields).eq("id", e["id"]).execute()
            print(f"  ✓ catalogue updated ({len(existing)} row(s))")
        else:
            sb.table("donor_sources").insert(
                {**cat_fields, "created_by": "source-registration"}).execute()
            print("  ✓ catalogue row added")
        sb.table("source_registry").upsert(reg_fields, on_conflict="host").execute()
        print(f"  ✓ registry {src['host']} → confirmed primary")

    print("\nDRY RUN — re-run with --commit to apply." if not commit else "\nCOMMITTED.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main("--commit" in sys.argv))
