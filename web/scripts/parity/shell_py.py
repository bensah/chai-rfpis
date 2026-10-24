"""Python half of check-shell.mjs: core/notifications.recent_feed for each active tenant,
scoped the way a member of that tenant sees it. Read-only. Prints JSON {tenant_id: [items]}."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from core.dotenv_compat import load_dotenv    # noqa: E402

load_dotenv(Path.cwd() / ".env")
load_dotenv(ROOT / ".env")

from auth import tenant_context as tc          # noqa: E402
from core import notifications as N            # noqa: E402
from db.supabase_client import service_client  # noqa: E402

feed = getattr(N.recent_feed, "__wrapped__", N.recent_feed)
out = {}
for t in service_client().table("tenants").select("id").eq("status", "active").execute().data or []:
    tid = str(t["id"])
    tok = tc.set_tenant_override(tid)      # get_client() scopes to this tenant, as for a member
    try:
        items = feed(scope_tid=tid, is_super=False)
    finally:
        tc.reset_tenant_override(tok)
    out[tid] = [{"ts": int(it["ts"].timestamp() * 1000), "icon": it["icon"], "title": it["title"],
                 "detail": it["detail"], "nav": it["nav"], "uid": it["uid"]} for it in items]
sys.stdout.write(json.dumps(out, ensure_ascii=False))
