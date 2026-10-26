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
      <div className="mb-1.5 text-sm font-medium text-ink-700" title={help}>{label}</div>
      <button
        type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className={`flex min-h-10 w-full items-center gap-1 rounded-lg border bg-white px-2 py-1 text-left transition-colors ${
          open ? "border-accent-600 ring-2 ring-accent-600/15" : "border-ink-300 hover:border-ink-400"
        }`}
      >
        <div className="flex flex-1 flex-wrap gap-1">
          {value.length === 0 && <span className="px-1 text-sm text-ink-400">Any</span>}
          {value.map((v) => (
            <span key={v} className="flex items-center gap-1 rounded-full bg-accent-50 px-2 py-0.5 text-xs font-medium text-accent-700">
              {format(v)}
              <X
                className="h-3 w-3 cursor-pointer hover:text-accent-800" aria-label={`Remove ${format(v)}`}
                onClick={(e) => { e.stopPropagation(); toggle(v); }}
              />
            </span>
          ))}
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 text-ink-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute z-40 mt-1.5 w-full overflow-hidden rounded-xl border border-ink-200 bg-white shadow-float">
          <input
            autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type to filter…"
            aria-label={`Filter ${label}`}
            className="w-full border-b border-ink-100 px-3 py-2.5 text-sm outline-none placeholder:text-ink-400"
          />
          <ul className="max-h-64 overflow-auto py-1">
            {shown.length === 0 && <li className="px-3 py-2.5 text-sm text-ink-400">No matches</li>}
            {shown.map((o) => {
              const on = value.includes(o);
              return (
                <li key={o}>
                  <button
                    type="button" onClick={() => toggle(o)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-ink-50"
                  >
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                      on ? "border-accent-600 bg-accent-600 text-white" : "border-ink-300"
                    }`}>
                      {on && <Check className="h-3 w-3" strokeWidth={3} />}
                    </span>
                    {format(o)}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
