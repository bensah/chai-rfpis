"""Emit supabase/functions/_shared/api/form_vocab.ts from the Python that owns the lists.

The React RFP editor is a port of `views/rfp_editor.py`, and almost every control on it is
a CONTROLLED vocabulary rather than a free-text box. Those vocabularies are not decoration:
`decision` decides who appears in Track and whether the scan tombstones a row;
`opportunity_type` decides whether the eligibility gate rejects the call outright;
`call_domain_areas` and `call_geographic_scope` feed matching. A dropdown that offers a
value the Python does not recognise writes a row nothing downstream can read.

So the DATA is generated here and only the FORM is hand-written. Four owners:

  * `config/dropdowns.yaml`         — the plain lists (roles, windows, stages, statuses)
  * `core/program_area_classifier`  — programme areas, as bare sub-area names
  * `core/geographies`              — UN regions + income tiers + countries
  * `core/scorer`                   — the nine criteria's rich per-answer labels
  * `core/type_detect`              — the three type axes the gate reads

`core/dropdowns.get` already routes the middle two away from the YAML for exactly this
reason ("no drifting YAML copies"), so this file calls `dropdowns.get` rather than reading
the YAML itself: one more copy of that routing rule is one more thing to drift.

WHAT IS DELIBERATELY NOT HERE: `team_members` and `currencies`. `core/dropdowns.load`
overlays both from `app_settings` — the roster is per-tenant and real names are never
committed to a public repo (see `core/settings.get_team_members`). Generating them would
bake one deployment's people into source. `form_options.ts` reads those two live instead,
the way `report_names.ts` and `money.ts` already do.

    python scripts/gen_form_vocab.py          # rewrites the .ts in place

Re-run it whenever config/dropdowns.yaml, the programme-area taxonomy, the geography list,
CRITERION_RESPONSES or the type vocabularies change. `tests/test_form_vocab_is_current.py`
re-generates and compares, so a stale table fails a test rather than silently narrowing a
dropdown.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import dropdowns                       # noqa: E402
from core import type_detect as td               # noqa: E402
from core.scorer import CRITERIA, CRITERION_RESPONSES   # noqa: E402

OUT = ROOT / "supabase/functions/_shared/api/form_vocab.ts"

# The YAML-backed lists the editor offers, in the order the tabs use them.
PLAIN_KEYS = [
    "applicant_role", "funding_window", "time_to_award", "submission_format",
    "feasibility", "decisions", "stages", "progress_status", "donor_decision",
    "support_roles", "eligibility_values", "report_statuses", "report_types",
]


def js(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def main() -> None:
    plain = {k: list(dropdowns.get(k) or []) for k in PLAIN_KEYS}

    # Routed through dropdowns.get, which takes these from the canonical modules rather
    # than the YAML. Bare sub-area names for programme areas; Sentence-cased geographies.
    program_areas = list(dropdowns.get("call_domain_areas") or [])
    geo_options = list(dropdowns.get("call_geographic_scope") or [])

    # The nine criteria's rich answers. Keyed by criterion so the editor can offer the
    # same options core/scorer.default_response maps a stored value back onto.
    responses = {k: list(CRITERION_RESPONSES.get(k) or []) for k in CRITERIA}

    body = f'''/**
 * The RFP editor's controlled vocabularies. GENERATED — do not edit.
 *
 *     python scripts/gen_form_vocab.py
 *
 * Source of truth, per list: config/dropdowns.yaml for the plain ones,
 * core/program_area_classifier for PROGRAM_AREAS, core/geographies for GEO_OPTIONS,
 * core/scorer.CRITERION_RESPONSES for CRITERION_ANSWERS, core/type_detect for the three
 * type axes. See scripts/gen_form_vocab.py for why these are generated and why
 * `team_members` and `currencies` are not (they are per-deployment and read live).
 */

/** config/dropdowns.yaml, the keys the editor offers. */
export const DROPDOWNS: Record<string, string[]> = {js(plain)};

/** core/program_area_classifier.TAXONOMY, flattened to bare sub-area names —
 * `dropdowns.get("call_domain_areas")`. */
export const PROGRAM_AREAS: string[] = {js(program_areas)};

/** core/geographies.GEO_OPTIONS — UN regions, income tiers, then countries —
 * `dropdowns.get("call_geographic_scope")`. */
export const GEO_OPTIONS: string[] = {js(geo_options)};

/** core/scorer.CRITERION_RESPONSES — criterion key → its rich answers, best first. */
export const CRITERION_ANSWERS: Record<string, string[]> = {js(responses)};

/** core/type_detect.OPPORTUNITY_TYPES — what pursuing this IS. The eligibility gate
 * rejects Procurement / Consultancy / Training / Loan for a grant-seeking org. */
export const OPPORTUNITY_TYPES: string[] = {js(list(td.OPPORTUNITY_TYPES))};

/** core/type_detect.SOLICITATION_TYPES — how the call is announced. */
export const SOLICITATION_TYPES: string[] = {js(list(td.SOLICITATION_TYPES))};

/** core/type_detect.INSTRUMENT_TYPES — the contract if awarded. */
export const INSTRUMENT_TYPES: string[] = {js(list(td.INSTRUMENT_TYPES))};
'''
    OUT.write_text(body, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(plain)} plain lists, "
          f"{len(program_areas)} programme areas, {len(geo_options)} geographies, "
          f"{len(responses)} criteria")


if __name__ == "__main__":
    main()
