"""Emit supabase/functions/_shared/api/donor_vocab.ts from the Python that owns the form.

`app_pages/donors.py` CANNOT BE IMPORTED — it calls Streamlit at module scope and reads
the live `donor_intel` table into a dataframe before it defines anything. So the constants
are lifted out of its AST and literal-eval'd, never executed. Same technique as the other
generators here, for the same reason: the alternative is a hand-copied vocabulary, and a
hand-copied vocabulary drifts.

WHY THIS FILE IS GENERATED, AND WHAT IT DELIBERATELY LEAVES OUT.

The donor edit form does not have a field list. It has a field *classification*: every
column of `donor_intel` that is not named in one of the text/contact/profile/meta sets is
a FLAG, and flags are then split into legal-registration, program-area-fit and
requirements. That rule lives at `donors.py:448`:

    _FLAGS = [c for c in df.columns if c not in _NON_FLAG]

Read it the other way round and the consequence is clear: **a migration that adds a column
to donor_intel adds a flag to the form, with no code change anywhere.** That is the design,
and it is why the classification sets are the thing worth pinning and the flag list is not.

So this file emits the REPO CONSTANTS — the sets that say what is *not* a flag, the
dropdown vocabularies, the tri-state map, the label overrides — and nothing that depends on
the live table. `donorFlagGroups()` in donor_edit.ts computes _FLAGS/_FIT/_REQ from the
columns the route actually read, exactly as the Python computes them from the dataframe it
actually loaded. Same split as org_vocab.ts and form_vocab.ts: repo constant here,
per-deployment data there.

THE TRI-STATE MAP IS THE SHARP EDGE. A requirement has FOUR states and blank is not Not
Sure: blank means nobody answered, "not_sure" means somebody looked and could not tell.
They score identically (`core.criteria_derive._truthy` activates only on yes/required) but
they are not the same fact, and completeness counts one and not the other. Copy the map
wrong in either direction and the form either invents answers nobody gave or discards
answers somebody did.

    python scripts/gen_donor_vocab.py          # rewrites the .ts in place

Re-run it whenever the classification sets, the dropdown vocabularies, the label overrides
or the tri-state map change in donors.py. `tests/test_donor_vocab_is_current.py`
re-generates and compares, so a stale table fails a test instead of quietly mis-rendering
somebody's donor record.
"""
from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

SRC = ROOT / "app_pages/donors.py"
OUT = ROOT / "supabase/functions/_shared/api/donor_vocab.ts"
# The browser does not import the Edge Function's modules — the two runtimes are
# separate bundles — so the same lifted constants are emitted a second time as JSON,
# the way web/src/generated/vocab.json already serves donors/vocab.ts. One source,
# two emissions, because the alternative is the hand-copied copy this replaces.
OUT_WEB = ROOT / "web/src/generated/donor_vocab.json"

# Every name here must be a PURE LITERAL in donors.py. A name whose value is computed —
# _FLAGS, _FIT, _REQ, _FLAG_GROUPS (the live columns), _YEAR_OPTIONS (today's date),
# _HQ_COUNTRY_OPTIONS and _PARTNER_OPTIONS (other modules and the live table) — is
# deliberately absent: those are derived at request time from data this file cannot see.
WANTED = [
    "_META", "_SHORT_TEXT", "_LONG_TEXT", "_CONTACT", "_CHOICE", "_PROFILE",
    "_HIDDEN_FIELDS", "_ELIG", "_ACR", "_LABEL_OVERRIDES", "_PARTNER_TYPE_OPTIONS",
    "FUNDING_MECHANISMS", "ROUTE_STATUSES", "LOCAL_ORG_ELIGIBLE", "FUNDING_CYCLES",
    "APPLICATION_PROCESSES", "REPORTING_REQUIREMENTS", "_OTHER", "_TRISTATE_GROUPS",
    "_TRISTATE_OPTS", "_TRISTATE_TO_VAL", "_VAL_TO_TRISTATE", "_LIST_FIELDS",
    "_COMPLETENESS_TEXT", "_COMPLETENESS_JSON", "_CATEGORIES", "_CATEGORY_CANON",
    "_ACRONYMS", "_CONTACT_COLS",
]


def lift() -> dict:
    """Literal-eval the wanted module-level assignments without running the module."""
    tree = ast.parse(SRC.read_text(encoding="utf-8"), filename=str(SRC))
    found: dict = {}
    for node in tree.body:                      # module level only — not ast.walk
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        for t in targets:
            if not isinstance(t, ast.Name) or t.id not in WANTED:
                continue
            if node.value is None:
                continue
            try:
                found[t.id] = ast.literal_eval(node.value)
            except ValueError:
                # Computed, not literal. Loud, because silently skipping one would ship a
                # vocabulary that is missing a field rather than one that is wrong.
                raise SystemExit(
                    f"{t.id} is not a literal in {SRC.name} — it is computed at import "
                    f"time. Either it moved, or it now depends on live data and belongs "
                    f"in donor_edit.ts instead of here.")
    missing = [n for n in WANTED if n not in found]
    if missing:
        raise SystemExit(f"not found in {SRC.name}: {', '.join(missing)}")
    return found


def js(value) -> str:
    """JSON, with sets flattened to sorted lists so the output is byte-stable."""
    if isinstance(value, (set, frozenset)):
        value = sorted(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def main() -> None:
    v = lift()
    body = f'''// GENERATED by scripts/gen_donor_vocab.py — do not edit by hand.
//
// The donor edit form's vocabulary, lifted from app_pages/donors.py, which cannot be
// imported (Streamlit at module scope). Re-run the generator after changing any of these
// in the Python; tests/test_donor_vocab_is_current.py fails if this file is stale.
//
// WHAT IS NOT HERE: the flag list. donor_intel's columns decide which fields are flags —
// anything not named in the sets below IS one — so a migration adds a form field with no
// code change. donorFlagGroups() in donor_edit.ts derives that from the live columns, the
// same way donors.py derives it from the dataframe it loaded.

/** Columns that never reach the form: ids, timestamps, derived display values. */
export const META: string[] = {js(v["_META"])};

/** Single-line free text. */
export const SHORT_TEXT: string[] = {js(v["_SHORT_TEXT"])};

/** Multi-line free text. */
export const LONG_TEXT: string[] = {js(v["_LONG_TEXT"])};

/**
 * The donor's OWN institutional contact details — one set, on the donor_intel row.
 * The many focal persons live in the `donor_contacts` table and are not these.
 */
export const CONTACT: string[] = {js(v["_CONTACT"])};

/** Columns on the donor_contacts table (focal persons), in form order. */
export const CONTACT_COLS: string[] = {js(v["_CONTACT_COLS"])};

/** Fixed enums. The leading "" is the unset option and must stay first. */
export const CHOICE: Record<string, string[]> = {js(v["_CHOICE"])};

/** Qualitative profile + hard eligibility conditions: VALUED text, never flags. */
export const PROFILE: string[] = {js(v["_PROFILE"])};

/**
 * Kept in the schema, surfaced nowhere. Not edited, not viewed, not exported.
 * verification_level already carries data confidence, and funded_geographies is dead
 * (the live geo field is donor_geographic_scope).
 */
export const HIDDEN_FIELDS: string[] = {js(v["_HIDDEN_FIELDS"])};

/**
 * The legal/registration flags, named explicitly because they are a GROUP, not a
 * pattern — unlike *_fit, which is matched by suffix. A flag in neither set is a
 * requirement.
 */
export const ELIG: string[] = {js(v["_ELIG"])};

/** Acronyms that must stay uppercase when a column name becomes a label. */
export const ACR: Record<string, string> = {js(v["_ACR"])};

/**
 * Labels that the column name cannot produce.
 *
 * Mostly these fix a reading that is not merely ugly but WRONG. "Donor tax exempt status
 * required" sounds like the donor's own status; it means the donor requires tax-exempt
 * status from the applicant. The donor_/call_/org_ prefix is an auditable schema
 * decision and is stripped for display only.
 */
export const LABEL_OVERRIDES: Record<string, string> = {js(v["_LABEL_OVERRIDES"])};

/** Shared with the org fit profile, so a required partner type matches an org's records. */
export const PARTNER_TYPE_OPTIONS: string[] = {js(v["_PARTNER_TYPE_OPTIONS"])};

export const FUNDING_MECHANISMS: string[] = {js(v["FUNDING_MECHANISMS"])};
export const ROUTE_STATUSES: string[] = {js(v["ROUTE_STATUSES"])};
export const LOCAL_ORG_ELIGIBLE: string[] = {js(v["LOCAL_ORG_ELIGIBLE"])};
export const FUNDING_CYCLES: string[] = {js(v["FUNDING_CYCLES"])};
export const APPLICATION_PROCESSES: string[] = {js(v["APPLICATION_PROCESSES"])};
export const REPORTING_REQUIREMENTS: string[] = {js(v["REPORTING_REQUIREMENTS"])};

/** The escape hatch on every single-choice dropdown. */
export const OTHER = {js(v["_OTHER"])};

/**
 * A REQUIREMENT HAS FOUR STATES, AND BLANK IS NOT "NOT SURE".
 *
 *   blank      nobody has answered — missing data, counts against completeness
 *   yes        required        no        not required        not_sure   looked, can't tell
 *
 * The three explicit answers all mean a human or an extractor engaged with the question,
 * so they count as documented; only blank is missing. An untouched field defaults to
 * BLANK, never Not Sure — otherwise missing data would read as answered.
 *
 * Scoring treats them identically: core.criteria_derive._truthy activates only on
 * "yes"/"required", so "no", "not_sure" and blank all read as Not Required. That is why
 * the distinction survives only here and in completeness, and why getting the map wrong
 * is invisible until somebody asks how complete a record is.
 */
export const TRISTATE_GROUPS: string[] = {js(v["_TRISTATE_GROUPS"])};
export const TRISTATE_OPTS: string[] = {js(v["_TRISTATE_OPTS"])};
export const TRISTATE_TO_VAL: Record<string, string | null> = {js(v["_TRISTATE_TO_VAL"])};
export const VAL_TO_TRISTATE: Record<string, string> = {js(v["_VAL_TO_TRISTATE"])};

/** Stored as JSON lists; rendered as comma lists in share and export. */
export const LIST_FIELDS: string[] = {js(v["_LIST_FIELDS"])};

/** Every donor-facing field that counts toward the completeness score. */
export const COMPLETENESS_TEXT: string[] = {js(v["_COMPLETENESS_TEXT"])};
export const COMPLETENESS_JSON: string[] = {js(v["_COMPLETENESS_JSON"])};

/** The category vocabulary, and every spelling seen in the wild that maps into it. */
export const CATEGORIES: string[] = {js(v["_CATEGORIES"])};
export const CATEGORY_CANON: Record<string, string> = {js(v["_CATEGORY_CANON"])};

/** Acronyms that must survive de-SHOUTING a workbook phrase. */
export const ACRONYMS: string[] = {js(v["_ACRONYMS"])};
'''
    OUT.write_text(body, encoding="utf-8")

    def plain(value):
        return sorted(value) if isinstance(value, (set, frozenset)) else value

    web = {
        "meta": plain(v["_META"]), "shortText": plain(v["_SHORT_TEXT"]),
        "longText": plain(v["_LONG_TEXT"]), "contact": plain(v["_CONTACT"]),
        "contactCols": plain(v["_CONTACT_COLS"]), "choice": plain(v["_CHOICE"]),
        "profile": plain(v["_PROFILE"]), "hidden": plain(v["_HIDDEN_FIELDS"]),
        "elig": plain(v["_ELIG"]), "acr": plain(v["_ACR"]),
        "labelOverrides": plain(v["_LABEL_OVERRIDES"]),
        "partnerTypeOptions": plain(v["_PARTNER_TYPE_OPTIONS"]),
        "fundingMechanisms": plain(v["FUNDING_MECHANISMS"]),
        "routeStatuses": plain(v["ROUTE_STATUSES"]),
        "localOrgEligible": plain(v["LOCAL_ORG_ELIGIBLE"]),
        "fundingCycles": plain(v["FUNDING_CYCLES"]),
        "applicationProcesses": plain(v["APPLICATION_PROCESSES"]),
        "reportingRequirements": plain(v["REPORTING_REQUIREMENTS"]),
        "other": v["_OTHER"],
        "tristateGroups": plain(v["_TRISTATE_GROUPS"]),
        "tristateOpts": plain(v["_TRISTATE_OPTS"]),
        "tristateToVal": plain(v["_TRISTATE_TO_VAL"]),
        "valToTristate": plain(v["_VAL_TO_TRISTATE"]),
        "listFields": plain(v["_LIST_FIELDS"]),
        "completenessText": plain(v["_COMPLETENESS_TEXT"]),
        "completenessJson": plain(v["_COMPLETENESS_JSON"]),
        "categories": plain(v["_CATEGORIES"]),
        "categoryCanon": plain(v["_CATEGORY_CANON"]),
        "acronyms": plain(v["_ACRONYMS"]),
    }
    OUT_WEB.parent.mkdir(parents=True, exist_ok=True)
    OUT_WEB.write_text(json.dumps(web, indent=1, ensure_ascii=False, sort_keys=True) + "\n",
                       encoding="utf-8")

    print(f"wrote {OUT.relative_to(ROOT)} and {OUT_WEB.relative_to(ROOT)}: "
          f"{len(v['_ELIG'])} legal flags, {len(v['_PROFILE'])} profile fields, "
          f"{len(v['_LABEL_OVERRIDES'])} label overrides, "
          f"{len(v['_COMPLETENESS_TEXT'])} completeness fields")


if __name__ == "__main__":
    main()
