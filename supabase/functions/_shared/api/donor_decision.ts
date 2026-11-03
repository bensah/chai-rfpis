/**
 * core/donor_decision.py, ported — what counts as "the funder has not answered yet".
 *
 * Its own module for the reason the Python's is: the test had three copies in the Streamlit
 * app (the RFP editor, the Grants page and the Excel sync) and they drifted, so one of them
 * suggested a value, one displayed a derived one, and one decided whether a spreadsheet may
 * overwrite what is stored. Here it already has two callers — the save warning in
 * pipeline_writes.ts and the Submitted stage's membership in routes_pipelines.ts — and a
 * read and a write that disagree about whether the funder has answered would put a row on
 * a stage the save thinks it left.
 *
 * The subtlety worth naming, which is the Python's own: "Not submitted" is the DEFAULT
 * every row carries, not a judgement anybody made, so it counts as no answer. "Under
 * Review" is different — somebody put it there deliberately — so it is an answer for the
 * purpose of not being overwritten, even though it is not an outcome.
 */

/** The funder's real answers. Anything else is the default or a pending state. */
export const OUTCOMES = ["Approved", "Not Approved"] as const;

/**
 * Values meaning nobody has recorded an answer. The NULL-ish shapes are the Python's and
 * they are not theoretical here either: rows migrated from the workbook carry the literal
 * string "nan" where the cell was empty, and a plain emptiness test leaves a truthy value
 * that no comparison would match.
 */
const NO_ANSWER = new Set(["", "none", "nan", "nat", "null", "not submitted"]);

/** core/pipeline.py::_UNSUBMITTED_DONOR_DECISIONS — the narrower pair `is_submitted` tests
 *  against. Kept separate from NO_ANSWER rather than merged, because the two lists answer
 *  different questions: this one is "did it reach the funder", that one is "has anybody
 *  recorded a response". */
const UNSUBMITTED = new Set(["", "not submitted"]);

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** core/pipeline.py::_txt — lower-cased, with the Excel-import "nan" treated as blank.
 *  `str(float("nan"))` produces the same thing, so a plain emptiness test leaves a truthy
 *  "nan" behind. */
const txt = (v: unknown) => { const s = norm(v); return s === "nan" ? "" : s; };

/** True when nothing has been recorded about the funder's response. */
export const isNoAnswer = (v: unknown): boolean => NO_ANSWER.has(norm(v));

/**
 * True when the funder has actually decided — approved or not.
 *
 * "Under Review" is deliberately NOT an outcome: it records that we are waiting, which is
 * why a row carrying it still belongs in Applied Funding but not in a win/loss count, and
 * why it belongs on the Submitted stage rather than on Outcome.
 */
export const isOutcome = (v: unknown): boolean =>
  OUTCOMES.some((o) => o.toLowerCase() === norm(v));

/**
 * core/pipeline.py::is_submitted — anything on the row that records the proposal reached
 * the funder.
 *
 * THE INVERSE LIST IS THE POINT, and it is not the same test as
 * views/report.py::_submitted_mask, which names the three donor decisions that prove a
 * submission. A donor can only decide on a proposal it received, so ANY value outside
 * {blank, "Not submitted"} proves the proposal went in — including a word added to the
 * dropdown next year, and including one somebody typed. The allowlist reads a value it has
 * never seen as unsubmitted.
 *
 * That is not hypothetical. Measured on the live table 2026-11-03: two rows carry
 * donor_decision "Submitted", which is not one of config/dropdowns.yaml's four values at
 * all. This test counts them; the report's mask does not.
 *
 * `date_completed` counts too, which is where this differs from the mask in the other
 * direction: a recorded submission date is a person writing down the day it went in.
 */
export function isSubmitted(row: {
  progress_status?: unknown; donor_decision?: unknown; date_completed?: unknown;
}): boolean {
  if (txt(row.progress_status) === "completed") return true;
  // The Python's narrower set here, NOT the six in NO_ANSWER above. core/pipeline.py uses
  // {"", "not submitted"} and reaches them through _txt, so "nan" arrives as "" and is
  // already covered — the two lists agree on every value either one can actually see.
  if (!UNSUBMITTED.has(txt(row.donor_decision))) return true;
  return txt(row.date_completed) !== "";
}
