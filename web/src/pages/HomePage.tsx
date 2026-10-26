/**
 * Home — a port of app_pages/home.py: a welcome, eight live counters, the quick-start
 * cards, the manual, and the how-to guide, with the live opportunity feed alongside.
 *
 * One thing is deliberately left behind: Streamlit syncs an Excel workbook on every Home
 * load, shelling out to a migration script. That belongs in a background job, not in a page
 * view (see docs/FRONTEND_MIGRATION.md), so it is not here.
 */
import { useEffect, useState } from "react";
import { fetchHome, type HomeKpis, type User } from "../api";
import OpportunityRail from "../components/OpportunityRail";
import { hrefOf, Link, type PageKey } from "../router";

const CARDS: [PageKey, string, string, string][] = [
  ["pipelines", "📚", "Pipeline",
    "Screen, review, track and summarise every opportunity across its lifecycle."],
  ["grants", "💼", "Applied funding",
    "Grants under donor review or already awarded, with their reporting deadlines."],
  ["actions", "🗒️", "Check-ins & engagements",
    "Weekly meeting notes, donor engagement touchpoints and pending follow-ups."],
  ["report", "📊", "KPI dashboard",
    "Activity from search and reviews through to grants secured, at a glance."],
  ["organization", "🏢", "Organization",
    "Your organisation — profile, bid-fitness, eligibility, partners and team."],
];

const SETTINGS_CARD: [PageKey, string, string, string] = ["settings", "⚙️", "Settings",
  "Setup, users, data, donor sources, Excel sync, rates and manual scans."];

function Tile({ label, value, note, inverse }: {
  label: string; value: number | string; note?: string; inverse?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-[#fafcfa] px-4 py-3">
      <div className="text-xs leading-tight text-slate-600">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${inverse && Number(value) > 0 ? "text-red-700" : "text-navy"}`}>
        {value}
      </div>
      {note && <div className="mt-0.5 text-xs text-slate-500">{note}</div>}
    </div>
  );
}

export default function HomePage({ user }: { user: User }) {
  const [k, setK] = useState<HomeKpis | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchHome().then(setK).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : "Couldn't load live KPIs."));
  }, []);

  const firstName = (user.name || user.email || "there").split(" ")[0];
  const cards = user.role === "admin" || user.role === "super_user" ? [...CARDS, SETTINGS_CARD] : CARDS;
  const dash = "—";

  return (
    <div className="flex flex-col gap-6 pt-4 lg:flex-row">
      <div className="min-w-0 flex-1">
        <h1 className="text-3xl font-bold text-navy">Welcome, {firstName} 👋</h1>
        {error && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>}

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Total Unique RFPs" value={k?.total_unique ?? dash}
            note={k ? (k.duplicates ? `${k.total_found} found · ${k.duplicates} duplicate`
              : `${k.total_found} found`) : undefined} />
          <Tile label="Proceed" value={k?.proceed ?? dash} />
          <Tile label="Park" value={k?.park ?? dash} />
          <Tile label="Decline" value={k?.decline ?? dash} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Due in 14 days" value={k?.due_soon ?? dash} />
          <Tile label="Submitted" value={k?.submitted ?? dash} />
          <Tile label="Past deadline" value={k?.overdue ?? dash} inverse />
          <Tile label="Awarded Grants" value={k?.awarded_grants ?? dash} />
        </div>

        <hr className="my-7 border-slate-200" />

        <h2 className="text-xl font-semibold text-navy">Where to start</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map(([page, icon, headline, body]) => (
            <div key={page} className="rounded-xl border border-slate-200 p-4 transition hover:shadow-md">
              <Link to={hrefOf(page)} title={`Go to ${headline}`}
                className="font-semibold text-brand hover:underline">
                {icon}  {headline}
              </Link>
              <p className="mt-1.5 text-sm text-slate-600">{body}</p>
            </div>
          ))}
        </div>

        <hr className="my-7 border-slate-200" />
        <div className="rounded-xl border border-slate-200 p-4">
          <h3 className="font-semibold">📘 New to RFPIS? Start with the manual</h3>
          <p className="mt-1 text-sm text-slate-500">
            Step by step through every page, plus the slides from the team training. Both are also
            under 👤 → <strong>Help</strong>.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href="/help/RFPIS_User_Manual.pdf" download
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
              ⬇ User manual (PDF)
            </a>
            <a href="/help/RFPIS_Training_Deck.pptx" download
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
              ⬇ Training slides (PPTX)
            </a>
          </div>
        </div>

        <details className="mt-4 rounded-xl border border-slate-200 p-4">
          <summary className="cursor-pointer font-medium">📖 How to use this app</summary>
          <div className="mt-3 space-y-3 text-sm text-slate-700">
            <p><strong>Weekly rhythm</strong></p>
            <ol className="list-decimal space-y-1.5 pl-5">
              <li><strong>Friday morning</strong> — the automated scan pulls new opportunities from the
                donor sources into the shared store, the 🔔 bell shows <strong>Scan completed</strong>,
                and everyone is emailed any new Proceed / Park calls. Open <strong>Pipelines →
                Screen</strong> and click <strong>🎯 Eligibility Scan</strong> to screen against your
                organisation.</li>
              <li><strong>Friday → Sunday</strong> — anyone who finds an RFP outside the scan submits it
                via <strong>📝 Submit New Funding</strong> on the Screen tab. It is scored and tagged to
                the current review week.</li>
              <li><strong>Monday</strong> — the team call. Walk through <strong>Screen</strong>, open
                <strong> Review</strong> for each RFP and record the outcome with <strong>✏ Update
                Decision</strong>. Capture notes and agreed actions in <strong>Actions →
                Meetings</strong>, linked to the RFP.</li>
              <li><strong>Mid-week</strong> — proposal teams work the <strong>Track</strong> tab: stage,
                progress, next action, deadlines. Log donor calls in <strong>Actions →
                Engagements</strong> and close finished items in <strong>Actions → Pending</strong>.</li>
            </ol>
            <p><strong>Roles</strong></p>
            <ul className="list-disc space-y-1 pl-5">
              <li><strong>Admin</strong> — everything, plus users, scan preferences and records
                (<strong>Settings</strong>).</li>
              <li><strong>Reviewer / Contributor</strong> — screening, decisions, RFP edits,
                submissions, meeting notes and engagements; no delete, no Settings.</li>
            </ul>
          </div>
        </details>
      </div>

      <div className="w-full shrink-0 lg:w-80">
        <OpportunityRail tenantName={user.view?.name ?? user.tenant?.name} />
      </div>
    </div>
  );
}
