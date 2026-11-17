"""Writing a donor record — the rules, with no user interface around them.

These used to live inside `_edit_dialog` in app_pages/donors.py, which meant they could
only ever run from Streamlit. The React app writes through a background job, and the job
runner needs the SAME rules: not similar ones, the same ones. `donor_intel` is shared
cross-tenant data, and the repo already says twice what a second implementation of its
write rules costs — `routes_platform.ts` on the suggestion queue, and
`scripts/run_web_job.py` on the approval path: "a quietly wrong donor record rather than"
an error.

So this module holds them once and both callers use it. It talks to Supabase but knows
nothing about Streamlit, a request or a job.

FOUR THINGS HERE ARE EASY TO GET WRONG AND HARD TO NOTICE:

  1. `clean_payload` applies `or None` to the WHOLE value, not just to strings. `False`
     and `0` become None, exactly as the Streamlit form has always done. Porting that as
     "strip strings, blank to None" would start storing `false` where the page stores
     nothing, and the tri-state's four states would quietly become five.

  2. `split_columns` drops keys the table has no column for, and NAMES them. Without that
     a user fills in a field, saves successfully, and the value disappears — the deployed
     app and the database being on different migrations is the normal cause, and nothing
     on screen would say so.

  3. `save_donor` VERIFIES the upsert came back with a row. PostgREST answers 200 with an
     empty list when RLS refuses the write or a column does not exist, so trusting the
     status code produces "looks saved, nothing changed", which is the single most
     expensive failure this table has.

  4. Contacts are reconciled AFTER the donor row and separately, so a contacts failure
     cannot roll back or block a good donor save. The caller is told about it as a
     warning, not as a failed save.
"""
from __future__ import annotations

import json
import re
from typing import Any, Iterable

from core import donor_fields as F

TABLE = "donor_intel"
CONTACTS_TABLE = "donor_contacts"


def clean_payload(edited: dict) -> dict:
    """Strip strings and collapse every empty value to None.

    NOTE THE `or None` APPLIES TO THE WHOLE EXPRESSION, which is what the Streamlit form
    has always done: False, 0, "" and [] all become None. It is not obviously right —
    a boolean False arguably means something — but it IS the stored behaviour, and the
    tri-state map depends on blank being None rather than False.
    """
    return {k: (v.strip() if isinstance(v, str) else v) or None for k, v in edited.items()}


def normalise(payload: dict, canonical_key: str) -> dict:
    """Force the key and canonicalise the category, in place of the caller doing it."""
    out = dict(payload)
    out["canonical_key"] = canonical_key
    if out.get("donor_category"):
        out["donor_category"] = F.normalize_category(out["donor_category"])
    return out


def split_columns(payload: dict, columns: Iterable[str]) -> tuple[dict, list[str]]:
    """(what can be stored, labels of what cannot).

    A key with no column is dropped — PostgREST would reject the whole write otherwise —
    but a key the user actually FILLED IN is reported, by its form label, so the caller
    can say which fields did not persist and why. A dropped blank is not worth mentioning.
    """
    cols = set(columns) | {"canonical_key"}
    dropped = sorted(F.label(k) for k, v in payload.items()
                     if k not in cols and v not in (None, ""))
    return {k: v for k, v in payload.items() if k in cols}, dropped


def mark_reviewed(payload: dict, row: dict, req_cols: Iterable[str],
                  columns: Iterable[str]) -> dict:
    """Tag every non-blank requirement as human-verified.

    A save means the reviewer looked at the requirements on screen, so the answers become
    the source of truth: auto-enrichment never overwrites a human_verified field, and the
    🔵 "suggested from a call" badge clears. Blank stays untagged — nobody verified a
    question nobody answered.
    """
    if "field_provenance" not in set(columns):
        return payload
    from core.donor_enrich import mark_human_verified

    fp = row.get("field_provenance")
    if isinstance(fp, str) and fp.strip():
        try:
            fp = json.loads(fp)
        except Exception:
            fp = {}
    fp = fp if isinstance(fp, dict) else {}
    verified = [c for c in req_cols if str(payload.get(c) or "").strip()]
    out = dict(payload)
    out["field_provenance"] = json.dumps(mark_human_verified(fp, verified))
    return out


def contact_records(rows: Iterable[dict], canonical_key: str) -> list[dict]:
    """Normalise edited focal-person rows, dropping the ones that are entirely blank.

    `is_official` is a real boolean and is NOT put through the blank-to-None rule the
    other columns get; a row is kept when any NON-boolean field has content, so ticking
    "official" on an otherwise empty row does not create a nameless contact.
    """
    out: list[dict] = []
    for cr in rows:
        rec: dict = {}
        for c in F.CONTACT_COLS:
            if c == "is_official":
                rec[c] = bool(cr.get(c))
                continue
            rec[c] = F.cell(cr.get(c))
        if any(rec[c] for c in F.CONTACT_COLS if c != "is_official"):
            rec["canonical_key"] = canonical_key
            out.append(rec)
    return out


def slug_key(name: str, existing: Iterable[str]) -> str:
    """A canonical_key from a donor name, de-duplicated against the live keys.

    Never collides: "gates_foundation", then "gates_foundation_2", and so on. A name with
    no usable characters at all falls back to "donor" rather than to an empty key, which
    would upsert onto whatever row already has one.
    """
    slug = re.sub(r"[^a-z0-9]+", "_", str(name or "").strip().lower()).strip("_") or "donor"
    taken = set(existing)
    key, i = slug, 2
    while key in taken:
        key, i = f"{slug}_{i}", i + 1
    return key


class WriteRefused(RuntimeError):
    """The database accepted the request and changed nothing."""


def save_donor(sb, payload: dict) -> list[dict]:
    """Upsert the donor row and VERIFY it landed.

    PostgREST answers 200 with an empty list when RLS refuses the write or a column is
    missing. Trusting the status code is how a save looks successful while nothing
    changed — the failure this product can least afford on a shared table — so an empty
    result is raised rather than returned.
    """
    resp = sb.table(TABLE).upsert(payload, on_conflict="canonical_key").execute()
    data = getattr(resp, "data", None)
    if not data:
        raise WriteRefused(
            "The write was blocked and nothing was changed — most likely an RLS policy "
            "or a column this deployment's database does not have.")
    return list(data)


def reconcile_contacts(sb, canonical_key: str, records: list[dict]) -> str | None:
    """Replace this donor's focal persons. Returns a warning, never raises.

    Deliberately SEPARATE from and after the donor save: the donor row is the valuable
    half, and a contacts hiccup must not make a good save look failed. The caller reports
    what comes back here as a warning alongside a successful save.
    """
    try:
        sb.table(CONTACTS_TABLE).delete().eq("canonical_key", canonical_key).execute()
        if records:
            sb.table(CONTACTS_TABLE).insert(records).execute()
    except Exception as exc:                                     # noqa: BLE001
        return f"Donor saved, but contacts couldn't be updated: {exc}"
    return None


def delete_donors(sb, keys: Iterable[str]) -> int:
    """Remove donor rows by canonical_key. Returns how many the database reported."""
    # `k is not None` FIRST: str(None) is "None", which is truthy, so a None in the list
    # would survive as the literal key "None" and be sent to the database.
    keys = [str(k).strip() for k in keys if k is not None and str(k).strip()]
    if not keys:
        return 0
    resp = sb.table(TABLE).delete().in_("canonical_key", keys).execute()
    return len(getattr(resp, "data", None) or [])


def dropped_warning(dropped: list[str]) -> str | None:
    """The sentence that stops a silently-discarded field from being a mystery."""
    if not dropped:
        return None
    return ("These fields aren't stored yet because the database is missing their columns "
            "(the deployed app and the DB are on different data-model migrations). Apply "
            "the latest `db/migrations/` in Supabase AND deploy the matching code, then "
            "re-save: " + ", ".join(dropped))


def apply_edit(sb, *, canonical_key: str, edited: dict, row: dict,
               columns: Iterable[str], req_cols: Iterable[str],
               contacts: Iterable[dict] | None = None) -> dict:
    """The whole save, in the order the Streamlit dialog does it.

    Returns {"dropped": [...], "warnings": [...]}; raises WriteRefused if the donor row
    did not land. Contacts are reconciled afterwards and downgrade to a warning.
    """
    columns = list(columns)
    payload = normalise(clean_payload(edited), canonical_key)
    payload, dropped = split_columns(payload, columns)
    payload = mark_reviewed(payload, row, req_cols, columns)

    records = contact_records(contacts or [], canonical_key)
    save_donor(sb, payload)                       # raises if the write was refused

    warnings = []
    warn = dropped_warning(dropped)
    if warn:
        warnings.append(warn)
    contact_warn = reconcile_contacts(sb, canonical_key, records)
    if contact_warn:
        warnings.append(contact_warn)
    return {"dropped": dropped, "warnings": warnings}


def suggest_edit(*, canonical_key: str | None, edited: dict, row: dict,
                 columns: Iterable[str], rationale: str | None,
                 target_label: str | None, user: dict) -> dict:
    """File a proposal instead of writing the shared row.

    The diff and the allow-list are `core.suggestions`' job, not this module's — it owns
    the optimistic claim, the live re-resolution of the target and the stale/invalid field
    reporting, and none of that should exist twice.
    """
    from core import suggestions as sug

    cols = set(columns) | {"canonical_key"}
    payload = normalise(clean_payload(edited), canonical_key or "")
    payload, _dropped = split_columns(payload, columns)
    diff, base = sug.diff_of(payload, row, allowed=cols - {"canonical_key"})
    if not diff:
        return {"ok": False, "count": 0, "detail": "No changes to suggest."}
    sug.create_suggestion(
        resource_type=TABLE, target_id=canonical_key, proposed_diff=diff,
        base_snapshot=base, rationale=rationale, target_label=target_label, user=user)
    return {"ok": True, "count": len(diff),
            "detail": f"A developer Super User will review {len(diff)} proposed change(s)."}
