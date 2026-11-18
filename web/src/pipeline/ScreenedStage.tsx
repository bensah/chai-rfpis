/**
 * Screened — what the scan found or a person submitted, scored and waiting on a decision.
 * A port of views/screened_rfp.py's KPI strip, duplicate banner, filters and review queue.
 *
 * Two rules from that file are carried deliberately and must not be "harmonised" with
 * Track, which deliberately disagrees with both:
 *
 *   * the EFFECTIVE decision is the stored one falling back to `auto_recommendation`, and
 *     Proceed is matched by prefix, not equality — that is what lets a freshly scanned row
 *     land in a bucket before anyone opens Review;
 *   * a duplicate counts only when its canonical is in the SAME week. Duplicates pointing
 *     at other weeks must not inflate the banner, and the KPI denominators use canonical
 *     rows only.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { fetchScreen, type ScreenRow, type Weeks } from "../api";
import { hrefOf, Link } from "../router";
import OpportunityCell from "../opportunity/OpportunityCell";
import RfpEditor from "../opportunity/RfpEditor";
import { Badge, Button, Card, EmptyState, Notice, Spinner, fieldClass } from "../ui";

const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();

/**
 * screened_rfp.py's `_eff`: the human decision if there is one, else the engine's.
 *
 * A BLANK DECISION IS NO DECISION, and `??` does not know that. It was
 * `r.decision ?? r.auto_recommendation`, which falls through only on null/undefined — so
 * a row whose `decision` is the EMPTY STRING returned "" and the engine's recommendation
 * was never consulted. Both spellings are in this table: `routes_pipelines.ts` selects
 * `decision=not.is.null` and then filters again with `str(r.decision).trim() !== ""`,
 * which is a filter that only exists because the first one lets blanks through.
 *
 * Everything on this stage reads through here — the three KPI counts, the ordering and
 * now the list itself — so on such a row the screen showed no verdict at all while the
 * footer promised "a decision nobody has made yet shows the engine's recommendation".
 */
const effective = (r: ScreenRow) =>
  lower(r.decision).trim() || lower(r.auto_recommendation).trim();
const isProceed = (d: string) => d.startsWith("proceed");

export default function ScreenedStage({ week, weeks, onPickWeek }: {
  week: string | null; weeks: Weeks | null; onPickWeek: (w: string) => void;
}) {
  const [rows, setRows] = useState<ScreenRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [editUid, setEditUid] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!week) return;
    setLoading(true);
    setError(null);
    fetchScreen(week)
      .then((r) => setRows(r.rows))
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this week."))
      .finally(() => setLoading(false));
  }, [week]);

  useEffect(load, [load]);

  const all = useMemo(() => rows ?? [], [rows]);
  // Canonical rows are what was actually screened; a duplicate of another week's row
  // should not hold the page open by itself.
  const canonical = useMemo(() => all.filter((r) => !r.is_duplicate), [all]);
  const inWeekDupes = useMemo(() => {
    const here = new Set(canonical.map((r) => r.uid));
    return all.filter((r) => r.is_duplicate && r.duplicate_of_uid && here.has(r.duplicate_of_uid));
  }, [all, canonical]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return canonical;
    return canonical.filter((r) =>
      `${r.opportunity_title ?? ""} ${r.funding_agency ?? ""} ${r.uid}`.toLowerCase().includes(term));
  }, [canonical, q]);

  const buckets = useMemo(() => {
    let proceed = 0, parked = 0, declined = 0;
    for (const r of filtered) {
      const d = effective(r);
      if (isProceed(d)) proceed++;
      else if (d === "park") parked++;
      else if (d === "decline") declined++;
    }
    return { proceed, parked, declined, total: filtered.length };
  }, [filtered]);

  // EVERY SCREENED CALL, DECLINES INCLUDED (owner, 2026-11-18).
  //
  // This list was Proceed and Park only. Decline was excluded because the hard gate used
  // to leak false positives — calls that passed it and then scored as Decline — and a
  // queue full of them was noise. The owner's reason for reversing it: "we've since
  // hardened the hard gate i.e. theme mismatch, passed deadline, ineligible geo scope
  // etc. this have been tested to prevent any rfps from leaking into a tenant's account
  // before the scoring decides how to classify them."
  //
  // So the gate decides what a tenant SEES, and the score only classifies what got
  // through. Once a call is in, hiding the engine's Decline hides a judgement the team is
  // entitled to disagree with — "a decline could end up being upgraded to Proceed by user
  // if they review and find them eligible". The meeting now reads the whole week.
  //
  // Order: Proceed, then Park, then Decline; highest score first within each. A decline
  // still sorts last, because the list is work to do and that is the order to do it in.
  //
  // THE CALL MUST STILL BE OPEN (owner, 2026-11-10) — unchanged. A closed call cannot be
  // acted on, so listing it as work asks for a decision nobody can make. `expired` is the
  // server's own `deadlinePassed`, and is deliberately NOT applied to the KPIs above:
  // what the scan found in a given week is history, and a count that shrank as deadlines
  // passed would rewrite it.
  const rank = (d: string) => (isProceed(d) ? 0 : d === "park" ? 1 : 2);
  const openQueue = useMemo(() => filtered
    .filter((r) => { const d = effective(r); return isProceed(d) || d === "park" || d === "decline"; })
    .sort((a, b) => rank(effective(a)) - rank(effective(b))
      || (b.alignment_score ?? 0) - (a.alignment_score ?? 0)), [filtered]);
  const queue = useMemo(() => openQueue.filter((r) => !r.expired), [openQueue]);
  const closedSince = openQueue.length - queue.length;

  if (!week) return <Spinner label="Finding the current review week…" />;
  if (!rows && loading) return <Spinner label={`Loading ${week}…`} />;

  if (error) {
    return <Notice tone="warn" role="alert">{error}</Notice>;
  }

  if (!canonical.length) {
    const latest = weeks?.weeksWithData?.[0];
    return (
      <Card>
        <EmptyState title={`Nothing screened in ${week}`}>
          {all.length > 0
            ? `${all.length} record(s) are tagged to this week but are duplicates of calls screened elsewhere.`
            : "No opportunities were recorded for this review week."}
          {latest && latest.week !== week && (
            <div className="mt-4">
              <Button onClick={() => onPickWeek(latest.week)}>
                Jump to {latest.week} ({latest.count})
              </Button>
            </div>
          )}
        </EmptyState>
      </Card>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Screened" value={buckets.total} />
        <Kpi label="Proceed" value={buckets.proceed} tone="good" />
        <Kpi label="Parked" value={buckets.parked} tone="warn" />
        <Kpi label="Declined" value={buckets.declined} />
      </div>

      <div className="mt-3">
        {inWeekDupes.length > 0 ? (
          <Notice tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>
            {inWeekDupes.length} duplicate record{inWeekDupes.length === 1 ? "" : "s"} flagged this
            period and excluded from the counts above.
          </Notice>
        ) : (
          <Notice tone="good" icon={<CheckCircle2 className="h-4 w-4" />}>
            No duplicates detected in this period.
          </Notice>
        )}
      </div>

      <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-brand-700">
            Screened calls <span className="font-normal text-ink-500">({queue.length})</span>
          </h2>
          {closedSince > 0 && (
            <p className="mt-0.5 text-xs text-ink-500">
              {closedSince} more {closedSince === 1 ? "has" : "have"} closed since being
              found — still counted above, now in the{" "}
              <Link to={`${hrefOf("opportunities")}?bucket=archived`}
                className="text-accent-700 hover:underline">archive</Link>.
            </p>
          )}
        </div>
        <input
          value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter this week"
          placeholder="Filter by title, funder or uid" className={`${fieldClass} max-w-xs`}
        />
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-b border-ink-200 bg-ink-50 text-left text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
                <th className="px-4 py-3">Opportunity</th>
                <th className="px-4 py-3">Funder</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Deadline</th>
                <th className="px-4 py-3 text-right">Score</th>
                <th className="px-4 py-3">Decision</th>
                <th className="px-4 py-3">Key risks</th>
              </tr>
            </thead>
            <tbody>
              {queue.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-ink-500">
                  Nothing was screened in this week.
                </td></tr>
              )}
              {queue.map((r) => {
                const d = effective(r);
                return (
                  <tr key={r.uid} className="border-b border-ink-100 transition-colors last:border-0 hover:bg-ink-50">
                    <td className="px-4 py-3">
                      <OpportunityCell uid={r.uid} title={r.opportunity_title}
                        link={r.opportunity_link} onEdit={setEditUid} />
                    </td>
                    <td className="px-4 py-3 text-ink-600">{r.funding_agency || "—"}</td>
                    <td className="px-4 py-3 text-ink-600">{r.applicant_role || "—"}</td>
                    <td className="px-4 py-3 text-ink-600">{r.call_submission_deadline?.slice(0, 10) || "—"}</td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-brand-700">
                      {r.alignment_score == null ? "—" : Math.round(r.alignment_score)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={isProceed(d) ? "good" : d === "park" ? "warn" : d === "decline" ? "bad" : "neutral"}>
                        {d ? d[0].toUpperCase() + d.slice(1) : "—"}
                      </Badge>
                      {!r.decision && <span className="ml-1.5 text-xs text-ink-400">auto</span>}
                    </td>
                    <td className="max-w-[20rem] px-4 py-3 text-ink-600">{r.key_risks || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="mt-3 text-xs text-ink-500">
        Every call screened in this week — proceed, parked and declined — highest score first
        within each. A decision nobody has made yet shows the engine's recommendation, marked{" "}
        <em>auto</em>; a decline is the engine's opinion, not a verdict, and can be changed.
      </p>
      {editUid && (
        <RfpEditor uid={editUid} onClose={() => setEditUid(null)} onSaved={load} />
      )}
    </>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "good" | "warn" }) {
  return (
    <Card className="p-5">
      <div className="text-xs font-medium tracking-wide text-ink-500 uppercase">{label}</div>
      <div className={`mt-1.5 text-3xl font-bold tabular-nums ${
        tone === "good" ? "text-good-700" : tone === "warn" ? "text-gold-700" : "text-brand-700"
      }`}>{value}</div>
    </Card>
  );
}
