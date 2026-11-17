/**
 * Settings → Setup → Scan Preferences. `views/org_setup.py`'s fourth tab.
 *
 * WHAT THESE DECIDE, and why the page says so out loud: they run at SCAN time, before
 * scoring. An opportunity that fails the country or theme gate is never inserted — it is
 * not a low score somebody can argue with, it does not exist, and no screen anywhere
 * explains a call that was never captured. The controls are therefore labelled by their
 * CONSEQUENCE rather than by their field name.
 *
 * THE DOCUMENT IS EDITED, NOT THE EFFECTIVE POLICY. `get_policies` seeds an empty
 * geography or theme scope from the organisation's own profile, so what the scan uses is
 * partly derived. Editing the derived value would turn a seed into an explicit choice the
 * moment anybody opened the tab. So the form holds the STORED document, an empty scope
 * stays visibly empty, and the seeded values are shown beside it as what the scan is
 * doing today.
 *
 * TWO OF THE FOUR SAVES ARE DEPLOYMENT-WIDE. The search terms and the currency table are
 * not tenant-scoped — one deployment, one exchange-rate table — and each says so next to
 * its own button rather than relying on a reader to know.
 */
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Ban, CheckCircle2, Coins, Globe2, Plus, Save, Search, Tags, Trash2,
} from "lucide-react";
import {
  fetchScanPrefs, saveCurrencies, saveScanPolicies, saveSearchTerms,
  type CurrencyRow, type ScanPrefs,
} from "../api";
import MultiSelect from "../components/MultiSelect";
import { Button, Card, Eyebrow, Notice, Spinner, fieldClass } from "../ui";

type Json = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const listOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
const dictOf = (v: unknown): Json =>
  (v && typeof v === "object" && !Array.isArray(v) ? v as Json : {});
/** A stored flag, defaulting TRUE — these are reject rules, as the server's does. */
const flag = (v: unknown) => v !== false;

const TABS = ["Countries", "Themes", "Criteria", "Search terms", "Currency"] as const;

export default function ScanPrefsTab() {
  const [data, setData] = useState<ScanPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Countries");

  const load = () => fetchScanPrefs().then((d) => { setData(d); setError(null); })
    .catch((e: unknown) =>
      setError(e instanceof Error ? e.message : "Couldn't load the scan preferences."));
  useEffect(() => { void load(); }, []);

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Spinner label="Loading the scan preferences…" />;

  return (
    <div>
      <Notice tone="brand" className="mb-4">
        These rules run <strong>during the scan, before any scoring</strong>. A call that
        fails the country or theme gate is never captured at all — it does not turn up as
        a low score you can overrule, so a scope that is too narrow is invisible rather
        than obvious.
      </Notice>
      {data.policyParseError && (
        <Notice tone="bad" className="mb-4" icon={<AlertTriangle className="h-4 w-4" />}>
          The stored policy could not be read, so the scan is falling back to the
          defaults. Saving from this tab will replace it with a readable one.
        </Notice>
      )}

      <div role="tablist" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
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
        {(tab === "Countries" || tab === "Themes" || tab === "Criteria") && (
          <PolicyForm data={data} section={tab} onSaved={load} />
        )}
        {tab === "Search terms" && <SearchTerms data={data} onSaved={load} />}
        {tab === "Currency" && <Currencies data={data} onSaved={load} />}
      </div>
    </div>
  );
}

/**
 * The policy document's three editable sections, all saved by ONE button.
 *
 * One button because the store is one document: `set_policies` writes the whole blob, so
 * a per-section save would still send everything and a reader could reasonably think it
 * had not. The button says what it covers.
 */
function PolicyForm({ data, section, onSaved }: {
  data: ScanPrefs; section: "Countries" | "Themes" | "Criteria"; onSaved: () => void;
}) {
  const o = data.options;
  const [form, setForm] = useState(() => fromStored(data));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const set = (patch: Partial<ReturnType<typeof fromStored>>) =>
    setForm((p) => ({ ...p, ...patch }));

  const save = async () => {
    setBusy(true); setDone(null); setFailed(null);
    try {
      const r = await saveScanPolicies(toPayload(form));
      setDone(r.detail);
      onSaved();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="max-w-4xl p-6">
      {section === "Countries" && (
        <>
          <div className="flex items-center gap-2.5">
            <Globe2 className="h-5 w-5 text-accent-600" />
            <Eyebrow>Where you are eligible</Eyebrow>
          </div>
          <p className="mt-1 mb-4 text-sm leading-relaxed text-ink-600">
            A call naming any of these is admitted. Leave both empty and the scan admits
            every geography — which is why an empty scope is filled from your registered
            and operating countries when you save.
          </p>
          {data.seeded.countries && (
            <Notice tone="warn" className="mb-4">
              The scan is currently gating on{" "}
              <strong>{data.effective.countries.eligible.join(", ")}</strong>, taken from
              your organisation profile because this policy names no countries. Saving
              writes that list down and makes it an explicit choice.
            </Notice>
          )}
          <Picks label="Eligible countries" value={form.eligible}
            onChange={(v) => set({ eligible: v })} options={o.countries} allowNew
            help="Exact countries you work in." />
          <Picks label="Broader regions and tiers" value={form.broadTerms}
            onChange={(v) => set({ broadTerms: v })} options={o.geoOptions} allowNew
            help="Regions, income tiers and groupings — “Sub-Saharan Africa”, “LMICs”. A region-only scope is respected and never overwritten." />
          <Check label="Admit a call that states no geography at all"
            hint="Most calls are silent about where they fund. Unchecking this rejects every one of them."
            checked={form.permissiveWhenSilent}
            onChange={(v) => set({ permissiveWhenSilent: v })} />
        </>
      )}

      {section === "Themes" && (
        <>
          <div className="flex items-center gap-2.5">
            <Tags className="h-5 w-5 text-accent-600" />
            <Eyebrow>What you work on</Eyebrow>
          </div>
          <p className="mt-1 mb-4 text-sm leading-relaxed text-ink-600">
            A call must match at least one required theme. Excluded themes are a hard
            reject, whatever else the call matches.
          </p>
          {data.seeded.themes && (
            <Notice tone="warn" className="mb-4">
              The scan is currently matching themes derived from your programme areas,
              because this policy names none. Saving writes them down.
            </Notice>
          )}
          <Picks label="Required themes — a call must match one" value={form.requiredAny}
            onChange={(v) => set({ requiredAny: v })} options={[]} allowNew
            help="Keywords matched against the call's text and tagged areas." />
          <Picks label="Excluded themes — reject on sight" value={form.excludedAny}
            onChange={(v) => set({ excludedAny: v })} options={[]} allowNew
            help="Out-of-capability work you never want captured." />

          <h3 className="mt-6 mb-2 text-sm font-bold text-brand-700">Blanket exclusions</h3>
          <div className="space-y-2">
            <Check label="Reject training-only calls" checked={form.rejectTrainingOnly}
              onChange={(v) => set({ rejectTrainingOnly: v })} />
            <Check label="Reject loans and concessional finance" checked={form.rejectLoans}
              onChange={(v) => set({ rejectLoans: v })} />
            <Check label="Reject consultancies" checked={form.rejectConsultancies}
              onChange={(v) => set({ rejectConsultancies: v })} />
            <Check label="Reject reimbursement-only funding"
              checked={form.rejectReimbursement}
              onChange={(v) => set({ rejectReimbursement: v })} />
          </div>

          <h3 className="mt-6 mb-2 text-sm font-bold text-brand-700">Applicant type</h3>
          <Picks label="Types this organisation can apply as" value={form.applicantTypes}
            onChange={(v) => set({ applicantTypes: v })}
            options={["nonprofit", "government", "higher_ed", "for_profit", "individual", "tribal"]}
            help="Leave empty and it falls back to nonprofit — an empty list would match no call's rule at all, rejecting everything." />
          <Check label="Reject a call whose applicant types none of yours match"
            checked={form.rejectApplicantMismatch}
            onChange={(v) => set({ rejectApplicantMismatch: v })} />
        </>
      )}

      {section === "Criteria" && (
        <>
          <div className="flex items-center gap-2.5">
            <Search className="h-5 w-5 text-accent-600" />
            <Eyebrow>Crawl keyword assist</Eyebrow>
          </div>
          <p className="mt-1 mb-4 text-sm leading-relaxed text-ink-600">
            Optional. The nine criteria are derived from your organisation profile first;
            these terms only refine the read of a call's own text. A{" "}
            <strong>positive</strong> term confirms a criterion that could not be derived;
            a <strong>negative</strong> one forces it to No. Neither ever overturns a value
            the profile, the call or donor intel already decided.
          </p>
          <div className="space-y-3">
            {o.criteria.map((c) => (
              <div key={c} className="rounded-lg border border-ink-200 p-3">
                <div className="mb-2 text-sm font-medium text-ink-800">
                  {o.criterionLabels[c] ?? c}
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Picks label="Positive — confirms" value={form.criteria[c]?.positive ?? []}
                    onChange={(v) => set({
                      criteria: { ...form.criteria, [c]: { ...form.criteria[c], positive: v } },
                    })} options={[]} allowNew />
                  <Picks label="Negative — red flag"
                    value={form.criteria[c]?.negative ?? []}
                    onChange={(v) => set({
                      criteria: { ...form.criteria, [c]: { ...form.criteria[c], negative: v } },
                    })} options={[]} allowNew />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mt-6 border-t border-ink-200 pt-5">
        <Button variant="primary" busy={busy} onClick={save}
          icon={<Save className="h-4 w-4" />}>
          Save scan preferences
        </Button>
        <p className="mt-2 text-xs text-ink-500">
          One document: countries, themes, exclusions, applicant types and the criteria
          terms are all saved together, whichever sub-tab you are on.
        </p>
        {done && (
          <Notice tone="good" className="mt-3" icon={<CheckCircle2 className="h-4 w-4" />}>
            {done}
          </Notice>
        )}
        {failed && <Notice tone="bad" className="mt-3">{failed}</Notice>}
      </div>
    </Card>
  );
}

// ── Search terms (deployment-wide) ───────────────────────────────────────────

function SearchTerms({ data, onSaved }: { data: ScanPrefs; onSaved: () => void }) {
  const [terms, setTerms] = useState<string[]>(data.searchTerms);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  return (
    <Card className="max-w-3xl p-6">
      <Eyebrow>Search terms</Eyebrow>
      <p className="mt-1 mb-2 text-sm leading-relaxed text-ink-600">
        When somebody runs a <em>broad</em> web search — “health”, say — it fans out into
        one RFP-framed query per term. The built-in list is fixed; these widen it.
      </p>
      <Notice tone="warn" className="mb-4">
        Deployment-wide: these apply to every organisation's searches, not only yours.
      </Notice>
      <Picks label="Custom search terms" value={terms} onChange={setTerms}
        options={[]} allowNew
        help="Type a term — a MeSH heading, a programme name — and press Enter." />
      <Button
        variant="primary" busy={busy} icon={<Save className="h-4 w-4" />}
        onClick={async () => {
          setBusy(true); setDone(null); setFailed(null);
          try {
            const r = await saveSearchTerms(terms);
            setTerms(r.terms);
            setDone(r.detail);
            onSaved();
          } catch (e) {
            setFailed(e instanceof Error ? e.message : "Save failed.");
          } finally {
            setBusy(false);
          }
        }}
      >
        Save search terms
      </Button>
      {done && <Notice tone="good" className="mt-3">{done}</Notice>}
      {failed && <Notice tone="bad" className="mt-3">{failed}</Notice>}
    </Card>
  );
}

// ── Currency (deployment-wide) ───────────────────────────────────────────────

function Currencies({ data, onSaved }: { data: ScanPrefs; onSaved: () => void }) {
  const [rows, setRows] = useState<CurrencyRow[]>(() => data.currencies.map((c) => ({
    code: s(c.code), label: s(c.label), symbol: c.symbol ?? null,
    aliases: listOf(c.aliases), usd_rate: Number(c.usd_rate) || 0,
  })));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const edit = (i: number, patch: Partial<CurrencyRow>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2.5">
        <Coins className="h-5 w-5 text-accent-600" />
        <Eyebrow>Currency rates</Eyebrow>
      </div>
      <p className="mt-1 mb-2 text-sm leading-relaxed text-ink-600">
        The USD rate is how many dollars one unit converts to — GBP 1.33 means £1 = $1.33.
        Every award size is compared in dollars, so these decide which calls clear your
        funding targets.
      </p>
      <Notice tone="warn" className="mb-4">
        Deployment-wide, and this table <strong>replaces</strong> the shipped defaults
        rather than adding to them — a currency missing here converts at 1.0 for everyone.
      </Notice>

      <div className="overflow-x-auto rounded-lg border border-ink-200">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs font-semibold text-ink-600 uppercase">
            <tr>
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Label</th>
              <th className="px-3 py-2">Symbol</th>
              <th className="px-3 py-2">Also written as</th>
              <th className="px-3 py-2">USD rate</th>
              <th className="w-10 px-3 py-2"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((r, i) => (
              <tr key={i} className="align-top">
                <td className="px-3 py-2">
                  <input className={`${fieldClass} w-24 font-mono`} value={r.code}
                    aria-label={`Code ${i + 1}`}
                    onChange={(e) => edit(i, { code: e.target.value })} />
                </td>
                <td className="px-3 py-2">
                  <input className={`${fieldClass} w-28`} value={r.label}
                    aria-label={`Label ${i + 1}`}
                    onChange={(e) => edit(i, { label: e.target.value })} />
                </td>
                <td className="px-3 py-2">
                  <input className={`${fieldClass} w-20`} value={s(r.symbol)}
                    aria-label={`Symbol ${i + 1}`}
                    onChange={(e) => edit(i, { symbol: e.target.value || null })} />
                </td>
                <td className="min-w-56 px-3 py-2">
                  <MultiSelect
                    label="" options={r.aliases} value={r.aliases} allowNew
                    onChange={(v) => edit(i, { aliases: v })}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number" step="0.0001" min="0.0001"
                    className={`${fieldClass} w-28 tabular-nums`} value={r.usd_rate}
                    aria-label={`USD rate ${i + 1}`}
                    onChange={(e) => edit(i, { usd_rate: Number(e.target.value) })}
                  />
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button" aria-label={`Remove ${r.code || "currency"}`}
                    className="rounded p-1.5 text-ink-400 transition-colors hover:bg-bad-50 hover:text-bad-700"
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-500">
        “Also written as” is how a call quoting <code>£</code> or <code>FCFA</code> is
        matched to a rate at all — neither string appears in any code or label, so a row
        without them converts at 1.0.
      </p>
      <Button className="mt-2" icon={<Plus className="h-4 w-4" />}
        onClick={() => setRows([...rows,
          { code: "", label: "", symbol: null, aliases: [], usd_rate: 1 }])}>
        Add a currency
      </Button>

      <div className="mt-5 border-t border-ink-200 pt-5">
        <Button
          variant="primary" busy={busy} icon={<Save className="h-4 w-4" />}
          onClick={async () => {
            setBusy(true); setDone(null); setFailed(null);
            try {
              const r = await saveCurrencies(rows);
              // The server's own answer: it upper-cases codes, drops bad rates and
              // de-duplicates. Keeping the submitted rows on screen would claim otherwise.
              setRows(r.rows);
              setDone(r.detail);
              onSaved();
            } catch (e) {
              setFailed(e instanceof Error ? e.message : "Save failed.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Save currency rates
        </Button>
        {done && (
          <Notice tone="good" className="mt-3" icon={<CheckCircle2 className="h-4 w-4" />}>
            {done}
          </Notice>
        )}
        {failed && (
          <Notice tone="bad" className="mt-3" icon={<Ban className="h-4 w-4" />}>
            {failed}
          </Notice>
        )}
      </div>
    </Card>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────────

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

function Check({ label, hint, checked, onChange }: {
  label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2.5 text-sm text-ink-700">
      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-brand-700"
        checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="block text-xs text-ink-500">{hint}</span>}
      </span>
    </label>
  );
}

/** The STORED document as the form holds it — never the effective one. */
function fromStored(data: ScanPrefs) {
  const p = data.stored;
  const countries = dictOf(p.countries);
  const themes = dictOf(p.themes);
  const exclusions = dictOf(p.exclusions);
  const eligibility = dictOf(p.eligibility);
  const storedCriteria = dictOf(p.criteria);
  const criteria: Record<string, { positive: string[]; negative: string[] }> = {};
  for (const c of data.options.criteria) {
    const rule = dictOf(storedCriteria[c]);
    criteria[c] = { positive: listOf(rule.positive), negative: listOf(rule.negative) };
  }
  return {
    eligible: listOf(countries.eligible),
    broadTerms: listOf(countries.broad_terms),
    permissiveWhenSilent: flag(countries.permissive_when_silent),
    requiredAny: listOf(themes.required_any),
    excludedAny: listOf(themes.excluded_any),
    rejectTrainingOnly: flag(exclusions.reject_training_only),
    rejectLoans: flag(exclusions.reject_loans),
    rejectConsultancies: flag(exclusions.reject_consultancies),
    rejectReimbursement: flag(exclusions.reject_reimbursement),
    applicantTypes: listOf(eligibility.org_applicant_types),
    rejectApplicantMismatch: flag(eligibility.reject_applicant_type_mismatch),
    criteria,
  };
}

/** The shape the route's `policyPayload` reads. */
function toPayload(f: ReturnType<typeof fromStored>): Json {
  return {
    countries: {
      eligible: f.eligible, broad_terms: f.broadTerms,
      permissive_when_silent: f.permissiveWhenSilent,
    },
    themes: { required_any: f.requiredAny, excluded_any: f.excludedAny },
    exclusions: {
      reject_training_only: f.rejectTrainingOnly,
      reject_loans: f.rejectLoans,
      reject_consultancies: f.rejectConsultancies,
      reject_reimbursement: f.rejectReimbursement,
    },
    eligibility: {
      org_applicant_types: f.applicantTypes,
      reject_applicant_type_mismatch: f.rejectApplicantMismatch,
    },
    criteria: f.criteria,
  };
}
