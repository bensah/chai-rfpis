/**
 * Meeting Actions (app_pages/actions.py) — "Your Meetings and Engagements".
 *
 * Four tabs: the week's call notes, the donor engagement log, everything still open across
 * both, and the check-in rota.
 *
 * PENDING OPENS FIRST, and that is a change from Streamlit, where it is the third tab.
 * The page exists to be read on a Monday morning before the call; the two logs are what you
 * open when you already know what you are looking for, and the open items are what you need
 * when you do not. The other three keep their order and their names.
 *
 * Every write here is sparse — the resolve toggle sends one field — so ticking an item off
 * cannot blank the note it belongs to.
 */
import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Check, ClipboardList, Handshake, Plus, RotateCcw } from "lucide-react";
import {
  ApiError, createEngagement, createNote, fetchActions, patchEngagement, patchNote, putSchedule,
  type Actions, type MeetingNote, type RotaEntry, type User,
} from "../api";
import { Badge, Button, Card, EmptyState, Field, Notice, PageHeader, Select, Spinner, fieldClass } from "../ui";
import { DataTable, fmtInt, fmtPct, Tile, Tiles } from "../report/charts";

const dash = "—";
type TabKey = "pending" | "meetings" | "engagements" | "schedule";
const TABS: { key: TabKey; label: string; icon: typeof ClipboardList }[] = [
  { key: "pending", label: "Pending", icon: ClipboardList },
  { key: "meetings", label: "Meetings", icon: CalendarDays },
  { key: "engagements", label: "Engagements", icon: Handshake },
  { key: "schedule", label: "Schedule", icon: RotateCcw },
];

/** Monday of the week holding `iso` — the same snap the server applies on write. */
function mondayOf(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const weekday = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - weekday * 86400000).toISOString().slice(0, 10);
}

export default function ActionsPage({ user }: { user: User }) {
  const [data, setData] = useState<Actions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("pending");
  const [week, setWeek] = useState<string>(() => mondayOf(new Date().toISOString().slice(0, 10)));
  const [busy, setBusy] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback((w: string) => {
    fetchActions(w)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't load meetings and engagements."));
  }, []);

  useEffect(() => { load(week); }, [week, load]);

  /** Run a write, then re-read. One source of truth on screen rather than a local patch
   *  that can drift from what the server actually stored. */
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setSaveError(null);
    try {
      await fn();
      load(week);
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : "That didn't save.");
    } finally {
      setBusy(null);
    }
  };

  if (error) return <EmptyState title="Meetings are unavailable">{error}</EmptyState>;
  if (!data) return <Spinner label="Loading meetings and engagements…" />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Meeting Actions"
        lead="This week's call, the donor engagement log, and everything still open across both."
      />

      <div role="tablist" aria-label="Meeting actions" className="flex flex-wrap gap-1 border-b border-ink-200">
        {TABS.map((t) => {
          const on = tab === t.key;
          const count = t.key === "pending"
            ? data.pending.notes.length + data.pending.engagements.length : null;
          return (
            <button key={t.key} role="tab" aria-selected={on} onClick={() => setTab(t.key)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
                on ? "border-accent-600 text-brand-700" : "border-transparent text-ink-500 hover:text-ink-700"}`}>
              <t.icon size={15} aria-hidden /> {t.label}
              {count !== null && count > 0 && (
                <span className="rounded-full bg-gold-100 px-1.5 text-xs font-semibold text-gold-700 tabular-nums">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {saveError && <Notice tone="bad">{saveError}</Notice>}

      {tab === "pending" && <Pending data={data} busy={busy} run={run} />}
      {tab === "meetings" && (
        <Meetings data={data} week={week} setWeek={setWeek} busy={busy} run={run} user={user} />
      )}
      {tab === "engagements" && <Engagements data={data} busy={busy} run={run} />}
      {tab === "schedule" && <Schedule data={data} busy={busy} run={run} />}
    </div>
  );
}

type Run = (key: string, fn: () => Promise<unknown>) => Promise<void>;

// ── Pending ──────────────────────────────────────────────────────────────────

/** "12.5% of 40", or "none logged" — a percentage of nothing is not a percentage. */
const share = (pct: number, total: number, noun: string) =>
  total > 0 ? `${fmtPct(pct)} of ${fmtInt(total)}` : `none ${noun}`;

function Pending({ data, busy, run }: { data: Actions; busy: string | null; run: Run }) {
  const p = data.pending;
  const nothing = p.notes.length === 0 && p.engagements.length === 0;
  return (
    <div className="space-y-5">
      <Tiles>
        <Tile label="Open meeting actions" value={fmtInt(p.meetingOpen)}
          tone={p.meetingOpen ? "warn" : "good"}
          note={share(p.meetingPct, p.meetingTotal, "notes")} />
        <Tile label="Open engagements" value={fmtInt(p.engagementOpen)}
          tone={p.engagementOpen ? "warn" : "good"}
          note={share(p.engagementPct, p.engagementTotal, "logged")} />
        <Tile label="People with something open" value={fmtInt(p.owners.length)} />
        <Tile label="Engagements this quarter" value={fmtInt(data.quarter.count)}
          note={`since ${data.quarter.from} · target 2–4`}
          tone={data.quarter.count >= 2 ? "good" : "warn"} />
      </Tiles>

      {p.owners.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-brand-700">Who owes what</h3>
          {/* An owner cell holding two names counts as two people each owing one, so this
              line can add up to more than the number of items. That is the Python's rule
              and it is the useful one — both people are waiting on. */}
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
            {p.owners.map((o) => (
              <li key={o.name} className="text-ink-700">
                {o.name} <span className="font-semibold tabular-nums text-brand-700">({o.items})</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {nothing ? (
        <EmptyState icon={<Check size={28} aria-hidden />} title="Nothing is open">
          Every meeting action and every engagement has been marked resolved.
        </EmptyState>
      ) : (
        <>
          {p.notes.length > 0 && (
            <Card className="p-4">
              <h3 className="mb-3 text-sm font-semibold text-brand-700">
                Meeting actions · {p.notes.length}
              </h3>
              <DataTable
                rows={p.notes} keyOf={(n) => n.id}
                cols={[
                  { head: "Action", cell: (n) => <span className="text-ink-700">{n.actions || dash}</span> },
                  { head: "Owner", cell: (n) => <span className="text-ink-600">{n.owner || "(unassigned)"}</span> },
                  { head: "Due", cell: (n) => <Due day={n.deadline} /> },
                  { head: "From", cell: (n) => <span className="text-ink-500">{n.meetingDate ?? dash}</span> },
                  {
                    head: "", align: "right", cell: (n) => (
                      <Button variant="ghost" size="sm" disabled={busy === n.id}
                        onClick={() => run(n.id, () => patchNote(n.id, { resolved: true }))}>
                        <Check size={14} aria-hidden /> Resolve
                      </Button>
                    ),
                  },
                ]}
              />
            </Card>
          )}
          {p.engagements.length > 0 && (
            <Card className="p-4">
              <h3 className="mb-1 text-sm font-semibold text-brand-700">
                Engagements · {p.engagements.length}
              </h3>
              <p className="mb-3 text-xs text-ink-500">
                An engagement counts as open until somebody marks it resolved — writing an
                outcome into it does not close it on its own.
              </p>
              <DataTable
                rows={p.engagements} keyOf={(e) => e.id}
                cols={[
                  { head: "Donor", cell: (e) => <span className="text-ink-700">{e.donor || dash}</span> },
                  { head: "Type", cell: (e) => <span className="text-ink-600">{e.type || dash}</span> },
                  { head: "Lead", cell: (e) => <span className="text-ink-600">{e.internalLead || dash}</span> },
                  { head: "When", cell: (e) => <span className="text-ink-500">{e.date ?? dash}</span> },
                  {
                    head: "", align: "right", cell: (e) => (
                      <Button variant="ghost" size="sm" disabled={busy === e.id}
                        onClick={() => run(e.id, () => patchEngagement(e.id, { resolved: true }))}>
                        <Check size={14} aria-hidden /> Resolve
                      </Button>
                    ),
                  },
                ]}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A deadline, said against today — a date alone makes a reader do the arithmetic.
 *
 * A RESOLVED item is never overdue, however long ago its date passed. Colouring it red
 * because the date is behind us says the work is late when it is done, which is the one
 * thing a list of open items must not get wrong.
 */
function Due({ day, resolved = false }: { day: string | null; resolved?: boolean }) {
  if (!day) return <span className="text-ink-400">{dash}</span>;
  if (resolved) return <span className="text-xs text-ink-400 tabular-nums">{day}</span>;
  const today = new Date().toISOString().slice(0, 10);
  const days = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const tone = days < 0 ? "bad" : days <= 7 ? "warn" : "neutral";
  const word = days < 0 ? `${-days}d overdue` : days === 0 ? "today" : `in ${days}d`;
  return <Badge tone={tone}>{day} · {word}</Badge>;
}

// ── Meetings ─────────────────────────────────────────────────────────────────

function Meetings({ data, week, setWeek, busy, run, user }: {
  data: Actions; week: string; setWeek: (w: string) => void;
  busy: string | null; run: Run; user: User;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MeetingNote | null>(null);
  // The week picker offers weeks that HAVE notes, plus this week — otherwise there is no
  // way to open the current week before its first note exists.
  const thisWeek = mondayOf(new Date().toISOString().slice(0, 10));
  const weeks = [...new Set([thisWeek, week, ...data.weeks])].sort().reverse();

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label>
            <span className="mb-1 block text-xs font-semibold text-ink-600">Week</span>
            <Select value={week} onChange={(e) => setWeek(e.target.value)}>
              {weeks.map((w) => <option key={w} value={w}>{w === thisWeek ? `${w} · this week` : w}</option>)}
            </Select>
          </label>
          <span className="text-sm text-ink-500">{data.week.label}</span>
          <Button variant="primary" onClick={() => { setEditing(null); setAdding(true); }}>
            <Plus size={15} aria-hidden /> Add a note
          </Button>
        </div>

        {data.rota ? (
          <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-ink-100 pt-3 text-sm">
            <div><dt className="text-xs text-ink-500">Note-taker</dt>
              <dd className="font-semibold text-brand-700">{data.rota.noteTaker || dash}</dd></div>
            <div><dt className="text-xs text-ink-500">Presenter</dt>
              <dd className="font-semibold text-brand-700">{data.rota.presenter || dash}</dd></div>
            <div><dt className="text-xs text-ink-500">Chair</dt>
              <dd className="font-semibold text-brand-700">{data.rota.chair || dash}</dd></div>
          </dl>
        ) : (
          <p className="mt-4 border-t border-ink-100 pt-3 text-xs text-ink-400">
            No rota recorded for this week — set one on the Schedule tab.
          </p>
        )}
      </Card>

      {(adding || editing) && (
        <NoteForm
          note={editing} week={week} user={user} busy={busy === "note"}
          onCancel={() => { setAdding(false); setEditing(null); }}
          onSave={async (payload) => {
            await run("note", () => editing
              ? patchNote(editing.id, payload)
              : createNote({ ...payload, meetingDate: week } as never));
            setAdding(false); setEditing(null);
          }}
        />
      )}

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-brand-700">
          Notes for {data.week.monday} · {data.notes.length}
        </h3>
        <DataTable
          rows={data.notes} keyOf={(n) => n.id} empty="No notes recorded for this week yet."
          cols={[
            { head: "Call / donor", cell: (n) => (
              <span className="text-ink-700">{n.donorTitle || n.rfpUid || dash}</span>
            ) },
            { head: "Remarks", cell: (n) => <span className="text-ink-600">{n.remarks || dash}</span> },
            { head: "Action", cell: (n) => <span className="text-ink-700">{n.actions || dash}</span> },
            { head: "Owner", cell: (n) => <span className="text-ink-600">{n.owner || dash}</span> },
            { head: "Due", cell: (n) => <Due day={n.deadline} resolved={n.resolved} /> },
            { head: "Status", cell: (n) => (
              <Button variant="ghost" size="sm" disabled={busy === n.id}
                onClick={() => run(n.id, () => patchNote(n.id, { resolved: !n.resolved }))}>
                <Badge tone={n.resolved ? "good" : "warn"}>{n.resolved ? "Resolved" : "Open"}</Badge>
              </Button>
            ) },
            { head: "", align: "right", cell: (n) => (
              <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setEditing(n); }}>Edit</Button>
            ) },
          ]}
        />
      </Card>
    </div>
  );
}

function NoteForm({ note, week, user, busy, onCancel, onSave }: {
  note: MeetingNote | null; week: string; user: User; busy: boolean;
  onCancel: () => void; onSave: (p: Record<string, unknown>) => void;
}) {
  const [f, setF] = useState({
    donorTitle: note?.donorTitle ?? "", rfpUid: note?.rfpUid ?? "",
    remarks: note?.remarks ?? "", actions: note?.actions ?? "",
    // A new note defaults to the person writing it. The rota rotates, so whoever is at the
    // keyboard on Monday is usually the owner of what they just agreed to.
    owner: note?.owner ?? (user.name || ""),
    deadline: note?.deadline ?? "", resolved: note?.resolved ?? false,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-brand-700">
        {note ? "Edit this note" : `Add a note for ${week}`}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="n-donor" label="Call or donor"><input id="n-donor" className={fieldClass} value={f.donorTitle} onChange={set("donorTitle")} /></Field>
        <Field id="n-uid" label="Linked call UID" hint="Optional."><input id="n-uid" className={fieldClass} value={f.rfpUid} onChange={set("rfpUid")} /></Field>
        <Field id="n-remarks" label="Remarks" ><textarea id="n-remarks" rows={3} className={fieldClass} value={f.remarks} onChange={set("remarks")} /></Field>
        <Field id="n-actions" label="Action or recommendation" hint="Required."><textarea id="n-actions" rows={3} className={fieldClass} value={f.actions} onChange={set("actions")} /></Field>
        <Field id="n-owner" label="Owner" hint="Two names, comma separated, means both."><input id="n-owner" className={fieldClass} value={f.owner} onChange={set("owner")} /></Field>
        <Field id="n-due" label="Due"><input id="n-due" type="date" className={fieldClass} value={f.deadline} onChange={set("deadline")} /></Field>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" className="size-4 accent-accent-600" checked={f.resolved}
          onChange={(e) => setF({ ...f, resolved: e.target.checked })} />
        Already resolved
      </label>
      <div className="mt-4 flex gap-2">
        <Button variant="primary" disabled={busy || !f.actions.trim()} onClick={() => onSave(f)}>
          {busy ? "Saving…" : note ? "Save changes" : "Add the note"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
      {!f.actions.trim() && <p className="mt-2 text-xs text-ink-400">An action is required — it is what the Pending tab lists.</p>}
    </Card>
  );
}

// ── Engagements ──────────────────────────────────────────────────────────────

function Engagements({ data, busy, run }: { data: Actions; busy: string | null; run: Run }) {
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({
    date: new Date().toISOString().slice(0, 10), donor: "", type: "", format: "",
    internalLead: "", donorContacts: "", purpose: "", outcome: "", rfpUid: "",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="space-y-4">
      <Tiles>
        <Tile label="Engagements logged" value={fmtInt(data.engagements.length)} />
        <Tile label="This quarter" value={fmtInt(data.quarter.count)}
          tone={data.quarter.count >= 2 ? "good" : "warn"} note="target 2–4" />
        <Tile label="Still open" value={fmtInt(data.pending.engagementOpen)}
          tone={data.pending.engagementOpen ? "warn" : "good"} />
        <Tile label="Donors reached"
          value={fmtInt(new Set(data.engagements.map((e) => e.donor).filter(Boolean)).size)} />
      </Tiles>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-brand-700">Partner engagements</h3>
          <Button variant={adding ? "ghost" : "primary"} onClick={() => setAdding((v) => !v)}>
            <Plus size={15} aria-hidden /> {adding ? "Cancel" : "Log an engagement"}
          </Button>
        </div>

        {adding && (
          <div className="mb-4 border-b border-ink-100 pb-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field id="e-date" label="Date"><input id="e-date" type="date" className={fieldClass} value={f.date} onChange={set("date")} /></Field>
              <Field id="e-donor" label="Donor" hint="Required."><input id="e-donor" className={fieldClass} value={f.donor} onChange={set("donor")} /></Field>
              <Field id="e-type" label="Type" hint="Call, pitch, conference, scoping…"><input id="e-type" className={fieldClass} value={f.type} onChange={set("type")} /></Field>
              <Field id="e-format" label="Format"><input id="e-format" className={fieldClass} value={f.format} onChange={set("format")} /></Field>
              <Field id="e-lead" label="Internal lead"><input id="e-lead" className={fieldClass} value={f.internalLead} onChange={set("internalLead")} /></Field>
              <Field id="e-contacts" label="Donor contacts"><input id="e-contacts" className={fieldClass} value={f.donorContacts} onChange={set("donorContacts")} /></Field>
              <Field id="e-purpose" label="Purpose"><textarea id="e-purpose" rows={2} className={fieldClass} value={f.purpose} onChange={set("purpose")} /></Field>
              <Field id="e-outcome" label="Outcome" hint="Leave blank while it is still open."><textarea id="e-outcome" rows={2} className={fieldClass} value={f.outcome} onChange={set("outcome")} /></Field>
              <Field id="e-uid" label="Linked call UID" hint="Optional — an engagement need not have one."><input id="e-uid" className={fieldClass} value={f.rfpUid} onChange={set("rfpUid")} /></Field>
            </div>
            <Button variant="primary" className="mt-3" disabled={busy === "eng" || !f.donor.trim()}
              onClick={() => run("eng", async () => {
                await createEngagement(f);
                setAdding(false);
                setF({ ...f, donor: "", type: "", format: "", internalLead: "", donorContacts: "", purpose: "", outcome: "", rfpUid: "" });
              })}>
              {busy === "eng" ? "Saving…" : "Log it"}
            </Button>
          </div>
        )}

        <DataTable
          rows={data.engagements} keyOf={(e) => e.id} empty="No engagements logged yet."
          cols={[
            { head: "Date", cell: (e) => <span className="text-ink-600">{e.date ?? dash}</span> },
            { head: "Donor", cell: (e) => <span className="text-ink-700">{e.donor || dash}</span> },
            { head: "Type", cell: (e) => <span className="text-ink-600">{e.type || dash}</span> },
            { head: "Lead", cell: (e) => <span className="text-ink-600">{e.internalLead || dash}</span> },
            { head: "Purpose", cell: (e) => <span className="text-ink-600">{e.purpose || dash}</span> },
            { head: "Outcome", cell: (e) => <span className="text-ink-600">{e.outcome || dash}</span> },
            { head: "Status", align: "right", cell: (e) => (
              <Button variant="ghost" size="sm" disabled={busy === e.id}
                onClick={() => run(e.id, () => patchEngagement(e.id, { resolved: e.open }))}>
                <Badge tone={e.open ? "warn" : "good"}>{e.open ? "Open" : "Closed"}</Badge>
              </Button>
            ) },
          ]}
        />
      </Card>
    </div>
  );
}

// ── Schedule ─────────────────────────────────────────────────────────────────

function Schedule({ data, busy, run }: { data: Actions; busy: string | null; run: Run }) {
  const [draft, setDraft] = useState<RotaEntry[]>(data.schedule);
  const [dirty, setDirty] = useState(false);
  // The rota runs back to the start of the year and forward a few months. Opening on the
  // whole of it buries the only rows anybody edits — the ones that have not happened yet —
  // under forty that already have.
  const [showPast, setShowPast] = useState(false);
  useEffect(() => { setDraft(data.schedule); setDirty(false); }, [data.schedule]);

  const today = new Date().toISOString().slice(0, 10);
  const edit = (i: number, k: keyof RotaEntry) => (e: { target: { value: string } }) => {
    const next = draft.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r));
    setDraft(next); setDirty(true);
  };
  const add = () => {
    // The next Monday that has no entry yet — the rota is weekly, so that is the only
    // row a reader ever wants to add next.
    const last = draft.length ? draft[draft.length - 1].date : today;
    const next = new Date(Date.parse(`${last}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
    setDraft([...draft, { date: mondayOf(next), noteTaker: "", presenter: "", chair: "", cid: "" }]);
    setDirty(true);
  };

  if (!data.canEditSchedule) {
    return (
      <Card className="p-4">
        <h3 className="mb-1 text-sm font-semibold text-brand-700">Check-in rota</h3>
        <p className="mb-3 text-xs text-ink-500">
          Who takes notes, presents and chairs each Monday. Only an administrator can change it.
        </p>
        <DataTable
          rows={data.schedule.filter((r) => r.date >= today).slice(0, 12)} keyOf={(r) => r.date}
          empty="No rota recorded."
          cols={[
            { head: "Monday", cell: (r) => <span className={r.date === mondayOf(today) ? "font-semibold text-brand-700" : "text-ink-600"}>{r.date}</span> },
            { head: "Note-taker", cell: (r) => r.noteTaker || dash },
            { head: "Presenter", cell: (r) => r.presenter || dash },
            { head: "Chair", cell: (r) => r.chair || dash },
          ]}
        />
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-brand-700">Check-in rota</h3>
          {/* Worth saying, because the store is one blob: a save replaces the whole list. */}
          <p className="mt-0.5 text-xs text-ink-500">
            Saving replaces the whole rota — two people editing it at once will overwrite
            each other, so it is a one-at-a-time job.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={add}><Plus size={15} aria-hidden /> Add a week</Button>
          <Button variant="primary" disabled={!dirty || busy === "sched"}
            onClick={() => run("sched", () => putSchedule(draft))}>
            {busy === "sched" ? "Saving…" : "Save the rota"}
          </Button>
        </div>
      </div>
      {!showPast && draft.some((r) => r.date < mondayOf(today)) && (
        <p className="mb-2 text-xs text-ink-500">
          {draft.filter((r) => r.date < mondayOf(today)).length} past week
          {draft.filter((r) => r.date < mondayOf(today)).length === 1 ? " is" : "s are"} hidden.{" "}
          <button type="button" onClick={() => setShowPast(true)}
            className="font-semibold text-accent-700 underline hover:text-accent-800">Show them</button>
          {" "}— they are still saved either way.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-152 border-collapse text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
              <th scope="col" className="px-2 py-2 font-semibold">Monday</th>
              <th scope="col" className="px-2 py-2 font-semibold">Note-taker</th>
              <th scope="col" className="px-2 py-2 font-semibold">Presenter</th>
              <th scope="col" className="px-2 py-2 font-semibold">Chair</th>
            </tr>
          </thead>
          <tbody>
            {/* Hidden rows are still in `draft` and still saved — the filter is a view, not
                a delete. Mapping over the filtered list would renumber the edit indices and
                write a change into the wrong week. */}
            {draft.map((r, i) => (showPast || r.date >= mondayOf(today)) && (
              <tr key={`${r.date}-${i}`} className="border-b border-ink-100 last:border-0">
                <td className="px-2 py-1.5"><input type="date" className={`${fieldClass} w-40`} value={r.date} onChange={edit(i, "date")} /></td>
                <td className="px-2 py-1.5"><input className={fieldClass} value={r.noteTaker} onChange={edit(i, "noteTaker")} /></td>
                <td className="px-2 py-1.5"><input className={fieldClass} value={r.presenter} onChange={edit(i, "presenter")} /></td>
                <td className="px-2 py-1.5"><input className={fieldClass} value={r.chair} onChange={edit(i, "chair")} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {draft.length === 0 && <p className="py-6 text-center text-sm text-ink-400">No rota yet — add a week.</p>}
    </Card>
  );
}
