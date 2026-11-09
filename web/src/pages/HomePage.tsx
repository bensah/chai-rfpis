/**
 * Dashboard — the whole pipeline in one screen.
 *
 * This page used to be a welcome, eight counters and a grid of "Where to start" cards that
 * repeated the left sidebar link for link. The owner's instruction (2026-11-09) was to put
 * Streamlit's Summary here instead of adding it as a sixth Pipeline tab, and to drop the
 * quick-start grid: the rail already says where to start, and saying it twice on the one
 * page that should be showing results is how a dashboard ends up with no data on it.
 *
 * THE FIGURES ARE A PARTITION, NOT A PILE. Each band below divides the one above it, so a
 * reader can check the arithmetic by eye:
 *
 *     found          = awaiting review + proceed + parked + declined
 *     sent to funder = awaiting answer + approved + not approved
 *
 * That matters because the old cards did not add up and said so in public: the Dashboard
 * read "Submitted 21" while the Summary read 24, and the two pages meant different things
 * by the word. See routes_phase1.ts::home for which meaning won and why.
 *
 * Gone with the counters that could not be acted on: "Past deadline" (79 of 94 calls - it
 * reported that calls close) and "Duplicates" (housekeeping; the deduplicator's job is to
 * remove them, not to count them).
 */
import { useEffect, useState } from "react";
import { BookOpen, Download } from "lucide-react";
import { fetchHome, type HomeKpis, type User } from "../api";
import OpportunityRail from "../components/OpportunityRail";
import { hrefOf, Link } from "../router";
import { Card, LinkButton, Notice, PageHeader } from "../ui";

const dash = "—";

const usd = (n: number | null | undefined) =>
  n == null ? dash : `$${Math.round(n).toLocaleString("en-US")}`;

function Tile({ label, value, note, to, title }: {
  label: string;
  value: number | string;
  note?: string;
  /** Present only when the number is worth acting on — see "Due in 14 days". */
  to?: string;
  title?: string;
}) {
  const body = (
    <>
      <div className="text-xs leading-tight text-ink-500">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-brand-700">{value}</div>
      {note && <div className="mt-0.5 text-xs text-ink-400">{note}</div>}
    </>
  );
  if (!to) return <Card className="px-4 py-3">{body}</Card>;
  return (
    <Card className="px-4 py-3 transition-shadow hover:shadow-float">
      <Link to={to} title={title} className="block hover:text-accent-700">{body}</Link>
    </Card>
  );
}

function Band({ title, hint, children }: {
  title: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <section className="mt-7 first:mt-0">
      <h2 className="text-sm font-semibold tracking-[0.04em] text-ink-500 uppercase">
        {title}
      </h2>
      {hint && <p className="mt-0.5 text-xs text-ink-400">{hint}</p>}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">{children}</div>
    </section>
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
  // A deadline you can still act on is the one number here that leads somewhere. Linked
  // only when there is something to see: a link to an empty list wastes the click.
  const dueSoon = k?.due_in_14_days ?? 0;

  return (
    <div className="flex flex-col gap-7 lg:flex-row">
      <div className="min-w-0 flex-1">
        <PageHeader title={`Welcome, ${firstName}`} />
        {error && <Notice tone="warn" className="mb-4">{error}</Notice>}

        <Band title="Calls found" hint="Everything the scan and the team have brought in.">
          <Tile label="Calls found" value={k?.found ?? dash} />
          <Tile label="Awaiting review" value={k?.awaiting_review ?? dash}
            note="No decision yet" />
        </Band>

        <Band title="Our decisions" hint="What the team decided to do about them.">
          <Tile label="Proceed" value={k?.proceed ?? dash} />
          <Tile label="Parked" value={k?.parked ?? dash} />
          <Tile label="Declined" value={k?.declined ?? dash} />
          <Tile label="Due in 14 days" value={k?.due_in_14_days ?? dash}
            note={dueSoon > 0 ? "Proceed — open the list" : "Proceed deadlines"}
            to={dueSoon > 0 ? `${hrefOf("pipelines")}?stage=bidding&due=14` : undefined}
            title="Show the Proceed calls closing within 14 days" />
        </Band>

        {/* APPLICATIONS, not calls - a proposal resubmitted to the same funder is two
            attempts, and the Funding page has always counted it that way. The hint says
            so, because a reader comparing this band with the one above would otherwise
            find they do not reconcile and have no way to know that is correct. */}
        <Band title="With funders"
          hint="Applications sent, and what came back. One call can be applied for twice.">
          <Tile label="Applications sent" value={k?.applications_sent ?? dash} />
          <Tile label="Awaiting answer" value={k?.awaiting_answer ?? dash} />
          <Tile label="Approved" value={k?.approved ?? dash} />
          <Tile label="Not approved" value={k?.not_approved ?? dash} />
        </Band>
        {!!k?.ledger_gap && (
          <Notice tone="warn" className="mt-3">
            {k.ledger_gap === 1
              ? "1 application has a funder's answer but was never marked Completed, so it counts as zero above."
              : `${k.ledger_gap} applications have a funder's answer but were never marked Completed, so they count as zero above.`}{" "}
            Open them from <Link to={hrefOf("grants")} className="underline">Funding</Link> and set the progress to Completed.
          </Notice>
        )}

        <Band title="Funding" hint="Converted to USD; applications we have sent.">
          <Tile label="Requested" value={usd(k?.usd_requested)} />
          <Tile label="Secured" value={usd(k?.usd_secured)} />
          <Tile label="Secured of requested"
            value={k?.pct_secured == null ? dash : `${k.pct_secured}%`} />
        </Band>
      </div>

      <div className="flex w-full shrink-0 flex-col gap-3 lg:w-80">
        {/* The manual comes FIRST in the rail and the live feed sits below it (owner,
            2026-11-09): somebody who needs the manual needs it before they need another
            opportunity to read. */}
        <Card className="p-5">
          <h3 className="flex items-center gap-2 font-semibold text-brand-700">
            <BookOpen className="h-4.5 w-4.5 text-accent-600" strokeWidth={1.9} />
            New to RFPIS? Start with the manual
          </h3>
          <p className="mt-1.5 text-sm text-ink-600">
            Step by step through every page, plus the slides from the team training.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <LinkButton href="/help/RFPIS_User_Manual.pdf" download
              icon={<Download className="h-4 w-4" />}>User manual (PDF)</LinkButton>
            <LinkButton href="/help/RFPIS_Training_Deck.pptx" download
              icon={<Download className="h-4 w-4" />}>Training slides (PPTX)</LinkButton>
          </div>
        </Card>

        <OpportunityRail tenantName={user.view?.name ?? user.tenant?.name} dashboard />
      </div>
    </div>
  );
}
