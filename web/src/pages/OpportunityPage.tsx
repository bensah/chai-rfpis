/**
 * One opportunity, in full — a port of app_pages/opportunity.py.
 *
 * Two parts, in the order the decision gets made in:
 *   1. the call itself, restated in the RFPIS standard format, so two calls from different
 *      funders read the same way;
 *   2. the decision aid — our criteria and fit strength against this tenant.
 *
 * None of that structure is decided here. core/opportunity_detail.py lays the call out and
 * core/opportunity_scoring.py scores it, both in the browser's Python engine; this file
 * renders what they return. The page shows its header as soon as the rows arrive and fills
 * in the rest when the engine answers, so it never sits blank waiting for the boot.
 */
import { useEffect, useState } from "react";
import { ArrowUpRight, Layers } from "lucide-react";
import { fetchOpportunityRows, type User } from "../api";
import OpportunityRail from "../components/OpportunityRail";
import { scoreOpportunity, useEngine } from "../scoring/engine";
import type { Block, OpportunityResult } from "../scoring/protocol";
import { hrefOf, Link } from "../router";
import { Badge, Card, EmptyState, LinkButton, Notice, PageHeader, Spinner, type Tone } from "../ui";

/** opportunity_detail's chip tones, mapped onto the design system's. */
const CHIP_TONE: Record<string, Tone> = {
  closed: "bad", urgent: "bad", soon: "warn", open: "good",
};
const DECISION_TONE: Record<string, Tone> = {
  Proceed: "good", Park: "warn", Decline: "bad",
};

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-9 mb-4 border-b border-ink-200 pb-2 text-lg font-bold text-brand-700">
      {children}
    </h2>
  );
}

function Lines({ lines, missing }: { lines: string[]; missing: boolean }) {
  return (
    <>
      {lines.map((l, i) => (
        <p key={i} className={`text-sm leading-relaxed ${missing ? "text-ink-400 italic" : "text-ink-700"}`}>{l}</p>
      ))}
    </>
  );
}

/** A fact block or a prose block from core/opportunity_detail.page_rows. */
function BlockView({ block }: { block: Block }) {
  if (block.kind === "prose") {
    return (
      <div className="mb-5">
        <h4 className="mb-1.5 font-semibold text-ink-800">{block.title}</h4>
        <Lines lines={block.lines} missing={block.missing} />
      </div>
    );
  }
  const body = (
    <>
      <h4 className="mb-2 font-semibold text-brand-700">{block.title}</h4>
      <dl>
        {block.rows.map(([label, value], i) => (
          <div key={i} className="flex justify-between gap-4 border-b border-dashed border-ink-100 py-1.5 last:border-b-0">
            <dt className="basis-5/12 text-sm text-ink-500">{label}</dt>
            <dd className="flex-1 text-right text-sm font-medium text-ink-800">{value}</dd>
          </div>
        ))}
      </dl>
      {block.prose.map((p, i) => <p key={i} className="mt-2 text-sm leading-relaxed text-ink-600">{p}</p>)}
    </>
  );
  return block.kind === "cards"
    ? <Card className="mb-4 p-4">{body}</Card>
    : <div className="mb-5">{body}</div>;
}

function Analysis({ a, who }: { a: Record<string, unknown>; who: string }) {
  if (a.error) {
    return <Notice tone="warn">Couldn't score this opportunity right now: {String(a.error)}</Notice>;
  }
  const conf = (a.confidence ?? {}) as Record<string, unknown>;
  const suggested = String(a.suggested_decision ?? "");
  const system = String(a.system_decision ?? "");
  const criteria = (a.criteria ?? []) as Record<string, unknown>[];
  const donorTxt = conf.donor_matched ? `${conf.donor_pct}%` : "no funder profile";
  return (
    <>
      <h3 className="mb-3 text-sm font-semibold text-ink-700">How this opportunity fares against {who}</h3>
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-x-10 gap-y-3">
          <div>
            <div className="text-xs text-ink-500">Bid Strength</div>
            <div className="text-2xl font-bold text-brand-700">
              {String(a.bid_strength)}<span className="text-base font-medium text-ink-400">/100</span>
            </div>
            <div className="text-xs text-ink-500">{String(a.fit)}</div>
          </div>
          <div>
            <div className="text-xs text-ink-500">Suggestion</div>
            <Badge tone={DECISION_TONE[suggested] ?? "neutral"} className="mt-1 text-sm">{suggested}</Badge>
            {suggested !== system && <div className="mt-1 text-xs text-gold-700">was {system}</div>}
          </div>
          <div>
            <div className="text-xs text-ink-500">Confidence</div>
            <div className="text-lg font-semibold text-ink-800">{String(conf.band ?? "")}</div>
            <div className="text-xs text-ink-500">
              data {String(conf.pct ?? "")}% · donor {donorTxt} · call {String(conf.call_pct ?? "")}%
            </div>
          </div>
        </div>
      </Card>

      {a.screened_out === true && a.screen_reason ? (
        <Notice tone="warn" className="mt-3">
          Screening would keep this out of your pipeline: {String(a.screen_reason)}
        </Notice>
      ) : null}
      {a.fatal === true && (
        <Notice tone="bad" className="mt-3">
          Disqualifier: {String(a.fatal_trigger ?? "a must-have criterion is not met")}
        </Notice>
      )}
      {a.below_award_floor === true && (
        <Notice tone="warn" className="mt-3">
          The award is below the floor your organisation pursues, so the suggestion is capped at Park.
        </Notice>
      )}
      {a.confidence_note ? <p className="mt-2 text-sm text-ink-500">{String(a.confidence_note)}</p> : null}

      <div className="mt-5">
        {criteria.map((c) => {
          const band = c.band as number | null;
          const edge = band === 2 ? "border-l-good-500" : band === 1 ? "border-l-gold-500"
            : band === 0 ? "border-l-bad-500" : "border-l-ink-200";
          return (
            <div key={String(c.key)}
              className={`mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-ink-200 border-l-4 bg-white px-3.5 py-2 ${edge}`}>
              {/* No "must" badge: the title core/opportunity_scoring gives already leads
                  with "MUST 1 ·" or "PREFER 6 ·". */}
              <span className="min-w-0 flex-1 text-sm text-ink-700">{String(c.title)}</span>
              <span className="text-sm font-semibold text-ink-800">{String(c.label ?? "")}</span>
              <span className="min-w-24 text-right text-xs text-ink-400">{String(c.count_text ?? "")}</span>
              <span className="min-w-14 text-right text-xs font-medium text-ink-600">
                {Number(c.points ?? 0).toFixed(1)}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

export default function OpportunityPage({ uid, user }: { uid: string; user: User }) {
  const [data, setData] = useState<OpportunityResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const engine = useEngine();

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    if (!uid) return;
    fetchOpportunityRows(uid)
      .then((rows) => scoreOpportunity(rows))
      .then((r) => live && setData(r as OpportunityResult))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Couldn't load it."));
    return () => {
      live = false;
    };
  }, [uid]);

  const rail = (
    <div className="w-full shrink-0 lg:w-80">
      <OpportunityRail tenantName={user.view?.name ?? user.tenant?.name} />
    </div>
  );
  const frame = (body: React.ReactNode) => (
    <div className="flex flex-col gap-7 lg:flex-row">
      <div className="min-w-0 flex-1">{body}</div>
      {rail}
    </div>
  );

  if (!uid) {
    return frame(
      <Card>
        <EmptyState icon={<Layers className="h-5 w-5" />} title="No opportunity selected">
          Open one from the <strong>Live opportunity feed</strong> on Home or Pipelines.
          <div className="mt-4">
            <Link to={hrefOf("pipelines")} className="text-accent-700 hover:underline">Go to Pipelines</Link>
          </div>
        </EmptyState>
      </Card>,
    );
  }
  if (error) {
    return frame(<Notice tone="bad">Couldn't load <code>{uid}</code>: {error}</Notice>);
  }
  if (!data) {
    return frame(<Spinner label={engine.state === "starting" ? engine.detail : "Loading this opportunity…"} />);
  }
  if (!data.found) {
    return frame(
      <Card>
        <EmptyState icon={<Layers className="h-5 w-5" />} title="That opportunity isn't here">
          Nothing matches uid <code>{uid}</code>. It may have been deleted, or it belongs to another tenant.
          <div className="mt-4">
            <Link to={hrefOf("pipelines")} className="text-accent-700 hover:underline">Back to Pipelines</Link>
          </div>
        </EmptyState>
      </Card>,
    );
  }

  const d = data as OpportunityResult & { orgName?: string; link?: string; analysis: Record<string, unknown> | null };
  return frame(
    <>
      <PageHeader
        title={d.title}
        lead={<>{d.funder}{d.reference ? ` · ${d.reference}` : ""}</>}
        actions={d.link ? (
          <LinkButton href={d.link} variant="primary" icon={<ArrowUpRight className="h-4 w-4" />}>
            Open the call
          </LinkButton>
        ) : undefined}
      />
      <div className="-mt-3 mb-2 flex flex-wrap gap-1.5">
        {d.chips.map((c, i) => (
          <Badge key={i} tone={CHIP_TONE[c.tone] ?? "neutral"}>{c.text}</Badge>
        ))}
      </div>

      <SectionHeading>1 · The opportunity</SectionHeading>
      {d.awardHeadline && (
        <p className="mb-4 text-xl font-semibold text-brand-700">{d.awardHeadline}</p>
      )}
      {d.overview.map(([heading, lines, missing], i) => (
        <div key={i} className="mb-4">
          <h4 className="mb-1.5 font-semibold text-ink-800">{heading}</h4>
          <Lines lines={lines} missing={missing} />
        </div>
      ))}
      {d.pageRows.map((row, i) => (
        <div key={i} className="grid gap-x-5 md:grid-cols-2">
          {row.map((col, j) => (
            <div key={j}>{col.map((b, k) => <BlockView key={k} block={b} />)}</div>
          ))}
        </div>
      ))}
      {d.narrative.map(([heading, lines, missing], i) => (
        <div key={i} className="mb-4">
          <h4 className="mb-1.5 font-semibold text-ink-800">{heading}</h4>
          <Lines lines={lines} missing={missing} />
        </div>
      ))}

      <SectionHeading>2 · Decision aid — is this worth bidding?</SectionHeading>
      {d.analysis
        ? <Analysis a={d.analysis} who={d.orgName?.trim() || "your organisation"} />
        : (
          <Notice tone="neutral">
            No scoring is available for this opportunity yet. It needs a tenant profile and a screened
            row before the criteria can be evaluated.
          </Notice>
        )}
    </>,
  );
}
