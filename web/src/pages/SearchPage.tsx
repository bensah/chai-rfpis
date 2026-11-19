/**
 * Search — `app_pages/search.py`.
 *
 * A mini search engine scoped to the app, then the open web. The two halves are not the
 * same kind of thing and the page does not pretend they are:
 *
 *   IN-APP   a static registry of pages, tabs and features, plus live matches in the
 *            organisation's own opportunities and donors. Three cheap reads, answered in
 *            the request, and the results are LINKS — the point is to arrive somewhere.
 *   THE WEB  one keyword fanned out into several RFP-framed searches across Serper and
 *            Tavily, filtered through seven rules. It holds the provider keys, it fetches
 *            candidate pages to read their posted dates, and it took 21.4 seconds the last
 *            time it was measured. It runs as a job and this page polls it.
 *
 * THE QUERY LIVES IN THE URL (`?q=`), as it does in the Python, so a refresh or a shared
 * link reproduces the same search. The page number does NOT, which is a deliberate
 * difference: Streamlit put it in `?p=` because its page-number links were anchors and a
 * rerun had nowhere else to keep it. Here paging is state, and a link somebody sends should
 * open on the first page of results rather than wherever the sender happened to be.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight, ExternalLink, Globe, Map, Search as SearchIcon,
  Sparkles, ThumbsDown, ThumbsUp, Minus, Plus, RotateCw,
} from "lucide-react";
import {
  ApiError, searchAction, siteSearch, startWebSearch,
  type SiteSearch, type WebHit, type WebSearchResult,
} from "../api";
import { awaitJob } from "../jobs";
import { hrefOf, Link, navigate, useLocation } from "../router";
import { Badge, Button, Card, Notice, PageHeader, Spinner, fieldClass } from "../ui";

const PER_PAGE = 15;

/** The query the URL is asking for. */
function urlQuery(): string {
  return new URLSearchParams(window.location.search).get("q")?.trim() ?? "";
}

export default function SearchPage() {
  useLocation();                       // re-render when ?q= changes under us
  const q = urlQuery();
  const [draft, setDraft] = useState(q);
  const [hits, setHits] = useState<SiteSearch | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState({ nav: true, opps: true, donors: true });

  // Web half
  const [web, setWeb] = useState<WebSearchResult | null>(null);
  const [webFor, setWebFor] = useState("");
  const [webStatus, setWebStatus] = useState("");
  const [webError, setWebError] = useState("");
  const [page, setPage] = useState(1);
  // Per-result state, keyed on the link, so a rating or a track survives paging and the
  // button it belongs to can say it is done.
  const [rated, setRated] = useState<Record<string, string>>({});
  const [tracked, setTracked] = useState<Record<string, string>>({});
  const runId = useRef(0);

  useEffect(() => { setDraft(q); }, [q]);

  useEffect(() => {
    if (q.length < 2) { setHits(null); return; }
    let live = true;
    siteSearch(q)
      .then((r) => { if (live) { setHits(r); setError(""); } })
      .catch((e) => live && setError(e instanceof ApiError ? e.message : "Search failed."));
    return () => { live = false; };
  }, [q]);

  // A new query retires the previous web run. Its results answered a different question
  // and leaving them on screen under a new heading is the one thing this page must not do.
  useEffect(() => {
    if (q !== webFor) { setWeb(null); setWebStatus(""); setWebError(""); setPage(1); }
  }, [q, webFor]);

  const submit = (text: string) => {
    const next = text.trim();
    navigate(next ? `/search?q=${encodeURIComponent(next)}` : "/search");
  };

  const runWeb = useCallback(async (fresh: boolean) => {
    const mine = ++runId.current;
    setWeb(null);
    setWebError("");
    setWebFor(q);
    setPage(1);
    setWebStatus("Queueing…");
    try {
      const { jobId } = await startWebSearch(q, fresh);
      const done = await awaitJob(jobId, (j) => {
        if (runId.current === mine) setWebStatus(j.message || j.status);
      }, { everyMs: 2000, timeoutMs: 240_000 });
      if (runId.current !== mine) return;       // a newer run started; this one is stale
      if (!done || done.status !== "done") {
        setWebError(done?.message
          || "The search did not finish. It may still be running — try again in a moment.");
        setWebStatus("");
        return;
      }
      setWeb((done.result ?? {}) as WebSearchResult);
      setWebStatus("");
    } catch (e) {
      if (runId.current !== mine) return;
      setWebError(e instanceof ApiError ? e.message : "The web search could not be started.");
      setWebStatus("");
    }
  }, [q]);

  /** Rate or track one hit. Both queue a job; the button reports what came back. */
  const act = async (
    hit: WebHit, action: "feedback" | "track", verdict?: "good" | "neutral" | "bad",
  ) => {
    const key = hit.link;
    if (action === "feedback") setRated((p) => ({ ...p, [key]: verdict ?? "" }));
    else setTracked((p) => ({ ...p, [key]: "…" }));
    try {
      const { jobId } = await searchAction(action, hit, verdict);
      const done = await awaitJob(jobId, undefined, { everyMs: 1500, timeoutMs: 120_000 });
      if (action === "track") {
        // `load_candidate`'s four outcomes, named as the module names them. `skipped`
        // is the one that is NOT a failure: it means something already tracks this call.
        const r = (done?.result ?? {}) as {
          ok?: boolean; uid?: string; routed?: string; rejected?: boolean;
          skipped?: boolean; reason?: string;
        };
        setTracked((p) => ({
          ...p,
          [key]: done?.status !== "done" ? "Couldn't track"
            : r.ok ? `Tracked as ${r.uid}`
            : r.routed === "registry" ? "Added to Sources"
            : r.rejected ? `Not added — ${r.reason ?? "rejected"}`
            : r.skipped ? "Already tracked"
            : r.reason ?? "Not added",
        }));
      } else if (done?.status !== "done") {
        // A rating that did not record must not keep its tick, or the reader believes the
        // scorer learned something it never saw.
        setRated((p) => { const n = { ...p }; delete n[key]; return n; });
      }
    } catch {
      if (action === "track") setTracked((p) => ({ ...p, [key]: "Couldn't track" }));
      else setRated((p) => { const n = { ...p }; delete n[key]; return n; });
    }
  };

  const results = web?.results ?? [];
  const pages = Math.max(1, Math.ceil(results.length / PER_PAGE));
  const cur = Math.min(page, pages);
  const shown = results.slice((cur - 1) * PER_PAGE, cur * PER_PAGE);
  const dropped = web ? DROP_LABELS
    .map(([k, word]) => [web[k] as number | undefined, word] as const)
    .filter(([n]) => (n ?? 0) > 0)
    .map(([n, word]) => `${n} ${word}`) : [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Search"
        lead="Pages, tabs, opportunities and donors in this app — then the open web." />

      <form onSubmit={(e) => { e.preventDefault(); submit(draft); }} className="flex gap-2">
        <label className="relative min-w-0 flex-1">
          <SearchIcon size={15} aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="Search pages, tabs, opportunities, donors…"
            aria-label="Search the site" autoFocus
            className={`${fieldClass} pl-9`} />
        </label>
        <Button type="submit" variant="primary">Search</Button>
      </form>

      {q.length < 2 ? (
        <Notice tone="neutral">
          Type a keyword above (2+ characters) to search across pages, tabs, opportunities
          and donors.
        </Notice>
      ) : error ? (
        <Notice tone="bad">{error}</Notice>
      ) : !hits ? (
        <Spinner label="Searching…" />
      ) : (
        <>
          <p className="text-sm text-ink-500">
            {hits.total} result{hits.total === 1 ? "" : "s"} in this app for “{q}”
          </p>
          {hits.total === 0 && (
            <Notice tone="warn">
              No in-app matches. Try fewer or different keywords — a donor name, a page like{" "}
              <em>blacklist</em> or <em>manage users</em>, or part of an opportunity title.
              You can also search the web below.
            </Notice>
          )}

          {hits.nav.length > 0 && (
            <Group icon={<ChevronRight size={14} aria-hidden />} title="Pages & tabs"
              count={hits.nav.length} open={open.nav}
              onToggle={() => setOpen((p) => ({ ...p, nav: !p.nav }))}>
              <ul className="divide-y divide-ink-100">
                {hits.nav.map((n) => (
                  <li key={n.label + n.href}>
                    <Link to={n.href}
                      className="flex items-center gap-2 py-2 text-sm text-accent-700 hover:text-accent-800">
                      <ChevronRight size={14} aria-hidden className="text-ink-400" />
                      {n.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </Group>
          )}

          {hits.opportunities.length > 0 && (
            <Group icon={<SearchIcon size={14} aria-hidden />} title="Opportunities"
              count={hits.opportunities.length} open={open.opps}
              onToggle={() => setOpen((p) => ({ ...p, opps: !p.opps }))}>
              <ul className="divide-y divide-ink-100">
                {hits.opportunities.map((o) => (
                  <li key={o.uid || o.title} className="py-2">
                    {/* The Streamlit hit lands on the Pipelines page and leaves the reader
                        to find the row; this one opens the call, because /opportunity
                        takes a uid. */}
                    <Link to={hrefOf("opportunity", { uid: o.uid })}
                      className="text-sm font-medium text-accent-700 hover:text-accent-800">
                      {o.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {[o.funder, o.deadline && `Deadline ${o.deadline}`,
                        o.decision && title(o.decision), o.source && title(o.source)]
                        .filter(Boolean).join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
            </Group>
          )}

          {hits.donors.length > 0 && (
            <Group icon={<Map size={14} aria-hidden />} title="Donors"
              count={hits.donors.length} open={open.donors}
              onToggle={() => setOpen((p) => ({ ...p, donors: !p.donors }))}>
              <ul className="divide-y divide-ink-100">
                {hits.donors.map((d) => (
                  <li key={d.name}>
                    <Link to={hrefOf("donors")}
                      className="block py-2 text-sm text-accent-700 hover:text-accent-800">
                      {d.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </Group>
          )}

          {/* ── The web ─────────────────────────────────────────────────── */}
          <Card className="p-4">
            <h2 className="flex items-center gap-2 text-base font-semibold text-brand-700">
              <Globe size={17} aria-hidden /> Opportunities on the web
            </h2>
            <p className="mt-1 text-sm text-ink-500">
              One keyword auto-expands into RFP-framed searches across every configured
              engine, then keeps only results that pass your health-theme and RFP-signal
              rules and your blacklist. Broad terms sweep the whole portfolio; specific
              terms stay focused.
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void runWeb(false)}
                disabled={!!webStatus}>
                <Globe size={15} aria-hidden /> Search the web for “{q}”
              </Button>
              {web && (
                <Button variant="secondary" onClick={() => void runWeb(true)}
                  disabled={!!webStatus}>
                  <RotateCw size={14} aria-hidden /> Refresh
                </Button>
              )}
              {webStatus && (
                <span className="text-sm text-ink-500">
                  {webStatus} — this takes about half a minute.
                </span>
              )}
            </div>

            {webError && <Notice tone="bad" className="mt-3">{webError}</Notice>}

            {web && web.available === false && (
              <Notice tone="neutral" className="mt-3">
                <strong>Web search isn't configured yet.</strong> An administrator can
                enable it by adding <code>SERPER_API_KEY</code> (real Google results, 2,500
                free queries from serper.dev) and/or <code>TAVILY_API_KEY</code> to the app
                secrets. Once set, one keyword fans out into several RFP-framed searches and
                keeps only the results that pass your rules.
              </Notice>
            )}

            {web && web.available !== false && web.ok === false && (
              <Notice tone="warn" className="mt-3">
                Web search unavailable: {web.error || "unknown error"}
              </Notice>
            )}

            {web && web.ok && results.length === 0 && (
              <p className="mt-3 text-sm text-ink-500">
                {web.mode === "lookup"
                  ? <>No primary-source match for that exact title (checked {web.raw_count ?? 0} hits).
                      The opportunity may only live on an aggregator, or the title wording differs on
                      the donor's site — try trimming to the distinctive part of the title.</>
                  : <>No web results passed the RFP filter (checked {web.raw_count ?? 0} hits).
                      Try different keywords.</>}
              </p>
            )}

            {results.length > 0 && (
              <>
                {web?.mode === "lookup" && (
                  <p className="mt-3 text-sm text-ink-600">
                    🎯 <strong>Title lookup</strong> — searched the exact phrase and filtered
                    to primary sources (aggregators hidden).
                  </p>
                )}
                {/* The filter explaining itself. A run that keeps 12 of 43 and says nothing
                    about the other 31 looks broken rather than selective. */}
                <p className="mt-2 text-xs text-ink-500">
                  {results.length} of {web?.raw_count ?? results.length} web results matched
                  your RFP configuration
                  {dropped.length > 0 && <> · dropped {dropped.join(", ")}</>} · showing{" "}
                  {(cur - 1) * PER_PAGE + 1}–{(cur - 1) * PER_PAGE + shown.length} (page {cur} of{" "}
                  {pages}), best matches first.
                </p>
                <p className="mt-1 text-xs text-ink-400">
                  Rate a result to feed the learning engine, or <strong>Track</strong> it
                  into Found Records as a scored candidate for review.
                </p>

                <ul className="mt-3 divide-y divide-ink-100">
                  {shown.map((r) => (
                    <WebResult key={r.link} hit={r} rated={rated[r.link]}
                      tracked={tracked[r.link]} onAct={act} />
                  ))}
                </ul>

                {pages > 1 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3 text-sm">
                    {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
                      <button key={n} type="button" onClick={() => setPage(n)}
                        className={n === cur
                          ? "font-bold text-good-700"
                          : "text-accent-700 hover:text-accent-800"}>
                        {n}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {(web?.suggest ?? []).length > 0 && (
              <div className="mt-4 border-t border-ink-100 pt-3">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink-600">
                  <Sparkles size={13} aria-hidden /> Related searches
                </p>
                <div className="flex flex-wrap gap-2">
                  {web!.suggest!.map((tterm) => (
                    <button key={tterm} type="button" onClick={() => submit(tterm)}
                      className="rounded-full bg-brand-50 px-3 py-1 text-xs text-brand-700 transition-colors hover:bg-brand-100">
                      {tterm}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/** The filter's own counts, in the Python's order, with the words it uses. */
const DROP_LABELS: [keyof WebSearchResult, string][] = [
  ["dropped_aggregator", "aggregator/blog"],
  ["dropped_expired", "expired"],
  ["dropped_old", "stale"],
  ["dropped_notrfp", "not a call"],
  ["dropped_geo", "out-of-geo"],
  ["dropped_scholarship", "scholarship"],
  ["dropped_offtopic", "job/off-topic"],
  ["dropped_lang", "non-EN/FR"],
];

const title = (v: string) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();

/** A collapsible result group — the Python's expanders, which default open. */
function Group({ icon, title: heading, count, open, onToggle, children }: {
  icon: React.ReactNode; title: string; count: number; open: boolean;
  onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <button type="button" onClick={onToggle}
        className="flex w-full items-center gap-2 text-left text-sm font-semibold text-brand-700">
        {open ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
        {icon} {heading} <Badge>{count}</Badge>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </Card>
  );
}

/**
 * One web hit: the link, a two-line summary, and the four actions.
 *
 * The summary is clamped to two lines so every result is the same height — the Streamlit
 * page does this with CSS line-clamp AND a hard 200-character cap, and both are kept: the
 * cap bounds what travels, the clamp bounds what is drawn.
 */
function WebResult({ hit, rated, tracked, onAct }: {
  hit: WebHit; rated?: string; tracked?: string;
  onAct: (h: WebHit, a: "feedback" | "track", v?: "good" | "neutral" | "bad") => void;
}) {
  const snippet = (hit.snippet ?? "").length > 200
    ? `${(hit.snippet ?? "").slice(0, 200).trimEnd()}…` : (hit.snippet ?? "");
  const lead = hit.deadline
    ? <span className="font-semibold text-good-700">Deadline {hit.deadline} · </span>
    : hit.page_date
      ? <span className="text-ink-400">Posted {hit.page_date} · </span>
      : null;
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
      <div className="min-w-0 flex-1">
        <a href={hit.link} target="_blank" rel="noreferrer noopener"
          className="flex items-center gap-1 truncate text-sm font-semibold text-accent-700 hover:text-accent-800">
          {hit.title} <ExternalLink size={12} aria-hidden className="shrink-0" />
        </a>
        <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-ink-600">
          {lead}<span className="text-ink-400">{hit.domain}</span> — {snippet}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {([["good", ThumbsUp], ["neutral", Minus], ["bad", ThumbsDown]] as const).map(([v, Icon]) => (
          <button key={v} type="button" title={`${title(v)} — like a ${
            v === "good" ? "Proceed" : v === "neutral" ? "Park" : "Decline"}.`}
            aria-label={`Rate ${v}`}
            disabled={rated === v}
            onClick={() => onAct(hit, "feedback", v)}
            className={`rounded p-1 transition-colors ${rated === v
              ? "text-accent-700" : "text-ink-300 hover:text-ink-600"}`}>
            <Icon size={14} aria-hidden />
          </button>
        ))}
        <button type="button" disabled={!!tracked}
          onClick={() => onAct(hit, "track")}
          title="Load into Found Records as a scored candidate awaiting review."
          className="ml-1 inline-flex items-center gap-1 rounded-lg border border-ink-300 px-2 py-1 text-xs text-ink-700 transition-colors hover:border-accent-600 hover:text-accent-700 disabled:border-ink-200 disabled:text-ink-400">
          {tracked ? tracked : <><Plus size={12} aria-hidden /> Track</>}
        </button>
      </div>
    </li>
  );
}
