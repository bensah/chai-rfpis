/**
 * Settings → Setup — the editor. `views/org_setup.py`, four tabs over two JSON blobs.
 *
 * IT IS THE ONLY PLACE THE SCORING PROFILE IS AUTHORED, which is what makes it the first
 * tab of the admin port rather than the biggest one. `core.auto_scorer` reads
 * `tenants.org_profile` on every call; My Organization only displays it. So the page's
 * job is not to collect values, it is to collect values the scorer can match — and the
 * server clamps every vocabulary field for the same reason (org_setup.ts).
 *
 * THREE SAVES, THREE BUTTONS, mirroring the Streamlit page exactly. They write three
 * places and are not interchangeable:
 *
 *   Profile       → tenants.org_identity, PARTIAL. "Organization name" is also the
 *                   tenant rename, which can fail on its own (another tenant holds the
 *                   name) while every other field is already stored. That is reported as
 *                   a warning, not an error — see below.
 *   Bid Fitness   → tenants.org_profile, WHOLESALE, plus three competitiveness keys back
 *                   onto the identity. The blob is REPLACED, so the form sends all 41
 *                   persistable keys whether or not they were touched.
 *   Team Members  → the roster key, tenant-scoped.
 *
 * WHAT A SAVE REPORTS. The characteristic failure on these columns is not an exception:
 * an RLS or wrong-key write returns success and changes nothing. The server re-reads and
 * names the fields that did not land, and this page shows that message as-is rather than
 * a cheerful "Saved" — the Streamlit page learnt the same lesson the same way.
 *
 * SCAN PREFERENCES is the fourth tab and lives in its own file: it writes three stores
 * of its own (core/policies.py, the search pivots and the currency table) rather than the
 * two blobs on the tenant row, and two of those three are deployment-wide.
 */
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Building2, CheckCircle2, Save, Trash2, Users as UsersIcon,
} from "lucide-react";
import {
  fetchSetup, saveSetupIdentity, saveSetupProfile, saveSetupTeam,
  type OrgPartner, type OrgSetup, type SetupOptions, type Warning,
} from "../api";
import MultiSelect from "../components/MultiSelect";
import ScanPrefsTab from "./ScanPrefsTab";
import { Choice, Lbl, Num, Row, Text } from "../opportunity/controls";
import {
  Badge, Button, Card, Eyebrow, Notice, Select, Spinner, fieldClass,
} from "../ui";

type Json = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const n = (v: unknown) => (v === null || v === undefined || v === "" ? "" : String(v));
const arr = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : []);

/**
 * The sub-area shown in full with its category beside it.
 *
 * It SPLITS a key; it never builds one. The key is what the classifier matches on, so a
 * display helper that learnt to compose keys would be one refactor away from storing a
 * composed one. An unknown prefix falls back to itself, as `category_full` does.
 */
function areaLabel(key: string, names: Record<string, string>): { sub: string; cat: string } {
  const i = key.indexOf(" - ");
  if (i < 0) return { sub: key, cat: "" };
  const code = key.slice(0, i);
  return { sub: key.slice(i + 3), cat: names[code] ?? code };
}

/**
 * Every option table present, whatever the server sent.
 *
 * NOT defensive programming against our own API — against a VERSION SKEW that this
 * deployment makes ordinary. The page ships to Cloudflare Pages and the route to a
 * Supabase Edge Function, separately, so a browser can hold a page newer than the
 * function answering it. One missing table then reads as `undefined[code]` inside a
 * render and takes the whole Settings page down with a white screen — which is how a
 * cosmetic lag becomes an outage. An empty table instead renders the stored CODE, which
 * is ugly and correct, and leaves the three saves working.
 */
function withDefaults(o: Partial<SetupOptions> | undefined): SetupOptions {
  return {
    legalTypes: o?.legalTypes ?? [],
    entityTypes: o?.entityTypes ?? [],
    stages: o?.stages ?? [],
    cofinancing: o?.cofinancing ?? [],
    boards: o?.boards ?? [],
    routes: o?.routes ?? [],
    languages: o?.languages ?? [],
    partnerTypes: o?.partnerTypes ?? [],
    partnerStatus: o?.partnerStatus ?? [],
    countries: o?.countries ?? [],
    areaTaxonomy: o?.areaTaxonomy ?? [],
    categoryNames: o?.categoryNames ?? {},
    legalTypeLabels: o?.legalTypeLabels ?? {},
    entityTypeLabels: o?.entityTypeLabels ?? {},
    donors: o?.donors ?? [],
    portals: o?.portals ?? [],
  };
}

/** Save state for one of the three buttons. */
type SaveState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; note: string; warnings: Warning[] }
  | { kind: "error"; message: string; problems: string[] };

function SaveBar({ label, state, onSave }: {
  label: string; state: SaveState; onSave: () => void;
}) {
  return (
    <div className="mt-6 border-t border-ink-200 pt-5">
      <Button
        variant="primary" busy={state.kind === "busy"} onClick={onSave}
        icon={<Save className="h-4 w-4" />}
      >
        {label}
      </Button>
      {state.kind === "ok" && (
        <>
          <Notice tone="good" className="mt-3" icon={<CheckCircle2 className="h-4 w-4" />}>
            {state.note}
          </Notice>
          {/* A rename that did not go through. Everything else on the form IS saved, and
              saying so is the point — the Python separates these two for the same reason. */}
          {state.warnings.map((w) => (
            <Notice key={w.code} tone="warn" className="mt-2"
              icon={<AlertTriangle className="h-4 w-4" />}>
              {w.detail}
              <span className="mt-1 block text-xs text-ink-600">
                Every other field on this tab was saved.
              </span>
            </Notice>
          ))}
        </>
      )}
      {state.kind === "error" && (
        <Notice tone="bad" className="mt-3">
          {state.message}
          {state.problems.length > 0 && (
            <ul className="mt-1.5 list-disc pl-5 text-sm">
              {state.problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
        </Notice>
      )}
    </div>
  );
}

/** Runs one save and turns whatever comes back into a SaveState. */
function useSaver() {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const run = async (note: string, fn: () => Promise<{ warnings?: Warning[] }>) => {
    setState({ kind: "busy" });
    try {
      const r = await fn();
      setState({ kind: "ok", note, warnings: r.warnings ?? [] });
      return r;
    } catch (e) {
      const err = e as { message?: string; problems?: string[] };
      setState({
        kind: "error",
        message: err.message || "Save failed — nothing was written.",
        problems: err.problems ?? [],
      });
      return null;
    }
  };
  return [state, run] as const;
}

export default function SetupTab() {
  const [data, setData] = useState<OrgSetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("Profile");

  useEffect(() => {
    fetchSetup().then((d) => setData({ ...d, options: withDefaults(d.options) }))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Couldn't load the organization."));
  }, []);

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Spinner label="Loading the organization…" />;

  const tabs = ["Profile", "Bid Fitness", "Team Members", "Scan Preferences"];
  return (
    <div>
      <div role="tablist" className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button
            key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)}
            className={`rounded-lg px-3.5 py-1.5 text-sm transition-colors ${
              t === tab ? "bg-brand-50 font-semibold text-brand-700"
                : "text-ink-600 hover:bg-ink-100 hover:text-ink-900"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="mt-5">
        {tab === "Profile" && <ProfileTab data={data} onSaved={setData} />}
        {tab === "Bid Fitness" && <FitTab data={data} onSaved={setData} />}
        {tab === "Team Members" && <TeamTab data={data} onSaved={setData} />}
        {tab === "Scan Preferences" && <ScanPrefsTab />}
      </div>
    </div>
  );
}

// ── Tab 1: Profile ───────────────────────────────────────────────────────────

function ProfileTab({ data, onSaved }: {
  data: OrgSetup; onSaved: (d: OrgSetup) => void;
}) {
  const id = data.identity;
  const boards = data.options.boards;
  const [f, setF] = useState({
    orgName: s(id.org_name), orgShort: s(id.org_short), orgCountry: s(id.org_country),
    orgTeam: s(id.org_team), orgEmail: s(id.org_contact_email),
    orgWebsite: s(id.org_website),
    usEntity: s(id.org_is_us_entity).toLowerCase() === "true",
    bdTeam: s(id.org_has_bd_team).toLowerCase() === "true",
    // Stored VALUE, not the label — the server accepts either and round-trips it.
    localBoard: s(id.org_has_local_board),
  });
  const set = (k: keyof typeof f) => (v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const [state, run] = useSaver();

  return (
    <Card className="max-w-4xl p-6">
      <Eyebrow>Organization</Eyebrow>
      <p className="mb-5 text-sm leading-relaxed text-ink-600">
        Stamps every page header, the Performance dashboard and outgoing email digests.
        The defaults are placeholders — a header reading “Your Organization” is telling
        you the real name was never set.
      </p>

      <Row>
        <Text label="Organization name" value={f.orgName} onChange={set("orgName")}
          tip="Also this tenant's unique name, so a rename can be refused if another organization holds it."
          hint="Shown in page captions and the report header." required />
        <Text label="Short name / abbreviation" value={f.orgShort} onChange={set("orgShort")}
          hint="Compact label for page titles and scan logs." />
      </Row>
      <Row>
        <Choice label="Primary country" value={f.orgCountry} onChange={set("orgCountry")}
          options={["", ...data.options.countries]} hint="Used in the report's geographic context." />
        <Text label="Team / department" value={f.orgTeam} onChange={set("orgTeam")}
          hint="The team running the screening." />
      </Row>
      <Row>
        <Text label="Contact email" value={f.orgEmail} onChange={set("orgEmail")}
          hint="Distribution list for digests, and the From / Reply-To on notifications." />
        <Text label="Website (optional)" value={f.orgWebsite} onChange={set("orgWebsite")} />
      </Row>

      <h3 className="mt-6 mb-1 text-sm font-bold text-brand-700">Eligibility gates</h3>
      <p className="mb-4 text-sm text-ink-600">
        These drive the scanner's hard screens and the donor compliance check — they
        decide what is <em>rejected</em>, not how it scores.
      </p>
      <label className="mb-3 flex items-start gap-2.5 text-sm text-ink-700">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-700"
          checked={f.usEntity} onChange={(e) => set("usEntity")(e.target.checked)} />
        <span>
          We are a US-based entity
          <span className="block text-xs text-ink-500">
            Unchecked, the scanner rejects US-domestic-only calls.
          </span>
        </span>
      </label>
      <div className="mb-3 max-w-md">
        <Lbl hint="“No” makes a donor that requires a local board a hard MUST-4 disqualifier. “Unknown” leaves the gate off.">
          Locally-constituted Board of Directors?
        </Lbl>
        <Select value={f.localBoard} onChange={(e) => set("localBoard")(e.target.value)}>
          {boards.map(([label, value]) => (
            <option key={label} value={value}>{label}</option>
          ))}
        </Select>
      </div>
      <label className="flex items-start gap-2.5 text-sm text-ink-700">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-700"
          checked={f.bdTeam} onChange={(e) => set("bdTeam")(e.target.checked)} />
        <span>
          We have a Business Development / Fundraising team
          <span className="block text-xs text-ink-500">Feeds bid effort (PREFER 9).</span>
        </span>
      </label>

      {/* The logo is READ here and changed in the classic app — see the module docstring.
          Showing it matters: an organisation looking at its own record and not seeing its
          own mark reads as the wrong record. */}
      <div className="mt-6 flex items-center gap-4 rounded-lg border border-ink-200 bg-ink-50 p-4">
        {data.logo
          ? <img src={data.logo} alt="Current logo" className="h-12 w-auto" />
          : <div className="flex h-12 w-12 items-center justify-center rounded bg-white text-ink-300">
              <Building2 className="h-6 w-6" />
            </div>}
        <div className="text-sm text-ink-600">
          <div className="font-medium text-ink-800">
            {data.logo ? "Logo in use" : "No logo uploaded"}
          </div>
          <div className="text-xs">
            Uploading and removing a logo is still on the classic Settings page.
          </div>
        </div>
      </div>

      <SaveBar
        label="Save organization profile" state={state}
        onSave={() => run("Organization profile saved.", async () => {
          const r = await saveSetupIdentity(f as unknown as Json);
          if (r.identity) onSaved({ ...data, identity: r.identity });
          return r;
        })}
      />
    </Card>
  );
}

// ── Tab 2: Bid Fitness ───────────────────────────────────────────────────────

function FitTab({ data, onSaved }: { data: OrgSetup; onSaved: (d: OrgSetup) => void }) {
  const p = data.profile;
  const o = data.options;
  const [f, setF] = useState(() => fromProfile(data));
  const set = (k: keyof ReturnType<typeof fromProfile>) => (v: unknown) =>
    setF((prev) => ({ ...prev, [k]: v }));
  const [state, run] = useSaver();

  // The entity vocabulary depends on the legal type — the editor's data-validation rule,
  // asked here so the dropdown cannot offer what the server would refuse.
  const entityOpts = f.legalType === "individual" ? ["individual"] : o.entityTypes;
  useEffect(() => {
    if (!entityOpts.includes(f.entityType)) {
      setF((prev) => ({ ...prev, entityType: entityOpts[0] }));
    }
  }, [f.legalType]); // eslint-disable-line react-hooks/exhaustive-deps

  const routeLabels = useMemo(
    () => Object.fromEntries(o.routes.map(([t, l]) => [t, l])), [o.routes]);

  return (
    <Card className="max-w-5xl p-6">
      <Eyebrow>Organization fit profile</Eyebrow>
      <p className="mb-5 text-sm leading-relaxed text-ink-600">
        The structured record of who you are, matched against each call's requirements to
        answer the eligibility questions objectively. Everything here is a scoring input:
        a field left unset is not neutral, it is a criterion with nothing to match.
      </p>

      <Row>
        <Choice label="Legal type" value={f.legalType} onChange={set("legalType")}
          options={o.legalTypes} blank="" format={(v) => o.legalTypeLabels[v] ?? v}
          tip="MUST-1 item A — the applicant category." />
        <Choice label="Entity type" value={f.entityType} onChange={set("entityType")}
          options={entityOpts} blank="" format={(v) => o.entityTypeLabels[v] ?? v}
          tip="MUST-1 item B. Also feeds competitiveness: grassroots and multi-country are derived from it." />
      </Row>
      <Row cols={3}>
        <Num label="Founding year" value={f.foundingYear} onChange={set("foundingYear")}
          hint="Track-record length." />
        <Choice label="Co-financing capacity" value={f.cofinancing} onChange={set("cofinancing")}
          options={o.cofinancing} blank=""
          tip="Can you commit your OWN funds alongside an award? Scored only when a call requires a match." />
        <Choice label="Pre-financing capacity" value={f.prefinancing}
          onChange={set("prefinancing")} options={o.cofinancing} blank="— not recorded"
          tip="Can you carry costs UP FRONT and be reimbursed? Blank means the check is skipped, not assumed." />
      </Row>

      <h3 className="mt-5 mb-1 text-sm font-bold text-brand-700">Capacity</h3>
      <p className="mb-3 text-xs text-ink-500">
        0 means “not set” for every money field below. Annual budget is what you manage
        per <em>year</em>; largest grant is one award over its whole life.
      </p>
      <Row cols={3}>
        <Num label="Annual budget managed (USD/yr)" value={f.annualBudget}
          onChange={set("annualBudget")} step="100000" />
        <Num label="Largest single grant ever (USD)" value={f.largestGrant}
          onChange={set("largestGrant")} step="100000" />
        <Num label="Indirect cost %" value={f.indirectCostRate}
          onChange={set("indirectCostRate")} step="0.5"
          hint="Blank skips the check; 0 means you recover no overhead and IS scored." />
      </Row>
      <Row cols={3}>
        <Num label="Smallest grant managed (USD)" value={f.lowestGrant}
          onChange={set("lowestGrant")} step="10000" />
        <Num label="Number of grants managed" value={f.grantsCount}
          onChange={set("grantsCount")} />
        <Choice label="Org stage" value={f.stage} onChange={set("stage")}
          options={o.stages} blank="" tip="Some funders fund early-stage organisations only." />
      </Row>

      <h3 className="mt-5 mb-1 text-sm font-bold text-brand-700">Preferred award size (USD)</h3>
      <p className="mb-3 text-xs text-ink-500">
        Low = you won't apply below it. Mid = the sweet spot. Max = the top of the
        comfortable range. Leave 0 for the defaults.
      </p>
      <Row cols={3}>
        <Num label="Target — low" value={f.minTarget} onChange={set("minTarget")} step="50000" />
        <Num label="Target — mid" value={f.midTarget} onChange={set("midTarget")} step="50000" />
        <Num label="Target — max" value={f.maxTarget} onChange={set("maxTarget")} step="50000" />
      </Row>

      <h3 className="mt-5 mb-2 text-sm font-bold text-brand-700">Eligibility facts</h3>
      <Checks items={[
        ["independentEntity", "Independent entity", "Not a branch or affiliate of a larger INGO."],
        ["samUei", "Holds SAM.gov / UEI", ""],
        ["taxExempt", "Tax-exempt (501c3 or equivalent)", ""],
        ["establishedPi", "Has a well-established PI",
          "Satisfies a call requiring an individual or PI based in an in-scope country."],
      ]} f={f} set={set} />

      <h3 className="mt-5 mb-1 text-sm font-bold text-brand-700">Compliance credentials</h3>
      <p className="mb-2 text-xs text-ink-500">
        Hard gates you must <em>already</em> hold. If a donor requires one and the box is
        unchecked, that requirement scores 0.
      </p>
      <Checks items={[
        ["auditedFinancials", "Audited financials", ""],
        ["auditReport", "Audit report on file", ""],
        ["safeguardingPolicy", "Safeguarding / PSEA policy", ""],
        ["partnerMou", "Partner MOU(s)", ""],
        ["govtMou", "Government MOU", ""],
        ["govtEndorsement", "Govt endorsement letter", ""],
      ]} f={f} set={set} />

      <div className="mt-5">
        <MultiSelect
          label="Funding routes we can receive through"
          options={o.routes.map(([t]) => t)} value={f.fundingRoutes}
          onChange={set("fundingRoutes")} format={(t) => routeLabels[t] ?? t}
          help="A call whose only routes you can't use scores 0 on the MUST-5 route gate."
        />
      </div>

      <h3 className="mt-6 mb-2 text-sm font-bold text-brand-700">Geography &amp; languages</h3>
      <Row>
        <Picks label="Countries registered" value={f.registeredCountries}
          onChange={set("registeredCountries")} options={o.countries}
          help="Legal-registration jurisdictions." />
        <Picks label="Countries of operation" value={f.operatingCountries}
          onChange={set("operatingCountries")} options={o.countries}
          help="Where you operate directly — drives geographic fit (MUST-4)." />
      </Row>
      <Row>
        <Picks label="Proposal languages" value={f.proposalLanguages}
          onChange={set("proposalLanguages")} options={o.languages}
          help="Languages you can write a competitive bid in." />
        <div className="mb-4">
          <Lbl hint="Matching the donor's HQ country boosts competitiveness. Distinct from the US-entity gate.">
            HQ country
          </Lbl>
          <Select value={f.hqCountry} onChange={(e) => set("hqCountry")(e.target.value)}>
            <option value="(none)">(none)</option>
            {o.countries.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </div>
      </Row>

      <Matrix
        options={o}
        title="Domains / areas of expertise (track record)"
        blurb="Where you have demonstrated experience. Grade 0–5 how strong the track record is — this drives competitiveness."
        selected={f.domains} ratings={f.domainRatings}
        onSelected={set("domains")} onRatings={set("domainRatings")}
      />
      <Matrix
        options={o}
        title="Strategic priority areas of interest"
        blurb="Where your strategy says you want to work, footprint or not. Drives strategic fit (MUST-2), matched to each donor's graded priorities."
        selected={f.priorities} ratings={f.priorityRatings}
        onSelected={set("priorities")} onRatings={set("priorityRatings")}
      />

      <PartnerTable
        rows={f.partners} onChange={set("partners")} options={o}
      />

      <h3 className="mt-6 mb-2 text-sm font-bold text-brand-700">Donor relationships</h3>
      <Row>
        <Picks label="Active donors — currently funding us" value={f.activeDonors}
          onChange={set("activeDonors")} options={o.donors} allowNew
          help="Donors with an OPEN grant right now. If a call bars current grantees, listing one here disqualifies you." />
        <Picks label="Donors we've engaged with — no grant yet" value={f.engagedDonors}
          onChange={set("engagedDonors")} options={o.donors} allowNew
          help="Meetings, concept notes, expressions of interest. Counts as a warm relationship (PREFER-7)." />
      </Row>
      <Row>
        <Picks label="Donors we've already won from" value={f.funderHistory}
          onChange={set("funderHistory")} options={o.donors} allowNew
          help="Past and current funders — drives funder relationship." />
        <Picks label="Leadership authorized signatory — donors we can sign for"
          value={f.authorizedSignatoryDonors} onChange={set("authorizedSignatoryDonors")}
          options={o.donors} allowNew
          help="A call requiring one scores 1 only if its donor is listed here. If a PARENT organization holds it, record it there — a child inherits it." />
      </Row>
      <Picks label="Donor portal registration active" value={f.donorRegistrations}
        onChange={set("donorRegistrations")} options={o.portals} allowNew
        help="Portals where your registration is active, as bare hosts (grants.gov, sam.gov)." />

      <SaveBar
        label="Save fit profile" state={state}
        onSave={() => run("Fit profile saved.", async () => {
          const r = await saveSetupProfile(toPayload(f));
          if (r.profile) {
            onSaved({
              ...data, profile: r.profile,
              identity: r.identity ?? data.identity,
              partners: r.partners ?? data.partners,
            });
          }
          return r;
        })}
      />
      {/* The one thing a reader of this form cannot see: it replaces the whole blob. */}
      <p className="mt-3 text-xs text-ink-500">
        Saving writes the entire fit profile, not only what you changed — every field on
        this tab is sent each time. {Object.keys(p).length} fields are stored.
      </p>
    </Card>
  );
}

/** A row of checkboxes bound to the fit form. */
function Checks({ items, f, set }: {
  items: [string, string, string][];
  f: Record<string, unknown>;
  set: (k: never) => (v: unknown) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([key, label, hint]) => (
        <label key={key} className="flex items-start gap-2.5 text-sm text-ink-700">
          <input
            type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-brand-700"
            checked={!!f[key]}
            onChange={(e) => set(key as never)(e.target.checked)}
          />
          <span>
            {label}
            {hint && <span className="block text-xs text-ink-500">{hint}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

/** A multi-select that keeps a stored value the vocabulary has since dropped. */
function Picks({ label, value, onChange, options, help, allowNew }: {
  label: string; value: string[]; onChange: (v: string[]) => void;
  options: string[]; help?: string; allowNew?: boolean;
}) {
  const opts = useMemo(() => [...new Set([...options, ...value])], [options, value]);
  return (
    <div className="mb-4">
      <MultiSelect label={label} options={opts} value={value} onChange={onChange}
        help={help} allowNew={allowNew} />
      {help && <p className="mt-1.5 text-xs text-ink-500">{help}</p>}
    </div>
  );
}

/**
 * The program-area matrix: pick areas, then grade each 0–5.
 *
 * The KEYS come from the generated taxonomy and are never composed here — a stored area
 * is "IDs - Malaria & NTDs" and that exact string is what the classifier matches an
 * organisation's areas against a call's and a donor's.
 */
function Matrix({ options, title, blurb, selected, ratings, onSelected, onRatings }: {
  options: SetupOptions; title: string; blurb: string;
  selected: string[]; ratings: Record<string, number>;
  onSelected: (v: string[]) => void; onRatings: (v: Record<string, number>) => void;
}) {
  const all = useMemo(
    () => options.areaTaxonomy.flatMap(([, keys]) => keys), [options.areaTaxonomy]);
  const opts = useMemo(() => [...new Set([...all, ...selected])], [all, selected]);
  return (
    <div className="mt-6">
      <h3 className="mb-1 text-sm font-bold text-brand-700">{title}</h3>
      <p className="mb-3 text-xs text-ink-500">{blurb}</p>
      <MultiSelect
        label="Areas" options={opts} value={selected} onChange={(v) => {
          onSelected(v);
          // Drop grades for areas no longer selected, so an unselect does not leave a
          // rating behind that nothing on screen explains.
          onRatings(Object.fromEntries(
            Object.entries(ratings).filter(([k]) => v.includes(k))));
        }}
        format={(k) => {
          const { sub, cat } = areaLabel(k, options.categoryNames);
          return cat ? `${sub} · ${cat}` : sub;
        }}
      />
      {selected.length > 0 && (
        <div className="mt-3 space-y-1.5 rounded-lg border border-ink-200 bg-ink-50 p-3">
          {selected.map((k) => {
            const { sub, cat } = areaLabel(k, options.categoryNames);
            const v = ratings[k] ?? 0;
            return (
              <div key={k} className="flex flex-wrap items-center gap-3">
                <div className="min-w-48 flex-1 text-sm text-ink-800">
                  {sub}
                  {cat && <span className="ml-1.5 text-xs text-ink-400">{cat}</span>}
                </div>
                <input
                  type="range" min={0} max={5} step={1} value={v}
                  aria-label={`${sub} rating`}
                  className="h-1.5 w-40 accent-accent-600"
                  onChange={(e) =>
                    onRatings({ ...ratings, [k]: Number(e.target.value) })}
                />
                <Badge tone={v >= 4 ? "good" : v >= 2 ? "accent" : "neutral"}>
                  {v}/5
                </Badge>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Affiliated partners — one table, name · type · status · country.
 *
 * It is seeded by the server from the structured `partners` PLUS the legacy flat lists,
 * and the save writes `partners` FROM this table. That is why the seed matters: a legacy
 * partner this table never showed would be gone the first time anybody pressed save.
 */
function PartnerTable({ rows, onChange, options }: {
  rows: OrgPartner[]; onChange: (v: OrgPartner[]) => void; options: SetupOptions;
}) {
  const edit = (i: number, patch: Partial<OrgPartner>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="mt-6">
      <h3 className="mb-1 text-sm font-bold text-brand-700">
        Affiliated partners and collaborators
      </h3>
      <p className="mb-3 text-xs text-ink-500">
        Type and country power donor conditions that require a <em>specific</em> partner
        (NIHR wanting a UK academic institution, say). Any partner also counts toward
        geographic fit “via a partner”.
      </p>
      <div className="overflow-x-auto rounded-lg border border-ink-200">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs font-semibold text-ink-600 uppercase">
            <tr>
              <th className="px-3 py-2">Partner name</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Country</th>
              <th className="w-10 px-3 py-2"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-4 text-ink-400">No partners recorded.</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={i} className="align-top">
                <td className="px-3 py-2">
                  <input className={fieldClass} value={r.name}
                    onChange={(e) => edit(i, { name: e.target.value })} />
                </td>
                <td className="px-3 py-2">
                  <Select value={r.type} onChange={(e) => edit(i, { type: e.target.value })}>
                    <option value="">—</option>
                    {options.partnerTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
                </td>
                <td className="px-3 py-2 min-w-52">
                  <MultiSelect
                    label="" options={options.partnerStatus} value={r.status}
                    onChange={(v) => edit(i, { status: v })}
                  />
                </td>
                <td className="px-3 py-2">
                  <Select value={r.country}
                    onChange={(e) => edit(i, { country: e.target.value })}>
                    <option value="">—</option>
                    {options.countries.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button" aria-label={`Remove ${r.name || "partner"}`}
                    className="rounded p-1.5 text-ink-400 transition-colors hover:bg-bad-50 hover:text-bad-700"
                    onClick={() => onChange(rows.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button
        className="mt-2"
        onClick={() => onChange([...rows, { name: "", type: "", status: [], country: "" }])}
      >
        Add a partner
      </Button>
    </div>
  );
}

// ── Tab 3: Team members ──────────────────────────────────────────────────────

function TeamTab({ data, onSaved }: { data: OrgSetup; onSaved: (d: OrgSetup) => void }) {
  const [text, setText] = useState(data.team.join("\n"));
  const [state, run] = useSaver();
  // Previewed with the SAME rule the server applies, so what the box says is what lands.
  const names = useMemo(
    () => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), [text]);

  return (
    <Card className="max-w-3xl p-6">
      <Eyebrow>Team members</Eyebrow>
      <p className="mb-4 text-sm leading-relaxed text-ink-600">
        Your roster, one name per line. These replace the “Team Member 1..N” placeholders
        in the Proposal lead, Contributors and Reviewers dropdowns on both forms. Stored
        privately — never in the repository.
      </p>
      <textarea
        className={`${fieldClass} min-h-48 font-mono text-sm`} value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"Jane Doe\nJohn Smith\nAmina Bello"}
        aria-label="One team member per line"
      />
      <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-500">
        <UsersIcon className="h-3.5 w-3.5" />
        {names.length} name{names.length === 1 ? "" : "s"}. “Other” is added to the
        dropdowns automatically, so don't list it here — it is dropped on save.
      </p>
      <SaveBar
        label="Save team members" state={state}
        onSave={() => run(`Saved ${names.length} team member(s).`, async () => {
          const r = await saveSetupTeam(names);
          if (r.team) onSaved({ ...data, team: r.team });
          return r;
        })}
      />
    </Card>
  );
}

// ── form ↔ payload ───────────────────────────────────────────────────────────

/**
 * The stored profile as the form holds it.
 *
 * Numbers become STRINGS, because an empty number input is "" and that is the only way
 * to tell "cleared" from 0 — which for the indirect-cost rate is the difference between
 * a skipped MUST-5 component and a scored answer of "we recover no overhead".
 */
function fromProfile(d: OrgSetup) {
  const p = d.profile;
  return {
    legalType: s(p.org_legal_type),
    entityType: s(p.org_entity_type),
    foundingYear: n(p.org_founding_year),
    cofinancing: s(p.org_cofinancing_capacity),
    prefinancing: s(p.org_prefinance_capacity),
    indirectCostRate: n(p.org_indirect_cost_rate),
    annualBudget: n(p.org_annual_budget),
    largestGrant: n(p.org_largest_grant),
    lowestGrant: n(p.org_lowest_grant),
    grantsCount: n(p.org_grants_count),
    minTarget: n(p.org_min_target),
    midTarget: n(p.org_mid_target),
    maxTarget: n(p.org_max_target),
    independentEntity: p.org_is_independent_entity !== false,
    samUei: !!p.org_has_sam_uei,
    taxExempt: !!p.org_tax_exempt,
    stage: s(p.org_stage),
    establishedPi: !!p.org_has_established_pi,
    auditedFinancials: !!p.org_has_audited_financials,
    auditReport: !!p.org_has_audit_report,
    safeguardingPolicy: !!p.org_has_safeguarding_policy,
    partnerMou: !!p.org_has_partner_mou,
    govtMou: !!p.org_has_govt_mou,
    govtEndorsement: !!p.org_has_govt_endorsement,
    authorizedSignatoryDonors: arr(p.org_authorized_signatory_donors),
    fundingRoutes: arr(p.org_funding_routes),
    partners: d.partners,
    domains: arr(p.org_domain_expertise),
    domainRatings: numMap(p.org_domain_ratings),
    priorities: arr(p.org_priority_areas),
    priorityRatings: numMap(p.org_priority_ratings),
    operatingCountries: arr(p.org_operating_countries),
    registeredCountries: arr(p.org_registered_countries),
    donorRegistrations: arr(p.org_donor_registrations),
    funderHistory: arr(p.org_funder_history),
    activeDonors: arr(p.org_active_donors),
    engagedDonors: arr(p.org_engaged_donors),
    proposalLanguages: arr(p.proposal_languages),
    // Lives on the IDENTITY blob, not the profile — the fit tab writes it back through
    // the derived competitiveness keys. "(none)" is the editor's own empty.
    hqCountry: s(d.identity.org_hq_country) || "(none)",
  };
}

function numMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, raw] of Object.entries(v as Json)) {
      const x = Number(raw);
      if (Number.isFinite(x)) out[k] = x;
    }
  }
  return out;
}

/** The form as the route wants it. Every key, always — the blob is replaced. */
function toPayload(f: ReturnType<typeof fromProfile>): Json {
  return { ...f } as unknown as Json;
}

