import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ExternalLink, Loader2, Printer, Share2, X } from "lucide-react";
import { fetchContacts } from "../api";
import {
  completeness, completenessBand, CONTACT_FIELDS, disp, fundingTiers, isYes, label, LIST_FIELDS,
  normalizeCategory, pastProjects, prettyChoice, ratings, toList, UNCATEGORISED, type Contact, type Donor,
  type Schema,
} from "../donors/model";
import { categoryFull, RATING_WORD, subareaLabel } from "../donors/vocab";

// Read-only full intelligence for one donor — the Streamlit page's _view_dialog, section for
// section. "Download / print (PDF)" there is a server-side ReportLab render; here the
// browser's own print-to-PDF does the job with no server at all.

const PRETTY = new Set(["donor_prefinance_required", "donor_entity_type_required", "donor_requires_pi",
  "donor_pi_country_scope", "donor_prior_beneficiary_rule"]);

const ELIG_KV: [string, string][] = [
  ["Route status", "donor_active_route_status"],
  ["Direct local org eligible", "donor_direct_local_org_eligible"],
  ["Prefinance", "donor_prefinance_required"],
  ["Application process", "donor_application_process"],
  ["Funding cycle", "donor_funding_cycle"],
  ["Reporting requirements", "donor_reporting_requirements"],
  ...["donor_application_deadlines", "donor_submission_portal_url"].map((c) => [label(c), c] as [string, string]),
  ["Recent activity", "donor_recent_activity"],
  ...["donor_hq_country_required", "org_stage_required", "donor_max_annual_budget", "donor_min_track_record",
    "donor_required_partner_type", "donor_required_partner_country", "donor_max_request_pct_of_budget",
    "donor_min_cofinancing_secured_pct", "donor_entity_type_required", "donor_registration_region",
    "donor_requires_pi", "donor_pi_country_scope", "donor_max_prior_grant", "donor_prior_beneficiary_rule",
  ].map((c) => [label(c), c] as [string, string]),
];

type Props = { row: Donor; schema: Schema; onClose: () => void; onShare: () => void };

export default function DonorDialog({ row, schema, onClose, onShare }: Props) {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [contactsError, setContactsError] = useState(false);

  useEffect(() => {
    let live = true;
    fetchContacts(row.canonical_key)
      .then((c) => live && setContacts(c))
      .catch(() => live && setContactsError(true));
    return () => { live = false; };
  }, [row.canonical_key]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", esc); document.body.style.overflow = prev; };
  }, [onClose]);

  const print = () => {
    document.body.classList.add("printing-dialog");
    const done = () => { document.body.classList.remove("printing-dialog"); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
  };

  const d = (c: string) => disp(row[c]);
  const name = d("donor") ?? "—";
  const short = d("donor_short");
  const title = name + (short && !name.toLowerCase().includes(short.toLowerCase()) ? ` (${short})` : "");
  const cat = normalizeCategory(row.donor_category);
  const funders = toList(row.donor_funders_collaborators);
  const website = d("donor_website");
  const { pct, have, total } = completeness(row, schema);
  const band = completenessBand(pct);

  // Identity
  const identity = ["donor_general_email", "donor_main_phone", "donor_hq_country", "donor_hq_address",
    "donor_linkedin_url", "donor_other_profile_urls"].filter((c) => d(c));
  // About
  const about = ([["donor_summary_description", "Summary"], ["donor_mission", "Mission"], ["donor_vision", "Vision"],
    ["donor_values", "Values"], ["donor_strategic_priorities", label("donor_strategic_priorities")]] as const)
    .filter(([c]) => d(c));
  const strategyUrl = d("donor_strategy_url");
  // Funding
  const facts: [string, string][] = [];
  const lo = d("donor_award_low");
  const hi = d("donor_award_high");
  if (lo || hi) facts.push(["Award range", `${lo ?? "—"} – ${hi ?? "—"}`]);
  for (const [c, lbl] of [["donor_total_annual_funding_global", "Annual funding"], ["donor_total_funding_to_date", "Total funding"],
    ["donor_total_awards", "Total awards"], ["donor_current_awards", "Current awards"], ["donor_past_awards", "Past awards"],
    ["donor_projected_budget", "Projected budget"]]) {
    let v = d(c);
    if (c === "donor_projected_budget" && v && d("donor_projected_budget_period")) v = `${v} (${d("donor_projected_budget_period")})`;
    if (v) facts.push([lbl, v]);
  }
  const mech = toList(row.donor_funding_mechanism);
  const programs = d("donor_funding_programs");
  const tiers = fundingTiers(row);
  // Scope
  const scope = toList(row.donor_geographic_scope);
  const areas = toList(row.donor_priority_areas);
  const rmap = ratings(row);
  const bars = Object.entries(rmap).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const ungraded = areas.filter((a) => !(a in rmap));
  const inScope = d("donor_in_scope");
  const outScope = d("donor_out_of_scope");
  // Eligibility
  const eligKv = ELIG_KV.map(([lbl, c]) => {
    let v: string | null;
    if (LIST_FIELDS.has(c)) {
      const vals = toList(row[c]);
      v = vals.length ? vals.join(", ") : null;
    } else {
      v = d(c);
      if (v && PRETTY.has(c)) v = prettyChoice(v);
    }
    return [lbl, c, v] as const;
  }).filter(([, , v]) => v) as [string, string, string][];
  const eligFlags = (["Legal & registration requirements", "Requirements & compliance"] as const)
    .map((g) => [g, (schema.groups[g] ?? []).filter((c) => isYes(row[c])).map(label)] as const)
    .filter(([, labs]) => labs.length);
  const eligNotes = d("donor_eligibility_notes");
  const selection = d("donor_selection_criteria");
  // Projects / guidance / sources
  const projects = pastProjects(row);
  const projectCols = ["title", "amount", "currency", "year", "country", "stage", "description", "link"]
    .filter((c) => projects.some((p) => p[c] !== null && p[c] !== undefined && p[c] !== ""));
  const guide = ["donor_strategic_fit_notes", "donor_gaps_risks", "donor_recommended_approach"].filter((c) => d(c));
  const ver = d("donor_verification_level") ? prettyChoice(row.donor_verification_level) : null;
  const sources = d("donor_source_urls");
  const institutional = CONTACT_FIELDS.filter((c) => !identity.includes(c) && d(c));

  return createPortal(
    <div className="print-root fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="dialog-panel w-full max-w-4xl rounded-2xl bg-white shadow-2xl">
        <div className="sticky top-0 z-10 rounded-t-2xl border-b-2 border-slate-200 bg-white px-6 pt-5 pb-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-2xl leading-tight font-extrabold text-navy">{title}</h2>
              <div className="mt-1 text-sm text-slate-500">
                {[cat !== UNCATEGORISED ? cat : null, d("donor_founded") ? `Founded ${d("donor_founded")}` : null,
                  funders.length ? `Partnered with ${funders.slice(0, 3).join(", ")}${funders.length > 3 ? "…" : ""}` : null]
                  .filter(Boolean).join(" · ")}
                {website && (
                  <> {cat !== UNCATEGORISED || d("donor_founded") || funders.length ? "· " : ""}
                    <a href={/^https?:\/\//.test(website) ? website : `https://${website}`} target="_blank" rel="noreferrer" className="text-brand hover:underline">{website}</a>
                  </>
                )}
              </div>
              <span className="mt-2 inline-block rounded-full px-3 py-0.5 text-xs font-bold text-white" style={{ background: band.color }}>
                Data completeness {pct}% · {band.label} ({have}/{total} fields)
              </span>
            </div>
            <div className="no-print flex shrink-0 items-center gap-1">
              <IconButton onClick={onShare} label="Download as Markdown"><Share2 className="h-4 w-4" /></IconButton>
              <IconButton onClick={print} label="Print / save as PDF"><Printer className="h-4 w-4" /></IconButton>
              <IconButton onClick={onClose} label="Close"><X className="h-5 w-5" /></IconButton>
            </div>
          </div>
        </div>

        <div className="space-y-4 px-6 py-5">
          {row.donor_verification_level === "low" && (
            <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle className="h-4 w-4" /> Low verification — confirm against the live call package.
            </p>
          )}

          {identity.length > 0 && (
            <Section icon="🏷" title="Identity">
              <KvList items={identity.map((c) => [label(c), d(c)!])} />
            </Section>
          )}

          {(about.length > 0 || strategyUrl) && (
            <Section icon="📖" title="About & strategy">
              {about.map(([c, lbl]) => <Block key={c} title={lbl}><Text>{d(c)!}</Text></Block>)}
              {strategyUrl && <p className="mt-3 text-sm"><strong>Strategy:</strong> <MaybeLink v={strategyUrl} /></p>}
            </Section>
          )}

          {(facts.length > 0 || mech.length > 0 || programs || funders.length > 0 || tiers.length > 0) && (
            <Section icon="💰" title="Funding">
              {facts.length > 0 && (
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                  {facts.map(([lbl, v]) => <div key={lbl} className="text-sm"><div className="font-semibold">{lbl}</div><div className="text-slate-700">{v}</div></div>)}
                </div>
              )}
              {mech.length > 0 && <Block title="Funding mechanism"><Chips items={mech} /></Block>}
              {funders.length > 0 && <Block title={label("donor_funders_collaborators")}><Chips items={funders} /></Block>}
              {programs && <Block title={label("donor_funding_programs")}><Text>{programs}</Text></Block>}
              {tiers.length > 0 && (
                <Block title="Funding tiers / bands / stages">
                  <Table cols={["Tier / band / stage", "Amount", "Duration", "Notes / criteria"]}
                    rows={tiers.map((t) => ["name", "amount", "duration", "notes"].map((k) => String(t[k] ?? "")))} />
                </Block>
              )}
            </Section>
          )}

          {(scope.length > 0 || areas.length > 0 || inScope || outScope) && (
            <Section icon="🎯" title="Scope & fit">
              {(bars.length > 0 || ungraded.length > 0) && (
                <Block title="Strategic priority areas">
                  {bars.map(([k, v]) => (
                    <div key={k} className="my-1 flex items-center gap-3">
                      <div className="w-60 shrink-0 text-sm leading-tight">{subareaLabel(k)} <span className="text-xs text-slate-400">· {categoryFull(k)}</span></div>
                      <div className="h-3 flex-1 rounded-md bg-slate-100">
                        <div className="h-3 rounded-md bg-gradient-to-r from-[#34a06b] to-brand" style={{ width: `${(v / 5) * 100}%` }} />
                      </div>
                      <div className="w-24 shrink-0 text-right text-xs font-semibold text-navy">{v}/5 · {RATING_WORD[v]}</div>
                    </div>
                  ))}
                  {ungraded.length > 0 && <Chips items={ungraded.map(subareaLabel)} />}
                </Block>
              )}
              {scope.length > 0 && <Block title="Funding scope — geographies"><Chips items={scope} /></Block>}
              {(inScope || outScope) && (
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  {inScope && <div><div className="text-sm font-semibold">✓ {label("donor_in_scope")}</div><Text>{inScope}</Text></div>}
                  {outScope && <div><div className="text-sm font-semibold">✗ {label("donor_out_of_scope")}</div><Text>{outScope}</Text></div>}
                </div>
              )}
            </Section>
          )}

          {(eligFlags.length > 0 || eligKv.length > 0 || eligNotes || selection) && (
            <Section icon="✅" title="Eligibility & process">
              {eligFlags.map(([g, labs]) => <Block key={g} title={g}><Chips items={[...labs]} /></Block>)}
              {eligKv.length > 0 && <Block title="Application logistics"><KvList items={eligKv.map(([lbl, , v]) => [lbl, v])} /></Block>}
              {eligNotes && <Block title={label("donor_eligibility_notes")}><Text>{eligNotes}</Text></Block>}
              {selection && <Block title={label("donor_selection_criteria")}><Text>{selection}</Text></Block>}
            </Section>
          )}

          {projects.length > 0 && (
            <Section icon="📚" title={`Past Projects — funded projects (${projects.length})`}>
              <Table
                cols={projectCols.map((c) => ({ title: "Project", amount: "Award", currency: "Cur.", year: "Year", country: "Country", stage: "Stage", description: "Description", link: "Link" })[c]!)}
                rows={projects.map((p) => projectCols.map((c) => String(p[c] ?? "")))}
                linkCol={projectCols.indexOf("link")}
              />
            </Section>
          )}

          {guide.length > 0 && (
            <Section icon="🧭" title="Strategic guidance">
              <p className="mb-2 text-xs text-slate-500">Funder-centric guidance for any applicant — what this donor rewards, what to avoid, and how to position a strong bid.</p>
              {guide.map((c) => <Block key={c} title={label(c)}><Text>{d(c)!}</Text></Block>)}
            </Section>
          )}

          <Section icon="📇" title="Contacts — focal persons">
            {institutional.length > 0 && <KvList items={institutional.map((c) => [label(c), d(c)!])} />}
            {contacts === null && !contactsError && <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading contacts…</p>}
            {contactsError && <p className="text-sm text-amber-700">Couldn't load contacts right now.</p>}
            {contacts && contacts.length === 0 && institutional.length === 0 && <p className="text-sm text-slate-500">No contacts recorded for your organisation.</p>}
            {contacts && contacts.length > 0 && (
              <ul className="space-y-2">
                {contacts.map((c, i) => <ContactLine key={i} c={c} />)}
              </ul>
            )}
          </Section>

          {(ver || d("donor_evidence_summary") || d("notes") || d("donor_aliases") || sources) && (
            <Section icon="🗂" title="Sources & data quality">
              <KvList items={([
                ["Profile completeness", `${pct}% (${have}/${total} fields)`],
                ["Verification (manual)", ver], ["Evidence summary", d("donor_evidence_summary")],
                ["Notes", d("notes")], ["Aliases", d("donor_aliases")],
              ] as [string, string | null][]).filter(([, v]) => v) as [string, string][]} />
              {sources && (
                <Block title="Source URLs">
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {sources.replace(/\\n/g, "\n").split("\n").map((u) => u.trim()).filter(Boolean).map((u) => <li key={u}><MaybeLink v={u} /></li>)}
                  </ul>
                </Block>
              )}
            </Section>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Section({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 p-4">
      <h3 className="mb-2 text-base font-bold text-navy"><span aria-hidden>{icon}</span>&nbsp;&nbsp;{title}</h3>
      {children}
    </section>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      <div className="mb-1 text-xs font-bold tracking-wider text-slate-500 uppercase">{title}</div>
      {children}
    </div>
  );
}

function Text({ children }: { children: string }) {
  return <p className="text-sm whitespace-pre-line text-slate-800">{children}</p>;
}

function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((t) => <span key={t} className="rounded-full bg-brand-soft px-3 py-0.5 text-sm text-brand">{t}</span>)}
    </div>
  );
}

function MaybeLink({ v }: { v: string }) {
  return /^https?:\/\//.test(v)
    ? <a href={v} target="_blank" rel="noreferrer" className="break-all text-brand hover:underline">{v}</a>
    : <>{v}</>;
}

function KvList({ items }: { items: [string, string][] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm">
      {items.map(([k, v]) => <li key={k}><strong>{k}:</strong> <MaybeLink v={v} /></li>)}
    </ul>
  );
}

function Table({ cols, rows, linkCol = -1 }: { cols: string[]; rows: string[][]; linkCol?: number }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-surface text-left text-xs text-slate-500">
          <tr>{cols.map((c) => <th key={c} className="px-3 py-2 font-semibold">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-slate-100 align-top">
              {r.map((v, j) => (
                <td key={j} className="px-3 py-2">
                  {j === linkCol && v
                    ? <a href={v} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">Open <ExternalLink className="h-3 w-3" /></a>
                    : v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContactLine({ c }: { c: Contact }) {
  const v = (k: string) => disp(c[k]);
  const linkedin = v("linkedin_url");
  const bits: ReactNode[] = [];
  if (v("email")) bits.push(<a key="e" href={`mailto:${v("email")}`} className="text-brand hover:underline">✉ {v("email")}</a>);
  if (v("phone")) bits.push(<span key="p">☎ {v("phone")}</span>);
  if (linkedin) bits.push(linkedin.startsWith("http")
    ? <a key="l" href={linkedin} target="_blank" rel="noreferrer" className="text-brand hover:underline">LinkedIn</a>
    : <span key="l">LinkedIn: {linkedin}</span>);
  if (v("address")) bits.push(<span key="a">{v("address")}</span>);
  if (v("notes")) bits.push(<em key="n">{v("notes")}</em>);
  return (
    <li className="text-sm">
      <strong>{v("contact_name") ?? "(unnamed)"}</strong>
      {v("role_title") && <> — {v("role_title")}</>}
      {Boolean(c.is_official) && <> · ✅ official</>}
      {bits.length > 0 && (
        <div className="text-slate-600">
          {bits.map((b, i) => <span key={i}>{i > 0 && " · "}{b}</span>)}
        </div>
      )}
    </li>
  );
}

function IconButton({ onClick, label: lbl, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button onClick={onClick} title={lbl} aria-label={lbl} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800">
      {children}
    </button>
  );
}
