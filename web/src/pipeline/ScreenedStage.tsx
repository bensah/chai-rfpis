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
import OpportunityCell from "../opportunity/OpportunityCell";
import RfpEditor from "../opportunity/RfpEditor";
import { Badge, Button, Card, EmptyState, Notice, Spinner, fieldClass } from "../ui";

const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** screened_rfp.py's `_eff`: the human decision if there is one, else the engine's. */
const effective = (r: ScreenRow) => lower(r.decision ?? r.auto_recommendation ?? "");
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

  // The review queue is Proceed AND Parked: a parked call was surfaced this week and still
  // needs a visible slot. Proceed first, then Park; highest score first within each.
  const queue = useMemo(() => filtered
    .filter((r) => { const d = effective(r); return isProceed(d) || d === "park"; })
    .sort((a, b) => (isProceed(effective(a)) ? 0 : 1) - (isProceed(effective(b)) ? 0 : 1)
      || (b.alignment_score ?? 0) - (a.alignment_score ?? 0)), [filtered]);

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
        <h2 className="text-lg font-bold text-brand-700">
          Proceed &amp; parked <span className="font-normal text-ink-500">({queue.length})</span>
        </h2>
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
                  Nothing to proceed with or park in this week.
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
                      <Badge tone={isProceed(d) ? "good" : d === "park" ? "warn" : "neutral"}>
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
        Proceed first, then parked; highest score first within each. A decision nobody has made yet
        shows the engine's recommendation, marked <em>auto</em>.
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
