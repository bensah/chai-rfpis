import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, Eye, Loader2, Lock, RefreshCw,
  Search, Share2, SlidersHorizontal,
} from "lucide-react";
import { cachedDonors, fetchDonors } from "../api";
import CategoryChart from "../components/CategoryChart";
import DonorDialog from "../components/DonorDialog";
import MultiSelect from "../components/MultiSelect";
import {
  APPLICANT_FLAG, applyFilters, buildSchema, download, EMPTY_FILTERS, normalizeCategory, summaryLines,
  toCsv, UNCATEGORISED, webUrl, type Donor, type Filters,
} from "../donors/model";
import { GEO_OPTIONS, PA_CATEGORIES } from "../donors/vocab";

const PER_PAGE = 10;
const EDIT_LOCK =
  "This React preview is read-only. Add, edit, suggest and delete still happen in the main RFPIS app.";

export default function DonorsPage() {
  const [donors, setDonors] = useState<Donor[] | null>(() => cachedDonors());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<Donor | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchDonors()
      .then((d) => setDonors(d))
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load donor records."))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const rows = useMemo(() => donors ?? [], [donors]);
  const schema = useMemo(() => buildSchema(rows), [rows]);
  const filtered = useMemo(() => applyFilters(rows, filters, schema), [rows, filters, schema]);
  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const pageRows = filtered.slice((Math.min(page, pages) - 1) * PER_PAGE, Math.min(page, pages) * PER_PAGE);

  useEffect(() => setPage(1), [filters]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const c = normalizeCategory(r.donor_category);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const verificationLevels = useMemo(
    () => [...new Set(rows.map((r) => r.donor_verification_level).filter((v): v is string => typeof v === "string" && !!v))].sort(),
    [rows]);

  const count = (col: string, val: string) => rows.filter((r) => r[col] === val).length;
  const has = (col: string) => schema.columns.includes(col);
  const setF = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const activeFilters = Object.values(filters).filter((v) => (Array.isArray(v) ? v.length : v)).length;

  const selectedRows = filtered.filter((r) => selected.has(r.canonical_key));
  const allSelected = filtered.length > 0 && selectedRows.length === filtered.length;
  const pageAllSelected = pageRows.length > 0 && pageRows.every((r) => selected.has(r.canonical_key));
  const toggle = (k: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
  const togglePage = () => setSelected((s) => {
    const n = new Set(s);
    for (const r of pageRows) {
      if (pageAllSelected) n.delete(r.canonical_key); else n.add(r.canonical_key);
    }
    return n;
  });

  const share = (list: Donor[]) => {
    const md = list.map((r) => summaryLines(r, schema).join("\n")).join("\n\n---\n\n");
    const name = list.length === 1
      ? `${String(list[0].donor_short || list[0].donor || "donor").trim().replace(/ /g, "_")}.md`
      : "donors_selected.md";
    download(name, md, "text/markdown");
  };

  if (!donors && loading) {
    return (
      <div className="flex items-center gap-2 py-24 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading donor records…
      </div>
    );
  }

  return (
    <>
      <section className="pt-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-3xl font-bold text-navy">Your Donor Mapping</h1>
          <button
            onClick={load} disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
        <p className="mt-2 max-w-4xl text-sm text-slate-600">
          Your curated list of funders and what each one requires. It is country-agnostic — the same donor
          record serves every call from that funder — and it is what the eligibility screening reads when it
          scores an opportunity.
        </p>
        <p className="mt-2 max-w-4xl text-sm text-slate-600">
          <strong>On the requirement questions:</strong> leave one blank only while you genuinely do not know
          yet — blank is what counts as missing, and it is the only thing that lowers a donor's completeness.{" "}
          <strong>Not sure</strong> is a real answer: it scores the same as <strong>Not required</strong>, so
          recording it closes the gap without pretending to a certainty you do not have.
        </p>
        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {error}{donors ? " Showing the last copy loaded in this browser." : ""}
          </p>
        )}
      </section>

      {rows.length === 0 && !loading && !error ? (
        <p className="mt-8 rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-800">
          No donor records yet. Apply migration 020, then run <code>python scripts/import_donor_intel.py</code>.
        </p>
      ) : (
        <>
          <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Donors mapped" value={rows.length} />
            {has("donor_lmic_africa_focus") && <Metric label="LMIC / Africa focus" value={count("donor_lmic_africa_focus", "yes")} />}
            {has("donor_global_multi_country_scope") && <Metric label="Global / multi-country" value={count("donor_global_multi_country_scope", "yes")} />}
            {has("donor_verification_level") && <Metric label="High-confidence" value={count("donor_verification_level", "high")} />}
          </section>

          <Collapsible title="Donors by category" open={showChart} onToggle={() => setShowChart((o) => !o)}>
            <CategoryChart counts={categories} />
          </Collapsible>

          <section className="mt-8 border-t border-slate-200 pt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-bold text-navy">All donors</h2>
              <button disabled title={EDIT_LOCK} className="flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-400">
                <Lock className="h-4 w-4" /> Add donor
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <div className="relative min-w-60 flex-1">
                <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
                <input
                  value={filters.q} onChange={(e) => setF("q", e.target.value)}
                  placeholder="Search name / acronym / alias"
                  className="w-full rounded-lg border border-slate-300 py-2 pr-3 pl-9 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                />
              </div>
              <button
                onClick={() => setShowFilters((o) => !o)}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm ${showFilters || activeFilters > (filters.q ? 1 : 0) ? "border-brand bg-brand-soft text-brand" : "border-slate-300 text-slate-700 hover:bg-slate-50"}`}
              >
                <SlidersHorizontal className="h-4 w-4" /> Filters
                {activeFilters - (filters.q ? 1 : 0) > 0 && <span className="rounded-full bg-brand px-1.5 text-xs text-white">{activeFilters - (filters.q ? 1 : 0)}</span>}
              </button>
              {activeFilters > 0 && (
                <button onClick={() => setFilters(EMPTY_FILTERS)} className="text-sm text-slate-500 underline hover:text-slate-700">
                  Clear all
                </button>
              )}
            </div>

            {showFilters && (
              <div className="mt-3 grid gap-4 rounded-xl border border-slate-200 bg-surface p-4 md:grid-cols-2 lg:grid-cols-3">
                <MultiSelect label="Category" options={categories.map(([c]) => c).sort()} value={filters.categories} onChange={(v) => setF("categories", v)} />
                <MultiSelect label="Verification" options={verificationLevels} value={filters.verification} onChange={(v) => setF("verification", v)} />
                <MultiSelect label="Strategic priority area" options={PA_CATEGORIES} value={filters.areas} onChange={(v) => setF("areas", v)}
                  help="Donors whose priority program areas fall in this taxonomy category." />
                <MultiSelect label="Eligible applicant type" options={Object.keys(APPLICANT_FLAG)} value={filters.applicant} onChange={(v) => setF("applicant", v)}
                  help="Donors whose eligibility allows this applicant type." />
                <MultiSelect label="Funds in (region / country)" options={GEO_OPTIONS} value={filters.fundsIn} onChange={(v) => setF("fundsIn", v)}
                  help="UN region/tier or country; matches donors that fund there (region ↔ country expansion)." />
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-slate-600">
                <strong className="text-slate-900">{filtered.length}</strong> of {rows.length} donors
                {selected.size > 0 && <> · <strong className="text-slate-900">{selectedRows.length}</strong> selected</>}
                {filtered.length > 0 && (
                  <button
                    onClick={() => setSelected(allSelected ? new Set() : new Set(filtered.map((r) => r.canonical_key)))}
                    className="ml-2 text-brand underline hover:text-brand-dark"
                  >
                    {allSelected ? "Clear selection" : `Select all ${filtered.length}`}
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selectedRows.length === 1 && (
                  <ActionButton onClick={() => setViewing(selectedRows[0])} icon={<Eye className="h-4 w-4" />}>View</ActionButton>
                )}
                {selectedRows.length > 0 && (
                  <ActionButton onClick={() => share(selectedRows)} icon={<Share2 className="h-4 w-4" />}>
                    Share{selectedRows.length > 1 ? ` ${selectedRows.length}` : ""} (.md)
                  </ActionButton>
                )}
                {selectedRows.length > 0 && (
                  <button disabled title={EDIT_LOCK} className="flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-400">
                    <Lock className="h-4 w-4" /> Edit / Delete
                  </button>
                )}
              </div>
            </div>

            <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[44rem] text-sm">
                <thead className="bg-surface text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  <tr>
                    <th className="w-10 px-3 py-2.5">
                      <input type="checkbox" checked={pageAllSelected} onChange={togglePage} aria-label="Select this page" className="accent-brand" />
                    </th>
                    <th className="px-3 py-2.5">Donor</th>
                    <th className="px-3 py-2.5">Short</th>
                    <th className="px-3 py-2.5">Category</th>
                    <th className="px-3 py-2.5">Verification</th>
                    <th className="px-3 py-2.5">Website</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.length === 0 && (
                    <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-500">No donors match these filters.</td></tr>
                  )}
                  {pageRows.map((r) => {
                    const cat = normalizeCategory(r.donor_category);
                    const web = webUrl(r.donor_website);
                    const on = selected.has(r.canonical_key);
                    return (
                      <tr key={r.canonical_key} className={`border-t border-slate-100 ${on ? "bg-brand-soft/60" : "hover:bg-slate-50"}`}>
                        <td className="px-3 py-2.5">
                          <input type="checkbox" checked={on} onChange={() => toggle(r.canonical_key)} aria-label={`Select ${String(r.donor ?? "")}`} className="accent-brand" />
                        </td>
                        <td className="px-3 py-2.5">
                          <button onClick={() => setViewing(r)} className="text-left font-medium text-navy hover:text-brand hover:underline">
                            {String(r.donor ?? "—")}
                          </button>
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">{String(r.donor_short ?? "")}</td>
                        <td className="px-3 py-2.5 text-slate-600">{cat === UNCATEGORISED ? <span className="text-slate-400">{cat}</span> : cat}</td>
                        <td className="px-3 py-2.5"><Verification level={r.donor_verification_level} /></td>
                        <td className="px-3 py-2.5">
                          {web
                            ? <a href={web} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">Open <ExternalLink className="h-3.5 w-3.5" /></a>
                            : <span className="text-slate-300">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
              <span>
                Showing {pageRows.length ? (Math.min(page, pages) - 1) * PER_PAGE + 1 : 0}–{(Math.min(page, pages) - 1) * PER_PAGE + pageRows.length} of {filtered.length}
              </span>
              <div className="flex items-center gap-1">
                <PageButton disabled={page <= 1} onClick={() => setPage((p) => p - 1)} label="Previous page"><ChevronLeft className="h-4 w-4" /></PageButton>
                <span className="px-2">Page {Math.min(page, pages)} of {pages}</span>
                <PageButton disabled={page >= pages} onClick={() => setPage((p) => p + 1)} label="Next page"><ChevronRight className="h-4 w-4" /></PageButton>
              </div>
            </div>

            <div className="mt-6 border-t border-slate-200 pt-4">
              <button
                onClick={() => download("donor_intelligence_mapping.csv", toCsv(filtered, schema.columns), "text/csv")}
                title="Exports every row in the current (filtered) table — all pages, all columns. Clear filters first to export the whole dataset."
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                <Download className="h-4 w-4" /> Download all {filtered.length} donors (CSV)
              </button>
            </div>
          </section>
        </>
      )}

      {viewing && <DonorDialog row={viewing} schema={schema} onClose={() => setViewing(null)} onShare={() => share([viewing])} />}
    </>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-200 p-4">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-navy">{value}</div>
    </div>
  );
}

function Collapsible({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <section className="mt-4 rounded-xl border border-slate-200">
      <button onClick={onToggle} aria-expanded={open} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-50">
        {title}
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="border-t border-slate-100 px-4 py-4">{children}</div>}
    </section>
  );
}

function Verification({ level }: { level: unknown }) {
  const v = String(level ?? "").trim().toLowerCase();
  if (!v) return <span className="text-slate-300">—</span>;
  const tone = v === "high" ? "bg-green-50 text-green-700" : v === "medium" ? "bg-amber-50 text-amber-700" : v === "low" ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-600";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{v}</span>;
}

function ActionButton({ onClick, icon, children }: { onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 rounded-lg border border-brand bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
      {icon} {children}
    </button>
  );
}

function PageButton({ disabled, onClick, label, children }: { disabled: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button disabled={disabled} onClick={onClick} aria-label={label} className="rounded-lg border border-slate-200 p-1.5 hover:bg-slate-50 disabled:opacity-40">
      {children}
    </button>
  );
}
