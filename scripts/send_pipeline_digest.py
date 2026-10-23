"""Preview or send the new-opportunity email for one tenant by hand.

The Friday cron sends it automatically (core.scan_pipeline.screen_all_tenants). This is
for checking the template against real data, or re-sending after a fix.

Usage:
    python scripts/send_pipeline_digest.py --tenant chai-cameroon --since 2026-10-16 \
        --preview digest.html                     # render to a file, send nothing
    python scripts/send_pipeline_digest.py --tenant chai-cameroon --since 2026-10-16 \
        --to me@example.org                       # send only to these address(es)
    python scripts/send_pipeline_digest.py --tenant chai-cameroon --since 2026-10-16 \
        --send                                    # send to every active member
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except Exception:
    pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tenant", required=True, help="tenant slug or id")
    ap.add_argument("--since", required=True,
                    help="ISO date/time: rows created at or after this are 'new'")
    ap.add_argument("--preview", help="write the HTML for the first member to this file")
    ap.add_argument("--to", nargs="+", help="send only to these addresses")
    ap.add_argument("--send", action="store_true", help="send to every active member")
    args = ap.parse_args()

    from auth.tenant_context import resolve_tenant_by_key
    from core import pipeline_digest as pd
    from core import user_emails as ue
    from db.supabase_client import service_client

    t = resolve_tenant_by_key(args.tenant)
    if not t:
        sys.exit(f"No tenant matches {args.tenant!r}")
    tid = str(t["id"])
    cli = service_client()

    if args.preview:
        rows = pd.new_rows(cli, tid, args.since)
        b: dict[str, list] = {"Proceed": [], "Park": [], "Decline": []}
        for r in rows:
            if pd.verdict(r):
                b[pd.verdict(r)].append(r)
        people = pd.recipients(cli, tid)
        html = pd.render_digest_html(
            recipient_name=(people[0]["name"] if people else ""), tenant_name=t.get("name") or "",
            product=ue._short_name(), base_url=ue._app_url(), slug=t.get("slug"),
            proceed=b["Proceed"], park=b["Park"], declined=len(b["Decline"]))
        Path(args.preview).write_text(html, encoding="utf-8")
        print(f"{len(rows)} new · {len(b['Proceed'])} Proceed · {len(b['Park'])} Park · "
              f"{len(b['Decline'])} Decline · {len(people)} member(s) · wrote {args.preview}")
        print("Subject:", pd.subject_line(t.get("name") or "", len(b["Proceed"]), len(b["Park"])))
        return

    if not (args.to or args.send):
        sys.exit("Pass --preview FILE, --to ADDRESS..., or --send.")
    print(pd.send_pipeline_digest(tid, args.since, only_to=args.to))


if __name__ == "__main__":
    main()
