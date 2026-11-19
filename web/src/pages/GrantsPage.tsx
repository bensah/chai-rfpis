/**
 * Applications (views/outcomes.py — "Your Applied Funding").
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Briefcase, ChevronLeft, ChevronRight, ExternalLink, RotateCw, Search,
} from "lucide-react";
import {
  ApiError, fetchGrants, type Grants, type GrantSelection, type GrantWindow,
} from "../api";
import { hrefOf, Link } from "../router";
import { Badge, Card, EmptyState, Notice, PageHeader, Select, Spinner, field } from "../ui";
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

/** The window buttons, in the order they are drawn. */
const WINDOWS: [GrantWindow, string][] = [
  ["all", "Whole period"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["90d", "Last 90 days"],
  ["365d", "Last 365 days"],
];

export default function GrantsPage() {
  const [data, setData] = useState<Grants | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  /**
   * Opens on the CURRENT YEAR, whole period — "default will be the current date" (owner,
   * 2026-11-16). The year is read from the browser's clock rather than waited for from the
   * server, so the first request already asks for the right window; `offeredYears` always
   * includes the current year, so this can never name one the server will reject.
   */
  const [sel, setSel] = useState<GrantSelection>(
    { window: "all", year: new Date().getFullYear(), quarter: null });
  const [readAt, setReadAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  // Keeps the LAST selection the page actually displayed, so a reload triggered by a tab
  // regaining focus asks for the same window rather than whatever the closure captured.
  const selRef = useRef(sel);
  selRef.current = sel;

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const d = await fetchGrants(selRef.current);
      setData(d);
      setReadAt(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load applied funding.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, sel]);

  /**
   * RE-READ WHEN THE TAB COMES BACK, which is this page's answer to "the table didn't
   * change after I edited a bid" (owner, 2026-11-16).
   *
   * Every figure here is an aggregate the server computes, and the page used to read them
   * once on mount. Editing a call in the Streamlit app, or in a second tab, left this one
   * showing the figures from before the edit with nothing saying they were old. Nothing in
   * the browser notices a row changing in Postgres, so the honest options are to poll or
   * to re-read at the moments a reader expects fresh numbers; this takes the second.
   * `visibilitychange` covers coming back to the tab, `focus` covers returning to the
   * window with the tab already showing, and the Refresh control covers an edit made with
   * this page in view the whole time. The caption says when the figures were read, so a
   * number on screen can always be dated.
   */
  useEffect(() => {
    const again = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
    };
  }, [load]);

  /**
   * The server already ordered `rows` newest first by the date it filters on, so this page
   * does not re-sort them. It used to — Approved, then pending, then the rest — which was
   * this author's guess at what a reader wants at the top and not what was asked for.
   *
   * The ordering lives on the server now because TWO things read it: this list and the
   * picker's default, which took `rows[0]` from the RAW server order while the dropdown
   * listed the re-sorted one. They disagreed, so opening the page selected a bid from the
   * middle of the list and the dropdown appeared to have chosen at random.
   */
  const ordered = data?.rows ?? [];

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

  const c = data.counts;
  const periodBar = (
    <PeriodBar sel={sel} years={data.years} busy={busy} readAt={readAt}
      hidden={data.hiddenByPeriod} label={data.period.label}
      onChange={(next) => { setSel(next); setPage(1); setPicked(null); }}
      onRefresh={() => void load()} />
  );

  // AN EMPTY WINDOW IS NOT AN EMPTY LOG, and the two need different words. The first is a
  // filter the reader can clear; the second is a page that has nothing to show yet, and
  // offering a period picker over it would be absurd.
  if (!data.rows.length) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Applications"
          lead="Every application sent to a funder — approved, awaiting an answer, and declined."
        />
        {data.hiddenByPeriod > 0 && periodBar}
        <EmptyState icon={<Briefcase size={28} aria-hidden />}
          title={data.hiddenByPeriod > 0 ? `No bids submitted in ${data.period.label}` : "No bids submitted yet"}>
          {data.hiddenByPeriod > 0 ? (
            <>
              {fmtInt(data.hiddenByPeriod)} submitted {data.hiddenByPeriod === 1 ? "bid falls" : "bids fall"}{" "}
              outside this window. Widen it above to see them.
            </>
          ) : (
            <>
              An application shows up here once it has been <strong>submitted</strong> to a funder —
              its decision is Approved, Under Review or Not Approved, or its progress is marked
              <strong> Completed</strong>.
            </>
          )}
        </EmptyState>
      </div>
    );
  }

  const g = ordered.find((r) => r.uid === picked) ?? ordered[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Applications"
        lead="Every application sent to a funder — approved, awaiting an answer, and declined."
      />

      {periodBar}

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
            {/* Newest first, in the server's order — the same order the list is filtered
                and counted in. The date is on the option because the list is sorted by it
                and an ordering a reader cannot see is one they will think is broken. */}
            <Select value={g.uid} onChange={(e) => setPicked(e.target.value)}>
              {ordered.map((r) => (
                <option key={r.uid} value={r.uid}>
                  {r.periodDate ?? "undated"} · {r.title} · {r.uid} · {r.status || dash}
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
            {/* The stored column, and then — only when it is empty — what stood in for it
                in the ordering and the filter. Showing the stand-in as if it were the
                answer would be a date the app invented. */}
            <Fact label="Date submitted" value={g.dateSubmitted ?? (
              g.periodDate
                ? <span className="text-ink-500">{g.periodDate}{" "}
                    <span className="text-xs text-ink-400">
                      ({g.dateSource === "deadline" ? "its deadline" : "logged"}, not recorded)
                    </span>
                  </span>
                : dash
            )} />
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
              className={field("w-56 pl-8")} />
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

/**
 * The window every figure on this page was computed for.
 *
 * TWO CONTROLS, AND THEY ARE NOT THE SAME KIND OF THING (owner, 2026-11-16). The rolling
 * windows are BUTTONS, because they are the common move — one click, no dropdown to open
 * and read — and a row of them shows at a glance which one is active. The year is a
 * dropdown beside them, because it is a different question: not "how far back" but "back
 * from when". Putting both in one list made them look like alternatives and made the year
 * list look hard-coded, which is what prompted a fair question about what happens in 2027.
 *
 * It does not need to happen. The years come from the rows plus today's date, so the list
 * grows on its own; a year after this one is never offered, because no bid can be in it.
 *
 * It sits ABOVE the tiles because it governs them. A filter placed beside the list it
 * obviously narrows, with aggregates above it, invites exactly the reading it should
 * prevent — that the tiles are the whole log and the list is a slice of it.
 *
 * The quarter picker appears only for a whole year, because "Q2, last 30 days" is two
 * windows fighting and the page does not offer it.
 */
function PeriodBar({ sel, years, busy, readAt, hidden, label, onChange, onRefresh }: {
  sel: GrantSelection; years: number[]; busy: boolean; readAt: Date | null;
  hidden: number; label: string;
  onChange: (s: GrantSelection) => void; onRefresh: () => void;
}) {
  const thisYear = new Date().getFullYear();
  return (
    <Card className="p-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div>
          <span className="mb-1 block text-xs font-semibold text-ink-600">Window</span>
          <div role="group" aria-label="Period" className="flex flex-wrap gap-1">
            {WINDOWS.map(([k, text]) => {
              const on = sel.window === k;
              return (
                <button key={k} type="button" aria-pressed={on}
                  onClick={() => onChange({ ...sel, window: k, quarter: k === "all" ? sel.quarter : null })}
                  className={`rounded-lg border px-2.5 py-1.5 text-sm transition-colors ${on
                    ? "border-accent-600 bg-accent-600 font-semibold text-white"
                    : "border-ink-300 text-ink-700 hover:border-accent-600 hover:text-accent-700"}`}>
                  {text}
                </button>
              );
            })}
          </div>
        </div>

        <label className="min-w-0">
          <span className="mb-1 block text-xs font-semibold text-ink-600">Year</span>
          <Select
            value={sel.year ? String(sel.year) : ""}
            onChange={(e) => {
              const y = e.target.value ? Number(e.target.value) : null;
              onChange({ ...sel, year: y, quarter: y ? sel.quarter : null });
            }}
            className="w-40"
          >
            <option value="">Every year</option>
            {years.map((y) => (
              <option key={y} value={y}>{y === thisYear ? `${y} · this year` : y}</option>
            ))}
          </Select>
        </label>

        {sel.window === "all" && sel.year !== null && (
          <label className="min-w-0">
            <span className="mb-1 block text-xs font-semibold text-ink-600">Quarter</span>
            <Select
              value={sel.quarter ? String(sel.quarter) : ""}
              onChange={(e) => onChange({ ...sel, quarter: e.target.value ? Number(e.target.value) : null })}
              className="w-40"
            >
              <option value="">Whole year</option>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>Q{n} ({["Jan–Mar", "Apr–Jun", "Jul–Sep", "Oct–Dec"][n - 1]})</option>
              ))}
            </Select>
          </label>
        )}

        <button type="button" onClick={onRefresh} disabled={busy}
          className="mb-0.5 inline-flex items-center gap-1.5 rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-700 transition-colors hover:border-accent-600 hover:text-accent-700 disabled:text-ink-300">
          <RotateCw size={14} aria-hidden className={busy ? "animate-spin" : ""} />
          {busy ? "Reading…" : "Refresh"}
        </button>
      </div>

      {/* Its own line rather than squeezed beside the controls: it has to say three
          separate things — what the window is, that it governs the whole page, and when
          the figures were read — and a caption nobody finishes reading is one that will
          not stop somebody comparing a filtered tile with an unfiltered memory. */}
      <p className="mt-2.5 border-t border-ink-100 pt-2 text-xs text-ink-500">
        Showing <strong>{label}</strong>, by the date each bid was completed. Every figure
        on this page is for this window — the tiles, the money, the win rate, the
        application list and the by-funder table.
        {sel.year !== null && sel.year !== thisYear && sel.window !== "all" && (
          <> A past year's rolling window ends on 31 December of that year.</>
        )}
        {hidden > 0 && <> {fmtInt(hidden)} submitted {hidden === 1 ? "bid falls" : "bids fall"} outside it.</>}
        {readAt && <span className="text-ink-400"> Read at {readAt.toLocaleTimeString()}; it re-reads when you come back to this tab.</span>}
      </p>
    </Card>
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
