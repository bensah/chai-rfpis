"""Emit supabase/functions/_shared/api/org_vocab.ts from the Python that owns the tables.

The My Organization page is a READ-ONLY view of two JSON blobs on the `tenants` row:
`org_identity` and `org_profile`. Neither is self-describing — what the page shows is the
blob MERGED ONTO A DEFAULT, with legacy keys renamed on the way in — so the defaults and
the rename map are not decoration, they decide what a reader is told about their own
organisation.

WHY THESE ARE GENERATED AND NOT HAND-WRITTEN, which is the same argument gen_form_vocab.py
makes for the dropdowns:

  * `DEFAULT_PROFILE` is forty-odd keys with meaningful defaults — `org_legal_type` is
    "nonprofit", `org_funding_routes` is ["grant", "subrecipient"], `proposal_languages`
    is ["English"]. A tenant that has never opened the editor is shown ALL of these, and
    the scoring engine reads the same merged dict. A TypeScript copy that fell behind
    would show one organisation's profile to another's rules.
  * `_RENAMED_KEYS` is how a profile saved before 2026 is still read. Miss one and a
    field that IS set reads as empty — the completeness bar drops, the page says
    "not yet screening-ready", and nothing on screen explains why.
  * `_ORG_DEFAULTS` is `core/settings.get_org`'s placeholder set, which exists so the
    header never renders blank. The page shows them as values, so they have to match.

WHAT IS DELIBERATELY NOT HERE: anything per-deployment. These are repo constants — the
same for every tenant — while the VALUES they are merged with are read live from the
tenant's own row. Same split as form_vocab.ts, for the same reason.

    python scripts/gen_org_vocab.py          # rewrites the .ts in place

Re-run it whenever DEFAULT_PROFILE, _RENAMED_KEYS, the legal/entity-type labels,
RATING_WORD or _ORG_DEFAULTS change. `tests/test_org_vocab_is_current.py` re-generates and
compares, so a stale table fails a test rather than silently misreading a profile.
"""
from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import org_profile as op                  # noqa: E402
from core import settings as st                     # noqa: E402
from core.criteria_derive import ROUTE_OPTIONS      # noqa: E402
from core.partners import DONOR_PORTALS, clean_portal_url  # noqa: E402
from core.program_area_classifier import CATEGORY_FULL   # noqa: E402
from core.program_area_select import RATING_WORD         # noqa: E402

OUT = ROOT / "supabase/functions/_shared/api/org_vocab.ts"
EDITOR = ROOT / "views/org_setup.py"


def js(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def portal_seed() -> list[str]:
    """DONOR_PORTALS reduced to bare hosts, exactly as the editor does it.

    `clean_portal_url` is what makes "https://www.grants.gov/search" and "grants.gov" the
    same entry, so the seed is cleaned HERE rather than in TypeScript: a second
    implementation of that normalisation would offer the same portal twice.
    """
    return sorted({p for p in map(clean_portal_url, DONOR_PORTALS) if p and "." in p})


def lifted(name: str, *, last: bool = False):
    """A literal assigned to `name` anywhere in views/org_setup.py.

    The editor's option lists are written INSIDE `render_org_setup`, so the module cannot
    be imported for them — it pulls in streamlit and runs widgets at import time. They are
    lifted from the syntax tree instead, which is the same trick the parity harnesses use
    on the other view files, and for the stronger reason here: these lists are not
    decoration. `_board_opts` maps three labels onto the three STORED values of
    `org_has_local_board`, and the middle one ("") is what turns the MUST-4 donor gate
    OFF. A retyped copy that lost a key, or reordered the dict so a different label
    carried "", would change which organisations a donor disqualifies — silently, because
    both apps would still render three plausible choices.

    `last=True` takes the final assignment: `_entity_opts` is written twice, once per
    branch of the legal-type rule, and the second is the general case (see ENTITY_TYPES).
    """
    tree = ast.parse(EDITOR.read_text(encoding="utf-8"))
    found = [n.value for n in ast.walk(tree)
             if isinstance(n, ast.Assign)
             for t in n.targets if isinstance(t, ast.Name) and t.id == name]
    if not found:
        raise SystemExit(f"{name} is no longer assigned in {EDITOR.name} — the editor was "
                         "restructured, so this table would ship a value nothing renders.")
    return ast.literal_eval(found[-1 if last else 0])


def main() -> None:
    body = f'''/**
 * The My Organization page's constant tables. GENERATED — do not edit.
 *
 *     python scripts/gen_org_vocab.py
 *
 * Source of truth: core/org_profile.py for the profile defaults, the rename map and the
 * legal/entity-type labels; core/settings.py for the identity placeholders;
 * core/program_area_select.py for the rating words. See scripts/gen_org_vocab.py for why
 * these are generated rather than retyped.
 */

/**
 * core/org_profile.DEFAULT_PROFILE — what a tenant's stored profile is merged ONTO.
 *
 * A tenant that has never opened the editor is shown all of this, and the scoring engine
 * reads the same merged dict, so a stale copy here would describe one organisation by
 * another's defaults.
 */
export const DEFAULT_PROFILE: Record<string, unknown> = {js(op.DEFAULT_PROFILE)};

/** core/org_profile.PROFILE_FIELDS — the key order, for stable iteration. */
export const PROFILE_FIELDS: string[] = {js(list(op.PROFILE_FIELDS))};

/**
 * core/org_profile._RENAMED_KEYS — legacy key -> current key.
 *
 * How a profile saved before the 2026 renames is still read. Applied only when the NEW
 * key is absent, so a profile carrying both keeps the new one.
 */
export const RENAMED_KEYS: Record<string, string> = {js(op._RENAMED_KEYS)};

/** core/org_profile.LEGAL_TYPE_LABELS — stored code -> what the page shows. */
export const LEGAL_TYPE_LABELS: Record<string, string> = {js(op.LEGAL_TYPE_LABELS)};

/** core/org_profile.ENTITY_TYPE_LABELS — MUST-1 item B, "" meaning not specified. */
export const ENTITY_TYPE_LABELS: Record<string, string> = {js(op.ENTITY_TYPE_LABELS)};

/** core/org_profile.LIST_FIELDS — the profile keys stored as a list of strings. */
export const LIST_FIELDS: string[] = {js(list(op.LIST_FIELDS))};

/**
 * core/settings._ORG_DEFAULTS — the identity placeholders.
 *
 * They exist so the header never renders blank, and the page shows them as values, so a
 * reader seeing "Your Organization" is being told the real name was never set.
 */
export const ORG_DEFAULTS: Record<string, string> = {js(st._ORG_DEFAULTS)};

/** core/program_area_select.RATING_WORD — 0-5 to the word beside the bar. */
export const RATING_WORD: Record<string, string> = {js({str(k): v for k, v in RATING_WORD.items()})};

/**
 * core/program_area_classifier.CATEGORY_FULL — the key PREFIX expanded.
 *
 * A rated area is stored under its full key, "HSS - Health Financing". The page shows the
 * sub-area in full and the category beside it in grey, so both halves of that key have to
 * be readable; an unknown prefix falls back to itself, as `category_full` does.
 */
export const CATEGORY_FULL: Record<string, string> = {js(CATEGORY_FULL)};

// ─────────────────────────────────────────────────────────────────────────────
// THE EDITOR'S OWN OPTION LISTS — Settings → Setup, `views/org_setup.py`.
//
// Everything above describes how a STORED profile is read. Everything below is what the
// four tabs OFFER, and the distinction matters: a reader shown a stale default sees a
// wrong number, while a writer offered a stale option list STORES one. The profile is
// read by the scoring engine, so a value outside the vocabulary does not fail, it just
// stops matching — the criterion quietly scores as if the organisation had answered
// nothing. That is the failure this whole file exists to prevent, on the write side.
// ─────────────────────────────────────────────────────────────────────────────

/** core/org_profile.COFINANCING_LEVELS — MUST-5, none / limited / strong. */
export const COFINANCING_LEVELS: string[] = {js(list(op.COFINANCING_LEVELS))};

/**
 * core/criteria_derive.ROUTE_OPTIONS — [stored token, label on screen].
 *
 * The editor shows the LABELS and stores the TOKENS, so both halves are needed: a label
 * stored where a token belongs matches no call's offered routes, and the MUST-5
 * funding-route gate then scores 0 for an organisation that can in fact be funded.
 */
export const ROUTE_OPTIONS: [string, string][] = {js([list(r) for r in ROUTE_OPTIONS])};

/** The six legal types the editor offers (`_legal_opts`), in its own order. */
export const LEGAL_TYPES: string[] = {js(lifted("_legal_opts"))};

/**
 * The entity types offered when the legal type is NOT "individual" (`_entity_opts`).
 *
 * The editor's rule is a data-validation one and belongs with the list: legal type
 * "individual" forces entity type to "individual" and offers nothing else; every other
 * legal type offers these three and hides "individual". See `entityOptions` in
 * org_setup.ts, which is the rule itself rather than this table.
 */
export const ENTITY_TYPES: string[] = {js(lifted("_entity_opts", last=True))};

/** `_stage_opts` — some funders fund early-stage organisations only. */
export const ORG_STAGES: string[] = {js(lifted("_stage_opts"))};

/**
 * `_board_opts` — label on screen -> the value stored in `org_has_local_board`.
 *
 * "" is not a missing answer, it is the answer that LEAVES THE GATE OFF: "no" makes a
 * donor requiring a local board a hard MUST-4 disqualifier, and "" means unknown, so a
 * blank and a "no" are opposite instructions to the scorer.
 *
 * PAIRS, not an object, because the ORDER is load-bearing and a Record would lose it.
 * The editor's selectbox falls back to index 0 when the stored value matches nothing, so
 * whichever entry comes first is what an unrecognised value is shown as — and here that
 * entry is the one carrying "". Sorted alphabetically, "No — we don't have one" would
 * come first instead, and a profile with a damaged value would read as a hard no.
 */
export const BOARD_OPTIONS: [string, string][] = {js(
    [list(pair) for pair in lifted("_board_opts").items()])};

/** `_LANGS` — languages a competitive bid can be written in (bid effort). */
export const PROPOSAL_LANGUAGES: string[] = {js(lifted("_LANGS"))};

/** `_PARTNER_TYPES` — the partner table's Type column. */
export const PARTNER_TYPES: string[] = {js(lifted("_PARTNER_TYPES"))};

/** `_STATUS_OPTS` — the partner table's Status column; a partner may hold several. */
export const PARTNER_STATUS: string[] = {js(lifted("_STATUS_OPTS"))};

/**
 * `_crit_labels` — the nine criteria as the Scan Preferences tab names them.
 *
 * A lookup, not an order: the page iterates `CRITERIA` from scorer.ts, which is the
 * scorer's own sequence, and reads a label out of here. Two orders of the same nine
 * things is one of them waiting to go stale.
 */
export const CRITERION_LABELS: Record<string, string> = {js(lifted("_crit_labels"))};

/**
 * core/partners.DONOR_PORTALS, cleaned to bare hosts by `clean_portal_url`.
 *
 * The SEED for "Donor portal registration active". The editor unions it with the hosts
 * on the live donor_intel rows, which the route adds — this half is the repo constant,
 * that half is per-deployment data, the same split the rest of this file keeps.
 */
export const DONOR_PORTAL_SEED: string[] = {js(portal_seed())};
'''
    OUT.write_text(body, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(op.DEFAULT_PROFILE)} profile defaults, "
          f"{len(op._RENAMED_KEYS)} renamed keys, {len(st._ORG_DEFAULTS)} identity defaults, "
          f"{len(CATEGORY_FULL)} categories")


if __name__ == "__main__":
    main()
