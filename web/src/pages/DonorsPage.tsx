import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, Eye, Globe, Info, Lock, RefreshCw,
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
import { Badge, Button, Card, EmptyState, IconButton, Notice, PageHeader, Spinner, fieldClass } from "../ui";

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
  const [showGuide, setShowGuide] = useState(false);
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
  const chips = activeFilters - (filters.q ? 1 : 0);

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

  if (!donors && loading) return <Spinner label="Loading donor records…" />;

  return (
    <>
      <PageHeader
        title={<span className="flex items-center gap-2.5"><Globe className="h-6 w-6 text-accent-600" strokeWidth={1.9} /> Donor mapping</span>}
        lead="Your curated list of funders and what each one requires. It is country-agnostic — the same record serves every call from that funder — and it is what eligibility screening reads when it scores an opportunity."
        actions={<Button onClick={load} busy={loading} icon={<RefreshCw className="h-4 w-4" />}>Refresh</Button>}
      />

      <button
        onClick={() => setShowGuide((o) => !o)} aria-expanded={showGuide}
        className="mb-5 flex items-center gap-2 text-sm font-medium text-accent-700 hover:underline"
      >
        <Info className="h-4 w-4" /> How to answer the requirement questions
        <ChevronDown className={`h-4 w-4 transition-transform ${showGuide ? "rotate-180" : ""}`} />
      </button>
      {showGuide && (
        <Notice tone="brand" className="mb-6">
          Leave a requirement blank only while you genuinely do not know yet — blank is what counts as missing, and
          it is the only thing that lowers a donor's completeness. <strong>Not sure</strong> is a real answer: it
          scores the same as <strong>Not required</strong>, so recording it closes the gap without pretending to a
          certainty you do not have.
        </Notice>
      )}

      {error && (
        <Notice tone="warn" role="alert" className="mb-6">
          {error}{donors ? " Showing the last copy loaded in this browser." : ""}
        </Notice>
      )}

      {rows.length === 0 && !loading && !error ? (
        <Card>
          <EmptyState icon={<Globe className="h-5 w-5" />} title="No donor records yet">
            Apply migration 020, then run <code className="rounded bg-ink-100 px-1 py-0.5 text-xs">python scripts/import_donor_intel.py</code>.
          </EmptyState>
        </Card>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Donors mapped" value={rows.length} />
            {has("donor_lmic_africa_focus") && <Metric label="LMIC / Africa focus" value={count("donor_lmic_africa_focus", "yes")} />}
            {has("donor_global_multi_country_scope") && <Metric label="Global / multi-country" value={count("donor_global_multi_country_scope", "yes")} />}
            {has("donor_verification_level") && <Metric label="High-confidence" value={count("donor_verification_level", "high")} />}
          </section>

          <Card className="mt-4">
            <button
              onClick={() => setShowChart((o) => !o)} aria-expanded={showChart}
              className="flex w-full items-center justify-between rounded-xl px-5 py-3.5 text-left text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50"
            >
              Donors by category
              <ChevronDown className={`h-4 w-4 text-ink-400 transition-transform ${showChart ? "rotate-180" : ""}`} />
            </button>
            {showChart && <div className="border-t border-ink-100 px-5 py-5"><CategoryChart counts={categories} /></div>}
          </Card>

          <section className="mt-8">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-bold text-brand-700">All donors</h2>
              <Button disabled title={EDIT_LOCK} icon={<Lock className="h-4 w-4" />}>Add donor</Button>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <div className="relative min-w-60 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-400" />
                <input
                  value={filters.q} onChange={(e) => setF("q", e.target.value)}
                  placeholder="Search name, acronym or alias" aria-label="Search donors"
                  className={`${fieldClass} pl-9`}
                />
              </div>
              <Button
                onClick={() => setShowFilters((o) => !o)}
                icon={<SlidersHorizontal className="h-4 w-4" />}
                className={showFilters || chips > 0 ? "border-accent-600/40 bg-accent-50 text-accent-700" : ""}
              >
                Filters
                {chips > 0 && (
                  <span className="ml-1 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-accent-600 px-1.5 py-0.5 text-xs font-semibold text-white">
                    {chips}
                  </span>
                )}
              </Button>
              {activeFilters > 0 && (
                <button onClick={() => setFilters(EMPTY_FILTERS)} className="text-sm text-ink-500 underline hover:text-ink-700">
                  Clear all
                </button>
              )}
            </div>

            {showFilters && (
              <Card className="mt-3 grid gap-4 p-5 md:grid-cols-2 lg:grid-cols-3">
                <MultiSelect label="Category" options={categories.map(([c]) => c).sort()} value={filters.categories} onChange={(v) => setF("categories", v)} />
                <MultiSelect label="Verification" options={verificationLevels} value={filters.verification} onChange={(v) => setF("verification", v)} />
                <MultiSelect label="Strategic priority area" options={PA_CATEGORIES} value={filters.areas} onChange={(v) => setF("areas", v)}
                  help="Donors whose priority program areas fall in this taxonomy category." />
                <MultiSelect label="Eligible applicant type" options={Object.keys(APPLICANT_FLAG)} value={filters.applicant} onChange={(v) => setF("applicant", v)}
                  help="Donors whose eligibility allows this applicant type." />
                <MultiSelect label="Funds in (region / country)" options={GEO_OPTIONS} value={filters.fundsIn} onChange={(v) => setF("fundsIn", v)}
                  help="UN region/tier or country; matches donors that fund there (region ↔ country expansion)." />
              </Card>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-ink-600">
                <strong className="text-ink-900">{filtered.length}</strong> of {rows.length} donors
                {selected.size > 0 && <> · <strong className="text-ink-900">{selectedRows.length}</strong> selected</>}
                {filtered.length > 0 && (
                  <button
                    onClick={() => setSelected(allSelected ? new Set() : new Set(filtered.map((r) => r.canonical_key)))}
                    className="ml-2 text-accent-700 underline hover:text-accent-800"
                  >
                    {allSelected ? "Clear selection" : `Select all ${filtered.length}`}
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selectedRows.length === 1 && (
                  <Button variant="primary" size="sm" onClick={() => setViewing(selectedRows[0])} icon={<Eye className="h-4 w-4" />}>
                    View
                  </Button>
                )}
                {selectedRows.length > 0 && (
                  <Button size="sm" onClick={() => share(selectedRows)} icon={<Share2 className="h-4 w-4" />}>
                    Share{selectedRows.length > 1 ? ` ${selectedRows.length}` : ""} (.md)
                  </Button>
                )}
                {selectedRows.length > 0 && (
                  <Button size="sm" disabled title={EDIT_LOCK} icon={<Lock className="h-4 w-4" />}>Edit / Delete</Button>
                )}
              </div>
            </div>

            <Card className="mt-3 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-sm">
                  <thead>
                    <tr className="border-b border-ink-200 bg-ink-50 text-left text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
                      <th className="w-10 px-4 py-3">
                        <input
                          type="checkbox" checked={pageAllSelected} onChange={togglePage}
                          aria-label="Select this page" className="h-4 w-4 accent-[#117996]"
                        />
                      </th>
                      <th className="px-4 py-3">Donor</th>
                      <th className="px-4 py-3">Short</th>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3">Verification</th>
                      <th className="px-4 py-3">Website</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.length === 0 && (
                      <tr><td colSpan={6} className="px-4 py-14 text-center text-ink-500">No donors match these filters.</td></tr>
                    )}
                    {pageRows.map((r) => {
                      const cat = normalizeCategory(r.donor_category);
                      const web = webUrl(r.donor_website);
                      const on = selected.has(r.canonical_key);
                      return (
                        <tr
                          key={r.canonical_key}
                          className={`border-b border-ink-100 transition-colors last:border-0 ${on ? "bg-brand-50" : "hover:bg-ink-50"}`}
                        >
                          <td className="px-4 py-3">
                            <input
                              type="checkbox" checked={on} onChange={() => toggle(r.canonical_key)}
                              aria-label={`Select ${String(r.donor ?? "")}`} className="h-4 w-4 accent-[#117996]"
                            />
                          </td>
                          <td className="px-4 py-3">
                            <button onClick={() => setViewing(r)} className="text-left font-medium text-brand-700 hover:text-accent-700 hover:underline">
                              {String(r.donor ?? "—")}
                            </button>
                          </td>
                          <td className="px-4 py-3 text-ink-600">{String(r.donor_short ?? "")}</td>
                          <td className="px-4 py-3 text-ink-600">{cat === UNCATEGORISED ? <span className="text-ink-400">{cat}</span> : cat}</td>
                          <td className="px-4 py-3"><Verification level={r.donor_verification_level} /></td>
                          <td className="px-4 py-3">
                            {web
                              ? <a href={web} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-700 hover:underline">Open <ExternalLink className="h-3.5 w-3.5" /></a>
                              : <span className="text-ink-300">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-ink-600">
              <span>
                Showing {pageRows.length ? (Math.min(page, pages) - 1) * PER_PAGE + 1 : 0}–{(Math.min(page, pages) - 1) * PER_PAGE + pageRows.length} of {filtered.length}
              </span>
              <div className="flex items-center gap-1">
                <IconButton label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </IconButton>
                <span className="px-2 tabular-nums">Page {Math.min(page, pages)} of {pages}</span>
                <IconButton label="Next page" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </IconButton>
              </div>
            </div>

            <div className="mt-8 border-t border-ink-200 pt-5">
              <Button
                onClick={() => download("donor_intelligence_mapping.csv", toCsv(filtered, schema.columns), "text/csv")}
                title="Exports every row in the current (filtered) table — all pages, all columns. Clear filters first to export the whole dataset."
                icon={<Download className="h-4 w-4" />}
              >
                Download all {filtered.length} donors (CSV)
              </Button>
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
    <Card className="p-5">
      <div className="text-xs font-medium tracking-wide text-ink-500 uppercase">{label}</div>
      <div className="mt-1.5 text-3xl font-bold tabular-nums text-brand-700">{value}</div>
    </Card>
  );
}

function Verification({ level }: { level: unknown }) {
  const v = String(level ?? "").trim().toLowerCase();
  if (!v) return <span className="text-ink-300">—</span>;
  const tone = v === "high" ? "good" : v === "medium" ? "warn" : v === "low" ? "bad" : "neutral";
  return <Badge tone={tone}>{v}</Badge>;
}
