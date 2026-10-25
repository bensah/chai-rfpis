import { useEffect, useRef, useState, type ReactNode } from "react";

/** A button that opens a panel below it (Streamlit's st.popover). Closes on outside click
 * or Escape; `close` is handed to the content so an action inside can dismiss it. */
export default function Popover({ label, title, badge, children, align = "right", width = "w-80" }: {
  label: ReactNode; title: string; badge?: string | null; align?: "left" | "right"; width?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button" title={title} aria-label={title} aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-10 w-10 items-center justify-center rounded-lg text-lg text-white hover:bg-white/10"
      >
        {label}
        {badge && (
          <span className="absolute -right-1 -top-0.5 rounded-full bg-red-600 px-1.5 py-0.5 text-[0.6rem] font-bold leading-none text-white">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div
          className={`absolute top-12 z-50 ${align === "right" ? "right-0" : "left-0"} ${width} max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-4 text-slate-800 shadow-xl`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
