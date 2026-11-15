/**
 * Bids Submitted (views/outcomes.py — "Your Applied Funding").
 *
 * Every application ever sent to a funder, declined ones included. It is a RECORD, not a
 * list of wins: dropping the losses would make the win rate it reports meaningless.
 *
 * NOT THE PIPELINE'S OUTCOME STAGE. That stage answers "what did funders decide in this
 * window"; this page is the whole log, with pending applications in it and no window at
 * all. Live, the two win rates are 17% here and 44% there, and both are correct — they
 * divide by different things. The Pipeline's own page says the same from its side.
 *
 * THREE COUNTS OF "AN APPLICATION" APPEAR ON THIS PAGE and they do not reconcile:
 * distinct rows, the weighted count the KPI strip uses, and the raw `submissions` column
 * the by-funder table sums. The server computes all three; this page LABELS which is which
 * rather than quietly picking one, because a reader who adds the by-funder column up and
 * compares it to the headline deserves to find out why they differ from the page itself.
 */
import { useEffect, useMemo, useState } from "react";
import { Briefcase, ChevronLeft, ChevronRight, ExternalLink, Search } from "lucide-react";
import { ApiError, fetchGrants, type GrantRow, type Grants } from "../api";
import { hrefOf, Link } from "../router";
import { Badge, Card, EmptyState, Notice, PageHeader, Select, Spinner, fieldClass } from "../ui";
import { DataTable, fmtInt, fmtUsd, Tile, Tiles } from "../report/charts";

const dash = "—";
const PAGE_SIZE = 10;

/** The three decisions, in the app's status colours. A blank is none of them. */
function StatusBadge({ status }: { status: string }) {
  const k = status.trim().toLowerCase();
  const tone = k === "approved" ? "good" : k === "not approved" ? "bad" : k === "under review" ? "warn" : "neutral";
  return <Badge tone={tone}>{status || dash}</Badge>;
}

/** The amount as entered, beside its conversion — never the conversion alone.
 *
 *  Showing only the USD made this page look like it disagreed with the editor: a CAD
 *  715,400 request rendered as "$509,530 USD" with nothing on screen saying a conversion
 *  had happened at all. */
function Amount({ usd, native, currency }: { usd: number; native: number | null; currency: string }) {
  const cur = currency.trim().toUpperCase();
  const converted = native !== null && cur && cur !== "USD";
  return (
    <span>
      <span className="font-semibold tabular-nums text-brand-700">{fmtUsd(usd)}</span>
      {converted && (
        <span className="ml-1.5 text-xs text-ink-400 tabular-nums">
          ({native.toLocaleString("en-US")} {cur})
        </span>
      )}
    </span>
  );
}

export default function GrantsPage() {
  const [data, setData] = useState<Grants | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    let live = true;
    fetchGrants()
      .then((d) => { if (live) { setData(d); setPicked(d.rows[0]?.uid ?? null); } })
      .catch((e) => live && setError(e instanceof ApiError ? e.message : "Couldn't load applied funding."));
    return () => { live = false; };
  }, []);

  /**
   * Approved first, then pending, then the rest; within each, by deadline descending.
   * The page's own order — what a reader wants at the top is what has been won, and after
   * that what is still in play.
   */
  const ordered = useMemo(() => {
    if (!data) return [];
    const rank = (g: GrantRow) => (g.approved ? 2 : g.pending ? 1 : 0);
    return [...data.rows].sort((a, b) =>
      rank(b) - rank(a) || String(b.deadline ?? "").localeCompare(String(a.deadline ?? "")));
  }, [data]);

  const funders = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return needle ? data.byFunder.filter((f) => f.funder.toLowerCase().includes(needle)) : data.byFunder;
  }, [data, q]);
  const funderTotal = useMemo(
    () => (data ? data.byFunder.reduce((a, f) => a + f.submissions, 0) : 0), [data]);
  const pages = Math.max(1, Math.ceil(funders.length / PAGE_SIZE));
  const cur = Math.min(page, pages);
  const shown = funders.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);

  if (error) return <EmptyState title="Applied funding is unavailable">{error}</EmptyState>;
  if (!data) return <Spinner label="Loading applied funding…" />;
  if (!data.rows.length) {
    return (
      <EmptyState icon={<Briefcase size={28} aria-hidden />} title="No bids submitted yet">
        An application shows up here once it has been <strong>submitted</strong> to a funder —
        its decision is Approved, Under Review or Not Approved, or its progress is marked
        <strong> Completed</strong>.
      </EmptyState>
    );
  }

  const g = ordered.find((r) => r.uid === picked) ?? ordered[0];
  const c = data.counts;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bids Submitted"
        lead="Every application sent to a funder — approved, awaiting an answer, and declined."
      />

      {/* Counts and money on separate rows, as the page has them: a dollar figure beside a
          count invites reading one as the other. */}
      <Tiles>
        <Tile label="Total submitted" value={fmtInt(c.submitted)}
          note={`${fmtInt(c.rows)} calls · ${data.winRate.toFixed(0)}% win rate`} />
        <Tile label="Approved" value={fmtInt(c.approved)} tone="good" />
        <Tile label="Under review" value={fmtInt(c.pending)} tone="warn"
          note="awaiting the funder" />
        <Tile label="Not approved" value={fmtInt(c.notApproved)} tone="bad" />
      </Tiles>
      <Tiles>
        <Tile label="Requested" value={fmtUsd(data.money.requested)} />
        <Tile label="Secured" value={fmtUsd(data.money.secured)} tone="good"
          note="on approved applications" />
        <Tile label="Unsecured" value={fmtUsd(data.money.unsecured)} tone="bad"
          note="asked for and refused" />
        <Tile label="Still in play" value={fmtUsd(data.money.balance)}
          note="requested − secured − unsecured" />
      </Tiles>

      {data.ledgerGap.length > 0 && (
        <Notice tone="warn">
          <strong>{data.ledgerGap.length} answered {data.ledgerGap.length === 1 ? "application counts" : "applications count"} as zero
          in the totals above</strong>, because {data.ledgerGap.length === 1 ? "its progress" : "their progress"} never
          reached Completed: <code className="font-mono text-xs">{data.ledgerGap.join(", ")}</code>.
          Reported rather than corrected here — setting Completed because a decision implies it
          is what put retired calls back in the pipeline once before. Fix it on the call itself.
        </Notice>
      )}

      {/* ── One application ─────────────────────────────────────────────── */}
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-xs font-semibold text-ink-600">Pick an application</span>
            <Select value={g.uid} onChange={(e) => setPicked(e.target.value)}>
              {ordered.map((r) => (
                <option key={r.uid} value={r.uid}>
                  {r.title} · {r.uid} · {r.status || dash}
                </option>
              ))}
            </Select>
          </label>
          <StatusBadge status={g.status} />
        </div>

        <div className="border-t border-ink-100 pt-3">
          <h3 className="text-base font-bold text-brand-700">{g.title}</h3>
          <p className="mt-0.5 text-xs text-ink-500">
            <code className="font-mono">{g.uid}</code> · {g.funder}
            {g.deadline && <> · deadline {g.deadline}</>}
            {g.link && (
              <> · <a href={g.link} target="_blank" rel="noreferrer noopener"
                className="inline-flex items-center gap-0.5 text-accent-700 underline hover:text-accent-800">
                the call <ExternalLink size={11} aria-hidden />
              </a></>
            )}
          </p>

          <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Role" value={g.role || dash} />
            <Fact label="Lead applicant" value={g.leadApplicant} />
            <Fact label="Sub applicant" value={g.subApplicant} />
            <Fact label="Proposal lead" value={g.proposalLead || dash} />
            <Fact label="Date submitted" value={g.dateSubmitted ?? dash} />
            <Fact label="Funder's decision date" value={g.expectedAward ?? dash} />
            <Fact label="Requested"
              value={<Amount usd={g.usdRequested} native={g.amountRequested} currency={g.requestCurrency} />} />
            <Fact label="Secured"
              value={g.usdSecured > 0
                ? <Amount usd={g.usdSecured} native={g.amountSecured} currency={g.securedCurrency} />
                : <span className="text-ink-400">{dash}</span>} />
            {g.geography.length > 0 && (
              <div className="sm:col-span-2 lg:col-span-4">
                <dt className="text-xs text-ink-500">Geography</dt>
                <dd className="mt-1 flex flex-wrap gap-1">
                  {g.geography.map((x) => <Badge key={x}>{x}</Badge>)}
                </dd>
              </div>
            )}
          </dl>

          <p className="mt-4 border-t border-ink-100 pt-3 text-xs text-ink-500">
            {/* The editor is the Opportunity page's, not a second one here: a second editor
                is a second set of write rules to keep in step with the first. */}
            <Link to={hrefOf("opportunity", { uid: g.uid })}
              className="font-semibold text-accent-700 underline hover:text-accent-800">
              Open this call
            </Link>
            {" "}to change its decision, amounts or reporting.
          </p>
        </div>
      </Card>

      {/* ── By funder ───────────────────────────────────────────────────── */}
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-brand-700">Applications by funder</h3>
            {/* The direction of the gap is NOT fixed, so the caption must not claim one.
                Two rules pull opposite ways: a row that never reached Completed is weighted
                zero in the strip and still counts here, while a row recording fewer than one
                submission is floored up to one application in the strip and left at zero
                here. Today the second wins and this column totals LOWER. */}
            <p className="mt-0.5 text-xs text-ink-500">
              Declined applications included. <strong>Calls</strong> counts distinct rows;{" "}
              <strong>Submissions</strong> sums each row's own submission count, with no
              progress check and no floor — so it totals{" "}
              {funderTotal === c.submitted ? "the same as" : funderTotal < c.submitted ? "less than" : "more than"}{" "}
              the {fmtInt(c.submitted)} applications in the strip above
              {funderTotal === c.submitted ? "" : ` (${fmtInt(funderTotal)})`}.
            </p>
          </div>
          <label className="relative">
            <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
            <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }}
              placeholder="Find a funder" aria-label="Find a funder"
              className={`${fieldClass} w-56 pl-8`} />
          </label>
        </div>

        <DataTable
          rows={shown} keyOf={(f) => f.funder} empty="No funder matches that."
          cols={[
            { head: "Funder", cell: (f) => <span className="text-ink-700">{f.funder}</span> },
            { head: "Calls", align: "right", cell: (f) => fmtInt(f.rfps) },
            { head: "Submissions", align: "right", cell: (f) => fmtInt(f.submissions) },
            { head: "Approved", align: "right", cell: (f) => <span className="text-good-700">{fmtInt(f.approved)}</span> },
            { head: "Under review", align: "right", cell: (f) => fmtInt(f.pending) },
            { head: "Not approved", align: "right", cell: (f) => <span className="text-bad-600">{fmtInt(f.notApproved)}</span> },
            { head: "Requested", align: "right", cell: (f) => fmtUsd(f.requested) },
            { head: "Secured", align: "right", cell: (f) => f.secured > 0
              ? <span className="font-semibold text-good-700">{fmtUsd(f.secured)}</span>
              : <span className="text-ink-400">{dash}</span> },
          ]}
        />

        {pages > 1 && (
          <div className="mt-3 flex items-center justify-center gap-4 border-t border-ink-100 pt-3 text-sm">
            <button type="button" onClick={() => setPage(cur - 1)} disabled={cur === 1}
              className="inline-flex items-center gap-1 text-ink-600 disabled:text-ink-300 hover:text-accent-700">
              <ChevronLeft size={15} aria-hidden /> Previous
            </button>
            <span className="text-xs text-ink-500 tabular-nums">
              Page {cur} of {pages} · {funders.length} funder{funders.length === 1 ? "" : "s"}
            </span>
            <button type="button" onClick={() => setPage(cur + 1)} disabled={cur >= pages}
              className="inline-flex items-center gap-1 text-ink-600 disabled:text-ink-300 hover:text-accent-700">
              Next <ChevronRight size={15} aria-hidden />
            </button>
          </div>
        )}

        {Object.keys(data.rates).length > 1 && (
          <p className="mt-3 border-t border-ink-100 pt-2.5 text-xs text-ink-400">
            Converted at{" "}
            {Object.entries(data.rates).filter(([k]) => k !== "USD")
              .map(([k, [rate, asOf]]) => `${k} ${rate?.toFixed(4) ?? "?"}${asOf ? ` (${asOf})` : " (table)"}`)
              .join(", ")}.
          </p>
        )}
      </Card>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink-800">{value}</dd>
    </div>
  );
}
