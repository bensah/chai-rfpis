/**
 * The live opportunity feed — a port of views/opportunity_rail.py.
 *
 * Four cards, in the order the owner settled on: Featured (ranked from the WHOLE shared
 * catalogue, so it can surface a call screening never reached), then Top Matches, Top
 * Funding and Also Interesting from the tenant's own pipeline.
 *
 * The ranking is not re-implemented here. The rows come from the API and go straight to the
 * Python engine (core/opportunity_feed.py), which is what Streamlit runs.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { fetchFeedRows } from "../api";
import { scoreFeed, useEngine } from "../scoring/engine";
import type { FeedItem, FeedResult } from "../scoring/protocol";
import { hrefOf, Link } from "../router";

/** views/opportunity_rail.py::_fmt_amount */
export function fmtAmount(amount: number, currency: string): string {
  if (!amount || amount <= 0) return "";
  const sym = ({ USD: "$", EUR: "€", GBP: "£" } as Record<string, string>)[(currency || "").toUpperCase()] ?? "";
  for (const [unit, div] of [["B", 1e9], ["M", 1e6], ["K", 1e3]] as [string, number][]) {
    if (amount >= div) return `${sym}${(amount / div).toFixed(1)}${unit}`.replace(".0", "");
  }
  return `${sym}${Math.round(amount).toLocaleString("en-US")}`;
}

/** views/opportunity_rail.py::_deadline_chip */
export function deadlineChip(days: number | null): string {
  if (days === null) return "";
  if (days < 0) return "⏳ closed";
  if (days === 0) return "⏳ due today";
  if (days <= 14) return `🔴 ${days}d left`;
  if (days <= 45) return `🟠 ${days}d left`;
  return `🗓 ${days}d`;
}

function Item({ item }: { item: FeedItem }) {
  const title = item.title.length > 70 ? `${item.title.slice(0, 70)}…` : item.title;
  const bits = [item.funder.slice(0, 34), fmtAmount(item.amount, item.currency), deadlineChip(item.days_until)]
    .filter(Boolean);
  const uid = String(item.uid ?? "").trim();
  return (
    <div className="border-b border-slate-100 py-2.5 last:border-b-0">
      {uid ? (
        <Link to={hrefOf("opportunity", { uid })} title="Open this opportunity in full"
          className="text-sm font-semibold text-brand-dark hover:underline">
          {title}
        </Link>
      ) : (
        <span className="text-sm font-semibold">{title}</span>
      )}
      <div className="mt-0.5 text-xs text-slate-500">
        {bits.join("  ·  ")}
        {item.link && (
          <>
            {bits.length ? "  ·  " : ""}
            <a href={item.link} target="_blank" rel="noreferrer" className="text-brand hover:underline">↗</a>
          </>
        )}
      </div>
      {item._why && <div className="mt-0.5 text-xs text-brand">
        <strong>Why:</strong> {item._why}
      </div>}
    </div>
  );
}

function Card({ title, help, items, empty }: {
  title: string; help: string; items: FeedItem[] | undefined; empty: string;
}) {
  return (
    <section className="mb-3 rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="font-semibold text-slate-800">{title}</h3>
      <p className="mt-0.5 text-xs text-slate-500">{help}</p>
      <div className="mt-2">
        {items === undefined ? (
          <div className="py-2 text-xs text-slate-400">…</div>
        ) : items.length === 0 ? (
          <p className="py-1 text-xs italic text-slate-400">{empty}</p>
        ) : (
          items.map((it, i) => <Item key={`${it.uid ?? i}`} item={it} />)
        )}
      </div>
    </section>
  );
}

export default function OpportunityRail({ tenantName }: { tenantName?: string | null }) {
  const [feed, setFeed] = useState<FeedResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const engine = useEngine();
  const who = tenantName?.trim() || "your organisation";

  useEffect(() => {
    let live = true;
    fetchFeedRows()
      .then((rows) => scoreFeed(rows))
      .then((r) => live && setFeed(r))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Feed unavailable."));
    return () => {
      live = false;
    };
  }, []);

  return (
    <aside className="w-full">
      <div className="text-xs font-bold tracking-wide text-brand">🔴 LIVE OPPORTUNITY FEED</div>
      <p className="mb-2 mt-0.5 text-xs text-slate-500">Every title opens that opportunity in full.</p>
      {!feed && !error && (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-slate-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          {engine.state === "starting" ? engine.detail : "Ranking opportunities…"}
        </p>
      )}
      {error && <p className="mb-3 text-xs italic text-slate-500">Opportunity feed unavailable: {error}</p>}
      <Card title="🎯 Featured for you"
        help={"Ranked from the whole catalogue against your geography, programme areas and the funders you " +
          "work with — including calls your screening didn't pick up."}
        items={feed?.featured} empty="Nothing to feature yet — run an extraction." />
      <Card title="✅ Top Matches" help={`Strong fit for ${who} (Proceed / Park / high alignment).`}
        items={feed?.top_matches} empty="No strong matches yet." />
      <Card title="💰 Top Funding" help={`Biggest / most-urgent calls ${who} is geographically eligible for.`}
        items={feed?.top_funding} empty="No live opportunities yet — run a scan." />
      <Card title="✨ Also Interesting" help="Fresh calls that aren't a match but are worth a look."
        items={feed?.other} empty="Nothing else new right now." />
    </aside>
  );
}
