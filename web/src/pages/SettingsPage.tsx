/**
 * Settings (app_pages/admin.py). Phase 0 builds the tab structure and two pieces:
 * Accounts → Active tenant (render_active_tenant) and, for the super_user, a test of the
 * background-job loop under Accounts → Deployment. Every other tab links to the classic app
 * until its phase lands.
 */
import { useState } from "react";
import { CheckCircle2, ExternalLink, PlayCircle, Settings as SettingsIcon } from "lucide-react";
import { startJob, switchTenant, type Job, type User } from "../api";
import { JOB_STATUS_LABEL, useJob } from "../jobs";
import ClassicPage from "./ClassicPage";
import { Badge, Button, Card, Eyebrow, Notice, PageHeader, Select } from "../ui";

const isSuper = (u: User) => u.role === "super_user";

/** The top level reads as a segmented control; the second as quieter pills inside it. */
function Tabs({ tabs, active, onPick, variant = "solid" }: {
  tabs: string[]; active: string; onPick: (t: string) => void; variant?: "solid" | "quiet";
}) {
  return (
    <div
      role="tablist"
      className={`flex flex-wrap gap-1 ${variant === "solid" ? "rounded-xl border border-ink-200 bg-white p-1 shadow-card" : ""}`}
    >
      {tabs.map((t) => {
        const on = t === active;
        return (
          <button
            key={t} role="tab" aria-selected={on} onClick={() => onPick(t)}
            className={`rounded-lg px-3.5 py-1.5 text-sm transition-colors ${
              on
                ? variant === "solid"
                  ? "bg-brand-700 font-semibold text-white"
                  : "bg-brand-50 font-semibold text-brand-700"
                : "text-ink-600 hover:bg-ink-100 hover:text-ink-900"
            }`}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}

export default function SettingsPage({ user, classicUrl }: { user: User; classicUrl: string | null }) {
  const dev = !!user.homeIsDeveloper;
  const devSuper = isSuper(user) && dev;
  // admin.py's tab list and order.
  const tabs = ["Setup", "Accounts", "Records", ...(dev ? ["Sources"] : []), "Manual Scan",
    ...(dev ? ["Learning data"] : []), ...(devSuper ? ["Suggestions"] : []), ...(isSuper(user) ? ["Analytics"] : [])];
  const [tab, setTab] = useState("Accounts");
  const acctTabs = [...(isSuper(user) ? [] : ["Active tenant"]), "Users", "Tenants", "Blacklisted",
    ...(isSuper(user) ? ["Deployment"] : [])];
  const [acct, setAcct] = useState(acctTabs[0]);

  return (
    <section>
      <PageHeader
        title={<span className="flex items-center gap-2.5"><SettingsIcon className="h-6 w-6 text-accent-600" strokeWidth={1.9} /> Settings</span>}
        lead="Accounts, tenants, records and the scan — everything an administrator controls."
      />
      <Tabs tabs={tabs} active={tab} onPick={setTab} />
      <div className="mt-6">
        {tab !== "Accounts" ? (
          <ClassicPage page="settings" classicUrl={classicUrl} />
        ) : (
          <>
            <Tabs tabs={acctTabs} active={acct} onPick={setAcct} variant="quiet" />
            {/* Deployment shows the job test and, under it, the classic link for env_diag. */}
            <div className="mt-5 space-y-6">
              {acct === "Active tenant" && <ActiveTenant user={user} />}
              {acct === "Deployment" && <JobTest />}
              {acct !== "Active tenant" && <ClassicPage page="settings" classicUrl={classicUrl} />}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/** account_sections.render_active_tenant (non-super members). */
function ActiveTenant({ user }: { user: User }) {
  const mems = user.memberships ?? [];
  const cur = user.tenant?.id ?? "";
  const [pick, setPick] = useState(mems.some((m) => m.id === cur) ? cur : mems[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (m: (typeof mems)[number]) => m.name || m.slug || "tenant";

  return (
    <Card className="max-w-2xl p-6">
      <Eyebrow>Active tenant</Eyebrow>
      {!mems.length ? (
        <Notice tone="brand">You don't belong to any tenant yet.</Notice>
      ) : mems.length === 1 ? (
        <p className="text-sm text-ink-700">
          You belong to one tenant, <strong className="text-brand-700">{label(mems[0])}</strong>. It is selected
          automatically when you sign in.
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm leading-relaxed text-ink-600">
            You belong to more than one tenant. Switching scopes every page to the selected tenant, and your choice is
            remembered across sign-ins.
          </p>
          <div className="flex flex-wrap gap-2">
            <Select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Tenant" className="min-w-0 flex-1">
              {mems.map((m) => <option key={m.id} value={m.id}>{label(m)}</option>)}
            </Select>
            <Button
              variant="primary" busy={busy} disabled={pick === cur}
              title={pick === cur ? "This is already your active tenant." : undefined}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await switchTenant(pick);
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Could not switch tenant.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Switch
            </Button>
          </div>
          {error && <Notice tone="bad" className="mt-3">{error}</Notice>}
        </>
      )}
    </Card>
  );
}

/** Proves the background-job loop: queue → GitHub Actions (or the local runner) → back. */
function JobTest() {
  const [started, setStarted] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useJob(started);
  const running = !!job && !["done", "failed", "cancelled"].includes(job.status);
  return (
    <Card className="max-w-2xl p-6">
      <Eyebrow>Background jobs</Eyebrow>
      <p className="text-sm leading-relaxed text-ink-600">
        Heavy work — scans, PDF reports, backups — runs on GitHub Actions rather than in the page. This runs an
        empty test job to check the connection end to end.
      </p>
      <Button
        busy={running} className="mt-4" icon={<PlayCircle className="h-4 w-4" />}
        onClick={async () => {
          setError(null);
          try {
            setStarted(await startJob("ping"));
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not start the job.");
          }
        }}
      >
        Run a test job
      </Button>
      {error && <Notice tone="bad" className="mt-3">{error}</Notice>}
      {job && (
        <div className="mt-4 rounded-lg border border-ink-200 bg-ink-50 p-3.5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={job.status === "done" ? "good" : job.status === "failed" ? "bad" : "accent"}>
              {job.status === "done" && <CheckCircle2 className="h-3 w-3" />}
              {JOB_STATUS_LABEL[job.status]}
            </Badge>
            {job.progress?.message && <span className="text-ink-600">{job.progress.message}</span>}
          </div>
          {job.status === "done" && <div className="mt-2 text-ink-600">Runner: {String(job.result?.runner ?? "?")}</div>}
          {job.status === "failed" && job.message && <div className="mt-2 text-bad-700">{job.message}</div>}
          {job.run_url && (
            <a
              href={job.run_url} target="_blank" rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-accent-700 hover:underline"
            >
              Open the Actions run <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      )}
    </Card>
  );
}
