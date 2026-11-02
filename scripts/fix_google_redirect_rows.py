"""Repair stored rows whose link is a Google Alert REDIRECT rather than a call.

Owner, 2026-11-02: "Re-resolve them."

`core/scraper.py` now unwraps these at scan time and drops what it cannot
resolve, but that only protects future scans. Five rows already in
`rfp_submissions` carried a google.com link, and they are NOT one problem:

  AS-261030-124802  www.google.com/goto?url=CAESyAEB…   funder "Google"   BROKEN
  AS-261030-124902  www.google.com/goto?url=CAESyAEB…   funder "Google"   BROKEN
  AB-260320-1308    docs.google.com/document/…          funder "GiveWell" FINE
  MI-260508-1647    docs.google.com/document/…          funder "GiveWell" FINE
  MI-260508-1657    docs.google.com/document/…          funder "GiveWell" FINE

The three GiveWell rows are not redirects at all — GiveWell published those RFIs
AS Google Docs, so the Doc IS the call. They are hand-migrated, fully filled and
human-reviewed, and "fixing" them would trade a working link for a guess. The
selector below is therefore the redirect SIGNATURE (a google.com host carrying a
`url=` query), not the google.com host, and it leaves a sixth row alone for the
same kind of reason: SH-260301-1747 is google.org's own AI Impact Challenge,
where "Google" is the correct funder.

What the two broken rows turned out to be, measured rather than assumed:

  * Following the redirect lands on a FundsForNGOs **Facebook post** — so the
    alert never pointed at a donor page, which is why every extracted field came
    back empty and the host became the funder.
  * `source_resolver.resolve()` on the title returns None: the title stored is
    the feed's truncated "💡 Call for Proposals — Advanced HIV Disease (AHD) ...",
    and no donor domain echoes it.
  * The real call is WHO's "Development, implementation and monitoring of norms
    and standards for advanced HIV disease" (who.int, posted 22 May 2026), which
    matches the post's own summary — tools, WHO guideline support, monitoring,
    inpatient care. That URL is hand-verified and recorded in VERIFIED below.

So the script tries, in order: follow the redirect and use the destination if it
is an acceptable primary; else the resolver; else a hand-verified URL. A row
that gets none of those is reported and left alone — never half-filled.

NOTHING A HUMAN DECIDED IS TOUCHED. decision, decision_note, the nine criteria
and the review stamps are not in the update at all: AS-261030-124802 was
Declined as expired by jlambif this morning, and that call stands whatever the
link turns out to be. Fields already holding a value are kept; only the link,
apply_url and funder are replaced, because those three are exactly what the
redirector poisoned.

DRY-RUN by default — prints the planned change. Run with --commit to write.

  python scripts/fix_google_redirect_rows.py            # preview
  python scripts/fix_google_redirect_rows.py --commit   # apply
"""
from __future__ import annotations

import re
import sys
from datetime import date
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from core import source_resolver                      # noqa: E402
from db.supabase_client import fetch_all, service_client   # noqa: E402

# Hand-verified primary sources, keyed by normalised title. Only consulted when
# the redirect's destination and the resolver have both failed, so a wrong entry
# here cannot quietly override a real resolution.
VERIFIED: dict[str, str] = {
    "call for proposals advanced hiv disease ahd": (
        "https://www.who.int/news-room/articles-detail/"
        "call-for-proposals--development--implementation-and-monitoring-of-"
        "norms-and-standards-for-advanced-hiv-disease"
    ),
}

# Column <- candidate key, filled from the resolved page only where the row is
# empty. The three replaced outright are handled separately.
FILL_IF_EMPTY = {
    "brief_description": "brief_description",
    "call_submission_deadline": "call_submission_deadline",
    "date_posted": "date_posted",
    "eligibility_specifics": "_eligibility",
}


def is_redirect(url: str | None) -> bool:
    """A google.com link that carries another URL — /url?url=… or /goto?url=….

    NOT 'the host is google.com': docs.google.com documents and google.org pages
    are real content that donors publish and link to, and both exist in the live
    table right now."""
    try:
        parts = urlsplit(url or "")
    except Exception:
        return False
    host = parts.netloc.lower()
    host = host[4:] if host.startswith("www.") else host
    if not (host == "google.com" or host.endswith(".google.com")):
        return False
    return "url" in parse_qs(parts.query)


def title_key(title: str | None) -> str:
    s = (title or "").lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())


def destination(url: str) -> str | None:
    """Where the redirect actually goes. The token in /goto?url= is an opaque
    protobuf blob — deliberately not decoded (it would break silently the day
    Google changes it); asking the redirector where it points is stable."""
    try:
        import requests
        from core.scraper import HTTP_TIMEOUT, USER_AGENT
        r = requests.get(url, headers={"User-Agent": USER_AGENT},
                         timeout=HTTP_TIMEOUT, allow_redirects=True)
        final = r.url or ""
        return final if final and not is_redirect(final) else None
    except Exception as exc:
        print(f"    redirect follow failed: {exc}")
        return None


def pick_source(row: dict) -> tuple[str | None, str]:
    """(url, how we got it) for one broken row."""
    link = row.get("opportunity_link") or ""
    dest = destination(link)
    if dest:
        print(f"    redirect  -> {dest}")
        if source_resolver._ok_primary(dest):
            return dest, "redirect destination"
        print("    destination is an aggregator / social page, not a source")
    title = re.sub(r"^[^\w(\"']+", "", (row.get("opportunity_title") or "").strip())
    title = re.sub(r"[\s.…]+$", "", title)
    found = source_resolver.resolve(title, None)
    if found:
        print(f"    resolver  -> {found}")
        return found, "resolver"
    verified = VERIFIED.get(title_key(title))
    if verified:
        return verified, "hand-verified"
    return None, "unresolved"


def main(commit: bool) -> int:
    sb = service_client()
    rows = fetch_all(lambda: sb.table("rfp_submissions").select("*"), order="uid")
    broken = [r for r in rows if is_redirect(r.get("opportunity_link"))]
    print(f"{len(rows)} rows, {len(broken)} carrying a redirect\n")

    repaired = stuck = 0
    for row in broken:
        uid = row.get("uid")
        print(f"{uid}  (tenant {row.get('tenant_id')})")
        print(f"    funder NOW  {row.get('funding_agency')!r}")
        src, how = pick_source(row)
        if not src:
            print("    NO SOURCE FOUND — left exactly as it is\n")
            stuck += 1
            continue
        print(f"    source    -> {src}   [{how}]")

        cand = {"opportunity_title": row.get("opportunity_title"),
                "funding_agency": row.get("funding_agency"),
                "opportunity_link": row.get("opportunity_link")}
        # force_funder: the stored name came off the REDIRECTOR's host, so it is
        # condemned by where it came from, not by how it reads.
        if not source_resolver.enrich_from_source(cand, src, force_funder=True):
            print("    page fetch failed — left exactly as it is\n")
            stuck += 1
            continue

        patch: dict[str, object] = {
            "opportunity_link": cand["opportunity_link"],
            "funding_agency": cand.get("funding_agency") or row.get("funding_agency"),
        }
        # apply_url held the same redirect on every row seen; only move it when
        # it did, so a real application form is never overwritten.
        if (row.get("apply_url") or "") == (row.get("opportunity_link") or ""):
            patch["apply_url"] = cand["opportunity_link"]
        for column, key in FILL_IF_EMPTY.items():
            if not row.get(column) and cand.get(key):
                value = cand[key]
                # The scraper's date extractors hand back `date`; PostgREST wants text.
                patch[column] = value.isoformat() if isinstance(value, date) else value
        # The stored title is what the feed sent, cut off mid-sentence. Replace
        # it only when it IS truncated, and only with the real page's own title.
        if re.search(r"(\.\.\.|…)\s*$", row.get("opportunity_title") or ""):
            better = cand.get("_page_title")
            if better:
                patch["opportunity_title"] = better

        for k, v in patch.items():
            old, new = row.get(k), v
            if isinstance(new, str) and len(new) > 160:
                new = new[:160] + f" …[{len(v)} chars]"
            if isinstance(old, str) and len(old) > 80:
                old = old[:80] + "…"
            print(f"      {k:26} {old!r}\n        ->  {new!r}")
        if commit:
            sb.table("rfp_submissions").update(patch).eq("id", row["id"]).execute()
        repaired += 1
        print()

    print(f"{repaired} repaired, {stuck} left alone.")
    print("COMMITTED." if commit else "DRY RUN — re-run with --commit to apply.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main("--commit" in sys.argv))
