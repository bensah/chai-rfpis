/**
 * The modal and the plain text field the Settings dialogs share.
 *
 * Extracted when the Add-user dialog arrived: it and the Edit dialog are the same shape,
 * and the alternative was either a circular import between two tab files or passing
 * components to each other as props. Neither is a thing to read twice.
 */
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Card, fieldClass } from "../ui";

export function Dialog({ title, onClose, children }: {
  title: string; onClose: () => void; children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/40 p-4">
      <Card className="my-8 w-full max-w-3xl p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-bold text-brand-700">{title}</h2>
          <button
            type="button" onClick={onClose} aria-label="Close"
            className="rounded p-1 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </Card>
    </div>
  );
}

export function Field({ label, value, onChange, disabled, hint }: {
  label: string; value: string; onChange: (v: string) => void;
  disabled?: boolean; hint?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium text-ink-700">{label}</div>
      <input
        className={fieldClass} value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}
