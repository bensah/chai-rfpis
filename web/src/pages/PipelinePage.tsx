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
import { ChevronRight, ClipboardCheck, Layers, Search, Send, Trophy } from "lucide-react";
import { fetchWeeks, type User, type Weeks } from "../api";
import { periodOf, type Period } from "../pipeline/period";
import PeriodPicker from "../pipeline/PeriodPicker";
import BiddingStage from "../pipeline/BiddingStage";
import ReviewedStage from "../pipeline/ReviewedStage";
import ScreenedStage from "../pipeline/ScreenedStage";
import { Card, EmptyState, PageHeader, Select } from "../ui";

/**
 * The stages, owner-confirmed 2026-10-27. Each is a place a row IS, decided by its own
 * columns — not a tab somebody clicks. The rule is written beside the label so the next
 * reader can check a row against it without going to the Python.
 *
 * The line deliberately runs past Bidding. Bidding is "preparing a bid"; the application
 * is then submitted and the funder answers, and that tail is today's separate Funding
 * page. So the pipeline is currently cut in half across two nav items. Folding Funding in
 * is a later change — these last two stages are named here so the shape is honest now
 * rather than looking like it stops at Track.
 */
type StageKey = "screened" | "reviewed" | "bidding" | "submitted" | "outcome";

const STAGES: {
  key: StageKey; label: string; hint: string; rule: string; icon: typeof Search; built: boolean;
}[] = [
  { key: "screened", label: "Screened", icon: Search, built: true,
    hint: "Found and scored, nobody has decided yet",
    rule: "no decision recorded — the recommendation shown is the engine's" },
  { key: "reviewed", label: "Reviewed", icon: ClipboardCheck, built: true,
    hint: "A person has decided: proceed, park or decline",
    rule: "a decision is recorded — the engine's recommendation alone does not count" },
  { key: "bidding", label: "Bidding", icon: Layers, built: true,
    hint: "Decided to bid, application under way",
    rule: "proceeding, not yet submitted, not completed or discontinued, deadline not past" },
  { key: "submitted", label: "Submitted", icon: Send, built: false,
    hint: "With the funder, awaiting their answer",
    rule: "progress complete, no funder decision yet" },
  { key: "outcome", label: "Outcome", icon: Trophy, built: false,
    hint: "The funder has answered",
    rule: "approved or not approved — today's Funding page" },
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
        {stage === "reviewed" && <ReviewedStage period={period} onPickPeriod={setPeriod} />}
        {stage === "bidding" && <BiddingStage period={period} />}
        {stage !== "screened" && stage !== "reviewed" && stage !== "bidding"
          && <StageNotBuilt stage={stage} />}
      </div>
    </section>
  );
}

/**
 * The line itself: where an opportunity is, and where it goes next.
 *
 * Laid out as steps with connectors rather than five equal cards, because the point is the
 * direction of travel. A row does not sit in "Screened and Bidding" — it has moved, or it
 * has not.
 */
function StageLine({ stage, onPick }: { stage: StageKey; onPick: (s: StageKey) => void }) {
  const activeIndex = STAGES.findIndex((s) => s.key === stage);
  return (
    <nav aria-label="Pipeline stage" className="flex flex-wrap items-stretch gap-y-2">
      {STAGES.map((s, i) => {
        const on = s.key === stage;
        const passed = i < activeIndex;
        const Icon = s.icon;
        return (
          <div key={s.key} className="flex min-w-[11rem] flex-1 items-stretch">
            <button
              onClick={() => onPick(s.key)} aria-current={on ? "step" : undefined}
              title={s.rule}
              className={`flex flex-1 items-start gap-2.5 rounded-xl border p-3 text-left transition-colors ${
                on ? "border-brand-700 bg-brand-700 text-white shadow-card"
                   : "border-ink-200 bg-white text-ink-700 hover:border-ink-300 hover:bg-ink-50"
              }`}
            >
              <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${
                on ? "bg-white/15 text-white"
                   : passed ? "bg-brand-100 text-brand-700" : "bg-ink-100 text-ink-500"
              }`}>
                <Icon className="h-4 w-4" strokeWidth={1.9} />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  {s.label}
                  {!s.built && (
                    <span className={`rounded px-1 py-0.5 text-[0.6rem] font-medium ${
                      on ? "bg-white/15 text-brand-100" : "bg-ink-100 text-ink-500"
                    }`}>soon</span>
                  )}
                </span>
                <span className={`mt-0.5 block text-[0.7rem] leading-snug ${on ? "text-brand-100" : "text-ink-500"}`}>
                  {s.hint}
                </span>
              </span>
            </button>
            {i < STAGES.length - 1 && (
              <span aria-hidden className="flex w-3 shrink-0 items-center justify-center">
                <ChevronRight className={`h-4 w-4 ${passed || on ? "text-brand-400" : "text-ink-300"}`} />
              </span>
            )}
          </div>
        );
      })}
    </nav>
  );
}

/** Honest about what is not built yet, and about where the work still happens. */
function StageNotBuilt({ stage }: { stage: StageKey }) {
  const s = STAGES.find((x) => x.key === stage)!;
  return (
    <Card>
      <EmptyState icon={<s.icon className="h-5 w-5" />} title={`${s.label} is not rebuilt yet`}>
        <p>{s.hint} — <span className="text-ink-400">{s.rule}</span>.</p>
        <p className="mt-2">
          It still works in the classic app meanwhile. {s.key === "outcome" || s.key === "submitted"
            ? "Today this part of the journey lives on the Funding page rather than here."
            : "This stage moves here as Phase 2 lands."}
        </p>
      </EmptyState>
    </Card>
  );
}
