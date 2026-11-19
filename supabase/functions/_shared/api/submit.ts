/**
 * Submit New Notice — the rules, as pure functions. `views/submit_form.py`, ported.
 *
 * THE POLICY THIS FORM IS BUILT AROUND (owner, 2026-06-05, quoted in the Python): it does
 * NOT block on duplicates. Every submission inserts immediately, so the submitter's act of
 * capturing an opportunity is never lost; de-duplication runs at DISPLAY time instead
 * (core/deduplicator.py, consumed by the Pipeline and the Report), so the dashboards still
 * do not double-count. The reasoning was that most "duplicates" were intentional
 * re-entries after a status change, and the warning cost more than it caught.
 *
 * That policy is why the UID is minted defensively below, and it is the one thing to keep
 * in mind when changing anything here: a validation that refuses a row is a change of
 * policy, not a safety improvement.
 *
 * WHAT IS DELIBERATELY NOT COMPUTED HERE: `decline_flags_present`. core/scorer.py has an
 * owner's rule for deriving it from the nine criteria (any failing MUST, or two failing
 * PREFERs), but this form ASKS — "Decline flags present? *", Yes/No, section 3 — and the
 * submitter's answer is what the Python stores. Deriving it would overwrite a human
 * judgement with a rule the submitter cannot see, on the one screen where the human is the
 * source.
 */
import { CRITERION_ANSWERS } from "./form_vocab.ts";
import { CRITERIA, scoreSubmission } from "./scorer.ts";
import { PROVENANCE_COLUMN, record } from "./provenance.ts";

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const trimmed = (v: unknown): string => s(v).trim();

/** A value, or null for anything the Streamlit form treats as "unset". */
const none = (v: unknown): string | null => {
  const t = trimmed(v);
  // "—" is the form's own NONE sentinel: the first entry of every single-select.
  return !t || t === "—" ? null : t;
};

// ── The UID ──────────────────────────────────────────────────────────────────

/** core/uid_generator._initials — two letters, or "XX" when there is no name at all. */
export function initials(name: unknown): string {
  const parts = trimmed(name).split(/\s+/).filter(Boolean);
  if (!parts.length) return "XX";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const two = (n: number) => String(n).padStart(2, "0");

/**
 * core/uid_generator.generate_uid — `<INITIALS>-<YYMMDD>-<HHMM>`, e.g. BE-260202-1220.
 *
 * `offsetMinutes` is the submitter's UTC offset, because the Python stamps
 * `datetime.now()` — WALL-CLOCK time where the process runs. For the Streamlit app that
 * process is the one on the reviewer's own machine, so the UID a submitter reads today
 * carries their own date and minute. Running in an Edge Function the same call would say
 * UTC, and a submission at half past midnight in Yaoundé would be stamped with yesterday's
 * date, which looks like a bug to the person who just made it.
 *
 * The CLOCK is still the server's and only the ZONE comes from the browser, so a wrong or
 * meddled-with client cannot mint a UID claiming another year. And the UID is an
 * identifier, not the record of when: `submitted_at` and `search_date` are server UTC and
 * are what anything date-sensitive reads.
 */
export function generateUid(submitter: unknown, now: Date, offsetMinutes = 0): string {
  const t = new Date(now.getTime() + clampOffset(offsetMinutes) * 60_000);
  const stamp = `${two(t.getUTCFullYear() % 100)}${two(t.getUTCMonth() + 1)}${two(t.getUTCDate())}`;
  return `${initials(submitter)}-${stamp}-${two(t.getUTCHours())}${two(t.getUTCMinutes())}`;
}

/** Real UTC offsets run -12:00 to +14:00. Anything else is a broken or hostile clock. */
export const clampOffset = (m: unknown): number => {
  const n = Number(m);
  return Number.isFinite(n) ? Math.max(-720, Math.min(840, Math.trunc(n))) : 0;
};

/** The submitter's own calendar day, which `review_week_label()` and the form both use. */
export const localDay = (now: Date, offsetMinutes = 0): string =>
  new Date(now.getTime() + clampOffset(offsetMinutes) * 60_000).toISOString().slice(0, 10);

/**
 * Pick a UID that no row holds yet, bumping the minute until one is free.
 *
 * THE PYTHON DOES NOT DO THIS, and the difference is worth the read it costs. Two people
 * whose names give the same two initials, submitting in the same minute, get the same UID.
 * If the column carries a unique constraint, the second insert fails — and a refused
 * insert is precisely what the 2026-06-05 policy above forbids. If it does not (the live
 * table has no such constraint that this repo's migrations create), the worse thing
 * happens: two rows answer to one name, and every `?uid=` deep link, every join through
 * `rfp_seen` and every decision tombstone addresses whichever one comes back first.
 *
 * So the minute is nudged rather than the insert risked. The stamp then reads a minute or
 * two late, which costs nothing — see `generateUid` on the UID not being the record of
 * when. `taken` is given the whole prefix at once so this is one query, not five.
 */
export function pickUid(base: string, taken: ReadonlySet<string>, limit = 5): string {
  if (!taken.has(base)) return base;
  const m = /^(.*-)(\d{2})(\d{2})$/.exec(base);
  if (!m) return base;
  let mins = Number(m[2]) * 60 + Number(m[3]);
  for (let i = 0; i < limit; i++) {
    mins = (mins + 1) % (24 * 60);
    const next = `${m[1]}${two(Math.floor(mins / 60))}${two(mins % 60)}`;
    if (!taken.has(next)) return next;
  }
  // Five collisions in one minute is not a clash, it is something else happening. Insert
  // under the original rather than loop: the policy says never refuse the submission.
  return base;
}

// ── What the browser sends ───────────────────────────────────────────────────

export type SubmitPayload = {
  title?: unknown;
  opportunityId?: unknown;
  funder?: unknown;
  brief?: unknown;
  datePosted?: unknown;
  deadline?: unknown;
  awardDate?: unknown;
  applicantRole?: unknown;
  fundingWindow?: unknown;
  timeToAward?: unknown;
  submissionFormat?: unknown;
  link?: unknown;
  value?: unknown;
  currency?: unknown;
  duration?: unknown;
  focusTheme?: unknown;
  leadApplicant?: unknown;
  subApplicant?: unknown;
  geo?: unknown;
  programAreas?: unknown;
  criteria?: unknown;
  feasibility?: unknown;
  declineFlags?: unknown;
  keyRisks?: unknown;
  decision?: unknown;
  rationale?: unknown;
  proposalLead?: unknown;
  contributors?: unknown;
  reviewers?: unknown;
  offsetMinutes?: unknown;
};

/** A list of non-blank strings, or null — `_multi_with_other`'s `final or None`. */
const list = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  const out = v.map(trimmed).filter(Boolean);
  return out.length ? out : null;
};

/** A date column: `YYYY-MM-DD`, or null. Anything else is refused rather than dropped. */
function dayOrNull(v: unknown, field: string): string | null {
  const t = trimmed(v);
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.slice(0, 10))) throw new Error(`${field} must be a date`);
  return t.slice(0, 10);
}

/** A number column: 0 and blank are both null, as `float(value) if value else None`. */
function numOrNull(v: unknown, int = false): number | null {
  const n = Number(trimmed(v));
  if (!Number.isFinite(n) || n === 0) return null;
  return int ? Math.trunc(n) : n;
}

/**
 * Section 5 (Team) is only shown for a Proceed or Park decision, and the Proposal lead is
 * only required when it is shown. `str.startswith` in the Python, so "Proceed as sub" —
 * a decision this app dropped in migration 019 but old rows still carry — would still
 * count, and anything the dropdown offers today matches exactly.
 */
export const showsTeam = (decision: unknown): boolean => {
  const d = trimmed(decision).toLowerCase();
  return d.startsWith("proceed") || d.startsWith("park");
};

/** The Python's five validations, in its order, with its wording. */
export function validate(p: SubmitPayload): string[] {
  const errors: string[] = [];
  if (!trimmed(p.title)) errors.push("Opportunity title is required.");
  if (!none(p.funder)) errors.push("Funder is required.");
  if (!trimmed(p.leadApplicant)) errors.push("Lead applicant is required.");
  if (!none(p.decision)) errors.push("Decision is required.");
  if (showsTeam(p.decision) && !none(p.proposalLead)) {
    errors.push("Proposal lead is required for a Proceed / Park decision.");
  }
  return errors;
}

/**
 * The nine criteria, each falling back to what the Streamlit dropdown opens on.
 *
 * `views/submit_form.py::_crit` is one line and it decides the default:
 *
 *     didx = opts.index("Not sure") if "Not sure" in opts else 0
 *
 * So eight criteria open on "Not sure" — the submitter sets only what they actually know,
 * and an unscored criterion is rated 0.5, the Park midpoint, rather than zero.
 *
 * BID_EFFORT USED TO BE THE EXCEPTION AND NO LONGER IS (owner, 2026-11-17). Its
 * vocabulary had no "Not sure", so `else 0` took the FIRST option — the list runs best to
 * worst — and an untouched PREFER-9 asserted "Ample time, sufficient resources", worth a
 * full 2. A submitter who filled in only the four required fields had told the scorer the
 * bid was comfortably resourced, and an otherwise-untouched form scored 54.5 instead of
 * 50.0. The option was added to `core.scorer.CRITERION_RESPONSES`, so the same one-line
 * rule now reaches the right answer in both apps with no code change here.
 *
 * A key the browser omits therefore behaves like an untouched dropdown, not like a blank,
 * and a value outside the vocabulary is dropped rather than stored: a free-text criterion
 * scores as nothing and would quietly become a tenth option on the editor that opens next.
 */
export function criteriaValues(raw: unknown): Record<string, string> {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const c of CRITERIA) {
    const given = trimmed(src[c]);
    const answers = CRITERION_ANSWERS[c] ?? [];
    out[c] = given && answers.includes(given)
      ? given
      // All nine carry "Not sure" since 2026-11-17; the opts[0] arm is kept for a
      // vocabulary that ever loses it again, where asserting the BEST answer is still
      // less wrong than asserting the worst.
      : (answers.includes("Not sure") ? "Not sure" : (answers[0] ?? ""));
  }
  return out;
}

/**
 * BACKDATED INTAKE — the deadline has already passed.
 *
 * `core/criteria_derive.needs_submission_check` is "not completed AND the deadline is in
 * the past". A row this route has just created is never completed (no progress_status, no
 * donor_decision, no date_completed), so only the second half can be true and the whole
 * test reduces to the date. That is not a shortcut around the Python: it is the same
 * predicate evaluated on a row whose first half is fixed by construction.
 *
 * It matters because of what the scorer does next. Nothing marks the row submitted, so
 * PREFER-9 reads the passed deadline as "not enough time" and the opportunity reads as one
 * that was missed — when in fact it may have gone to the donor months ago and be under
 * review. The page prompts for the one field that fixes it.
 */
export const needsSubmissionCheck = (deadline: string | null, today: string): boolean =>
  !!deadline && deadline < today;

/** The row, exactly as `views/submit_form.py` builds it. */
export function buildRow(
  p: SubmitPayload,
  opts: {
    uid: string; submitter: string; email: string; nowIso: string; reviewWeek: string;
    /** The submitter's own calendar day, for `decision_date` — a date, not a timestamp. */
    today: string;
  },
): Record<string, unknown> {
  const criteria = criteriaValues(p.criteria);
  const declineBool = p.declineFlags === true || trimmed(p.declineFlags) === "Yes";
  const { score, recommendation } = scoreSubmission(criteria, declineBool);
  return {
    uid: opts.uid,
    // The same value twice, as the Python writes it. `form_id` is the MS-Form response id
    // for rows that came from the form; a manual row has none, and copying the uid keeps
    // the column non-null for the joins that assume it.
    form_id: opts.uid,
    source: "manual",
    submitted_by: opts.submitter,
    submitted_by_email: opts.email,
    submitted_at: opts.nowIso,
    search_date: opts.nowIso,
    opportunity_id: none(p.opportunityId),
    opportunity_title: trimmed(p.title),
    brief_description: none(p.brief),
    date_posted: dayOrNull(p.datePosted, "datePosted"),
    funding_agency: none(p.funder),
    call_geographic_scope: list(p.geo),
    call_domain_areas: list(p.programAreas),
    focus_theme: none(p.focusTheme),
    opportunity_link: none(p.link),
    applicant_role: none(p.applicantRole),
    lead_applicant: none(p.leadApplicant),
    sub_applicant: none(p.subApplicant),
    funding_window: none(p.fundingWindow),
    call_submission_deadline: dayOrNull(p.deadline, "deadline"),
    expected_award_date: dayOrNull(p.awardDate, "awardDate"),
    time_to_award: none(p.timeToAward),
    call_award_value: numOrNull(p.value),
    currency: none(p.currency),
    project_duration: numOrNull(p.duration, true),
    submission_format: none(p.submissionFormat),
    feasibility: none(p.feasibility),
    ...criteria,
    // WHO ANSWERED WHICH CRITERION, against THE FORM'S OWN DEFAULTS rather than an empty
    // row. An insert has nothing stored to compare with, so the baseline is what the nine
    // dropdowns would say if the submitter touched none of them — `criteriaValues({})`,
    // which is the same function that fills them. Compared against an empty row instead,
    // every default would read as an answer and the submitter's name would go on nine
    // things they never said.
    //
    // `views/submit_form.py` does exactly this (fd81bdd) and calls the argument
    // `baseline`; its `_crit_default` is this module's own fallback rule, which is why
    // the two paths record the same thing for the same form.
    [PROVENANCE_COLUMN]: record(criteriaValues({}) as never, criteria, opts.email,
      opts.nowIso) ?? null,
    decline_flags_present: declineBool,
    key_risks: none(p.keyRisks),
    alignment_score: score,
    auto_recommendation: recommendation,
    decision: none(p.decision),
    // A DECISION RECORDED AT SUBMISSION IS THIS ROW'S FIRST CAPTURE, which is the one
    // moment a system date may stand in for one nobody typed (owner, 2026-11-09) — the
    // form has no date field. Stamped only when a decision is actually present: a
    // submission without one has nothing to date.
    //
    // It also brings the row under the re-score job's skip immediately, instead of
    // waiting for provenance to reach it through a later editor save. `views/submit_form
    // .py` stamps it on the same condition.
    decision_date: none(p.decision) ? opts.today : null,
    decision_note: none(p.rationale),
    proposal_lead: none(p.proposalLead),
    contributors: list(p.contributors),
    reviewers: list(p.reviewers),
    review_week: opts.reviewWeek,
  };
}

/**
 * What the submission is shared to the GLOBAL pool as — `core/extracted_store`'s shape.
 *
 * Why share at all: every tenant's "My Eligible Funding" scan matches the pool against its
 * own preferences, so one team capturing a call by hand makes it discoverable to the
 * others, screened per-tenant. The submitter already has their own row and their own seen
 * tombstone, so their next scan will not hand it back to them.
 *
 * Returns null when there is no URL to key on — `upsert_extracted` makes the uid from the
 * URL and refuses a record without one, so a call with no link is the submitter's alone.
 * The two array columns take a bare string wrapped in a list, which is what the Python
 * does: the submit form can store either, and the pool's columns are arrays.
 */
export function poolRecord(row: Record<string, unknown>): Record<string, unknown> | null {
  if (!trimmed(row.opportunity_link)) return null;
  const arr = (v: unknown) => (typeof v === "string" && v ? [v] : (v ?? null));
  const theme = trimmed(row.focus_theme);
  return {
    opportunity_name: row.opportunity_title,
    opportunity_url: row.opportunity_link,
    opportunity_id: row.opportunity_id,
    funder_name: row.funding_agency,
    brief_description: row.brief_description,
    date_posted: row.date_posted,
    deadline: row.call_submission_deadline,
    deadline_confidence: row.call_submission_deadline ? "stated" : null,
    grant_amount: row.call_award_value,
    currency: row.currency,
    funding_window: row.funding_window,
    expected_award_date: row.expected_award_date,
    time_to_award: row.time_to_award,
    project_duration: row.project_duration,
    submission_format: row.submission_format,
    call_geographic_scope: arr(row.call_geographic_scope),
    call_domain_areas: arr(row.call_domain_areas),
    focus_themes: theme ? [theme] : null,
    funding_status: "Open",
    source: "manual-submission",
  };
}
