/**
 * Reviewed — the calls a person has decided on, and the place to change a verdict.
 *
 * This is the one stage with an ACTION rather than a view, so three things it does are
 * deliberate:
 *
 *   * Membership is a non-empty `decision`, NOT `decision_date`. Requiring the date was
 *     this stage's first rule and it hid 61 of 83 real decisions — the Excel migration
 *     carried verdicts and rationales but no dates. routes_pipelines.ts::reviewed has the
 *     measurement. Each row's `decided_on` is resolved there, so the period a decision
 *     belongs to has one owner rather than two.
 *
 *   * Changing a verdict re-records it rather than editing a field. The decision carries
 *     consequences beyond the row — the scan's tombstone and the learning engine's label —
 *     and POST /pipelines/decision is what carries them. A field edit would not.
 *
 *   * Warnings from that route are shown, not swallowed. `decision_not_recorded` in
 *     particular means a declined call may come back on the next scan, which the reviewer
 *     would otherwise discover by seeing it again weeks later.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import {
  fetchReviewed, recordDecision, scoreIsBehind,
  type Reviewed, type ReviewedRow, type Warning,
} from "../api";
import { atGrain, periodOf, rangeOf, labelOf, type Period } from "./period";
import { Badge, Button, Card, EmptyState, Notice, Select, Spinner, fieldClass } from "../ui";

/** config/dropdowns.yaml's `decisions`, which the API validates against. */
const DECISIONS = ["Proceed", "Park", "Decline"] as const;

const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
const toneOf = (d: string) =>
  d.startsWith("proceed") ? "good" : d === "park" ? "warn" : "neutral";

export default function ReviewedStage({ period, onPickPeriod }: {
  period: Period; onPickPeriod: (p: Period) => void;
}) {
  const { from, to } = rangeOf(period);
  const [data, setData] = useState<Reviewed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [notices, setNotices] = useState<Warning[]>([]);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchReviewed(from, to)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this period."))
      .finally(() => setLoading(false));
  }, [from, to]);

  useEffect(load, [load]);

  const rows = data?.rows ?? null;
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const all = rows ?? [];
    if (!term) return all;
    return all.filter((r) =>
      `${r.opportunity_title ?? ""} ${r.funding_agency ?? ""} ${r.uid}`
        .toLowerCase().includes(term));
  }, [rows, q]);

  const buckets = useMemo(() => {
    let proceed = 0, parked = 0, declined = 0;
    for (const r of filtered) {
      const d = lower(r.decision);
      if (d.startsWith("proceed")) proceed++;
      else if (d === "park") parked++;
      else if (d === "decline") declined++;
    }
    return { proceed, parked, declined, total: filtered.length };
  }, [filtered]);

  async function change(row: ReviewedRow, decision: string) {
    if (decision === row.decision) return;
    setSaving(row.uid);
    setNotices([]);
    try {
      const res = await recordDecision(row.uid, decision);
      // Replace from the server's row rather than patching locally: it carries the new
      // decision_date and stamps, and a local guess at those would be a second opinion.
      setData((cur) => cur && {
        ...cur,
        rows: cur.rows.map((r) => (r.uid === row.uid ? { ...r, ...res.row } : r)),
      });
      setNotices(res.warnings ?? []);
    } catch (e) {
      setNotices([{
        code: "decision_failed",
        detail: e instanceof Error ? e.message : "The decision could not be saved.",
      }]);
    } finally {
      setSaving(null);
    }
  }

  if (!rows && loading) return <Spinner label={`Loading ${labelOf(period)}…`} />;
  if (error) return <Notice tone="warn" role="alert">{error}</Notice>;

  if (!rows?.length) {
    // The difference that matters: "nothing this week" and "nothing ever" look identical
    // on screen and mean completely different things. `latest` tells them apart, and the
    // button goes to where the decisions actually are instead of leaving the reader to
    // guess which period to try.
    const latest = data?.latest ?? null;
    return (
      <Card>
        <EmptyState title={`Nothing decided in ${labelOf(period)}`}>
          {latest ? (
            <>
              <p>
                The most recent decision was on <strong>{latest}</strong>
                {data && data.total > 0 && <> — {data.total} in all.</>}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button onClick={() => onPickPeriod(periodOf("month", latest))}>
                  Jump to {labelOf(periodOf("month", latest))}
                </Button>
                <Button variant="secondary"
                  onClick={() => onPickPeriod(atGrain(periodOf("year", latest), "year"))}>
                  Show the whole year
                </Button>
              </div>
            </>
          ) : (
            <p>
              Nothing has been decided yet. A call appears here once somebody records a
              verdict on it, filed under the date the decision was taken.
            </p>
          )}
          {!!data?.undated && (
            <p className="mt-3 text-ink-500">
              {data.undated} decision{data.undated === 1 ? " carries" : "s carry"} no date at
              all, so {data.undated === 1 ? "it falls" : "they fall"} outside every period.
            </p>
          )}
        </EmptyState>
      </Card>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Decided" value={buckets.total} />
        <Kpi label="Proceed" value={buckets.proceed} tone="good" />
        <Kpi label="Parked" value={buckets.parked} tone="warn" />
        <Kpi label="Declined" value={buckets.declined} />
      </div>

      {notices.map((w) => (
        <div className="mt-3" key={w.code}>
          <Notice tone="warn" role="alert" icon={<AlertTriangle className="h-4 w-4" />}>
            {w.detail}
          </Notice>
        </div>
      ))}

      <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-brand-700">
          Decided in {labelOf(period)}{" "}
          <span className="font-normal text-ink-500">({filtered.length})</span>
        </h2>
        <input
          value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter decisions"
          placeholder="Filter by title, funder or uid" className={`${fieldClass} max-w-xs`}
        />
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          {/* FIXED LAYOUT, EXPLICIT WIDTHS. With `auto`, the browser shares the width out
              by content: Rationale is the longest text, so it was squeezed into a narrow
              column that wrapped to eight lines while "Change to" lost its own control to
              an ellipsis - "Pr..." where a reader needs to see "Proceed". Stating the
              proportions lets the long text have the room and keeps the controls whole.
              The wrapper scrolls horizontally below the min-width, so narrowing the
              window scrolls rather than crushing a column. */}
          <table className="w-full min-w-[72rem] table-fixed text-sm">
            <colgroup>
              <col className="w-[24%]" />{/* Opportunity — the thing you are reading   */}
              <col className="w-[15%]" />{/* Funder                                    */}
              <col className="w-[11%]" />{/* Decided                                   */}
              <col className="w-[6%]" /> {/* Score                                     */}
              <col className="w-[9%]" /> {/* Verdict                                   */}
              <col className="w-[11%]" />{/* Change to — must fit the longest option    */}
              <col className="w-[24%]" />{/* Rationale — the longest text on the row    */}
            </colgroup>
            <thead>
              <tr className="border-b border-ink-200 bg-ink-50 text-left text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
                <th className="px-4 py-3">Opportunity</th>
                <th className="px-4 py-3">Funder</th>
                <th className="px-4 py-3">Decided</th>
                <th className="px-4 py-3 text-right">Score</th>
                <th className="px-4 py-3">Verdict</th>
                <th className="px-4 py-3">Change to</th>
                <th className="px-4 py-3">Rationale</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-ink-500">
                  Nothing matches that filter.
                </td></tr>
              )}
              {filtered.map((r) => {
                const d = lower(r.decision);
                const behind = scoreIsBehind(r);
                return (
                  <tr key={r.uid} className="border-b border-ink-100 transition-colors last:border-0 hover:bg-ink-50">
                    <td className="px-4 py-3">
                      <a href={`/opportunity?uid=${encodeURIComponent(r.uid)}`}
                        className="font-medium text-brand-700 hover:text-accent-700 hover:underline">
                        {r.opportunity_title || r.uid}
                      </a>
                      {r.opportunity_link && (
                        <a href={r.opportunity_link} target="_blank" rel="noreferrer"
                          className="ml-1.5 inline-flex text-ink-400 hover:text-accent-700" aria-label="Open the call">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top text-ink-600 break-words">
                      {r.funding_agency || "—"}
                    </td>
                    <td className="px-4 py-3 text-ink-600">
                      {r.decided_on}
                      {/* A migrated decision has no decision_date of its own, so the date
                          shown is inferred. Saying which is better than implying a
                          precision the row does not have. */}
                      {!r.decision_date && (
                        <span className="ml-1 text-xs text-ink-400" title="No decision date recorded; filed under the row's own date">
                          approx.
                        </span>
                      )}
                      {r.decision_overridden_by && (
                        <div className="text-xs text-ink-400">{r.decision_overridden_by}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-brand-700">
                      {r.alignment_score == null ? "—" : Math.round(r.alignment_score)}
                      {behind && (
                        /* The score predates the last edit, so a re-score is in flight.
                           Saying so beats showing the old number as though it were final. */
                        <span title="Being recalculated after a recent edit"
                          className="ml-1 inline-flex align-middle text-ink-400">
                          <RefreshCw className="h-3 w-3 animate-spin" />
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={toneOf(d)}>
                        {d ? d[0].toUpperCase() + d.slice(1) : "—"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Select
                        aria-label={`Change the decision on ${r.opportunity_title || r.uid}`}
                        className="w-full min-w-[6.5rem] py-1.5" value={r.decision ?? ""}
                        disabled={saving === r.uid}
                        onChange={(e) => change(r, e.target.value)}
                      >
                        {/* A stored value the vocabulary no longer offers stays visible so
                            the row reads honestly; picking another is what replaces it. */}
                        {r.decision && !(DECISIONS as readonly string[]).includes(r.decision) && (
                          <option value={r.decision}>{r.decision}</option>
                        )}
                        {DECISIONS.map((x) => <option key={x} value={x}>{x}</option>)}
                      </Select>
                    </td>
                    {/* The full note stays available on hover rather than being cut
                        off: a rationale is the one column a reviewer actually reads. */}
                    <td className="px-4 py-3 align-top text-ink-600">
                      <div className="line-clamp-4 leading-relaxed"
                        title={r.decision_note || undefined}>
                        {r.decision_note || "—"}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "good" | "warn" }) {
  const colour = tone === "good" ? "text-good-700" : tone === "warn" ? "text-gold-700" : "text-brand-700";
  return (
    <Card className="px-4 py-3">
      <div className="text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${colour}`}>{value}</div>
    </Card>
  );
}
