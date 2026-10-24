"""Python half of check-routing.mjs.

    python routing_py.py sets      → the routing sets from db/supabase_client.py and the
                                     arrays in migration 098, as JSON
    python routing_py.py tenants   → for every user: their active memberships and the tenant
                                     a new session lands in (tenant_context rules), as JSON

Read-only. Uses the service key from the repo's .env, like the app.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from core.dotenv_compat import load_dotenv    # noqa: E402

load_dotenv(Path.cwd() / ".env")
load_dotenv(ROOT / ".env")


def sets() -> dict:
    from db import supabase_client as sc
    sql = (ROOT / "db" / "migrations" / "098_rls_lockdown_shared_tables.sql").read_text(encoding="utf-8")

    def arr(name: str) -> list[str]:
        m = re.search(name + r"\s+text\[\]\s*:=\s*array\[(.*?)\];", sql, re.S)
        return sorted(re.findall(r"'([a-z_]+)'", m.group(1))) if m else []

    return {
        "service_only": sorted(sc._SERVICE_ONLY_TABLES),
        "service_write": sorted(sc._SERVICE_WRITE_TABLES),
        "tenant_scoped": sorted(sc._TENANT_SCOPED_TABLES),
        "mig_service_only": arr("_service_only"),
        "mig_read_only": arr("_read_only"),
    }


def tenants() -> dict:
    from auth import tenant_context as tc
    from db.supabase_client import service_client
    users = (service_client().table("users")
             .select("id,email,role,last_tenant_id").execute().data or [])
    out = {}
    for u in users:
        mems = tc.active_memberships(u["id"])
        chosen = tc._default_membership(u, mems)
        # set_active_tenant refuses a tenant the user does not actively hold.
        ids = {str(m["tenant_id"]) for m in mems}
        eff = str(chosen["tenant_id"]) if chosen and str(chosen["tenant_id"]) in ids else None
        out[str(u["id"])] = {
            "memberships": sorted(str(m["tenant_id"]) for m in mems),
            "tenant": eff,
            "tenant_role": (chosen or {}).get("role") if eff else None,
        }
    return out


if __name__ == "__main__":
    what = sys.argv[1]
    sys.stdout.write(json.dumps(sets() if what == "sets" else tenants()))
