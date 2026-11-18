"""The Python half of the Donors parity check — app_pages/donors.py.

The rules come from `core/donor_fields.py`, which is what app_pages/donors.py itself now
calls — the page aliases every name below to that module, so comparing against it compares
against what Streamlit actually renders. It used to lift them out of the page's AST,
because the page cannot be imported (Streamlit at module scope, and it loads the live
table before defining anything).

THE SHARED-FIXTURE RULE APPLIES HERE. This file owns both the rows and the answers: it
reads real donor_intel rows, runs donors.py's own helpers over them, and emits
{row, expected}. The TypeScript side re-derives the same values from the same rows and
compares. Neither side gets to decide what "right" means on its own — the Python does,
because the Python is what the Streamlit app shows today.

WHY THESE FUNCTIONS. They are the ones whose output a human reads and compares between the
two apps:

  * `_label` turns a column name into a form label, and the donor_/call_/org_ prefix is
    stripped for display only. "Donor tax exempt status required" reads as the donor's own
    status; it means the donor REQUIRES it of applicants. A label that diverges is a
    question answered wrongly.
  * `_normalize_category` folds thirty-odd spellings into six. It drives the category
    chart, the filter and the table at once, so a divergence splits one donor group into
    two in one app and not the other.
  * `_completeness` is the number people use to decide whether a record is worth
    trusting, and it is a PERCENTAGE OF A DERIVED DENOMINATOR — the flags come from the
    live columns. Both halves have to agree about which columns are flags before the
    percentage can agree.
  * `_disp` / `_deshout` tidy SHOUTED workbook text without touching the stored value, so
    the two apps can disagree about what a donor is called while holding identical data.
  * `_to_list` splits legacy free text on ; and , but NOT on "/", because "/" appears
    inside real values ("Procurement / contracts").

READ ONLY. It selects from donor_intel and writes nothing.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import pandas as pd                                          # noqa: E402

from db.supabase_client import service_client                # noqa: E402

from core import donor_fields as F                           # noqa: E402
from core import donor_share as S                            # noqa: E402

SRC = REPO_ROOT / "app_pages" / "donors.py"


def edited_columns() -> list[str]:
    """Every donor_intel column `_edit_dialog` writes, read out of its AST.

    THE ONE THING THE REACT FORM CANNOT BE ALLOWED TO QUIETLY LACK. A field missing from
    a form does not look like a bug — it looks like a donor nobody has filled in, and the
    completeness percentage agrees with that reading. So the Streamlit dialog's field set
    is extracted here and the React spec is compared against it, rather than both being
    maintained by hand and drifting.

    The dialog is parsed, never executed: it calls Streamlit at module scope.
    """
    import ast
    tree = ast.parse(SRC.read_text(encoding="utf-8"), filename=str(SRC))
    fn = next((n for n in ast.walk(tree)
               if isinstance(n, ast.FunctionDef) and n.name == "_edit_dialog"), None)
    if fn is None:
        raise SystemExit("_edit_dialog is gone from donors.py — this check needs rewriting")
    cols = set()
    for node in ast.walk(fn):
        if not isinstance(node, ast.Assign):
            continue
        for t in node.targets:
            if (isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name)
                    and t.value.id == "edited" and isinstance(t.slice, ast.Constant)):
                cols.add(t.slice.value)
    if not cols:
        raise SystemExit("found no edited[...] columns — the dialog's shape changed")
    return sorted(cols)



def _namespace(columns: list[str]) -> dict:
    """The helpers, plus the DERIVED half computed over the columns actually read.

    donor_fields.flag_groups() is the same classification the page applies to the
    dataframe it loaded. The completeness denominator comes out of it, so both sides have
    to agree about which live columns are flags before any percentage can agree.
    """
    flags, fit, _req, groups = F.flag_groups(columns)
    return {"_FLAGS": flags, "_FIT": fit, "_GROUPS": groups,
            "_label": F.label, "_normalize_category": F.normalize_category,
            "_to_list": F.to_list, "_disp": F.disp, "_pretty_choice": F.pretty_choice,
            "_title_name": F.title_name,
            "_summary_lines": lambda row: S.summary_lines(row, groups),
            "_completeness": lambda row: F.completeness(row, flags, fit)}


# Column names invented to exercise _label's rules without depending on what the live
# table happens to hold: an override, a bare-name override, prefix stripping, acronyms in
# first and later positions, and a name with no special case at all.
LABEL_PROBES = [
    "donor_type", "org_stage_required", "donor_ngo_eligible", "donor_lmic_africa_focus",
    "call_tb_focus", "org_mande_capacity", "donor_two_stage_application",
    "donor_hq_country_required", "some_unprefixed_column", "donor_us_govt_route",
    "donor_cv_required", "donor_irb_approval_needed", "a", "donor_",
]

# Category spellings: canonical, known aliases, the plural fold, whitespace and a
# trailing full stop, plus values that must pass through untouched.
CATEGORY_PROBES = [
    None, "", "   ", "Bilaterals", "bilateral", "MULTILATERALS", "dfi", "DFIs",
    "Foundations.", "  Private   Sector  ", "u.s. federal agencies", "US Federal Agencies",
    "foundation", "foundations", "Academic", "research institutions",
    "Something Nobody Has Ever Written", "philanthropy",
]

# Values for _to_list: JSON arrays, legacy delimited text, the "/" that must NOT split,
# and the blank spellings.
LIST_PROBES = [
    None, "", "nan", "None", "NaT", '["a","b"]', '[" a ", "", "b"]', "a; b; c",
    "a, b, c", "Procurement / contracts", "Grants; Loans / concessional finance",
    "[]", "{}", '"plain string"', "single", "a;;b", "  spaced  ,  out  ",
]

# Strings for _disp / _deshout: SHOUTED phrases, protected acronyms, the {country}
# placeholder retirement, and multi-sentence segments.
DISP_PROBES = [
    None, "", "nan", "NONE", "  ", "HEALTH SYSTEMS STRENGTHENING",
    "HIV AND TB PROGRAMS", "MNCH", "Normal sentence text.",
    "FIRST SENTENCE HERE. SECOND ONE TOO.", "Work in {country} today",
    "{country}'s health system", "support for {country}",
    "DR-TB AND NCDS", "R&D FUNDING", "A", "WASH", "UNICEF AND UNAIDS",
    "MIXED Case Text", "ALL CAPS; SEMICOLON SPLIT HERE",
]


# (have, total) pairs for the completeness percentage. HALF OF THEM ARE TIES, and they
# are constructed rather than observed because the live table currently contains none —
# a check run against today's rows alone cannot tell Python's round() from JS's
# Math.round, which is exactly the drift most likely to appear and least likely to be
# noticed. 12.5 must round DOWN to 12 and 37.5 UP to 38: half-to-even, not half-up.
ROUNDING_PROBES = [
    (1, 8), (3, 8), (5, 8), (7, 8),          # 12.5  37.5  62.5  87.5
    (1, 200), (3, 200), (1, 40), (5, 40),    # 0.5   1.5   2.5   12.5
    (1, 16), (9, 72), (0, 7), (7, 7),        # 6.25  12.5  0     100
    (1, 3), (2, 3), (1, 6), (5, 6), (17, 61), (43, 97),
]


# Funded-project records for `project_line`. THE AMOUNT IS THE POINT: Python formats it
# with `f"{float(amt):,.0f}"` — thousands separators, no decimals, half-to-even on the
# .5 — and a JS port reaching for toLocaleString or toFixed agrees on 1200 and disagrees
# on 1500.5, a bare string, or an amount that is not a number at all. The rest covers the
# optional segments: currency, the year/country/stage joins, description, link.
PROJECT_PROBES = [
    {"title": "Minimal"},
    {"title": "  Padded  ", "amount": 1200, "currency": "USD"},
    {"title": "No currency", "amount": 1234567.89},
    {"title": "Tie rounds even", "amount": 1500.5, "currency": "EUR"},
    {"title": "Tie rounds even 2", "amount": 2500.5},
    {"title": "Half below", "amount": 0.5},
    {"title": "Not a number", "amount": "about 3m", "currency": "GBP"},
    {"title": "Empty amount", "amount": "", "currency": "USD"},
    {"title": "Zero", "amount": 0},
    {"title": "Null amount", "amount": None, "year": 2024},
    {"title": "Segments", "year": 2023, "country": " Kenya ", "stage": "Stage 2"},
    {"title": "Everything", "amount": 50000, "currency": "USD", "year": "2022",
     "country": "Mali", "stage": "Pilot", "description": "  A pilot study.  ",
     "link": " https://example.org/x "},
    {"title": "Link only", "link": "https://example.org/y"},
    {"title": "Description only", "description": "Just prose."},
]

# Funding tiers for `tier_line` — the name is bolded, amount/duration join with a comma,
# notes become a trailing sentence. A tier with neither amount nor duration must not
# print a dangling em-dash.
TIER_PROBES = [
    {"name": "Seed"},
    {"name": "  Growth  ", "amount": "$50k–$250k"},
    {"name": "Scale", "duration": "24 months"},
    {"name": "Full", "amount": "$1m", "duration": "36 months", "notes": "  By invitation.  "},
    {"name": "Notes only", "notes": "Rolling."},
    {"name": "", "amount": "x"},
]

# Focal-person contacts for `contact_line`. The two formatting rules that matter are the
# TWO-SPACE hard break before the detail line and the `$` escape — Streamlit reads `$…$`
# as LaTeX, so an amount in a contact's note would render as maths. The share path undoes
# both; this pins the raw form so the undoing has something fixed to undo.
CONTACT_PROBES = [
    {},
    {"contact_name": "Ada Lovelace"},
    {"contact_name": "Ada Lovelace", "role_title": "Programme Officer", "is_official": True},
    {"contact_name": "Grace", "email": "grace@example.org", "phone": "+1 555 0100"},
    {"contact_name": "Linked", "linkedin_url": "https://linkedin.com/in/x"},
    {"contact_name": "Bare handle", "linkedin_url": "in/x"},
    {"contact_name": "Addressed", "address": "12 High St"},
    {"contact_name": "Noted", "notes": "Prefers email"},
    {"contact_name": "Money", "notes": "Budget $5,000 to $10,000"},
    {"contact_name": "SHOUTING PERSON", "role_title": "DIRECTOR OF PROGRAMS"},
    {"contact_name": "", "email": "anon@example.org"},
    {"contact_name": "Everything", "role_title": "Lead", "is_official": True,
     "email": "e@example.org", "phone": "+1 555", "linkedin_url": "https://x/y",
     "address": "Somewhere", "notes": "Note $1"},
]


# Whole donor rows, invented, for the parts of the summary the live table does not
# exercise. Each one pins a rule that was wrong or unpinned:
#
#   * the ratings TIE-BREAK is Python's string order on the raw key, so "IDs - HIV/AIDS"
#     precedes "IDs - Hepatitis" ('I' < 'e'). JS localeCompare collates the other way and
#     reordered a shared profile's priorities.
#   * `int(v)` TRUNCATES toward zero and does NOT clamp. A 7 left by a bad import reads
#     "7/5" and sorts first; React clamped it to 5 and buried it among the 5s.
#   * a priority area with no rating still prints, under a different bullet.
#   * an unparseable ratings blob falls back to {} rather than failing the section.
SUMMARY_ROW_PROBES = [
    # NOTE THE AREAS LIST ON EVERY RATED PROBE. The Scope & fit section is emitted only
    # when the row has priority AREAS or a scope pair — a donor carrying ratings and
    # nothing else prints no priorities at all, in either app. A probe without it is
    # inert and proves nothing about the sort.
    {"canonical_key": "probe_tiebreak", "donor": "Tie Break Trust",
     "donor_priority_areas": json.dumps(["IDs - Malaria"]),
     "donor_priority_ratings": json.dumps({
         "IDs - Hepatitis": 5, "IDs - HIV/AIDS": 5, "IDs - Malaria": 5,
         "Cross-cutting - Artificial Intelligence": 5})},
    {"canonical_key": "probe_range", "donor": "Out Of Range Fund",
     "donor_priority_areas": json.dumps(["IDs - Malaria"]),
     "donor_priority_ratings": json.dumps({
         "IDs - Malaria": 7, "IDs - TB": 0, "HSS - Health Financing": 3})},
    {"canonical_key": "probe_truncation", "donor": "Fractional Foundation",
     "donor_priority_areas": json.dumps(["IDs - Malaria"]),
     "donor_priority_ratings": json.dumps({
         "IDs - Malaria": 3.9, "IDs - TB": "4", "HSS - Health Financing": -2})},
    {"canonical_key": "probe_unrated", "donor": "Unrated Areas Fund",
     "donor_priority_areas": json.dumps(
         ["IDs - Malaria", "Cross-cutting - Artificial Intelligence", "GOV - Rule of Law"]),
     "donor_priority_ratings": json.dumps({"IDs - Malaria": 4})},
    {"canonical_key": "probe_badjson", "donor": "Broken Ratings Fund",
     "donor_priority_ratings": "{not json",
     "donor_priority_areas": json.dumps(["IDs - TB"])},
    {"canonical_key": "probe_notadict", "donor": "Wrong Shape Fund",
     "donor_priority_ratings": json.dumps([1, 2, 3]),
     "donor_priority_areas": json.dumps(["IDs - TB"])},
    {"canonical_key": "probe_unknown_prefix", "donor": "Unknown Prefix Fund",
     "donor_priority_areas": json.dumps(["IDs - TB"]),
     "donor_priority_ratings": json.dumps(
         {"ZZZ - Something": 4, "Bare key with no prefix": 3})},
    # Every section empty — the summary must still be a title and nothing else, not a
    # page of empty headings.
    {"canonical_key": "probe_empty", "donor": "Empty Fund"},
    {"canonical_key": "probe_tiers_projects", "donor": "Tiers And Projects Fund",
     "donor_funding_tiers_json": json.dumps(
         [{"name": "Seed", "amount": "$10k"}, {"amount": "no name"},
          {"name": "Scale", "duration": "2y", "notes": "Invite only"}]),
     "donor_past_projects_json": json.dumps(
         [{"title": "Named", "amount": 2500.5, "currency": "USD", "year": 2024},
          {"amount": 10, "description": "no title, dropped"},
          {"title": "Bare"}])},
]


def main() -> None:
    sys.stdin.read()
    sb = service_client()
    # A bounded sample, ordered so the set is stable between the two halves of a run.
    rows = (sb.table("donor_intel").select("*")
            .order("canonical_key").limit(400).execute().data) or []
    columns: list[str] = []
    seen = set()
    for r in rows:
        for k in r:
            if k not in seen:
                seen.add(k)
                columns.append(k)
    ns = _namespace(columns)

    completeness = []
    for r in rows:
        pct, have, total = ns["_completeness"](r)
        completeness.append({
            "canonical_key": r.get("canonical_key"),
            "pct": pct, "have": have, "total": total,
            "title": ns["_title_name"](r),
            "category_clean": ns["_normalize_category"](r.get("donor_category")),
        })

    print(json.dumps({
        "columns": columns,
        "rows": rows,
        "labels": {c: ns["_label"](c) for c in LABEL_PROBES},
        "categories": [{"raw": c, "out": ns["_normalize_category"](c)}
                       for c in CATEGORY_PROBES],
        "lists": [{"raw": v, "out": ns["_to_list"](v)} for v in LIST_PROBES],
        "disp": [{"raw": v, "out": ns["_disp"](v)} for v in DISP_PROBES],
        "pretty": [{"raw": v, "out": ns["_pretty_choice"](v)}
                   for v in [None, "", "high", "reimbursement_only", "NOT_SURE", "a_b_c"]],
        "completeness": completeness,
        # The bare rounding rule, from the same expression _completeness uses.
        "rounding": [{"have": h, "total": t, "pct": round(100 * h / t)}
                     for h, t in ROUNDING_PROBES],
        # The derived half, emitted so a denominator mismatch is reported as what it is
        # rather than as every donor's percentage being wrong at once.
        "editedColumns": edited_columns(),
        "flags": ns["_FLAGS"],
        "fit": ns["_FIT"],
        "groups": ns["_GROUPS"],
        # THE SHARE DOCUMENT, line by line, over every live row. It is the only donor
        # output that leaves the product — somebody pastes it into an email or sends the
        # PDF to a colleague — so a section the React half drops or reorders is read by
        # the recipient and by nobody who could notice.
        "summary": [{"canonical_key": r.get("canonical_key"),
                     "lines": ns["_summary_lines"](r)} for r in rows],
        # The same function over INVENTED rows, for the rules no live donor exercises.
        "summaryProbes": [{"row": r, "lines": ns["_summary_lines"](r)}
                          for r in SUMMARY_ROW_PROBES],
        "projectLines": [{"rec": p, "out": S.project_line(p)} for p in PROJECT_PROBES],
        "tierLines": [{"rec": t, "out": S.tier_line(t)} for t in TIER_PROBES],
        "contactLines": [{"rec": c, "out": S.contact_line(c)} for c in CONTACT_PROBES],
        "shareFilenames": [
            {"row": r, "pdf": S.share_filename(r, "pdf"), "md": S.share_filename(r, "md")}
            for r in ({"donor_short": "GATES", "donor": "Gates Foundation"},
                      {"donor": "Open  Society Foundations"},
                      {"donor_short": "", "donor": "Wellcome Trust"},
                      {"donor_short": "  BMZ  "},
                      {})],
        # The whole share document for one real donor, contacts included, flattened the
        # way the dialog flattens it.
        "shareMarkdown": ([
            {"canonical_key": rows[0].get("canonical_key"),
             "md": S.share_markdown(rows[0], ns["_GROUPS"], CONTACT_PROBES)}
        ] if rows else []),
    }, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
