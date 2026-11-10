// What the main thread and the scoring worker say to each other.
//
// The feed request/result pair that used to live here is gone: the rail is ranked by the
// server now (supabase/functions/_shared/api/opportunity_feed.ts). What remains is the one
// call the Opportunity page's decision aid still needs.

/** Everything the Python scoring path reads from the database, fetched once by the API.
 * See supabase/functions/_shared/api/routes_phase1.ts for how each piece is obtained. */
export type ScoringSnapshot = {
  tenant_id: string;
  /** Today as the SERVER sees it. Passed in so a browser in another timezone cannot
   * classify a deadline differently from Streamlit. */
  today: string;
  scan_policies: string | null;
  donor_intel: Record<string, unknown>[];
  org_profile: Record<string, unknown> | null;
  org_identity: Record<string, unknown> | null;
  user_programs: (string | null)[];
  tenants: Record<string, unknown>[];
  /** Live exchange rates the server already fetched: the browser has no network access to
   * the rate API and would otherwise fall back to a stale static table. */
  fx_rates: Record<string, [number | null, string | null]>;
};

export type OpportunityRequest = {
  uid: string;
  /** Candidate rows the API resolved for this uid — the worker picks between them with
   * core/opportunity_detail.load's own precedence rules. */
  pipelineRow: Record<string, unknown> | null;
  catalogRow: Record<string, unknown> | null;
  extraction: Record<string, unknown> | null;
  isSuper: boolean;
};

/** A fact block or a prose block from core/opportunity_detail.page_rows. */
export type Block =
  | {
      kind: "cards" | "facts"; title: string; rows: [string, string][];
      /** The subsection's own detail, under its rows and with no heading of its own —
       *  INLINE_PROSE in core/opportunity_detail. */
      prose: string[];
      /** The names of this block's inline-prose fields the call says nothing about.
       *  INLINE_PROSE appends nothing for a blank field, so without this the field's
       *  name is nowhere on the page — which breaks the page's own rule that a tracked
       *  field is always named. See _name_inline_gaps in worker.ts. */
      missingInline: string[];
    }
  | { kind: "prose"; title: string; lines: string[]; missing: boolean };

/** One of the nine weighted criteria, as core/opportunity_scoring.analyse returns it.
 *
 * Typed rather than read off a `Record<string, unknown>`, which is what the page did while
 * this declaration described fields (`name`, `tone`, `caption`) that the Python has not
 * returned for some time. A stale type that nothing checks is worse than none: it reads
 * like a contract.
 */
export type Criterion = {
  key: string;
  /** Already carries its own "MUST 1 · " / "PREFER 6 · " prefix. */
  title: string;
  label: string | null;
  /** 2 / 1 / 0, or null when the criterion could not be determined. */
  band: number | null;
  countText: string;
  scored: boolean;
  weight: number;
  points: number;
};

export type Analysis = {
  bidStrength: number;
  fit: string;
  systemDecision: string;
  suggestedDecision: string;
  confidenceNote: string;
  fatal: boolean;
  fatalTrigger: string;
  belowAwardFloor: boolean;
  screenedOut: boolean;
  screenReason: string;
  confidence: {
    band: string; pct: number; callPct: number; donorPct: number; donorMatched: boolean;
  };
  criteria: Criterion[];
  /** Set instead of everything above when scoring could not run at all. */
  error?: string;
};

/** How much of the call we actually captured — core/opportunity_detail.coverage.
 *
 * Served to every reader, not only a super_user. The page renders the schema's whole
 * skeleton on every call, dash and all (sections(), 2026-08-11: "a dash is a statement"),
 * so on a thinly-extracted call most of what is on screen is dashes. This is the one
 * number that tells a reader whether that is this call being silent or this record being
 * thin, and without it the page looks broken rather than honest.
 */
export type Coverage = { filled: number; total: number };

export type OpportunityResult = {
  found: boolean;
  kind: "pipeline" | "catalog" | null;
  title: string;
  chips: { text: string; tone: string }[];
  funder: string;
  reference: string;
  links: { label: string; url: string }[];
  awardHeadline: string;
  overview: [string, string[], boolean][];
  /** True when `full_description` was clipped to fit, so the page can offer the source
   *  instead of pretending the summary is the whole call. */
  overviewTruncated: boolean;
  pageRows: Block[][][];
  coverage: Coverage;
  // NO `narrative`. core/opportunity_detail composes every NARRATIVE_FIELD into the page
  // already — `full_description` as the overview, `how_to_apply` and
  // `compliance_requirements` through INLINE_PROSE, the two funded/not-funded fields
  // through PROSE_ROWS — so sending narrative_sections as well rendered all five A SECOND
  // TIME, under their own headings, further down the same page. app_pages/opportunity.py
  // never did: it renders overview_text + page_rows and stops.
  // tests/test_opportunity_detail_places_every_narrative.py keeps that composition
  // complete, so a field added to NARRATIVE_FIELDS cannot go unplaced here.
  analysis: Analysis | null;
  /** Only populated for a super_user: where each field came from. */
  provenance: [string, string][] | null;
  tracked: { uid: string | null; decision: string | null };
};

export type WorkerRequest =
  | { id: number; kind: "boot"; bundleUrl: string; snapshot: ScoringSnapshot }
  | { id: number; kind: "opportunity"; payload: OpportunityRequest };

export type WorkerResponse =
  | { id: number; ok: true; result: unknown; ms: number }
  | { id: number; ok: false; error: string }
  | { id: 0; progress: string };
