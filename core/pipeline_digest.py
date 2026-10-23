"""Email every member of a tenant when a scan lands new Proceed / Park opportunities.

Sent at the end of the Friday cron's per-tenant screening (core.scan_pipeline.
screen_all_tenants), once per tenant, only when that run ADDED at least one row the system
rates Proceed or Park. A run that added only Declines, or nothing, sends nothing - the
team should not learn to ignore the email.

What it says: how many calls the run added, split Proceed / Park / Decline; then, for each
Proceed and Park call, the funder, amount, deadline, a short note on what it is about, and
a link that lands on that opportunity's own page (/opportunity?uid=...). The link carries
?tenant= so a super_user lands in the right tenant; for everyone else the app ignores it.
A signed-out reader is sent through sign-in and then on to the same page (App.py,
_post_login_dest).

Colours follow the CHAI palette (CHAI Identity Guide): Dark Blue headings, Turquoise
accents, Light Blue / Light Grey panels, Trebuchet MS. Inline styles and tables only -
most mail clients strip <style> blocks and flexbox. Sent through the same Resend sender
as the account emails (core.mailer, RESEND_FROM_EMAIL).

Set RFPIS_PIPELINE_DIGEST=0 to switch the email off without touching code, and
RFPIS_PIPELINE_DIGEST_TO=a@x.org,b@y.org to send only to those addresses while testing.
"""
from __future__ import annotations

import html
import logging
import os
import re
from datetime import date, datetime
from typing import Any, Callable, Iterable
from urllib.parse import quote

log = logging.getLogger(__name__)

# CHAI palette (CHAI Identity Guide).
DARK_BLUE = "#003E78"
TURQUOISE = "#117996"
LIGHT_BLUE = "#D5E7EF"
LIGHT_GREY = "#F2F2F2"
DARK_GREEN = "#169E5F"
DARK_GOLD = "#C08E0A"
DARK_RED = "#7C1220"
FONT = "'Trebuchet MS', Arial, sans-serif"

MAX_LISTED = 25          # per email; the rest are counted and left to the pipeline page
_NOTE_CHARS = 220

_ROW_COLS = ("uid,opportunity_title,funding_agency,brief_description,call_award_value,"
             "currency,call_submission_deadline,decision,auto_recommendation,"
             "alignment_score,is_duplicate")


def enabled() -> bool:
    return (os.environ.get("RFPIS_PIPELINE_DIGEST") or "1").strip().lower() not in (
        "0", "false", "no", "off")


def test_recipients() -> list[str] | None:
    """RFPIS_PIPELINE_DIGEST_TO (comma-separated) limits the automatic send to these
    addresses - for trying the email out before every member receives it. Unset: everyone."""
    raw = (os.environ.get("RFPIS_PIPELINE_DIGEST_TO") or "").strip()
    return [e.strip() for e in raw.split(",") if e.strip()] or None


# ── Data ────────────────────────────────────────────────────────────────────

def verdict(row: dict[str, Any]) -> str:
    """Proceed / Park / Decline - the team's decision when there is one, else the system's.
    A freshly screened row has no human decision yet, so this is normally the auto-rec."""
    v = (row.get("decision") or row.get("auto_recommendation") or "").strip().lower()
    if v.startswith("proceed"):
        return "Proceed"
    if v == "park":
        return "Park"
    if v == "decline":
        return "Decline"
    return ""


def new_rows(client: Any, tenant_id: str, since_iso: str) -> list[dict[str, Any]]:
    """This tenant's rfp_submissions created at or after `since_iso`, duplicates dropped."""
    rows = (client.table("rfp_submissions").select(_ROW_COLS)
            .eq("tenant_id", tenant_id).gte("submitted_at", since_iso)
            .execute().data or [])
    return [r for r in rows if not r.get("is_duplicate")]


def recipients(client: Any, tenant_id: str) -> list[dict[str, str]]:
    """Active, non-blocked members of the tenant: [{email, name}], de-duplicated."""
    rows = (client.table("tenant_memberships")
            # Named FK: decided_by also points at users, so a bare embed is ambiguous.
            .select("status,users!tenant_memberships_user_id_fkey"
                    "(email,name,is_active,is_blacklisted)")
            .eq("tenant_id", tenant_id).eq("status", "active")
            .execute().data or [])
    out: dict[str, dict[str, str]] = {}
    for r in rows:
        u = r.get("users") or {}
        email = (u.get("email") or "").strip()
        if not email or "@" not in email or not u.get("is_active") or u.get("is_blacklisted"):
            continue
        out.setdefault(email.lower(), {"email": email, "name": (u.get("name") or "").strip()})
    return list(out.values())


def _tenant(client: Any, tenant_id: str) -> dict[str, Any]:
    rows = (client.table("tenants").select("name,slug").eq("id", tenant_id)
            .limit(1).execute().data or [])
    return rows[0] if rows else {}


# ── Formatting ──────────────────────────────────────────────────────────────

def _esc(v: Any) -> str:
    return html.escape("" if v is None else str(v), quote=True)


def amount_text(value: Any, currency: Any) -> str:
    """CHAI Style Guide money: US$300,000 / US$1.5 million; never "M" or "K"."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return "Amount not stated"
    if v != v or v <= 0:                                   # NaN or nothing to show
        return "Amount not stated"
    code = (str(currency or "").strip().upper() or "USD")
    if code in ("USD", "US$", "$"):
        if v >= 1_000_000_000:
            return f"US${v / 1e9:,.1f} billion".replace(".0 ", " ")
        if v >= 1_000_000:
            return f"US${v / 1e6:,.1f} million".replace(".0 ", " ")
        return f"US${v:,.0f}"
    try:
        from core.currency import format_money
        return format_money(v, code)
    except Exception:
        return f"{v:,.0f} {code}"


def date_text(value: Any) -> str:
    """CHAI Style Guide date: October 30, 2026."""
    if not value:
        return "No deadline stated"
    try:
        d = value if isinstance(value, date) else datetime.fromisoformat(str(value)[:10]).date()
    except ValueError:
        return str(value)
    return f"{d.strftime('%B')} {d.day}, {d.year}"


def brief_note(text: Any) -> str:
    """One short paragraph of what the call is about, cut at a word boundary."""
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    if not s:
        return "No summary yet. Open the opportunity for the full call."
    if len(s) <= _NOTE_CHARS:
        return s
    cut = s[:_NOTE_CHARS].rsplit(" ", 1)[0].rstrip(",;:-")
    return cut + "…"


def opportunity_url(base: str, uid: str, slug: str | None) -> str:
    url = f"{base.rstrip('/')}/opportunity?uid={quote(str(uid))}"
    return url + (f"&tenant={quote(slug)}" if slug else "")


# ── Template ────────────────────────────────────────────────────────────────

def _button(url: str, label: str, bg: str) -> str:
    return (f'<a href="{_esc(url)}" style="background:{bg};color:#ffffff;text-decoration:none;'
            f'padding:10px 18px;border-radius:6px;font-weight:bold;display:inline-block;'
            f'font-family:{FONT};font-size:14px;">{_esc(label)}</a>')


def _count_cell(n: int, label: str, color: str) -> str:
    return (f'<td align="center" style="background:{LIGHT_GREY};border-radius:8px;'
            f'padding:14px 6px;width:33%;">'
            f'<div style="font-family:{FONT};font-size:30px;font-weight:bold;color:{color};'
            f'line-height:1.1;">{n}</div>'
            f'<div style="font-family:{FONT};font-size:13px;color:#000000;">{label}</div></td>')


def _item(row: dict[str, Any], base: str, slug: str | None) -> str:
    url = opportunity_url(base, row["uid"], slug)
    meta = [row.get("funding_agency") or "Funder not stated",
            amount_text(row.get("call_award_value"), row.get("currency")),
            ("Deadline " + date_text(row.get("call_submission_deadline"))
             if row.get("call_submission_deadline") else "No deadline stated")]
    score = row.get("alignment_score")
    if isinstance(score, (int, float)):
        meta.append(f"Bid strength {round(score)}/100")
    return f"""
      <tr><td style="padding:0 0 14px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="border:1px solid {LIGHT_BLUE};border-radius:8px;">
          <tr><td style="padding:14px 16px;">
            <a href="{_esc(url)}" style="font-family:{FONT};font-size:16px;font-weight:bold;
               color:{DARK_BLUE};text-decoration:none;line-height:1.35;">{_esc(row.get("opportunity_title") or row["uid"])}</a>
            <div style="font-family:{FONT};font-size:13px;color:#4a4a4a;margin:6px 0 8px;">
              {' &nbsp;·&nbsp; '.join(_esc(m) for m in meta)}</div>
            <div style="font-family:{FONT};font-size:14px;color:#000000;line-height:1.5;">
              {_esc(brief_note(row.get("brief_description")))}</div>
            <div style="margin-top:12px;">{_button(url, "Open in RFPIS", TURQUOISE)}</div>
          </td></tr>
        </table>
      </td></tr>"""


def _section(title: str, rows: list[dict[str, Any]], base: str, slug: str | None) -> str:
    if not rows:
        return ""
    items = "".join(_item(r, base, slug) for r in rows)
    return f"""
      <tr><td style="padding:22px 0 10px 0;font-family:{FONT};font-size:18px;font-weight:bold;
                     color:{TURQUOISE};">{_esc(title)} ({len(rows)})</td></tr>
      {items}"""


def render_digest_html(*, recipient_name: str, tenant_name: str, product: str, base_url: str,
                       slug: str | None, proceed: list[dict], park: list[dict],
                       declined: int, run_label: str = "Friday's scan") -> str:
    """The whole email. Pure function: no I/O, so it can be previewed and tested."""
    listed_p = proceed[:MAX_LISTED]
    listed_k = park[:max(0, MAX_LISTED - len(listed_p))]
    hidden = len(proceed) + len(park) - len(listed_p) - len(listed_k)
    total = len(proceed) + len(park) + declined
    worth = len(proceed) + len(park)
    pipe_url = f"{base_url.rstrip('/')}/pipelines" + (f"?tenant={quote(slug)}" if slug else "")
    more = (f'<tr><td style="font-family:{FONT};font-size:14px;color:#000000;padding:0 0 8px;">'
            f'{hidden} more {"is" if hidden == 1 else "are"} waiting on the pipeline page.'
            f'</td></tr>') if hidden > 0 else ""
    greet = _esc(recipient_name.split()[0]) if recipient_name else "there"
    return f"""<!doctype html>
<html><body style="margin:0;padding:0;background:{LIGHT_GREY};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{LIGHT_GREY};">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="max-width:640px;background:#ffffff;border-radius:10px;overflow:hidden;">
    <tr><td style="background:{DARK_BLUE};padding:22px 28px;">
      <div style="font-family:{FONT};font-size:12px;letter-spacing:1px;color:{LIGHT_BLUE};
                  text-transform:uppercase;">{_esc(product)} &nbsp;·&nbsp; {_esc(tenant_name)}</div>
      <div style="font-family:{FONT};font-size:22px;font-weight:bold;color:#ffffff;margin-top:6px;
                  line-height:1.3;">New funding opportunities in your pipeline</div>
    </td></tr>
    <tr><td style="padding:24px 28px 8px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-family:{FONT};font-size:15px;color:#000000;line-height:1.55;padding-bottom:16px;">
          Hi {greet},<br><br>
          {_esc(run_label)} added <b>{total}</b> new {"call" if total == 1 else "calls"} to the
          {_esc(tenant_name)} pipeline. <b>{worth}</b> {"is" if worth == 1 else "are"} rated
          Proceed or Park and listed below, ready for the team to review.
        </td></tr>
        <tr><td style="padding-bottom:6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>
            {_count_cell(len(proceed), "Proceed", DARK_GREEN)}
            {_count_cell(len(park), "Park", DARK_GOLD)}
            {_count_cell(declined, "Declined", DARK_RED)}
          </tr></table>
        </td></tr>
        {_section("Proceed", listed_p, base_url, slug)}
        {_section("Park", listed_k, base_url, slug)}
        {more}
        <tr><td align="center" style="padding:14px 0 26px 0;">
          {_button(pipe_url, "Review this week's pipeline", DARK_BLUE)}
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="background:{LIGHT_BLUE};padding:16px 28px;font-family:{FONT};font-size:12px;
                   color:{DARK_BLUE};line-height:1.5;">
      Ratings are the system's suggestion until the team updates the decision.
      Declined calls stay in the pipeline if you want to check them.<br>
      You are receiving this because you are a member of {_esc(tenant_name)} on {_esc(product)}.
      This mailbox is not monitored. For help, open
      <a href="{_esc(base_url.rstrip('/') + '/help')}" style="color:{DARK_BLUE};">Help</a> in the app
      or ask your administrator.
    </td></tr>
  </table>
</td></tr></table>
</body></html>"""


def subject_line(tenant_name: str, proceed: int, park: int) -> str:
    n = proceed + park
    noun = "opportunity" if n == 1 else "opportunities"
    return f"{tenant_name}: {n} new funding {noun} to review ({proceed} Proceed, {park} Park)"


# ── Send ────────────────────────────────────────────────────────────────────

def send_pipeline_digest(tenant_id: str, since_iso: str, *, dry_run: bool = False,
                         client: Any = None, send: Callable[..., Any] | None = None,
                         only_to: Iterable[str] | None = None) -> dict[str, Any]:
    """Email the tenant's members about rows added since `since_iso`.

    Returns a summary dict; never raises for an ordinary miss (nothing new, no members, mail
    not configured) so the scan that calls it cannot be failed by it. `only_to` restricts the
    send to the given addresses (a test send); `dry_run` builds everything and sends nothing.
    """
    from core import user_emails as ue
    if client is None:
        from db.supabase_client import service_client
        client = service_client()
    rows = new_rows(client, tenant_id, since_iso)
    buckets: dict[str, list[dict]] = {"Proceed": [], "Park": [], "Decline": []}
    for r in rows:
        v = verdict(r)
        if v:
            buckets[v].append(r)
    for k in ("Proceed", "Park"):
        buckets[k].sort(key=lambda r: -(r.get("alignment_score") or 0))
    out: dict[str, Any] = {"new": len(rows), "proceed": len(buckets["Proceed"]),
                           "park": len(buckets["Park"]), "declined": len(buckets["Decline"]),
                           "sent": 0, "failed": 0}
    if not (buckets["Proceed"] or buckets["Park"]):
        out["skipped"] = "no new Proceed or Park rows"
        return out
    people = recipients(client, tenant_id)
    if only_to is not None:
        wanted = {e.strip().lower() for e in only_to}
        people = [p for p in people if p["email"].lower() in wanted] or \
                 [{"email": e, "name": ""} for e in wanted]
    if not people:
        out["skipped"] = "no active members with an email address"
        return out
    t = _tenant(client, tenant_id)
    tenant_name = t.get("name") or "your organization"
    product = ue._short_name()
    base = ue._app_url()
    subject = subject_line(tenant_name, len(buckets["Proceed"]), len(buckets["Park"]))
    out["subject"] = subject
    out["recipients"] = len(people)
    if dry_run:
        out["skipped"] = "dry run"
        return out
    send = send or ue.send_email
    for p in people:
        body = render_digest_html(recipient_name=p["name"], tenant_name=tenant_name,
                                  product=product, base_url=base, slug=t.get("slug"),
                                  proceed=buckets["Proceed"], park=buckets["Park"],
                                  declined=len(buckets["Decline"]))
        try:
            # One message per person: a shared To: line would show every member's address
            # to everyone, and lets the greeting use their own name.
            send(to=[p["email"]], subject=subject, html=body)
            out["sent"] += 1
        except ue.MailerNotConfigured as exc:
            out["skipped"] = f"mail not configured: {exc}"
            break
        except Exception as exc:                  # one bad address must not stop the rest
            out["failed"] += 1
            log.warning("pipeline digest to %s failed: %s", p["email"], exc)
    return out
