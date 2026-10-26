/**
 * The period control that sits above the Pipeline stages.
 *
 * One control, read by every stage, because the owner's point is that a week's work should
 * flow from found through to summarised without changing how you ask for a period. Picking
 * a grain and stepping through it is the common case; the explicit range is there for the
 * questions a calendar grain cannot phrase ("the three weeks around the deadline").
 */
import { useState } from "react";
import { CalendarRange, ChevronLeft, ChevronRight } from "lucide-react";
import {
  atGrain, canGoForward, GRAINS, labelOf, periodOf, rangeOf, shift, today,
  type Period,
} from "./period";
import { Button, IconButton, fieldClass } from "../ui";

export default function PeriodPicker({ value, onChange, right }: {
  value: Period; onChange: (p: Period) => void; right?: React.ReactNode;
}) {
  const [customOpen, setCustomOpen] = useState(value.kind === "custom");
  const grain = value.kind === "grain" ? value.grain : null;
  const forward = canGoForward(value);

  return (
    <div className="mb-6 rounded-xl border border-ink-200 bg-white p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-3">
        {/* Grain: a segmented control, because these are one choice among six. */}
        <div role="tablist" aria-label="Period length" className="flex flex-wrap gap-0.5 rounded-lg bg-ink-100 p-0.5">
          {GRAINS.map((g) => {
            const on = grain === g.grain;
            return (
              <button
                key={g.grain} role="tab" aria-selected={on}
                onClick={() => { setCustomOpen(false); onChange(atGrain(value, g.grain)); }}
                className={`rounded-md px-2.5 py-1 text-sm transition-colors ${
                  on ? "bg-white font-semibold text-brand-700 shadow-card" : "text-ink-600 hover:text-ink-900"
                }`}
              >
                {g.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1">
          <IconButton label="Previous period" onClick={() => onChange(shift(value, -1))}>
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
          <span className="min-w-[11rem] px-1 text-center text-sm font-semibold text-brand-700">
            {labelOf(value)}
          </span>
          {/* Walking into a period that has not happened is never useful, so it is disabled
              rather than returning an empty page the reader has to interpret. */}
          <IconButton
            label={forward ? "Next period" : "This is the current period"}
            disabled={!forward} onClick={() => onChange(shift(value, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </IconButton>
        </div>

        {/* Only worth offering once you have stepped away from the present. */}
        {grain !== null && !isCurrent(value) && (
          <Button size="sm" onClick={() => onChange(periodOf(grain, today()))}>Now</Button>
        )}

        <Button
          size="sm" icon={<CalendarRange className="h-4 w-4" />}
          onClick={() => setCustomOpen((o) => !o)}
          className={value.kind === "custom" ? "border-accent-600/40 bg-accent-50 text-accent-700" : ""}
        >
          Custom range
        </Button>

        {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
      </div>

      {customOpen && <CustomRange value={value} onChange={onChange} />}
    </div>
  );
}

const isCurrent = (p: Period) => {
  const { from, to } = rangeOf(p);
  const now = today();
  return from <= now && now < to;
};

/** The explicit range. Shown inclusively and stored half-open, so "1–31 Oct" means what a
 *  reader thinks it means while the API still gets a clean `lt` bound. */
function CustomRange({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const current = rangeOf(value);
  const [from, setFrom] = useState(current.from);
  const [until, setUntil] = useState(shiftIso(current.to, -1));   // inclusive, for display
  const bad = until < from;

  return (
    <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-ink-100 pt-3">
      <label className="text-sm">
        <span className="mb-1 block font-medium text-ink-700">From</span>
        <input type="date" value={from} max={until} onChange={(e) => setFrom(e.target.value)}
          className={`${fieldClass} w-auto`} />
      </label>
      <label className="text-sm">
        <span className="mb-1 block font-medium text-ink-700">To</span>
        <input type="date" value={until} min={from} onChange={(e) => setUntil(e.target.value)}
          className={`${fieldClass} w-auto`} />
      </label>
      <Button
        variant="primary" disabled={bad}
        title={bad ? "The end of the range is before its start." : undefined}
        onClick={() => onChange({ kind: "custom", from, to: shiftIso(until, 1) })}
      >
        Apply
      </Button>
      <p className="text-xs text-ink-500">Both dates are included.</p>
    </div>
  );
}

function shiftIso(s: string, days: number): string {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
