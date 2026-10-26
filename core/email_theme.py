"""One look for every email the system sends.

The pipeline digest had a table-based, brand-coloured layout while account mail
still used an older shell with a different palette, so an invitation and the
weekly alert did not look like they came from the same product. This holds the
palette and the outer shell both now use.

Table-based and inline-styled on purpose. Desktop Outlook renders with Word,
which ignores flexbox, grid, most of `position`, and anything in a <style>
block, so a layout that looks fine in a browser can arrive as a single
unstyled column. Tables and inline attributes are what survive.

The colours are the deploying organisation's, supplied here as values rather
than named after it, so the source carries a palette and not a brand.
"""
from __future__ import annotations

import html as _html

DARK_BLUE = "#003E78"
TURQUOISE = "#117996"
LIGHT_BLUE = "#D5E7EF"
LIGHT_GREY = "#F2F2F2"
BODY_TEXT = "#000000"
MUTED_TEXT = "#475569"
FAINT_TEXT = "#94A3B8"
HAIRLINE = "#E3E7E3"
FONT = "'Trebuchet MS', Arial, sans-serif"


def esc(v: object) -> str:
    return _html.escape("" if v is None else str(v), quote=True)


def button(url: str, label: str) -> str:
    """A link styled as a button, with the URL repeated as text underneath.

    Some corporate mail clients strip or rewrite anchors, and a tap on a
    forwarded phone is unreliable, so the URL is always readable as well.
    """
    safe = esc(url)
    return f"""
      <tr><td style="padding:22px 0 6px 0;">
        <a href="{safe}" style="background:{DARK_BLUE};color:#ffffff;text-decoration:none;
           padding:13px 26px;border-radius:6px;font-family:{FONT};font-size:15px;
           font-weight:bold;display:inline-block;">{esc(label)}</a>
      </td></tr>
      <tr><td style="font-family:{FONT};font-size:12px;color:#64748B;
                     word-break:break-all;padding-bottom:4px;">
        If the button does not work, paste this into your browser:<br>{safe}
      </td></tr>"""


def code_block(code: str) -> str:
    """A short code, set large enough to read off a phone and copy by eye."""
    return f"""
      <tr><td align="center" style="padding:6px 0 2px 0;">
        <div style="font-family:{FONT};font-size:30px;letter-spacing:8px;font-weight:bold;
                    color:{DARK_BLUE};background:{LIGHT_GREY};border:1px solid {HAIRLINE};
                    border-radius:8px;padding:16px 10px;">{esc(code)}</div>
      </td></tr>"""


def shell(*, eyebrow: str, heading: str, greeting: str, body_rows: str,
          footer_note: str = "", app_url: str = "", help_url: str = "") -> str:
    """The whole message: header bar, greeting, caller's rows, footer.

    `body_rows` is raw <tr> markup, so a caller composes with `button`,
    `code_block` and paragraphs of its own rather than being handed a fixed
    shape. `eyebrow` is the small uppercase line above the heading, usually the
    product and the tenant.
    """
    greet = esc(greeting.split()[0]) if greeting else "there"
    links = ""
    if app_url:
        safe_app = esc(app_url)
        help_part = (f'&nbsp;·&nbsp;<a href="{esc(help_url)}" '
                     f'style="color:{TURQUOISE};">Help</a>') if help_url else ""
        links = (f'<tr><td style="font-family:{FONT};font-size:13px;color:{MUTED_TEXT};'
                 f'padding-top:26px;">Log in at <a href="{safe_app}" '
                 f'style="color:{TURQUOISE};">{safe_app}</a>{help_part}</td></tr>')
    note = (f'<tr><td style="font-family:{FONT};font-size:13px;color:{MUTED_TEXT};'
            f'padding-top:14px;">{footer_note}</td></tr>') if footer_note else ""
    return f"""<!doctype html>
<html><body style="margin:0;padding:0;background:{LIGHT_GREY};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
       style="background:{LIGHT_GREY};">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="max-width:640px;background:#ffffff;border-radius:10px;overflow:hidden;">
    <tr><td style="background:{DARK_BLUE};padding:22px 28px;">
      <div style="font-family:{FONT};font-size:12px;letter-spacing:1px;color:{LIGHT_BLUE};
                  text-transform:uppercase;">{eyebrow}</div>
      <div style="font-family:{FONT};font-size:22px;font-weight:bold;color:#ffffff;
                  margin-top:6px;line-height:1.3;">{esc(heading)}</div>
    </td></tr>
    <tr><td style="padding:24px 28px 26px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-family:{FONT};font-size:15px;color:{BODY_TEXT};line-height:1.55;
                       padding-bottom:4px;">Hi {greet},</td></tr>
        {body_rows}
        {note}
        {links}
        <tr><td style="font-family:{FONT};font-size:12px;color:{FAINT_TEXT};padding-top:22px;">
          This is an automated message. If you didn't expect it, contact your
          administrator.
        </td></tr>
      </table>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>
"""
