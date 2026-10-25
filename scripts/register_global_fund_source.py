"""Validate The Global Fund tenders source live, then mark it validated.

The catalogue row (donor_sources, host theglobalfund.org) was `manual`: a June
audit read the Oracle Fusion negotiation portal as "JS shell only". It is not —
it is an ADF page that renders server-side once its loopback token is echoed
back (core.scraper._adf_open), and its Details popups are plain form postbacks.

The source is a two-hop chain, registered as ONE source rooted at the business
page so a moved portal is still found:

    https://www.theglobalfund.org/en/business-opportunities/   (checked live)
      └─ "Open tenders" button → Oracle Fusion NegotiationAbstracts list

This script runs the chain live (business page → button → list → open tenders),
and only if it yields negotiations does it:
  1. flip the catalogue row to `html` on the business page (handler
     core.scraper._scan_global_fund), and
  2. mark the registry host confirmed/primary with the business page as its
     listings URL and the verification evidence in its notes.

Idempotent.

    python scripts/register_global_fund_source.py            # dry-run
    python scripts/register_global_fund_source.py --commit   # apply
    python scripts/register_global_fund_source.py --commit --registry-only

`--registry-only` leaves the catalogue row as it is. Use it while the handler is
not yet deployed: code without `_scan_global_fund` would crawl the business page
generically (its stale items) once the row says `html`, whereas a `manual` row
returns nothing there — and code WITH the handler routes the business-page URL to
it before looking at the method, so local scans already use it.
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

import requests  # noqa: E402
from bs4 import BeautifulSoup  # noqa: E402

from core import scraper  # noqa: E402
from db.supabase_client import get_client  # noqa: E402

HOST = "theglobalfund.org"
BUSINESS_PAGE = scraper._GF_BUSINESS_PAGE
SOLICITATION_TYPES = ["RFP", "RFI"]
INSTRUMENT_TYPES = ["Grant", "Contract"]
OPPORTUNITY_TYPES = ["Grant", "Tender"]


def _verify() -> dict:
    """Run the chain live. Raises if any hop fails."""
    r = requests.get(BUSINESS_PAGE, headers={"User-Agent": scraper.USER_AGENT},
                     timeout=30)
    r.raise_for_status()
    tenders = scraper._gf_tenders_url()
    if tenders == scraper._GF_TENDERS_FALLBACK and "NegotiationAbstracts" not in r.text:
        raise RuntimeError("business page no longer carries the Open tenders link")
    sess = requests.Session()
    sess.headers.update({"User-Agent": scraper.USER_AGENT})
    page = scraper._adf_open(sess, tenders)
    listed = [tr for tr in BeautifulSoup(page.text, "html.parser").select("tr[_afrrk]")
              if len(tr.find_all("td", recursive=False)) >= 7]
    if not listed:
        raise RuntimeError("negotiation list rendered no rows")
    open_now = scraper.scan_source({"name": "The Global Fund", "method": "html",
                                    "url": BUSINESS_PAGE})
    return {"business_status": r.status_code, "tenders_url": tenders,
            "listed": len(listed), "open": len(open_now),
            "open_ids": [c["opportunity_id"] for c in open_now]}


def main(argv: list[str]) -> int:
    commit = "--commit" in argv
    registry_only = "--registry-only" in argv
    print(f"=== The Global Fund tenders source {'(COMMIT)' if commit else '(DRY RUN)'} ===")
    ev = _verify()
    today = _dt.date.today().isoformat()
    evidence = (f"[verify {today}] VERIFIED: business page {BUSINESS_PAGE} "
                f"(HTTP {ev['business_status']}) → Open tenders → {ev['tenders_url']} · "
                f"{ev['listed']} negotiations listed · {ev['open']} open "
                f"({', '.join(ev['open_ids']) or 'none'}) · plain HTTP (ADF loopback + "
                f"Details postback), handler _scan_global_fund")
    print("  " + evidence)

    sb = get_client()
    cat = [r for r in (sb.table("donor_sources").select("id,source_uid,donor_name,"
                                                        "scrape_method,rfp_listing_url,notes")
                       .eq("host", HOST).execute().data or [])]
    print(f"  catalogue rows for {HOST}: "
          + ", ".join(f"uid {r['source_uid']} [{r['scrape_method']}]" for r in cat))
    cat_fields = {
        "base_url": "https://www.theglobalfund.org/",
        "rfp_listing_url": BUSINESS_PAGE,
        "scrape_method": "html",
        "is_active": True,
        "source_class": "Primary source",
        "access_model": "Free",
        "solicitation_types": SOLICITATION_TYPES,
        "instrument_types": INSTRUMENT_TYPES,
        "opportunity_types": OPPORTUNITY_TYPES,
    }
    reg_fields = {
        "host": HOST, "classification": "primary", "status": "confirmed",
        "source_class": "Primary source", "access_model": "Free",
        "ingestion_method": "Page crawl", "has_api": False,
        "listings_url": BUSINESS_PAGE, "sample_url": ev["tenders_url"],
        "sample_title": "The Global Fund — Open tenders (Oracle negotiation list)",
        "donor_name": "The Global Fund",
        "solicitation_types": SOLICITATION_TYPES,
        "instrument_types": INSTRUMENT_TYPES,
        "opportunity_types": OPPORTUNITY_TYPES,
        "in_catalogue": bool(cat) or not registry_only, "notes": evidence,
        "verified_by": "global-fund-crawler",
        "verified_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
    }
    if not commit:
        print("\nDry-run. Re-run with --commit to apply.")
        return 0
    if registry_only:
        print("  · catalogue left unchanged (--registry-only)")
    elif cat:
        for r in cat:
            sb.table("donor_sources").update(
                {**cat_fields, "notes": f"{evidence} | prev: {(r.get('notes') or '')[:300]}"}
            ).eq("id", r["id"]).execute()
            print(f"  ✓ catalogue uid {r['source_uid']} → html @ business page")
    else:
        sb.table("donor_sources").insert({
            **cat_fields, "donor_name": "The Global Fund", "donor_code": "Global Fund",
            "host": HOST, "notes": evidence, "created_by": "global-fund-crawler",
        }).execute()
        print("  ✓ catalogue row added")
    sb.table("source_registry").upsert(reg_fields, on_conflict="host").execute()
    print(f"  ✓ registry {HOST} → confirmed primary, listings = business page")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
