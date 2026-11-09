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
  | { kind: "cards" | "facts"; title: string; rows: [string, string][]; prose: string[] }
  | { kind: "prose"; title: string; lines: string[]; missing: boolean };

export type Criterion = {
  name: string;
  label: string;
  tone: string;
  caption: string;
  points: string;
};

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
  pageRows: Block[][][];
  narrative: [string, string[], boolean][];
  analysis: {
    score: number | null;
    band: string | null;
    recommendation: string | null;
    confidence: string | null;
    blockers: string[];
    notices: string[];
    criteria: Criterion[];
  } | null;
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
