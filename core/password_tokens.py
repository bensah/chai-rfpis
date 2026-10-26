"""One-time links for account setup and password reset.

Replaces emailing a temporary password. A password in an inbox stays valid
until somebody changes it, and it is sitting in the sender's outbox and in
every mail server that relayed it. A token expires, is single-use, and is
worthless afterwards.

# What the link can do

Exactly one thing: open the set-password screen for one account. It does
NOT sign anyone in. That is the deliberate trade — a forwarded invite lets
an attacker set a password, but it cannot be done invisibly, because the
real user's own login then fails and they say so. A link that authenticated
the bearer would hand over the account silently.

# What is stored

Only `sha256(token)`. The token exists in the email and nowhere else, so
this table leaking yields nothing usable — the same reasoning behind
storing `password_hash` rather than a password.

# Lifetimes

    invite   7 days   a new joiner may not read their email today
    reset    2 hours  requested deliberately and acted on at once, so a
                      short window limits how long a copy stays live

Issuing a new token for an account invalidates any outstanding one, so a
re-sent invite silently retires the first link rather than leaving two
valid ways in.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, NamedTuple, Optional

from db.supabase_client import service_client

PURPOSE_INVITE = "invite"
PURPOSE_RESET = "reset"

_TTL = {
    PURPOSE_INVITE: timedelta(days=7),
    PURPOSE_RESET: timedelta(hours=2),
}

# 32 bytes of urandom, URL-safe. Long enough that guessing is not a strategy
# and short enough to survive a mail client wrapping the line.
_TOKEN_BYTES = 32

# The typed code. Six digits is one in a million, which is only defensible
# because of the two rules below it; see `check_code`.
CODE_DIGITS = 6
MAX_CODE_ATTEMPTS = 5


class IssuedToken(NamedTuple):
    """One issued credential, in its two forms.

    `token` goes in the link and is the strong one. `code` is the same
    permission in a form somebody can read off a phone and type, and is weak
    enough that it is only ever checked against one named account, a limited
    number of times.
    """
    token: str
    code: str
    expires_at: datetime


def _digest(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _gen_code() -> str:
    """A zero-padded six-digit code.

    randbelow, not randint on a seeded generator: this is a credential. Leading
    zeros are kept because dropping them would both shrink the space and produce
    a code that does not match what the email printed.
    """
    return f"{secrets.randbelow(10 ** CODE_DIGITS):0{CODE_DIGITS}d}"


def normalise_code(code: str) -> str:
    """What the user typed, reduced to the digits they meant.

    People space codes in threes, paste them with a stray newline, and some mail
    clients insert a non-breaking space. None of that should be a wrong code.
    """
    return "".join(ch for ch in (code or "") if ch.isdigit())


def _now() -> datetime:
    return datetime.now(timezone.utc)


def issue_token(
    *,
    user_id: str,
    purpose: str,
    created_by: Optional[str] = None,
) -> IssuedToken:
    """Mint a credential for one account, in both its forms.

    Returns the long token for the link, the six-digit code for typing, and
    the expiry. Both are returned ONCE, to be put in the email — neither is
    recoverable afterwards, by us or by anyone who reads the database, since
    only their digests are stored.

    The two are alternatives, not a pair to present together: either proves
    the same thing, and the code exists because a 43-character token is not
    something to retype off a phone.

    Any outstanding token for the same user is retired first: re-sending an
    invite should replace the old link, not add a second working one.
    """
    if purpose not in _TTL:
        raise ValueError(f"Unknown token purpose {purpose!r}")

    raw = secrets.token_urlsafe(_TOKEN_BYTES)
    code = _gen_code()
    expires_at = _now() + _TTL[purpose]
    sb = service_client()

    # Retire anything still live for this user. Marked used rather than
    # deleted so the audit trail still shows a link was issued and
    # superseded.
    try:
        sb.table("user_password_tokens").update(
            {"used_at": _now().isoformat()}
        ).eq("user_id", user_id).is_("used_at", None).execute()
    except Exception:
        # A failure to retire old tokens must not block issuing a new one -
        # the new link is what the user is waiting on, and the old ones
        # still expire on their own.
        pass

    sb.table("user_password_tokens").insert({
        "user_id": user_id,
        "token_hash": _digest(raw),
        "code_hash": _digest(code),
        "attempts": 0,
        "purpose": purpose,
        "expires_at": expires_at.isoformat(),
        "created_by": created_by,
    }).execute()

    return IssuedToken(token=raw, code=code, expires_at=expires_at)


def peek_token(raw_token: str) -> Optional[dict[str, Any]]:
    """Validate a token WITHOUT consuming it.

    Used to decide whether to render the set-password screen. Consuming
    here would burn the link on a page refresh, which is the most common
    thing a confused user does.

    Returns the joined token+user record, or None when the token is
    unknown, already used, or expired. The three are deliberately not
    distinguished to the caller: telling a stranger "that link expired"
    confirms the link once existed.
    """
    if not raw_token:
        return None
    sb = service_client()
    try:
        res = (
            sb.table("user_password_tokens")
            .select("id, user_id, purpose, expires_at, used_at")
            .eq("token_hash", _digest(raw_token))
            .limit(1)
            .execute()
        )
    except Exception:
        return None

    rows = res.data or []
    if not rows:
        return None
    row = rows[0]
    if row.get("used_at"):
        return None

    try:
        expires = datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00"))
    except Exception:
        return None
    if expires <= _now():
        return None

    try:
        ures = (
            sb.table("users")
            .select("id, email, name, is_active")
            .eq("id", row["user_id"])
            .limit(1)
            .execute()
        )
    except Exception:
        return None
    users = ures.data or []
    if not users:
        return None

    row["user"] = users[0]
    return row


def _live_and_owned(sb: Any, row: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Attach the owning user if `row` is still usable, else None.

    The unused / unexpired / owner-exists checks that peek_token makes, factored
    out so the code path cannot drift from the token path.
    """
    if row.get("used_at"):
        return None
    try:
        expires = datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00"))
    except Exception:
        return None
    if expires <= _now():
        return None
    try:
        users = (sb.table("users").select("id, email, name, is_active")
                 .eq("id", row["user_id"]).limit(1).execute().data or [])
    except Exception:
        return None
    if not users:
        return None
    row["user"] = users[0]
    return row


def peek_by_id(token_id: str) -> Optional[dict[str, Any]]:
    """peek_token's verdict for a row already identified by a code check.

    A short code proves WHICH row it is without revealing the long token, so
    once it has been checked the set-password screen keys on the row id for the
    rest of its reruns. Re-reads the row every time rather than trusting the
    session, so a code consumed in another tab stops working here too.
    """
    if not token_id:
        return None
    sb = service_client()
    try:
        rows = (sb.table("user_password_tokens")
                .select("id, user_id, purpose, expires_at, used_at")
                .eq("id", token_id).limit(1).execute().data or [])
    except Exception:
        return None
    return _live_and_owned(sb, rows[0]) if rows else None


def check_code(email: str, code: str) -> Optional[dict[str, Any]]:
    """Validate a six-digit code against ONE named account, counting the attempt.

    Six digits is one in a million, so unlike the long token it is not safe to
    look up on its own. Two rules make it defensible, and both live here:

      * the code is only ever checked against the account named by `email`. The
        holder must know the address, and a code that would match somebody
        else's token is simply wrong. A global lookup would let a sweep of a
        million codes hit whichever live token collided, belonging to anybody.

      * every check is counted, and the token is BURNED once the limit is
        passed, so an issued code is worth a handful of guesses rather than the
        million its length suggests. Burning rather than merely refusing means
        an attacker who exhausts the limit also destroys the credential they
        were guessing at, instead of waiting for the counter to be forgotten.

    Returns the same record shape as peek_token, or None for every kind of
    failure. Does NOT consume on success: that happens once the new password is
    accepted, exactly as with a link.
    """
    digits = normalise_code(code)
    if len(digits) != CODE_DIGITS or not email:
        return None

    sb = service_client()
    try:
        users = (sb.table("users").select("id, email, name, is_active, is_blacklisted")
                 .eq("email", email.strip()).limit(1).execute().data or [])
    except Exception:
        return None
    if not users:
        return None
    u = users[0]
    if not u.get("is_active") or u.get("is_blacklisted"):
        return None

    try:
        rows = (sb.table("user_password_tokens")
                .select("id, user_id, purpose, expires_at, used_at, code_hash, attempts")
                .eq("user_id", u["id"]).is_("used_at", None)
                .order("created_at", desc=True).limit(1).execute().data or [])
    except Exception:
        return None
    if not rows or not rows[0].get("code_hash"):
        return None
    row = rows[0]

    attempts = int(row.get("attempts") or 0)
    if attempts >= MAX_CODE_ATTEMPTS:
        invalidate_tokens_for_user(u["id"])
        return None

    # Count the attempt BEFORE comparing, so a failure between the two costs a
    # guess rather than granting a free one. The `lt` filter bounds the damage
    # if two guesses race: PostgREST cannot do attempts = attempts + 1 server
    # side without an RPC, so the write is conditional on still being under the
    # limit and a loser of the race simply does not get counted twice.
    try:
        updated = (sb.table("user_password_tokens")
                   .update({"attempts": attempts + 1})
                   .eq("id", row["id"]).lt("attempts", MAX_CODE_ATTEMPTS)
                   .execute().data or [])
    except Exception:
        return None
    if not updated:
        invalidate_tokens_for_user(u["id"])
        return None

    if not secrets.compare_digest(str(row["code_hash"]), _digest(digits)):
        if attempts + 1 >= MAX_CODE_ATTEMPTS:
            invalidate_tokens_for_user(u["id"])
        return None

    return _live_and_owned(sb, row)


def consume_by_id(token_id: str) -> Optional[dict[str, Any]]:
    """Burn a row identified by a code check. consume_token, without the token."""
    record = peek_by_id(token_id)
    if record is None:
        return None
    try:
        res = (service_client().table("user_password_tokens")
               .update({"used_at": _now().isoformat()})
               .eq("id", record["id"]).is_("used_at", None).execute())
    except Exception:
        return None
    if not (res.data or []):
        return None
    return record


def consume_token(raw_token: str) -> Optional[dict[str, Any]]:
    """Validate and burn a token in one step.

    Called only once the new password has been accepted. The update is
    conditional on `used_at is null`, so two tabs racing to submit cannot
    both succeed — whichever loses gets None and is told the link is spent.
    """
    record = peek_token(raw_token)
    if record is None:
        return None

    sb = service_client()
    try:
        res = (
            sb.table("user_password_tokens")
            .update({"used_at": _now().isoformat()})
            .eq("id", record["id"])
            .is_("used_at", None)
            .execute()
        )
    except Exception:
        return None

    if not (res.data or []):
        # Someone else consumed it between peek and update.
        return None
    return record


def invalidate_tokens_for_user(user_id: str) -> None:
    """Retire every outstanding link for an account.

    Called after a password is set by any route. A reset link that still
    works after the user has already chosen a password is a live credential
    nobody is watching.
    """
    try:
        service_client().table("user_password_tokens").update(
            {"used_at": _now().isoformat()}
        ).eq("user_id", user_id).is_("used_at", None).execute()
    except Exception:
        pass


def build_link(app_url: str, raw_token: str) -> str:
    """The URL that goes in the email.

    Streamlit reads `st.query_params`, so the token rides as a query string
    on the app root. Built from the deployment's own APP_PUBLIC_URL rather
    than a literal, so a domain change does not send people somewhere dead.
    """
    return f"{app_url.rstrip('/')}/?token={raw_token}"


__all__ = [
    "PURPOSE_INVITE",
    "PURPOSE_RESET",
    "CODE_DIGITS",
    "MAX_CODE_ATTEMPTS",
    "IssuedToken",
    "issue_token",
    "peek_token",
    "peek_by_id",
    "check_code",
    "normalise_code",
    "consume_token",
    "consume_by_id",
    "invalidate_tokens_for_user",
    "build_link",
]
