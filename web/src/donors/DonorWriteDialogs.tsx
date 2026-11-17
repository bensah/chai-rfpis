/**
 * Add and Delete for the donor catalogue. Both QUEUE a job and wait for it.
 *
 * NOTHING HERE DECIDES WHAT IS ALLOWED. The job reads the actor from the users table and
 * enforces the split — a developer-tenant Super User edits `donor_intel` directly,
 * everyone else proposes a change for review. This file only decides which WORD to put on
 * the button, from the same `isDeveloperSuper` the Edge Function and Streamlit use, so a
 * user is never offered an action the server will refuse.
 *
 * IT WAITS FOR THE JOB RATHER THAN REPORTING SUCCESS AT THE QUEUE. The write happens in a
 * GitHub Actions runner, so "queued" is not "done" and the gap is a minute, not a moment.
 * Saying "Added" the instant the row is written would be a lie often enough to matter —
 * and the honest failure here is specific: a job that is queued but never dispatched does
 * not error, it simply sits, which is the worst failure this product has.
 */
import { useState } from "react";
import { AlertTriangle, Lightbulb, Plus, Trash2 } from "lucide-react";
import {
  createDonor, deleteDonors as apiDeleteDonors, type DonorJob,
} from "../api";
import { awaitJob } from "../jobs";
import { Button, Notice, fieldClass } from "../ui";
import { Dialog } from "../settings/dialog";
import { CATEGORIES } from "./writeVocab";

/** Queue, wait, and turn the outcome into one sentence. Never claims more than it knows. */
async function run(
  start: () => Promise<DonorJob>,
  onNote: (s: string) => void,
): Promise<{ ok: boolean; message: string }> {
  let queued: DonorJob;
  try {
    queued = await start();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "The request failed." };
  }
  if (!queued.dispatched) {
    // Not an error and not a success. The row exists, nothing has run, and nothing will
    // say so later — so it is said now, in those words.
    return { ok: false, message: queued.detail };
  }
  onNote("Running…");
  const job = await awaitJob(queued.job_id, (j) => onNote(j.message || "Running…"));
  if (!job) return { ok: false, message: "Still running — check back in a moment." };
  if (job.status !== "done") {
    return {
      ok: false,
      message: job.message || `The job ${job.status}. Nothing was changed.`,
    };
  }
  const result = (job.result ?? {}) as { summary?: string; warnings?: string[] };
  const warn = (result.warnings ?? []).join(" ");
  return { ok: true, message: [result.summary, warn].filter(Boolean).join(" ") || "Done." };
}

export function AddDonorDialog(
  { suggest, onClose, onDone }:
  { suggest: boolean; onClose: () => void; onDone: (msg: string) => void },
) {
  const [name, setName] = useState("");
  const [short, setShort] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [website, setWebsite] = useState("");
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await run(() => createDonor(name, {
      suggest,
      edited: {
        donor_short: short.trim() || null,
        donor_category: category,
        donor_website: website.trim() || null,
      },
      rationale: rationale.trim() || undefined,
    }), setNote);
    setBusy(false);
    setNote(null);
    if (!res.ok) { setError(res.message); return; }
    onDone(res.message);
  }

  return (
    <Dialog
      title={suggest ? "Propose a new donor" : "Add a new donor"}
      onClose={busy ? () => {} : onClose}
    >
      <p className="mb-4 text-sm leading-relaxed text-ink-600">
        {suggest
          ? "A developer Super User reviews and creates it; the full profile can be filled in afterwards."
          : "Create the record now, then open it and edit to add the full profile (scope, awards, contacts)."}
      </p>

      {error && <Notice tone="bad" className="mb-4">{error}</Notice>}

      <label className="mb-1.5 block text-sm font-medium text-ink-700">Donor name *</label>
      <input value={name} onChange={(e) => setName(e.target.value)} className={fieldClass}
        autoFocus disabled={busy} />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-ink-700">
            Short code / acronym
          </label>
          <input value={short} onChange={(e) => setShort(e.target.value)}
            className={fieldClass} disabled={busy} />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-ink-700">Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}
            className={fieldClass} disabled={busy}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <label className="mt-4 mb-1.5 block text-sm font-medium text-ink-700">Website</label>
      <input value={website} onChange={(e) => setWebsite(e.target.value)}
        placeholder="https://…" className={fieldClass} disabled={busy} />

      {suggest && (
        <>
          <label className="mt-4 mb-1.5 block text-sm font-medium text-ink-700">
            Why add this donor? <span className="font-normal text-ink-500">(optional)</span>
          </label>
          <textarea value={rationale} onChange={(e) => setRationale(e.target.value)}
            rows={3} className={fieldClass} disabled={busy} />
        </>
      )}

      {note && <p className="mt-3 text-sm text-ink-500">{note}</p>}

      <div className="mt-6 flex justify-end gap-2.5">
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          variant="primary" onClick={submit} disabled={busy || !name.trim()}
          icon={suggest ? <Lightbulb className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        >
          {busy ? "Working…" : suggest ? "Submit suggestion" : "Create donor"}
        </Button>
      </div>
    </Dialog>
  );
}

export function DeleteDonorsDialog(
  { keys, names, onClose, onDone }:
  { keys: string[]; names: string[]; onClose: () => void; onDone: (msg: string) => void },
) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await run(() => apiDeleteDonors(keys), setNote);
    setBusy(false);
    setNote(null);
    if (!res.ok) { setError(res.message); return; }
    onDone(res.message);
  }

  return (
    <Dialog title={keys.length === 1 ? "Delete donor" : `Delete ${keys.length} donors`}
      onClose={busy ? () => {} : onClose}>
      {error && <Notice tone="bad" className="mb-4">{error}</Notice>}
      <Notice tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>
        {/* Named, not counted. "Delete 7 donors?" is a number somebody confirms without
            reading; the names are what makes a wrong selection visible. */}
        This removes {keys.length === 1 ? "this donor" : "these donors"} from the shared
        catalogue every tenant reads, and cannot be undone.
      </Notice>
      <ul className="mt-4 max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-sm text-ink-700">
        {names.map((n, i) => <li key={keys[i]}>{n}</li>)}
      </ul>
      {note && <p className="mt-3 text-sm text-ink-500">{note}</p>}
      <div className="mt-6 flex justify-end gap-2.5">
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="danger" onClick={submit} disabled={busy}
          icon={<Trash2 className="h-4 w-4" />}>
          {busy ? "Deleting…" : "Yes, delete"}
        </Button>
      </div>
    </Dialog>
  );
}
