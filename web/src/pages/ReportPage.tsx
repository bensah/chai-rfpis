/**
 * Performance — the period, the filter, and five sections of figures.
 *
 * "Performance" in the rail; the heading here spells the report out, because the rail has one line
 * per item and somebody meeting the initials for the first time is looking at the page.
 *
 * TWO THINGS SHAPE THIS PAGE, and both come from the Streamlit original rather than from
 * taste:
 *
 * 1. NOTHING LOADS UNTIL YOU GENERATE. The sections read up to 50,000 submissions between
 *    them, so opening the page does not fetch them. You pick a period, optionally narrow
 *    the filter, and press Generate — which is also the moment the selection is SAVED, so
 *    the report survives a refresh, a dropped connection, or being sent to someone else.
 *
 * 2. THE SHORT LINK IS THE REPORT. Generate mints `?r=YYYYMMDD-NNNNNN` and the whole
 *    selection lives server-side under it (api/report_snapshots.ts). Opening that link
 *    restores the exact report. The store keeps the newest 100 and is shared across
 *    tenants, so an old link can age out — `missing` says so rather than showing an empty
 *    report that looks like a data problem.
 *
 * Each section is fetched on its own, and shown the moment it lands. They take very
 * different times — Section 1 reads the scan log, Section 5 waits on live FX — and holding
 * all five behind the slowest would make the fastest look broken.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, Check, Download, Link2, Play, SlidersHorizontal } from "lucide-react";
import {
  ApiError, fetchReportSection1, fetchReportSection2, fetchReportSection3, fetchReportSection4,
  fetchReportSection5, fetchReportSnapshot, requestReportExport, saveReportSnapshot,
  type Job, type ReportExportResult,
  type ReportSection1 as S1, type ReportSection2 as S2, type ReportSection3 as S3,
  type ReportSection4 as S4, type ReportSection5 as S5, type ReportSelection, type ReportSnapshot,
} from "../api";
import { awaitJob, JOB_STATUS_LABEL } from "../jobs";
import { setParams } from "../router";
import { Button, Card, EmptyState, Field, Notice, PageHeader, Select, Spinner } from "../ui";
import { Section1, Section2, Section3, Section4, Section5 } from "../report/sections";

/** The report id in the URL, if there is one. */
const ridInUrl = () => {
  try {
    return (new URLSearchParams(window.location.search).get("r") ?? "").trim() || null;
  } catch {
    return null;
  }
};

/**
 * The comparison behind "Selections changed", in the server's own spelling.
 *
 * It is built from what was SAVED, not from what was restored — which is why a link made
 * before a metric existed says "changed" the moment it opens. That is not a bug: restoring
 * switches the new metric on, so re-Generating really would save something different from
 * what the link holds. See `signatureOf` in api/report_snapshots.ts.
 */
const signature = (sel: ReportSelection, secs: string[], items: string[]) =>
  JSON.stringify([sel.period, sel.year, sel.month, sel.view, [...secs].sort(), [...items].sort()]);

type Loaded<T> = { data?: T; error?: string };

export default function ReportPage() {
  const [snap, setSnap] = useState<ReportSnapshot | null>(null);
  const [boot, setBoot] = useState<string | null>(null);

  // The controls. Seeded from the snapshot once it lands, then the reader's to change.
  const [sel, setSel] = useState<ReportSelection | null>(null);
  const [secs, setSecs] = useState<string[]>([]);
  const [items, setItems] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);

  // What has actually been generated — the sections follow THIS, never the live controls,
  // so changing a dropdown does not silently re-fetch five sections under the reader.
  const [shown, setShown] = useState<ReportSelection | null>(null);
  const [shownSecs, setShownSecs] = useState<string[]>([]);
  const [shownItems, setShownItems] = useState<string[]>([]);
  const [savedSig, setSavedSig] = useState<string | null>(null);
  const [rid, setRid] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState<Job | null>(null);
  const [exported, setExported] = useState<ReportExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [s1, setS1] = useState<Loaded<S1>>({});
  const [s2, setS2] = useState<Loaded<S2>>({});
  const [s3, setS3] = useState<Loaded<S3>>({});
  const [s4, setS4] = useState<Loaded<S4>>({});
  const [s5, setS5] = useState<Loaded<S5>>({});

  // Only the newest Generate may write into the section slots: a reader who presses it
  // twice would otherwise get the first run's answers painted over the second's.
  const run = useRef(0);

  useEffect(() => {
    let live = true;
    fetchReportSnapshot(ridInUrl())
      .then((s) => {
        if (!live) return;
        setSnap(s);
        setSel(s.selection);
        setSecs(s.restored.secs);
        setItems(s.restored.items);
        setSavedSig(s.savedSignature);
        setRid(s.found ? s.rid : null);
        // A link that resolved IS a generated report — that is the whole point of it
        // surviving a refresh, so it loads its sections without a second press.
        if (s.found) load(s.selection, s.restored.secs, s.restored.items);
      })
      .catch((e) => live && setBoot(e instanceof ApiError ? e.message : "Couldn't load the report controls."));
    return () => { live = false; };
    // Deliberately once: after this the controls belong to the reader, and a URL that kept
    // overriding them would fight the person using it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback((s: ReportSelection, pickedSecs: string[], pickedItems: string[]) => {
    const mine = ++run.current;
    setShown(s); setShownSecs(pickedSecs); setShownItems(pickedItems);
    setS1({}); setS2({}); setS3({}); setS4({}); setS5({});
    const on = (id: string) => pickedSecs.includes(id);
    const go = <T,>(id: string, f: (s: ReportSelection) => Promise<T>, set: (v: Loaded<T>) => void) => {
      if (!on(id)) return;
      f(s)
        .then((d) => { if (run.current === mine) set({ data: d }); })
        .catch((e) => {
          if (run.current !== mine) return;
          set({ error: e instanceof ApiError ? e.message : "This section didn't load." });
        });
    };
    go("1", fetchReportSection1, setS1);
    go("4", fetchReportSection2, setS2);
    go("2", fetchReportSection3, setS3);
    go("3", fetchReportSection4, setS4);
    go("5", fetchReportSection5, setS5);
  }, []);

  async function generate() {
    if (!sel) return;
    setSaving(true);
    setCopied(false);
    try {
      const { rid: id } = await saveReportSnapshot(sel, secs, items);
      setRid(id);
      setSavedSig(signature(sel, secs, items));
      setParams({ r: id });
    } catch {
      // The report is still worth showing when only the SAVE failed — the figures do not
      // come from the snapshot, they come from the rows. The link just will not survive.
      setRid(null);
      setSavedSig(null);
    } finally {
      setSaving(false);
    }
    load(sel, secs, items);
  }

  /**
   * Start the workbook and wait for it.
   *
   * It exports THE PERIOD ON SCREEN, not the one that was last generated — the rows do not
   * come from the snapshot, so there is nothing to be out of step with, and a reader who
   * has just changed the period means the one they can see.
   *
   * A 503 here is a real state rather than a bug: a deployment with no dispatch token
   * records the job and never starts it. Saying so beats a spinner that never ends.
   */
  async function exportData() {
    if (!sel || exporting) return;
    setExportError(null);
    setExported(null);
    try {
      const { job } = await requestReportExport(sel, rid);
      setExporting(job);
      const done = await awaitJob(job.id, setExporting, { everyMs: 2000, timeoutMs: 300_000 });
      setExporting(done);
      if (done?.status === "done" && done.result?.url) {
        setExported(done.result as unknown as ReportExportResult);
      } else if (done?.status === "failed") {
        setExportError(done.message || "The export failed.");
      } else if (done && done.status !== "done") {
        setExportError("The export is taking longer than expected. It may still finish — try again in a minute.");
      }
    } catch (e) {
      setExporting(null);
      // The server says why a 503 happened — no dispatch token, or a refused dispatch —
      // and those call for different things from the reader, so its message wins.
      setExportError(e instanceof ApiError ? e.message : "Couldn't start the export.");
    }
  }

  if (boot) return <EmptyState title="The report is unavailable">{boot}</EmptyState>;
  if (!snap || !sel) return <Spinner label="Loading the report controls…" />;

  const o = snap.options;
  const yearUsed = ["This year", "Year to date", "Specific month"].includes(sel.period);
  const changed = savedSig !== null && savedSig !== signature(sel, secs, items);
  const generated = shown !== null;
  const on = (id: string) => shownSecs.includes(id);
  const show = (key: string) => shownItems.includes(key);
  const link = rid ? `${window.location.origin}${window.location.pathname}?r=${rid}` : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Business Development and Resource Mobilization Report"
        lead="Pick a period, then generate. The report is saved under a short link that survives a refresh."
      />

      {snap.missing && (
        <Notice tone="warn">
          Report <code className="font-mono">{snap.rid}</code> wasn't found. Only the 100 most
          recent reports are kept, and they are shared across every team on this deployment,
          so an older link can age out. Choose a period below and generate a fresh one.
        </Notice>
      )}

      {/* ── The controls ───────────────────────────────────────────────── */}
      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="rp-period" label="Period" hint="The window every figure on the page uses.">
            <Select id="rp-period" value={sel.period}
              onChange={(e) => setSel({ ...sel, period: e.target.value })}>
              {o.periods.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
          </Field>
          <Field id="rp-year" label="Year">
            <Select id="rp-year" value={String(sel.year)} disabled={!yearUsed}
              onChange={(e) => setSel({ ...sel, year: Number(e.target.value) })}>
              {Array.from({ length: o.yearMax - o.yearMin + 1 }, (_, i) => o.yearMin + i)
                .map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
          </Field>
          <Field id="rp-month" label="Month" hint={sel.period === "Specific month" ? undefined : "Only used for a specific month."}>
            <Select id="rp-month" value={sel.month} disabled={sel.period !== "Specific month"}
              onChange={(e) => setSel({ ...sel, month: e.target.value })}>
              {o.months.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </Field>
          <Field id="rp-view" label="View by" hint="How time-series charts are bucketed.">
            <Select id="rp-view" value={sel.view}
              onChange={(e) => setSel({ ...sel, view: e.target.value })}>
              {o.views.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-ink-100 pt-3">
          <Button variant="primary" onClick={generate} disabled={saving}>
            <Play size={15} aria-hidden /> {saving ? "Generating…" : "Generate report"}
          </Button>
          <Button variant="secondary" onClick={() => setFilterOpen((v) => !v)}
            aria-expanded={filterOpen} aria-controls="rp-filter">
            <SlidersHorizontal size={15} aria-hidden /> Sections & metrics
            <span className="ml-1 rounded bg-ink-100 px-1.5 text-xs tabular-nums text-ink-600">
              {secs.length}/{snap.catalog.allSecIds.length} · {items.length}/{snap.catalog.allKeys.length}
            </span>
          </Button>
          {link && (
            <Button variant="ghost" onClick={() => {
              navigator.clipboard?.writeText(link).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              }).catch(() => undefined);
            }}>
              {copied ? <Check size={15} aria-hidden /> : <Link2 size={15} aria-hidden />}
              {copied ? "Link copied" : "Copy link"}
            </Button>
          )}
          <Button variant="ghost" onClick={exportData}
            disabled={!!exporting && !["done", "failed", "cancelled"].includes(exporting.status)}>
            <Download size={15} aria-hidden />
            {exporting && !["done", "failed", "cancelled"].includes(exporting.status)
              ? (exporting.progress?.message || JOB_STATUS_LABEL[exporting.status])
              : "Export data"}
          </Button>
          <span className="ml-auto text-xs text-ink-500">
            {snap.phrase}
            {changed && (
              <span className="ml-2 font-semibold text-gold-700">
                · Selections changed — generate to save them under a fresh link
              </span>
            )}
          </span>
        </div>

        {filterOpen && (
          <div id="rp-filter" className="mt-4 space-y-4 border-t border-ink-100 pt-4">
            <p className="text-xs text-ink-500">
              Everything is on by default, so generating without touching this gives the full
              report. Untick a whole section to leave it out, or single metrics within one.
            </p>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {snap.catalog.sections.map((s) => {
                const secOn = secs.includes(s.id);
                return (
                  <div key={s.id} className={`rounded-lg border p-3 ${secOn ? "border-ink-200" : "border-ink-100 bg-ink-50"}`}>
                    <label className="flex items-center gap-2 text-sm font-semibold text-brand-700">
                      <input type="checkbox" checked={secOn} className="size-4 accent-accent-600"
                        onChange={(e) => setSecs(e.target.checked
                          ? [...secs, s.id] : secs.filter((x) => x !== s.id))} />
                      {s.label}
                    </label>
                    <ul className="mt-2 space-y-1.5">
                      {s.items.map((it) => (
                        <li key={it.key}>
                          <label className={`flex items-center gap-2 text-sm ${secOn ? "text-ink-700" : "text-ink-400"}`}>
                            <input type="checkbox" checked={items.includes(it.key)} disabled={!secOn}
                              className="size-4 accent-accent-600"
                              onChange={(e) => setItems(e.target.checked
                                ? [...items, it.key] : items.filter((x) => x !== it.key))} />
                            {it.label}
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => {
                setSecs([...snap.catalog.allSecIds]); setItems([...snap.catalog.allKeys]);
              }}>Everything</Button>
              <Button variant="ghost" onClick={() => { setSecs([]); setItems([]); }}>Nothing</Button>
            </div>
          </div>
        )}
      </Card>

      {exportError && <Notice tone="bad">{exportError}</Notice>}
      {exported && (
        <Notice tone="good" icon={<Download size={16} aria-hidden />}>
          <strong>{exported.filename}</strong> is ready —{" "}
          {Object.entries(exported.sheets).map(([name, n], i, a) => (
            <span key={name}>
              {name} ({n.toLocaleString("en-US")}){i < a.length - 1 ? ", " : ""}
            </span>
          ))}
          .{" "}
          <a href={exported.url} download={exported.filename}
            className="font-semibold text-accent-700 underline hover:text-accent-800">Download</a>
          {" "}— the link expires in {Math.round(exported.expiresInS / 60)} minutes, so it is
          not worth pasting anywhere.
        </Notice>
      )}

      {/* ── The report ─────────────────────────────────────────────────── */}
      {!generated ? (
        <EmptyState icon={<BarChart3 size={28} aria-hidden />} title="Nothing is loaded yet">
          Pick your period and view above, narrow the sections if you want to, then press
          <strong> Generate report</strong>. The page opens instantly because nothing is read
          until you do — and the report you generate is saved under a short link you can share.
        </EmptyState>
      ) : (
        <div className="space-y-8">
          {shownSecs.length === 0 && (
            <EmptyState title="Every section is switched off">
              Open <strong>Sections &amp; metrics</strong> and tick at least one, then generate again.
            </EmptyState>
          )}
          <Block on={on("1")} slot={s1} name="Scan activity">
            {(d) => <Section1 d={d} show={show} />}
          </Block>
          <Block on={on("4")} slot={s2} name="Team &amp; partners">
            {(d) => <Section2 d={d} show={show} />}
          </Block>
          <Block on={on("2")} slot={s3} name="Status &amp; eligibility funnel">
            {(d) => <Section3 d={d} show={show} />}
          </Block>
          <Block on={on("3")} slot={s4} name="Reviews &amp; decisions">
            {(d) => <Section4 d={d} show={show} />}
          </Block>
          <Block on={on("5")} slot={s5} name="Our results">
            {(d) => <Section5 d={d} show={show} />}
          </Block>
        </div>
      )}
    </div>
  );
}

/**
 * One section's slot: its spinner, its error, or its content.
 *
 * A section that fails says so where it would have been, and the other four still render —
 * five sections behind one error message would lose a whole report to a single slow query.
 */
function Block<T>({ on, slot, name, children }: {
  on: boolean; slot: Loaded<T>; name: string; children: (d: T) => React.ReactNode;
}) {
  if (!on) return null;
  if (slot.error) {
    return (
      <Notice tone="bad">
        <strong>{name}</strong> didn't load. {slot.error}
      </Notice>
    );
  }
  if (!slot.data) return <Spinner label={`Loading ${name.replace(/&amp;/g, "&").toLowerCase()}…`} />;
  return <>{children(slot.data)}</>;
}
