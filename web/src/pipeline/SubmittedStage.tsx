/**
 * Submitted — the proposals sitting with a funder, and how long each has been sitting.
 *
 * The stage is a WAIT, not an event, and nearly everything here follows from that.
 *
 *   * The number that matters is days, not dates. "95 days" is a question somebody can act
 *     on; "submitted 2026-07-31" is a fact nobody reads. Longest wait first, because that
 *     is the order the chasing has to happen in.
 *
 *   * Many of those days are approximate and the page says so. 8 of 14 rows have no
 *     `date_completed` (measured 2026-11-03), so the wait is counted from the intake date
 *     instead. The API resolves which date was used and flags it; this marks it rather
 *     than rounding a guess into a confident number.
 *
 *   * The gap IS the content. Most rows here arrive with donor_decision "Not submitted" —
 *     the default nobody chose — because the Bidding panel's "it was submitted" writes
 *     progress and nothing else. rfp_editor.py used to silently force "Under Review" in
 *     exactly this case and that was removed for being a decision nobody made, leaving
 *     only a warning. This stage is where the warning finally gets asked as a question.
 *
 * Every action re-fetches rather than patching the row in place, and that is not caution:
 * recording an answer moves the row to Outcome, and recording a submission date changes
 * the wait, the sort and which period the row falls in. A patched row would sit there
 * claiming a state it had just left.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, CalendarClock, ExternalLink, Hourglass, Send,
} from "lucide-react";
import {
  fetchSubmitted, saveRfpFields, type Submitted, type SubmittedRow, type Warning,
} from "../api";
import { atGrain, labelOf, rangeOf, type Period } from "./period";
import { Badge, Button, Card, EmptyState, Notice, Select, Spinner, fieldClass } from "../ui";

/** config/dropdowns.yaml's `donor_decision`. The API pins the same list against that file
 *  (pipeline_writes.ts::DONOR_DECISIONS) but does not REFUSE anything outside it — live
 *  rows carry values the vocabulary never had, so a stored one is shown as it is. */
const UNDER_REVIEW = "Under Review";
const APPROVED = "Approved";
const NOT_APPROVED = "Not Approved";

/** The stages that mean the application was never walked forward. A submitted proposal
 *  sitting in "Identification & screening" is bookkeeping left behind, not a contradiction
 *  — 9 of 14 rows, so it is worth one click rather than a lecture. */
const PRE_SUBMISSION = new Set([
  "Identification & screening", "Go/no-go decision & bid planning",
  "Proposal development", "Budgeting development",
  "Review, compliance check & approvals", "Final packaging & submission",
]);
const FOLLOW_UP = "Post-submission follow-up";

const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
const iso = () => new Date().toISOString().slice(0, 10);

/** Days between an ISO date and today. Null for anything unparseable. */
function waitedSince(d: string | null): number | null {
  if (!d) return null;
  const t = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.round((Date.parse(`${iso()}T00:00:00Z`) - t) / 86400_000);
}

/** Nobody has recorded what the funder said. The default "Not submitted" counts as
 *  nothing said — core/donor_decision.py, and the API's own membership test. */
const noAnswerYet = (r: SubmittedRow) =>
  ["", "not submitted", "none", "nan", "nat", "null"].includes(lower(r.donor_decision));

export default function SubmittedStage({ period, onPickPeriod }: {
  period: Period; onPickPeriod: (p: Period) => void;
}) {
  const { from, to } = rangeOf(period);
  const [data, setData] = useState<Submitted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [notices, setNotices] = useState<Warning[]>([]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchSubmitted(from, to)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this period."))
      .finally(() => setLoading(false));
  }, [from, to]);

  useEffect(load, [load]);

  const rows = data?.rows ?? null;

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const all = rows ?? [];
    if (!term) return all;
    return all.filter((r) =>
      `${r.opportunity_title ?? ""} ${r.funding_agency ?? ""} ${r.uid}`
        .toLowerCase().includes(term));
  }, [rows, q]);

  const kpis = useMemo(() => {
    let longest = 0, noAnswer = 0, noDate = 0;
    for (const r of filtered) {
      const d = waitedSince(r.submitted_on);
      if (d !== null && d > longest) longest = d;
      if (noAnswerYet(r)) noAnswer++;
      if (!r.submitted_on_exact) noDate++;
    }
    return { total: filtered.length, longest, noAnswer, noDate };
  }, [filtered]);

  /** Any field save on one proposal. Always re-fetches — see the file header. */
  const save = useCallback(async (uid: string, fields: Record<string, unknown>) => {
    setSaving(uid);
    setNotices([]);
    try {
      const res = await saveRfpFields(uid, fields);
      setNotices(res.warnings ?? []);
      load();
    } catch (e) {
      setNotices([{
        code: "save_failed",
        detail: e instanceof Error ? e.message : "That change could not be saved.",
      }]);
    } finally {
      setSaving(null);
    }
  }, [load]);

  if (!rows && loading) return <Spinner label={`Loading ${labelOf(period)}…`} />;
  if (error) return <Notice tone="warn" role="alert">{error}</Notice>;

  const total = data?.total ?? 0;
  const elsewhere = Math.max(0, total - (rows?.length ?? 0));

  if (!rows?.length) {
    // "Nothing submitted in October" and "nothing is with a funder at all" look identical
    // on screen and mean opposite things. `total` tells them apart, and because waiting is
    // a state rather than an event, the second question is the one somebody actually has.
    return (
      <Card>
        <EmptyState icon={<Send className="h-5 w-5" />}
          title={`Nothing submitted in ${labelOf(period)}`}>
          {total > 0 ? (
            <>
              <p>
                <strong>{total}</strong> proposal{total === 1 ? " is" : "s are"} still with a
                funder from outside this period
                {data?.oldest && <>, the oldest since <strong>{data.oldest}</strong></>}.
                A wait does not end when the period does.
              </p>
              <p className="mt-3">
                <Button size="sm" onClick={() => onPickPeriod(atGrain(period, "year"))}>
                  Show the whole year
                </Button>
              </p>
            </>
          ) : (
            <p>
              A proposal arrives here once something records it going to the funder — the
              progress set to Completed, a submission date, or any donor decision — and
              leaves when the funder approves or declines it.
            </p>
          )}
        </EmptyState>
      </Card>
    );
  }

  const selected = filtered.find((r) => r.uid === open) ?? null;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Waiting" value={kpis.total} />
        <Kpi label="Longest wait" value={kpis.longest} unit="days"
          tone={kpis.longest >= 90 ? "warn" : undefined} />
        <Kpi label="No answer recorded" value={kpis.noAnswer}
          tone={kpis.noAnswer ? "warn" : undefined} />
        <Kpi label="Submission date missing" value={kpis.noDate} />
      </div>

      {elsewhere > 0 && (
        <div className="mt-3">
          <Notice tone="neutral" icon={<Hourglass className="h-4 w-4" />}>
            {elsewhere} more {elsewhere === 1 ? "proposal is" : "proposals are"} still
            waiting from outside {labelOf(period)}
            {data?.oldest && <> — the longest since {data.oldest}</>}.{" "}
            <button className="font-semibold text-accent-700 underline underline-offset-2"
              onClick={() => onPickPeriod(atGrain(period, "year"))}>
              Show the whole year
            </button>
          </Notice>
        </div>
      )}

      {notices.map((w) => (
        <div className="mt-3" key={w.code}>
          <Notice tone="warn" role="alert" icon={<AlertTriangle className="h-4 w-4" />}>
            {w.detail}
          </Notice>
        </div>
      ))}

      <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-brand-700">
          With a funder <span className="font-normal text-ink-500">({filtered.length})</span>
        </h2>
        <input
          value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter proposals"
          placeholder="Filter by title, funder or uid" className={`${fieldClass} max-w-xs`}
        />
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[54rem] text-sm">
            <thead>
              <tr className="border-b border-ink-200 bg-ink-50 text-left text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
                <th className="px-4 py-3">Opportunity</th>
                <th className="px-4 py-3">Funder</th>
                <th className="px-4 py-3">Lead</th>
                <th className="px-4 py-3">Submitted</th>
                <th className="px-4 py-3">Waiting</th>
                <th className="px-4 py-3">Funder says</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-ink-500">
                  Nothing matches that filter.
                </td></tr>
              )}
              {filtered.map((r) => {
                const on = r.uid === open;
                const days = waitedSince(r.submitted_on);
                return (
                  <tr key={r.uid}
                    className={`border-b border-ink-100 transition-colors last:border-0 ${
                      on ? "bg-brand-50" : "hover:bg-ink-50"}`}>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => setOpen(on ? null : r.uid)} aria-expanded={on}
                        className="text-left font-medium text-brand-700 hover:text-accent-700 hover:underline"
                      >
                        {r.opportunity_title || r.uid}
                      </button>
                      {r.opportunity_link && (
                        <a href={r.opportunity_link} target="_blank" rel="noreferrer"
                          className="ml-1.5 inline-flex text-ink-400 hover:text-accent-700"
                          aria-label="Open the call">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-600">{r.funding_agency || "—"}</td>
                    <td className="px-4 py-3 text-ink-600">{r.proposal_lead || "—"}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-ink-600">
                      {r.submitted_on ?? "—"}
                      {!r.submitted_on_exact && (
                        <span className="ml-1.5 text-xs text-ink-400"
                          title="No submission date recorded — counted from when the opportunity was logged">
                          approx.
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {days === null ? <span className="text-ink-400">—</span> : (
                        <Badge tone={days >= 90 ? "warn" : "neutral"}>
                          {days === 1 ? "1 day" : `${days} days`}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3"><Answer row={r} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {selected && (
        <div className="mt-4">
          <SubmissionDetail row={selected} saving={saving === selected.uid} onSave={save} />
        </div>
      )}
    </>
  );
}

/** What the funder has said, as stored. A value outside the vocabulary is shown as it is
 *  and marked, rather than normalised away — somebody typed it and it means something. */
function Answer({ row }: { row: SubmittedRow }) {
  const v = String(row.donor_decision ?? "").trim();
  if (noAnswerYet(row)) {
    return <span className="text-xs text-gold-700">Nothing recorded</span>;
  }
  const known = v === UNDER_REVIEW;
  return (
    <Badge tone={known ? "accent" : "neutral"}
      className={known ? "" : "border-dashed"}
      {...(known ? {} : { title: "Not one of the four recorded answers" })}>
      {v}
    </Badge>
  );
}

/**
 * One proposal, opened: what is known, what is missing, and the answer form.
 *
 * The three questions are laid out in the order they get asked in real life — did the
 * funder answer, when did this actually go in, and is the application record still saying
 * it was never started. Each is one write.
 */
function SubmissionDetail({ row, saving, onSave }: {
  row: SubmittedRow; saving: boolean;
  onSave: (uid: string, fields: Record<string, unknown>) => void;
}) {
  const [showApproved, setShowApproved] = useState(false);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(row.currency ?? "USD");
  const [on, setOn] = useState(iso());
  const [sentOn, setSentOn] = useState("");
  const days = waitedSince(row.submitted_on);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-brand-700">
            {row.opportunity_title || row.uid}
          </h3>
          <p className="mt-0.5 text-sm text-ink-500">
            {row.funding_agency || "Funder not recorded"} · {row.uid}
            {row.applicant_role && <> · {row.applicant_role}</>}
          </p>
        </div>
        {days !== null && (
          <Badge tone={days >= 90 ? "warn" : "neutral"}>
            {days === 1 ? "1 day" : `${days} days`} with the funder
            {!row.submitted_on_exact && " (approx.)"}
          </Badge>
        )}
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm lg:grid-cols-4">
        <Fact label="Proposal lead" value={row.proposal_lead} />
        <Fact label="Assigned to" value={row.assigned_to} />
        <Fact label="Programme officer" value={row.donor_program_officer} />
        <Fact label="Award expected"
          value={row.expected_award_date?.slice(0, 10) ?? null}
          icon={row.expected_award_date ? <CalendarClock className="h-3.5 w-3.5" /> : undefined} />
        <Fact label="Amount requested" value={money(row.amount_requested, row.currency)} />
        <Fact label="Call value" value={money(row.call_award_value, row.currency)} />
        <Fact label="Times submitted"
          value={row.submissions != null && row.submissions > 0 ? String(row.submissions) : null} />
        <Fact label="Progress" value={row.progress_status} />
      </dl>

      {/* 1 — the answer. The question this stage exists to close. */}
      <section className="mt-6 border-t border-ink-100 pt-5">
        <h4 className="text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
          Has the funder answered?
        </h4>
        <p className="mt-1 text-sm text-ink-600">
          {noAnswerYet(row)
            ? <>Nothing is recorded, so this proposal does not appear in Applied Funding yet.
                Say it is still being considered, or record the outcome.</>
            : <>Recorded as <strong className="text-ink-800">{row.donor_decision}</strong>.
                An outcome moves it on to Outcome.</>}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {lower(row.donor_decision) !== lower(UNDER_REVIEW) && (
            <Button size="sm" disabled={saving}
              onClick={() => onSave(row.uid, { donor_decision: UNDER_REVIEW })}>
              Still under review
            </Button>
          )}
          <Button size="sm" variant="secondary" disabled={saving}
            onClick={() => setShowApproved(!showApproved)} aria-expanded={showApproved}>
            Approved…
          </Button>
          <Button size="sm" variant="secondary" disabled={saving}
            onClick={() => onSave(row.uid, {
              donor_decision: NOT_APPROVED, date_of_approval: iso(),
            })}>
            Not approved
          </Button>
        </div>

        {showApproved && (
          // Amount and date are OPTIONAL. Of the eight already-answered rows, four carry no
          // date_of_approval and three no amount_secured, so a form that insisted on both
          // would stop somebody recording the one fact they actually have.
          <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-accent-200 bg-accent-50/40 p-3">
            <label className="text-xs font-medium text-ink-700">
              <span className="mb-1 block">Amount secured</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal" placeholder="optional"
                className={`${fieldClass} w-36 py-1.5`} />
            </label>
            <label className="text-xs font-medium text-ink-700">
              <span className="mb-1 block">Currency</span>
              <Select value={currency} onChange={(e) => setCurrency(e.target.value)}
                className="w-24 py-1.5">
                {["USD", "EUR", "GBP", "XAF"].map((c) => <option key={c}>{c}</option>)}
              </Select>
            </label>
            <label className="text-xs font-medium text-ink-700">
              <span className="mb-1 block">Approved on</span>
              <input type="date" value={on} onChange={(e) => setOn(e.target.value)}
                className={`${fieldClass} w-40 py-1.5`} />
            </label>
            <Button size="sm" busy={saving}
              onClick={() => onSave(row.uid, {
                donor_decision: APPROVED,
                date_of_approval: on || null,
                ...(amount.trim()
                  ? { amount_secured: Number(amount), currency_secured: currency }
                  : {}),
              })}>
              Record the award
            </Button>
          </div>
        )}
      </section>

      {/* 2 — when it actually went in. Without this the wait above is the intake date. */}
      {!row.submitted_on_exact && (
        <section className="mt-5 border-t border-ink-100 pt-5">
          <h4 className="text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
            When did it go in?
          </h4>
          <p className="mt-1 text-sm text-ink-600">
            No submission date is recorded, so the wait above is counted from{" "}
            {row.submitted_on ?? "the intake date"}, when the opportunity was logged.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <input type="date" value={sentOn} onChange={(e) => setSentOn(e.target.value)}
              aria-label="Date submitted" className={`${fieldClass} w-40 py-1.5`} />
            <Button size="sm" disabled={saving || !sentOn}
              onClick={() => onSave(row.uid, { date_completed: sentOn })}>
              Record the date
            </Button>
          </div>
        </section>
      )}

      {/* 3 — the record left behind. Not an error, just never walked forward. */}
      {PRE_SUBMISSION.has(String(row.stage ?? "").trim()) && (
        <section className="mt-5 border-t border-ink-100 pt-5">
          <h4 className="text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
            Application stage
          </h4>
          <p className="mt-1 text-sm text-ink-600">
            Still recorded as <strong className="text-ink-800">{row.stage}</strong>, though
            the proposal has gone in. Moving it keeps the Bidding progress bar honest when
            anyone looks back.
          </p>
          <Button size="sm" variant="secondary" className="mt-3" disabled={saving}
            onClick={() => onSave(row.uid, { stage: FOLLOW_UP })}>
            Move to {FOLLOW_UP}
          </Button>
        </section>
      )}
    </Card>
  );
}

/** Plain grouping, no FX. The rates live behind /scoring/snapshot and a second source here
 *  would drift from the one the rest of the app converts with. */
function money(v: number | null, currency: string | null): string | null {
  if (v == null || Number.isNaN(Number(v))) return null;
  const n = Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return `${n}${currency?.trim() ? ` ${currency.trim().split(/\s+/)[0]}` : ""}`;
}

function Fact({ label, value, icon }: {
  label: string; value: string | null | undefined; icon?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 flex items-start gap-1.5 text-ink-700">
        {icon}<span className="min-w-0 break-words">{value?.trim() || "—"}</span>
      </dd>
    </div>
  );
}

function Kpi({ label, value, unit, tone }: {
  label: string; value: number; unit?: string; tone?: "good" | "warn";
}) {
  const colour = tone === "good" ? "text-good-700" : tone === "warn" ? "text-gold-700" : "text-brand-700";
  return (
    <Card className="px-4 py-3">
      <div className="text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${colour}`}>
        {value}{unit && <span className="ml-1 text-sm font-semibold">{unit}</span>}
      </div>
    </Card>
  );
}
