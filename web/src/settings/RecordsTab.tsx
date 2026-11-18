/**
 * Settings → Records → Data. `app_pages/admin.py`, the `_DATA_SPECS` branch.
 *
 * ONE GRID, DRIVEN BY A SPEC. Which columns show, what they are called, which parse as
 * dates, what a search looks at, which offer a dropdown, and what the editor writes all
 * come from the server with the rows. Nothing about any particular table is written into
 * this file — add a table to `_DATA_SPECS` in admin.py, re-run the generator, and it
 * appears here with its filters and its editor already working.
 *
 * That is not elegance for its own sake. The alternative is four hand-built grids, and
 * the first one somebody forgets to update is a table whose new column is invisible in
 * one app and editable in the other.
 *
 * TWO BRANCHES ARE NOT TABLES. "Screened Solicitations" is the opportunity line-list,
 * which has its own page — the route says so and this links across rather than drawing a
 * second grid over the same rows. "Extracted Solicitations" is the global raw store, and
 * it is read-only because a scan is what writes it.
 */
import { useEffect, useMemo, useState } from "react";
import { Database, ExternalLink, Pencil, Save, Search, Trash2, X } from "lucide-react";
import {
  deleteRecord, fetchRecords, saveRecord,
  type RecordSpec, type RecordsPage,
} from "../api";
import { hrefOf } from "../router";
import {
  Badge, Button, Card, Eyebrow, LinkButton, Notice, Select, Spinner, field, fieldClass,
} from "../ui";

type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/**
 * The picker's options.
 *
 * Hard-coded here ONLY as the opening request; every later one uses the label the server
 * echoed back. The list itself is the generated `RECORD_OPTIONS`, served with the first
 * response, so a table added in admin.py appears without touching this file.
 */
const FIRST = "Meeting Logs";

export default function RecordsTab() {
  const [options, setOptions] = useState<string[]>([]);
  const [table, setTable] = useState(FIRST);
  const [page, setPage] = useState<RecordsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const load = async (name: string) => {
    setBusy(true); setError(null);
    try {
      const p = await fetchRecords(name);
      setPage(p);
      // The option list rides along with the first answer rather than a second request:
      // it is a generated constant, and two round trips for one page of a settings
      // screen is two chances to half-load it.
      if (p.options) setOptions(p.options);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load that table.");
      setPage(null);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void load(table); }, [table]);

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <Eyebrow>Records</Eyebrow>
        <p className="mb-4 text-sm leading-relaxed text-ink-600">
          The tables behind the app, as an administrator sees them — every row, including
          the ones an Excel sync wrote. The task-shaped views live on their own pages;
          this is the table itself.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            className="w-auto min-w-56" value={table} aria-label="Table"
            onChange={(e) => setTable(e.target.value)}
          >
            {(options.length ? options : [table]).map((o) => <option key={o}>{o}</option>)}
          </Select>
          {page?.total !== undefined && page.kind !== "screened" && (
            <Badge tone="neutral">{page.total} row{page.total === 1 ? "" : "s"}</Badge>
          )}
          {page?.truncated && (
            <Badge tone="warn">showing the first {page.rows.length}</Badge>
          )}
        </div>

        {error && <Notice tone="bad" className="mt-4">{error}</Notice>}
        {busy && <div className="mt-4"><Spinner label="Loading the table…" /></div>}

        {!busy && page?.kind === "screened" && (
          <div className="mt-4">
            <Notice tone="brand">{page.note}</Notice>
            <LinkButton href={hrefOf("opportunities")} variant="primary" className="mt-3"
              icon={<Database className="h-4 w-4" />}>
              Open the opportunity list
            </LinkButton>
          </div>
        )}

        {!busy && page?.kind === "extracted" && (
          <ExtractedGrid page={page} />
        )}

        {!busy && page?.kind === "aux" && page.spec && (
          <AuxGrid page={page} spec={page.spec} onChanged={() => void load(table)} />
        )}
      </Card>
    </div>
  );
}

// ── The global raw store ─────────────────────────────────────────────────────

function ExtractedGrid({ page }: { page: RecordsPage }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("All");
  const cols = page.columns ?? [];
  // The same four columns the Streamlit branch searches, and the same status filter.
  const shown = useMemo(() => page.rows.filter((r) => {
    const needle = q.trim().toLowerCase();
    if (needle) {
      const blob = ["opportunity_name", "funder_name", "call_geographic_scope",
        "solicitation_type"].map((c) => s(r[c])).join(" ").toLowerCase();
      if (!blob.includes(needle)) return false;
    }
    return status === "All" || s(r.funding_status) === status;
  }), [page.rows, q, status]);

  return (
    <div className="mt-4">
      <Notice tone="brand">{page.note}</Notice>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ}
          placeholder="malaria, Gates, Mali, LMICs" />
        <Select className="w-auto" value={status} aria-label="Status"
          onChange={(e) => setStatus(e.target.value)}>
          {["All", "Open", "Closed"].map((o) => <option key={o}>{o}</option>)}
        </Select>
        <ExportButton rows={shown} columns={cols} name="extracted_solicitations" />
      </div>
      <p className="mt-2 text-xs text-ink-500">
        {shown.length} of {page.total} extracted solicitations, all geographies.
      </p>
      <Grid
        rows={shown.slice(0, 200)} columns={cols}
        label={(c) => c.replace(/_/g, " ")}
        linkColumn="opportunity_url"
      />
      {shown.length > 200 && (
        <p className="mt-2 text-xs text-ink-500">
          Showing the first 200. Narrow the search, or export the {shown.length} matching
          rows in full.
        </p>
      )}
    </div>
  );
}

// ── An editable auxiliary table ──────────────────────────────────────────────

function AuxGrid({ page, spec, onChanged }: {
  page: RecordsPage; spec: RecordSpec; onChanged: () => void;
}) {
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [editing, setEditing] = useState<Row | null>(null);
  const [confirming, setConfirming] = useState<Row | null>(null);

  const primaryDate = spec.dateCols[0] ?? null;

  // Each dropdown's options come from the ROWS, not a vocabulary: these columns are free
  // text that happens to repeat, so the only honest option list is what is actually there.
  const options = useMemo(() => Object.fromEntries(spec.advancedFilters.map((col) => [
    col, [...new Set(page.rows.map((r) => s(r[col])).filter(Boolean))].sort(),
  ])), [page.rows, spec.advancedFilters]);

  const shown = useMemo(() => page.rows.filter((r) => {
    const needle = q.trim().toLowerCase();
    if (needle && !spec.searchCols.some((c) => s(r[c]).toLowerCase().includes(needle))) {
      return false;
    }
    for (const [col, want] of Object.entries(filters)) {
      if (want && s(r[col]) !== want) return false;
    }
    if (primaryDate) {
      // Compared as ISO strings. These columns are dates stored as yyyy-mm-dd, where
      // lexical order IS chronological order — no parsing, and nothing to get wrong
      // across time zones for a value that has no time in it.
      const v = s(r[primaryDate]).slice(0, 10);
      if (from && (!v || v < from)) return false;
      if (to && (!v || v > to)) return false;
    }
    return true;
  }), [page.rows, q, filters, from, to, primaryDate, spec.searchCols]);

  return (
    <div className="mt-4">
      {spec.caption && (
        <Notice tone="brand">
          <Markdownish text={spec.caption} />
        </Notice>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <SearchBox value={q} onChange={setQ}
          placeholder={`Search ${spec.searchCols.map(labelOf(spec)).join(", ")}…`} />
        {spec.advancedFilters.map((col) => (
          <div key={col}>
            <div className="mb-1 text-xs font-medium text-ink-600">{labelOf(spec)(col)}</div>
            <Select
              className="w-auto min-w-32" value={filters[col] ?? ""}
              aria-label={labelOf(spec)(col)}
              onChange={(e) => setFilters((p) => ({ ...p, [col]: e.target.value }))}
            >
              <option value="">All</option>
              {options[col].map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
          </div>
        ))}
        {primaryDate && (
          <>
            <DateBox label={`${labelOf(spec)(primaryDate)} from`} value={from} onChange={setFrom} />
            <DateBox label="to" value={to} onChange={setTo} />
          </>
        )}
        <ExportButton rows={shown} columns={spec.tableCols} name={spec.table} />
      </div>
      <p className="mt-2 text-xs text-ink-500">
        {shown.length} of {page.total} row{page.total === 1 ? "" : "s"}.
      </p>

      <Grid
        rows={shown.slice(0, 200)} columns={spec.tableCols} label={labelOf(spec)}
        actions={(r) => (
          <div className="flex gap-1">
            <IconBtn label="Edit" onClick={() => setEditing(r)}>
              <Pencil className="h-4 w-4" />
            </IconBtn>
            <IconBtn label="Delete" danger onClick={() => setConfirming(r)}>
              <Trash2 className="h-4 w-4" />
            </IconBtn>
          </div>
        )}
      />
      {shown.length > 200 && (
        <p className="mt-2 text-xs text-ink-500">Showing the first 200 of {shown.length}.</p>
      )}

      {editing && (
        <EditRow
          spec={spec} table={page.table} row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged(); }}
        />
      )}
      {confirming && (
        <ConfirmDelete
          spec={spec} table={page.table} row={confirming}
          onClose={() => setConfirming(null)}
          onDone={() => { setConfirming(null); onChanged(); }}
        />
      )}
    </div>
  );
}

const labelOf = (spec: RecordSpec) => (col: string) =>
  spec.colLabels[col] ?? col.replace(/_/g, " ");

// ── Pieces ───────────────────────────────────────────────────────────────────

function Grid({ rows, columns, label, actions, linkColumn }: {
  rows: Row[]; columns: string[]; label: (c: string) => string;
  actions?: (r: Row) => React.ReactNode; linkColumn?: string;
}) {
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-ink-200">
      <table className="w-full text-sm">
        <thead className="bg-ink-50 text-left text-xs font-semibold text-ink-600 uppercase">
          <tr>
            {columns.map((c) => <th key={c} className="px-3 py-2 whitespace-nowrap">{label(c)}</th>)}
            {actions && <th className="w-20 px-3 py-2"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {rows.length === 0 && (
            <tr><td colSpan={columns.length + (actions ? 1 : 0)}
              className="px-3 py-5 text-ink-400">No rows match.</td></tr>
          )}
          {rows.map((r, i) => (
            <tr key={s(r.id) || i} className="align-top hover:bg-ink-50">
              {columns.map((c) => (
                <td key={c} className="max-w-72 px-3 py-2 text-ink-700">
                  <Cell value={r[c]} isLink={c === linkColumn} />
                </td>
              ))}
              {actions && <td className="px-3 py-2">{actions(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One cell.
 *
 * A boolean renders as a word rather than "true": these columns are statuses
 * (`is_resolved` is the meeting's Status column), and "true" in a Status column reads as
 * a leaked database value, not as an answer.
 */
function Cell({ value, isLink }: { value: unknown; isLink?: boolean }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-ink-300">—</span>;
  }
  if (typeof value === "boolean") {
    return <Badge tone={value ? "good" : "neutral"}>{value ? "Yes" : "No"}</Badge>;
  }
  const text = Array.isArray(value) ? value.join(", ") : String(value);
  if (isLink && /^https?:\/\//i.test(text)) {
    return (
      <a href={text} target="_blank" rel="noreferrer"
        className="inline-flex items-center gap-1 text-accent-700 hover:underline">
        Open <ExternalLink className="h-3.5 w-3.5" />
      </a>
    );
  }
  return <span className="line-clamp-3 whitespace-pre-wrap">{text}</span>;
}

function SearchBox({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder: string;
}) {
  return (
    <div className="relative min-w-56 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-400" />
      <input className={`${fieldClass} pl-9`} value={value} placeholder={placeholder}
        aria-label={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function DateBox({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-ink-600">{label}</div>
      <input type="date" className={field("w-auto")} value={value}
        aria-label={label} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function IconBtn({ label, onClick, danger, children }: {
  label: string; onClick: () => void; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button" onClick={onClick} aria-label={label} title={label}
      className={`rounded p-1.5 transition-colors ${danger
        ? "text-ink-400 hover:bg-bad-50 hover:text-bad-700"
        : "text-ink-400 hover:bg-ink-100 hover:text-ink-700"}`}
    >
      {children}
    </button>
  );
}

/**
 * A CSV of what is on screen, built in the browser.
 *
 * The filtered set, every column — the Streamlit download button's own promise ("every
 * row in the current view — all pages, all columns"). Quoting is the whole of CSV that
 * can go wrong, so every field is quoted and inner quotes doubled rather than guessed at
 * per value.
 */
function ExportButton({ rows, columns, name }: {
  rows: Row[]; columns: string[]; name: string;
}) {
  const download = () => {
    const esc = (v: unknown) => `"${s(v).replace(/"/g, '""')}"`;
    const csv = [columns.map(esc).join(","),
      ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\r\n");
    // A BOM, so Excel on Windows reads it as UTF-8. Without one it guesses the system
    // codepage and every accented funder name arrives mangled — and these are funder
    // names from across the world.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Button onClick={download} disabled={!rows.length}>
      Export {rows.length} as CSV
    </Button>
  );
}

/** The caption's **bold** spans, which is all the markdown those strings use. */
function Markdownish({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        (part.startsWith("**") && part.endsWith("**")
          ? <strong key={i}>{part.slice(2, -2)}</strong>
          : <span key={i}>{part}</span>))}
    </>
  );
}

function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/40 p-4">
      <Card className="my-8 w-full max-w-2xl p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-bold text-brand-700">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close"
            className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </Card>
    </div>
  );
}

function EditRow({ spec, table, row, onClose, onSaved }: {
  spec: RecordSpec; table: string; row: Row; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState<Row>(() => Object.fromEntries(
    spec.editFields.map(([col, kind]) =>
      [col, kind === "bool" ? !!row[col] : s(row[col]).slice(0, kind === "date" ? 10 : undefined)])));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  return (
    <Modal title={`Edit — ${spec.table}`} onClose={onClose}>
      <div className="space-y-3">
        {spec.editFields.map(([col, kind, label]) => (
          <div key={col}>
            <div className="mb-1.5 text-sm font-medium text-ink-700">{label}</div>
            {kind === "bool" ? (
              <label className="flex items-center gap-2.5 text-sm text-ink-700">
                <input type="checkbox" className="h-4 w-4 accent-brand-700"
                  checked={!!f[col]}
                  onChange={(e) => setF((p) => ({ ...p, [col]: e.target.checked }))} />
                {label}
              </label>
            ) : kind === "area" ? (
              <textarea className={`${fieldClass} min-h-24`} value={s(f[col])}
                onChange={(e) => setF((p) => ({ ...p, [col]: e.target.value }))} />
            ) : (
              <input
                type={kind === "date" ? "date" : "text"} className={fieldClass}
                value={s(f[col])}
                onChange={(e) => setF((p) => ({ ...p, [col]: e.target.value }))}
              />
            )}
          </div>
        ))}
      </div>
      {failed && <Notice tone="bad" className="mt-4">{failed}</Notice>}
      <div className="mt-5 flex gap-2">
        <Button
          variant="primary" busy={busy} icon={<Save className="h-4 w-4" />}
          onClick={async () => {
            setBusy(true); setFailed(null);
            try {
              await saveRecord(table, s(row.id), f);
              onSaved();
            } catch (e) {
              setFailed(e instanceof Error ? e.message : "Save failed.");
              setBusy(false);
            }
          }}
        >
          Save
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}

function ConfirmDelete({ spec, table, row, onClose, onDone }: {
  spec: RecordSpec; table: string; row: Row; onClose: () => void; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Named by the columns a person would recognise it by, not by its id.
  const describe = spec.tableCols.slice(0, 3).map((c) => s(row[c])).filter(Boolean).join(" · ");
  return (
    <Modal title={`Delete from ${spec.table}`} onClose={onClose}>
      <Notice tone="bad">
        This permanently deletes the row. It cannot be undone, and an Excel re-sync will
        not bring it back unless the row still exists in the workbook.
      </Notice>
      <p className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3 text-sm text-ink-800">
        {describe || s(row.id)}
      </p>
      {failed && <Notice tone="bad" className="mt-3">{failed}</Notice>}
      <div className="mt-5 flex gap-2">
        <Button
          variant="danger" busy={busy} icon={<Trash2 className="h-4 w-4" />}
          onClick={async () => {
            setBusy(true); setFailed(null);
            try {
              await deleteRecord(table, s(row.id));
              onDone();
            } catch (e) {
              setFailed(e instanceof Error ? e.message : "Delete failed.");
              setBusy(false);
            }
          }}
        >
          Delete permanently
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}
