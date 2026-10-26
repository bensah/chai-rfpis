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
import { ExternalLink, Loader2 } from "lucide-react";
import { fetchOpportunityRows, type User } from "../api";
import OpportunityRail from "../components/OpportunityRail";
import { scoreOpportunity, useEngine } from "../scoring/engine";
import type { Block, OpportunityResult } from "../scoring/protocol";
import { hrefOf, Link } from "../router";

const CHIP_TONE: Record<string, string> = {
  closed: "bg-red-100 text-red-700",
  urgent: "bg-red-100 text-red-700 font-semibold",
  soon: "bg-amber-100 text-amber-800 font-semibold",
  open: "bg-green-100 text-brand-dark",
};

const DECISION_TONE: Record<string, string> = {
  Proceed: "bg-green-100 text-brand-dark",
  Park: "bg-amber-100 text-amber-800",
  Decline: "bg-red-100 text-red-700",
};

function Chip({ text, tone }: { text: string; tone: string }) {
  return (
    <span className={`rounded-xl px-2.5 py-0.5 text-xs whitespace-nowrap ${CHIP_TONE[tone] ?? "bg-slate-100 text-slate-600"}`}>
      {text}
    </span>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 mt-8 border-b-2 border-slate-200 pb-1.5 text-xl font-extrabold text-[#0f3d2a]">
      {children}
    </h2>
  );
}

/** A fact block or a prose block from core/opportunity_detail.page_rows. */
function BlockView({ block }: { block: Block }) {
  if (block.kind === "prose") {
    return (
      <div className="mb-4">
        <h4 className="mb-1.5 font-bold text-[#24352c]">{block.title}</h4>
        {block.lines.map((l, i) => (
          <p key={i} className={`text-sm leading-relaxed ${block.missing ? "italic text-slate-400" : "text-slate-700"}`}>{l}</p>
        ))}
      </div>
    );
  }
  return (
    <div className={`mb-4 ${block.kind === "cards" ? "rounded-xl border border-slate-200 bg-white p-4" : ""}`}>
      <h4 className={`mb-2 font-bold ${block.kind === "cards" ? "text-brand-dark" : "text-[#24352c]"}`}>
        {block.title}
      </h4>
      <dl>
        {block.rows.map(([label, value], i) => (
          <div key={i} className="flex justify-between gap-4 border-b border-dashed border-slate-100 py-1.5 last:border-b-0">
            <dt className="basis-5/12 text-sm text-slate-600">{label}</dt>
            <dd className="flex-1 text-right text-sm font-semibold text-slate-800">{value}</dd>
          </div>
        ))}
      </dl>
      {block.prose.map((p, i) => <p key={i} className="mt-2 text-sm leading-relaxed text-slate-700">{p}</p>)}
    </div>
  );
}

function Analysis({ a, who }: { a: Record<string, unknown>; who: string }) {
  if (a.error) {
    return <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
      Couldn't score this opportunity right now: {String(a.error)}
    </p>;
  }
  const conf = (a.confidence ?? {}) as Record<string, unknown>;
  const suggested = String(a.suggested_decision ?? "");
  const system = String(a.system_decision ?? "");
  const criteria = (a.criteria ?? []) as Record<string, unknown>[];
  const donorTxt = conf.donor_matched ? `${conf.donor_pct}%` : "no funder profile";
  return (
    <>
      <h3 className="mb-2 font-bold text-[#24352c]">How this opportunity fares against {who}</h3>
      <div className={`flex flex-wrap items-center gap-7 rounded-xl px-4 py-3 ${DECISION_TONE[suggested] ?? "bg-slate-100"}`}>
        <div>
          Bid Strength: <strong className="text-xl">{String(a.bid_strength)}/100 — {String(a.fit)}</strong>
        </div>
        <div className="text-slate-800">
          Suggestion: <strong className="text-xl">{suggested}</strong>
          {suggested !== system && <span className="text-amber-800"> (was {system})</span>}
        </div>
        <div className="text-slate-800">
          Confidence: <strong className="text-xl">{String(conf.band ?? "")}</strong>
          <span> · data {String(conf.pct ?? "")}% (donor {donorTxt} · call {String(conf.call_pct ?? "")}%)</span>
        </div>
      </div>

      {a.screened_out === true && a.screen_reason ? (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Screening would keep this out of your pipeline: {String(a.screen_reason)}
        </p>
      ) : null}
      {a.fatal === true && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          Disqualifier: {String(a.fatal_trigger ?? "a must-have criterion is not met")}
        </p>
      )}
      {a.below_award_floor === true && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          The award is below the floor your organisation pursues, so the suggestion is capped at Park.
        </p>
      )}
      {a.confidence_note ? <p className="mt-2 text-sm text-slate-500">{String(a.confidence_note)}</p> : null}

      <div className="mt-4">
        {criteria.map((c) => {
          const band = c.band as number | null;
          const colour = band === 2 ? "border-l-brand" : band === 1 ? "border-l-amber-400"
            : band === 0 ? "border-l-red-500" : "border-l-slate-300";
          return (
            <div key={String(c.key)} className={`mb-1.5 flex items-center gap-3 rounded-lg border border-slate-200 border-l-4 bg-white px-3 py-1.5 ${colour}`}>
              <span className="flex-1 text-sm text-slate-700">
                {String(c.title)}
                {c.is_must === true && <span className="ml-1.5 text-xs text-slate-400">must</span>}
              </span>
              <span className="text-sm font-bold">{String(c.label ?? "")}</span>
              <span className="min-w-24 text-right text-xs text-slate-400">{String(c.count_text ?? "")}</span>
              <span className="min-w-16 text-right text-xs text-slate-600">
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

  const rail = <div className="w-full shrink-0 lg:w-80">
    <OpportunityRail tenantName={user.view?.name ?? user.tenant?.name} />
  </div>;

  if (!uid) {
    return (
      <div className="flex flex-col gap-6 pt-4 lg:flex-row">
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-bold text-navy">Opportunity</h1>
          <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900">
            No opportunity selected. Open one from the <strong>Live Opportunity Feed</strong> on Home or Pipelines.
          </p>
          <Link to={hrefOf("pipelines")} className="mt-3 inline-block text-brand hover:underline">📚 Go to Pipelines</Link>
        </div>
        {rail}
      </div>
    );
  }

  let body;
  if (error) {
    body = <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">Couldn't load <code>{uid}</code>: {error}</p>;
  } else if (!data) {
    body = (
      <p className="mt-6 flex items-center gap-2 text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        {engine.state === "starting" ? engine.detail : "Loading this opportunity…"}
      </p>
    );
  } else if (!data.found) {
    body = (
      <>
        <h1 className="text-3xl font-bold text-navy">Opportunity</h1>
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Couldn't find an opportunity with uid <code>{uid}</code>. It may have been deleted, or it belongs
          to another tenant.
        </p>
        <Link to={hrefOf("pipelines")} className="mt-3 inline-block text-brand hover:underline">📚 Back to Pipelines</Link>
      </>
    );
  } else {
    const d = data as OpportunityResult & { orgName?: string; link?: string; analysis: Record<string, unknown> | null };
    body = (
      <>
        <h1 className="text-3xl font-bold text-navy">{d.title}</h1>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {d.chips.map((c, i) => <Chip key={i} text={c.text} tone={c.tone} />)}
        </div>
        <p className="mt-2 text-sm text-slate-600">
          {d.funder}{d.reference ? ` · ${d.reference}` : ""}
        </p>
        {d.link && (
          <a href={d.link} target="_blank" rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
            Open the call <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}

        <SectionHeading>1 · The opportunity</SectionHeading>
        {d.awardHeadline && <p className="mb-3 text-lg font-semibold text-slate-800">{d.awardHeadline}</p>}
        {d.overview.map(([heading, lines, missing], i) => (
          <div key={i} className="mb-3">
            <h4 className="mb-1 font-bold text-[#24352c]">{heading}</h4>
            {lines.map((l, j) => (
              <p key={j} className={`text-sm leading-relaxed ${missing ? "italic text-slate-400" : "text-slate-700"}`}>{l}</p>
            ))}
          </div>
        ))}
        {d.pageRows.map((row, i) => (
          <div key={i} className="grid gap-4 md:grid-cols-2">
            {row.map((col, j) => (
              <div key={j}>{col.map((b, k) => <BlockView key={k} block={b} />)}</div>
            ))}
          </div>
        ))}
        {d.narrative.map(([heading, lines, missing], i) => (
          <div key={i} className="mb-3">
            <h4 className="mb-1 font-bold text-[#24352c]">{heading}</h4>
            {lines.map((l, j) => (
              <p key={j} className={`text-sm leading-relaxed ${missing ? "italic text-slate-400" : "text-slate-700"}`}>{l}</p>
            ))}
          </div>
        ))}

        <SectionHeading>2 · Decision aid — is this worth bidding?</SectionHeading>
        {d.analysis
          ? <Analysis a={d.analysis} who={d.orgName?.trim() || "your organisation"} />
          : <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900">
            No scoring is available for this opportunity yet. It needs a tenant profile and a screened
            row before the criteria can be evaluated.
          </p>}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6 pt-4 lg:flex-row">
      <div className="min-w-0 flex-1">{body}</div>
      {rail}
    </div>
  );
}
