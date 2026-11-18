/**
 * The eight-tab donor profile editor — `_edit_dialog` in app_pages/donors.py.
 *
 * IT SENDS A DIFF, NOT THE FORM. `edited` carries only the columns the user actually
 * changed, and that is load-bearing rather than an optimisation: the save is an upsert,
 * so a column PRESENT in the payload is written and a column ABSENT is left alone.
 * Sending the whole form would mean this React editor writing its own idea of every
 * field — including the ones it has no control for — over whatever the classic app
 * stored. `donor_priority_ratings` is the live example: React cannot edit the per-area
 * rating matrix, so it never names the column and the ratings survive.
 *
 * THE FLAG MATRIX IS DERIVED, NOT LISTED. donor_intel's columns decide which fields are
 * requirement flags, so the matrix renders whatever `buildSchema` classified from the
 * rows actually loaded — the same negative rule the Python applies to its dataframe.
 * A migration adds a question here with no change to this file.
 *
 * A REQUIREMENT HAS FOUR STATES AND BLANK IS NOT "NOT SURE". Blank means nobody has
 * answered; "not_sure" means somebody looked and could not tell. Scoring treats them
 * identically, so the only place the difference shows is the completeness percentage —
 * which is exactly why the control must offer all four and default to blank.
 */
import { useMemo, useState } from "react";
import { Lightbulb, Save } from "lucide-react";
import { updateDonor, type DonorJob } from "../api";
import { awaitJob } from "../jobs";
import { Badge, Button, Notice, fieldClass } from "../ui";
import { Dialog } from "../settings/dialog";
import MultiSelect from "../components/MultiSelect";
import {
  completeness, disp, label, prettyChoice, titleName, toList, type Donor, type Schema,
} from "./model";
import { TABS, type Field } from "./formSpec";
import {
  CATEGORIES, CONTACT_COLS, OTHER, TRISTATE_OPTS, TRISTATE_TO_VAL, VAL_TO_TRISTATE,
} from "./writeVocab";

type Contact = Record<string, unknown>;
type Values = Record<string, unknown>;

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** The form's starting value for a column, as a string the controls can hold. */
function initial(row: Donor, col: string): string {
  const v = row[col];
  // NOT `disp()`: that de-SHOUTS and rewrites the {country} placeholder for DISPLAY.
  // Seeding an editor with it would save the prettified text over the stored value.
  return v === null || v === undefined ? "" : String(v);
}

function jsonList(v: unknown): string[] {
  return toList(v);
}

export default function DonorEditDialog(
  { row, schema, contacts, suggest, onClose, onDone }: {
    row: Donor;
    schema: Schema;
    contacts: Contact[];
    suggest: boolean;
    onClose: () => void;
    onDone: (msg: string) => void;
  },
) {
  const [tab, setTab] = useState(TABS[0].id);
  // Only what the user touched. See the note at the top: absent means "leave alone".
  const [edited, setEdited] = useState<Values>({});
  const [contactRows, setContactRows] = useState<Contact[]>(() => contacts.map((c) => ({ ...c })));
  const [contactsTouched, setContactsTouched] = useState(false);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = (col: string, v: unknown) => setEdited((e) => ({ ...e, [col]: v }));
  const valueOf = (col: string): string =>
    col in edited ? str(edited[col]) : initial(row, col);
  const listOf = (col: string): string[] =>
    col in edited ? jsonList(edited[col]) : jsonList(row[col]);

  const pct = useMemo(() => completeness(row, schema).pct, [row, schema]);
  const dirty = Object.keys(edited).length + (contactsTouched ? 1 : 0);

  async function submit() {
    setBusy(true);
    setError(null);
    let queued: DonorJob;
    try {
      queued = await updateDonor(row.canonical_key, {
        edited: edited as Record<string, unknown>,
        // Sent ONLY if the user opened and changed the contacts grid. The runner
        // REPLACES a donor's contacts with what it is given, so an untouched grid must
        // not be sent at all — [] would delete every focal person this donor has.
        ...(contactsTouched ? { contacts: contactRows as Record<string, unknown>[] } : {}),
        suggest,
        rationale: rationale.trim() || undefined,
      });
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "The request failed.");
      return;
    }
    if (!queued.dispatched) {
      setBusy(false);
      setError(queued.detail);
      return;
    }
    setNote("Running…");
    const job = await awaitJob(queued.job_id, (j) => setNote(j.message || "Running…"));
    setBusy(false);
    setNote(null);
    if (!job) { setError("Still running — check back in a moment."); return; }
    if (job.status !== "done") {
      setError(job.message || `The job ${job.status}. Nothing was changed.`);
      return;
    }
    const result = (job.result ?? {}) as { summary?: string; warnings?: string[] };
    onDone([result.summary, ...(result.warnings ?? [])].filter(Boolean).join(" ")
      || "Saved.");
  }

  function renderField(f: Field, i: number) {
    if (f.kind === "matrix") return <FlagMatrix key={`m${i}`} {...{ f, schema, row, edited, set }} />;
    if (f.kind === "contacts") {
      return (
        <ContactsGrid
          key={`c${i}`} rows={contactRows}
          onChange={(rows) => { setContactRows(rows); setContactsTouched(true); }}
        />
      );
    }
    const text = f.label ?? label(f.col);
    const help = "help" in f && f.help
      ? <p className="mt-1 text-xs leading-relaxed text-ink-500">{f.help}</p>
      : null;

    if (f.kind === "repeater") {
      return (
        <div key={f.col} className="mb-5">
          <label className="mb-1.5 block text-sm font-medium text-ink-700">{text}</label>
          <Repeater
            columns={f.columns}
            rows={(() => {
              const raw = f.col in edited ? edited[f.col] : row[f.col];
              try {
                const parsed = JSON.parse(str(raw) || "[]");
                return Array.isArray(parsed) ? parsed as Values[] : [];
              } catch { return []; }
            })()}
            onChange={(rows) => set(f.col, JSON.stringify(rows))}
          />
          {help}
        </div>
      );
    }

    if (f.kind === "multi") {
      const opts = f.col === "donor_funders_collaborators" ? [] : f.options;
      return (
        <div key={f.col} className="mb-5">
          <MultiSelect
            label={text} options={opts} value={listOf(f.col)}
            onChange={(v) => set(f.col, JSON.stringify(v))}
          />
          {help}
        </div>
      );
    }

    if (f.kind === "select") {
      const opts = f.col === "donor_category" ? categoryOptions(row) : f.options;
      const cur = valueOf(f.col);
      // A legacy value that is not in the list is APPENDED, never silently replaced by
      // option 0 — that would rewrite a donor's stored value just by opening the form.
      const all = cur && !opts.includes(cur) ? [...opts, cur] : opts;
      return (
        <div key={f.col} className="mb-5">
          <label className="mb-1.5 block text-sm font-medium text-ink-700">{text}</label>
          <select className={fieldClass} value={cur} disabled={busy}
            onChange={(e) => set(f.col, e.target.value)}>
            {all.map((o) => (
              <option key={o} value={o}>{o === "" ? "—" : f.pretty ? prettyChoice(o) : o}</option>
            ))}
          </select>
          {help}
        </div>
      );
    }

    if (f.kind === "singleOther") {
      return (
        <SingleWithOther
          key={f.col} label={text} options={f.options} value={valueOf(f.col)}
          disabled={busy} onChange={(v) => set(f.col, v)} help={help}
        />
      );
    }

    return (
      <div key={f.col} className="mb-5">
        <label className="mb-1.5 block text-sm font-medium text-ink-700">{text}</label>
        {f.kind === "area"
          ? <textarea className={fieldClass} rows={f.rows ?? 3} value={valueOf(f.col)}
              disabled={busy} onChange={(e) => set(f.col, e.target.value)} />
          : <input className={fieldClass} value={valueOf(f.col)} disabled={busy}
              placeholder={"placeholder" in f ? f.placeholder : undefined}
              onChange={(e) => set(f.col, e.target.value)} />}
        {help}
      </div>
    );
  }

  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <Dialog
      title={titleName(row)}
      onClose={busy ? () => {} : onClose}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <Badge tone="neutral">{pct}% documented</Badge>
        {suggest
          ? <span className="text-sm text-ink-600">
              Your edits are submitted for a developer Super User to review — nothing is
              saved directly.
            </span>
          : <span className="text-sm text-ink-600">
              Keep entries funder-centric and reusable across tenants.
            </span>}
      </div>

      {error && <Notice tone="bad" className="mb-4">{error}</Notice>}

      <div className="mb-5 flex flex-wrap gap-1.5 border-b border-ink-200 pb-2">
        {TABS.map((t) => (
          <button
            key={t.id} onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              t.id === tab
                ? "bg-accent-50 text-accent-700"
                : "text-ink-600 hover:bg-ink-100 hover:text-ink-900"}`}
          >
            {t.title}
          </button>
        ))}
      </div>

      <div className="max-h-[52vh] overflow-y-auto pr-1">
        {active.fields.map(renderField)}
      </div>

      {suggest && (
        <div className="mt-4 border-t border-ink-100 pt-4">
          <label className="mb-1.5 block text-sm font-medium text-ink-700">
            Why this change? <span className="font-normal text-ink-500">(optional — helps the reviewer)</span>
          </label>
          <textarea className={fieldClass} rows={2} value={rationale} disabled={busy}
            onChange={(e) => setRationale(e.target.value)} />
        </div>
      )}

      {note && <p className="mt-3 text-sm text-ink-500">{note}</p>}

      <div className="mt-6 flex items-center justify-between gap-3">
        <span className="text-sm text-ink-500">
          {dirty === 0 ? "No changes yet" : `${dirty} change${dirty === 1 ? "" : "s"} not yet saved`}
        </span>
        <span className="flex gap-2.5">
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary" onClick={submit} disabled={busy || dirty === 0}
            icon={suggest ? <Lightbulb className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          >
            {busy ? "Working…" : suggest ? "Submit suggestion" : "Save changes"}
          </Button>
        </span>
      </div>
    </Dialog>
  );
}

/** The category list, with this donor's own value appended if it is not canonical. */
function categoryOptions(row: Donor): string[] {
  const opts = [...CATEGORIES];
  const cur = disp(row.donor_category);
  if (cur && !opts.includes(cur)) opts.push(cur);
  return opts;
}

/**
 * Selectbox with an "Other (specify)" escape hatch.
 *
 * A legacy free-text value that is not in `options` preselects Other with that text, so
 * opening the form never silently drops what somebody typed last year.
 */
function SingleWithOther(
  { label: text, options, value, disabled, onChange, help }: {
    label: string; options: string[]; value: string; disabled: boolean;
    onChange: (v: string) => void; help: React.ReactNode;
  },
) {
  const known = options.includes(value);
  const [other, setOther] = useState(known ? "" : value);
  const [pick, setPick] = useState(known ? value : value ? OTHER : "");
  const base = ["", ...options, OTHER];

  return (
    <div className="mb-5">
      <label className="mb-1.5 block text-sm font-medium text-ink-700">{text}</label>
      <select
        className={fieldClass} value={pick} disabled={disabled}
        onChange={(e) => {
          setPick(e.target.value);
          onChange(e.target.value === OTHER ? other : e.target.value);
        }}
      >
        {base.map((o) => <option key={o} value={o}>{o === "" ? "—" : o}</option>)}
      </select>
      {pick === OTHER && (
        <input
          className={`${fieldClass} mt-2`} value={other} disabled={disabled}
          placeholder={`${text} — specify`}
          onChange={(e) => { setOther(e.target.value); onChange(e.target.value); }}
        />
      )}
      {help}
    </div>
  );
}

/**
 * The flag groups, rendered from the LIVE schema.
 *
 * Requirements are tri-state; the legal/registration capabilities stay yes/no. The
 * untouched default for a requirement is BLANK, never "Not sure" — otherwise missing
 * data would read as answered, and the completeness percentage would be a lie in the
 * flattering direction.
 */
function FlagMatrix(
  { f, schema, row, edited, set }: {
    f: Extract<Field, { kind: "matrix" }>; schema: Schema; row: Donor;
    edited: Values; set: (col: string, v: unknown) => void;
  },
) {
  return (
    <>
      {f.groups.map((group) => {
        const cols = schema.groups[group] ?? [];
        if (!cols.length) return null;
        const tristate = group === "Requirements & compliance";
        return (
          <div key={group} className="mb-6">
            <h4 className="mb-2.5 text-sm font-bold text-brand-700">{group}</h4>
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {cols.map((c) => {
                const stored = str(c in edited ? edited[c] : row[c]).trim().toLowerCase();
                if (tristate) {
                  const cur = VAL_TO_TRISTATE[stored] ?? TRISTATE_OPTS[0];
                  return (
                    <label key={c} className="text-xs text-ink-700">
                      <span className="mb-1 block">{label(c)}</span>
                      <select
                        className={`${fieldClass} h-9 text-xs`} value={cur}
                        onChange={(e) => set(c, TRISTATE_TO_VAL[e.target.value] ?? null)}
                      >
                        {TRISTATE_OPTS.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </label>
                  );
                }
                return (
                  <label key={c} className="flex items-start gap-2 text-xs text-ink-700">
                    <input
                      type="checkbox" className="mt-0.5" checked={stored === "yes"}
                      onChange={(e) => {
                        // An UNKNOWN (blank) flag that is unticked stays unknown. Only a
                        // flag that already said something becomes an explicit "no".
                        if (e.target.checked) set(c, "yes");
                        else if (stored === "") set(c, row[c] ?? null);
                        else set(c, "no");
                      }}
                    />
                    <span>{label(c)}</span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** A JSON array of objects, edited as rows. Blank rows are dropped by the runner. */
function Repeater(
  { columns, rows, onChange }: {
    columns: { key: string; label: string }[];
    rows: Values[];
    onChange: (rows: Values[]) => void;
  },
) {
  const update = (i: number, key: string, v: string) =>
    onChange(rows.map((r, n) => (n === i ? { ...r, [key]: v } : r)));

  return (
    <div className="rounded-lg border border-ink-200">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs font-semibold text-ink-600">
            <tr>{columns.map((c) => <th key={c.key} className="px-2 py-2">{c.label}</th>)}
              <th className="w-10" /></tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key} className="px-1.5 py-1.5">
                    <input
                      className="w-full rounded border border-ink-200 px-2 py-1 text-xs"
                      value={str(r[c.key])}
                      onChange={(e) => update(i, c.key, e.target.value)}
                    />
                  </td>
                ))}
                <td className="px-1.5">
                  <button
                    onClick={() => onChange(rows.filter((_, n) => n !== i))}
                    className="text-xs text-bad-700 hover:underline" aria-label="Remove row"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={columns.length + 1}
                className="px-3 py-3 text-xs text-ink-500">No rows yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <button
        onClick={() => onChange([...rows, {}])}
        className="w-full border-t border-ink-200 px-3 py-2 text-xs font-medium text-accent-700 hover:bg-ink-50"
      >
        + Add row
      </button>
    </div>
  );
}

/**
 * The focal-person grid (`donor_contacts`), which is NOT a donor_intel column.
 *
 * The runner REPLACES this donor's contacts with whatever it is sent, so the dialog only
 * sends them when this grid has been touched. That is why `onChange` fires on every edit
 * and the parent records it: an untouched grid must produce no `contacts` key at all.
 */
function ContactsGrid(
  { rows, onChange }: { rows: Contact[]; onChange: (rows: Contact[]) => void },
) {
  const cols = CONTACT_COLS.filter((c) => c !== "is_official");
  const update = (i: number, key: string, v: unknown) =>
    onChange(rows.map((r, n) => (n === i ? { ...r, [key]: v } : r)));

  return (
    <div>
      <p className="mb-3 text-sm leading-relaxed text-ink-600">
        Official channels or people the team has engaged. Sourced from public pages or
        first-party — never guessed. A row with no details at all is dropped on save.
      </p>
      <div className="space-y-3">
        {rows.map((r, i) => (
          <div key={i} className="rounded-lg border border-ink-200 p-3">
            <div className="grid gap-2.5 sm:grid-cols-2">
              {cols.map((c) => (
                <label key={c} className="text-xs text-ink-600">
                  <span className="mb-1 block">{label(c)}</span>
                  <input
                    className="w-full rounded border border-ink-200 px-2 py-1.5 text-sm"
                    value={str(r[c])} onChange={(e) => update(i, c, e.target.value)}
                  />
                </label>
              ))}
            </div>
            <div className="mt-2.5 flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-ink-700">
                <input type="checkbox" checked={r.is_official === true}
                  onChange={(e) => update(i, "is_official", e.target.checked)} />
                Official contact
              </label>
              <button
                onClick={() => onChange(rows.filter((_, n) => n !== i))}
                className="text-xs text-bad-700 hover:underline"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="text-sm text-ink-500">No contacts recorded.</p>
        )}
      </div>
      <button
        onClick={() => onChange([...rows, { is_official: false }])}
        className="mt-3 text-sm font-medium text-accent-700 hover:underline"
      >
        + Add a contact
      </button>
    </div>
  );
}
