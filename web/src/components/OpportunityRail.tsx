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
import { ExternalLink, Loader2, Radio } from "lucide-react";
import { fetchFeedRows } from "../api";
import { scoreFeed, useEngine } from "../scoring/engine";
import type { FeedItem, FeedResult } from "../scoring/protocol";
import { hrefOf, Link } from "../router";
import { Card, Eyebrow } from "../ui";

/** views/opportunity_rail.py::_fmt_amount */
export function fmtAmount(amount: number, currency: string): string {
  if (!amount || amount <= 0) return "";
  const sym = ({ USD: "$", EUR: "€", GBP: "£" } as Record<string, string>)[(currency || "").toUpperCase()] ?? "";
  for (const [unit, div] of [["B", 1e9], ["M", 1e6], ["K", 1e3]] as [string, number][]) {
    if (amount >= div) return `${sym}${(amount / div).toFixed(1)}${unit}`.replace(".0", "");
  }
  return `${sym}${Math.round(amount).toLocaleString("en-US")}`;
}

/** views/opportunity_rail.py::_deadline_chip, as a label plus the tone it was coloured by. */
export function deadlineChip(days: number | null): { text: string; className: string } | null {
  if (days === null) return null;
  if (days < 0) return { text: "closed", className: "text-ink-400" };
  if (days === 0) return { text: "due today", className: "text-bad-700 font-medium" };
  if (days <= 14) return { text: `${days}d left`, className: "text-bad-700 font-medium" };
  if (days <= 45) return { text: `${days}d left`, className: "text-gold-700 font-medium" };
  return { text: `${days}d`, className: "text-ink-500" };
}

function Item({ item }: { item: FeedItem }) {
  const title = item.title.length > 70 ? `${item.title.slice(0, 70)}…` : item.title;
  const uid = String(item.uid ?? "").trim();
  const amount = fmtAmount(item.amount, item.currency);
  const chip = deadlineChip(item.days_until);
  return (
    <div className="border-t border-ink-100 py-2.5 first:border-t-0 first:pt-0">
      {uid ? (
        <Link to={hrefOf("opportunity", { uid })} title="Open this opportunity in full"
          className="text-sm leading-snug font-semibold text-brand-700 hover:text-accent-700 hover:underline">
          {title}
        </Link>
      ) : (
        <span className="text-sm leading-snug font-semibold text-ink-800">{title}</span>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-500">
        {item.funder && <span className="truncate">{item.funder.slice(0, 34)}</span>}
        {amount && <span className="font-medium text-ink-700">{amount}</span>}
        {chip && <span className={chip.className}>{chip.text}</span>}
        {item.link && (
          <a href={item.link} target="_blank" rel="noreferrer" title="Open the call"
            className="text-accent-600 hover:text-accent-700">
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      {item._why && (
        <p className="mt-1 text-xs leading-snug text-accent-700">
          <span className="font-semibold">Why:</span> {item._why}
        </p>
      )}
    </div>
  );
}

function FeedCard({ title, help, items, empty }: {
  title: string; help: string; items: FeedItem[] | undefined; empty: string;
}) {
  return (
    <Card className="mb-3 p-4">
      <h3 className="text-sm font-semibold text-ink-800">{title}</h3>
      <p className="mt-0.5 text-xs leading-snug text-ink-500">{help}</p>
      <div className="mt-2.5">
        {items === undefined ? (
          <div className="py-3 text-xs text-ink-400">…</div>
        ) : items.length === 0 ? (
          <p className="py-1 text-xs text-ink-400 italic">{empty}</p>
        ) : (
          items.map((it, i) => <Item key={`${it.uid ?? i}`} item={it} />)
        )}
      </div>
    </Card>
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
      <Eyebrow>
        <span className="inline-flex items-center gap-1.5">
          <Radio className="h-3.5 w-3.5 text-bad-600" /> Live opportunity feed
        </span>
      </Eyebrow>
      <p className="mt-1 mb-2.5 text-xs text-ink-500">Every title opens that opportunity in full.</p>
      {!feed && !error && (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-ink-500">
          <Loader2 className="h-3 w-3 animate-spin text-accent-600" />
          {engine.state === "starting" ? engine.detail : "Ranking opportunities…"}
        </p>
      )}
      {error && <p className="mb-3 text-xs text-ink-500 italic">Opportunity feed unavailable: {error}</p>}
      <FeedCard title="🎯 Featured for you"
        help={"Ranked from the whole catalogue against your geography, programme areas and the funders you " +
          "work with — including calls your screening didn't pick up."}
        items={feed?.featured} empty="Nothing to feature yet — run an extraction." />
      <FeedCard title="✅ Top Matches" help={`Strong fit for ${who} (Proceed / Park / high alignment).`}
        items={feed?.top_matches} empty="No strong matches yet." />
      <FeedCard title="💰 Top Funding" help={`Biggest / most-urgent calls ${who} is geographically eligible for.`}
        items={feed?.top_funding} empty="No live opportunities yet — run a scan." />
      <FeedCard title="✨ Also Interesting" help="Fresh calls that aren't a match but are worth a look."
        items={feed?.other} empty="Nothing else new right now." />
    </aside>
  );
}
