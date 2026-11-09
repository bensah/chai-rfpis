/**
 * Outcome — what the funder decided, and what it was worth.
 *
 * The end of the line, and the only stage whose subject is money rather than work. Three
 * things about it are deliberate:
 *
 *   * EVERY COUNT IS SUBMISSION-WEIGHTED. A proposal submitted to a funder twice is two
 *     applications (`core/records.py::submission_weight`), and one live row carries
 *     `submissions = 2` — so counting rows would show 4 losses where the Streamlit Applied
 *     Funding page shows 5. The weight is the API's; this page only displays it, and says
 *     so wherever the number differs from the number of rows on screen.
 *
 *   * THE WIN RATE IS OVER DECIDED APPLICATIONS, not everything submitted. This stage shows
 *     only answers, so "when a funder answers, how often is it yes" is the question its
 *     denominator can honestly carry — 44% live. The Funding page divides by everything
 *     including what is still pending and gets 17%. Both are right for their page, so the
 *     pending count sits beside it rather than leaving two numbers nobody can tie together.
 *
 *   * MONEY IS CONVERTED SERVER-SIDE. Not because the browser could not, but because the
 *     rates live where the fetch is, and a win/loss total that depended on the Pyodide
 *     scoring snapshot would stop working the day that seam is retired.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Trophy, X } from "lucide-react";
import { fetchOutcome, type Outcome, type OutcomeRow } from "../api";
import OpportunityCell from "../opportunity/OpportunityCell";
import RfpEditor from "../opportunity/RfpEditor";
import { atGrain, labelOf, rangeOf, type Period } from "./period";
import { Badge, Card, Button, EmptyState, Notice, Spinner, fieldClass } from "../ui";

const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
const won = (r: OutcomeRow) => lower(r.donor_decision) === "approved";

/** Whole dollars. These are totals people read, not amounts they reconcile to the cent,
 *  and a column of figures with pennies in it is harder to compare at a glance. */
const usd = (v: number) =>
  `$${Math.round(v).toLocaleString("en-US")}`;

/** Compact for the KPI tiles, where $38,992,206 does not fit and $39.0M does. */
function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `$${Math.round(v / 1000)}k`;
  return `$${Math.round(v)}`;
}

export default function OutcomeStage({ period, onPickPeriod }: {
  period: Period; onPickPeriod: (p: Period) => void;
}) {
  const { from, to } = rangeOf(period);
  const [data, setData] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "won" | "lost">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [editUid, setEditUid] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchOutcome(from, to)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this period."))
      .finally(() => setLoading(false));
  }, [from, to]);

  useEffect(load, [load]);

  const rows = data?.rows ?? null;

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    let all = rows ?? [];
    if (only !== "all") all = all.filter((r) => (only === "won") === won(r));
    if (!term) return all;
    return all.filter((r) =>
      `${r.opportunity_title ?? ""} ${r.funding_agency ?? ""} ${r.uid}`
        .toLowerCase().includes(term));
  }, [rows, q, only]);

  if (!rows && loading) return <Spinner label={`Loading ${labelOf(period)}…`} />;
  if (error) return <Notice tone="warn" role="alert">{error}</Notice>;

  const c = data?.counts;
  const m = data?.money;

  if (!rows?.length) {
    return (
      <Card>
        <EmptyState icon={<Trophy className="h-5 w-5" />}
          title={`No funder answered in ${labelOf(period)}`}>
          {data && data.total > 0 ? (
            <>
              <p>
                <strong>{data.total}</strong> application
                {data.total === 1 ? " has" : "s have"} been answered outside this period
                {data.latest && <>, most recently on <strong>{data.latest}</strong></>}.
              </p>
              <p className="mt-3">
                <Button size="sm" onClick={() => onPickPeriod(atGrain(period, "year"))}>
                  Show the whole year
                </Button>
              </p>
            </>
          ) : (
            <p>
              An application arrives here when its funder decision is set to Approved or
              Not Approved. {c && c.pending > 0 && (
                <>Right now <strong>{c.pending}</strong> are still waiting for an answer —
                  they are on the Submitted stage.</>
              )}
            </p>
          )}
        </EmptyState>
      </Card>
    );
  }

  const selected = filtered.find((r) => r.uid === open) ?? null;
  const decided = c ? c.approved + c.notApproved : 0;
  const rate = decided ? Math.round((c!.approved / decided) * 100) : 0;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Won" value={String(c?.approved ?? 0)} tone="good"
          note={c && c.approved !== filtered.filter(won).length
            ? `${filtered.filter(won).length} rows` : undefined} />
        <Kpi label="Not approved" value={String(c?.notApproved ?? 0)}
          note={c && c.notApproved !== filtered.filter((r) => !won(r)).length
            ? `${filtered.filter((r) => !won(r)).length} rows` : undefined} />
        <Kpi label="Secured" value={compact(m?.secured ?? 0)} tone="good"
          note={m ? usd(m.secured) : undefined} />
        <Kpi label="Lost" value={compact(m?.unsecured ?? 0)}
          note={m ? `${usd(m.unsecured)} requested` : undefined} />
      </div>

      {/* The win rate is a sentence rather than a tile, because the denominator is the
          whole story and a bare "44%" invites being read as the Funding page's 17%. */}
      {c && (
        <div className="mt-3">
          <Notice tone="neutral">
            <strong className="text-brand-700">{rate}%</strong> of answered applications
            were approved — {c.approved} of {decided} in {labelOf(period)}.
            {c.pending > 0 && (
              <> Another <strong>{c.pending}</strong> {c.pending === 1 ? "is" : "are"} still
                with a funder and not counted here.</>
            )}
            {c.applications !== filtered.length && (
              <span className="block mt-1 text-xs text-ink-500">
                Counts are applications, not rows: a proposal submitted more than once
                counts each time. {filtered.length} rows,{" "}
                {c.applications} applications.
              </span>
            )}
          </Notice>
        </div>
      )}

      {data?.ledgerGap?.length ? (
        <div className="mt-3">
          <Notice tone="warn" role="alert" icon={<AlertTriangle className="h-4 w-4" />}>
            {data.ledgerGap.length} answered application
            {data.ledgerGap.length === 1 ? "" : "s"} count{data.ledgerGap.length === 1 ? "s" : ""}{" "}
            as zero in the totals above, because the progress is not marked Completed. A
            funder cannot answer a proposal it never received, so the progress field is
            stale — open the row and set it. Nothing here changes it for you: a donor
            decision alone once resurrected counts that were deliberately reset.
          </Notice>
        </div>
      ) : null}

      <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-brand-700">
          Answered <span className="font-normal text-ink-500">({filtered.length})</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-ink-200 p-0.5" role="group"
            aria-label="Filter by outcome">
            {([["all", "All"], ["won", "Won"], ["lost", "Not approved"]] as const)
              .map(([k, label]) => (
                <button key={k} onClick={() => setOnly(k)}
                  aria-pressed={only === k}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    only === k ? "bg-brand-700 text-white" : "text-ink-600 hover:bg-ink-50"}`}>
                  {label}
                </button>
              ))}
          </div>
          <input
            value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter applications"
            placeholder="Filter by title, funder or uid" className={`${fieldClass} max-w-xs`}
          />
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead>
              <tr className="border-b border-ink-200 bg-ink-50 text-left text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
                <th className="px-4 py-3">Opportunity</th>
                <th className="px-4 py-3">Funder</th>
                <th className="px-4 py-3">Answered</th>
                <th className="px-4 py-3">Outcome</th>
                <th className="px-4 py-3 text-right">Requested</th>
                <th className="px-4 py-3 text-right">Secured</th>
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
                const yes = won(r);
                return (
                  <tr key={r.uid}
                    className={`border-b border-ink-100 transition-colors last:border-0 ${
                      on ? "bg-brand-50" : "hover:bg-ink-50"}`}>
                    <td className="px-4 py-3">
                      <OpportunityCell uid={r.uid} title={r.opportunity_title}
                        link={r.opportunity_link} onEdit={setEditUid}
                        expanded={on} onToggle={() => setOpen(on ? null : r.uid)}
                      >
                        {r.applications > 1 && (
                          <span className="ml-1.5 text-xs text-ink-500"
                            title="Submitted to the funder more than once — counts each time">
                            ×{r.applications}
                          </span>
                        )}
                      </OpportunityCell>
                    </td>
                    <td className="px-4 py-3 text-ink-600">{r.funding_agency || "—"}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-ink-600">
                      {r.outcome_on ?? "—"}
                      {!r.date_of_approval && (
                        <span className="ml-1.5 text-xs text-ink-400"
                          title="No answer date recorded — taken from the submission or intake date">
                          approx.
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={yes ? "good" : "bad"}>
                        {yes ? "Approved" : "Not approved"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                      {r.usd_requested ? usd(r.usd_requested) : "—"}
                    </td>
                    <td className={`px-4 py-3 text-right tabular-nums font-medium ${
                      r.usd_secured ? "text-good-700" : "text-ink-400"}`}>
                      {r.usd_secured ? usd(r.usd_secured) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {selected && (
        <div className="mt-4"><OutcomeDetail row={selected} /></div>
      )}

      {m && Object.keys(m.rates).length > 0 && (
        <p className="mt-3 text-xs text-ink-500">
          Non-USD amounts converted at{" "}
          {Object.entries(m.rates)
            .filter(([, [rate]]) => rate)
            .map(([cur, [rate, when]]) =>
              `${cur} ${Number(rate).toFixed(4)}${when ? ` (${when})` : ""}`)
            .join(", ") || "the table rates"}.
        </p>
      )}
      {editUid && (
        <RfpEditor uid={editUid} onClose={() => setEditUid(null)} onSaved={load} />
      )}
    </>
  );
}

/** One answered application. No actions: the answer is the end of this stage's work, and
 *  changing it belongs where it was recorded. The editor owns reporting. */
function OutcomeDetail({ row }: { row: OutcomeRow }) {
  const yes = won(row);
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
        <Badge tone={yes ? "good" : "bad"}>
          {yes ? <Trophy className="mr-1 h-3.5 w-3.5" /> : <X className="mr-1 h-3.5 w-3.5" />}
          {yes ? "Approved" : "Not approved"}
        </Badge>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm lg:grid-cols-4">
        <Fact label="Answered on" value={row.outcome_on} />
        <Fact label="Submitted on" value={row.date_completed?.slice(0, 10) ?? null} />
        <Fact label="Proposal lead" value={row.proposal_lead} />
        <Fact label="Programme officer" value={row.donor_program_officer} />
        <Fact label="Requested"
          value={row.amount_requested != null
            ? `${Number(row.amount_requested).toLocaleString("en-US")} ${row.currency_secured?.trim() || row.currency?.trim() || ""}`.trim()
            : null} />
        <Fact label="Secured"
          value={yes && row.amount_secured != null
            ? `${Number(row.amount_secured).toLocaleString("en-US")} ${row.currency_secured?.trim() ?? ""}`.trim()
            : null} />
        <Fact label="Kick-off" value={row.kickoff_date?.slice(0, 10) ?? null} />
        <Fact label="Duration" value={row.project_duration} />
      </dl>

      {yes && row.amount_secured == null && (
        <p className="mt-4 text-sm text-gold-700">
          Approved, but no amount is recorded — so this award adds nothing to Secured above.
        </p>
      )}
      {row.applications === 0 && (
        <p className="mt-4 text-sm text-gold-700">
          The progress on this row is “{row.progress_status || "not set"}”, so the
          submission ledger counts it as zero applications and it is missing from the totals.
        </p>
      )}
      {row.applications > 1 && (
        <p className="mt-4 text-sm text-ink-500">
          Submitted {row.applications} times, so it counts {row.applications} times in the
          figures above.
        </p>
      )}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 text-ink-700"><span className="break-words">{value?.trim() || "—"}</span></dd>
    </div>
  );
}

function Kpi({ label, value, note, tone }: {
  label: string; value: string; note?: string; tone?: "good" | "warn";
}) {
  const colour = tone === "good" ? "text-good-700" : tone === "warn" ? "text-gold-700" : "text-brand-700";
  return (
    <Card className="px-4 py-3">
      <div className="text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${colour}`}>{value}</div>
      {note && <div className="mt-0.5 text-xs text-ink-500 tabular-nums">{note}</div>}
    </Card>
  );
}
