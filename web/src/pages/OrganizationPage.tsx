/**
 * My Organization — `app_pages/organization.py`.
 *
 * A read-only view of what the matching engine believes about this tenant. Everyone can
 * see it; the editor is Settings → Setup, which is the Streamlit page's own arrangement
 * rather than a limit of this port.
 *
 * THE COMPLETENESS BAR IS THE POINT OF THE PAGE, not decoration at the top of it. Every
 * other block is a field somebody filled in once and has not looked at since; the bar is
 * what says whether the profile is good enough for screening to be trusted, and the
 * warning under it names the specific pieces missing rather than saying "incomplete".
 * `core/profile_completeness.py` weighs geography and program areas highest for the same
 * reason: they are the load-bearing gate and fit signals, and everything else fills in
 * the picture.
 *
 * "ENTITY" RATHER THAN "ORGANIZATION" where the wording allows it — a tenant may be a
 * single individual rather than an organisation (migration 078), and the Streamlit page
 * avoids org-only language on purpose. The rail item is still "My Organization", which is
 * the owner's word.
 */
import { useEffect, useState } from "react";
import {
  Building2, Check, ExternalLink, Globe, Handshake, Mail, Target, TriangleAlert, Users,
} from "lucide-react";
import { ApiError, fetchOrganization, type Organization, type OrgRatingRow } from "../api";
import OpportunityRail from "../components/OpportunityRail";
import { hrefOf, Link } from "../router";
import { Badge, Card, EmptyState, Notice, PageHeader, Spinner } from "../ui";
import { DataTable } from "../report/charts";
import type { User } from "../api";

const dash = "—";

/** The Python's `_yn`: a real boolean first, because `False or ""` is "" and reads as unset. */
function yn(v: unknown): string {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (v === null || v === undefined || v === "") return dash;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "yes" ? "Yes" : s === "false" || s === "no" ? "No" : dash;
}

/** `_present` — the same three-way answer, worded for a thing that exists or does not. */
function present(v: unknown): string {
  if (typeof v === "boolean") return v ? "Present" : "Absent";
  if (v === null || v === undefined || v === "") return dash;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "yes" ? "Present" : s === "false" || s === "no" ? "Absent" : dash;
}

/** `_money` — and zero is NOT a figure here, it is a field nobody filled in. */
function money(v: unknown): string {
  if (v === null || v === undefined || v === "" || v === 0) return dash;
  const n = Number(v);
  return Number.isFinite(n) ? `$${Math.round(n).toLocaleString("en-US")}` : String(v);
}

const titled = (v: unknown): string => {
  const s = String(v ?? "").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : dash;
};

const joined = (v: unknown): string =>
  Array.isArray(v) && v.length ? v.map((x) => String(x)).join(", ") : dash;

/** A muted uppercase label over a prominent value — the Streamlit card's own shape. */
function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  const empty = value === null || value === undefined || value === "" ;
  return (
    <div className="mb-3.5">
      <div className="mb-0.5 text-[0.7rem] font-bold uppercase tracking-wide text-ink-500">{label}</div>
      <div className="text-[1.02rem] font-medium leading-snug text-ink-800">{empty ? dash : value}</div>
    </div>
  );
}

function Block({ icon, title, hint, children }: {
  icon: React.ReactNode; title: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-brand-700" title={hint}>
        {icon} {title}
      </h3>
      {children}
    </Card>
  );
}

/**
 * The red-amber-green completeness bar.
 *
 * The FILL colour is the band the score falls in — at or below 50% red, 50 to 80% yellow,
 * at or above 80% green — and the remainder is a muted grey with faint ticks at the two
 * thresholds, so a reader can see how far off the next band is rather than only where
 * they are. The bands are `core/profile_completeness.rag_band`, resolved on the server so
 * both apps draw the same colour for the same profile.
 */
function RagBar({ pct, band, label }: { pct: number; band: string; label: string }) {
  const w = Math.max(0, Math.min(100, Math.round(pct * 1000) / 10));
  const fill = band === "green" ? "#1e8e3e" : band === "amber" ? "#eab308" : "#d1343b";
  return (
    <div className="mb-2">
      <div className="mb-1.5 text-sm text-ink-700">{label}</div>
      <div className="relative h-3 overflow-hidden rounded-full bg-ink-100 shadow-[inset_0_0_0_1px_rgba(128,128,128,0.14)]">
        <div className="h-full rounded-l-full transition-[width] duration-300"
          style={{ width: `${w}%`, background: fill }} />
        <div className="absolute inset-y-0 left-1/2 w-px bg-ink-300" />
        <div className="absolute inset-y-0 left-[80%] w-px bg-ink-300" />
      </div>
    </div>
  );
}

/** One graded program area: the sub-area, its category, a bar, and the word for the score. */
function Ratings({ rows, ungraded }: { rows: OrgRatingRow[]; ungraded: string[] }) {
  return (
    <>
      {rows.map((r) => (
        <div key={r.key} className="my-1 flex items-center gap-2.5">
          <div className="w-60 shrink-0 text-[0.86rem] leading-tight text-ink-700">
            {r.label} <span className="text-[0.72rem] text-ink-400">· {r.category}</span>
          </div>
          <div className="h-3 flex-1 rounded-full bg-ink-100">
            <div className="h-3 rounded-full bg-gradient-to-r from-good-500 to-good-700"
              style={{ width: `${(r.value / 5) * 100}%` }} />
          </div>
          <div className="w-24 shrink-0 text-right text-[0.74rem] font-semibold text-brand-700">
            {r.value}/5 · {r.word}
          </div>
        </div>
      ))}
      {ungraded.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {ungraded.map((a) => <Badge key={a} tone="brand">{a}</Badge>)}
        </div>
      )}
    </>
  );
}

export default function OrganizationPage({ user }: { user: User }) {
  const [data, setData] = useState<Organization | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    fetchOrganization()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : "Couldn't load this entity."));
    return () => { live = false; };
  }, []);

  if (error) return <EmptyState title="This entity is unavailable">{error}</EmptyState>;
  if (!data) return <Spinner label="Loading your organization…" />;

  // NOTHING HERE RESOLVES A LABEL OR AN ORDER. The ratings arrive sorted, the categories
  // and the 0-5 words are looked up server-side from tables generated out of the Python,
  // and the legal type is already a label. A browser copy of any of it would be a second
  // implementation of something core/org_profile.py owns.
  const { identity: o, profile: p, completeness: c, ratings: r } = data;

  const partners = Array.isArray(p.partners)
    ? (p.partners as Record<string, unknown>[]) : [];
  const website = String(o.org_website ?? "").trim();
  const websiteHref = website.startsWith("http") ? website : `https://${website}`;

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-4">
        <PageHeader
          title="Your Organization"
          lead="What the matching engine knows about you. Screening reads this, so a gap here is a gap in every score."
          actions={data.canEdit
            ? (
              <Link to={hrefOf("settings")}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-3 py-2 text-sm font-semibold text-white hover:bg-accent-700">
                Edit in Settings
              </Link>
            )
            : <span className="text-xs text-ink-500">View only — editing is restricted to app owners.</span>}
        />

        {/* Identity strip */}
        <Card className="flex flex-wrap items-center gap-4 p-4">
          {data.logo && (
            <img src={data.logo} alt="" className="h-20 w-20 shrink-0 object-contain" />
          )}
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-brand-700">{o.org_name || "This tenant"}</h2>
            <p className="text-sm text-ink-500">
              {[o.org_team, o.org_country].filter(Boolean).join(" · ") || dash}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-3 text-sm">
              {website && (
                <a href={websiteHref} target="_blank" rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-accent-700 underline hover:text-accent-800">
                  {website} <ExternalLink size={12} aria-hidden />
                </a>
              )}
              {o.org_contact_email && (
                <span className="inline-flex items-center gap-1 text-ink-600">
                  <Mail size={13} aria-hidden /> {o.org_contact_email}
                </span>
              )}
            </p>
          </div>
        </Card>

        {/* Completeness — the reason the page exists */}
        <Card className="p-4">
          <RagBar pct={c.pct} band={c.band}
            label={`Profile ${Math.round(c.pct * 100)}% complete · ${
              c.gap.length === 0 ? "✅ screening-ready" : "⚠ not yet screening-ready"}`} />
          {!c.hasGeo ? (
            <Notice tone="warn" icon={<TriangleAlert size={15} aria-hidden />}>
              <strong>No geography set.</strong> Add your countries of operation so screening
              can gate on where you work — without it, off-scope calls slip into your pipeline.
            </Notice>
          ) : c.gap.length > 0 ? (
            <Notice tone="neutral">Add {c.gap.join(" and ")} to unlock accurate matching.</Notice>
          ) : null}
          {c.missing.length > 0 && c.pct < 1 && (
            <p className="mt-2 text-xs text-ink-500">
              {data.canEdit ? "Complete your profile to improve matching" : "Still missing"}:{" "}
              {c.missing.slice(0, 6).join(", ")}{c.missing.length > 6 ? "…" : ""}
            </p>
          )}
        </Card>

        <Block icon={<Building2 size={15} aria-hidden />} title="Identity & eligibility">
          <div className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-4">
            <Kv label="Legally registered as" value={data.labels.legalType} />
            <Kv label="Founded in the year" value={p.org_founding_year as React.ReactNode} />
            <Kv label="Located in" value={o.org_country} />
            <Kv label="Local board" value={present(o.org_has_local_board)} />
            <Kv label="BD / fundraising team" value={yn(o.org_has_bd_team)} />
            <Kv label="Local organization" value={yn(o.org_is_grassroot)} />
            <Kv label="Multi-country" value={yn(o.org_is_multi_country)} />
            <Kv label="HQ country" value={o.org_hq_country} />
          </div>
        </Block>

        <Block icon={<Target size={15} aria-hidden />} title="Capacity & funding targets"
          hint="Funding-quality bands use geometric midpoints: ≤√(low·mid) Low · ≤√(mid·max) Moderate · above High.">
          <div className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-4">
            <Kv label="Annual budget" value={money(p.org_annual_budget)} />
            <Kv label="Largest grant managed" value={money(p.org_largest_grant)} />
            <Kv label="Co-financing capacity" value={titled(p.org_cofinancing_capacity)} />
            <Kv label="Stage" value={titled(p.org_stage)} />
            <Kv label="Funding target — low" value={money(p.org_min_target)} />
            <Kv label="Funding target — mid" value={money(p.org_mid_target)} />
            <Kv label="Funding target — max" value={money(p.org_max_target)} />
            <Kv label="Independent entity (not INGO affiliate)" value={yn(p.org_is_independent_entity)} />
            <Kv label="Holds SAM.gov / UEI" value={yn(p.org_has_sam_uei)} />
            <Kv label="Tax-exempt" value={yn(p.org_tax_exempt)} />
          </div>
        </Block>

        <Block icon={<Target size={15} aria-hidden />} title="Program areas (graded 0–5)">
          <p className="text-sm font-semibold text-ink-700">
            Domains / areas of expertise (track record → competitiveness)
          </p>
          <p className="mb-2 text-xs text-ink-500">Where you have demonstrated experience.</p>
          <Ratings rows={r.domain} ungraded={r.domainUngraded} />
          <p className="mt-4 text-sm font-semibold text-ink-700">Strategic priority areas of interest</p>
          <p className="mb-2 text-xs text-ink-500">Where your strategy says you want to work.</p>
          <Ratings rows={r.priority} ungraded={r.priorityUngraded} />
        </Block>

        <Block icon={<Globe size={15} aria-hidden />} title="Geography & partners">
          <div className="grid gap-x-6 sm:grid-cols-2">
            <Kv label="Countries registered" value={joined(p.org_registered_countries)} />
            <Kv label="Countries of operation" value={joined(p.org_operating_countries)} />
          </div>
          {partners.length > 0 && (
            <>
              <p className="mb-2 mt-2 text-sm font-semibold text-ink-700">
                Affiliated partners & collaborators
              </p>
              <DataTable
                rows={partners} keyOf={(r, i) => `${String(r.name ?? "")}-${i}`}
                cols={[
                  { head: "Partner", cell: (r) => String(r.name ?? dash) },
                  { head: "Type", cell: (r) => String(r.type ?? dash) },
                  { head: "Country", cell: (r) => String(r.country ?? dash) },
                ]}
              />
            </>
          )}
        </Block>

        <Block icon={<Handshake size={15} aria-hidden />} title="Funders & languages">
          <Kv label="Donors we've won grants/awards from" value={joined(p.org_funder_history)} />
          <Kv label="Donor portal registration active" value={joined(p.org_donor_registrations)} />
          <Kv label="Proposal languages" value={joined(p.proposal_languages)} />
        </Block>

        {data.team.length > 0 && (
          <Block icon={<Users size={15} aria-hidden />} title="Team members">
            <div className="flex flex-wrap gap-1.5">
              {data.team.map((m) => <Badge key={m}>{m}</Badge>)}
            </div>
          </Block>
        )}

        {!data.canEdit && (
          <p className="flex items-center gap-1.5 text-xs text-ink-500">
            <Check size={13} aria-hidden />
            To change any of the above, ask an app owner (admin / super-user).
          </p>
        )}
      </div>

      <div className="min-w-0">
        <OpportunityRail tenantName={user.view?.name ?? user.tenant?.name} />
      </div>
    </div>
  );
}
