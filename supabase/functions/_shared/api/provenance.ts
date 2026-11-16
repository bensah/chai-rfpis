/**
 * Criteria provenance — `core/criteria_provenance.py::record`, for the React save path.
 *
 * WHY THIS EXISTS AT ALL. Since 2b6d42f the scorer honours a criterion a PERSON answered
 * instead of re-deriving it, and it knows which those are from
 * `rfp_submissions.criteria_provenance` (migration 102). Both Streamlit editors write it.
 * `RfpEditor.tsx` edits the same nine columns and did not, which made the React app the
 * one place where a reviewer's answer was indistinguishable from the scan's own output —
 * the exact fault the column was added to end, surviving in the app that is replacing the
 * one that was fixed.
 *
 * THE SHAPE: { "<criterion>": { "by": "<email>", "at": "<iso8601>" } }
 *
 * THE RULE IS THE HARD PART, and it is subtractive: record only criteria whose value this
 * save actually MOVES. Three cases are refused, each of which would otherwise put a
 * reviewer's name on something they never said:
 *
 *   1. A VALUE IDENTICAL TO THE STORED ONE. An editor save carries all nine columns
 *      whether or not the person touched them, so "present in the payload" means nothing.
 *   2. A VALUE LANDING IN A COLUMN THAT WAS EMPTY. `views/rfp_editor.py::_elig` pre-selects
 *      through `default_response`, and where there is nothing to map it falls to the option
 *      at index 0 — so a save of any OTHER field writes a default into a blank criterion.
 *      The cost is a false negative: a reviewer genuinely answering a blank one is not
 *      recorded until they change it again. That is the safe direction to be wrong in.
 *   3. CLEARING a criterion drops its entry rather than recording one. Nobody is the
 *      author of a blank.
 *
 * "Not sure" is NOT empty — it is a stored non-answer, so answering one still counts as a
 * change. What the READ side does with a "Not sure" label is `criteria_provenance.answers`'
 * business and deliberately not duplicated here: provenance says WHO answered, the column
 * says WHAT, and this module never holds a second copy of a value that already exists.
 */
import { CRITERIA } from "./scorer.ts";
import type { Json } from "./jwt.ts";

/** `core/criteria_provenance.COLUMN`. */
export const PROVENANCE_COLUMN = "criteria_provenance";

export type ProvenanceEntry = { by: string; at: string };
export type Provenance = Record<string, ProvenanceEntry>;

/** jsonb arrives as an object; a text column arrives as a string. Both are accepted, as
 *  `_as_dict` accepts them, and anything else is no provenance at all. */
export function asDict(value: unknown): Provenance {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...value } as Provenance;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Provenance : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** `_empty` — nothing stored at all. DISTINCT from "Not sure", which is a stored
 *  non-answer and does count as something a person can change. */
const empty = (v: unknown): boolean => v === null || v === undefined || !String(v).trim();

const same = (a: unknown, b: unknown): boolean =>
  String(a ?? "").trim() === String(b ?? "").trim();

/**
 * The new provenance column for a save, or null when nothing moved.
 *
 * `values` is what the save is about to write for the nine criteria; `row` is what the row
 * holds now. Existing entries are KEPT — a criterion answered last week is still that
 * person's when somebody edits a different one today — and an entry is dropped only when
 * this save clears that criterion.
 *
 * Returning null rather than an unchanged object is what lets the caller leave the column
 * out of the update entirely, instead of rewriting it to its own value on every save and
 * touching a row nothing changed on.
 */
export function record(
  row: Json | null, values: Record<string, unknown>, by: string, at?: string,
): Provenance | null {
  const current = row ?? {};
  const after = asDict(current[PROVENANCE_COLUMN]);
  const stamp = at ?? new Date().toISOString();
  let changed = false;

  for (const criterion of CRITERIA) {
    if (!(criterion in values)) continue;
    const next = values[criterion];
    const old = current[criterion];
    if (same(next, old)) continue;        // round-tripped, or genuinely unchanged
    if (empty(old)) continue;             // the form filling a gap, not a person speaking
    changed = true;
    if (empty(next)) delete after[criterion];
    else after[criterion] = { by: by || "unknown", at: stamp };
  }

  return changed ? after : null;
}

/** The criteria this row records a person as having answered — `human_set`, for the
 *  provenance column alone. The overrides column is the Python's second channel and is
 *  not read here: nothing on this side of the wire scores. */
export const humanSet = (row: Json | null): string[] =>
  CRITERIA.filter((c) => c in asDict((row ?? {})[PROVENANCE_COLUMN]));
