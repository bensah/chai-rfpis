/**
 * Alerts — everything the system has to tell this tenant, in one place.
 *
 * The bell has carried this feed all along, but a popover is a glance: fifteen items, one
 * line each, gone when you click away. This is the screen you watch. Same data, the whole
 * list, and each item opens to the facts behind it rather than only a link somewhere else
 * (owner, 2026-11-09).
 *
 * WHAT ARRIVES HERE. Completed scans, calls a person submitted, and — new — calls the
 * engine rated Proceed or Park. That last one is why `recentFeed` no longer drops every
 * auto row: the flood is still suppressed (a Friday scan adds dozens, and the scan line
 * already says so once), but a verdict worth a reader's attention is not a flood.
 *
 * Role filtering is deliberately NOT here yet. Every member sees their tenant's alerts
 * while the owner decides the rule, because that is the direction you can narrow later
 * without anybody losing sight of something they had been watching.
 */
import { useEffect, useMemo, useState } from "react";
import { fetchShell, markAllRead, type FeedItem, type Shell } from "../api";
import { hrefOf, Link, type PageKey } from "../router";
import { fmtScan, relativeTime } from "../shell/time";
import { Badge, Button, Card, Notice, PageHeader, fieldClass } from "../ui";

const KINDS = [
  { key: "all", label: "Everything" },
  { key: "verdict", label: "Proceed / Park" },
  { key: "opportunity", label: "Submitted by the team" },
  { key: "scan", label: "Scans" },
] as const;

type KindKey = (typeof KINDS)[number]["key"];

function AlertRow({ item, isNew, open, onToggle }: {
  item: FeedItem; isNew: boolean; open: boolean; onToggle: () => void;
}) {
  const to = item.nav === "opportunity" && item.uid
    ? hrefOf("opportunity", { uid: item.uid })
    : hrefOf(item.nav as PageKey);
  return (
    <li className="border-b border-ink-100 last:border-0">
      {/* The row itself expands rather than navigating. Going somewhere else is a
          deliberate second action, because the question "what is this?" is answered here
          and "take me to it" is not the same question. */}
      <button
        onClick={onToggle} aria-expanded={open}
        className="flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-50/70"
      >
        <span aria-hidden className="mt-0.5 text-base leading-none">{item.icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink-800">{item.title}</span>
            {isNew && <Badge tone="accent">New</Badge>}
          </span>
          <span className="mt-0.5 block truncate text-sm text-ink-600">{item.detail}</span>
        </span>
        <span className="shrink-0 text-xs whitespace-nowrap text-ink-400">
          {relativeTime(item.ts)}
        </span>
      </button>

      {open && (
        <div className="bg-ink-50/60 px-4 pt-1 pb-4">
          <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {(item.facts ?? []).map((f) => (
              <div key={f.label} className="flex gap-2 text-sm">
                <dt className="shrink-0 text-ink-500">{f.label}</dt>
                <dd className="min-w-0 break-words text-ink-800">{f.value}</dd>
              </div>
            ))}
            <div className="flex gap-2 text-sm">
              <dt className="shrink-0 text-ink-500">When</dt>
              <dd className="text-ink-800">{fmtScan(new Date(item.ts))}</dd>
            </div>
          </dl>
          <div className="mt-3">
            <Link to={to} className="text-sm text-accent-700 hover:underline">
              {item.kind === "scan" ? "Open the report" : "Open this opportunity"} →
            </Link>
          </div>
        </div>
      )}
    </li>
  );
}

export default function AlertsPage() {
  const [shell, setShell] = useState<Shell | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindKey>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  // Captured ONCE, on arrival. Marking the feed read immediately would erase the "New"
  // badges in front of the reader, which is the one thing they came to look at.
  const [seenAtArrival, setSeenAtArrival] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    fetchShell()
      .then((s) => {
        setShell(s);
        setSeenAtArrival((prev) => (prev === undefined ? s.seen : prev));
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Couldn't load alerts."));
  }, []);

  const feed = shell?.feed ?? [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return feed.filter((it) => {
      if (kind !== "all" && it.kind !== kind) return false;
      if (!needle) return true;
      return `${it.title} ${it.detail}`.toLowerCase().includes(needle);
    });
  }, [feed, kind, q]);

  const unread = shell?.unread ?? 0;

  return (
    <div>
      <PageHeader
        title="Alerts"
        lead="Scans, new calls the system rated Proceed or Park, and what the team has added."
      />
      {error && <Notice tone="warn" className="mb-4">{error}</Notice>}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {KINDS.map((k) => (
          <button
            key={k.key} onClick={() => { setKind(k.key); setOpen(null); }}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              kind === k.key
                ? "bg-brand-700 text-white"
                : "bg-ink-100 text-ink-600 hover:bg-ink-200"
            }`}
          >
            {k.label}
          </button>
        ))}
        <input
          value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter alerts"
          placeholder="Filter alerts" className={`${fieldClass} ml-auto max-w-xs py-1.5`}
        />
        {unread > 0 && (
          <Button size="sm" variant="secondary"
            onClick={() => markAllRead().then((r) =>
              setShell((s) => (s ? { ...s, seen: r.seen, unread: 0 } : s)))}>
            Mark all read
          </Button>
        )}
      </div>

      <Card className="overflow-hidden">
        {!shell && !error && (
          <p className="px-4 py-10 text-center text-sm text-ink-500">Loading alerts…</p>
        )}
        {shell && !shown.length && (
          <p className="px-4 py-10 text-center text-sm text-ink-500">
            {feed.length
              ? "No alerts match that filter."
              : "Nothing yet. The Friday scan is usually the first thing to arrive."}
          </p>
        )}
        <ul>
          {shown.map((it, i) => (
            <AlertRow
              key={`${it.ts}-${i}`} item={it}
              isNew={seenAtArrival == null || it.ts > seenAtArrival}
              open={open === i} onToggle={() => setOpen(open === i ? null : i)}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}
