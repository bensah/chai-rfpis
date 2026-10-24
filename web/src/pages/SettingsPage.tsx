/**
 * Settings (app_pages/admin.py). Phase 0 builds the tab structure and two pieces:
 * Accounts → Active tenant (render_active_tenant) and, for the super_user, a test of the
 * background-job loop under Accounts → Deployment. Every other tab links to the classic app
 * until its phase lands.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { startJob, switchTenant, type Job, type User } from "../api";
import { JOB_STATUS_LABEL, useJob } from "../jobs";
import ClassicPage from "./ClassicPage";

const isSuper = (u: User) => u.role === "super_user";

function Tabs({ tabs, active, onPick }: { tabs: string[]; active: string; onPick: (t: string) => void }) {
  return (
    <div role="tablist" className="mb-5 flex flex-wrap gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t} role="tab" aria-selected={t === active} onClick={() => onPick(t)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${t === active ? "border-brand font-semibold text-brand-dark" : "border-transparent text-slate-600 hover:text-slate-900"}`}
        >
          {t}
        </button>
      ))}
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
    <section className="pt-4">
      <h1 className="mb-4 text-3xl font-bold text-navy">⚙️ Settings</h1>
      <Tabs tabs={tabs} active={tab} onPick={setTab} />
      {tab !== "Accounts" ? (
        <ClassicPage page="settings" classicUrl={classicUrl} />
      ) : (
        <>
          <Tabs tabs={acctTabs} active={acct} onPick={setAcct} />
          {acct === "Active tenant" && <ActiveTenant user={user} />}
          {acct === "Deployment" && <JobTest />}
          {acct !== "Active tenant" && <ClassicPage page="settings" classicUrl={classicUrl} />}
        </>
      )}
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
    <div className="max-w-2xl">
      <h2 className="mb-2 text-xl font-semibold">Active tenant</h2>
      {!mems.length ? (
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900">You don't belong to any tenant yet.</p>
      ) : mems.length === 1 ? (
        <p>You belong to one tenant: <strong>{label(mems[0])}</strong>. It is selected automatically when you sign in.</p>
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-500">
            You belong to more than one tenant. Switching scopes every page to the selected tenant, and your choice is
            remembered across sign-ins.
          </p>
          <div className="flex gap-2">
            <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Tenant"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2">
              {mems.map((m) => <option key={m.id} value={m.id}>{label(m)}</option>)}
            </select>
            <button
              disabled={pick === cur || busy}
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
              className="rounded-lg bg-brand px-4 py-2 font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
            >
              Switch
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
        </>
      )}
    </div>
  );
}

/** Proves the background-job loop: queue → GitHub Actions (or the local runner) → back. */
function JobTest() {
  const [started, setStarted] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useJob(started);
  const running = !!job && !["done", "failed", "cancelled"].includes(job.status);
  return (
    <div className="mb-6 max-w-2xl rounded-xl border border-slate-200 p-5">
      <h2 className="text-lg font-semibold">Background jobs</h2>
      <p className="mt-1 text-sm text-slate-500">
        Heavy work (scans, PDF reports, backups) runs on GitHub Actions. This runs an empty test job to check the
        connection end to end.
      </p>
      <button
        disabled={running}
        onClick={async () => {
          setError(null);
          try {
            setStarted(await startJob("ping"));
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not start the job.");
          }
        }}
        className="mt-3 flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-60"
      >
        {running && <Loader2 className="h-4 w-4 animate-spin" />} Run a test job
      </button>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      {job && (
        <div className="mt-3 text-sm">
          <div><strong>{JOB_STATUS_LABEL[job.status]}</strong>{job.progress?.message ? ` · ${job.progress.message}` : ""}</div>
          {job.status === "done" && <div className="text-slate-600">Runner: {String(job.result?.runner ?? "?")}</div>}
          {job.status === "failed" && job.message && <div className="text-red-700">{job.message}</div>}
          {job.run_url && <a href={job.run_url} target="_blank" rel="noreferrer" className="text-brand hover:underline">Open the Actions run</a>}
        </div>
      )}
    </div>
  );
}
