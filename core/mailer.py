"""Thin wrapper around Resend.

Single send_email() helper. Reads RESEND_API_KEY + RESEND_FROM_EMAIL from
env / Streamlit secrets. Raises a clear error when not configured so the UI
can show a friendly message.

Every message leaves with a NAMED From: header rather than a bare address —
see `_from_header`. Doing it here, rather than in each caller, is the point:
account emails, the pipeline digest and anything added later all pick it up
without having to remember to.
"""
from __future__ import annotations

import os
from email.utils import formataddr, parseaddr
from typing import Any, Iterable


class MailerNotConfigured(RuntimeError):
    pass


def _secret(name: str) -> str | None:
    val = os.environ.get(name)
    if val:
        return val
    try:
        import streamlit as st  # type: ignore
        if name in st.secrets:
            return str(st.secrets[name])
    except Exception:
        pass
    return None


def is_configured() -> bool:
    """True when send_email has what it needs to reach the transport.

    Exists so a caller can tell "this deployment cannot send mail to ANYBODY", which is
    safe to say out loud, from "that address has no account", which is not. Without the
    distinction an anti-enumeration flow reports success to a visitor while the whole
    mailer is unconfigured, and nobody finds out until someone complains their email
    never arrived.
    """
    return bool(_secret("RESEND_API_KEY") and _secret("RESEND_FROM_EMAIL"))


def _from_name() -> str:
    """The display name every outgoing email should be FROM.

    Resolved, never hardcoded, for the same reason as the rest of the email identity
    (`email_product_name`, `email_powered_by`): the deploying organisation's name must not
    be baked into the source. `email_from_name` wins when a deployment wants the sender to
    read differently from the email header; otherwise the product name already configured
    for that header is reused, so one setting brands both and the two cannot drift.
    """
    try:
        from core.settings import get_setting
        for key in ("email_from_name", "email_product_name"):
            v = (get_setting(key) or "").strip()
            if v:
                return v
    except Exception:
        pass
    return ((os.environ.get("EMAIL_FROM_NAME")
             or os.environ.get("EMAIL_PRODUCT_NAME") or "").strip())


def _from_header(sender: str) -> str:
    """`sender` as a named From: header — "Product Name <no-reply@example.org>".

    Mail clients show the display name and hide the address, so a bare address is exactly
    what the recipient sees in their inbox list: a no-reply mailbox rather than the product
    that sent it.

    Two cases are left alone. A sender already in "Name <addr>" form is returned untouched,
    because wrapping a second name around it produces an invalid header; and an address that
    cannot be parsed is passed through as configured rather than silently rewritten into
    something the transport will reject.

    formataddr does the RFC 5322 work: it quotes a name containing a comma or a full stop,
    and encodes a non-ASCII one, either of which would otherwise corrupt the header.
    """
    name, addr = parseaddr(sender)
    # parseaddr hands back any bare string as an "address", so "@" is the test for
    # something worth wrapping. Naming a value that is not an address would turn a
    # misconfiguration into a stranger-looking one.
    if not addr or "@" not in addr:
        return sender
    if name:
        return sender
    display = _from_name()
    return formataddr((display, addr)) if display else addr


def send_email(
    *,
    to: Iterable[str],
    subject: str,
    html: str,
    reply_to: str | None = None,
) -> dict[str, Any]:
    api_key = _secret("RESEND_API_KEY")
    sender = _secret("RESEND_FROM_EMAIL")
    if not api_key or not sender:
        raise MailerNotConfigured(
            "RESEND_API_KEY and RESEND_FROM_EMAIL must be set in env or secrets."
        )
    sender = _from_header(sender)
    import resend  # local import; the package warns about being optional at import time

    resend.api_key = api_key
    payload: dict[str, Any] = {
        "from": sender,
        "to": list(to),
        "subject": subject,
        "html": html,
    }
    if reply_to:
        payload["reply_to"] = reply_to
    return resend.Emails.send(payload)
