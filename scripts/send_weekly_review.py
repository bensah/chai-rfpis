"""Send, or preview, the Monday summary of last week's pipeline.

The Monday cron sends it for every active tenant (--all). This is for checking the
template against real data, re-sending after a fix, or running it for one tenant.

Usage:
    python scripts/send_weekly_review.py --tenant <slug> --preview week.html
    python scripts/send_weekly_review.py --tenant <slug> --to me@example.org
    python scripts/send_weekly_review.py --tenant <slug> --send
    python scripts/send_weekly_review.py --all --send          # what the cron runs

--week-of ISO-DATE reports the week containing that date instead of the one just
gone, for re-sending a missed Monday or checking a past week.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except Exception:
    pass


def _anchor(week_of: str | None) -> datetime | None:
    """The 'now' the window is measured back from.

    --week-of names a day INSIDE the week you want reported, so the anchor is the
    following Monday: week_window looks back one week from the Monday of its own
    week.
    """
    if not week_of:
        return None
    from datetime import timedelta
    d = datetime.fromisoformat(week_of).replace(tzinfo=timezone.utc)
    return d + timedelta(days=7 - d.weekday())


def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--tenant", help="tenant slug or id")
    g.add_argument("--all", action="store_true", help="every active tenant")
    ap.add_argument("--week-of", help="ISO date inside the week to report")
    ap.add_argument("--preview", help="write the HTML for the first member to this file")
    ap.add_argument("--to", nargs="+", help="send only to these addresses")
    ap.add_argument("--send", action="store_true", help="send to every active member")
    args = ap.parse_args()

    from core import pipeline_digest as pd
    from core import user_emails as ue
    from db.supabase_client import service_client

    cli = service_client()
    now = _anchor(args.week_of)

    if args.all:
        if not args.send:
            sys.exit("--all is for the cron; pass --send.")
        tenants = (cli.table("tenants").select("id,name,slug")
                   .eq("status", "active").execute().data or [])
        failures = 0
        for t in tenants:
            try:
                res = pd.send_weekly_review(str(t["id"]), now=now, client=cli)
                print(f"{t.get('slug') or t['id']}: {res}")
            except Exception as exc:               # one tenant must not stop the rest
                failures += 1
                print(f"{t.get('slug') or t['id']}: FAILED {exc}", file=sys.stderr)
        print(f"{len(tenants)} tenant(s), {failures} failed")
        sys.exit(1 if failures else 0)

    from auth.tenant_context import resolve_tenant_by_key
    t = resolve_tenant_by_key(args.tenant)
    if not t:
        sys.exit(f"No tenant matches {args.tenant!r}")
    tid = str(t["id"])

    if args.preview:
        start, end = pd.week_window(now)
        data = pd.weekly_review_data(cli, tid, start, end)
        people = pd.recipients(cli, tid)
        html = pd.render_weekly_review_html(
            recipient_name=(people[0]["name"] if people else ""),
            tenant_name=t.get("name") or "", product=ue._short_name(),
            base_url=ue._app_url(), slug=t.get("slug"), data=data,
            start=start, end=end)
        Path(args.preview).write_text(html, encoding="utf-8")
        waiting = sum(len(v) for v in data["waiting"].values())
        print(f"{start.date()} to {end.date()} · {data['found_total']} found · "
              f"{waiting} awaiting · {data['decided_total']} decided · "
              f"{len(people)} member(s) · wrote {args.preview}")
        print("Subject:", pd.weekly_subject(t.get("name") or "", waiting,
                                            data["decided_total"]))
        return

    if not (args.to or args.send):
        sys.exit("Pass --preview FILE, --to ADDRESS..., or --send.")
    print(pd.send_weekly_review(tid, now=now, only_to=args.to))


if __name__ == "__main__":
    main()
