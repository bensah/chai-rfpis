"""Build the Pyodide spike's fixture: the scoring snapshot, some rows, and the scores
Python gives for them.

    python web/scripts/spike/make_fixture.py <tenant_id> [n_rows] [out_dir]

The snapshot holds exactly the six reads the scoring path makes (see the module docstring
of web/src/scoring/snapshot.ts): tenant policies, the donor catalogue, the org profile, the
declared program areas, the tenant graph and the org identity. Read-only.
"""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from core.dotenv_compat import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

from auth import tenant_context as tc        # noqa: E402
from db.supabase_client import service_client  # noqa: E402


def main() -> None:
    tid = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    out = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(__file__).parent / "fixture"
    out.mkdir(parents=True, exist_ok=True)
    sb = service_client()

    def rows(table, select, **eq):
        q = sb.table(table).select(select)
        for k, v in eq.items():
            q = q.eq(k, v)
        return q.execute().data or []

    snapshot = {
        "tenant_id": tid,
        "scan_policies": next((r["value"] for r in rows(
            "tenant_settings", "value", tenant_id=tid, key="scan_policies")), None),
        "donor_intel": rows("donor_intel", "*"),
        "org_profile": next((r.get("org_profile") for r in rows(
            "tenants", "org_profile", id=tid)), None),
        "org_identity": next((r for r in rows("tenants", "name, org_identity", id=tid)), None),
        "user_programs": [r.get("program") for r in rows("users", "program", is_active=True)],
        "tenants": (sb.table("tenants")
                    .select("id,name,slug,status,parent_tenant_id,share_for_consortium_scoring")
                    .neq("status", "blacklisted").execute().data or []),
    }

    subs = (sb.table("rfp_submissions").select("*")
            .eq("tenant_id", tid).limit(n).execute().data or [])

    tok = tc.set_tenant_override(tid)
    try:
        from core.assessment import assess_row
        assess_row(dict(subs[0]))                     # warm the FX and profile caches
        t0 = time.perf_counter()
        expected = {str(r["uid"]): assess_row(dict(r)) for r in subs}
        dt = time.perf_counter() - t0
    finally:
        tc.reset_tenant_override(tok)

    # The exchange rates Python just used. core/fx.py fetches these over the network, which
    # the browser cannot do (no httpx) — without them it falls back to the static table in
    # config/dropdowns.yaml and a converted amount can land in a different band. So the rates
    # travel with the snapshot and are seeded into the browser's cache before scoring.
    from core import fx
    snapshot["fx_rates"] = {cur: list(val) for cur, (_at, val) in fx._RATE_CACHE.items()}

    (out / "snapshot.json").write_text(json.dumps(snapshot, default=str), encoding="utf-8")
    (out / "rows.json").write_text(json.dumps(subs, default=str), encoding="utf-8")
    (out / "expected.json").write_text(json.dumps(expected, default=str), encoding="utf-8")
    size = sum(f.stat().st_size for f in out.glob("*.json"))
    print(f"{len(subs)} rows, {len(snapshot['donor_intel'])} donors, "
          f"{size / 1e6:.1f} MB written to {out}")
    print(f"python scored {len(subs)} rows in {dt * 1000:.0f} ms "
          f"({dt / len(subs) * 1000:.1f} ms/row)")


if __name__ == "__main__":
    main()
