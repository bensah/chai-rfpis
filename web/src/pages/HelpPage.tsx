/**
 * Help — `app_pages/help.py`.
 *
 * IT DESCRIBES THIS APP, NOT THE ONE IT WAS PORTED FROM, and that is the only interesting
 * decision on the page. The Streamlit copy names "Home", "Pipelines", "Grants" and
 * "Actions", and says Actions has four tabs and Pipelines four. None of that is true here:
 * the rail was renamed on 2026-11-16 (Pipeline, Applications, Meetings, Performance,
 * Donors), Meetings is three tabs since Pending moved inside it, and the Pipeline is five
 * stages rather than four tabs. A help page that names controls a reader cannot find is
 * worse than no help page — it teaches them the app is broken.
 *
 * So the STRUCTURE and the explanations are carried over, and every name, count and route
 * is this app's. Where the two apps genuinely differ, this says so rather than papering
 * over it.
 *
 * NO ROUTE AND NO PARITY CHECK. The page computes nothing: the only live values are the
 * reader's own name, role and organisation, which the shell already carries, and the admin
 * contact address, which travels with it. There is nothing here for a check to compare.
 */
import {
  BarChart3, Briefcase, Building2, Compass, Layers, LayoutDashboard, Mail, Map,
  NotebookPen, Scale, Search, Settings as SettingsIcon, UserRound, Workflow,
} from "lucide-react";
import { Badge, Card, Notice, PageHeader } from "../ui";
import { hrefOf, Link } from "../router";
import type { Shell, User } from "../api";

const isAdmin = (u: User) => u.role === "admin" || u.role === "super_user";
const isSuper = (u: User) => u.role === "super_user";

function Block({ icon, title, children }: {
  icon: React.ReactNode; title: string; children: React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <h2 className="mb-2.5 flex items-center gap-2 text-sm font-bold text-brand-700">
        {icon} {title}
      </h2>
      <div className="space-y-2 text-sm leading-relaxed text-ink-700">{children}</div>
    </Card>
  );
}

/** One numbered step of the opportunity flow. */
function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand-700">
        {n}
      </span>
      <span>
        <strong className="text-ink-800">{title}</strong>
        <span className="block text-ink-600">{children}</span>
      </span>
    </li>
  );
}

export default function HelpPage({ user, shell }: { user: User; shell: Shell | null }) {
  const admin = isAdmin(user);
  const sup = isSuper(user);
  // An UNCONFIGURED deployment gets words, not a dead address. The server sends the
  // same placeholder both apps use, and says it is a placeholder; printing it here would
  // invite somebody to email admin@example.org and hear nothing back.
  const configured = shell?.adminContactConfigured !== false && !!shell?.adminContactEmail;
  const contact = configured
    ? (shell?.adminContactEmail as string) : "your administrator";
  const org = user.view?.name ?? user.tenant?.name ?? "your organization";
  const mailto = configured && contact.includes("@") ? `mailto:${contact}` : undefined;
  const Contact = () => mailto
    ? <a href={mailto} className="font-semibold text-accent-700 underline hover:text-accent-800">{contact}</a>
    : <strong>{contact}</strong>;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="Help & navigation guide"
        lead="RFPIS discovers funding opportunities — RFPs, RFIs, EOIs, calls for proposals,
              grand challenges — from donor sites and the web, screens each against your
              eligibility rules, and helps the team decide Proceed / Park / Decline, all in
              one place." />

      <div className="flex flex-wrap gap-2">
        <Badge tone="brand">{user.name || user.email}</Badge>
        <Badge>Role · {user.role}</Badge>
        <Badge>Org · {org}</Badge>
      </div>
      <p className="text-sm text-ink-500">
        Anything this guide doesn't answer? Ask an administrator — <Contact />.
      </p>

      <Block icon={<Compass size={15} aria-hidden />} title="Getting around">
        <p>There are two navigation zones:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Left sidebar</strong> — your everyday work pages. It collapses to an
            icon rail and expands back to labels; your role shows at the foot, with the
            account menu.
          </li>
          <li>
            <strong>Top bar</strong> — search, notifications, and the account menu
            (Profile, Help{admin ? ", Settings" : ""}, Sign Out).
          </li>
        </ul>
        <p>Most pages carry tabs or stages along the top — that's where the detail lives.</p>
      </Block>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Block icon={<LayoutDashboard size={15} aria-hidden />} title="The pages">
          <ul className="space-y-1.5">
            <li><Link to={hrefOf("home")} className="font-semibold text-accent-700 hover:underline">Dashboard</Link>
              {" "}— what needs attention, recent activity, and every figure clickable
              through to the calls behind it.</li>
            <li><Link to={hrefOf("pipelines")} className="font-semibold text-accent-700 hover:underline">Pipeline</Link>
              {" "}— the journey in five stages: Screened → Review → Bidding → Submitted →
              Outcome. A call is in a stage because of its own columns, not because
              somebody filed it there.</li>
            <li><Link to={hrefOf("grants")} className="font-semibold text-accent-700 hover:underline">Applications</Link>
              {" "}— every bid ever sent to a funder, approved and declined alike, with the
              per-funder breakdown. Filter it by window and year at the top.</li>
            <li><Link to={hrefOf("actions")} className="font-semibold text-accent-700 hover:underline">Meetings</Link>
              {" "}— three tabs: Meetings (the weekly call, its rota, what's still open and
              the notes), Engagements (donor touchpoints), Schedule (the rota itself).</li>
            <li><Link to={hrefOf("report")} className="font-semibold text-accent-700 hover:underline">Performance</Link>
              {" "}— the Business Development and Resource Mobilization Report: five
              sections of figures over a period you choose, exportable.</li>
            <li><Link to={hrefOf("donors")} className="font-semibold text-accent-700 hover:underline">Donors</Link>
              {" "}— the funder catalogue: focus areas, award ranges, requirements and
              contacts. Eligibility screening reads it.</li>
            <li><Link to={hrefOf("organization")} className="font-semibold text-accent-700 hover:underline">My Organization</Link>
              {" "}— what the matching engine believes about you, and how much of it is
              still missing.</li>
            <li><Link to={hrefOf("submit-new-rfp")} className="font-semibold text-accent-700 hover:underline">Submit New Notice</Link>
              {" "}— capture a call you found outside the scan.</li>
          </ul>
        </Block>

        <Block icon={<Search size={15} aria-hidden />} title="Search, alerts and your account">
          <ul className="space-y-1.5">
            <li><strong>Search</strong> — a keyword finds matching pages and tabs,
              opportunities and donors. It can also search the <em>web</em> for live,
              filtered funding calls; that runs as a background job and takes about half a
              minute, because it fans one keyword into several searches and filters the
              results against your rules.</li>
            <li><strong>Alerts</strong> — your organization's activity feed: when scans
              ran, what's next, and newly found opportunities.</li>
            <li><strong>Profile</strong> — your contact details, your password, and the
              last twelve sign-ins with the device and address each came from.</li>
          </ul>
        </Block>
      </div>

      <Block icon={<Workflow size={15} aria-hidden />} title="How an opportunity flows">
        <ol className="space-y-2.5">
          <Step n={1} title="Discovered">
            The scan or a manual submission lands it in <strong>Screened</strong>.
          </Step>
          <Step n={2} title="Screened">
            Auto-scoring tags eligibility (MUST 1–5 / PREFER 6–9) and proposes a decision.
          </Step>
          <Step n={3} title="Reviewed">
            On <strong>Review</strong>, the team confirms or overrides — Proceed, Park or
            Decline. A human who has read the call outranks the derivation.
          </Step>
          <Step n={4} title="Bidding, then Submitted">
            A Proceed gets an owner and deadlines, and moves on when it goes to the funder.
          </Step>
          <Step n={5} title="Outcome">
            The funder answers. Everything ever sent also shows on{" "}
            <Link to={hrefOf("grants")} className="font-semibold text-accent-700 hover:underline">Applications</Link>,
            pending ones included — which is why its win rate and the Outcome stage's
            differ, and both are right.
          </Step>
        </ol>
        <Notice tone="neutral" className="mt-3">
          Funding calls are a <strong>shared, platform-wide pool</strong>. Every
          organization's eligibility scan screens the whole pool against its own
          preferences, so a call surfaces wherever it fits — and an opportunity submitted
          by any user joins that pool, becoming available to everyone on their next scan.
        </Notice>
      </Block>

      <Block icon={<Scale size={15} aria-hidden />} title="How an opportunity is scored">
        <p>
          Every opportunity is read against <strong>nine criteria</strong> — five MUSTs and
          four PREFERs — and each contributes points out of its own weight.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <p className="font-semibold text-ink-800">The five MUSTs (65% of the score)</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-ink-600">
              <li>Legal status &amp; qualification</li>
              <li>Strategic fit</li>
              <li>Implementation capacity</li>
              <li>Geographic fit</li>
              <li>Compliance requirements</li>
            </ol>
            <p className="mt-2 font-semibold text-ink-800">The four PREFERs (35%)</p>
            <ol start={6} className="mt-1 list-decimal space-y-0.5 pl-5 text-ink-600">
              <li>Funding quality</li>
              <li>Donor relationship</li>
              <li>Competitiveness</li>
              <li>Bid effort</li>
            </ol>
          </div>
          <div>
            <p className="font-semibold text-ink-800">What the verdicts mean</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-600">
              <li><strong>Proceed</strong> — 90 or above</li>
              <li><strong>Park</strong> — 70 to 89, worth a human look</li>
              <li><strong>Decline</strong> — below 70</li>
              <li>A fatal gate declines outright: a structural ineligibility that cannot be
                fixed before the deadline.</li>
              <li><strong>Not scored</strong> means the call stated nothing to score — it
                takes the Park midpoint rather than counting against you.</li>
            </ul>
          </div>
        </div>
        <p className="mt-2 font-semibold text-ink-800">
          Why a verdict can differ from the count beside it
        </p>
        <p>
          The count is the <strong>evidence</strong> — how many of the criterion's
          components were met. The verdict is the <strong>score</strong>. They are not the
          same measure, and two things make them diverge:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>Gate criteria.</strong> MUST-5 spans compliance requirements, and any
            unmet requirement makes it <em>Not met</em> — so it shows what is unmet rather
            than a percentage, because a percentage would imply partial credit the score
            does not give.</li>
          <li><strong>Weighted criteria.</strong> Funding quality and Competitiveness are
            models, not averages: a track record counts one and a half times, and unmet
            donor requirements subtract. A flat ratio over the components cannot express
            that, so the model names the verdict and the ratio stays beside it as
            evidence.</li>
        </ul>
        <p className="text-ink-500">
          Reviewers can change any component when they record a decision, and the verdict
          follows.
        </p>
      </Block>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Block icon={<UserRound size={15} aria-hidden />} title="Your account & role">
          <ul className="list-disc space-y-1 pl-5">
            <li><Link to={hrefOf("profile")} className="font-semibold text-accent-700 hover:underline">Profile</Link>
              {" "}— edit your name and contact details, or change your password.</li>
            <li>Your role shows at the foot of the sidebar. Most teammates are
              Contributors.</li>
            <li>Need more access? Ask an administrator to adjust your role under
              Settings → Accounts → Users.</li>
            <li><strong>Delete your account</strong> — Profile → Danger zone. This removes
              your login only; your contributed records stay in the system for
              institutional memory.</li>
          </ul>
        </Block>

        <Block icon={<Mail size={15} aria-hidden />} title="Contacting an administrator">
          <p>
            Wherever the app says "ask an administrator" — a role change, a locked action,
            a suspended organization, or a data request — reach the app owner at{" "}
            <Contact />.
          </p>
          <Notice tone="neutral">
            <strong>Closing an organization.</strong> An org admin can suspend their
            organization under Settings → Setup → Danger zone: auto-scans stop and the
            account is retired, <strong>but all records are kept</strong> for later
            retrieval — nothing is deleted. Reactivating a suspended org, or permanently
            deleting its data, is the Super User's to do.
          </Notice>
        </Block>
      </div>

      {admin && (
        <Block icon={<SettingsIcon size={15} aria-hidden />} title="Settings (administrators)">
          <p className="text-ink-500">
            Open from the account menu at the foot of the sidebar.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li><strong>Setup</strong> — org profile, working year, currencies, and scan
              eligibility (health themes, geographic scope, criteria). Includes the Danger
              zone to suspend this organization's account.</li>
            <li><strong>Accounts</strong> — Users (add and edit teammates, set roles, reset
              passwords; pick a user to see their access privileges inline)
              {sup ? ", Tenants (every organization on the platform, with view-as), and Blacklisted (hard-blocked users and tenants, with undo)" : ""}.</li>
            <li><strong>Records</strong> — the full opportunity backend in Data · Verify ·
              Reset (view, edit, delete, export, share). Reset holds backup and maintenance
              tools and is Super-User-only.</li>
            <li><strong>Sources</strong> — Validated (the donor-site catalogue the scanner
              crawls), Verify Registry (classify hosts aggregator-vs-primary and push new
              sources to the catalogue), and Blocked (URL tokens excluded from scans and
              web search).</li>
            <li><strong>Manual Scan</strong> — run a full Extraction, an Eligibility Scan,
              or Sync Excel, and view scan history.</li>
            <li><strong>Learning data</strong> — captured scan, decision and feedback
              signals that train the scoring model.</li>
            {sup && (
              <li><strong>Analytics</strong> — cross-tenant platform stats and the
                system-wide discovery counter.</li>
            )}
          </ul>
        </Block>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {[
          [<Briefcase key="a" size={14} aria-hidden />, "Applications", "grants"],
          [<Layers key="b" size={14} aria-hidden />, "Pipeline", "pipelines"],
          [<NotebookPen key="c" size={14} aria-hidden />, "Meetings", "actions"],
          [<BarChart3 key="d" size={14} aria-hidden />, "Performance", "report"],
          [<Map key="e" size={14} aria-hidden />, "Donors", "donors"],
          [<Building2 key="f" size={14} aria-hidden />, "My Organization", "organization"],
        ].map(([icon, label, page]) => (
          <Link key={String(label)} to={hrefOf(page as never)}
            className="flex items-center gap-2 rounded-lg border border-ink-200 px-3 py-2 text-sm font-semibold text-ink-700 transition-colors hover:border-accent-600 hover:text-accent-700">
            {icon as React.ReactNode} {label as string}
          </Link>
        ))}
      </div>

      <p className="pt-2 text-center text-xs text-ink-400">{org} · powered by RFPIS</p>
    </div>
  );
}
