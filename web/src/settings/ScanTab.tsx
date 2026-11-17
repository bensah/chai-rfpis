/**
 * Settings → Manual Scan. `app_pages/admin.py`, the four sub-tabs.
 *
 * ALL THREE BUTTONS START JOBS, and that is the architectural point rather than a
 * convenience. Streamlit runs this work in the request: an eligibility screen walks the
 * global store through `core/scan_pipeline`, and an extraction crawls every catalogued
 * source for 25-40 minutes. Neither can happen inside an Edge Function — not because of
 * the time, but because that engine is Python, and re-implementing it is the one thing
 * this whole port exists to avoid. So the browser queues, GitHub Actions runs the repo's
 * own code, and the job row is the channel back.
 *
 * The job kinds landed with this page (`scan_screen`, `scan_extract`, `excel_sync` in
 * scripts/run_web_job.py); before them these buttons had nothing to call.
 *
 * WHO SEES WHAT, mirroring the Streamlit gates exactly:
 *
 *   Extraction      developer-tenant admins only. It writes the SHARED store every
 *                   tenant screens against, so one organisation's admin starting a
 *                   platform-wide crawl is the thing being prevented. The tab is hidden
 *                   rather than disabled — a control you may never use is noise, and the
 *                   Streamlit page hides it for the same reason.
 *   Eligibility     any admin. It screens the shared store against THIS organisation.
 *   Excel Sync      any admin, and only when a workbook is configured.
 *   Search          not a job at all: the search page already exists, and sending people
 *                   there keeps one search UI, one ranking and one place feedback lands.
 *
 * WHAT IS NOT HERE: the run-history panel. `_run_summary` in admin.py aggregates
 * `scan_logs` by `run_id`, with a timestamp-gap fallback for rows written before
 * migration 065 — its own piece of work, and the classic page still shows it. What this
 * page reports is the run IT started, from the job's own result.
 */
import { useState } from "react";
import {
  AlertTriangle, CheckCircle2, ExternalLink, FileSpreadsheet, PlayCircle, Radar, Search,
  Target,
} from "lucide-react";
import { startJob, type Job, type User } from "../api";
import { JOB_STATUS_LABEL, useJob } from "../jobs";
import { hrefOf } from "../router";
import { Badge, Button, Card, Eyebrow, LinkButton, Notice } from "../ui";

const FINAL = new Set(["done", "failed", "cancelled"]);

export default function ScanTab({ user }: { user: User }) {
  const dev = !!user.homeIsDeveloper;
  const tabs = [...(dev ? ["Extraction"] : []), "Eligibility Scan", "Search", "Excel Sync"];
  const [tab, setTab] = useState(tabs[dev ? 1 : 0]);

  return (
    <div>
      <div role="tablist" className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button
            key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)}
            className={`rounded-lg px-3.5 py-1.5 text-sm transition-colors ${
              t === tab ? "bg-brand-50 font-semibold text-brand-700"
                : "text-ink-600 hover:bg-ink-100 hover:text-ink-900"}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {tab === "Extraction" && (
          <Runner
            kind="scan_extract"
            icon={<Radar className="h-5 w-5 text-accent-600" />}
            title="Run extraction"
            button="Run extraction"
            lead="Crawls every catalogued funding source — detail pages, PDFs and LLM
              enrichment — and extracts opportunities into the shared global store. No
              screening against any organisation happens here."
            notes={[
              "This is the slow one: 25 to 40 minutes. It refreshes the store that the "
              + "Eligibility Scan then screens against.",
              "It writes the store EVERY tenant uses, which is why it is limited to a "
              + "developer tenant. Running it twice at once is prevented — a second "
              + "press joins the run already in flight.",
            ]}
            tone="warn"
          />
        )}

        {tab === "Eligibility Scan" && (
          <Runner
            kind="scan_screen"
            icon={<Target className="h-5 w-5 text-accent-600" />}
            title="Eligibility scan"
            button="Select eligible funding"
            lead="Screens the curated funding store against this organisation's
              eligibility — the geography gate and the nine MUST/PREFER criteria, from
              Settings → Setup → Scan preferences. Fast: no crawl."
            notes={[
              "It reads the store as it stands. If the store is stale, the answer is "
              + "stale with it — the store is refreshed by extraction, which is a "
              + "separate job.",
              "Opportunities it finds eligible land in this organisation's pipeline, "
              + "where the Screen tab picks them up.",
            ]}
          />
        )}

        {tab === "Search" && (
          <Card className="max-w-3xl p-6">
            <Eyebrow>Search</Eyebrow>
            <p className="mt-1 text-sm leading-relaxed text-ink-600">
              Searching across stored opportunities, donors, the app's own pages and the
              web already has a page, reachable from the header. It is not duplicated
              here on purpose: one search means one relevance ranking and one place where
              feedback on a result is recorded.
            </p>
            <LinkButton href={hrefOf("search")} variant="primary" className="mt-4"
              icon={<Search className="h-4 w-4" />}>
              Open search
            </LinkButton>
          </Card>
        )}

        {tab === "Excel Sync" && (
          <Runner
            kind="excel_sync"
            icon={<FileSpreadsheet className="h-5 w-5 text-accent-600" />}
            title="Excel sync"
            button="Import the workbook"
            lead="Imports the master Excel workbook into THIS organisation's pipeline.
              Every imported row is stamped with your organisation, so it lands in your
              pipeline rather than as an unowned row."
            notes={[
              "Auxiliary tables are matched on external_id, a stable hash of each row's "
              + "natural key: a re-sync overwrites the Excel-managed columns and leaves "
              + "the app-managed ones alone.",
              "If no workbook is configured for this deployment, the job says so rather "
              + "than failing — nothing is written either way.",
            ]}
          />
        )}
      </div>
    </div>
  );
}

/**
 * One button, one job, and the run reported honestly.
 *
 * The job's own `summary` is what is shown on success, composed in the runner so both
 * apps describe the same run in the same words rather than each phrasing the numbers its
 * own way. A result carrying `ok: false` — a timed-out crawl, a missing workbook — is
 * shown as a warning, not a tick: in both cases the work did not fully happen, and in
 * both cases nothing is broken.
 */
function Runner({ kind, icon, title, button, lead, notes, tone = "brand" }: {
  kind: string; icon: React.ReactNode; title: string; button: string;
  lead: string; notes: string[]; tone?: "brand" | "warn";
}) {
  const [started, setStarted] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useJob(started);
  const running = !!job && !FINAL.has(job.status);
  const result = (job?.result ?? {}) as Record<string, unknown>;
  const summary = typeof result.summary === "string" ? result.summary : "";
  const incomplete = job?.status === "done" && result.ok === false;

  return (
    <Card className="max-w-3xl p-6">
      <div className="flex items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-brand-700">{title}</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-600">{lead}</p>
        </div>
      </div>

      <ul className="mt-4 space-y-1.5">
        {notes.map((n) => (
          <li key={n} className="flex gap-2 text-sm text-ink-600">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-300" />
            <span>{n}</span>
          </li>
        ))}
      </ul>

      {tone === "warn" && (
        <Notice tone="warn" className="mt-4" icon={<AlertTriangle className="h-4 w-4" />}>
          This affects every organisation on the deployment, not only yours.
        </Notice>
      )}

      <Button
        variant="primary" className="mt-5" busy={running}
        icon={<PlayCircle className="h-4 w-4" />}
        onClick={async () => {
          setError(null);
          try {
            setStarted(await startJob(kind));
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not start the job.");
          }
        }}
      >
        {button}
      </Button>
      {error && <Notice tone="bad" className="mt-3">{error}</Notice>}

      {job && (
        <div className="mt-4 rounded-lg border border-ink-200 bg-ink-50 p-3.5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={job.status === "done" ? (incomplete ? "warn" : "good")
              : job.status === "failed" ? "bad" : "accent"}>
              {job.status === "done" && !incomplete && <CheckCircle2 className="h-3 w-3" />}
              {JOB_STATUS_LABEL[job.status]}
            </Badge>
            {job.progress?.message && (
              <span className="text-ink-600">{job.progress.message}</span>
            )}
          </div>
          {summary && (
            <p className={`mt-2 ${incomplete ? "text-warn-800" : "text-ink-700"}`}>
              {summary}
            </p>
          )}
          {job.status === "failed" && job.message && (
            <p className="mt-2 whitespace-pre-wrap text-bad-700">{job.message}</p>
          )}
          {job.run_url && (
            <a
              href={job.run_url} target="_blank" rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-accent-700 hover:underline"
            >
              Open the Actions run <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          {running && (
            <p className="mt-2 text-xs text-ink-500">
              You can leave this page — the job keeps running, and the result is on the
              row when you come back.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
