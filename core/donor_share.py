"""The donor SHARE summary and its PDF — lifted out of app_pages/donors.py.

WHY THIS MODULE EXISTS, and why it is separate from donor_fields. `donor_fields` owns the
vocabulary: what a column is called, what counts as documented. This owns the one
DOCUMENT the product hands to somebody outside it — the summary a user copies into an
email, downloads as markdown, or prints as a branded PDF. It is the only donor output
that leaves the application, so it is the one whose wording a reader cannot cross-check
against anything.

It had to move for the same reason the save rules did: the PDF is reportlab, so it cannot
run in the Edge Function, so it has to run as a job — and a job cannot call a function
that lives inside a Streamlit page. The alternative was a second summary in the job
runner, which would be the third copy of this layout (donors.py, model.ts, the runner)
and the first one nobody would notice drifting, because a PDF is read by the person it
was sent to and by nobody else.

THE GROUPS ARE A PARAMETER, NOT AN IMPORT. `summary_lines` needs the flag groups, and
those are DERIVED from the live table's columns (`donor_fields.flag_groups`). Hard-coding
them here would freeze today's columns into a document that is supposed to grow with the
table; taking them as an argument keeps the caller honest about having read the schema.

NOTHING HERE TOUCHES THE DATABASE OR STREAMLIT. `donor_pdf` reads the deploying org's
name and logo through `core.settings`, which is a database read, and it is the only one —
it is wrapped so a settings failure prints an unbranded PDF rather than none.
"""
from __future__ import annotations

import json
import re
from typing import Any, Mapping

from core import donor_fields as F
from core.program_area_classifier import category_full as _pa_cat
from core.program_area_classifier import subarea_label as _pa_sub

__all__ = [
    "past_projects", "funding_tiers", "project_line", "tier_line",
    "contact_line", "summary_lines", "share_markdown", "donor_pdf",
    "share_filename",
]


def past_projects(row: Mapping[str, Any]) -> list[dict]:
    """Parsed past-projects list (only entries with a title), or []."""
    return [p for p in F.json_dicts(row.get("donor_past_projects_json")) if p.get("title")]


def funding_tiers(row: Mapping[str, Any]) -> list[dict]:
    """Parsed funding-tiers list (only entries with a name), or []."""
    return [t for t in F.json_dicts(row.get("donor_funding_tiers_json")) if t.get("name")]


def project_line(p: Mapping[str, Any]) -> str:
    """One markdown bullet for a funded project: title — amount, year, country,
    stage. <desc>."""
    bits = []
    amt = p.get("amount")
    if amt not in (None, ""):
        cur = (p.get("currency") or "").strip()
        try:
            bits.append((f"{cur} " if cur else "") + f"{float(amt):,.0f}")
        except (TypeError, ValueError):
            bits.append(((f"{cur} " if cur else "") + str(amt)).strip())
    for k in ("year", "country", "stage"):
        if p.get(k):
            bits.append(str(p[k]).strip())
    head = f"- {str(p['title']).strip()}"
    if bits:
        head += f" — {', '.join(bits)}"
    desc = str(p.get("description") or "").strip()
    if desc:
        head += f". {desc}"
    link = str(p.get("link") or "").strip()
    if link:
        head += f" ({link})"
    return head


def tier_line(t: Mapping[str, Any]) -> str:
    """One markdown bullet for a funding tier: **name** — amount, duration. <notes>."""
    seg = [str(t[k]).strip() for k in ("amount", "duration") if t.get(k)]
    head = f"- **{str(t.get('name', '')).strip()}**"
    if seg:
        head += f" — {', '.join(seg)}"
    notes = str(t.get("notes") or "").strip()
    if notes:
        head += f". {notes}"
    return head


def contact_line(cr: Mapping[str, Any]) -> str:
    """One markdown line for a focal-person contact ($ escaped).

    THE ESCAPE IS FOR STREAMLIT, NOT FOR MARKDOWN. `st.markdown` reads `$…$` as LaTeX, so
    an amount in a contact's notes would render as maths. Anything consuming this for a
    file or a PDF undoes it — see `share_markdown`, which is what the share path uses.
    """
    name = F.disp(cr.get("contact_name")) or "(unnamed)"
    head = f"**{name}**"
    if F.disp(cr.get("role_title")):
        head += f" — {F.disp(cr.get('role_title'))}"
    if cr.get("is_official"):
        head += " · ✅ official"
    bits = []
    if F.disp(cr.get("email")):
        bits.append(f"✉ {F.disp(cr.get('email'))}")
    if F.disp(cr.get("phone")):
        bits.append(f"☎ {F.disp(cr.get('phone'))}")
    if F.disp(cr.get("linkedin_url")):
        ln = F.disp(cr.get("linkedin_url"))
        bits.append(f"[LinkedIn]({ln})" if ln.startswith("http") else f"LinkedIn: {ln}")
    if F.disp(cr.get("address")):
        bits.append(F.disp(cr.get("address")))
    if F.disp(cr.get("notes")):
        bits.append(f"_{F.disp(cr.get('notes'))}_")
    line = head + ("  \n" + " · ".join(bits) if bits else "")
    return line.replace("$", r"\$")


def summary_lines(row: Mapping[str, Any],
                  groups: Mapping[str, list[str]]) -> list[str]:
    """Sectioned markdown for share / PDF / download, laid out in 'Donor
    Intelligence Report' order so the A4-portrait PDF prints with clean section
    headings. Blank fields and empty sections are skipped — only what's known
    shows. Section-title lines (no leading '- ') render as PDF sub-headings.

    `groups` is `donor_fields.flag_groups(columns)[3]` — the derived classification over
    the live table's columns.
    """
    _label = F.label
    _disp = F.disp
    _to_list = F.to_list
    _disp_field = F.disp_field
    _pretty_choice = F.pretty_choice
    _normalize_category = F.normalize_category

    lines = [f"# {F.title_name(row)}", ""]

    def section(title: str, pairs: list[tuple[str, str]]) -> None:
        pairs = [(lbl, v) for lbl, v in pairs if v]
        if not pairs:
            return
        lines.append(title)
        for lbl, v in pairs:
            lines.append(f"- **{lbl}:** {v}")
        lines.append("")

    def flags(group: str) -> str | None:
        labs = []
        for c in groups.get(group, []):
            if _yes(row.get(c)):
                labs.append(re.sub(r"\s*fit$", "", _label(c), flags=re.I)
                            if group == "Program-area fit" else _label(c))
        return ", ".join(labs) or None

    def choice(col: str) -> str | None:
        return _pretty_choice(row.get(col)) if _disp(row.get(col)) else None

    def listf(col: str) -> str | None:
        vals = _to_list(row.get(col))
        return ", ".join(vals) if vals else None

    _cat = _normalize_category(row.get("donor_category"))
    section("Overview", [
        ("Category", _cat if _cat != "(uncategorised)" else None),
        ("Donor type", _disp(row.get("donor_type"))),
        ("Also an implementer that publishes calls",
         _disp(row.get("donor_is_dual_role_implementer"))),
        ("Founded", _disp(row.get("donor_founded"))),
        ("Website", _disp(row.get("donor_website"))),
        ("HQ country", _disp(row.get("donor_hq_country"))),
        ("HQ address", _disp(row.get("donor_hq_address"))),
        ("General email", _disp(row.get("donor_general_email"))),
        ("Main phone", _disp(row.get("donor_main_phone"))),
        ("LinkedIn", _disp(row.get("donor_linkedin_url"))),
        ("Other profiles", _disp(row.get("donor_other_profile_urls"))),
    ])
    section("About & strategy", [
        ("Summary", _disp(row.get("donor_summary_description"))),
        ("Mission", _disp(row.get("donor_mission"))),
        ("Vision", _disp(row.get("donor_vision"))),
        ("Values", _disp(row.get("donor_values"))),
        (_label("donor_strategic_priorities"), _disp(row.get("donor_strategic_priorities"))),
        ("Strategy (URL)", _disp(row.get("donor_strategy_url"))),
    ])

    _lo, _hi = _disp(row.get("donor_award_low")), _disp(row.get("donor_award_high"))
    _award = f"{_lo or '—'} – {_hi or '—'}" if (_lo or _hi) else None
    _pb = _disp(row.get("donor_projected_budget"))
    if _pb:
        _per = _disp(row.get("donor_projected_budget_period"))
        _pb = f"{_pb} ({_per})" if _per else _pb
    section("Funding", [
        ("Award range", _award),
        ("Annual funding", _disp(row.get("donor_total_annual_funding_global"))),
        ("Total awards", _disp(row.get("donor_total_awards"))),
        ("Total funding to date", _disp(row.get("donor_total_funding_to_date"))),
        ("Current awards", _disp(row.get("donor_current_awards"))),
        ("Past awards", _disp(row.get("donor_past_awards"))),
        ("Projected budget", _pb),
        ("Funding mechanism", _disp_field(row, "donor_funding_mechanism")),
        (_label("donor_funders_collaborators"), _disp_field(row, "donor_funders_collaborators")),
        (_label("donor_funding_programs"), _disp(row.get("donor_funding_programs"))),
    ])
    _tiers = funding_tiers(row)
    if _tiers:
        lines.append("Funding tiers / bands")
        lines.extend(tier_line(t) for t in _tiers)
        lines.append("")

    # Scope & fit — strategic priority areas (graded), geographies, in/out scope.
    _areas_s = _to_list(row.get("donor_priority_areas"))
    try:
        _pa_ratings_s = json.loads(row.get("donor_priority_ratings") or "{}")
        _pa_ratings_s = _pa_ratings_s if isinstance(_pa_ratings_s, dict) else {}
    except (ValueError, TypeError):
        _pa_ratings_s = {}
    _scope_pairs = [(lbl, v) for lbl, v in (
        ("Funding scope — geographies", listf("donor_geographic_scope")),
        (_label("donor_in_scope"), _disp(row.get("donor_in_scope"))),
        (_label("donor_out_of_scope"), _disp(row.get("donor_out_of_scope"))),
    ) if v]
    if _areas_s or _scope_pairs:
        lines.append("Scope & fit")
        for _k, _v in sorted(_pa_ratings_s.items(), key=lambda kv: (-int(kv[1]), kv[0])):
            lines.append(f"- **Priority:** {_pa_sub(_k)} ({_pa_cat(_k)}) — {int(_v)}/5")
        for _a in _areas_s:
            if _a not in _pa_ratings_s:
                lines.append(f"- **Priority area:** {_pa_sub(_a)}")
        for _lbl, _v in _scope_pairs:
            lines.append(f"- **{_lbl}:** {_v}")
        lines.append("")
    section("Eligibility & process", [
        ("Legal & registration requirements", flags("Legal & registration requirements")),
        ("Requirements & compliance", flags("Requirements & compliance")),
        ("Direct local org eligible", _disp(row.get("donor_direct_local_org_eligible"))),
        ("Route status", _disp(row.get("donor_active_route_status"))),
        ("Prefinance", choice("donor_prefinance_required")),
        ("Application process", _disp(row.get("donor_application_process"))),
        ("Funding cycle", _disp(row.get("donor_funding_cycle"))),
        ("Reporting requirements", _disp(row.get("donor_reporting_requirements"))),
        (_label("donor_application_deadlines"), _disp(row.get("donor_application_deadlines"))),
        (_label("donor_submission_portal_url"), _disp(row.get("donor_submission_portal_url"))),
        ("Recent activity", _disp(row.get("donor_recent_activity"))),
        (_label("donor_eligibility_notes"), _disp(row.get("donor_eligibility_notes"))),
        (_label("donor_selection_criteria"), _disp(row.get("donor_selection_criteria"))),
        (_label("donor_hq_country_required"), listf("donor_hq_country_required")),
        (_label("org_stage_required"), _disp(row.get("org_stage_required"))),
        (_label("donor_max_annual_budget"), _disp_field(row, "donor_max_annual_budget")),
        (_label("donor_min_track_record"), _disp_field(row, "donor_min_track_record")),
        (_label("donor_required_partner_type"), listf("donor_required_partner_type")),
        (_label("donor_required_partner_country"), listf("donor_required_partner_country")),
        (_label("donor_max_request_pct_of_budget"), _disp(row.get("donor_max_request_pct_of_budget"))),
        (_label("donor_min_cofinancing_secured_pct"), _disp(row.get("donor_min_cofinancing_secured_pct"))),
        (_label("donor_entity_type_required"), choice("donor_entity_type_required")),
        (_label("donor_registration_region"), listf("donor_registration_region")),
        (_label("donor_requires_pi"), choice("donor_requires_pi")),
        (_label("donor_pi_country_scope"), choice("donor_pi_country_scope")),
        (_label("donor_max_prior_grant"), _disp_field(row, "donor_max_prior_grant")),
        (_label("donor_prior_beneficiary_rule"), choice("donor_prior_beneficiary_rule")),
    ])

    projects = past_projects(row)
    if projects:
        lines.append(f"Past Projects — funded projects ({len(projects)})")
        lines.extend(project_line(p) for p in projects)
        lines.append("")

    section("Strategic guidance", [
        (_label("donor_strategic_fit_notes"), _disp(row.get("donor_strategic_fit_notes"))),
        (_label("donor_gaps_risks"), _disp(row.get("donor_gaps_risks"))),
        (_label("donor_recommended_approach"), _disp(row.get("donor_recommended_approach"))),
    ])
    section("Sources & data quality", [
        ("Verification", choice("donor_verification_level")),
        ("Evidence summary", _disp(row.get("donor_evidence_summary"))),
        ("Notes", _disp(row.get("notes"))),
        ("Aliases", _disp(row.get("donor_aliases"))),
        ("Source URLs", _disp(row.get("donor_source_urls"))),
        ("Opportunity listing URL(s)", _disp(row.get("donor_opportunity_listing_urls"))),
    ])
    return lines


def _yes(v: Any) -> bool:
    return str(v).strip().lower() == "yes"


def share_lines(row: Mapping[str, Any], groups: Mapping[str, list[str]],
                contacts: list[Mapping[str, Any]] | None = None) -> list[str]:
    """`summary_lines` plus the focal-person block the share dialog appends.

    THE TWO REPLACEMENTS ARE NOT COSMETIC. `contact_line` formats for `st.markdown`: it
    ends the name line with a two-space hard break and escapes `$` so Streamlit does not
    read an amount as LaTeX. Neither survives a flatten into one bullet, so the break
    becomes an em-dash separator and the escape is undone. Leave them in and a shared
    summary carries backslashes into somebody's email.
    """
    lines = list(summary_lines(row, groups))
    rows = list(contacts or [])
    if rows:
        lines.append("Contacts — focal persons")
        for cr in rows:
            lines.append("- " + contact_line(cr).replace("  \n", " — ").replace(r"\$", "$"))
        lines.append("")
    return lines


def share_markdown(row: Mapping[str, Any], groups: Mapping[str, list[str]],
                   contacts: list[Mapping[str, Any]] | None = None) -> str:
    """The shareable markdown for ONE donor — what the dialog shows and downloads."""
    return "\n".join(share_lines(row, groups, contacts))


def share_filename(row: Mapping[str, Any], ext: str = "pdf") -> str:
    """`GATES.pdf` — the short code, else the name, spaces to underscores.

    Matches the Streamlit dialog's own spelling so a file downloaded from either app
    lands under the same name in the same folder rather than beside it.
    """
    stem = str(row.get("donor_short") or row.get("donor") or "donor").strip().replace(" ", "_")
    return f"{stem or 'donor'}.{ext}"


# ---------------------------------------------------------------------------
# The PDF
# ---------------------------------------------------------------------------
def donor_pdf(lines: list[str]) -> bytes:
    """Render the share summary to a branded PDF: the deploying org's logo +
    name/team at the top, the donor intelligence body, and an RFPIS footer on
    every page. reportlab base fonts are WinAnsi, so emoji/symbols are swapped
    for ASCII and any other non-cp1252 glyph is dropped."""
    import io
    import re as _re
    from datetime import date as _date
    from xml.sax.saxutils import escape as _esc
    from reportlab.lib import colors as _colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import (
        HRFlowable, Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer,
    )

    def _safe(s: str) -> str:
        for a, b in (("✅", "[official]"), ("📇", ""), ("✉", "Email:"),
                     ("☎", "Phone:")):
            s = s.replace(a, b)
        return s.encode("cp1252", "ignore").decode("cp1252")

    def _inline(s: str) -> str:
        parts = _re.split(r"\*\*(.+?)\*\*", s)
        return "".join(f"<b>{_esc(_safe(p))}</b>" if i % 2 else _esc(_safe(p))
                       for i, p in enumerate(parts))

    base = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=base["Title"], fontSize=16, spaceBefore=4, spaceAfter=12)
    head = ParagraphStyle("head", parent=base["Heading4"], spaceBefore=8, spaceAfter=2)
    body = ParagraphStyle("body", parent=base["BodyText"], fontSize=9.5, leading=13)
    bullet = ParagraphStyle("bul", parent=body, leftIndent=12)
    org_name_st = ParagraphStyle("orgname", parent=base["Normal"], alignment=TA_CENTER,
                                 fontSize=12, leading=15, spaceAfter=1,
                                 textColor=_colors.HexColor("#1e3a8a"))
    org_team_st = ParagraphStyle("orgteam", parent=base["Normal"], alignment=TA_CENTER,
                                 fontSize=9.5, leading=12, spaceAfter=8,
                                 textColor=_colors.HexColor("#475569"))

    # --- Org branding header (logo + name + team) ---
    flow: list = []
    try:
        from core import settings as _s
        _org = _s.get_org()
        _logo_bytes, _ = _s.get_org_logo()
    except Exception:
        _org, _logo_bytes = {}, None
    if _logo_bytes:
        try:
            _ir = ImageReader(io.BytesIO(_logo_bytes))
            _iw, _ih = _ir.getSize()
            _maxh = 46.0
            _img = Image(io.BytesIO(_logo_bytes), width=_iw * (_maxh / _ih), height=_maxh)
            _img.hAlign = "CENTER"
            flow.append(_img)
            flow.append(Spacer(1, 5))
        except Exception:
            pass  # unrenderable (e.g. SVG/WebP) — skip the logo gracefully
    _oname = _safe(str(_org.get("org_name") or "")).strip()
    if _oname and _oname.lower() != "your organization":
        flow.append(Paragraph(f"<b>{_esc(_oname)}</b>", org_name_st))
    # "Donor Intelligence" eyebrow under the org name (replaces the redundant
    # team line — org_name already carries the team); the donor name then
    # stands alone as the title below.
    flow.append(Paragraph("Donor Intelligence", org_team_st))
    flow.append(HRFlowable(width="100%", thickness=0.6,
                           color=_colors.HexColor("#cbd5e1"), spaceAfter=8))

    # --- Donor intelligence body (from the share markdown lines) ---
    #
    # A "# " heading is a DONOR, and there is exactly one per profile. Several of them
    # means a combined document, so each one after the first starts a new page: a profile
    # that begins two thirds of the way down somebody else's last page cannot be printed,
    # filed or handed to a colleague on its own, which is what a donor PDF is for. The
    # FIRST is never preceded by a break, or every single-donor PDF would open on a blank
    # page under the letterhead.
    started = False
    for ln in lines:
        if not ln.strip():
            flow.append(Spacer(1, 4))
        elif ln.startswith("# "):
            if started:
                flow.append(PageBreak())
            started = True
            flow.append(Paragraph(_inline(ln[2:]), h1))
        elif ln.startswith("- "):
            flow.append(Paragraph("&bull;&nbsp;" + _inline(ln[2:]), bullet))
        else:
            flow.append(Paragraph(_inline(ln), head))

    # --- RFPIS footer on every page ---
    def _footer(canvas, doc):
        canvas.saveState()
        w, _h = A4
        canvas.setStrokeColor(_colors.HexColor("#e2e8f0"))
        canvas.setLineWidth(0.5)
        canvas.line(1.8 * cm, 1.35 * cm, w - 1.8 * cm, 1.35 * cm)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(_colors.HexColor("#94a3b8"))
        canvas.drawCentredString(
            w / 2.0, 1.0 * cm,
            "RFP Intelligence System (RFPIS) · Version 1 · All Rights Reserved.")
        canvas.drawString(1.8 * cm, 1.0 * cm, f"Generated {_date.today().isoformat()}")
        canvas.drawRightString(w - 1.8 * cm, 1.0 * cm, f"Page {doc.page}")
        canvas.restoreState()

    buf = io.BytesIO()
    SimpleDocTemplate(
        buf, pagesize=A4, leftMargin=1.8 * cm, rightMargin=1.8 * cm,
        topMargin=1.5 * cm, bottomMargin=1.9 * cm, title="Donor Intelligence",
    ).build(flow, onFirstPage=_footer, onLaterPages=_footer)
    return buf.getvalue()
