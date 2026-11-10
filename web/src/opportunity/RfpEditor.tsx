/**
 * THE editor. One form, one table, every screen.
 *
 * A port of `views/rfp_editor.py`, which exists in the Streamlit app for exactly the reason
 * it exists here: Records, Tracking, Review and Funding all used to edit the same
 * `rfp_submissions` row through four different forms, and four forms meant four answers to
 * "which columns does saving this touch". Everything that edits an opportunity in this app
 * opens THIS component — the Opportunity page, and every stage of the Pipeline — so an
 * edit made from one screen is the same edit made from another.
 *
 * ONE TABLE. Every field below is a column of `rfp_submissions`, written through
 * `PATCH /pipelines/rfp/:uid`, which refuses any column name that is not on its own
 * `EDITABLE` list. The single exception is the Reporting tab, whose five fields belong to
 * the linked `applied_funding` row; that is the same split the Python makes, and the same
 * route handles it, so grant reporting is still edited in one place rather than two.
 *
 * WHAT THIS DOES NOT DO, and why:
 *
 *   * It does not score. `views/rfp_editor.py` calls `score_submission` and writes
 *     `alignment_score` / `auto_recommendation` itself. Doing that here would be a SECOND
 *     implementation of the scoring rules — the drift that had 70/45 and 90/70 standing for
 *     the same number for months. The PATCH route queues the `rescore` job instead, which
 *     runs the one `core.auto_scorer.auto_score`, so the score on screen right after a save
 *     is the OLD one and the page says so.
 *
 *   * It does not delete the row itself, and neither does the route behind the button.
 *     The Python tombstones the row first (`seen_ledger`) so the next scan does not
 *     re-ingest the call, and that logic is deliberately Python's. Half a delete — the row
 *     removed without the tombstone — is precisely the "we keep declining this and it
 *     keeps coming back" bug. So `DELETE /pipelines/rfp/:uid` queues a job that records
 *     and then removes, and the dialog WAITS for it rather than claiming an opportunity is
 *     gone while it is still on the table. That wait is the visible cost of the ordering
 *     and it is the right way round: see `pipeline_writes.ts::deleteRfp`.
 *
 *   * It does not write a decision through PATCH. Recording a decision carries two
 *     consequences a field edit does not: the ML training label and the scan's tombstone.
 *     `POST /pipelines/decision` does both; PATCH does neither. So when the decision or its
 *     rationale changes, the save sends that through the decision route and everything else
 *     through PATCH. The Streamlit editor writes `decision` straight into its update dict
 *     and skips `decision_date` entirely, which is how a decision could be recorded without
 *     the row ever being marked human-reviewed.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Trash2, X } from "lucide-react";
import {
  currentSession, deleteRfp, fetchFormOptions, fetchRfp, recordDecision, saveRfp,
  type FormOptions, type Warning,
} from "../api";
import { awaitJob, JOB_STATUS_LABEL } from "../jobs";
import MultiSelect from "../components/MultiSelect";
import { Button, IconButton, Notice, Select, Spinner, fieldClass } from "../ui";
import {
  changedColumns, columnValue, dateText, numText, orNull, readRow, txt,
  type Form, type FormValue,
} from "./values";

// ── Small controls ───────────────────────────────────────────────────────────

function Row({ children, cols = 2 }: { children: React.ReactNode; cols?: 2 | 3 | 4 }) {
  const c = cols === 4 ? "sm:grid-cols-4" : cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  return <div className={`grid grid-cols-1 gap-x-4 ${c}`}>{children}</div>;
}

function Lbl({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5 text-sm font-medium text-ink-700" title={hint}>{children}</div>
  );
}

function Text({ label, value, onChange, hint, area, required }: {
  label: string; value: string; onChange: (v: string) => void;
  hint?: string; area?: boolean; required?: boolean;
}) {
  return (
    <div className="mb-4">
      <Lbl hint={hint}>{label}{required && <span className="text-bad-600"> *</span>}</Lbl>
      {area
        ? <textarea className={`${fieldClass} min-h-24`} value={value}
            onChange={(e) => onChange(e.target.value)} />
        : <input className={fieldClass} value={value}
            onChange={(e) => onChange(e.target.value)} />}
      {hint && <p className="mt-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

function Num({ label, value, onChange, step = "1", hint }: {
  label: string; value: string; onChange: (v: string) => void; step?: string; hint?: string;
}) {
  return (
    <div className="mb-4">
      <Lbl hint={hint}>{label}</Lbl>
      <input type="number" min="0" step={step} className={fieldClass} value={value}
        onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="mt-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

function DateBox({ label, value, onChange, hint }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string;
}) {
  return (
    <div className="mb-4">
      <Lbl hint={hint}>{label}</Lbl>
      <input type="date" className={fieldClass} value={value}
        onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="mt-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

/**
 * A controlled vocabulary, with one rule worth stating: a value already on the row that is
 * NOT in the list stays selectable. `_opt` and `_type_select` both do this, and it is not
 * politeness — a row carrying a value an older vocabulary allowed would otherwise be
 * silently rewritten to something else the moment anyone opened the editor on it.
 */
function Choice({ label, value, onChange, options, hint, blank = "—" }: {
  label: string; value: string; onChange: (v: string) => void;
  options: string[]; hint?: string; blank?: string;
}) {
  const opts = useMemo(() => {
    const list = [...new Set(options)];
    return value && !list.includes(value) ? [...list, value] : list;
  }, [options, value]);
  return (
    <div className="mb-4">
      <Lbl hint={hint}>{label}</Lbl>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{blank}</option>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </Select>
      {hint && <p className="mt-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

function Multi({ label, value, onChange, options, hint }: {
  label: string; value: string[]; onChange: (v: string[]) => void;
  options: string[]; hint?: string;
}) {
  // Same rule as Choice: stored values the vocabulary has since dropped stay selected.
  const opts = useMemo(
    () => [...new Set([...options, ...value])], [options, value]);
  return (
    <div className="mb-4">
      <MultiSelect label={label} options={opts} value={value} onChange={onChange} help={hint} />
      {hint && <p className="mt-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

// ── The nine criteria ────────────────────────────────────────────────────────

const MUST: [string, string][] = [
  ["qualification", "MUST 1 — Legal status & qualification"],
  ["strategic_fit", "MUST 2 — Strategic fit"],
  ["capacity", "MUST 3 — Implementation capacity"],
  ["geographic_fit", "MUST 4 — Geographic fit"],
  ["cofinancing", "MUST 5 — Cofinancing & compliance"],
];
const PREFER: [string, string][] = [
  ["funding_quality", "PREFER 6 — Funding quality"],
  ["funder_relationship", "PREFER 7 — Donor relationship"],
  ["competitiveness", "PREFER 8 — Competitiveness"],
  ["bid_effort", "PREFER 9 — Bid effort"],
];

const CRITERIA = [...MUST, ...PREFER].map(([k]) => k);

/**
 * Open a criterion on the answer its stored value means, not on the string itself.
 *
 * Live rows carry the LEGACY vocabulary — plain "Yes" / "Partial" / "No", and the
 * per-criterion labels that preceded the current ones. Shown raw, such a value became a
 * tenth, stray option in a nine-option dropdown and was written straight back on save, so
 * the vocabulary could never converge. `views/rfp_editor.py` has always resolved it
 * through `core/scorer.default_response`.
 *
 * The mapping is resolved SERVER-SIDE (`criterionDefaults`) because `default_response`
 * runs through `criterion_score` — the rule that turns a label into 2/1/0 — and a second
 * implementation of a scoring rule is exactly what this migration exists to avoid.
 *
 * A spelling the table does not know (free text somebody typed) is left exactly as it is:
 * `Choice` keeps an unrecognised stored value selectable, so nothing is lost and the odd
 * value stays visible rather than being quietly replaced by a guess.
 */
function resolveCriteria(f: Form, o: FormOptions): Form {
  const out = { ...f };
  for (const key of CRITERIA) {
    const stored = txt(out[key]).trim();
    if (!stored) continue;
    if ((o.criterionAnswers[key] ?? []).includes(stored)) continue;
    const mapped = o.criterionDefaults[key]?.[stored.toLowerCase()];
    if (mapped) out[key] = mapped;
  }
  return out;
}

const TABS = [
  "Opportunity", "Eligibility", "Decision & Pipeline", "Team", "Submission & Award",
  "Application", "Reporting",
] as const;
type TabName = (typeof TABS)[number];

export type RfpEditorProps = {
  uid: string;
  onClose: () => void;
  /**
   * The saved row, so the screen behind can update without a refetch.
   *
   * ALSO CALLED AFTER A DELETE, with `{ uid, deleted: true }` rather than a row, because
   * there is no row any more and a deleted opportunity must not be left sitting on the
   * table behind the dialog. Every caller today simply reloads and ignores the argument;
   * `deleted` is there for the one that should do more than reload — the Opportunity page,
   * which is a page ABOUT the row that just stopped existing.
   */
  onSaved?: (row: Record<string, unknown>) => void;
  /** The auto-synthesised Application detail. Shown when reviewing a call; hidden on a
   *  grant, where it belongs on Review — `show_application` in the Python. */
  showApplication?: boolean;
  /** The linked grant's reporting fields. Shown only from a funding screen, so grant
   *  reporting is edited in one place — `show_reporting` in the Python. */
  showReporting?: boolean;
};

export default function RfpEditor({
  uid, onClose, onSaved, showApplication = true, showReporting = false,
}: RfpEditorProps) {
  // Read rather than threaded through a prop: five Pipeline stages open this dialog and
  // none of them is given the user, so a prop would have had four components carrying a
  // value only the footer line below uses.
  const session = currentSession();
  const viewingAs = session?.user.view ?? null;
  /**
   * `core/permissions.is_admin` — role admin or super_user — which is the gate the
   * Streamlit button uses (`disabled=not is_admin`). Hidden rather than disabled here: a
   * greyed-out Delete tells a contributor the app can do something they may not, which is
   * noise on a screen they use every day. The route checks the same thing and is what
   * actually enforces it; this only decides whether to offer it.
   */
  const canDelete = session?.user.role === "admin" || session?.user.role === "super_user";
  const [opts, setOpts] = useState<FormOptions | null>(null);
  const [loaded, setLoaded] = useState<Form | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [grant, setGrant] = useState<Record<string, unknown> | null>(null);
  const [reporting, setReporting] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState<Record<string, unknown>>({});
  const [tab, setTab] = useState<TabName>("Opportunity");
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  /** Blank means "today" at the decision route, which is right for a decision recorded as
   *  it is taken and wrong for one recorded weeks later. Only sent when the decision moves. */
  const [decisionDate, setDecisionDate] = useState("");
  /** The confirmation step, and then what the removal job is doing. Separate, because
   *  "are you sure" and "it is being removed" are different screens and the second one
   *  must not be dismissible. */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([fetchRfp(uid, showReporting), fetchFormOptions()])
      .then(([rec, o]) => {
        if (!live) return;
        // Resolved into BOTH the baseline and the working copy, so a legacy row opens on
        // the right answer without the dialog claiming nine edits nobody made. The stored
        // string is upgraded when somebody actually touches that criterion.
        const f = resolveCriteria(readRow(rec.row), o);
        setLoaded(f);
        setForm({ ...f });
        setMeta(rec.row);
        setGrant(rec.grant);
        setReporting({
          status: txt(rec.grant?.status),
          report_type: txt(rec.grant?.report_type),
          report_due_date: dateText(rec.grant?.report_due_date),
          owner: txt(rec.grant?.owner),
          remarks: txt(rec.grant?.remarks),
        });
        setOpts(o);
      })
      .catch((e: unknown) =>
        live && setError(e instanceof Error ? e.message : "Couldn't open this opportunity."));
    return () => { live = false; };
  }, [uid, showReporting]);

  // Escape closes, like every other dialog in the app.
  useEffect(() => {
    // Escape must not walk out of a delete that is already running: the job is away and
    // closing would leave the person with no idea whether it landed.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || deleting) return;
      if (confirmingDelete) setConfirmingDelete(false);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, confirmingDelete, deleting]);

  const set = useCallback(
    (col: string, v: FormValue) => setForm((f) => (f ? { ...f, [col]: v } : f)), []);

  const dirty = useMemo(
    () => (form && loaded ? changedColumns(form, loaded) : []), [form, loaded]);

  const reportingDirty = useMemo(() => {
    if (!showReporting) return false;
    const was = {
      status: txt(grant?.status), report_type: txt(grant?.report_type),
      report_due_date: dateText(grant?.report_due_date), owner: txt(grant?.owner),
      remarks: txt(grant?.remarks),
    };
    return Object.keys(was).some((k) => was[k as keyof typeof was] !== (reporting[k] ?? ""));
  }, [showReporting, grant, reporting]);

  const save = async () => {
    if (!form) return;
    setProblems([]);
    setError(null);
    setSavedNote(null);
    setWarnings([]);
    if (!txt(form.opportunity_title).trim() || !txt(form.funding_agency).trim()) {
      setError("Title and Funder are required.");
      setTab("Opportunity");
      return;
    }
    setSaving(true);
    try {
      const notes: Warning[] = [];
      let row: Record<string, unknown> | null = null;

      // The decision travels its own route — see the file header. Sent first, so that if
      // the field save then fails the human verdict is still on the row.
      const decisionMoved = dirty.includes("decision");
      const noteMoved = dirty.includes("decision_note");
      if (decisionMoved || noteMoved) {
        const d = txt(form.decision).trim();
        if (!d) {
          setError("Clearing a decision isn't something this form can do — a decision is " +
            "recorded, not unset. Change it to Proceed, Park or Decline instead.");
          setTab("Decision & Pipeline");
          setSaving(false);
          return;
        }
        const res = await recordDecision(
          uid, d, txt(form.decision_note), decisionDate || undefined);
        row = res.row as unknown as Record<string, unknown>;
        notes.push(...(res.warnings ?? []));
      }

      const fields: Record<string, unknown> = {};
      for (const col of dirty) {
        if (col === "decision" || col === "decision_note") continue;
        fields[col] = columnValue(col, form[col]);
      }

      const sendReporting = showReporting && (reportingDirty || Object.keys(fields).length > 0);
      if (Object.keys(fields).length || sendReporting) {
        const res = await saveRfp(
          uid, fields,
          sendReporting
            ? {
              status: orNull(reporting.status ?? ""),
              report_type: orNull(reporting.report_type ?? ""),
              report_due_date: orNull(reporting.report_due_date ?? ""),
              owner: orNull(reporting.owner ?? ""),
              remarks: orNull(reporting.remarks ?? ""),
            }
            : undefined,
        );
        row = res.row;
        notes.push(...(res.warnings ?? []));
        if (res.rescore) {
          notes.push({
            code: "rescoring",
            detail: "Saved. The score is being recalculated in the background, so the " +
              "number on screen is the one from before this edit until the job lands.",
          });
        }
      }

      if (!row) {
        setSavedNote("Nothing had changed, so nothing was saved.");
        setSaving(false);
        return;
      }
      const next = opts ? resolveCriteria(readRow(row), opts) : readRow(row);
      setLoaded(next);
      setForm(next);
      setMeta(row);
      setWarnings(notes);
      setSavedNote(`Saved ${uid}.`);
      setDecisionDate("");
      onSaved?.(row);
    } catch (e) {
      if (e && typeof e === "object" && "problems" in e) {
        setProblems((e as { problems: string[] }).problems ?? []);
      }
      setError(e instanceof Error ? e.message : "That change could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  /**
   * Delete, which is a different shape from every other action in this dialog: the server
   * answers 202 with a job and the row is STILL THERE. It is only gone once the runner has
   * written the scan's tombstone and then removed it, in that order, so this waits for the
   * job before it says anything is gone — `pipeline_writes.ts::deleteRfp` is where the
   * ordering is argued, and the wait is its one visible cost.
   *
   * Three endings, and they are deliberately not the same sentence:
   *   done        — it is gone; close, and tell the screen behind so the row leaves the table.
   *   failed      — nothing was removed; stay open with the reason, and the row is still editable.
   *   ran out     — still running; do NOT claim either way. Reload the screen behind, because
   *                 it may land a second from now, and leave the dialog saying so.
   */
  const remove = async () => {
    setError(null);
    setProblems([]);
    setWarnings([]);
    setSavedNote(null);
    setDeleting("Recording the removal, so the next scan does not find this call again…");
    try {
      const res = await deleteRfp(uid);
      const job = await awaitJob(res.queued.job_id, (j) =>
        setDeleting(j.progress?.message
          ? `${j.progress.message}…`
          : `${JOB_STATUS_LABEL[j.status]}…`));

      if (job?.status === "done") {
        onSaved?.({ uid, deleted: true });
        onClose();
        return;
      }
      setConfirmingDelete(false);
      setDeleting(null);
      if (job && (job.status === "failed" || job.status === "cancelled")) {
        setError("The opportunity was NOT deleted. " +
          (job.message ?? "The removal could not be completed.") +
          " Nothing has been changed — you can try again.");
        return;
      }
      // Still going. Saying "deleted" would be a guess, and so would "failed".
      setWarnings([{
        code: "delete_still_running",
        detail: "The removal has been recorded and is still running. This opportunity " +
          "will disappear from the pipeline once it lands — there is nothing more to do.",
      }]);
      onSaved?.({ uid, deleted: false });
    } catch (e) {
      setConfirmingDelete(false);
      setDeleting(null);
      setError(e instanceof Error
        ? e.message
        : "The opportunity could not be deleted, and nothing was changed.");
    }
  };

  const shown = TABS.filter((t) =>
    (t !== "Application" || showApplication) && (t !== "Reporting" || showReporting));

  const body = () => {
    if (error && !form) return <Notice tone="bad">{error}</Notice>;
    if (!form || !opts) return <Spinner label="Opening the editor…" />;
    const d = opts.dropdowns;
    const v = (c: string) => txt(form[c]);
    const l = (c: string) => form[c] as string[];

    switch (tab) {
      case "Opportunity":
        return (
          <>
            <Row cols={3}>
              <div className="sm:col-span-2">
                <Text label="Title" required value={v("opportunity_title")}
                  onChange={(x) => set("opportunity_title", x)} />
              </div>
              <Text label="Opportunity ID" value={v("opportunity_id")}
                onChange={(x) => set("opportunity_id", x)} />
            </Row>
            <Text label="Funder" required value={v("funding_agency")}
              onChange={(x) => set("funding_agency", x)} />
            <Text label="Brief description" area value={v("brief_description")}
              onChange={(x) => set("brief_description", x)} />
            <Row cols={3}>
              <DateBox label="Date posted" value={v("date_posted")}
                onChange={(x) => set("date_posted", x)} />
              <DateBox label="Submission deadline" value={v("call_submission_deadline")}
                onChange={(x) => set("call_submission_deadline", x)} />
              <DateBox label="Expected award" value={v("expected_award_date")}
                onChange={(x) => set("expected_award_date", x)} />
            </Row>
            <Row cols={4}>
              <Choice label="Applicant role" value={v("applicant_role")}
                onChange={(x) => set("applicant_role", x)} options={d.applicant_role ?? []} />
              <Choice label="Funding window" value={v("funding_window")}
                onChange={(x) => set("funding_window", x)} options={d.funding_window ?? []} />
              <Choice label="Time to award" value={v("time_to_award")}
                onChange={(x) => set("time_to_award", x)} options={d.time_to_award ?? []} />
              <Choice label="Submission format" value={v("submission_format")}
                onChange={(x) => set("submission_format", x)} options={d.submission_format ?? []} />
            </Row>
            <Row>
              <Text label="Lead applicant" value={v("lead_applicant")}
                onChange={(x) => set("lead_applicant", x)}
                hint="The prime / lead institution on this application." />
              <Text label="Sub applicant" value={v("sub_applicant")}
                onChange={(x) => set("sub_applicant", x)}
                hint="Sub-recipient / co-applicant, if any." />
            </Row>
            <Row cols={4}>
              <div className="sm:col-span-2">
                <Text label="Opportunity link" value={v("opportunity_link")}
                  onChange={(x) => set("opportunity_link", x)} />
              </div>
              <Num label="Estimated value" step="10000" value={v("call_award_value")}
                onChange={(x) => set("call_award_value", x)} />
              <Choice label="Currency" value={v("currency")}
                onChange={(x) => set("currency", x)} options={opts.currencies}
                hint="What the call was advertised in." />
            </Row>
            <Row>
              <Num label="Duration (months)" value={v("project_duration")}
                onChange={(x) => set("project_duration", x)} />
              <Text label="Focus theme" value={v("focus_theme")}
                onChange={(x) => set("focus_theme", x)} />
            </Row>
            <Multi label="Geographic scope" value={l("call_geographic_scope")}
              onChange={(x) => set("call_geographic_scope", x)} options={opts.geoOptions} />
            <Multi label="Program area(s)" value={l("call_domain_areas")}
              onChange={(x) => set("call_domain_areas", x)} options={opts.programAreas} />
            <Row>
              <Text label="Funding opportunity number" value={v("funding_opportunity_number")}
                onChange={(x) => set("funding_opportunity_number", x)} />
              <Text label="Apply URL (funder portal)" value={v("apply_url")}
                onChange={(x) => set("apply_url", x)}
                hint="Where applicants actually submit, if different from the opportunity link." />
            </Row>
            <Row cols={3}>
              <Choice label="Opportunity type" value={v("opportunity_type")}
                onChange={(x) => set("opportunity_type", x)} options={opts.opportunityTypes}
                blank=""
                hint="What pursuing this IS. Procurement / Consultancy / Training / Loan are excluded by the eligibility gate for a grant-seeking org." />
              <Choice label="Solicitation type" value={v("solicitation_type")}
                onChange={(x) => set("solicitation_type", x)} options={opts.solicitationTypes}
                blank="" hint="How the call is announced and applied to." />
              <Choice label="Instrument type" value={v("instrument_type")}
                onChange={(x) => set("instrument_type", x)} options={opts.instrumentTypes}
                blank="" hint="The contract if awarded." />
            </Row>
            <Text label="Notes" area value={v("notes")} onChange={(x) => set("notes", x)}
              hint="Free-form internal notes on this opportunity." />
          </>
        );

      case "Eligibility":
        return (
          <>
            <div className="sm:max-w-xs">
              <Choice label="Feasibility" value={v("feasibility")}
                onChange={(x) => set("feasibility", x)} options={d.feasibility ?? []} />
            </div>
            <Row>
              <div>
                {MUST.map(([key, label]) => (
                  <Choice key={key} label={label} value={v(key)}
                    onChange={(x) => set(key, x)}
                    options={opts.criterionAnswers[key] ?? d.eligibility_values ?? []}
                    blank="Not recorded" />
                ))}
              </div>
              <div>
                {PREFER.map(([key, label]) => (
                  <Choice key={key} label={label} value={v(key)}
                    onChange={(x) => set(key, x)}
                    options={opts.criterionAnswers[key] ?? d.eligibility_values ?? []}
                    blank="Not recorded" />
                ))}
              </div>
            </Row>
            <div className="mb-4">
              <Lbl>Decline flags present?</Lbl>
              <div className="flex gap-4">
                {[["No", false], ["Yes", true]].map(([label, val]) => (
                  <label key={String(label)} className="flex items-center gap-2 text-sm text-ink-700">
                    <input type="radio" name="decline" checked={form.decline_flags_present === val}
                      onChange={() => set("decline_flags_present", val as boolean)} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <Text label="Key risks" area value={v("key_risks")}
              onChange={(x) => set("key_risks", x)} />
            <Notice tone="neutral">
              Stored Bid Strength <strong>{numText(meta.alignment_score) || "—"}</strong> ·
              auto-decision <strong>{txt(meta.auto_recommendation) || "—"}</strong>.
              Saving a change here queues a recalculation, which runs the same scorer the scan
              does — so the number above is the one from before this edit until that lands.
            </Notice>
          </>
        );

      case "Decision & Pipeline":
        return (
          <>
            <Row cols={3}>
              <Choice label="Decision" value={v("decision")}
                onChange={(x) => set("decision", x)} options={d.decisions ?? []} />
              <div className="sm:col-span-2">
                <Text label="Rationale" area value={v("decision_note")}
                  onChange={(x) => set("decision_note", x)} />
              </div>
            </Row>
            {dirty.includes("decision") && (
              <div className="sm:max-w-xs">
                <DateBox label="Decision taken on" value={decisionDate}
                  onChange={setDecisionDate}
                  hint="Leave blank for today. Set it when the team settled this earlier than it was typed in." />
              </div>
            )}
            <Row cols={3}>
              <Num label="Submissions" value={v("submissions")}
                onChange={(x) => set("submissions", x)}
                hint="How many times this was actually submitted to the funder. 0 until submitted." />
              <Choice label="Stage" value={v("stage")} onChange={(x) => set("stage", x)}
                options={d.stages ?? []} />
              <Choice label="Progress status" value={v("progress_status")}
                onChange={(x) => set("progress_status", x)} options={d.progress_status ?? []} />
            </Row>
            <Row>
              <Choice label="Donor decision" value={v("donor_decision")}
                onChange={(x) => set("donor_decision", x)} options={d.donor_decision ?? []}
                hint="The funder's answer — a different act from the decision above." />
              <Choice label="Assigned to" value={v("assigned_to")}
                onChange={(x) => set("assigned_to", x)} options={opts.teamMembers}
                hint="From Admin → Settings → Team members." />
            </Row>
            {txt(form.progress_status).toLowerCase() === "completed"
              && !txt(form.donor_decision).trim() && (
              <Notice tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>
                Progress is Completed but no donor decision is recorded, so this row will not
                appear in Applied Funding. Set it once the funder answers — nothing is
                written for you.
              </Notice>
            )}
            <Row>
              <DateBox label="Action deadline" value={v("action_deadline")}
                onChange={(x) => set("action_deadline", x)} />
              <DateBox label="Last update" value={v("last_update")}
                onChange={(x) => set("last_update", x)} />
            </Row>
            <Text label="Next action" value={v("next_action")}
              onChange={(x) => set("next_action", x)} />
            <Text label="Remarks" area value={v("remarks")}
              onChange={(x) => set("remarks", x)} />
          </>
        );

      case "Team":
        return (
          <>
            <Choice label="Proposal lead" value={v("proposal_lead")}
              onChange={(x) => set("proposal_lead", x)} options={opts.teamMembers} />
            <Multi label="Contributors" value={l("contributors")}
              onChange={(x) => set("contributors", x)} options={opts.teamMembers} />
            <Multi label="Reviewers" value={l("reviewers")}
              onChange={(x) => set("reviewers", x)} options={opts.teamMembers} />
            <Multi label="Support" value={l("support_roles")}
              onChange={(x) => set("support_roles", x)} options={d.support_roles ?? []}
              hint="Functions this proposal needs — technical, finance, compliance. Not people; name individuals under Contributors and Reviewers." />
          </>
        );

      case "Submission & Award":
        return (
          <>
            <Row>
              <DateBox label="Date submitted" value={v("date_completed")}
                onChange={(x) => set("date_completed", x)}
                hint="When the proposal went to the funder." />
              <Num label="Amount requested" step="10000" value={v("amount_requested")}
                onChange={(x) => set("amount_requested", x)} />
            </Row>
            <Row>
              <Num label="Award floor (per grant)" step="10000" value={v("call_award_floor")}
                onChange={(x) => set("call_award_floor", x)} />
              <Num label="Award ceiling (per grant)" step="10000" value={v("call_award_ceiling")}
                onChange={(x) => set("call_award_ceiling", x)} />
            </Row>
            <Row>
              <Num label="Total program funding" step="100000" value={v("total_program_funding")}
                onChange={(x) => set("total_program_funding", x)} />
              <Num label="Expected # awards" value={v("expected_awards")}
                onChange={(x) => set("expected_awards", x)} />
            </Row>
            <Row>
              <DateBox label="Date of approval" value={v("date_of_approval")}
                onChange={(x) => set("date_of_approval", x)} />
              <Num label="Amount secured" step="10000" value={v("amount_secured")}
                onChange={(x) => set("amount_secured", x)} />
            </Row>
            <Row>
              <Choice label="Currency" value={v("currency_secured")}
                onChange={(x) => set("currency_secured", x)} options={opts.currencies}
                hint="The currency of the amounts on this tab. The call's own advertised currency is on the Opportunity tab." />
              <Text label="Donor program officer" value={v("donor_program_officer")}
                onChange={(x) => set("donor_program_officer", x)} />
            </Row>
            <Row>
              <DateBox label="Kick-off date" value={v("kickoff_date")}
                onChange={(x) => set("kickoff_date", x)} />
              <Text label="Next step" value={v("next_step")}
                onChange={(x) => set("next_step", x)} />
            </Row>
          </>
        );

      case "Application":
        return (
          <>
            <Notice tone="neutral" className="mb-4">
              Synthesised from the call at scan time. Edits here are yours and are not
              overwritten by a later scan.
            </Notice>
            <Text label="How to apply" area value={v("how_to_apply")}
              onChange={(x) => set("how_to_apply", x)} />
            <Text label="Eligibility specifics" area value={v("eligibility_specifics")}
              onChange={(x) => set("eligibility_specifics", x)} />
            <Text label="Compliance requirements" area value={v("compliance_requirements")}
              onChange={(x) => set("compliance_requirements", x)} />
            <Text label="Application checklist" area value={v("application_checklist")}
              onChange={(x) => set("application_checklist", x)} />
          </>
        );

      case "Reporting": {
        const r = (k: string) => reporting[k] ?? "";
        const setR = (k: string, x: string) => setReporting((p) => ({ ...p, [k]: x }));
        return (
          <>
            <Row>
              <Choice label="Report status" value={r("status")}
                onChange={(x) => setR("status", x)} options={d.report_statuses ?? []} />
              <Choice label="Report type" value={r("report_type")}
                onChange={(x) => setR("report_type", x)} options={d.report_types ?? []} />
            </Row>
            <Row>
              <DateBox label="Report due date" value={r("report_due_date")}
                onChange={(x) => setR("report_due_date", x)} />
              <Text label="Reporting owner" value={r("owner")}
                onChange={(x) => setR("owner", x)} />
            </Row>
            <Text label="Reporting remarks" area value={r("remarks")}
              onChange={(x) => setR("remarks", x)} />
            {!grant && (
              <Notice tone="neutral">
                No reporting record yet. Saving with a status or type creates one linked to
                this grant.
              </Notice>
            )}
          </>
        );
      }
    }
  };

  const submittedBy = txt(meta.submitted_by).trim();
  const submittedEmail = txt(meta.submitted_by_email).trim();

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-brand-950/50 p-4 backdrop-blur-[2px] sm:p-8"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-label={`Edit ${uid}`}
        className="dialog-panel w-full max-w-5xl rounded-2xl bg-white shadow-float">
        <div className="sticky top-0 z-10 rounded-t-2xl border-b border-ink-200 bg-white/95 px-6 pt-5 pb-0 backdrop-blur-md">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-xl leading-tight font-bold text-brand-700">
                {txt(form?.opportunity_title) || uid}
              </h2>
              <p className="mt-1 text-sm text-ink-500">
                <code className="text-ink-600">{uid}</code>
                {submittedBy && <> · submitted by {submittedBy}</>}
                {submittedEmail && <> · {submittedEmail}</>}
              </p>
            </div>
            <IconButton onClick={onClose} label="Close"><X className="h-5 w-5" /></IconButton>
          </div>
          <div className="-mb-px mt-4 flex flex-wrap gap-1 overflow-x-auto">
            {shown.map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`rounded-t-lg border-b-2 px-3.5 py-2 text-sm whitespace-nowrap transition-colors ${
                  t === tab
                    ? "border-accent-600 font-semibold text-brand-700"
                    : "border-transparent text-ink-500 hover:text-brand-700"}`}>
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="px-6 py-5">
          {error && form && (
            <Notice tone="bad" className="mb-4" role="alert">
              {error}
              {problems.length > 0 && <> ({problems.join(", ")})</>}
            </Notice>
          )}
          {savedNote && <Notice tone="good" className="mb-4">{savedNote}</Notice>}
          {warnings.map((w) => (
            <Notice key={w.code} tone="warn" className="mb-4"
              icon={<AlertTriangle className="h-4 w-4" />}>{w.detail}</Notice>
          ))}
          {body()}
        </div>

        <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-b-2xl border-t border-ink-200 bg-white/95 px-6 py-4 backdrop-blur-md">
          <p className="text-xs text-ink-500">
            {dirty.length || reportingDirty
              ? `${dirty.length + (reportingDirty ? 1 : 0)} change${
                dirty.length + (reportingDirty ? 1 : 0) === 1 ? "" : "s"} not yet saved`
              : "No unsaved changes"}
            {viewingAs && <> · editing as {viewingAs.name}</>}
          </p>
          <div className="flex gap-2">
            {/* Where the Python has it, and only for the people the Python offers it to.
                Leftmost and in the danger variant, well away from the primary button the
                same hand is about to reach for. */}
            {canDelete && (
              <Button variant="danger" icon={<Trash2 className="h-4 w-4" />}
                onClick={() => setConfirmingDelete(true)} disabled={!form || saving}>
                Delete this RFP
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>Close</Button>
            <Button variant="primary" onClick={save} busy={saving}
              disabled={!form || (!dirty.length && !reportingDirty)}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      </div>

      {confirmingDelete && (
        <DeleteConfirm
          uid={uid}
          title={txt(form?.opportunity_title)}
          funder={txt(form?.funding_agency)}
          deleting={deleting}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={remove}
        />
      )}
    </div>,
    document.body,
  );
}

/**
 * The one irreversible act in this dialog, so it is asked as a question with the answer
 * spelled out rather than an "Are you sure?".
 *
 * It NAMES the opportunity — title, funder, uid — because this dialog is opened from five
 * different tables and the row under the cursor is not always the row in the editor. It
 * says what else happens, because the tombstone is not a detail: the opportunity is also
 * being recorded as rejected so the scan stops finding it, and somebody who wanted it back
 * tomorrow should know that now rather than discover it then.
 *
 * Once the work has started there is no cancel and no backdrop click. The job is away; an
 * escape hatch here would close the only screen that can say whether it landed.
 */
function DeleteConfirm({ uid, title, funder, deleting, onCancel, onConfirm }: {
  uid: string; title: string; funder: string;
  deleting: string | null; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-brand-950/50 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && !deleting && onCancel()}>
      <div role="alertdialog" aria-modal="true" aria-label="Delete this opportunity"
        className="dialog-panel w-full max-w-lg rounded-2xl bg-white p-6 shadow-float">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-lg bg-bad-50 p-2 text-bad-700">
            <Trash2 className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg leading-tight font-bold text-brand-700">
              Delete this opportunity?
            </h3>
            <p className="mt-2 text-sm text-ink-700">
              <strong className="text-ink-900">{title || uid}</strong>
              {funder && <> — {funder}</>}
              <br />
              <code className="text-xs text-ink-500">{uid}</code>
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-3 text-sm text-ink-700">
          <p>
            <strong className="text-bad-700">This cannot be undone.</strong> The
            opportunity and everything recorded against it — the decision, the nine
            criteria, the team's notes — are removed from the pipeline.
          </p>
          <p>
            It is also recorded as rejected, so the next scan does not find the same call
            and add it back.
          </p>
        </div>

        {deleting
          ? (
            <div className="mt-6">
              <Spinner label={deleting} />
              <p className="mt-2 text-xs text-ink-500">
                This runs on the server and can take a minute. Leave this open.
              </p>
            </div>
          )
          : (
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" onClick={onCancel}>Keep it</Button>
              <Button variant="danger" icon={<Trash2 className="h-4 w-4" />}
                onClick={onConfirm}>
                Delete permanently
              </Button>
            </div>
          )}
      </div>
    </div>
  );
}
