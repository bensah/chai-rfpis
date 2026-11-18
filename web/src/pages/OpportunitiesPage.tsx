/**
 * Triage — every call in one list, filtered by the Dashboard figure you came in through.
 *
 * The owner's ask: make the numbers on the Dashboard doors. Click "Awaiting review 17" and
 * get those seventeen, with the titles leading to the full record. This is the room behind
 * every one of those doors, and the filters let you change which door you are standing in
 * without going back.
 *
 * IT OWNS NO DEFINITIONS. "Awaiting review" is not a `filter` written here — every row
 * arrives already tagged with the figures it belongs to, computed by the same module that
 * counts the tiles (supabase/functions/_shared/api/home_buckets.ts). This page tests
 * membership in a list of keys. That is the whole point: a tile saying 17 over a page
 * listing 19 gives a reader no way to tell which one lied, and the only way to be sure is
 * for there to be one selection rather than two.
 *
 * The second filter row — funder, lead, decision, text — is a narrowing of what the bucket
 * already chose, which is a presentation decision and safe to make here. It never widens.
 *
 * ROWS AND APPLICATIONS. Four buckets weigh applications rather than count calls, because
 * a proposal sent to the same funder twice is two applications and one call. So
 * "Applications sent 24" opens 21 opportunities, and the header says both numbers rather
 * than letting the reader think five went missing.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowUpDown, CalendarClock, ChevronLeft, ChevronRight, ExternalLink,
  Pencil, Search, X,
} from "lucide-react";
import {
  fetchOpportunityList,
  type OpportunityBucket, type OpportunityList, type OpportunityListRow, type User,
} from "../api";
import RfpEditor from "../opportunity/RfpEditor";
import { hrefOf, Link, setParams, useLocation } from "../router";
import {
  Badge, Card, EmptyState, IconButton, Notice, PageHeader, Select, Spinner, field,
  type Tone,
} from "../ui";

/** Rows per page (owner, 2026-11-18). Ten is also what Funding and Donors show, and a
 *  reader moving between them should not have to learn a different page size for each. */
const PAGE_SIZE = 10;

const DECISION_TONE: Record<string, Tone> = {
  proceed: "good", "proceed as sub": "good", park: "warn", decline: "bad",
};
const ANSWER_TONE: Record<string, Tone> = {
  approved: "good", "not approved": "bad", "under review": "warn",
};
const lower = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

const usd = (n: number) => (n ? `$${n.toLocaleString("en-US")}` : "—");

/** Days from today, as the stage tables phrase it. Null deadline sorts last, never first:
 *  a call with no deadline is not urgent. */
function daysTo(deadline: string | null, today: string): number | null {
  if (!deadline) return null;
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${deadline}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / 86400_000);
}

type SortKey = "deadline" | "score" | "value" | "found" | "title";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "deadline", label: "Deadline, soonest first" },
  { key: "score", label: "Bid strength, highest first" },
  { key: "value", label: "Award size, largest first" },
  { key: "found", label: "Found, most recent first" },
  { key: "title", label: "Title, A to Z" },
];

/**
 * The bucket picker — one control, the figures filed under the question each answers.
 *
 * WHY A SELECT AND NOT FOURTEEN CHIPS. The chips were honest but unreadable: fourteen of
 * them wrapped over two rows above the page's own filters, so the thing that decides WHAT
 * YOU ARE LOOKING AT sat apart from, and looked unlike, the things that narrow it. A
 * reader had to scan fourteen labels to find the one question they arrived with.
 *
 * WHY ONE SELECT AND NOT ONE PER GROUP. The buckets are a single choice — picking Archived
 * replaces Awaiting review, it does not combine with it. Three dropdowns would LOOK like
 * three filters that narrow together and would have to silently reset each other, which is
 * the worse lie. `optgroup` gives the parent headings without implying they compose.
 *
 * The counts stay on every option, so the Dashboard's figures are still readable here —
 * they are just read inside the list rather than across the page.
 */
/**
 * The one figure that is a PROMPT rather than a lens, given its own control.
 *
 * Every other bucket answers "show me the calls that are X". This one answers "what runs
 * out soon", and it is the only one on the page with a deadline attached to doing nothing
 * about it — a live bid whose fortnight passes unnoticed is simply not submitted. Inside
 * the dropdown it was a line of text you had to go looking for, which is the wrong shape
 * for the question somebody opens this page to ask first.
 *
 * IT IS STILL IN THE DROPDOWN, under By deadline, and that is deliberate. The buckets are
 * one selection; a shortcut that removed its own target from the list would leave the
 * dropdown with nothing valid to show while the shortcut was active, and a native select
 * with no matching option displays its FIRST one — the page would say "Calls found" while
 * listing the fortnight's bids. Both controls show the same state because they set the
 * same state.
 *
 * Pressing it while it is already on returns to Calls found, so it toggles rather than
 * trapping the reader in a filter they have to go elsewhere to leave.
 */
function DueSoonButton({ bucket, active, onPick }: {
  bucket: OpportunityBucket; active: boolean; onPick: (k: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(active ? "found" : bucket.key)}
      aria-pressed={active}
      title={bucket.rule}
      className={`inline-flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
        active
          ? "border-accent-600 bg-accent-600 text-white hover:bg-accent-700"
          : "border-accent-600/40 bg-accent-50 text-accent-800 hover:border-accent-600 hover:bg-accent-100"}`}
    >
      <CalendarClock className="h-4 w-4" strokeWidth={2} />
      {bucket.label}
      {/* The count is the point of the control: a 0 here is the reassurance, so it is
          never hidden or greyed into invisibility. */}
      <span className={`tabular-nums ${active ? "text-white" : "text-accent-700"}`}>
        {bucket.count}
      </span>
    </button>
  );
}

function BucketPicker({ buckets, groups, active, onPick }: {
  buckets: OpportunityBucket[]; groups: string[];
  active: string; onPick: (k: string) => void;
}) {
  // Any bucket whose group the server did not name still has to appear, or a figure
  // added later would vanish from the page instead of landing under a new heading.
  const named = new Set(groups);
  const rest = buckets.filter((b) => !named.has(b.group));
  const order = rest.length ? [...groups, "Other"] : groups;
  const inGroup = (g: string) =>
    g === "Other" ? rest : buckets.filter((b) => b.group === g);

  return (
    <Select
      aria-label="Which figure to show" className="font-semibold"
      value={active} onChange={(e) => onPick(e.target.value)}
    >
      {order.map((g) => {
        const members = inGroup(g);
        if (!members.length) return null;
        return (
          <optgroup key={g} label={g}>
            {members.map((b) => (
              <option key={b.key} value={b.key} title={b.rule}>
                {b.label} ({b.count})
              </option>
            ))}
          </optgroup>
        );
      })}
    </Select>
  );
}

/**
 * `embedded` — rendered as a SECTION of another screen rather than as the page itself.
 *
 * It drops the PageHeader and nothing else: the heading belongs to whatever is hosting it
 * (Pipeline > Screened says "Triaged calls — full list"), and two headings stacked read as
 * two screens. The filters, the bucket and the table are identical, deliberately — this is
 * one list with two mount points, not a copy, so a change to the triage rules cannot reach
 * one and miss the other.
 *
 * The bucket still lives in the URL, so a Dashboard tile remains an ordinary link however
 * this is mounted, and `setParams` edits the query in place rather than replacing it —
 * picking a figure inside the Pipeline page keeps `stage=screened` where it is.
 */
export default function OpportunitiesPage(
  { user, embedded = false }: { user: User; embedded?: boolean },
) {
  const { params } = useLocation();
  const [data, setData] = useState<OpportunityList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editUid, setEditUid] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [funder, setFunder] = useState("");
  const [lead, setLead] = useState("");
  const [sort, setSort] = useState<SortKey>("deadline");

  // The bucket lives in the URL, so a Dashboard tile is an ordinary link and the back
  // button does what it looks like it will.
  const bucketKey = params.get("bucket") || "found";

  const load = useCallback(() => {
    setError(null);
    fetchOpportunityList()
      .then(setData)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Couldn't load the opportunities."));
  }, []);
  useEffect(load, [load]);

  const bucket = data?.buckets.find((b) => b.key === bucketKey) ?? null;
  // Looked up rather than assumed: a deployment whose server does not ship this figure
  // should lose the shortcut, not render a button that selects a bucket with no rows and
  // no rule to explain itself.
  const dueSoon = data?.buckets.find((b) => b.key === "due_in_14_days") ?? null;

  const inBucket = useMemo(
    () => (data?.rows ?? []).filter((r) => r.buckets.includes(bucketKey)),
    [data, bucketKey],
  );

  const funders = useMemo(
    () => [...new Set(inBucket.map((r) => r.funder).filter(Boolean))].sort(),
    [inBucket],
  );
  const leads = useMemo(
    () => [...new Set(inBucket.map((r) => r.lead).filter((x): x is string => !!x))].sort(),
    [inBucket],
  );

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const out = inBucket.filter((r) =>
      (!funder || r.funder === funder)
      && (!lead || r.lead === lead)
      && (!term
        || `${r.title} ${r.funder} ${r.uid} ${r.lead ?? ""}`.toLowerCase().includes(term)));
    const today = data?.today ?? "";
    const by: Record<SortKey, (a: OpportunityListRow, b: OpportunityListRow) => number> = {
      // A missing deadline is not urgent, so it sorts last rather than first — the same
      // rule the Bidding stage uses.
      deadline: (a, b) => {
        const x = daysTo(a.deadline, today), y = daysTo(b.deadline, today);
        if (x === null && y === null) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        return x - y;
      },
      score: (a, b) => (b.score ?? -1) - (a.score ?? -1),
      value: (a, b) => b.usd - a.usd,
      found: (a, b) => (b.found ?? "").localeCompare(a.found ?? ""),
      title: (a, b) => a.title.localeCompare(b.title),
    };
    return [...out].sort(by[sort]);
  }, [inBucket, q, funder, lead, sort, data]);

  const applications = useMemo(
    () => rows.reduce((t, r) => t + r.applications, 0), [rows]);
  const narrowed = rows.length !== inBucket.length;

  // PAGING. Ten rows at a time, over the rows the bucket and filters have already chosen —
  // never over the bucket, so the figure a tile promised still governs what can appear.
  //
  // `cur` is clamped rather than stored clamped: a filter that shortens the list below the
  // page you are on must not leave you looking at an empty table while the control says
  // page 4. The effect below resets to 1 on any change to the SELECTION, which is the
  // honest behaviour when the rows underneath you are no longer the ones you were reading
  // — paging is a position in a list, and that is a different list.
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [bucketKey, funder, lead, q, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const cur = Math.min(page, pages);
  const pageRows = useMemo(
    () => rows.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE), [rows, cur]);

  const pick = (k: string) => {
    setParams({ bucket: k });
    // The narrowing filters belong to the bucket you were in; carrying them into another
    // one silently hides rows the tile just promised.
    setFunder(""); setLead(""); setQ("");
  };

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Spinner label="Loading your opportunities…" />;

  return (
    <>
      {!embedded && (
        <PageHeader
          title="Triage"
          lead={
            <>
              Every call in one place. The figure you pick is the Dashboard's own —
              choosing one shows the rows behind that number, and nothing else; the
              filters beside it narrow what it chose.
            </>
          }
        />
      )}

      {/* ONE ROW, because they are one decision taken in two steps: which figure, then
          which slice of it. Splitting them put the first above the page's heading and the
          second below it, so they looked like different kinds of thing.

          TWO ROWS, SPLIT BY WHAT THEY DO. Row one chooses WHICH CALLS — the fortnight
          shortcut, the figure, the funder, the lead, the order. Row two narrows them by
          free text, which is the only filter with no fixed set of answers and the only
          one you type, so it gets its own line and room to be read back.

          THE WIDTH IS ON THE WRAPPER, NOT THE CONTROL, and it has to be. `fieldClass`
          begins `w-full`, and Tailwind resolves two width utilities by stylesheet order
          rather than by the order they appear in the attribute — so the `w-52` these
          selects used to pass LOST to it, every one of them rendered full width, and that
          is why four filters occupied four lines. A fixed-width flex item with a w-full
          control inside it does what the class was asking for, without changing `Select`
          for the rest of the app (where other callers have the same silent problem). */}
      {/* ROW ONE — WHICH CALLS. Every control here changes the set. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {dueSoon && (
          <DueSoonButton
            bucket={dueSoon} active={bucketKey === dueSoon.key} onPick={pick}
          />
        )}
        <div className="w-64">
          <BucketPicker
            buckets={data.buckets} groups={data.bucketGroups ?? []}
            active={bucketKey} onPick={pick}
          />
        </div>
        <div className="w-52">
          <Select aria-label="Filter by funder"
            value={funder} onChange={(e) => setFunder(e.target.value)}>
            <option value="">Every funder</option>
            {funders.map((f) => <option key={f} value={f}>{f}</option>)}
          </Select>
        </div>
        <div className="w-44">
          <Select aria-label="Filter by lead"
            value={lead} onChange={(e) => setLead(e.target.value)}>
            <option value="">Anyone</option>
            {leads.map((l) => <option key={l} value={l}>{l}</option>)}
          </Select>
        </div>
        <div className="w-56">
          <Select aria-label="Sort"
            value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </Select>
        </div>
      </div>

      {/* ROW TWO — WHICH OF THEM. Text search is the one filter with no fixed set of
          answers, so it gets the room to be typed in rather than a slot between two
          dropdowns. The tally sits with it because it is what all of row one and row two
          together produced, and it reads last for the same reason. */}
      <div className="mt-2 mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            aria-label="Filter these opportunities"
            placeholder="Title, funder, lead or uid"
            className={field("pl-8")}
          />
        </div>
        {narrowed && (
          <button
            onClick={() => { setQ(""); setFunder(""); setLead(""); }}
            className="inline-flex items-center gap-1 text-sm text-accent-700 hover:underline"
          >
            <X className="h-3.5 w-3.5" /> Clear filters
          </button>
        )}
        {/* "Showing" moved to the pager below, where it names the PAGE. Two lines both
            beginning "Showing", one counting what the filters kept and one counting what
            fits on screen, is a reader comparing two numbers that answer different
            questions. This line is the filter's count; the pager's is the page's. */}
        <span className="ml-auto text-sm text-ink-500 tabular-nums">
          {narrowed
            ? <><strong className="text-ink-700">{rows.length}</strong> of {inBucket.length} match</>
            : <><strong className="text-ink-700">{rows.length}</strong> {rows.length === 1 ? "opportunity" : "opportunities"}</>}
          {bucket?.kind === "applications" && <> · {applications} applications</>}
        </span>
      </div>

      {/* The chosen figure's own sentence, kept. The picker shows a label and a count;
          this is the rule behind them, and it is the only thing on the page a reader can
          check the selection against. It reads under the controls now rather than above
          them, because it describes what they produced. */}
      {bucket && (
        <p className="mb-3 text-sm text-ink-500">
          <strong className="font-semibold text-brand-700">{bucket.label}</strong>
          {" — "}{bucket.rule}
        </p>
      )}

      {/* The one place this page could mislead, said out loud. */}
      {bucket?.kind === "applications" && (
        <Notice tone="neutral" className="mb-3">
          <strong>{bucket.count}</strong>{" "}
          {bucket.count === 1 ? "application" : "applications"} across{" "}
          <strong>{inBucket.length}</strong>{" "}
          {inBucket.length === 1 ? "opportunity" : "opportunities"} — a call sent to the
          same funder twice counts twice in the figure and appears once below.
        </Notice>
      )}

      {rows.length === 0 ? (
        <Card>
          <EmptyState icon={<Search className="h-5 w-5" />} title="Nothing here">
            {inBucket.length === 0
              ? <>No call is currently <strong>{bucket?.label.toLowerCase()}</strong>.</>
              : <>All {inBucket.length} are filtered out. Clear the filters to see them.</>}
            <div className="mt-4">
              <Link to={hrefOf("home")} className="text-accent-700 hover:underline">
                Back to the Dashboard
              </Link>
            </div>
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[60rem] text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50 text-left text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
                  <th className="px-4 py-3">Opportunity</th>
                  <th className="px-4 py-3">Funder</th>
                  <th className="px-4 py-3">Lead</th>
                  <th className="px-4 py-3">Deadline</th>
                  <th className="px-4 py-3 text-right">Award</th>
                  <th className="px-4 py-3 text-right">Strength</th>
                  <th className="px-4 py-3">Where it stands</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => {
                  const d = daysTo(r.deadline, data.today);
                  const dec = lower(r.decision);
                  const ans = lower(r.donorDecision);
                  return (
                    <tr key={r.uid}
                      className="border-b border-ink-100 transition-colors last:border-0 hover:bg-ink-50">
                      <td className="px-4 py-3">
                        {/* Same three controls as every Pipeline stage: the title opens the
                            record in this app, the arrow opens the funder's own call, the
                            pencil opens the one editor. */}
                        <div className="min-w-0">
                          <Link to={hrefOf("opportunity", { uid: r.uid })}
                            title="Open the full record in RFPIS"
                            className="font-medium text-brand-700 hover:text-accent-700 hover:underline">
                            {r.title || r.uid}
                          </Link>
                          {r.link && (
                            <a href={r.link} target="_blank" rel="noreferrer"
                              title="Open the call on the funder's own site"
                              aria-label="Open the call on the funder's own site"
                              className="ml-1.5 inline-flex text-ink-400 hover:text-accent-700">
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                          <button onClick={() => setEditUid(r.uid)}
                            title="Edit this opportunity" aria-label="Edit this opportunity"
                            className="ml-1.5 inline-flex align-text-bottom text-ink-400 hover:text-accent-700">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          {r.applications > 1 && (
                            <span className="ml-1.5 text-xs text-ink-500"
                              title="Sent to the funder more than once — counts each time in the application figures">
                              ×{r.applications}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-ink-600">{r.funder || "—"}</td>
                      <td className="px-4 py-3 text-ink-600">{r.lead ?? "—"}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {r.deadline
                          ? <>
                              <span className="text-ink-700">{r.deadline}</span>
                              {d !== null && (
                                <span className={`ml-1.5 text-xs ${
                                  d < 0 ? "text-ink-400" : d <= 14 ? "font-medium text-gold-700" : "text-ink-500"}`}>
                                  {d < 0 ? "closed" : d === 0 ? "today" : `${d}d`}
                                </span>
                              )}
                            </>
                          : <span className="text-ink-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap text-ink-700 tabular-nums">
                        {usd(r.usd)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {r.score == null
                          ? <span className="text-ink-300">—</span>
                          : <span className="font-semibold text-ink-800">{Math.round(r.score)}</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {r.decision
                            ? <Badge tone={DECISION_TONE[dec] ?? "neutral"}>{r.decision}</Badge>
                            : <Badge tone="neutral">Not reviewed</Badge>}
                          {r.donorDecision && (
                            <Badge tone={ANSWER_TONE[ans] ?? "neutral"}>{r.donorDecision}</Badge>
                          )}
                          {r.buckets.includes("ledger_gap") && (
                            <span title="A funder has answered, but progress never reached Completed, so this weighs nothing in the application figures">
                              <Badge tone="warn">
                                <AlertTriangle className="h-3 w-3" /> not counted
                              </Badge>
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ONLY WHEN THERE IS MORE THAN ONE PAGE. "Page 1 of 1" beside two dead arrows is a
          control that has nothing to control, on what is usually a short list once a
          figure and a funder have been chosen. The count itself is never hidden — it is on
          the filter line above, which is there whether or not this is. */}
      {pages > 1 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-ink-600">
          <span className="tabular-nums">
            Showing {(cur - 1) * PAGE_SIZE + 1}–{(cur - 1) * PAGE_SIZE + pageRows.length}
            {" of "}{rows.length}
          </span>
          <div className="flex items-center gap-1">
            <IconButton label="Previous page" disabled={cur <= 1}
              onClick={() => setPage(cur - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </IconButton>
            <span className="px-2 tabular-nums">Page {cur} of {pages}</span>
            <IconButton label="Next page" disabled={cur >= pages}
              onClick={() => setPage(cur + 1)}>
              <ChevronRight className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      )}

      <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-500">
        <ArrowUpDown className="h-3.5 w-3.5" />
        Sorted by {SORTS.find((s) => s.key === sort)?.label.toLowerCase()}. Award values are
        converted to USD at today's rates so sizes compare.
      </p>

      {editUid && (
        <RfpEditor uid={editUid} onClose={() => setEditUid(null)} onSaved={load} />
      )}
      {user.view && (
        <p className="mt-2 text-xs text-ink-400">Viewing as {user.view.name}.</p>
      )}
    </>
  );
}
