import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A button that opens a panel below it (Streamlit's st.popover). Closes on an
 * outside click or Escape; `close` is handed to the content so an action inside
 * can dismiss it. Styled for the white top bar.
 */
export default function Popover({
  label, title, badge, children, align = "right", width = "w-80", triggerClass = "",
}: {
  label: ReactNode; title: string; badge?: string | null; align?: "left" | "right";
  width?: string; triggerClass?: string;
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
        type="button" title={title} aria-label={title} aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className={`relative inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
          open ? "bg-brand-50 text-brand-700" : "text-ink-500 hover:bg-ink-100 hover:text-ink-800"
        } ${triggerClass}`}
      >
        {label}
        {badge && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[1.05rem] rounded-full bg-accent-600 px-1 py-0.5 text-[0.6rem] leading-none font-bold text-white ring-2 ring-white">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog" aria-label={title}
          className={`absolute top-[calc(100%+0.5rem)] z-50 ${align === "right" ? "right-0" : "left-0"} ${width} max-w-[calc(100vw-2rem)] rounded-xl border border-ink-200 bg-white p-4 text-ink-800 shadow-float`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
