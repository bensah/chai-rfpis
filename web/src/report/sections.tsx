/**
 * The Report's five sections, each a pure function of the payload its route returns.
 *
 * NOTHING HERE COMPUTES A REPORTED FIGURE. Every number arrives from
 * supabase/functions/_shared/api/report_section*.ts, where it sits beside a parity check
 * against views/report.py. The only arithmetic in this file is a bar's share of its own
 * chart's maximum, which is geometry rather than a figure anyone reads. If a number needs
 * working out, it belongs on the server — a second implementation here is how the React
 * page and the Streamlit page would start quietly disagreeing about the same word.
 *
 * SECTION IDS ARE NOT THE DISPLAY ORDER. The page shows 1, 4, 2, 3, 5 — those are the ids
 * stored inside every saved `?r=` snapshot, so they cannot be renumbered to match the
 * headings a reader sees. The ids are carried; the headings say "1 ·", "2 ·" and so on.
 *
 * Each metric is gated by its own key (`s1_donor`, `s5_grants`, …) from the advanced
 * filter. A hidden metric is not rendered at all rather than hidden with CSS, so a filtered
 * report costs nothing to draw and an exported one holds only what was asked for.
 */
import type {
  ReportSection1, ReportSection2, ReportSection3, ReportSection4, ReportSection5,
} from "../api";
import {
  DataTable, DivergingBars, Dumbbell, fmtInt, fmtPct, fmtUsd, Legend, Plot, RankedBars,
  SplitBars, Tile, Tiles, TimeArea, TimeBars,
} from "./charts";

type Show = (key: string) => boolean;
const dash = "—";

/** One section's heading and its blocks. */
function Section({ n, title, lead, children }: {
  n: string; title: string; lead: string; children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <header>
        <h3 className="text-lg font-bold text-brand-700">{n} · {title}</h3>
        <p className="mt-0.5 text-sm text-ink-500">{lead}</p>
      </header>
      {children}
    </section>
  );
}

/** Two charts side by side on a wide screen, stacked on a narrow one. */
const Pair = ({ children }: { children: React.ReactNode }) =>
  <div className="grid gap-4 xl:grid-cols-2">{children}</div>;

// ── 1 · Scan activity ────────────────────────────────────────────────────────

export function Section1({ d, show }: { d: ReportSection1; show: Show }) {
  const topSubmitters = d.discovery.buckets.length
    ? Object.entries(
      d.discovery.buckets.reduce<Record<string, number>>((acc, b) => {
        for (const [k, v] of Object.entries(b.bySubmitter)) acc[k] = (acc[k] ?? 0) + v;
        return acc;
      }, {}),
    ).sort((a, b) => b[1] - a[1])
    : [];
  return (
    <Section n="1" title="Scan activity" lead="What the scans found in this period, and who brought it in.">
      <Tiles>
        <Tile label="Calls taken in" value={fmtInt(d.intake.total)}
          note={`${fmtInt(d.intake.duplicates)} of them duplicates`} />
        <Tile label="Scan runs" value={fmtInt(d.scans.runs)}
          note={d.scans.errorRuns ? `${fmtInt(d.scans.errorRuns)} errored` : "none errored"}
          tone={d.scans.errorRuns ? "warn" : "brand"} />
        <Tile label="Found by the scanner" value={fmtInt(d.scans.found)}
          note={`${fmtInt(d.scans.eligible)} passed eligibility`} />
        <Tile label="Added to the pipeline" value={fmtInt(d.scans.added)}
          note={`${fmtInt(d.scans.rejected)} rejected`} />
      </Tiles>

      {show("s1_discovery") && (
        <Plot title="Funding discovered" hint={`Calls found per ${d.bucketLabel.toLowerCase()}. Hover a bar for who brought them in.`}
          empty={d.discovery.buckets.length ? undefined : "No calls were discovered in this period."}>
          <TimeBars
            points={d.discovery.buckets.map((b) => ({ bucket: b.bucket, value: b.total }))}
            cadence={d.bucketLabel} unit="calls"
            detail={(b) => {
              const row = d.discovery.buckets.find((x) => x.bucket === b);
              return Object.entries(row?.bySubmitter ?? {}).sort((a, c) => c[1] - a[1])
                .map(([label, value]) => ({ label, value }));
            }}
          />
          {topSubmitters.length > 0 && (
            <div className="mt-4 border-t border-ink-100 pt-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Who found them · {d.discovery.submitters.length} people
              </p>
              <RankedBars unit="Calls found, by member"
                rows={topSubmitters.slice(0, 10).map(([label, value]) => ({ label, value }))} />
            </div>
          )}
        </Plot>
      )}

      <Pair>
        {show("s1_donor") && (
          <Plot title="Funding by donor" hint="The 15 funders putting the most calls into the pipeline."
            empty={d.donors.top.length ? undefined : "No donors recorded in this period."}>
            <RankedBars unit="Calls by donor"
              rows={d.donors.top.map((r) => ({ label: r.donor, value: r.rfps }))} />
          </Plot>
        )}
        {show("s1_keywords") && (
          <Plot title="Focus areas"
            hint={`Where the ${fmtInt(d.proceedCount)} calls we decided to bid on sit. All time, not this period.`}
            empty={d.focusAreas.length ? undefined : "No focus areas on the Proceed rows yet."}>
            {/* The Streamlit page draws this as a word cloud. Ranked bars instead: the
                question is which areas recur, and area-of-text is the least exact encoding
                of a count there is — two areas three calls apart look identical in a cloud. */}
            <RankedBars unit="Calls by focus area"
              rows={d.focusAreas.slice(0, 15).map((r) => ({ label: r.area, value: r.calls }))} />
          </Plot>
        )}
      </Pair>

      {show("s1_kw_success") && (
        <Plot title="Keywords driving success"
          hint="Search terms ranked by how far their calls actually got."
          empty={d.keywordSuccess.length ? undefined : "No keyword results in this period."}>
          <DataTable
            rows={d.keywordSuccess.slice(0, 20)} keyOf={(r) => r.keyword}
            cols={[
              { head: "Keyword", cell: (r) => <span className="text-ink-700">{r.keyword}</span> },
              { head: "Calls", align: "right", cell: (r) => fmtInt(r.hits) },
              { head: "Proceed", align: "right", cell: (r) => fmtInt(r.proceed) },
              { head: "Submitted", align: "right", cell: (r) => fmtInt(r.submitted) },
              { head: "Approved", align: "right", cell: (r) => <span className="font-semibold text-good-700">{fmtInt(r.approved)}</span> },
            ]}
          />
        </Plot>
      )}

      <Pair>
        {show("s1_sources") && (
          <Plot title="Top sources by yield" hint="Added as a share of everything that source found."
            empty={d.sources.top.length ? undefined : "No sources ran in this period."}>
            <RankedBars unit="Yield by source" fmt={(n) => fmtPct(n)}
              rows={d.sources.top.map((r) => ({
                label: r.source, value: r.yieldPct,
                note: `of ${fmtInt(r.found)}`,
                title: `${r.source}: ${fmtInt(r.added)} added of ${fmtInt(r.found)} found over ${fmtInt(r.runs)} runs, ${r.avgDur}s average`,
              }))} />
          </Plot>
        )}
        {show("s1_cycle") && (
          <Plot title="Search → submission" hint="Days from finding a call to sending the application. All time."
            empty={d.cycle && d.cycle.n ? undefined : "No call has both a find date and a submission date yet."}>
            {d.cycle && d.cycle.n > 0 && (
              <>
                <Tiles>
                  <Tile label="Median" value={`${fmtInt(d.cycle.median)}d`} note={`over ${fmtInt(d.cycle.n)} calls`} />
                  <Tile label="Mean" value={`${d.cycle.mean.toFixed(1)}d`} />
                  <Tile label="Fastest" value={`${fmtInt(d.cycle.min)}d`} tone="good" />
                  <Tile label="Slowest" value={`${fmtInt(d.cycle.max)}d`} tone="warn" />
                </Tiles>
                <div className="mt-3">
                  <RankedBars unit="Days per call" fmt={(n) => `${fmtInt(n)}d`}
                    rows={[...d.cycle.days].sort((a, b) => a - b)
                      .map((v, i) => ({ label: `Call ${i + 1}`, value: v }))} />
                </div>
              </>
            )}
          </Plot>
        )}
      </Pair>

      {d.intake.bySource.length > 0 && (
        <Plot title="Where the calls came from" hint="Every route into the pipeline, with its duplicates.">
          <DataTable
            rows={d.intake.bySource} keyOf={(r) => r.source}
            cols={[
              { head: "Route", cell: (r) => <span className="text-ink-700">{r.label}</span> },
              { head: "Unique", align: "right", cell: (r) => fmtInt(r.unique) },
              { head: "Duplicates", align: "right", cell: (r) => fmtInt(r.duplicates) },
              { head: "Total", align: "right", cell: (r) => <span className="font-semibold">{fmtInt(r.total)}</span> },
            ]}
          />
        </Plot>
      )}
    </Section>
  );
}

// ── 2 · Team & partners (section id 4) ───────────────────────────────────────

export function Section2({ d, show }: { d: ReportSection2; show: Show }) {
  return (
    <Section n="2" title="Team & partners"
      lead="Meetings and donor contact in this period; the people and partner figures are all-time.">
      <Tiles>
        <Tile label="Meeting actions logged" value={fmtInt(d.meetings.logged)} />
        <Tile label="Still open" value={fmtInt(d.meetings.open)}
          note={`${fmtPct(d.meetings.pctUnresolved)} unresolved`}
          tone={d.meetings.open ? "warn" : "good"} />
        <Tile label="Donor engagements" value={fmtInt(d.donors.engagements)}
          note={`${fmtInt(d.donors.donors)} donors, ${d.donors.avgPerDonor.toFixed(1)} each`} />
        <Tile label="Tied to a call" value={fmtInt(d.donors.tiedToRfp)}
          note="engagements linked to an RFP" />
      </Tiles>

      {show("s4_eng_ts") && (
        <Plot title="Donor engagements over time" hint={`Touchpoints logged per ${d.bucketLabel.toLowerCase()}.`}
          empty={d.engagements.length ? undefined : "No donor engagements were logged in this period."}>
          <TimeBars points={d.engagements.map((b) => ({ bucket: b.bucket, value: b.engagements }))}
            cadence={d.bucketLabel} unit="engagements" />
        </Plot>
      )}

      <Pair>
        {show("s4_topdonors") && (
          <Plot title="Top donors by touchpoints" hint="Who the team spent its contact on."
            empty={d.topDonors.top.length ? undefined : "No donor touchpoints in this period."}>
            <RankedBars unit="Touchpoints by donor"
              rows={d.topDonors.top.map((r) => ({ label: r.donor, value: r.touchpoints }))} />
          </Plot>
        )}
        {show("s4_partners") && (
          <Plot title="Partners" hint={`Across ${fmtInt(d.proceedRows)} calls we decided to bid on. All time.`}
            empty={d.partners.lead.top.length || d.partners.sub.top.length ? undefined : "No partners recorded yet."}>
            {d.partners.lead.top.length > 0 && (
              <>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Lead applicant</p>
                <RankedBars unit="Calls led, by organisation"
                  rows={d.partners.lead.top.map((r) => ({ label: r.org, value: r.rfps }))} />
              </>
            )}
            {d.partners.sub.top.length > 0 && (
              <div className={d.partners.lead.top.length ? "mt-4 border-t border-ink-100 pt-3" : ""}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Sub applicant</p>
                <RankedBars unit="Calls as sub applicant, by organisation"
                  rows={d.partners.sub.top.map((r) => ({ label: r.org, value: r.rfps }))} />
              </div>
            )}
          </Plot>
        )}
      </Pair>

      <Pair>
        {show("s4_leads") && (
          <Plot title="Proposal leads" hint="Who carried each bid, and how many of theirs went in."
            empty={d.leads.top.length ? undefined : "No proposal leads recorded yet."}>
            <SplitBars aLabel="Submitted" bLabel="Not yet"
              rows={d.leads.top.map((r) => ({ label: r.name, a: r.submitted, b: r.unsubmitted, total: r.total }))} />
          </Plot>
        )}
        {show("s4_contrib") && (
          <Plot title="Contributors" hint="Everyone named on a bid, not only its lead."
            empty={d.contributors.top.length ? undefined : "No contributors recorded yet."}>
            <SplitBars aLabel="Submitted" bLabel="Not yet"
              rows={d.contributors.top.map((r) => ({ label: r.name, a: r.submitted, b: r.unsubmitted, total: r.total }))} />
          </Plot>
        )}
      </Pair>
    </Section>
  );
}

// ── 3 · Status & eligibility funnel (section id 2) ───────────────────────────

export function Section3({ d, show }: { d: ReportSection3; show: Show }) {
  const c = d.counts;
  /**
   * ALL-TIME ON PURPOSE, and the caption has to say so. The Excel-migrated rows carry no
   * search_date, so filtering this funnel by period would hide the organisation's whole
   * pre-migration pipeline — only "found in this period" follows the period at all.
   */
  const stages = [
    { label: "Taken in", value: c.total, note: "every non-duplicate call" },
    { label: "Decided to bid", value: c.proceed, note: "Proceed" },
    { label: "Submitted", value: c.submitted, note: "sent to the funder" },
    { label: "Approved", value: c.approved, note: "funder said yes" },
  ];
  const money = [
    { label: "Discovered", value: d.values.discovered },
    { label: "Decided to bid", value: d.values.proceed },
    { label: "Submitted", value: d.values.submitted },
    { label: "Approved", value: d.values.approved },
  ];
  return (
    <Section n="3" title="Status & eligibility funnel"
      lead="All time, not this period — the migrated rows have no find date, and filtering would hide them.">
      <Tiles>
        <Tile label="Calls in the pipeline" value={fmtInt(c.total)}
          note={`${fmtInt(c.discoveredInPeriod)} found in this period`} />
        <Tile label="Decided to bid" value={fmtInt(c.proceed)}
          note={`${fmtPct((c.proceed / Math.max(1, c.total)) * 100)} of everything taken in`} />
        <Tile label="No decision yet" value={fmtInt(c.noDecision)}
          tone={c.noDecision ? "warn" : "good"} note={`${fmtInt(c.park)} parked, ${fmtInt(c.decline)} declined`} />
        <Tile label="Approved" value={fmtInt(c.approved)} tone="good"
          note={`of ${fmtInt(c.submitted)} submitted`} />
      </Tiles>

      <Pair>
        {show("s2_funnel") && (
          <Plot title="Conversion funnel" hint="Calls at each stage. The order is the progression, not a ranking.">
            {/* One hue: these are the same thing counted at four points, so colour carries
                no identity and the bars read as pure magnitude. The drop between stages is
                the thing worth seeing, which is why the order is never sorted by size. */}
            <RankedBars unit="Calls by stage"
              rows={stages.map((s) => ({ label: s.label, value: s.value, sub: s.note }))} />
          </Plot>
        )}
        {show("s2_funnel") && (
          <Plot title="The same funnel in dollars" hint="Award value at each stage, converted to USD.">
            {/* A SEPARATE CHART, not a second axis on the one beside it. Counts and dollars
                are different scales, and two y-axes on one plot is the chart mistake that
                makes any two series look correlated. */}
            <RankedBars unit="Value by stage" fmt={(n) => fmtUsd(n)}
              rows={money.map((m) => ({ label: m.label, value: m.value }))} />
          </Plot>
        )}
      </Pair>

      {show("s2_progress") && (
        <Plot title="Progress status" hint={`Where the ${fmtInt(d.proceedRows)} calls we decided to bid on have got to.`}
          empty={d.progress.length ? undefined : "No Proceed rows yet."}>
          <RankedBars unit="Calls by progress status"
            rows={d.progress.map((p) => ({ label: p.status, value: p.rfps }))} />
        </Plot>
      )}
    </Section>
  );
}

// ── 4 · Reviews & decisions (section id 3) ───────────────────────────────────

const DECISION_TONE: Record<string, string> = {
  Proceed: "bg-good-700", Park: "bg-gold-700", Decline: "bg-bad-600", "No decision": "bg-ink-300",
};

export function Section4({ d, show }: { d: ReportSection4; show: Show }) {
  const total = d.distribution.reduce((a, r) => a + r.count, 0);
  return (
    <Section n="4" title="Reviews & decisions"
      lead="Decisions taken in this period. The distribution and the funders' answers are all-time.">
      <Tiles>
        <Tile label="Decisions taken" value={fmtInt(d.kpis.decisions)} />
        <Tile label="Days to decide (median)"
          value={d.kpis.medianDays === null ? dash : `${d.kpis.medianDays.toFixed(1)}d`}
          note={d.kpis.dated ? `${fmtInt(d.kpis.dated)} with both dates` : "no call has both dates"} />
        <Tile label="Mean days" value={d.kpis.avgDays === null ? dash : `${d.kpis.avgDays.toFixed(1)}d`}
          note={d.kpis.avgDays !== null && d.kpis.avgDays < 0 ? "negative: decided before it was found" : undefined}
          tone={d.kpis.avgDays !== null && d.kpis.avgDays < 0 ? "warn" : "brand"} />
        <Tile label="Overridden" value={fmtInt(d.kpis.overridden)} note="a person changed the call" />
      </Tiles>

      <Pair>
        {show("s3_decdist") && (
          <Plot title="Decision distribution" hint="Every non-duplicate call, all time."
            empty={total ? undefined : "No calls to show."}>
            {/* A tall segmented bar, not a donut: one whole split four ways, read at a
                glance. Bars on one baseline compare more exactly than slices of a circle.
                Every segment carries its figure — the gold is under 3:1 on white, so the
                label is relief, not decoration. */}
            <div className="flex h-7 w-full gap-[2px] overflow-hidden rounded-md bg-ink-100" role="img"
              aria-label={d.distribution.map((p) => `${p.count} ${p.decision}`).join(", ")}>
              {d.distribution.filter((p) => p.count > 0).map((p) => (
                <div key={p.decision} title={`${p.decision}: ${p.count}`}
                  className={`${DECISION_TONE[p.decision] ?? "bg-ink-300"} flex items-center justify-center`}
                  style={{ width: `${(p.count / Math.max(1, total)) * 100}%` }}>
                  {(p.count / Math.max(1, total)) * 100 >= 10 && (
                    <span className="text-xs font-semibold tabular-nums text-white">{p.count}</span>
                  )}
                </div>
              ))}
            </div>
            <Legend items={d.distribution.map((p) => ({
              label: p.decision, className: DECISION_TONE[p.decision] ?? "bg-ink-300", value: p.count,
            }))} />
          </Plot>
        )}
        {show("s3_donordec") && (
          <Plot title="Donor decisions" hint="What funders answered on the calls we bid for. All time."
            empty={d.donor.ranked.length ? undefined : "No funder has answered yet."}>
            <RankedBars unit="Calls by funder decision"
              rows={d.donor.ranked.map((r) => ({ label: r.decision, value: r.rfps }))} />
            <p className="mt-3 border-t border-ink-100 pt-2.5 text-xs text-ink-500">
              <span className="font-semibold text-gold-700 tabular-nums">{fmtInt(d.donor.pending)}</span>
              {" "}Proceed calls are still waiting for a funder's answer.
            </p>
          </Plot>
        )}
      </Pair>

      {show("s3_dectime") && (
        <Plot title="Proceed decisions over time" hint={`Calls we decided to bid on, per ${d.bucketLabel.toLowerCase()}.`}
          empty={d.overTime.length ? undefined : "No Proceed decisions in this period."}>
          <TimeBars points={d.overTime.map((b) => ({ bucket: b.bucket, value: b.decisions }))}
            cadence={d.bucketLabel} unit="decisions" />
        </Plot>
      )}

      {show("s3_autorec") && (
        <Plot title="Auto-scorer vs the team" hint="What the engine recommended against what people decided."
          right={
            <span className="shrink-0 rounded-md bg-accent-50 px-2.5 py-1 text-xs font-semibold text-accent-800 tabular-nums">
              agreed on {fmtInt(d.autoRec.agreed)} of {fmtInt(d.autoRec.total)}
            </span>
          }
          empty={d.autoRec.total ? undefined : "No decided calls to compare."}>
          <Dumbbell aLabel="Auto-scorer" bLabel="The team"
            rows={d.autoRec.rows.map((r) => ({ label: r.decision, a: r.auto, b: r.team }))} />
        </Plot>
      )}
    </Section>
  );
}

// ── 5 · Our results ──────────────────────────────────────────────────────────

export function Section5({ d, show }: { d: ReportSection5; show: Show }) {
  const conv = d.conversion;
  return (
    <Section n="5" title="Our results"
      lead="All time, in US dollars. Only the cumulative curve follows the period.">
      <Tiles>
        <Tile label="Applications sent" value={fmtInt(d.kpis.submitted)}
          note="submission events, not calls" />
        <Tile label="Approved" value={fmtInt(d.kpis.approved)} tone="good"
          note={`${fmtPct(d.kpis.winRate)} win rate`} />
        <Tile label="Secured" value={fmtUsd(d.money.secured)} tone="good"
          note={`${fmtPct(d.kpis.securedRatio)} of what was asked for`} />
        <Tile label="Requested" value={fmtUsd(d.money.requested)}
          note={`${fmtUsd(d.money.unsecured)} declined`} />
      </Tiles>

      {(d.missingCurrency.approved > 0 || d.missingCurrency.pipeline > 0) && (
        <p className="rounded-md border border-gold-300 bg-gold-100 px-3 py-2 text-xs text-ink-700">
          <strong>Some of these dollars are a guess.</strong>{" "}
          {d.missingCurrency.approved > 0 && <>{fmtInt(d.missingCurrency.approved)} approved {d.missingCurrency.approved === 1 ? "call has" : "calls have"} an amount with no currency beside it. </>}
          {d.missingCurrency.pipeline > 0 && <>{fmtInt(d.missingCurrency.pipeline)} in the pipeline {d.missingCurrency.pipeline === 1 ? "does" : "do"} too. </>}
          They are counted as US dollars, which is right only if they are.
        </p>
      )}

      <Pair>
        {show("s5_cumusd") && (
          <Plot title="Cumulative USD secured" hint={`Money approved, accumulating per ${d.bucketLabel.toLowerCase()}.`}
            empty={d.cumulative.length ? undefined : "No approved funding with a date in this period."}>
            <TimeArea points={d.cumulative.map((b) => ({ bucket: b.bucket, value: b.cumulative }))}
              cadence={d.bucketLabel} unit="secured" fmt={(n) => fmtUsd(n)} />
          </Plot>
        )}
        {show("s5_conv") && (
          <Plot title="Conversion rates" hint="How far a call we decided to bid on actually gets.">
            <RankedBars unit="Calls by stage"
              rows={[
                { label: "Decided to bid", value: conv.proceeded },
                { label: "Submitted", value: conv.submitted, sub: `${fmtPct(conv.proceededToSubmitted)} of those we bid on` },
                { label: "Approved", value: conv.approved, sub: `${fmtPct(conv.submittedToApproved)} of those submitted` },
              ]} />
            <p className="mt-3 border-t border-ink-100 pt-2.5 text-xs text-ink-500">
              End to end, <span className="font-semibold text-brand-700 tabular-nums">{fmtPct(conv.endToEnd)}</span>{" "}
              of the calls we decide to bid on are approved.
            </p>
          </Plot>
        )}
      </Pair>

      {show("s5_reqsec") && (
        <Plot title="Requested vs secured, per call"
          hint="Right of the line is money in hand or still in play; left is money asked for and refused."
          empty={d.outcomes.length ? undefined : "No call has a funder's answer and an amount yet."}>
          <DivergingBars rows={d.outcomes.map((o) => ({
            label: o.label, funder: o.funder, value: o.signedUsd, outcome: o.outcome,
          }))} />
        </Plot>
      )}

      {show("s5_grants") && (
        <Plot title="Applied funding pipeline" hint="Every completed bid, with what it asked for and what it got.">
          <DataTable
            rows={d.grants} keyOf={(r) => r.uid} empty="No completed bids yet."
            cols={[
              {
                head: "Grant", cell: (r) => (
                  <span className="text-ink-700" title={`${r.grant} — ${r.uid}`}>{r.grant}</span>
                ),
              },
              { head: "Funder", cell: (r) => <span className="text-ink-600">{r.funder}</span> },
              { head: "Requested", align: "right", cell: (r) => fmtUsd(r.requestedUsd) },
              {
                head: "Secured", align: "right", cell: (r) => (
                  <span className={r.securedUsd > 0 ? "font-semibold text-good-700" : "text-ink-400"}>
                    {r.securedUsd > 0 ? fmtUsd(r.securedUsd) : dash}
                  </span>
                ),
              },
              { head: "Answer", cell: (r) => <span className="text-ink-600">{r.donorDecision}</span> },
              { head: "Sent", align: "right", cell: (r) => <span className="text-ink-500">{r.submittedOn ?? dash}</span> },
              { head: "Times sent", align: "right", cell: (r) => fmtInt(r.submissions) },
            ]}
          />
        </Plot>
      )}
    </Section>
  );
}
