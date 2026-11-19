/**
 * The call, summarised, without leaving the table you are reading.
 *
 * THE PROBLEM IT SOLVES, in the owner's words: "the only way to view the details of the
 * call without leaving the screen is to click on the hyperlinked opportunity title". In a
 * review meeting that is the wrong trade — one person is presenting, they want the gist of
 * a row and its score, and navigating away loses the week they were walking through. So a
 * click anywhere on the row that is not a link opens this; the title still goes to the
 * full record.
 *
 * WHAT IT DOES NOT DO, deliberately: it does not re-implement the criteria editor. The
 * nine criteria are shown here with the answer stored against each and the score that
 * answer is worth, read straight off the row and coloured by `criterionScore` — the
 * scorer's OWN rule, not a second opinion about what "Yes" is worth. Changing one opens
 * `RfpEditor`, which is where every field on this record is edited and where the save
 * rules live. Two editors for one set of nine answers is exactly the drift this codebase
 * keeps paying for.
 *
 * WHAT IT DOES CHANGE, because the meeting needs it live: the DECISION. That is the act a
 * review is for, it is already a first-class route (`POST /pipelines/decision`, which
 * stamps the human override and queues the tombstone), and it is one control rather than
 * a form.
 */
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, ArrowUpRight, ExternalLink, Pencil, X,
} from "lucide-react";
import { fetchRfp, recordDecision, type Warning } from "../api";
import { CRITERIA, criterionScore } from "../../../supabase/functions/_shared/api/scorer";
import { CRITERION_LABELS } from "../../../supabase/functions/_shared/api/org_vocab";
import { hrefOf, Link } from "../router";
import { Badge, Button, Notice, Select, Spinner, type Tone } from "../ui";
import { callHref } from "./values";

/** The decisions a person may record. Mirrors ReviewedStage's own list. */
const DECISIONS = ["", "Proceed", "Proceed as sub", "Park", "Decline"] as const;

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v)).trim();
const lower = (v: unknown) => str(v).toLowerCase();

/** 2 → good, 1 → warn, 0 → bad, unscored → neutral. The scorer decides, not this file. */
function toneOfScore(s: number | null): Tone {
  return s === null ? "neutral" : s >= 2 ? "good" : s >= 1 ? "warn" : "bad";
}

const decisionTone = (d: string): Tone =>
  d.startsWith("proceed") ? "good" : d === "park" ? "warn" : d === "decline" ? "bad" : "neutral";

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.68rem] font-semibold tracking-wide text-ink-400 uppercase">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink-700">{children}</dd>
    </div>
  );
}

export default function OpportunityPeek({ uid, onClose, onEdit, onChanged }: {
  uid: string;
  onClose: () => void;
  /** Open the full editor on this row — where the criteria are overridden. */
  onEdit: (uid: string) => void;
  /** A decision was recorded, so the table behind this should reload. */
  onChanged?: () => void;
}) {
  const [row, setRow] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    setError(null);
    fetchRfp(uid)
      .then((r) => { setRow(r.row as Record<string, unknown>); setNote(str((r.row as Record<string, unknown>).decision_note)); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load this call."));
  }, [uid]);
  useEffect(load, [load]);

  // Escape closes it. A reader who opened this with a click expects to leave it the same
  // way they leave every other overlay in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const v = (k: string) => str(row?.[k]);
  const decision = lower(v("decision"));
  const effective = decision || lower(v("auto_recommendation"));
  const call = callHref(v("opportunity_link"));

  async function setDecision(next: string) {
    if (!next) return;
    setSaving(true);
    setError(null);
    try {
      const res = await recordDecision(uid, next, note || undefined);
      setWarnings(res.warnings ?? []);
      // A Decline whose tombstone was never written can be found again by the next scan,
      // so a null `recorded` is said out loud rather than smoothed over.
      if (!res.recorded) {
        setWarnings((w) => [...w, {
          code: "not_recorded",
          detail:
            "The decision is saved, but the background record was not queued — the next "
            + "scan may surface this call again.",
        }]);
      }
      load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record that decision.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/40 p-4 sm:p-8"
      role="dialog" aria-modal="true" aria-label="Opportunity summary"
      // The backdrop closes; a click inside must not. `currentTarget` is the backdrop
      // itself, so this fires only when the click really landed on it.
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-3xl rounded-xl bg-white shadow-float">
        <div className="flex items-start justify-between gap-4 border-b border-ink-200 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-lg leading-tight font-bold text-brand-700">
              {v("opportunity_title") || uid}
            </h2>
            <p className="mt-0.5 text-sm text-ink-600">{v("funding_agency") || "—"}</p>
            <p className="mt-1 font-mono text-xs text-ink-400 select-all">{uid}</p>
          </div>
          <button
            onClick={onClose} aria-label="Close"
            className="shrink-0 rounded-lg p-1 text-ink-400 hover:bg-ink-50 hover:text-ink-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && <Notice tone="bad" className="m-5">{error}</Notice>}
        {warnings.map((w, i) => (
          <Notice key={w.code + i} tone="warn" className="mx-5 mt-5"
            icon={<AlertTriangle className="h-4 w-4" />}>
            {w.detail}
          </Notice>
        ))}

        {!row && !error ? <Spinner label="Loading this call…" /> : row && (
          <div className="px-5 py-4">
            <dl className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
              <Line label="Deadline">{v("call_submission_deadline").slice(0, 10) || "—"}</Line>
              <Line label="Role">{v("applicant_role") || "—"}</Line>
              <Line label="Bid strength">
                <span className="font-semibold tabular-nums text-brand-700">
                  {v("alignment_score") ? Math.round(Number(v("alignment_score"))) : "—"}
                </span>
              </Line>
              <Line label="Decision">
                <Badge tone={decisionTone(effective)}>
                  {effective ? effective[0].toUpperCase() + effective.slice(1) : "—"}
                </Badge>
                {!decision && effective && (
                  <span className="ml-1.5 text-xs text-ink-400">auto</span>
                )}
              </Line>
            </dl>

            {v("brief_description") && (
              <div className="mt-4">
                <h3 className="text-[0.68rem] font-semibold tracking-wide text-ink-400 uppercase">
                  Summary
                </h3>
                {/* Capped, not cut: the meeting wants the gist, and the full text is one
                    click away on the record. */}
                <p className="mt-1 max-h-40 overflow-y-auto text-sm leading-relaxed text-ink-700">
                  {v("brief_description")}
                </p>
              </div>
            )}

            {v("key_risks") && (
              <div className="mt-4">
                <h3 className="text-[0.68rem] font-semibold tracking-wide text-ink-400 uppercase">
                  Key risks
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-700">{v("key_risks")}</p>
              </div>
            )}

            {/* THE SCORING MATRIX. Nine rows, the stored answer against each, and the
                score that answer is worth — `criterionScore`, the scorer's own rule, so
                the colour here and the number in the Score column cannot disagree. */}
            <div className="mt-5">
              <h3 className="text-[0.68rem] font-semibold tracking-wide text-ink-400 uppercase">
                Scoring matrix
              </h3>
              <div className="mt-2 grid gap-x-5 gap-y-1 sm:grid-cols-2">
                {CRITERIA.map((key) => {
                  const answer = v(key);
                  const s = criterionScore(key, answer);
                  return (
                    <div key={key}
                      className="flex items-baseline justify-between gap-3 border-b border-ink-100 py-1.5 last:border-0">
                      <span className="min-w-0 text-sm text-ink-700">
                        {CRITERION_LABELS[key] ?? key}
                      </span>
                      <Badge tone={toneOfScore(s)}>
                        {answer || "Not recorded"}
                      </Badge>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-ink-500">
                Change any of these in the editor — they are the scorer's inputs, and the
                score recalculates from them.
              </p>
            </div>

            {/* THE ONE THING CHANGED HERE. A review meeting exists to take this decision,
                and a human one always beats the engine's. */}
            <div className="mt-5 rounded-lg border border-ink-200 bg-ink-50/60 p-4">
              <label className="block text-sm font-semibold text-ink-800" htmlFor="peek-dec">
                Record a decision
              </label>
              <p className="mt-0.5 text-xs text-ink-500">
                Yours replaces the engine's and is kept as the human verdict.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <div className="w-44">
                  <Select
                    id="peek-dec" aria-label="Record a decision"
                    value={v("decision")} disabled={saving}
                    onChange={(e) => setDecision(e.target.value)}
                  >
                    {DECISIONS.map((x) => (
                      <option key={x || "blank"} value={x}>{x || "—"}</option>
                    ))}
                  </Select>
                </div>
                <input
                  value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="Why (optional) — saved with the next decision"
                  aria-label="Decision rationale"
                  className="min-w-0 flex-1 rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-800 placeholder:text-ink-400 outline-none focus:border-accent-600"
                />
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-200 px-5 py-3">
          {call && (
            <a
              href={call} target="_blank" rel="noreferrer"
              className="mr-auto inline-flex items-center gap-1.5 text-sm text-accent-700 hover:underline"
            >
              <ExternalLink className="h-4 w-4" /> The funder's own page
            </a>
          )}
          <Button variant="ghost" onClick={() => onEdit(uid)}
            icon={<Pencil className="h-4 w-4" />}>
            Edit everything
          </Button>
          <Link to={hrefOf("opportunity", { uid })}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white hover:bg-brand-800">
            <ArrowUpRight className="h-4 w-4" /> Open full record
          </Link>
        </div>
      </div>
    </div>
  );
}
