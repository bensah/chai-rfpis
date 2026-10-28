"""Remove catalogue rows that a republisher, not a funder, is the source of.

THE RULE (owner, 2026-07-06): an aggregator may IDENTIFY an opportunity; it may never be
the stored source, and it may never be the funder. The pipeline enforces that at ingest —
an unresolved aggregator hit is dropped, and a hit whose funder is a republisher's label is
dropped — but both gates learned their hosts over time, so rows written before a host was
known are still sitting in the shared store.

That is how a $244M Pandemic Fund call came to be recorded as funded by
"Globalscholardesk", an SEO site that had republished it. The funder shows on the
opportunity page and in the opportunity rail, so a reviewer reads the republisher as the
donor; and the stored URL points at the copy rather than the call.

Both halves of the rule are applied here, using the pipeline's OWN classifiers so this
script can never disagree with the gate:

  * `aggregators.classify(url)` -> the row is hosted on a republisher or a blog platform
  * `source_resolver.is_aggregator_funder(name)` -> the row names one as its funder

A purged row is not lost work: it is a republished copy, and the donor's own page is
rediscovered by the next sweep through the normal route. Rows are printed in full before
deletion and written to a CSV so the decision stays reviewable.

PIPELINE ROWS ARE NEVER DELETED. A tenant's `rfp_submissions` row is tracked work with
decisions and a review history attached, so an affected one is REPORTED for a human,
never removed.

Usage:
    python scripts/purge_aggregator_sourced_rows.py              # DRY-RUN (default)
    python scripts/purge_aggregator_sourced_rows.py --apply
    python scripts/purge_aggregator_sourced_rows.py --apply --max 40
"""
from __future__ import annotations

import argparse
import csv
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except Exception:
    pass

from core import aggregators, source_resolver
from db.supabase_client import service_client

# A safety rail, not a limit on correctness: the audit that prompted this found 12 of 1,559
# store rows. An order of magnitude more means the classifier changed meaning, and a bulk
# delete should stop and be looked at rather than proceed.
_SANE_MAX = 60


def _why(url: str, funder: str) -> str | None:
    """The gate's own reason this row may not stand, or None if it may."""
    kind, detail = aggregators.classify(url)
    if kind in ("aggregator", "blog"):
        return f"{kind} host ({detail})"
    if funder and source_resolver.is_aggregator_funder(funder):
        return f"names a republisher as the funder ({funder!r})"
    return None


def _all_rows(sb, table: str, cols: str) -> list[dict]:
    """Every row, in pages. PostgREST caps a response at 1,000 however large the
    `.limit()` — asking for 20,000 and reading 1,000 is how a sweep silently misses the
    newest third of the catalogue, which is exactly the half this script is cleaning."""
    out: list[dict] = []
    page = 1000
    while True:
        batch = (sb.table(table).select(cols)
                 .order("uid").range(len(out), len(out) + page - 1)
                 .execute().data or [])
        out.extend(batch)
        if len(batch) < page:
            return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="perform the delete (default: dry-run)")
    ap.add_argument("--max", type=int, default=_SANE_MAX,
                    help=f"refuse to delete more than this many rows (default {_SANE_MAX})")
    args = ap.parse_args()

    sb = service_client()          # the shared store is not tenant-scoped

    store = _all_rows(sb, "extracted_solicitations",
                      "uid,opportunity_name,funder_name,opportunity_url,source,created_at")
    subs = _all_rows(sb, "rfp_submissions",
                     "uid,opportunity_title,funding_agency,opportunity_link,tenant_id,"
                     "decision,extraction_uid")

    doomed = []
    for r in store:
        why = _why(r.get("opportunity_url") or "", (r.get("funder_name") or "").strip())
        if why:
            doomed.append((r, why))

    print(f"Catalogue rows scanned: {len(store)}")
    print(f"Sourced from a republisher: {len(doomed)}\n")
    for r, why in doomed:
        print(f"  {r['uid']}")
        print(f"      {str(r.get('opportunity_name') or '')[:88]}")
        print(f"      funder: {r.get('funder_name')!r}   ·   {why}")
        print(f"      {r.get('opportunity_url')}")

    # A tenant may already be tracking one of these. Deleting the catalogue row does not
    # touch their pipeline row, but they need telling which record came from a copy.
    links = {(r.get("opportunity_url") or "").rstrip("/").lower() for r, _ in doomed}
    uids = {r["uid"] for r, _ in doomed}
    tracked = [s for s in subs
               if (s.get("opportunity_link") or "").rstrip("/").lower() in links
               or (s.get("extraction_uid") or "") in uids]

    affected = []
    for s in subs:
        why = _why(s.get("opportunity_link") or "", (s.get("funding_agency") or "").strip())
        if why:
            affected.append((s, why))

    print(f"\nPipeline rows tracking one of these: {len(tracked)}")
    for s in tracked:
        print(f"  {s['uid']}  decision={s.get('decision')!r}  {s.get('funding_agency')!r}")
    print(f"\nPipeline rows that name a republisher (REPORTED, never deleted): "
          f"{len(affected)}")
    for s, why in affected:
        print(f"  {s['uid']}  decision={s.get('decision')!r}  {why}")

    if not doomed:
        print("\nNothing to purge.")
        return 0

    out = (Path(__file__).resolve().parent.parent / "data" /
           f"purged_aggregator_rows_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}.csv")
    if args.apply:
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["uid", "opportunity_name", "funder_name", "opportunity_url",
                        "source", "created_at", "reason"])
            for r, why in doomed:
                w.writerow([r.get("uid"), r.get("opportunity_name"), r.get("funder_name"),
                            r.get("opportunity_url"), r.get("source"),
                            r.get("created_at"), why])
        print(f"\nSaved the deleted rows to {out}")

    if len(doomed) > args.max:
        print(f"\nREFUSING: {len(doomed)} rows exceeds --max {args.max}. "
              f"Check the classifier before deleting this many.")
        return 1

    if not args.apply:
        print(f"\nDRY-RUN — nothing written. Re-run with --apply to delete "
              f"{len(doomed)} catalogue row(s).")
        return 0

    deleted = 0
    for r, _ in doomed:
        try:
            sb.table("extracted_solicitations").delete().eq("uid", r["uid"]).execute()
            deleted += 1
        except Exception as exc:                                 # noqa: BLE001
            print(f"  FAILED {r['uid']}: {type(exc).__name__}: {exc}")
    print(f"\nDeleted {deleted} of {len(doomed)} catalogue row(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
