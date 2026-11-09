/**
 * Bidding — the bids actually in flight, and how far each one has got.
 *
 * The stage the owner asked for a progress bar on. `stage` is a real column with real
 * values (config/dropdowns.yaml's seven `stages`), so the bar is not decoration over a
 * percentage somebody invented: each step is a value a person can set, and clicking one
 * writes it.
 *
 * MEMBERSHIP IS THE ROUTE'S, NOT THIS PAGE'S. `/pipelines/track` applies the six rules in
 * core/pipeline.py::is_active_proceed — decision starts with Proceed, canonical row, not
 * Completed or Discontinued, not already submitted, deadline not past. Re-deriving any of
 * them here would be a second opinion about what counts as live work, and Track and
 * Screened already disagree on purpose (Screened reads the EFFECTIVE decision, this reads
 * the stored one exactly), so a page-side rule would land between the two.
 *
 * ONE AT A TIME, which is the shape the owner asked for: the table is the list, and the
 * selected bid opens beneath it with the full stepper. The table's own bar is a readout,
 * not a control — seven clickable steps per row would be a wall of targets, and advancing
 * a bid is deliberate rather than something to do by mistake while scanning.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, Check, Layers } from "lucide-react";
import {
  fetchTrack, saveRfpFields, type Track, type TrackRow, type Warning,
} from "../api";
import OpportunityCell from "../opportunity/OpportunityCell";
import RfpEditor from "../opportunity/RfpEditor";
import { labelOf, rangeOf, type Period } from "./period";
import { Badge, Button, Card, EmptyState, Notice, Spinner, fieldClass } from "../ui";

/**
 * config/dropdowns.yaml's `stages`, in order — the API pins the same list against that
 * file (pipeline_writes.ts::STAGES). Seven, not the five in tracking_rfp.py's fallback:
 * live rows sit in "Budgeting development" and "Review, compliance check & approvals".
 */
const STAGES = [
  "Identification & screening",
  "Go/no-go decision & bid planning",
  "Proposal development",
  "Budgeting development",
  "Review, compliance check & approvals",
  "Final packaging & submission",
  "Post-submission follow-up",
] as const;

/** Short forms for the bar. The full label is the title and the stepper's own text. */
const SHORT: Record<string, string> = {
  "Identification & screening": "Screening",
  "Go/no-go decision & bid planning": "Go/no-go",
  "Proposal development": "Proposal",
  "Budgeting development": "Budget",
  "Review, compliance check & approvals": "Review",
  "Final packaging & submission": "Packaging",
  "Post-submission follow-up": "Follow-up",
};

const stageIndex = (s: string | null) =>
  STAGES.indexOf(String(s ?? "").trim() as typeof STAGES[number]);

const daysTo = (d: string | null) => {
  if (!d) return null;
  const t = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`))
    / 86400_000);
};

export default function BiddingStage({ period }: { period: Period }) {
  const { from, to } = rangeOf(period);
  const [data, setData] = useState<Track | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [editUid, setEditUid] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [notices, setNotices] = useState<Warning[]>([]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchTrack(from, to)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load the bids."))
      .finally(() => setLoading(false));
  }, [from, to]);

  useEffect(load, [load]);

  const rows = data?.rows ?? null;
  const leadsOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const l of data?.leads ?? []) m.set(l.uid, l.proposalLeads);
    return m;
  }, [data]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const all = rows ?? [];
    const hit = !term ? all : all.filter((r) =>
      `${r.opportunity_title ?? ""} ${r.funding_agency ?? ""} ${r.uid}`
        .toLowerCase().includes(term));
    // Soonest deadline first, because that is the order the work has to be done in.
    // A bid with no deadline is not urgent and sorts last rather than first, which is
    // what an absent date would do to a plain comparison.
    return [...hit].sort((a, b) => {
      const da = daysTo(a.call_submission_deadline), db_ = daysTo(b.call_submission_deadline);
      if (da === null && db_ === null) return 0;
      if (da === null) return 1;
      if (db_ === null) return -1;
      return da - db_;
    });
  }, [rows, q]);

  const kpis = useMemo(() => {
    let dueSoon = 0, noDeadline = 0, notStarted = 0;
    for (const r of filtered) {
      const d = daysTo(r.call_submission_deadline);
      if (d === null) noDeadline++;
      else if (d <= 14) dueSoon++;
      if (stageIndex(r.stage) <= 0) notStarted++;
    }
    return { total: filtered.length, dueSoon, noDeadline, notStarted };
  }, [filtered]);

  /** Any field save on one bid. Re-fetches when the change could move the row between
   *  lists — confirming a submission takes it out of Bidding altogether, and patching the
   *  row in place would leave it sitting there claiming to be in flight. */
  const save = useCallback(async (
    uid: string, fields: Record<string, unknown>, refetch = false,
  ) => {
    setSaving(uid);
    setNotices([]);
    try {
      const res = await saveRfpFields(uid, fields);
      if (refetch) load();
      else {
        setData((cur) => cur && {
          ...cur,
          rows: cur.rows.map((r) => (r.uid === uid ? { ...r, ...res.row } : r)),
        });
      }
      setNotices(res.warnings ?? []);
    } catch (e) {
      setNotices([{
        code: "save_failed",
        detail: e instanceof Error ? e.message : "That change could not be saved.",
      }]);
    } finally {
      setSaving(null);
    }
  }, [load]);

  if (!rows && loading) return <Spinner label={`Loading ${labelOf(period)}…`} />;
  if (error) return <Notice tone="warn" role="alert">{error}</Notice>;

  const awaiting = data?.awaitingSubmission ?? [];

  if (!rows?.length) {
    return (
      <>
        <Card>
          <EmptyState icon={<Layers className="h-5 w-5" />} title="No bids in flight">
            <p>
              A call arrives here once somebody decides to proceed with it, and leaves when
              it is submitted, completed, discontinued, or its deadline passes.
            </p>
            <p className="mt-2 text-ink-500">
              Nothing in {labelOf(period)} — widen the period above to see bids from earlier.
            </p>
          </EmptyState>
        </Card>
        {awaiting.length > 0 && (
          <div className="mt-4"><AwaitingSubmission rows={awaiting} onSave={save} saving={saving} /></div>
        )}
      </>
    );
  }

  const selected = filtered.find((r) => r.uid === open) ?? null;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="In flight" value={kpis.total} />
        <Kpi label="Due in 14 days" value={kpis.dueSoon} tone={kpis.dueSoon ? "warn" : undefined} />
        <Kpi label="Not yet started" value={kpis.notStarted} />
        <Kpi label="No deadline set" value={kpis.noDeadline} />
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
          Bids in flight <span className="font-normal text-ink-500">({filtered.length})</span>
        </h2>
        <input
          value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter bids"
          placeholder="Filter by title, funder or uid" className={`${fieldClass} max-w-xs`}
        />
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[54rem] text-sm">
            <thead>
              <tr className="border-b border-ink-200 bg-ink-50 text-left text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
                <th className="px-4 py-3">Opportunity</th>
                <th className="px-4 py-3">Funder</th>
                <th className="px-4 py-3">Lead</th>
                <th className="px-4 py-3">Deadline</th>
                <th className="px-4 py-3 w-56">Progress</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-12 text-center text-ink-500">
                  Nothing matches that filter.
                </td></tr>
              )}
              {filtered.map((r) => {
                const on = r.uid === open;
                const d = daysTo(r.call_submission_deadline);
                const leads = leadsOf.get(r.uid) ?? [];
                return (
                  <tr key={r.uid}
                    className={`border-b border-ink-100 transition-colors last:border-0 ${
                      on ? "bg-brand-50" : "hover:bg-ink-50"}`}>
                    <td className="px-4 py-3">
                      <OpportunityCell uid={r.uid} title={r.opportunity_title}
                        link={r.opportunity_link} onEdit={setEditUid}
                        expanded={on} onToggle={() => setOpen(on ? null : r.uid)} />
                    </td>
                    <td className="px-4 py-3 text-ink-600">{r.funding_agency || "—"}</td>
                    <td className="px-4 py-3 text-ink-600">
                      {leads.length ? leads.join(", ") : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Deadline iso={r.call_submission_deadline} days={d} />
                    </td>
                    <td className="px-4 py-3"><MiniBar stage={r.stage} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {selected && (
        <div className="mt-4">
          <BidDetail
            row={selected}
            leads={leadsOf.get(selected.uid) ?? []}
            saving={saving === selected.uid}
            onPick={(s) => { if (s !== selected.stage) save(selected.uid, { stage: s }); }}
          />
        </div>
      )}

      {awaiting.length > 0 && (
        <div className="mt-6"><AwaitingSubmission rows={awaiting} onSave={save} saving={saving} /></div>
      )}
      {editUid && (
        <RfpEditor uid={editUid} onClose={() => setEditUid(null)} onSaved={load} />
      )}
    </>
  );
}

/**
 * The bids the deadline rule removed, and the one question that settles each.
 *
 * NOT folded into the table above. These are not in flight — their deadline has gone —
 * and mixing them in would be the harmonisation the track route's own comment warns
 * against. But hiding them is worse: on the live data this is 15 rows against 1 active
 * bid, so a stage that said nothing would look like a year of work had vanished.
 *
 * The fix is one field. `progress_status = Completed` is what the Python reads as "this
 * went in" (criteria_derive._is_completed), and marking it also lets the scorer stop
 * treating the past deadline as "not enough time".
 */
function AwaitingSubmission({ rows, onSave, saving }: {
  rows: TrackRow[];
  onSave: (uid: string, fields: Record<string, unknown>, refetch?: boolean) => void;
  saving: string | null;
}) {
  const [show, setShow] = useState(false);
  return (
    <Card className="p-0 overflow-hidden">
      <button
        onClick={() => setShow(!show)} aria-expanded={show}
        className="flex w-full items-start gap-2.5 p-4 text-left hover:bg-ink-50"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-gold-700" />
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink-700">
            {rows.length} bid{rows.length === 1 ? "" : "s"} passed the deadline with no
            submission recorded
          </span>
          <span className="mt-0.5 block text-xs text-ink-500">
            The team decided to proceed and nothing says what happened. If these went in,
            marking them keeps them out of the board and stops the scorer reading the past
            deadline as a missed opportunity. {show ? "Hide" : "Review them"}.
          </span>
        </span>
      </button>

      {show && (
        <ul className="border-t border-ink-100">
          {rows.map((r) => (
            <li key={r.uid} className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-4 py-3 last:border-0">
              <div className="min-w-0 flex-1">
                <a href={`/opportunity?uid=${encodeURIComponent(r.uid)}`}
                  className="text-sm font-medium text-brand-700 hover:text-accent-700 hover:underline">
                  {r.opportunity_title || r.uid}
                </a>
                <div className="text-xs text-ink-500">
                  {r.funding_agency || "Funder not recorded"} · deadline{" "}
                  {r.call_submission_deadline?.slice(0, 10) ?? "—"}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={saving === r.uid}
                  onClick={() => onSave(r.uid, { progress_status: "Completed" }, true)}>
                  It was submitted
                </Button>
                <Button size="sm" variant="secondary" disabled={saving === r.uid}
                  onClick={() => onSave(r.uid, { progress_status: "Discontinued" }, true)}>
                  We dropped it
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The readout in the table: how far along, without being a row of seven buttons. */
function MiniBar({ stage }: { stage: string | null }) {
  const i = stageIndex(stage);
  const label = stage?.trim() ? (SHORT[stage.trim()] ?? stage.trim()) : "Not set";
  return (
    <div title={stage ?? "No stage recorded"}>
      <div className="flex gap-0.5" aria-hidden>
        {STAGES.map((_, n) => (
          <span key={n} className={`h-1.5 flex-1 rounded-full ${
            i >= 0 && n <= i ? "bg-accent-600" : "bg-ink-200"}`} />
        ))}
      </div>
      <div className="mt-1 text-[0.7rem] text-ink-500">
        {i >= 0 ? `${i + 1}/${STAGES.length} · ${label}` : label}
      </div>
    </div>
  );
}

function Deadline({ iso, days }: { iso: string | null; days: number | null }) {
  if (!iso) return <span className="text-ink-400">—</span>;
  const tone = days !== null && days <= 7 ? "bad" : days !== null && days <= 14 ? "warn" : "neutral";
  return (
    <span className="whitespace-nowrap">
      <span className="text-ink-600">{iso.slice(0, 10)}</span>
      {days !== null && (
        <Badge tone={tone} className="ml-2">
          {days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`}
        </Badge>
      )}
    </span>
  );
}

/**
 * One bid, opened. The stepper is the control: every step is clickable, including ones
 * behind the current position, because a bid that went back to budgeting has gone back
 * and the record should say so rather than only ever moving forward.
 */
function BidDetail({ row, leads, saving, onPick }: {
  row: TrackRow; leads: string[]; saving: boolean; onPick: (stage: string) => void;
}) {
  const i = stageIndex(row.stage);
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-brand-700">
            {row.opportunity_title || row.uid}
          </h3>
          <p className="mt-0.5 text-sm text-ink-500">
            {row.funding_agency || "Funder not recorded"} · {row.uid}
            {row.applicant_role && <> · {row.applicant_role}</>}
          </p>
        </div>
        {row.alignment_score != null && (
          <Badge tone="neutral">Score {Math.round(row.alignment_score)}</Badge>
        )}
      </div>

      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
            Application progress
          </span>
          {saving && <span className="text-xs text-ink-400">Saving…</span>}
        </div>
        <ol className="flex flex-wrap gap-1.5">
          {STAGES.map((s, n) => {
            const done = i >= 0 && n < i;
            const now = n === i;
            return (
              <li key={s}>
                <button
                  onClick={() => onPick(s)}
                  disabled={saving}
                  aria-current={now ? "step" : undefined}
                  title={s}
                  className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 ${
                    now ? "border-brand-700 bg-brand-700 text-white"
                      : done ? "border-accent-200 bg-accent-50 text-accent-700 hover:border-accent-400"
                        : "border-ink-200 bg-white text-ink-600 hover:border-ink-300 hover:bg-ink-50"
                  }`}
                >
                  <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[0.6rem] font-bold ${
                    now ? "bg-white/20" : done ? "bg-accent-600 text-white" : "bg-ink-100 text-ink-500"}`}>
                    {done ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : n + 1}
                  </span>
                  {SHORT[s] ?? s}
                </button>
              </li>
            );
          })}
        </ol>
        <p className="mt-2 text-xs text-ink-500">
          {i >= 0
            ? <>Currently <strong className="text-ink-700">{row.stage}</strong>. Click any step to move the bid — back as well as forward.</>
            : <>No step recorded yet. Click where this bid actually is.</>}
        </p>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm lg:grid-cols-4">
        <Fact label="Proposal lead" value={leads.length ? leads.join(", ") : row.proposal_lead} />
        <Fact label="Assigned to" value={row.assigned_to} />
        <Fact label="Next action" value={row.next_action} />
        <Fact
          label="Action due"
          value={row.action_deadline?.slice(0, 10) ?? null}
          icon={row.action_deadline ? <CalendarClock className="h-3.5 w-3.5" /> : undefined}
        />
      </dl>
    </Card>
  );
}

function Fact({ label, value, icon }: {
  label: string; value: string | null; icon?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 flex items-start gap-1.5 text-ink-700">
        {icon}<span className="min-w-0 break-words">{value?.trim() || "—"}</span>
      </dd>
    </div>
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
