/**
 * Dashboard — the whole pipeline in one screen.
 *
 * This page used to be a welcome, eight counters and a grid of "Where to start" cards that
 * repeated the left sidebar link for link. The owner's instruction (2026-11-09) was to put
 * Streamlit's Summary here instead of adding it as a sixth Pipeline tab, and to drop the
 * quick-start grid: the rail already says where to start, and saying it twice on the one
 * page that should be showing results is how a dashboard ends up with no data on it.
 *
 * THE FIGURES ARE A PARTITION, NOT A PILE. Each band below divides the one above it, so a
 * reader can check the arithmetic by eye:
 *
 *     found          = awaiting review + proceed + parked + declined
 *     sent to funder = awaiting answer + approved + not approved
 *
 * That matters because the old cards did not add up and said so in public: the Dashboard
 * read "Submitted 21" while the Summary read 24, and the two pages meant different things
 * by the word. See routes_phase1.ts::home for which meaning won and why.
 *
 * Gone with the counters that could not be acted on: "Past deadline" (79 of 94 calls - it
 * reported that calls close) and "Duplicates" (housekeeping; the deduplicator's job is to
 * remove them, not to count them).
 */
import { useEffect, useState } from "react";
import { BookOpen, ChevronDown, Download } from "lucide-react";
import { fetchHome, type HomeKpis, type User } from "../api";
import OpportunityRail from "../components/OpportunityRail";
import HowToUse from "../shell/HowToUse";
import { hrefOf, Link } from "../router";
import { Card, LinkButton, Notice, PageHeader } from "../ui";
import {
  DECISION_PARTS, Meter, SegmentedBar, StageBars,
} from "../components/DashboardCharts";

const dash = "—";

const usd = (n: number | null | undefined) =>
  n == null ? dash : `$${Math.round(n).toLocaleString("en-US")}`;

/** Where a figure's rows live. Every number on this page that stands for a set of calls
 *  links through here, and the key is the Dashboard figure's own name — the same key the
 *  server counted it under (api/home_buckets.ts), so the list cannot show a different set
 *  from the one the tile counted. */
const rowsOf = (bucket: string) => hrefOf("opportunities", { bucket });

function Tile({ label, value, note, to, title }: {
  label: string;
  value: number | string;
  note?: string;
  /** Present only when the number is worth acting on — see "Due in 14 days". */
  to?: string;
  title?: string;
}) {
  const body = (
    <>
      <div className="text-xs leading-tight text-ink-500">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-brand-700">{value}</div>
      {note && <div className="mt-0.5 text-xs text-ink-400">{note}</div>}
    </>
  );
  if (!to) return <Card className="px-4 py-3">{body}</Card>;
  return (
    <Card className="px-4 py-3 transition-shadow hover:shadow-float">
      <Link to={to} title={title} className="block hover:text-accent-700">{body}</Link>
    </Card>
  );
}

export default function HomePage({ user }: { user: User }) {
  const [k, setK] = useState<HomeKpis | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchHome().then(setK).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : "Couldn't load live KPIs."));
  }, []);

  const firstName = (user.name || user.email || "there").split(" ")[0];
  // A deadline you can still act on is the one number here that leads somewhere. Linked
  // only when there is something to see: a link to an empty list wastes the click.
  const dueSoon = k?.due_in_14_days ?? 0;

  return (
    <div className="flex flex-col gap-7 lg:flex-row">
      <div className="min-w-0 flex-1">
        <PageHeader title={`Welcome, ${firstName}`} />
        {error && <Notice tone="warn" className="mb-4">{error}</Notice>}

        {/* THE HEADLINE ROW STAYS CARDS. A handful of current values is a KPI row's job,
            and a one-bar chart of a single number says less than the number does. The
            plotted forms below are for the figures whose SHAPE carries meaning: a split,
            a progression, a ratio. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Calls found" value={k?.found ?? dash} note="Non-duplicate"
            to={rowsOf("found")} title="Show every call found" />
          <Tile label="Awaiting review" value={k?.awaiting_review ?? dash}
            note="Still open, no decision" to={rowsOf("awaiting_review")}
            title="Show the open calls nobody has decided on yet" />
          <Tile label="Applications sent" value={k?.applications_sent ?? dash}
            note="One call can be sent twice" to={rowsOf("applications_sent")}
            title="Show everything that reached a funder" />
          {/* Bidding owns this work, so a live number opens the stage rather than the
              list. With nothing due, the list is the honest destination: it can say "no
              call is currently due in 14 days", which an empty stage cannot. */}
          <Tile label="Due in 14 days" value={k?.due_in_14_days ?? dash}
            note={dueSoon > 0 ? "Open in Bidding" : "Live bids only"}
            to={dueSoon > 0 ? `${hrefOf("pipelines")}?stage=bidding&period=all`
              : rowsOf("due_in_14_days")}
            title="Open the live bids, soonest deadlines first" />
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-brand-700">What we decided</h2>
            <p className="mt-0.5 mb-4 text-xs text-ink-400">
              How the {k?.found ?? 0} calls found split, once a person had looked.
            </p>
            {k && (
              <SegmentedBar
                total={k.found} unit="calls"
                parts={[
                  { label: "Proceed", value: k.proceed, className: DECISION_PARTS.good,
                    to: rowsOf("proceed") },
                  { label: "Parked", value: k.parked, className: DECISION_PARTS.holding,
                    to: rowsOf("parked") },
                  { label: "Declined", value: k.declined, className: DECISION_PARTS.bad,
                    to: rowsOf("declined") },
                  { label: "Not yet reviewed", value: k.awaiting_review,
                    className: "bg-ink-300", to: rowsOf("awaiting_review") },
                  // Expired before anybody looked. Its own segment rather than folded into
                  // the one above, because the two call for opposite things: one is work
                  // waiting to be done, the other is work that can no longer be done.
                  { label: "Expired unreviewed", value: k.expired_unreviewed,
                    className: "bg-ink-200", to: rowsOf("expired_unreviewed") },
                ]}
              />
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-brand-700">What funders said</h2>
            <p className="mt-0.5 mb-4 text-xs text-ink-400">
              Of {k?.applications_sent ?? 0} applications sent. Same three colours, same
              three meanings as above.
            </p>
            {k && (
              <SegmentedBar
                total={k.applications_sent} unit="applications"
                parts={[
                  { label: "Approved", value: k.approved, className: DECISION_PARTS.good,
                    to: rowsOf("approved") },
                  { label: "Awaiting answer", value: k.awaiting_answer,
                    className: DECISION_PARTS.holding, to: rowsOf("awaiting_answer") },
                  { label: "Not approved", value: k.not_approved,
                    className: DECISION_PARTS.bad, to: rowsOf("not_approved") },
                ]}
              />
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-brand-700">Down the pipeline</h2>
            <p className="mt-0.5 mb-4 text-xs text-ink-400">
              The same work measured at five points. Stage order, not size order — the
              drop between stages is the thing worth seeing.
            </p>
            {k && (
              <StageBars stages={[
                { label: "Found", value: k.found, to: rowsOf("found") },
                // Counted here as the three decisions, which is how the bar reads; the
                // list's own `reviewed` bucket is "a decision is recorded", the same set
                // from the other side. The test pins them equal.
                { label: "Reviewed", value: k.proceed + k.parked + k.declined,
                  to: rowsOf("reviewed") },
                { label: "Proceed", value: k.proceed, to: rowsOf("proceed") },
                { label: "Sent", value: k.applications_sent, to: rowsOf("applications_sent") },
                { label: "Approved", value: k.approved, to: rowsOf("approved") },
              ]} />
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-brand-700">Funding</h2>
            <p className="mt-0.5 mb-4 text-xs text-ink-400">
              Converted to USD at today's rates.
            </p>
            <div className="mb-4 grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-ink-500">Requested</div>
                <div className="text-xl font-bold text-brand-700 tabular-nums">
                  {usd(k?.usd_requested)}
                </div>
                <div className="text-xs text-ink-400">Everything sent</div>
              </div>
              <div>
                <div className="text-xs text-ink-500">Secured</div>
                <div className="text-xl font-bold text-brand-700 tabular-nums">
                  {usd(k?.usd_secured)}
                </div>
              </div>
            </div>
            {/* A ratio against a limit is a meter, not a two-slice pie - and the caption
                names the population, because over everything sent the same share reads
                28.8% where over decided applications it reads 62.0%. */}
            <Meter
              value={k?.usd_secured ?? 0} limit={k?.usd_requested_decided ?? 0}
              caption={k?.pct_won_of_decided == null
                ? "Nothing answered yet"
                : `${k.pct_won_of_decided}% of ${usd(k.usd_requested_decided)} a funder has answered`}
            />
          </Card>
        </div>

        {/* A TABLE, because each row carries a name, a funder, a date and a value - four
            classes that all mean something, which is past where a chart helps. */}
        {!!k?.closing_soon?.length && (
          <Card className="mt-4 overflow-hidden">
            <div className="flex items-baseline justify-between gap-3 px-5 pt-5 pb-3">
              <h2 className="text-sm font-semibold text-brand-700">Closing soon</h2>
              <Link to={`${hrefOf("pipelines")}?stage=bidding&period=all`}
                className="text-xs text-accent-700 hover:underline">
                All live bids
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] table-fixed text-sm">
                <colgroup>
                  <col className="w-[46%]" /><col className="w-[26%]" />
                  <col className="w-[14%]" /><col className="w-[14%]" />
                </colgroup>
                <thead>
                  <tr className="border-y border-ink-200 bg-ink-50 text-left text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
                    <th className="px-5 py-2">Opportunity</th>
                    <th className="px-3 py-2">Funder</th>
                    <th className="px-3 py-2">Closes</th>
                    <th className="px-3 py-2 text-right">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {k.closing_soon.map((r) => (
                    <tr key={r.uid} className="align-top hover:bg-ink-50/60">
                      <td className="px-5 py-2.5">
                        <Link to={`${hrefOf("opportunity")}?uid=${encodeURIComponent(r.uid)}`}
                          className="font-medium text-brand-700 hover:text-accent-700 hover:underline">
                          {r.title || r.uid}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 break-words text-ink-600">{r.funder || dash}</td>
                      <td className="px-3 py-2.5 text-ink-600 tabular-nums">{r.deadline || dash}</td>
                      <td className="px-3 py-2.5 text-right text-ink-600 tabular-nums">
                        {r.usd ? usd(r.usd) : dash}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
        {!!k?.ledger_gap && (
          <Notice tone="warn" className="mt-3">
            {k.ledger_gap === 1
              ? "1 application has a funder's answer but was never marked Completed, so it counts as zero above."
              : `${k.ledger_gap} applications have a funder's answer but were never marked Completed, so they count as zero above.`}{" "}
            Open them from <Link to={hrefOf("grants")} className="underline">Funding</Link> and set the progress to Completed.
          </Notice>
        )}

        <Card className="mt-6 p-5">
          <h3 className="flex items-center gap-2 font-semibold text-brand-700">
            <BookOpen className="h-4.5 w-4.5 text-accent-600" strokeWidth={1.9} />
            New to RFPIS? Start with the manual
          </h3>
          <p className="mt-1.5 text-sm text-ink-600">
            Step by step through every page, plus the slides from the team training.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <LinkButton href="/help/RFPIS_User_Manual.pdf" download
              icon={<Download className="h-4 w-4" />}>User manual (PDF)</LinkButton>
            <LinkButton href="/help/RFPIS_Training_Deck.pptx" download
              icon={<Download className="h-4 w-4" />}>Training slides (PPTX)</LinkButton>
          </div>
        </Card>

        {/* The SAME component the sidebar overlay renders, not a second copy of the
            words. Two ways in - here for somebody reading the Dashboard top to bottom,
            and from the sidebar on any other page - one place the text lives. */}
        <Card className="mt-3">
          <details className="group p-5">
            <summary className="flex cursor-pointer list-none items-center justify-between font-medium text-ink-800">
              How to use this app
              <ChevronDown className="h-4 w-4 text-ink-400 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-4">
              <HowToUse />
            </div>
          </details>
        </Card>
      </div>

      {/* The rail is the feed's again (owner, 2026-11-09). The manual moved here while the
          centre was a wall of tiles and the page had nowhere else to put it; now that the
          centre carries the charts and the table, there is room beneath them, which is
          where both of these read better - a newcomer scrolls past the figures and finds
          them, instead of them competing with the feed for the narrow column. */}
      <div className="w-full shrink-0 lg:w-80">
        <OpportunityRail tenantName={user.view?.name ?? user.tenant?.name} dashboard />
      </div>
    </div>
  );
}
