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

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import org_profile as op                  # noqa: E402
from core import settings as st                     # noqa: E402
from core.program_area_classifier import CATEGORY_FULL   # noqa: E402
from core.program_area_select import RATING_WORD         # noqa: E402

OUT = ROOT / "supabase/functions/_shared/api/org_vocab.ts"


def js(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


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
'''
    OUT.write_text(body, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(op.DEFAULT_PROFILE)} profile defaults, "
          f"{len(op._RENAMED_KEYS)} renamed keys, {len(st._ORG_DEFAULTS)} identity defaults, "
          f"{len(CATEGORY_FULL)} categories")


if __name__ == "__main__":
    main()
