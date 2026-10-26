"""Browser stand-in for auth/tenant_context.py.

The real module resolves the session's tenant from Streamlit session state and mints JWTs.
In the browser the tenant is already decided — the API put it in the snapshot — so this
answers the few questions the scoring path asks, and nothing else. See the note in
db/supabase_client.py (the browser stand-in) on why shadowing the data layer is safe.
"""
from __future__ import annotations

from typing import Any, Optional

from db.supabase_client import SNAPSHOT, service_client


def multitenant_enabled() -> bool:
    return True


def current_tenant_id() -> Optional[str]:
    return SNAPSHOT.get("tenant_id")


def override_tenant_id() -> Optional[str]:
    return SNAPSHOT.get("tenant_id")


def set_tenant_override(_tenant_id):
    return None


def reset_tenant_override(_token) -> None:
    return None


def tenant_store(tenant_id: str | None = None) -> tuple[Any, str] | None:
    tid = tenant_id or current_tenant_id()
    return (service_client(), str(tid)) if tid else None


def active_memberships(_user_id) -> list[dict]:
    return []


def developer_tenant_ids() -> list[str]:
    return []


def active_tenant_is_developer() -> bool:
    # The scoring path never needs developer powers; the API decides that, not the browser.
    return False


def public_tenant_ids() -> list[str]:
    return []


def clear_membership_cache(_user_id=None) -> None:
    return None
