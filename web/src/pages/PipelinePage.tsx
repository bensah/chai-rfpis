/**
 * Pipeline — the stages an opportunity moves through, not a row of sibling tabs.
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
import OutcomeStage from "../pipeline/OutcomeStage";
import ScreenedStage from "../pipeline/ScreenedStage";
import SubmittedStage from "../pipeline/SubmittedStage";
import OpportunitiesPage from "./OpportunitiesPage";
import { PageHeader, Select } from "../ui";

/**
 * The stages, owner-confirmed 2026-10-27. Each is a place a row IS, decided by its own
 * columns — not a tab somebody clicks. The rule is written beside the label so the next
 * reader can check a row against it without going to the Python.
 *
 * The line runs past Bidding to the end: the application is submitted, and the funder
 * answers. That tail used to be a separate Funding page ("Your Applied Funding"), so the
 * pipeline was cut in half across two nav items. It is one line now.
 *
 * The Funding page is NOT deleted by this. It still holds the per-funder breakdown and the
 * reporting tab, and it still counts Under Review and Approved together as applied funding,
 * which is the right frame for a funding log and the wrong one for a journey — a proposal
 * that is still being read has not reached an outcome. So the two differ on purpose, and
 * `/pipelines/outcome` returns the pending count precisely so the Funding page's own
 * figures stay reconstructable from this side.
 */
type StageKey = "screened" | "reviewed" | "bidding" | "submitted" | "outcome";

const STAGES: {
  key: StageKey; label: string; hint: string; rule: string; icon: typeof Search; built: true;
}[] = [
  { key: "screened", label: "Screened", icon: Search, built: true,
    hint: "Found and scored, nobody has decided yet",
    rule: "no decision recorded — the recommendation shown is the engine's" },
  { key: "reviewed", label: "Review", icon: ClipboardCheck, built: true,
    hint: "A person has decided: proceed, park or decline",
    rule: "a decision is recorded — the engine's recommendation alone does not count" },
  { key: "bidding", label: "Bidding", icon: Layers, built: true,
    hint: "Decided to bid, application under way",
    rule: "proceeding, not yet submitted, not completed or discontinued, deadline not past" },
  { key: "submitted", label: "Submitted", icon: Send, built: true,
    hint: "With the funder, awaiting their answer",
    rule: "something records it going in, and the funder has not approved or declined it" },
  { key: "outcome", label: "Outcome", icon: Trophy, built: true,
    hint: "The funder has answered",
    rule: "approved or not approved — what the Funding page calls applied funding" },
];

/**
 * What period a stage OPENS on, which is not the same question for all five.
 *
 * The owner's rhythm, in their words: "Screened and Review are the parts that gets the
 * found rfps into the pipeline, the Bidding and Submitted are those that are actively
 * being worked on to completion, then the Outcome is the one waiting Funder's feedback."
 *
 * So the first two are a WEEKLY intake — the meeting walks through the week just gone, one
 * week at a time, and `periodOf("week")` already anchors on the previous week because the
 * current one is a day old on the Monday the team sits down.
 *
 * The last three are not periods of intake at all; they are WORK IN FLIGHT. A bid decided
 * in March is still a bid in March, and a proposal sent in April is still with the funder
 * in November — the Submitted screen said so itself, "7 proposals are still with a funder
 * from outside this period", and Bidding said "widen the period above to see bids from
 * earlier". A week-shaped window over work that outlives the week shows an empty board and
 * asks every reader to widen it by hand before the meeting can start. They open on the
 * YEAR instead. What leaves those boards is a row being submitted, answered, discontinued
 * or past its deadline — the stage rules already do that, and the period should not be
 * doing it a second time by accident.
 */
function defaultPeriodFor(stage: StageKey): Period {
  return stage === "screened" || stage === "reviewed"
    ? periodOf("week")
    : periodOf("year");
}

/** A deep link may name the stage to open and widen the period to reach it.
 *
 * The Dashboard's "Due in 14 days" counts across ALL time, while this page filters by when
 * a call was FOUND. Sending a reader to Bidding's own default would show fewer rows than
 * the number they just clicked - the two-pages-disagree fault, in a new place. So the link
 * carries `period=all` and the page honours it.
 *
 * Read once, as the initial state, rather than kept in sync: after landing, the period and
 * stage controls are the reader's, and a URL that kept overriding them would fight the
 * person using it.
 */
function linkIntent(): { stage: StageKey | null; wide: boolean } {
  try {
    const q = new URLSearchParams(window.location.search);
    const s = String(q.get("stage") || "").trim().toLowerCase();
    const stage = STAGES.some((x) => x.key === s) ? (s as StageKey) : null;
    return { stage, wide: String(q.get("period") || "").trim().toLowerCase() === "all" };
  } catch {
    return { stage: null, wide: false };
  }
}

export default function PipelinePage({ user }: { user: User }) {
  const intent = linkIntent();
  const [stage, setStage] = useState<StageKey>(intent.stage ?? "screened");
  const [period, setPeriod] = useState<Period>(() =>
    intent.wide
      // Wide enough to contain every row the Dashboard counted, whenever it was found.
      ? { kind: "custom", from: "1900-01-01", to: "2999-01-01" }
      : defaultPeriodFor(intent.stage ?? "screened"));
  // Once the reader moves the period themselves it is theirs, and changing stage stops
  // resetting it. Without this the per-stage default would undo a deliberate choice every
  // time somebody stepped along the line and back.
  const [pinnedPeriod, setPinnedPeriod] = useState(intent.wide);
  const pickPeriod = (p: Period) => { setPinnedPeriod(true); setPeriod(p); };
  const [weeks, setWeeks] = useState<Weeks | null>(null);
  const [week, setWeek] = useState<string | null>(null);

  useEffect(() => {
    fetchWeeks().then((w) => {
      setWeeks(w);
      // defaultWeek, not current: a review screen opens on the week just GONE, because the
      // team reviews it on the Monday after, when the current week is a day old and nearly
      // empty. `?? ` keeps a week the reader already picked — only the first value moves.
      setWeek((cur) => cur ?? w.defaultWeek);
    }).catch(() => undefined);
  }, [user.tenant?.id, user.view?.id]);

  return (
    <section>
      <PageHeader
        title="Pipeline"
        lead="Every opportunity across its lifecycle — found and screened, decided, then tracked through the bid."
      />

      {/* ONE CONTROL, AND IT IS THE ONE THAT WORKS HERE.

          Screened is keyed by a review WEEK: `ScreenedStage` takes week/weeks/onPickWeek
          and never reads `period` — grep it, the only hits are prose. So the period
          picker that used to sit here on this stage drove nothing at all. A reader could
          move the grain, step back a month, open the custom range, and watch the list not
          change, which is a worse lie than any wording: the control was answering for a
          filter that did not exist.

          It was survivable while Screened had one list. It stopped being survivable when
          the Triage section landed below (owner, 2026-11-18), because now there are two
          lists under it and the obvious reading of an inert control is "it governs the
          other one". The react-migration session's instinct was right — bind the control
          to the block it governs — and the honest version of that is to show only the
          control that governs something.

          The other four stages are date-ranged and keep the picker, with defaultPeriodFor
          and the pinning behind it untouched: a period chosen on Bidding still survives a
          walk down the line and back. */}
      {stage === "screened" ? (
        weeks && (
          <div className="mb-6 rounded-xl border border-ink-200 bg-white p-3 shadow-card">
            <label className="flex items-center gap-2 text-sm text-ink-600">
              Review week
              <Select value={week ?? weeks.defaultWeek}
                onChange={(e) => setWeek(e.target.value)} className="w-auto py-1.5">
                {weeks.weeks.map((w) => <option key={w} value={w}>{w}</option>)}
              </Select>
            </label>
          </div>
        )
      ) : (
        <PeriodPicker value={period} onChange={pickPeriod} />
      )}

      <StageLine
        stage={stage}
        onPick={(s) => {
          setStage(s);
          // Follow the stage only while the period is still a default. A reader who has
          // chosen one keeps it across the whole line.
          if (!pinnedPeriod) setPeriod(defaultPeriodFor(s));
        }}
      />

      <div className="mt-6">
        {stage === "screened" && (
          <>
            <ScreenedStage week={week} weeks={weeks} onPickWeek={setWeek} />
            <TriageSection user={user} />
          </>
        )}
        {/* A stage's own "show the whole year" button is the reader choosing a period
            just as deliberately as the picker above, so it pins too. */}
        {stage === "reviewed" && <ReviewedStage period={period} onPickPeriod={pickPeriod} />}
        {stage === "bidding" && <BiddingStage period={period} />}
        {stage === "submitted" && <SubmittedStage period={period} onPickPeriod={pickPeriod} />}
        {stage === "outcome" && <OutcomeStage period={period} onPickPeriod={pickPeriod} />}
      </div>
    </section>
  );
}

/**
 * TRIAGE, as a section of the Screened stage rather than a page (owner, 2026-11-18):
 * "i don't think it needs to sit on a page of its own. it can sit under Pipeline >
 * Screened ... sits own its own section as 'Triaged Calls - full list'".
 *
 * WHY IT BELONGS HERE. Screened is the stage where a call has been found and scored and
 * nobody has decided yet, and triage is the act of deciding. The block above it is that
 * work for the week the team is sitting down to; this is the same work with no week on it.
 *
 * THE SCOPE IS SAID TWICE, HERE AND IN THE BLOCK ABOVE, because the Review week control at
 * the top of the stage governs only that block. An all-time list under a week-scoped
 * control is exactly the arrangement a reader reports as a bug — "I set the week and the
 * list below ignored me" — so each list carries its own scope in its own heading, and this
 * one says what the control does not reach.
 *
 * It renders the SAME component the `/opportunities` key renders, with `embedded` to drop
 * the page heading. One list, two mount points: a change to what triage means cannot land
 * on one and miss the other.
 */
function TriageSection({ user }: { user: User }) {
  // Deep links from the Dashboard carry ?bucket=<figure> and used to land on a page whose
  // first element was the list. Here the list is below a stage, so an unscrolled landing
  // shows the week's block and looks like the tile went to the wrong place. Scroll to the
  // section when, and only when, the reader arrived by clicking a figure.
  useEffect(() => {
    try {
      if (!new URLSearchParams(window.location.search).get("bucket")) return;
    } catch {
      return;
    }
    // After paint, so the section exists and the list has laid out its filters.
    const id = window.setTimeout(() => {
      document.getElementById("triage")?.scrollIntoView({ block: "start" });
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <section id="triage" className="mt-10 border-t border-ink-100 pt-8">
      <h2 className="text-lg font-bold text-brand-700">Triaged calls — full list</h2>
      <p className="mt-1 text-sm text-ink-600">
        Every call, whichever week it was found in — the Review week above applies to the
        screened block, not to this one. Pick a Dashboard figure to see the rows behind
        it, then narrow by funder, lead or text.
      </p>
      <div className="mt-2">
        <OpportunitiesPage user={user} embedded />
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

