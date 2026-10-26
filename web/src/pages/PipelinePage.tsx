/**
 * Pipeline — the stages an opportunity moves through, not four sibling tabs.
 *
 * The owner's shape: the things every stage shares sit on top (the period, and the week
 * when the stage is week-keyed), the stage line shows where work is, and opening one
 * opportunity gives a single flow where only the stage-specific part changes.
 *
 * Summary is deliberately NOT on the line. It is a lens over the whole pipeline rather
 * than somewhere an opportunity ends up, and putting it fourth implies a row finishes
 * "in Summary", which is not a thing that happens.
 */
import { useEffect, useState } from "react";
import { ClipboardCheck, Layers, Search } from "lucide-react";
import { fetchWeeks, type User, type Weeks } from "../api";
import { periodOf, type Period } from "../pipeline/period";
import PeriodPicker from "../pipeline/PeriodPicker";
import ScreenedStage from "../pipeline/ScreenedStage";
import { Card, EmptyState, PageHeader, Select } from "../ui";

type StageKey = "screened" | "review" | "track";

const STAGES: { key: StageKey; label: string; hint: string; icon: typeof Search }[] = [
  { key: "screened", label: "Screened", hint: "Found by the scan or submitted, and scored", icon: Search },
  { key: "review", label: "Review", hint: "Where the decision is made", icon: ClipboardCheck },
  { key: "track", label: "Track", hint: "Decided to bid, application under way", icon: Layers },
];

export default function PipelinePage({ user }: { user: User }) {
  const [stage, setStage] = useState<StageKey>("screened");
  const [period, setPeriod] = useState<Period>(() => periodOf("week"));
  const [weeks, setWeeks] = useState<Weeks | null>(null);
  const [week, setWeek] = useState<string | null>(null);

  useEffect(() => {
    fetchWeeks().then((w) => {
      setWeeks(w);
      setWeek((cur) => cur ?? w.current);
    }).catch(() => undefined);
  }, [user.tenant?.id, user.view?.id]);

  return (
    <section>
      <PageHeader
        title="Pipeline"
        lead="Every opportunity across its lifecycle — found and screened, decided, then tracked through the bid."
      />

      {/* The common denominators, above the stages. The week picker only appears for the
          stage that is keyed by a review week; the period drives the date-ranged ones. */}
      <PeriodPicker
        value={period} onChange={setPeriod}
        right={stage === "screened" && weeks ? (
          <label className="flex items-center gap-2 text-sm text-ink-600">
            Review week
            <Select value={week ?? weeks.current} onChange={(e) => setWeek(e.target.value)}
              className="w-auto py-1.5">
              {weeks.weeks.map((w) => <option key={w} value={w}>{w}</option>)}
            </Select>
          </label>
        ) : undefined}
      />

      <StageLine stage={stage} onPick={setStage} />

      <div className="mt-6">
        {stage === "screened" && <ScreenedStage week={week} weeks={weeks} onPickWeek={setWeek} />}
        {stage !== "screened" && (
          <Card>
            <EmptyState title={`${STAGES.find((s) => s.key === stage)!.label} is next`}>
              The route is built; this stage is being rebuilt on the new flow. It still works in
              the classic app meanwhile.
            </EmptyState>
          </Card>
        )}
      </div>
    </section>
  );
}

/** The line itself: where an opportunity is, and where it goes next. */
function StageLine({ stage, onPick }: { stage: StageKey; onPick: (s: StageKey) => void }) {
  return (
    <nav aria-label="Pipeline stage" className="flex flex-wrap items-stretch gap-2">
      {STAGES.map((s, i) => {
        const on = s.key === stage;
        const Icon = s.icon;
        return (
          <button
            key={s.key} onClick={() => onPick(s.key)} aria-current={on ? "step" : undefined}
            className={`group relative flex min-w-[13rem] flex-1 items-start gap-3 rounded-xl border p-3.5 text-left transition-colors ${
              on ? "border-brand-700 bg-brand-700 text-white shadow-card"
                 : "border-ink-200 bg-white text-ink-700 hover:border-ink-300 hover:bg-ink-50"
            }`}
          >
            <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
              on ? "bg-white/15" : "bg-brand-50 text-brand-600"
            }`}>
              <Icon className="h-4 w-4" strokeWidth={1.9} />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 font-semibold">
                <span className={on ? "text-white/60" : "text-ink-400"}>{i + 1}</span> {s.label}
              </span>
              <span className={`mt-0.5 block text-xs leading-relaxed ${on ? "text-brand-100" : "text-ink-500"}`}>
                {s.hint}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
