/**
 * core/scorer.py's three public rules, for the one caller that cannot wait for the job:
 * Submit New Notice.
 *
 * WHY THIS EXISTS WHEN THE SERVER ALREADY OWNS THE SCORE. Since 2026-10-28 a save queues
 * a `rescore` job and the Python writes `alignment_score` back — one implementation of the
 * rule, running where it always ran. An edit can wait for that because the row already
 * carries a number. A BRAND-NEW row does not, and two things follow:
 *
 *   * The Streamlit form writes a score at insert and tells the submitter what it is
 *     ("Submitted as BE-261116-0904 — alignment score 72.5/100"). A React page that
 *     reported nothing would be a worse form, not a more careful one.
 *   * The live deployment holds no RFPIS_GH_DISPATCH_TOKEN, so the re-score job is queued
 *     and never dispatched. Today, a row inserted without a score keeps no score at all,
 *     and the Pipeline's bands, the Dashboard's tiles and the Report all read it as a
 *     zero. That is not a theoretical gap; it is the current state of the deployment.
 *
 * So the row is scored here AND a re-score is queued. The two numbers are not the same and
 * are not meant to be: this is `score_submission`, which core/scorer.py's own docstring
 * calls a COARSER rule than `auto_scorer.auto_score` — no fatal-factor gate, no
 * below-award-floor cap, both of which only ever downgrade. It is therefore an upper bound
 * on the canonical answer, and the job replaces it with the canonical one when it runs.
 *
 * NOTHING IS RE-DERIVED HERE. `criterion_score` is _SCORE_MAP plus a list of substring
 * heuristics, and the weights and bands are a YAML file that has already been
 * hand-copied wrong once (70/45 against auto_scorer's 90/70 — see the file's own comment).
 * All three are GENERATED into form_vocab.ts by scripts/gen_form_vocab.py, which runs the
 * Python over every spelling the form can send. This module is the arithmetic and nothing
 * else.
 */
import {
  CRITERION_SCORES, SCORING_THRESHOLDS, SCORING_WEIGHTS,
} from "./form_vocab.ts";
import { pyRound } from "./py_round.ts";

/** core/scorer.CRITERIA, in the order the weights and the MUST/PREFER split assume. */
export const CRITERIA = [
  "qualification", "strategic_fit", "capacity", "geographic_fit", "cofinancing",
  "funding_quality", "funder_relationship", "competitiveness", "bid_effort",
] as const;

export type Criterion = (typeof CRITERIA)[number];

const _SCORE_TO_FLOAT: Record<number, number> = { 2: 1.0, 1: 0.5, 0: 0.0 };

/**
 * "Not sure" / undetermined leaves the denominator entirely (owner, 2026-11-18) — it is
 * NOT rated 0.5 any more, and it is not rated 0 either. See core/scorer.alignment_score
 * for the reasoning; the short of it is that a half-weight for "we could not read this"
 * was invisible on the page and printed as "7.5 / 15" beside the words "not scored".
 *
 * Kept as a named constant because the 0.5 is still what `_SCORE_TO_FLOAT` gives a
 * PARTIAL answer, and a future reader deserves to find the retired rule rather than
 * wonder whether it was ever there.
 */
const NOT_SURE_FLOAT = 0.5;    // retired 2026-11-18; see alignmentScore below.
void NOT_SURE_FLOAT;

/** `criterion_score`'s own normalisation, which the generated keys are already in. */
const norm = (v: unknown): string =>
  String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ")
    .replace(/–/g, "-").replace(/—/g, "-");

/**
 * One answer → 2 / 1 / 0, or null for unscored.
 *
 * A value the table does not hold is free text nobody's dropdown offered, and it comes
 * back null — which is what `criterion_score` does with an unrecognised string too, after
 * its fallbacks have also failed to place it. The fallbacks are not reproduced: they exist
 * for MS-Form wording drift on the ingest side, and every value reaching this module came
 * from a <select> whose options are the generated list.
 */
export function criterionScore(criterion: string, value: unknown): number | null {
  const s = norm(value);
  if (!s || s.includes("not sure")) return null;
  const table = CRITERION_SCORES[criterion];
  const hit = table ? table[s] : undefined;
  return hit === undefined ? null : hit;
}

/**
 * core/scorer.alignment_score — 0-100, one decimal.
 *
 * ONLY DETERMINED CRITERIA COUNT (owner, 2026-11-18). A criterion answered "Not sure",
 * or carrying a value this criterion's own vocabulary does not recognise, leaves BOTH the
 * numerator and the denominator — so the score is the weighted fit across what could
 * actually be judged, not a number dragged toward 50 by everything that could not.
 *
 * It used to be the opposite: all nine counted and an unanswered one was rated 0.5. The
 * mirror of this change is core/scorer.alignment_score; web/scripts/parity/check-submit
 * runs the two against each other, so they move together or the gate goes red.
 */
export function alignmentScore(values: Record<string, unknown>): number {
  let total = 0;
  let weightSum = 0;
  for (const c of CRITERIA) {
    const sc = criterionScore(c, values[c]);
    if (sc === null) continue;
    const w = SCORING_WEIGHTS[c] ?? 0;
    weightSum += w;
    total += w * _SCORE_TO_FLOAT[sc];
  }
  if (weightSum <= 0) return 0;
  const score = (total / weightSum) * 100;
  // Python rounds to one decimal and THEN clamps; order matters only at the extremes.
  //
  // This used to be `Math.round(score * 10) / 10` with a note arguing the half-up/half-even
  // difference was unreachable here. The note was about the wrong half of the problem: the
  // MULTIPLICATION is what moves a value across a tie, and the same idiom in
  // opportunity_feed.ts duly turned check-scoring red on a real row. `pyRound` is
  // `round()` outright — the exact value, ties to even — so neither half can bite.
  return Math.max(0, Math.min(100, pyRound(score, 1)));
}

/**
 * core/scorer.auto_recommendation — the decline-flag override beats the bands. */
export function autoRecommendation(score: number, declineFlagsPresent: boolean): string {
  if (declineFlagsPresent) return "Decline";
  if (score >= SCORING_THRESHOLDS.proceed) return "Proceed";
  if (score >= SCORING_THRESHOLDS.park) return "Park";
  return "Decline";
}

/** core/scorer.score_submission — the pair, as the submit form takes them. */
export function scoreSubmission(
  values: Record<string, unknown>, declineFlagsPresent: boolean,
): { score: number; recommendation: string } {
  const score = alignmentScore(values);
  return { score, recommendation: autoRecommendation(score, declineFlagsPresent) };
}
