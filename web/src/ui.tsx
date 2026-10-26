/**
 * The shared pieces every screen is built from, so the app reads as one system:
 * one button, one card, one badge, one field. Colours come from the CHAI tokens
 * in index.css — Dark Blue for anything primary, Turquoise for anything active.
 */
import type {
  AnchorHTMLAttributes, ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes,
} from "react";
import { Loader2 } from "lucide-react";

// ── Buttons ──────────────────────────────────────────────────────────────────

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary: "bg-brand-700 text-white shadow-card hover:bg-brand-800 active:bg-brand-900",
  secondary: "border border-ink-200 bg-white text-ink-700 shadow-card hover:border-ink-300 hover:bg-ink-50",
  ghost: "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
  danger: "border border-bad-600/25 bg-white text-bad-700 hover:bg-bad-50",
};
const SIZE: Record<Size, string> = {
  sm: "h-8 gap-1.5 rounded-lg px-2.5 text-sm",
  md: "h-10 gap-2 rounded-lg px-4 text-sm",
};

const BASE = "inline-flex items-center justify-center font-medium whitespace-nowrap transition-colors";

export const buttonClass = (variant: Variant = "secondary", size: Size = "md") =>
  `${BASE} ${VARIANT[variant]} ${SIZE[size]}`;

export function Button({
  variant = "secondary", size = "md", busy = false, icon, className = "", children, disabled, ...rest
}: {
  variant?: Variant; size?: Size; busy?: boolean; icon?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      disabled={disabled || busy}
      className={`${buttonClass(variant, size)} disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...rest}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

/** The same thing as a real link, so it can be opened in a new tab. */
export function LinkButton({
  variant = "secondary", size = "md", icon, className = "", children, ...rest
}: { variant?: Variant; size?: Size; icon?: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={`${buttonClass(variant, size)} ${className}`} {...rest}>
      {icon}
      {children}
    </a>
  );
}

/** A square button that is only an icon — toolbars, dialog headers, pagination. */
export function IconButton({
  label, className = "", children, ...rest
}: { label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      title={label} aria-label={label}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-800 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// ── Surfaces ─────────────────────────────────────────────────────────────────

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-xl border border-ink-200 bg-white shadow-card ${className}`}>{children}</div>;
}

/** The title block at the top of a page: name, one line of orientation, actions. */
export function PageHeader({ title, lead, actions }: { title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-brand-700 sm:text-[1.75rem]">{title}</h1>
        {lead && <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-ink-600">{lead}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A small caps label above a group of fields or a block of content. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-[0.7rem] font-semibold tracking-[0.08em] text-ink-500 uppercase">{children}</div>;
}

// ── Badges and notices ───────────────────────────────────────────────────────

export type Tone = "neutral" | "brand" | "accent" | "good" | "warn" | "bad";

const TONE: Record<Tone, string> = {
  neutral: "bg-ink-100 text-ink-600",
  brand: "bg-brand-100 text-brand-700",
  accent: "bg-accent-50 text-accent-700",
  good: "bg-good-50 text-good-700",
  warn: "bg-gold-100 text-gold-700",
  bad: "bg-bad-50 text-bad-700",
};

export function Badge({ tone = "neutral", className = "", children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[tone]} ${className}`}>
      {children}
    </span>
  );
}

const NOTICE: Record<Tone, string> = {
  neutral: "border-ink-200 bg-ink-50 text-ink-700",
  brand: "border-brand-200 bg-brand-50 text-brand-800",
  accent: "border-accent-200 bg-accent-50 text-accent-800",
  good: "border-good-600/20 bg-good-50 text-good-700",
  warn: "border-gold-500/30 bg-gold-100 text-gold-700",
  bad: "border-bad-600/20 bg-bad-50 text-bad-700",
};

export function Notice({ tone = "neutral", icon, className = "", children, ...rest }: {
  tone?: Tone; icon?: ReactNode; className?: string; children: ReactNode; role?: string;
}) {
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${NOTICE[tone]} ${className}`} {...rest}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ── Form controls ────────────────────────────────────────────────────────────

export const fieldClass =
  "w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-800 placeholder:text-ink-400 " +
  "transition-colors outline-none focus:border-accent-600 focus:ring-2 focus:ring-accent-600/15 disabled:bg-ink-50";

export function Field({ id, label, hint, children, ...rest }: {
  id: string; label: string; hint?: string; children?: ReactNode;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="mb-4">
      <label className="mb-1.5 block text-sm font-medium text-ink-700" htmlFor={id}>{label}</label>
      {children ?? <input id={id} className={fieldClass} {...rest} />}
      {hint && <p className="mt-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

export function Select({ className = "", ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${fieldClass} ${className}`} {...rest} />;
}

// ── States ───────────────────────────────────────────────────────────────────

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-20 text-sm text-ink-500">
      <Loader2 className="h-5 w-5 animate-spin text-accent-600" /> {label}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">{icon}</div>
      )}
      <p className="font-semibold text-ink-800">{title}</p>
      {children && <div className="mt-1.5 max-w-md text-sm text-ink-500">{children}</div>}
    </div>
  );
}
