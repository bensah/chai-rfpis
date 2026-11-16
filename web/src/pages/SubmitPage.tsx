/**
 * Submit New Notice — `app_pages/submit_rfp.py` + `views/submit_form.py`.
 *
 * The one screen where a person, rather than the Friday scan, is the source. Everything
 * the pipeline later does to an opportunity — screening, scoring, the decision, the bid —
 * starts from what is typed here, so the form's job is to make the fields that matter
 * downstream easy to fill and hard to fill WRONG. That is why almost every control is a
 * dropdown over a generated vocabulary rather than a box: a funder name typed four ways
 * splits four years of history across four funders.
 *
 * IT NEVER REFUSES A ROW FOR BEING A DUPLICATE (owner, 2026-06-05). De-duplication runs at
 * display time instead, so the dashboards do not double-count but the submitter's capture
 * is never lost. If you are tempted to add a "this looks like an existing call" gate here,
 * read api/submit.ts first — that gate existed and was removed on measurement.
 *
 * THE SCORE SHOWN ON SUCCESS is the form's own (`core/scorer.score_submission`), the same
 * number the Streamlit page reports. It is a coarser rule than the canonical
 * `auto_scorer.auto_score` that the queued re-score writes afterwards, and deliberately an
 * upper bound on it rather than a contradiction. When the re-score could not be started
 * the page says so instead of leaving the number looking settled.
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CheckCircle2, Clock } from "lucide-react";
import {
  fetchFormOptions, submitNotice, type FormOptions, type SubmitPayload, type SubmitResult,
} from "../api";
import { Choice, DateBox, Lbl, Multi, Num, Row, Text } from "../opportunity/controls";
import OpportunityRail from "../components/OpportunityRail";
import { hrefOf, navigate } from "../router";
import { Button, Card, LinkButton, Notice, PageHeader, Spinner, fieldClass } from "../ui";
import type { User } from "../api";

/**
 * The nine criteria, with the guiding text the MS Form and the Streamlit page both carry.
 *
 * The descriptions are not decoration: each criterion's answers read as a scale only if
 * you know which direction is which, and MUST 5 in particular ("Cofinancing & compliance")
 * covers two different things that used to be separate criteria. A submitter who guesses
 * writes a value that feeds the gauge and the auto-decision.
 */
const MUST: [string, string, string][] = [
  ["qualification", "MUST 1 — Legal status & qualification",
    "Are we legally eligible to apply — applicant/legal type, HQ country, "
    + "individual-vs-org award, and local registration? These are non-dynamic gates "
    + "(can't change before the deadline). Compliance paperwork (SAM, tax, partner, "
    + "board) now sits in MUST 5."],
  ["strategic_fit", "MUST 2 — Strategic fit",
    "Does this RFP fit our defined strategic priorities?"],
  ["capacity", "MUST 3 — Implementation capacity",
    "Can we implement at the stated award size and scope (team, systems, a grant size we "
    + "can manage)?"],
  ["geographic_fit", "MUST 4 — Geographic fit",
    "Does the funder's geographic scope align with where we currently have operations / "
    + "programs or a trusted partner?"],
  ["cofinancing", "MUST 5 — Cofinancing & compliance",
    "Can we meet any co-financing / match and the funder's compliance requirements "
    + "(SAM/UEI, tax-exempt, safeguarding, …)? Yes, fully met → we meet them all; Not met "
    + "→ at least one required item we can't meet (this gates the whole criterion)."],
];

const PREFER: [string, string, string][] = [
  ["funding_quality", "PREFER 6 — Funding quality",
    "Is the award size attractive — within our preferred funding range (not too small to "
    + "bother with, not beyond what we can absorb)?"],
  ["funder_relationship", "PREFER 7 — Donor relationship",
    "Do we have a relationship with this funder — a current/past grant, "
    + "registration/contact on their portal, OR a shared partner who already works with "
    + "this donor?"],
  ["competitiveness", "PREFER 8 — Competitiveness",
    "How well-positioned are we to win — track record in this exact area, incumbency, and "
    + "fit to the funder's requirements (board / grassroots / co-financing / multi-country "
    + "/ HQ)?"],
  ["bid_effort", "PREFER 9 — Bid effort",
    "Is the bid effort feasible — enough time to the deadline and a business-development "
    + "/ proposal team to do it justice? This one has no ‘Not sure’, so it starts on "
    + "the best answer — change it if time or the team is short."],
];

/**
 * What each criterion opens on — `views/submit_form.py::_crit`, which is one line:
 *
 *     didx = opts.index("Not sure") if "Not sure" in opts else 0
 *
 * Eight open on "Not sure", so the submitter sets only what they know. PREFER-9 has no
 * "Not sure" in its vocabulary and therefore opens on the FIRST option, which is the best
 * one — an untouched bid-effort claims ample time and a team. That is the Streamlit
 * behaviour and it is reproduced rather than corrected, because both apps are live and the
 * same input must not score two ways; the one mercy is that the dropdown shows it, so a
 * submitter can see what was assumed on their behalf. See api/submit.ts::criteriaValues.
 */
const defaultCriteria = (answers: Record<string, string[]>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k] of [...MUST, ...PREFER]) {
    const opts = answers[k] ?? [];
    out[k] = opts.includes("Not sure") ? "Not sure" : (opts[0] ?? "");
  }
  return out;
};

/**
 * A single-select whose vocabulary offers "Other", revealing a box for the real value.
 *
 * The TYPED value is what gets stored, not the word "Other" — `_single_with_other` in the
 * Python. A blank box after choosing Other stores nothing at all, which is why the Donor
 * field can still fail its required check while the dropdown reads as answered.
 */
function OtherChoice({ label, value, onChange, options, hint, required }: {
  label: string; value: string; onChange: (v: string) => void;
  options: string[]; hint?: string; required?: boolean;
}) {
  const [other, setOther] = useState(false);
  const canOther = options.includes("Other");
  return (
    <>
      <Choice
        label={label} required={required} hint={hint}
        options={options}
        value={other ? "Other" : value}
        onChange={(v) => {
          if (canOther && v === "Other") { setOther(true); onChange(""); return; }
          setOther(false);
          onChange(v);
        }}
      />
      {other && (
        <div className="-mt-2 mb-4">
          <Lbl>↳ Specify {label.replace(/ —.*/, "").toLowerCase()} *</Lbl>
          <input className={fieldClass} value={value} autoFocus
            onChange={(e) => onChange(e.target.value)} />
        </div>
      )}
    </>
  );
}

/** The multi-select counterpart — "Other" reveals a comma-separated box. */
function OtherMulti({ label, value, onChange, options, hint }: {
  label: string; value: string[]; onChange: (v: string[]) => void;
  options: string[]; hint?: string;
}) {
  const [extra, setExtra] = useState("");
  const canOther = options.includes("Other");
  // What the dropdown shows is the chosen list plus the marker; what leaves is the list
  // with the marker replaced by whatever was typed, as `_multi_with_other` builds it.
  const picked = useMemo(() => value.filter((v) => v !== "Other"), [value]);
  const [marked, setMarked] = useState(false);
  const push = (sel: string[], text: string) => {
    const typed = text.split(",").map((s) => s.trim()).filter(Boolean);
    onChange([...sel.filter((v) => v !== "Other"), ...typed]);
  };
  return (
    <>
      <Multi
        label={label} hint={hint} options={options}
        value={marked ? [...picked, "Other"] : picked}
        onChange={(sel) => {
          const wants = canOther && sel.includes("Other");
          setMarked(wants);
          push(sel, wants ? extra : "");
          if (!wants) setExtra("");
        }}
      />
      {marked && (
        <div className="-mt-2 mb-4">
          <Lbl>↳ Other {label.replace(/ —.*/, "").toLowerCase()}(s) — comma-separated *</Lbl>
          <input className={fieldClass} value={extra} autoFocus
            onChange={(e) => { setExtra(e.target.value); push(picked, e.target.value); }} />
        </div>
      )}
    </>
  );
}

export default function SubmitPage({ user }: { user: User }) {
  const [opts, setOpts] = useState<FormOptions | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState<SubmitResult | null>(null);

  const [f, setF] = useState<SubmitPayload>({ title: "", declineFlags: false });
  const [criteria, setCriteria] = useState<Record<string, string>>({});
  const set = <K extends keyof SubmitPayload>(k: K, v: SubmitPayload[K]) =>
    setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    fetchFormOptions()
      .then((o) => { setOpts(o); setCriteria(defaultCriteria(o.criterionAnswers)); })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Couldn't load the form."));
  }, []);

  // Section 5 appears only when we intend to pursue the bid. Hidden for Decline, and for
  // an unset decision — there is no team to name for a call nobody has decided on.
  const dec = (f.decision ?? "").trim().toLowerCase();
  const showTeam = dec.startsWith("proceed") || dec.startsWith("park");

  async function send() {
    setSaving(true);
    setProblems([]);
    setError("");
    try {
      setDone(await submitNotice({ ...f, criteria }));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      if (e && typeof e === "object" && "problems" in e) {
        setProblems((e as { problems: string[] }).problems ?? []);
      }
      setError(e instanceof Error ? e.message : "The submission could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <Notice tone="bad">Couldn't load the form: {loadError}</Notice>;
  if (!opts) return <Spinner label="Loading the form…" />;

  const d = opts.dropdowns;

  if (done) {
    return (
      <div className="mx-auto max-w-3xl">
        <Card className="p-6">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-good-600" />
            <div>
              <p className="text-lg font-semibold text-ink-800">
                Submitted as <code className="text-brand-700">{done.uid}</code>
              </p>
              <p className="mt-1 text-sm text-ink-600">
                Alignment score {done.alignmentScore.toFixed(1)}/100, auto-recommendation{" "}
                <strong>{done.autoRecommendation}</strong>.
              </p>
              <p className="mt-3 text-xs text-ink-500">
                Captured. Duplicate-detection runs at display time, so if this matches an
                existing record the dashboards will merge them automatically — no action
                needed from you.
              </p>
            </div>
          </div>

          {done.needsSubmissionCheck && (
            <Notice tone="warn" icon={<Clock className="h-4 w-4" />} className="mt-5">
              <p>
                <strong>This call's deadline has already passed.</strong> If you{" "}
                <strong>already submitted</strong> to the donor, open the opportunity and set{" "}
                <strong>Progress status = Completed</strong> (or record the donor decision,
                e.g. <em>Under review</em>). Otherwise the bid-effort score treats it as
                "not enough time" and it reads as a missed opportunity.
              </p>
              <p className="mt-2">
                <LinkButton href={hrefOf("opportunity", { uid: done.uid })} variant="primary">
                  Open {done.uid} to fix this <ArrowRight className="h-4 w-4" />
                </LinkButton>
              </p>
            </Notice>
          )}

          {done.warnings.map((w) => (
            <Notice key={w.code} tone="warn" className="mt-3">{w.detail}</Notice>
          ))}

          <div className="mt-6 flex gap-2">
            <Button onClick={() => {
              setDone(null);
              setF({ title: "", declineFlags: false });
              setCriteria(defaultCriteria(opts.criterionAnswers));
            }}>Submit another</Button>
            <Button variant="secondary"
              onClick={() => navigate(hrefOf("opportunity", { uid: done.uid }))}>
              Open {done.uid}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">
        <PageHeader
          title="Submit New Notice"
          lead={"Capture an opportunity you found outside the Friday scan. Submitted "
            + "immediately — duplicate-detection runs at display time, so re-entries are "
            + "merged in the dashboards automatically."}
        />
        <p className="mb-5 text-sm text-ink-500">
          Submitting as <strong>{user.name || user.email}</strong>. Sign out and back in to
          submit on behalf of another team member.
        </p>

        <Card className="mb-5 p-5">
          <h2 className="mb-4 text-base font-semibold text-ink-800">1. Opportunity description</h2>
          <Row>
            <Text label="Opportunity title" required value={f.title}
              onChange={(v) => set("title", v.slice(0, 300))} />
            <Text label="Opportunity ID (optional)" value={f.opportunityId ?? ""}
              onChange={(v) => set("opportunityId", v)} />
          </Row>
          <OtherChoice
            label="Donor" required options={d.donors ?? []} value={f.funder ?? ""}
            onChange={(v) => set("funder", v)}
            hint="The donor (full name) — matches the Donor Intelligence catalog. Pick
                  'Other' if not listed."
          />
          <Text label="Brief description" area value={f.brief ?? ""}
            onChange={(v) => set("brief", v)} />

          <Row cols={3}>
            <DateBox label="Date posted" value={f.datePosted ?? ""}
              onChange={(v) => set("datePosted", v)} />
            <DateBox label="Submission deadline" value={f.deadline ?? ""}
              onChange={(v) => set("deadline", v)} />
            <DateBox label="Expected award date" value={f.awardDate ?? ""}
              onChange={(v) => set("awardDate", v)} />
          </Row>

          <Row cols={4}>
            <Choice label="Applicant role" options={d.applicant_role ?? []}
              value={f.applicantRole ?? ""} onChange={(v) => set("applicantRole", v)}
              tip="How the lead applicant participates: Prime (lead beneficiary), Sub
                   (sub-recipient), or Technical (assists another applicant — e.g. a
                   government on a Pandemic Fund bid — without being a beneficiary)." />
            <Choice label="Funding window" options={d.funding_window ?? []}
              value={f.fundingWindow ?? ""} onChange={(v) => set("fundingWindow", v)} />
            <Choice label="Time to award" options={d.time_to_award ?? []}
              value={f.timeToAward ?? ""} onChange={(v) => set("timeToAward", v)} />
            <OtherChoice label="Submission format" options={d.submission_format ?? []}
              value={f.submissionFormat ?? ""} onChange={(v) => set("submissionFormat", v)} />
          </Row>

          <Row cols={3}>
            <Text label="Opportunity link (URL)" value={f.link ?? ""}
              onChange={(v) => set("link", v)}
              hint="Needed to share this call to the pool other tenants' scans read." />
            <Num label="Estimated value" step="10000" value={f.value ?? ""}
              onChange={(v) => set("value", v)} />
            <Choice label="Currency" options={opts.currencies}
              value={f.currency ?? ""} onChange={(v) => set("currency", v)} />
          </Row>

          <Row>
            <Num label="Project duration (months)" value={f.duration ?? ""}
              onChange={(v) => set("duration", v)} />
            <Text label="Focus theme (optional)" value={f.focusTheme ?? ""}
              onChange={(v) => set("focusTheme", v)} />
          </Row>

          <Row>
            <Text label="Lead applicant" required value={f.leadApplicant ?? ""}
              onChange={(v) => set("leadApplicant", v)}
              hint="The organisation leading the application — e.g. your org, or a
                    government / partner you are supporting. Always required." />
            <Text label="Sub applicant (optional)" value={f.subApplicant ?? ""}
              onChange={(v) => set("subApplicant", v)}
              hint="Sub-recipient / co-applicant, if one is known at the time you log the
                    opportunity." />
          </Row>

          <OtherMulti label="Geographic scope" options={opts.geoOptions}
            value={f.geo ?? []} onChange={(v) => set("geo", v)} />
          <OtherMulti label="Program area(s)" options={opts.programAreas}
            value={f.programAreas ?? []} onChange={(v) => set("programAreas", v)} />
        </Card>

        <Card className="mb-5 p-5">
          <h2 className="mb-1 text-base font-semibold text-ink-800">2. Eligibility</h2>
          <p className="mb-4 text-sm text-ink-500">
            Answer each criterion with the best-fit option. <strong>Not sure</strong> leaves
            it unscored (treated as missing — it won't drag the score down). MUST 1–5 are
            hard; any clear <strong>No</strong> means decline.
          </p>
          <Row>
            <div>
              {MUST.map(([k, label, desc]) => (
                <Criterion key={k} label={label} desc={desc}
                  options={opts.criterionAnswers[k] ?? []} value={criteria[k] ?? ""}
                  onChange={(v) => setCriteria((p) => ({ ...p, [k]: v }))} />
              ))}
            </div>
            <div>
              {PREFER.map(([k, label, desc]) => (
                <Criterion key={k} label={label} desc={desc}
                  options={opts.criterionAnswers[k] ?? []} value={criteria[k] ?? ""}
                  onChange={(v) => setCriteria((p) => ({ ...p, [k]: v }))} />
              ))}
            </div>
          </Row>
          <div className="max-w-xs">
            <Choice label="Feasibility (your read)" options={d.feasibility ?? []}
              value={f.feasibility ?? ""} onChange={(v) => set("feasibility", v)}
              hint="Optional, and not scored."
              tip="Your subjective gut-rating of how promising this RFP is — the human
                   analogue of the auto-scan's Proceed/Park/Decline tier." />
          </div>
        </Card>

        <Card className="mb-5 p-5">
          <h2 className="mb-4 text-base font-semibold text-ink-800">3. Decline flags & risks</h2>
          <Lbl hint="Your judgement, not a derived value — it is stored as you answer it.">
            Decline flags present? <span className="text-bad-600">*</span>
          </Lbl>
          <div className="mb-4 flex gap-4 text-sm">
            {[["No", false], ["Yes", true]].map(([label, on]) => (
              <label key={String(label)} className="flex items-center gap-1.5">
                <input type="radio" name="decline" checked={f.declineFlags === on}
                  onChange={() => set("declineFlags", on as boolean)} />
                {label}
              </label>
            ))}
          </div>
          <Text label="Key risks (one line)" area value={f.keyRisks ?? ""}
            onChange={(v) => set("keyRisks", v)} />
        </Card>

        <Card className="mb-5 p-5">
          <h2 className="mb-4 text-base font-semibold text-ink-800">
            4. Initial decision (your recommendation)
          </h2>
          <Row>
            <Choice label="Bid decision" required options={d.decisions ?? []}
              value={f.decision ?? ""} onChange={(v) => set("decision", v)} />
            <Text label="Decision rationale (1–2 lines)" area value={f.rationale ?? ""}
              onChange={(v) => set("rationale", v)} />
          </Row>
        </Card>

        {showTeam && (
          <Card className="mb-5 p-5">
            <h2 className="mb-1 text-base font-semibold text-ink-800">5. Team</h2>
            <p className="mb-4 text-sm text-ink-500">
              Shown because the decision is Proceed or Park — there is a bid to staff.
            </p>
            <div className="max-w-md">
              <OtherChoice label="Proposal lead" required options={opts.teamMembers}
                value={f.proposalLead ?? ""} onChange={(v) => set("proposalLead", v)} />
            </div>
            <OtherMulti label="Contributors" options={opts.teamMembers}
              value={f.contributors ?? []} onChange={(v) => set("contributors", v)} />
            <OtherMulti label="Reviewers" options={opts.teamMembers}
              value={f.reviewers ?? []} onChange={(v) => set("reviewers", v)} />
          </Card>
        )}

        {error && (
          <Notice tone="bad" className="mb-4">
            {error}
            {problems.length > 0 && (
              <ul className="mt-2 list-disc pl-5">
                {problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
            )}
          </Notice>
        )}

        <div className="mb-10">
          <Button variant="primary" onClick={send} disabled={saving}>
            {saving ? "Submitting…" : "Submit RFP"}
          </Button>
        </div>
      </div>

      <div className="min-w-0">
        <OpportunityRail tenantName={user.view?.name ?? user.tenant?.name} />
      </div>
    </div>
  );
}

/** One criterion: its question, the guiding text, then the answers. */
function Criterion({ label, desc, options, value, onChange }: {
  label: string; desc: string; options: string[]; value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="mb-5">
      <p className="text-sm font-semibold text-ink-800">{label}</p>
      <p className="mb-1.5 text-xs text-ink-500">{desc}</p>
      <Choice label="" options={options} value={value} onChange={onChange} />
    </div>
  );
}
