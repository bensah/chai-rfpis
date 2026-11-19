/**
 * Settings → Analytics — the cross-tenant platform overview. `views/super_analytics.py`.
 *
 * SUPER_USER ONLY. Every figure here crosses tenant boundaries, which is the whole reason
 * it is a separate tab with its own gate rather than a richer version of the dashboard.
 *
 * READ-ONLY, and the numbers are the Python's own: core/analytics.py's three rollups,
 * ported in api/analytics.ts and pinned by check-analytics against the live database.
 * The two counting rules that matter are stated on the page itself rather than left to a
 * reader to infer — a "system run" excludes every tenant's own screening, and scan_logs
 * holds one row per source per run, so the run count is approximate by construction.
 * Printing those totals without saying so invites them to be read as exact.
 */
import { useEffect, useState } from "react";
import { Building2, Database, Users } from "lucide-react";
import { fetchAnalytics, type PlatformAnalytics } from "../api";
import { Badge, Card, Eyebrow, Notice, Spinner } from "../ui";

const num = (n: number) => n.toLocaleString();
const day = (v: string | null) => (v ? String(v).slice(0, 10) : "—");

export default function AnalyticsTab() {
  const [data, setData] = useState<PlatformAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAnalytics().then(setData)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Couldn't load the analytics."));
  }, []);

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Spinner label="Reading the platform rollups…" />;

  const { discovery, tenants, users } = data;
  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex items-center gap-2.5">
          <Database className="h-5 w-5 text-accent-600" />
          <Eyebrow>Discovery across the deployment</Eyebrow>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="System runs" value={num(discovery.runs)} />
          <Stat label="Opportunities found" value={num(discovery.found)} />
          <Stat label="Rejected at screening" value={num(discovery.rejected)} />
          <Stat label="Shared catalogue" value={num(discovery.catalog)} />
        </div>
        <p className="mt-4 text-xs leading-relaxed text-ink-500">
          A <strong>system run</strong> is the scheduled crawl, which belongs to no
          tenant; each organisation's own screening of the same store is counted under
          that organisation, not here. The scan log holds one row per source per run, so
          the run count is distinct run <em>minutes</em> — close, not exact. Last system
          run: {day(discovery.last_run)}.
        </p>
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2.5">
          <Building2 className="h-5 w-5 text-accent-600" />
          <Eyebrow>Organisations</Eyebrow>
        </div>
        <div className="mt-4 overflow-x-auto rounded-lg border border-ink-200">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs font-semibold text-ink-600 uppercase">
              <tr>
                <th className="px-3 py-2">Organisation</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Members</th>
                <th className="px-3 py-2 text-right">Pending</th>
                <th className="px-3 py-2 text-right">Opportunities</th>
                <th className="px-3 py-2">Last screening</th>
                <th className="px-3 py-2">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {tenants.map((t) => (
                <tr key={t.id} className="hover:bg-ink-50">
                  <td className="px-3 py-2 font-medium text-ink-900">
                    {t.name ?? "—"}
                    {t.is_platform && <Badge tone="accent" className="ml-2">platform</Badge>}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={t.status === "active" ? "good"
                      : t.status === "suspended" ? "bad" : "neutral"}>
                      {t.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(t.members)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {t.pending ? num(t.pending) : <span className="text-ink-300">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(t.rfps)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-600">
                    {day(t.last_screen)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-600">{t.created || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-ink-500">
          An organisation with no last screening has never run one — the shared catalogue
          is there, but nothing has been matched against its eligibility.
        </p>
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2.5">
          <Users className="h-5 w-5 text-accent-600" />
          <Eyebrow>People</Eyebrow>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label="Accounts" value={num(users.total)} />
          <Stat label="Active" value={num(users.active)} />
          <Stat label="Inactive" value={num(users.inactive)} tone="muted" />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {Object.entries(users.by_role).sort().map(([role, count]) => (
            <Badge key={role} tone="neutral">
              {role}: {num(count)}
            </Badge>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "muted" }) {
  return (
    <div>
      <div className="text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
        {label}
      </div>
      <div className={`mt-1 text-3xl font-bold tabular-nums ${
        tone === "muted" ? "text-ink-500" : "text-brand-700"}`}>
        {value}
      </div>
    </div>
  );
}
