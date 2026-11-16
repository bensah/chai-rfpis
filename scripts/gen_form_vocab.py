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
  * `core/scorer`                   — the nine criteria's rich per-answer labels, and
                                      what each answer scores
  * `config/scoring_weights.yaml`   — the nine weights and the 90/70 bands
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
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import dropdowns                       # noqa: E402
from core.geographies import COUNTRIES            # noqa: E402
from core import type_detect as td               # noqa: E402
from core.scorer import (                        # noqa: E402
    CRITERIA, CRITERION_RESPONSES, _SCORE_MAP, _load_config, criterion_score,
    default_response)

OUT = ROOT / "supabase/functions/_shared/api/form_vocab.ts"

# The YAML-backed lists the editor offers, in the order the tabs use them.
PLAIN_KEYS = [
    "applicant_role", "funding_window", "time_to_award", "submission_format",
    "feasibility", "decisions", "stages", "progress_status", "donor_decision",
    "support_roles", "eligibility_values", "report_statuses", "report_types",
    # `donors` joined the list for Submit New Notice, which offers the donor as a
    # DROPDOWN where the RFP editor has a free-text box. It is plain repo YAML with no
    # app_settings overlay (unlike team_members and currencies), so generating it is safe
    # and keeping it out would mean a hand-typed funder name on the one form whose whole
    # job is first capture — the spelling every later join is keyed on.
    "donors",
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

    # WHICH OPTION A STORED VALUE PRE-SELECTS, resolved here rather than in the browser.
    #
    # Live rows carry the LEGACY vocabulary — plain "Yes" / "Partial" / "No", and the
    # per-criterion labels that preceded the current ones ("Yes, none required",
    # "Strong - priorities + experience"). `views/rfp_editor.py` runs each through
    # `default_response`, so such a row opens on the matching rich option and SAVES the
    # rich one; without that the editor would show the legacy string as a tenth, stray
    # option and write it straight back, leaving the vocabulary never to converge.
    #
    # `default_response` resolves through `criterion_score`, which is a SCORING rule — the
    # one that turns a label into 2/1/0 — and restating it in TypeScript is exactly the
    # drift this repo keeps out. So the ANSWERS are computed here, by the Python, for every
    # spelling `_SCORE_MAP` has ever recognised, and the browser only looks them up.
    #
    # A value in no table at all (free text somebody typed) is deliberately absent: the
    # editor then keeps showing it as it is rather than guessing, which is visible and
    # loses nothing.
    defaults = {
        k: {s: default_response(k, s) for s in sorted(_SCORE_MAP)}
        for k in CRITERIA
    }

    # WHAT EACH ANSWER IS WORTH, for the same reason `defaults` is resolved here.
    #
    # `core.scorer.alignment_score` is a weighted sum over `criterion_score`, and
    # `criterion_score` is _SCORE_MAP plus a _FALLBACK of substring heuristics. Submit New
    # Notice needs the number at insert time — the Streamlit form writes it, and the
    # re-score job that would otherwise supply it is dispatched through a token the live
    # deployment does not yet hold, so a row inserted without one stays unscored.
    #
    # Restating the heuristics in TypeScript is the drift this file exists to prevent, so
    # the ANSWERS are scored here, by the Python, over every spelling the form can send
    # (its own rich options) plus every spelling _SCORE_MAP has ever recognised. That makes
    # the table TOTAL for the form: a value absent from it is free text nobody's dropdown
    # offered, and the TypeScript treats it as unscored rather than guessing — which is
    # what `criterion_score` does with an unrecognised string anyway.
    #
    # null means UNSCORED ("Not sure"), which alignment_score rates 0.5 — the Park
    # midpoint, not a zero. See core/scorer._NOT_SURE_FLOAT for why.
    # Keyed by the NORMALISED answer — `criterion_score`'s own first step, lifted so the
    # TypeScript looks a value up rather than re-deriving where the case and the dash
    # spellings go. "High" and "high" collapse to one key and score the same, which they
    # already did.
    def _norm(s: str) -> str:
        return re.sub(r"\s+", " ", str(s).strip().lower()).replace("–", "-").replace("—", "-")

    scores = {
        k: {_norm(s): criterion_score(s)
            for s in sorted(set(_SCORE_MAP) | set(CRITERION_RESPONSES.get(k) or []))}
        for k in CRITERIA
    }

    # config/scoring_weights.yaml, whole. The weights and the 90/70 thresholds are repo
    # data with no per-tenant overlay (`_load_config` reads the file and nothing else), so
    # they generate like any other table. They are here rather than hand-copied because
    # the thresholds have already been wrong once in exactly that way: they sat at 70/45
    # here while auto_scorer used 90/70, and the same score banded two ways depending on
    # how the row entered the app. The YAML's own comment tells that story.
    cfg = _load_config()
    weights = {k: float(cfg.get(k, 0.0)) for k in CRITERIA}
    th = cfg.get("thresholds") or {}
    thresholds = {"proceed": float(th.get("proceed", 90)), "park": float(th.get("park", 70))}

    body = f'''/**
 * The RFP editor's controlled vocabularies. GENERATED — do not edit.
 *
 *     python scripts/gen_form_vocab.py
 *
 * Source of truth, per list: config/dropdowns.yaml for the plain ones,
 * core/program_area_classifier for PROGRAM_AREAS, core/geographies for GEO_OPTIONS,
 * core/scorer.CRITERION_RESPONSES for CRITERION_ANSWERS, core/scorer.criterion_score for
 * CRITERION_SCORES, config/scoring_weights.yaml for the weights and bands,
 * core/type_detect for the three type axes. See scripts/gen_form_vocab.py for why these
 * are generated and why `team_members` and `currencies` are not (they are per-deployment
 * and read live).
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

/** criterion key → lower-cased stored value → the option it pre-selects, as
 * core/scorer.default_response resolves it. Lets a row carrying the legacy vocabulary
 * open on the right rich answer and save that, instead of writing the legacy string back
 * for ever. A spelling absent here is shown as it is rather than guessed at. */
export const CRITERION_DEFAULTS: Record<string, Record<string, string>> = {js(defaults)};

/** core/type_detect.OPPORTUNITY_TYPES — what pursuing this IS. The eligibility gate
 * rejects Procurement / Consultancy / Training / Loan for a grant-seeking org. */
export const OPPORTUNITY_TYPES: string[] = {js(list(td.OPPORTUNITY_TYPES))};

/** core/type_detect.SOLICITATION_TYPES — how the call is announced. */
export const SOLICITATION_TYPES: string[] = {js(list(td.SOLICITATION_TYPES))};

/** core/type_detect.INSTRUMENT_TYPES — the contract if awarded. */
export const INSTRUMENT_TYPES: string[] = {js(list(td.INSTRUMENT_TYPES))};

/**
 * core/geographies.COUNTRIES — countries ALONE, without the UN regions and income tiers
 * that GEO_OPTIONS puts in front of them.
 *
 * The Profile page's Country field is a person's location, so "Sub-Saharan Africa" and
 * "Lower-middle income" are not answers to it; `views/account_sections.py` uses this list
 * for that reason. GEO_OPTIONS stays what a CALL's scope is picked from, where a region
 * genuinely is an answer.
 */
export const COUNTRIES: string[] = {js(list(COUNTRIES))};

/** criterion key → lower-cased answer → 2 / 1 / 0, or null for UNSCORED ("Not sure"),
 * as core/scorer.criterion_score resolves it. Covers every answer the forms offer and
 * every legacy spelling _SCORE_MAP recognises, so it is total for anything a dropdown can
 * send; a value absent from it is free text and scores as unscored, which is what
 * criterion_score does with one too. Unscored is rated 0.5 by alignment_score, NOT 0. */
export const CRITERION_SCORES: Record<string, Record<string, number | null>> = {js(scores)};

/** config/scoring_weights.yaml — the nine weights alignment_score sums over. */
export const SCORING_WEIGHTS: Record<string, number> = {js(weights)};

/** config/scoring_weights.yaml — the auto-recommendation bands, applied after the
 * decline-flag override. 90/70, matching core/auto_scorer.recommend_from_composite. */
export const SCORING_THRESHOLDS: {{ proceed: number; park: number }} = {js(thresholds)};
'''
    OUT.write_text(body, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(plain)} plain lists, "
          f"{len(program_areas)} programme areas, {len(geo_options)} geographies, "
          f"{len(responses)} criteria, {sum(len(v) for v in scores.values())} scored answers, "
          f"{len(COUNTRIES)} countries")


if __name__ == "__main__":
    main()
