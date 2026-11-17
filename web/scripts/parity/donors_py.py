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
    flags, fit, _req, _groups = F.flag_groups(columns)
    return {"_FLAGS": flags, "_FIT": fit,
            "_label": F.label, "_normalize_category": F.normalize_category,
            "_to_list": F.to_list, "_disp": F.disp, "_pretty_choice": F.pretty_choice,
            "_title_name": F.title_name,
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
    }, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
