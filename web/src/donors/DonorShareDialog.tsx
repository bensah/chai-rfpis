/**
 * Share a donor profile — the markdown summary to copy, and the branded PDF.
 *
 * TWO HALVES THAT BEHAVE DIFFERENTLY ON PURPOSE. The markdown is built in the browser
 * from rows it already has, so it is instant and works offline; the PDF is reportlab, so
 * it queues a job and takes a minute. Presenting them as one button would mean either
 * making the copy wait for a renderer it does not need, or implying the PDF is ready when
 * it has not started.
 *
 * THE MARKDOWN IS NOT A PREVIEW OF THE PDF. It is the same text, but the PDF adds the
 * deploying org's logo and name, a title block and a page footer — things the markdown
 * has no way to carry. The caption says so rather than letting a reader infer that what
 * they copied is what their colleague will receive.
 *
 * CONTACTS ARE FETCHED, NOT ASSUMED. `donor_contacts` is a separate, tenant-scoped table
 * that the donors list does not carry, so the dialog loads them when it opens. A failed
 * load is NOT an error here: the profile is still shareable without the focal persons,
 * and refusing to share it over a missing contacts read would be the wrong trade. It
 * says the block is missing instead of silently shipping a summary that looks complete.
 */
import { useEffect, useState } from "react";
import {
  AlertTriangle, Check, Copy, Download, FileText, Users,
} from "lucide-react";
import {
  fetchContacts, requestDonorPdf, type DonorJob, type DonorPdfResult,
} from "../api";
import { awaitJob } from "../jobs";
import { Button, Notice } from "../ui";
import { Dialog } from "../settings/dialog";
import {
  type Contact, type Donor, type Schema, download, shareFilename, shareMarkdown,
  summaryLines, titleName,
} from "./model";

/** Bytes as a reader would say them, for a download the user is about to accept. */
function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DonorShareDialog(
  { rows, schema, onClose }:
  { rows: Donor[]; schema: Schema; onClose: () => void },
) {
  const one = rows.length === 1 ? rows[0] : null;
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [contactsFailed, setContactsFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<DonorPdfResult | null>(null);

  // Only for a single donor. A combined PDF of twenty would mean twenty contact reads
  // before the dialog could show anything, and the markdown for a selection has never
  // carried contacts — in Streamlit either.
  useEffect(() => {
    if (!one) { setContacts([]); return; }
    let live = true;
    setContacts(null);
    setContactsFailed(false);
    fetchContacts(one.canonical_key)
      .then((c) => { if (live) setContacts(c); })
      .catch(() => { if (live) { setContacts([]); setContactsFailed(true); } });
    return () => { live = false; };
  }, [one?.canonical_key]);

  const md = one
    ? shareMarkdown(one, schema, contacts ?? [])
    : rows.map((r) => summaryLines(r, schema).join("\n")).join("\n\n---\n\n");
  const mdName = one ? shareFilename(one, "md") : "donors_selected.md";
  const pdfName = one ? shareFilename(one, "pdf") : "donors_selected.pdf";

  async function copy() {
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard permission is the user's to give and some browsers withhold it from a
      // non-gesture context. The markdown is on screen and selectable, so say that
      // rather than failing silently.
      setError("Could not reach the clipboard — select the text below and copy it.");
    }
  }

  async function makePdf() {
    setBusy(true);
    setError(null);
    setReady(null);
    setNote("Queued…");
    let queued: DonorJob;
    try {
      queued = await requestDonorPdf(rows.map((r) => r.canonical_key),
        { filename: pdfName, contacts: !!one });
    } catch (e) {
      setBusy(false);
      setNote(null);
      setError(e instanceof Error ? e.message : "Could not start the PDF.");
      return;
    }
    if (!queued.dispatched) {
      // Queued but never dispatched: not an error, not a success, and nothing will say
      // so later. It is the worst failure this product has, so it is named.
      setBusy(false);
      setNote(null);
      setError(queued.detail);
      return;
    }
    setNote("Rendering…");
    // Five minutes, not awaitJob's default three. The wait is a GitHub Actions cold
    // start before any rendering begins, and the Report export already found three
    // minutes short of it. Giving up early does not cancel the job — it just stops
    // watching one that is about to succeed.
    const job = await awaitJob(queued.job_id, (j) => setNote(j.message || "Rendering…"),
      { everyMs: 2000, timeoutMs: 300_000 });
    setBusy(false);
    setNote(null);
    if (!job) {
      setError("Still rendering — try again in a moment.");
      return;
    }
    if (job.status !== "done") {
      setError(job.message || `The PDF job ${job.status}.`);
      return;
    }
    const result = job.result as unknown as DonorPdfResult;
    setReady(result);
    // Opened rather than navigated to: the signed URL carries a download disposition, so
    // the tab closes itself and the reader keeps the dialog they started from.
    window.open(result.url, "_blank", "noopener");
  }

  return (
    <Dialog
      title={one ? `Share ${titleName(one)}` : `Share ${rows.length} donors`}
      onClose={onClose}
    >
      <p className="text-sm text-slate-600">
        Copy the summary below, or download the full profile as a print-ready A4 PDF with
        your organisation's letterhead.
      </p>

      {contactsFailed && (
        <Notice tone="warn" className="mt-3" icon={<AlertTriangle className="h-4 w-4" />}>
          Focal-person contacts could not be loaded, so they are not in this summary. The
          rest of the profile is complete.
        </Notice>
      )}
      {one && contacts !== null && contacts.length > 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
          <Users className="h-3.5 w-3.5" />
          {contacts.length} focal {contacts.length === 1 ? "person" : "persons"} included.
        </p>
      )}

      {error && (
        <Notice tone="bad" className="mt-3" icon={<AlertTriangle className="h-4 w-4" />}>
          {error}
        </Notice>
      )}

      {ready && (
        <Notice tone="good" className="mt-3" icon={<Check className="h-4 w-4" />}>
          <span className="block">
            {ready.filename} ({readableSize(ready.bytes)}) is downloading.
          </span>
          {/* The link is a bearer capability with a clock on it. A reader's instinct is to
              paste a download link into a thread, where it will be dead by the time
              anybody clicks it — so the clock is stated, not left to be discovered. */}
          <span className="mt-1 block text-xs">
            The download link expires in {Math.round(ready.expiresInS / 60)} minutes.
            {" "}
            <a href={ready.url} className="underline" target="_blank" rel="noopener noreferrer">
              Download again
            </a>
            {ready.missing.length > 0
              && ` ${ready.missing.length} selected donor(s) no longer exist and were left out.`}
          </span>
        </Notice>
      )}

      <pre className="mt-4 max-h-[42vh] overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">
        {contacts === null ? "Loading contacts…" : md}
      </pre>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {note && <span className="mr-auto text-xs text-slate-500">{note}</span>}
        <Button
          variant="ghost"
          onClick={copy}
          disabled={contacts === null}
          icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        >
          {copied ? "Copied" : "Copy summary"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => download(mdName, md, "text/markdown")}
          disabled={contacts === null}
          icon={<Download className="h-4 w-4" />}
        >
          Download (.md)
        </Button>
        <Button
          onClick={makePdf}
          busy={busy}
          disabled={contacts === null}
          icon={<FileText className="h-4 w-4" />}
        >
          {busy ? "Rendering…" : "Download PDF"}
        </Button>
      </div>
    </Dialog>
  );
}
