"""Emit supabase/functions/_shared/api/donor_vocab.ts from the Python that owns the form.

The source is `core/donor_fields.py`, which is an ordinary importable module. It used to be
`app_pages/donors.py`, which is not — it calls Streamlit at module scope and reads the live
`donor_intel` table before defining anything — so this generator parsed the page's AST and
literal-eval'd the constants out of it. Moving them to core removed the need for that, and
with it the generator's second opinion about what the page meant.

WHY THIS FILE IS GENERATED, AND WHAT IT DELIBERATELY LEAVES OUT.

The donor edit form does not have a field list. It has a field *classification*: every
column of `donor_intel` that is not named in one of the text/contact/profile/meta sets is
a FLAG, and flags are then split into legal-registration, program-area-fit and
requirements. That rule is `donor_fields.flag_groups()`:

    flags = [c for c in columns if c not in NON_FLAG]

Read it the other way round and the consequence is clear: **a migration that adds a column
to donor_intel adds a flag to the form, with no code change anywhere.** That is the design,
and it is why the classification sets are the thing worth pinning and the flag list is not.

So this file emits the REPO CONSTANTS — the sets that say what is *not* a flag, the
dropdown vocabularies, the tri-state map, the label overrides — and nothing that depends on
the live table. Each consumer calls its own `flag_groups` over the columns it actually
read, exactly as the page does over the dataframe it actually loaded. Same split as
org_vocab.ts and form_vocab.ts: repo constant here, per-deployment data there.

THE TRI-STATE MAP IS THE SHARP EDGE. A requirement has FOUR states and blank is not Not
Sure: blank means nobody answered, "not_sure" means somebody looked and could not tell.
They score identically (`core.criteria_derive._truthy` activates only on yes/required) but
they are not the same fact, and completeness counts one and not the other. Copy the map
wrong in either direction and the form either invents answers nobody gave or discards
answers somebody did.

    python scripts/gen_donor_vocab.py          # rewrites the .ts in place

Re-run it whenever the classification sets, the dropdown vocabularies, the label overrides
or the tri-state map change in `core/donor_fields.py`.
`tests/test_donor_vocab_is_current.py` re-reads them and compares, so a stale table fails
a test instead of quietly mis-rendering somebody's donor record.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import donor_fields as fields          # noqa: E402

OUT = ROOT / "supabase/functions/_shared/api/donor_vocab.ts"
# The browser does not import the Edge Function's modules — the two runtimes are
# separate bundles — so the same lifted constants are emitted a second time as JSON,
# the way web/src/generated/vocab.json already serves donors/vocab.ts. One source,
# two emissions, because the alternative is the hand-copied copy this replaces.
OUT_WEB = ROOT / "web/src/generated/donor_vocab.json"

# Every name here is a repo CONSTANT. Anything derived is deliberately absent: the flag
# lists come from donor_fields.flag_groups() over the live columns, and the year and
# partner dropdowns from today's date and the live donor list. Emitting any of those
# would freeze one deployment's data into the repo and stop a migration from adding a
# form field. tests/test_donor_vocab_is_current.py pins that exclusion.
WANTED = [
    "META", "SHORT_TEXT", "LONG_TEXT", "CONTACT", "CHOICE", "CONDITION_CHOICE", "PROFILE",
    "HIDDEN_FIELDS", "ELIG", "ACR", "LABEL_OVERRIDES", "PARTNER_TYPE_OPTIONS",
    "FUNDING_MECHANISMS", "ROUTE_STATUSES", "LOCAL_ORG_ELIGIBLE", "FUNDING_CYCLES",
    "APPLICATION_PROCESSES", "REPORTING_REQUIREMENTS", "OTHER", "TRISTATE_GROUPS",
    "TRISTATE_OPTS", "TRISTATE_TO_VAL", "VAL_TO_TRISTATE", "LIST_FIELDS",
    "COMPLETENESS_TEXT", "COMPLETENESS_JSON", "CATEGORIES", "CATEGORY_CANON",
    "ACRONYMS", "CONTACT_COLS",
]


def lift() -> dict:
    """Read the wanted constants off core.donor_fields.

    THIS USED TO PARSE donors.py's AST, because the vocabulary lived inside a Streamlit
    page that cannot be imported. It now lives in core/donor_fields.py — a plain module
    with no Streamlit and no database — so the values come from an ordinary import, and
    the generator no longer has a second opinion about what donors.py means.

    A name that disappears from the module raises here rather than being skipped:
    silently dropping one would ship a vocabulary that is missing a field, which does not
    remove a form field but INVENTS one (the classification is negative).
    """
    missing = [n for n in WANTED if not hasattr(fields, n)]
    if missing:
        raise SystemExit(
            f"not found in core/donor_fields.py: {', '.join(missing)}. Either they were "
            f"renamed, or they moved somewhere this generator cannot see.")
    return {n: getattr(fields, n) for n in WANTED}


def js(value) -> str:
    """JSON, with sets flattened to sorted lists so the output is byte-stable."""
    if isinstance(value, (set, frozenset)):
        value = sorted(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def main() -> None:
    v = lift()
    body = f'''// GENERATED by scripts/gen_donor_vocab.py — do not edit by hand.
//
// The donor edit form's vocabulary, from core/donor_fields.py — which is also what
// app_pages/donors.py uses, so this is the same vocabulary Streamlit renders rather than
// a copy of it. Re-run the generator after changing any of these in the Python;
// tests/test_donor_vocab_is_current.py fails if this file is stale.
//
// WHAT IS NOT HERE: the flag list. donor_intel's columns decide which fields are flags —
// anything not named in the sets below IS one — so a migration adds a form field with no
// code change. donorFlagGroups() in donor_edit.ts derives that from the live columns, the
// same way donors.py derives it from the dataframe it loaded.

/** Columns that never reach the form: ids, timestamps, derived display values. */
export const META: string[] = {js(v["META"])};

/** Single-line free text. */
export const SHORT_TEXT: string[] = {js(v["SHORT_TEXT"])};

/** Multi-line free text. */
export const LONG_TEXT: string[] = {js(v["LONG_TEXT"])};

/**
 * The donor's OWN institutional contact details — one set, on the donor_intel row.
 * The many focal persons live in the `donor_contacts` table and are not these.
 */
export const CONTACT: string[] = {js(v["CONTACT"])};

/** Columns on the donor_contacts table (focal persons), in form order. */
export const CONTACT_COLS: string[] = {js(v["CONTACT_COLS"])};

/** Fixed enums. The leading "" is the unset option and must stay first. */
export const CHOICE: Record<string, string[]> = {js(v["CHOICE"])};

/**
 * The hard-eligibility enums. THE STORED VALUE IS THE KEY, not a label:
 * core.criteria_derive matches "grassroot_local" and "ineligible_current" exactly, so a
 * form that stored a prettified label would satisfy no rule and fail no rule — which
 * reads as a donor with no eligibility conditions at all.
 */
export const CONDITION_CHOICE: Record<string, string[]> = {js(v["CONDITION_CHOICE"])};

/** Qualitative profile + hard eligibility conditions: VALUED text, never flags. */
export const PROFILE: string[] = {js(v["PROFILE"])};

/**
 * Kept in the schema, surfaced nowhere. Not edited, not viewed, not exported.
 * verification_level already carries data confidence, and funded_geographies is dead
 * (the live geo field is donor_geographic_scope).
 */
export const HIDDEN_FIELDS: string[] = {js(v["HIDDEN_FIELDS"])};

/**
 * The legal/registration flags, named explicitly because they are a GROUP, not a
 * pattern — unlike *_fit, which is matched by suffix. A flag in neither set is a
 * requirement.
 */
export const ELIG: string[] = {js(v["ELIG"])};

/** Acronyms that must stay uppercase when a column name becomes a label. */
export const ACR: Record<string, string> = {js(v["ACR"])};

/**
 * Labels that the column name cannot produce.
 *
 * Mostly these fix a reading that is not merely ugly but WRONG. "Donor tax exempt status
 * required" sounds like the donor's own status; it means the donor requires tax-exempt
 * status from the applicant. The donor_/call_/org_ prefix is an auditable schema
 * decision and is stripped for display only.
 */
export const LABEL_OVERRIDES: Record<string, string> = {js(v["LABEL_OVERRIDES"])};

/** Shared with the org fit profile, so a required partner type matches an org's records. */
export const PARTNER_TYPE_OPTIONS: string[] = {js(v["PARTNER_TYPE_OPTIONS"])};

export const FUNDING_MECHANISMS: string[] = {js(v["FUNDING_MECHANISMS"])};
export const ROUTE_STATUSES: string[] = {js(v["ROUTE_STATUSES"])};
export const LOCAL_ORG_ELIGIBLE: string[] = {js(v["LOCAL_ORG_ELIGIBLE"])};
export const FUNDING_CYCLES: string[] = {js(v["FUNDING_CYCLES"])};
export const APPLICATION_PROCESSES: string[] = {js(v["APPLICATION_PROCESSES"])};
export const REPORTING_REQUIREMENTS: string[] = {js(v["REPORTING_REQUIREMENTS"])};

/** The escape hatch on every single-choice dropdown. */
export const OTHER = {js(v["OTHER"])};

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
export const TRISTATE_GROUPS: string[] = {js(v["TRISTATE_GROUPS"])};
export const TRISTATE_OPTS: string[] = {js(v["TRISTATE_OPTS"])};
export const TRISTATE_TO_VAL: Record<string, string | null> = {js(v["TRISTATE_TO_VAL"])};
export const VAL_TO_TRISTATE: Record<string, string> = {js(v["VAL_TO_TRISTATE"])};

/** Stored as JSON lists; rendered as comma lists in share and export. */
export const LIST_FIELDS: string[] = {js(v["LIST_FIELDS"])};

/** Every donor-facing field that counts toward the completeness score. */
export const COMPLETENESS_TEXT: string[] = {js(v["COMPLETENESS_TEXT"])};
export const COMPLETENESS_JSON: string[] = {js(v["COMPLETENESS_JSON"])};

/** The category vocabulary, and every spelling seen in the wild that maps into it. */
export const CATEGORIES: string[] = {js(v["CATEGORIES"])};
export const CATEGORY_CANON: Record<string, string> = {js(v["CATEGORY_CANON"])};

/** Acronyms that must survive de-SHOUTING a workbook phrase. */
export const ACRONYMS: string[] = {js(v["ACRONYMS"])};
'''
    OUT.write_text(body, encoding="utf-8")

    def plain(value):
        return sorted(value) if isinstance(value, (set, frozenset)) else value

    web = {
        "meta": plain(v["META"]), "shortText": plain(v["SHORT_TEXT"]),
        "longText": plain(v["LONG_TEXT"]), "contact": plain(v["CONTACT"]),
        "contactCols": plain(v["CONTACT_COLS"]), "choice": plain(v["CHOICE"]),
        "conditionChoice": plain(v["CONDITION_CHOICE"]),
        "profile": plain(v["PROFILE"]), "hidden": plain(v["HIDDEN_FIELDS"]),
        "elig": plain(v["ELIG"]), "acr": plain(v["ACR"]),
        "labelOverrides": plain(v["LABEL_OVERRIDES"]),
        "partnerTypeOptions": plain(v["PARTNER_TYPE_OPTIONS"]),
        "fundingMechanisms": plain(v["FUNDING_MECHANISMS"]),
        "routeStatuses": plain(v["ROUTE_STATUSES"]),
        "localOrgEligible": plain(v["LOCAL_ORG_ELIGIBLE"]),
        "fundingCycles": plain(v["FUNDING_CYCLES"]),
        "applicationProcesses": plain(v["APPLICATION_PROCESSES"]),
        "reportingRequirements": plain(v["REPORTING_REQUIREMENTS"]),
        "other": v["OTHER"],
        "tristateGroups": plain(v["TRISTATE_GROUPS"]),
        "tristateOpts": plain(v["TRISTATE_OPTS"]),
        "tristateToVal": plain(v["TRISTATE_TO_VAL"]),
        "valToTristate": plain(v["VAL_TO_TRISTATE"]),
        "listFields": plain(v["LIST_FIELDS"]),
        "completenessText": plain(v["COMPLETENESS_TEXT"]),
        "completenessJson": plain(v["COMPLETENESS_JSON"]),
        "categories": plain(v["CATEGORIES"]),
        "categoryCanon": plain(v["CATEGORY_CANON"]),
        "acronyms": plain(v["ACRONYMS"]),
    }
    OUT_WEB.parent.mkdir(parents=True, exist_ok=True)
    OUT_WEB.write_text(json.dumps(web, indent=1, ensure_ascii=False, sort_keys=True) + "\n",
                       encoding="utf-8")

    print(f"wrote {OUT.relative_to(ROOT)} and {OUT_WEB.relative_to(ROOT)}: "
          f"{len(v['ELIG'])} legal flags, {len(v['PROFILE'])} profile fields, "
          f"{len(v['LABEL_OVERRIDES'])} label overrides, "
          f"{len(v['COMPLETENESS_TEXT'])} completeness fields")


if __name__ == "__main__":
    main()
