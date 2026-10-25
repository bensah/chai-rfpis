import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";

type Props = {
  label: string;
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
  help?: string;
  format?: (v: string) => string;
};

/** Searchable multi-select: selected values show as removable chips. */
export default function MultiSelect({ label, options, value, onChange, help, format = (v) => v }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const shown = useMemo(() => {
    // De-duplicate: GEO_OPTIONS repeats a label, and a repeated React key renders stale rows.
    const unique = [...new Set(options)];
    const ql = q.trim().toLowerCase();
    return ql ? unique.filter((o) => format(o).toLowerCase().includes(ql)) : unique;
  }, [options, q, format]);

  const toggle = (o: string) => onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o]);

  return (
    <div ref={box} className="relative">
      <div className="mb-1 text-sm font-medium text-slate-700" title={help}>{label}</div>
      <button
        type="button" onClick={() => setOpen((o) => !o)}
        className="flex min-h-10 w-full items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-left hover:border-slate-400"
      >
        <div className="flex flex-1 flex-wrap gap-1">
          {value.length === 0 && <span className="px-1 text-sm text-slate-400">Any</span>}
          {value.map((v) => (
            <span key={v} className="flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-xs text-brand">
              {format(v)}
              <X
                className="h-3 w-3 cursor-pointer" aria-label={`Remove ${format(v)}`}
                onClick={(e) => { e.stopPropagation(); toggle(v); }}
              />
            </span>
          ))}
        </div>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-40 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg">
          <input
            autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type to filter…"
            className="w-full border-b border-slate-100 px-3 py-2 text-sm outline-none"
          />
          <ul className="max-h-64 overflow-auto py-1">
            {shown.length === 0 && <li className="px-3 py-2 text-sm text-slate-400">No matches</li>}
            {shown.map((o) => (
              <li key={o}>
                <button
                  type="button" onClick={() => toggle(o)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50"
                >
                  <span className={`flex h-4 w-4 items-center justify-center rounded border ${value.includes(o) ? "border-brand bg-brand text-white" : "border-slate-300"}`}>
                    {value.includes(o) && <Check className="h-3 w-3" />}
                  </span>
                  {format(o)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
