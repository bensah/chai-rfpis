/**
 * One opportunity, in full — a port of app_pages/opportunity.py.
 *
 * Two parts, in the order the decision gets made in:
 *   1. the call itself, restated in the RFPIS standard format, so two calls from different
 *      funders read the same way;
 *   2. the decision aid — our criteria and fit strength against this tenant.
 *
 * None of that structure is decided here. core/opportunity_detail.py lays the call out and
 * core/opportunity_scoring.py scores it, both in the browser's Python engine; this file
 * renders what they return.
 *
 * EVERY FIELD THE SCHEMA TRACKS IS ON THIS PAGE, including the ones this call says nothing
 * about, and that is the owner's rule rather than an oversight (opportunity_detail.sections,
 * 2026-08-11): "a dash is a statement — the field is tracked, this call is silent on it".
 * Dropping blank rows read better on one call and was wrong across a set of them, because
 * the page changed SHAPE from call to call and two calls could no longer be compared by eye.
 *
 * So this layout may never earn its quiet by hiding anything. It earns it by WEIGHT: a
 * stated value is set in solid ink and an unstated one recedes to a faint dash, both in the
 * same place on every call. The per-block "n/m" and the header's coverage line then say out
 * loud what the dashes mean — this call was thin, or this record is — which is the question
 * a page full of dashes otherwise leaves a reader to guess at.
 *
 * WHAT CHANGED, AND WHY IT IS NOT A DELETION. Every narrative field used to be rendered
 * TWICE: core/opportunity_detail composes all five of them into the page already
 * (`full_description` as the overview, `how_to_apply` and `compliance_requirements` through
 * INLINE_PROSE, the funded/not-funded pair through PROSE_ROWS), and this page then rendered
 * `narrative_sections` underneath, repeating the lot under their own headings.
 * app_pages/opportunity.py never did that — it renders overview_text + page_rows and stops.
 * The second copy is gone; no field went with it, and
 * tests/test_opportunity_detail_places_every_narrative.py fails if one ever would.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Layers, Pencil } from "lucide-react";
import { fetchOpportunityRows, type User } from "../api";
import OpportunityRail from "../components/OpportunityRail";
import RfpEditor from "../opportunity/RfpEditor";
import { scoreOpportunity, useEngine, warmEngine } from "../scoring/engine";
import type { Analysis, Block, Criterion, OpportunityResult } from "../scoring/protocol";
import { hrefOf, Link } from "../router";
import {
  Badge, Button, Card, EmptyState, Eyebrow, LinkButton, Notice, Spinner, type Tone,
} from "../ui";

/** opportunity_detail's chip tones, mapped onto the design system's. */
const CHIP_TONE: Record<string, Tone> = {
  closed: "bad", urgent: "bad", soon: "warn", open: "good",
};
const DECISION_TONE: Record<string, Tone> = {
  Proceed: "good", Park: "warn", Decline: "bad",
};

/** core/opportunity_detail.MISSING. The one string that means "this call is silent". */
const MISSING = "—";
const isMissing = (v: string) => v.trim() === MISSING || v.trim() === "";

// ── Page furniture ───────────────────────────────────────────────────────────

/** A numbered part of the page. Deliberately louder than a block title, which it used to
 *  compete with: both were bold brand-coloured text a size apart, so the eye could not
 *  tell the two levels apart and the page read as one long list. */
function Section({ step, title, lead, aside }: {
  step: string; title: string; lead?: React.ReactNode; aside?: React.ReactNode;
}) {
  return (
    <div className="mt-10 mb-5 border-b border-ink-200 pb-3 first:mt-0">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <Eyebrow>Part {step}</Eyebrow>
          <h2 className="text-xl font-bold text-brand-700">{title}</h2>
          {lead && <p className="mt-1 max-w-2xl text-sm text-ink-500">{lead}</p>}
        </div>
        {aside && <div className="shrink-0">{aside}</div>}
      </div>
    </div>
  );
}

/** One figure in the band under the header. */
function Fact({ label, value, sub, tone }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone;
}) {
  const colour = tone === "good" ? "text-good-700" : tone === "warn" ? "text-gold-700"
    : tone === "bad" ? "text-bad-700" : "text-brand-700";
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
        {label}
      </div>
      <div className={`mt-1 text-lg leading-tight font-bold ${colour}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-500">{sub}</div>}
    </div>
  );
}

function Lines({ lines, missing }: { lines: string[]; missing: boolean }) {
  if (missing) {
    return (
      <p className="text-sm text-ink-400 italic">Not stated in this call.</p>
    );
  }
  return (
    <>
      {lines.map((l, i) => (
        <p key={i} className="text-sm leading-relaxed text-ink-700">{l}</p>
      ))}
    </>
  );
}

/** A label/value pair. The whole design of this page lives in these six lines: a stated
 *  value is solid ink, an unstated one is a faint dash in the same place, so a reader
 *  sweeping the page sees the facts without the gaps being hidden from them. */
function Row({ label, value }: { label: string; value: string }) {
  const blank = isMissing(value);
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className={`shrink-0 basis-5/12 text-sm ${blank ? "text-ink-400" : "text-ink-500"}`}>
        {label}
      </dt>
      <dd className={`min-w-0 flex-1 text-right text-sm ${
        blank ? "text-ink-300" : "font-medium text-ink-800"}`}>
        {blank ? MISSING : value}
      </dd>
    </div>
  );
}

/** "3/5" — how much of THIS block the call filled in. Quiet, and only where there is
 *  something to count. It is not a judgement on the call; it is the answer to "is this
 *  section empty because the funder said nothing, or because we only track three things
 *  here?", which the dashes alone cannot give. */
function Filled({ rows }: { rows: [string, string][] }) {
  if (rows.length < 2) return null;
  const n = rows.filter(([, v]) => !isMissing(v)).length;
  return (
    <span
      title={`${n} of ${rows.length} fields in this section are stated in the call`}
      className={`shrink-0 rounded-full px-2 py-0.5 text-[0.7rem] font-semibold tabular-nums ${
        n === 0 ? "bg-ink-100 text-ink-400"
          : n === rows.length ? "bg-good-50 text-good-700" : "bg-ink-100 text-ink-600"}`}
    >
      {n}/{rows.length}
    </span>
  );
}

/** A fact block or a prose block from core/opportunity_detail.page_rows. */
function BlockView({ block }: { block: Block }) {
  if (block.kind === "prose") {
    return (
      <section className="mb-6">
        <h3 className="mb-1.5 text-sm font-semibold text-ink-800">{block.title}</h3>
        <Lines lines={block.lines} missing={block.missing} />
      </section>
    );
  }
  const body = (
    <>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-brand-700">{block.title}</h3>
        <Filled rows={block.rows} />
      </div>
      <dl className="divide-y divide-ink-100">
        {block.rows.map(([label, value], i) => <Row key={i} label={label} value={value} />)}
      </dl>
      {/* The subsection's own detail, under its rows and with no second heading —
          INLINE_PROSE in core/opportunity_detail. */}
      {block.prose.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-ink-100 pt-3">
          {block.prose.map((p, i) => (
            <p key={i} className="text-sm leading-relaxed text-ink-600">{p}</p>
          ))}
        </div>
      )}
      {/* …and the ones this call is silent on, which INLINE_PROSE would otherwise leave
          unnamed anywhere on the page. The name is the whole content: it says the app
          tracks this and the funder did not state it. */}
      {block.missingInline.length > 0 && (
        <div className="mt-3 border-t border-ink-100 pt-3">
          {block.missingInline.map((t) => (
            <p key={t} className="text-sm text-ink-400">
              {t} <span className="italic">— not stated in this call.</span>
            </p>
          ))}
        </div>
      )}
    </>
  );
  return block.kind === "cards"
    ? <Card className="mb-5 p-4">{body}</Card>
    : <section className="mb-6">{body}</section>;
}

// ── The decision aid ─────────────────────────────────────────────────────────

const BAND_BAR: Record<string, string> = {
  "2": "bg-good-600", "1": "bg-gold-500", "0": "bg-bad-600",
};

/** One criterion: what it asks, what we answered, and what that was worth.
 *
 * The bar is the criterion's POINTS against its own WEIGHT — how much of what this
 * criterion could have contributed it actually did. A flat list of nine numbers made every
 * criterion look equally decisive when their weights run from 0.08 to 0.15, so the row that
 * cost the most was indistinguishable from the one that cost least.
 */
function CriterionRow({ c }: { c: Criterion }) {
  const max = c.weight * 100;
  const pct = max > 0 ? Math.max(0, Math.min(100, (c.points / max) * 100)) : 0;
  const edge = c.band === 2 ? "border-l-good-600" : c.band === 1 ? "border-l-gold-500"
    : c.band === 0 ? "border-l-bad-600" : "border-l-ink-200";
  return (
    <div className={`mb-1.5 rounded-lg border border-ink-200 border-l-4 bg-white px-3.5 py-2.5 ${edge}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* No "must" badge: the title core/opportunity_scoring gives already leads with
            "MUST 1 ·" or "PREFER 6 ·". */}
        <span className="min-w-0 flex-1 text-sm text-ink-700">{c.title}</span>
        <span className={`text-sm font-semibold ${c.scored ? "text-ink-800" : "text-ink-400 italic"}`}>
          {c.label ?? "Not sure"}
        </span>
        <span className="min-w-24 text-right text-xs text-ink-400">{c.countText}</span>
        <span className="min-w-20 text-right text-xs font-semibold text-ink-700 tabular-nums">
          {c.points.toFixed(1)}
          <span className="font-normal text-ink-400"> / {max.toFixed(0)}</span>
        </span>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-ink-100">
        <div
          className={`h-full rounded-full ${BAND_BAR[String(c.band)] ?? "bg-ink-300"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function CriteriaGroup({ title, lead, rows }: {
  title: string; lead: string; rows: Criterion[];
}) {
  if (!rows.length) return null;
  const won = rows.reduce((t, c) => t + c.points, 0);
  const max = rows.reduce((t, c) => t + c.weight * 100, 0);
  return (
    <div className="mt-5">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <h3 className="text-sm font-bold text-brand-700">{title}</h3>
          <p className="text-xs text-ink-500">{lead}</p>
        </div>
        <span className="text-xs font-semibold text-ink-600 tabular-nums">
          {won.toFixed(1)} / {max.toFixed(0)} points
        </span>
      </div>
      {rows.map((c) => <CriterionRow key={c.key} c={c} />)}
    </div>
  );
}

function AnalysisView({ a, who }: { a: Analysis; who: string }) {
  if (a.error) {
    return <Notice tone="warn">Couldn't score this opportunity right now: {a.error}</Notice>;
  }
  const conf = a.confidence;
  const donorTxt = conf.donorMatched ? `${conf.donorPct}%` : "no funder profile";
  const moved = a.suggestedDecision !== a.systemDecision;
  // MUST 1–5 are the disqualifiers and PREFER 6–9 the preferences. The split is the
  // Python's own — its titles carry the words — so it is read off them rather than
  // restated as a list of keys here, which would be a second place to keep in step.
  const must = a.criteria.filter((c) => /^MUST/i.test(c.title));
  const prefer = a.criteria.filter((c) => !/^MUST/i.test(c.title));
  return (
    <>
      <p className="mb-3 text-sm text-ink-600">
        How this opportunity fares against <strong className="text-ink-800">{who}</strong>.
      </p>

      <Card className="divide-y divide-ink-200 sm:flex sm:divide-x sm:divide-y-0">
        <div className="flex-1 px-4 py-3">
          <div className="text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
            Bid strength
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-3xl leading-none font-bold text-brand-700 tabular-nums">
              {a.bidStrength}
            </span>
            <span className="text-sm font-medium text-ink-400">/ 100</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
            <div className="h-full rounded-full bg-accent-600"
              style={{ width: `${Math.max(0, Math.min(100, a.bidStrength))}%` }} />
          </div>
          <div className="mt-1.5 text-xs text-ink-500">{a.fit}</div>
        </div>
        <Fact
          label="Suggestion"
          value={<Badge tone={DECISION_TONE[a.suggestedDecision] ?? "neutral"} className="text-sm">
            {a.suggestedDecision}
          </Badge>}
          sub={moved ? `the rules alone said ${a.systemDecision}` : undefined}
        />
        <Fact
          label="Confidence"
          value={conf.band}
          sub={`data ${conf.pct}% · donor ${donorTxt} · call ${conf.callPct}%`}
        />
      </Card>

      <div className="mt-3 space-y-2">
        {a.screenedOut && a.screenReason && (
          <Notice tone="warn">
            Screening would keep this out of your pipeline: {a.screenReason}
          </Notice>
        )}
        {a.fatal && (
          <Notice tone="bad">
            Disqualifier: {a.fatalTrigger || "a must-have criterion is not met"}
          </Notice>
        )}
        {a.belowAwardFloor && (
          <Notice tone="warn">
            The award is below the floor your organisation pursues, so the suggestion is
            capped at Park.
          </Notice>
        )}
        {a.confidenceNote && <p className="text-sm text-ink-500">{a.confidenceNote}</p>}
      </div>

      <CriteriaGroup
        title="Must-haves" rows={must}
        lead="Any one of these failing is a reason not to bid."
      />
      <CriteriaGroup
        title="Preferences" rows={prefer}
        lead="These shape how attractive the bid is, not whether it is possible."
      />
    </>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

export default function OpportunityPage({ uid, user }: { uid: string; user: User }) {
  const [data, setData] = useState<OpportunityResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  /** Bumped when a save lands, to re-run the load effect below. The detail layout and the
   *  decision aid are both computed from the row, so an edit that changes a date or a
   *  criterion changes the page — re-reading is the only honest way to show the result. */
  const [saved, setSaved] = useState(0);
  const engine = useEngine();

  const onSaved = useCallback(() => setSaved((n) => n + 1), []);

  // This is the only surface left that needs the Python engine, so it starts it rather
  // than the app shell: nobody downloads a Python runtime until they open an opportunity.
  useEffect(() => {
    if (uid) warmEngine();
  }, [uid]);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    if (!uid) return;
    fetchOpportunityRows(uid)
      .then((rows) => scoreOpportunity(rows))
      .then((r) => live && setData(r as OpportunityResult))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Couldn't load it."));
    return () => {
      live = false;
    };
  }, [uid, saved]);

  const rail = (
    <div className="w-full shrink-0 lg:w-80">
      <OpportunityRail tenantName={user.view?.name ?? user.tenant?.name} />
    </div>
  );
  const frame = (body: React.ReactNode) => (
    <>
      <div className="flex flex-col gap-7 lg:flex-row">
        <div className="min-w-0 flex-1">{body}</div>
        {rail}
      </div>
      {/* The one editor. Mounted at the frame rather than inside the header so it survives
          the page's own loading states — a save re-reads the rows, and a dialog that
          unmounted while that happened would close itself on every save. */}
      {editing && (
        <RfpEditor uid={uid} onClose={() => setEditing(false)} onSaved={onSaved} />
      )}
    </>
  );

  if (!uid) {
    return frame(
      <Card>
        <EmptyState icon={<Layers className="h-5 w-5" />} title="No opportunity selected">
          Open one from the <strong>Live opportunity feed</strong> on Home or Pipelines.
          <div className="mt-4">
            <Link to={hrefOf("pipelines")} className="text-accent-700 hover:underline">Go to Pipelines</Link>
          </div>
        </EmptyState>
      </Card>,
    );
  }
  if (error) {
    return frame(<Notice tone="bad">Couldn't load <code>{uid}</code>: {error}</Notice>);
  }
  if (!data) {
    return frame(<Spinner label={engine.state === "starting" ? engine.detail : "Loading this opportunity…"} />);
  }
  if (!data.found) {
    return frame(
      <Card>
        <EmptyState icon={<Layers className="h-5 w-5" />} title="That opportunity isn't here">
          Nothing matches uid <code>{uid}</code>. It may have been deleted, or it belongs to another tenant.
          <div className="mt-4">
            <Link to={hrefOf("pipelines")} className="text-accent-700 hover:underline">Back to Pipelines</Link>
          </div>
        </EmptyState>
      </Card>,
    );
  }

  const d = data as OpportunityResult & { orgName?: string; link?: string };
  const cov = d.coverage;
  const pct = cov && cov.total ? Math.round((cov.filled / cov.total) * 100) : null;

  return frame(
    <>
      {/* THE HEADER, as one surface rather than a title with things stacked under it. The
          name, who is behind it, how it stands, and the two things you can do with it —
          read in that order without scrolling. */}
      <Card className="overflow-hidden">
        <div className="border-b border-ink-200 bg-brand-50/60 px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="min-w-0">
              <Eyebrow>{d.kind === "catalog" ? "From the catalogue" : "In your pipeline"}</Eyebrow>
              <h1 className="text-2xl leading-tight font-bold text-brand-700">{d.title}</h1>
              <p className="mt-1 text-sm text-ink-600">
                {d.funder}
                {d.reference && <span className="text-ink-400"> · {d.reference}</span>}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button variant="secondary" icon={<Pencil className="h-4 w-4" />}
                onClick={() => setEditing(true)}>
                Edit
              </Button>
              {d.link && (
                <LinkButton href={d.link} target="_blank" rel="noreferrer" variant="primary"
                  icon={<ArrowUpRight className="h-4 w-4" />}>
                  Open the call
                </LinkButton>
              )}
            </div>
          </div>
          {d.chips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {d.chips.map((c, i) => (
                <Badge key={i} tone={CHIP_TONE[c.tone] ?? "neutral"}>{c.text}</Badge>
              ))}
            </div>
          )}
        </div>

        {/* The three figures a bid/no-bid actually turns on, before any scrolling. */}
        <div className="grid grid-cols-1 divide-y divide-ink-200 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <Fact label="Award" value={d.awardHeadline || MISSING}
            sub={d.awardHeadline ? undefined : "no value stated in the call"} />
          <Fact
            label="Bid strength"
            value={d.analysis && !d.analysis.error
              ? <>{d.analysis.bidStrength}<span className="text-base font-medium text-ink-400">/100</span></>
              : MISSING}
            sub={d.analysis && !d.analysis.error ? d.analysis.fit : "not scored"}
          />
          <Fact
            label="Suggestion"
            value={d.analysis && !d.analysis.error ? d.analysis.suggestedDecision : MISSING}
            sub={d.analysis && !d.analysis.error
              ? `confidence ${d.analysis.confidence.band.toLowerCase()}` : undefined}
            tone={d.analysis && !d.analysis.error
              ? DECISION_TONE[d.analysis.suggestedDecision] : undefined}
          />
        </div>
      </Card>

      <Section
        step="1" title="The opportunity"
        lead="Every call is restated in the same shape, so two funders' calls can be compared line by line."
        aside={pct !== null && (
          <div className="text-right">
            <div className="text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
              Captured from the call
            </div>
            <div className="mt-1 flex items-center justify-end gap-2">
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-100">
                <div className="h-full rounded-full bg-accent-600" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-sm font-semibold text-ink-700 tabular-nums">
                {cov.filled}/{cov.total}
              </span>
            </div>
            <p className="mt-1 max-w-[16rem] text-xs text-ink-400">
              A dash below means this call is silent on that field, not that we stopped tracking it.
            </p>
          </div>
        )}
      />

      {d.overview.map(([heading, lines, missing], i) => (
        <section key={i} className="mb-6">
          <h3 className="mb-1.5 text-sm font-semibold text-ink-800">{heading}</h3>
          <div className="max-w-3xl">
            <Lines lines={lines} missing={missing} />
          </div>
          {d.overviewTruncated && d.link && (
            <p className="mt-2 text-xs text-ink-500">
              Clipped to keep the page readable.{" "}
              <a href={d.link} target="_blank" rel="noreferrer"
                className="font-medium text-accent-700 hover:underline">
                Read the funder's full text
              </a>
              .
            </p>
          )}
        </section>
      ))}

      {d.pageRows.map((row, i) => (
        <div key={i} className="grid gap-x-6 md:grid-cols-2">
          {row.map((col, j) => (
            <div key={j}>{col.map((b, k) => <BlockView key={k} block={b} />)}</div>
          ))}
        </div>
      ))}

      <Section
        step="2" title="Decision aid"
        lead="Is this worth bidding? The nine criteria, what each is worth, and where the score came from."
      />
      {d.analysis
        ? <AnalysisView a={d.analysis} who={d.orgName?.trim() || "your organisation"} />
        : (
          <Notice tone="neutral">
            No scoring is available for this opportunity yet. It needs a tenant profile and a screened
            row before the criteria can be evaluated.
          </Notice>
        )}
    </>,
  );
}
