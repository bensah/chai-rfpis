/**
 * Settings → Sources, Learning data and Suggestions — the three developer surfaces.
 *
 * ONE FILE because they share one fact: everything on them belongs to EVERY tenant, not
 * to the organisation whose Settings page you opened. Each says so on screen rather than
 * leaving a reader to wonder why another organisation's data is in their account — which
 * is the question the Streamlit page records having been asked.
 *
 * The gates are the server's and are not re-derived here: a payload either carries the
 * data with `canEdit…` true, or it carries a refusal with the reason in it.
 */
import { useEffect, useState } from "react";
import {
  Ban, CheckCircle2, Database, GitPullRequestArrow, Globe, Plus, Save, Trash2, XCircle,
} from "lucide-react";
import {
  approveSuggestion, fetchLearning, fetchSources, fetchSuggestions, rejectSuggestion,
  saveBlockedTokens,
  type LearningData, type SourcesData, type SuggestionsData,
} from "../api";
import { Badge, Button, Card, Eyebrow, Notice, Spinner, fieldClass } from "../ui";

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const num = (n: number) => n.toLocaleString();

/** A shared-resource banner. Every one of these tabs needs it; none of them is yours. */
function SharedNote({ children }: { children: React.ReactNode }) {
  return (
    <Notice tone="brand" icon={<Globe className="h-4 w-4" />} className="mb-4">
      {children}
    </Notice>
  );
}

function useLoad<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => fn().then((d) => { setData(d); setError(null); })
    .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load this."));
  useEffect(() => { void reload(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload };
}

// ── Sources ──────────────────────────────────────────────────────────────────

export function SourcesTab() {
  const { data, error, reload } = useLoad<SourcesData>(fetchSources);
  const [tab, setTab] = useState<"Validated" | "Blocked">("Validated");

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Spinner label="Loading the sources catalogue…" />;

  return (
    <div>
      <div role="tablist" className="mb-4 flex flex-wrap gap-1">
        {(["Validated", "Blocked"] as const).map((t) => (
          <button
            key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)}
            className={`rounded-lg px-3.5 py-1.5 text-sm transition-colors ${
              t === tab ? "bg-brand-50 font-semibold text-brand-700"
                : "text-ink-600 hover:bg-ink-100 hover:text-ink-900"}`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Validated" ? (
        <Card className="p-6">
          <div className="flex items-center gap-2.5">
            <Database className="h-5 w-5 text-accent-600" />
            <Eyebrow>Validated sources catalogue</Eyebrow>
          </div>
          <p className="mt-1 mb-4 text-sm leading-relaxed text-ink-600">
            The curated funding URLs every scan iterates over, in addition to the
            keyword-wide sources in the repository's own config. {data.catalog.length}{" "}
            source{data.catalog.length === 1 ? "" : "s"}.
          </p>
          {data.note && <SharedNote>{data.note}</SharedNote>}
          <CatalogGrid rows={data.catalog} />
          <p className="mt-3 text-xs text-ink-500">
            Adding a source, and classifying a host as an aggregator or a primary funder,
            is still done on the classic Settings page under Verify Registry — it is a
            judgement about a host rather than an edit to a row, with its own flow.
          </p>
        </Card>
      ) : (
        <BlockedTokens data={data} onSaved={reload} />
      )}
    </div>
  );
}

function CatalogGrid({ rows }: { rows: Record<string, unknown>[] }) {
  // The columns a reader of a CATALOGUE needs: who, where, how it is fetched, and
  // whether a scan will actually visit it. The table has many more; showing them all
  // turns a catalogue into a database dump.
  const cols: [string, string][] = [
    ["donor_name", "Source"], ["rfp_listing_url", "Listing URL"],
    ["scrape_method", "Method"], ["is_active", "Active"],
  ];
  return (
    <div className="overflow-x-auto rounded-lg border border-ink-200">
      <table className="w-full text-sm">
        <thead className="bg-ink-50 text-left text-xs font-semibold text-ink-600 uppercase">
          <tr>{cols.map(([, l]) => <th key={l} className="px-3 py-2">{l}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {rows.length === 0 && (
            <tr><td colSpan={cols.length} className="px-3 py-5 text-ink-400">
              No sources in the catalogue.
            </td></tr>
          )}
          {rows.map((r, i) => (
            <tr key={s(r.id) || i} className="hover:bg-ink-50">
              <td className="px-3 py-2 font-medium text-ink-900">{s(r.donor_name) || "—"}</td>
              <td className="max-w-96 px-3 py-2">
                {s(r.rfp_listing_url) ? (
                  <a href={s(r.rfp_listing_url)} target="_blank" rel="noreferrer"
                    className="break-all text-accent-700 hover:underline">
                    {s(r.rfp_listing_url)}
                  </a>
                ) : <span className="text-ink-300">—</span>}
              </td>
              <td className="px-3 py-2"><code className="text-xs">{s(r.scrape_method) || "—"}</code></td>
              <td className="px-3 py-2">
                <Badge tone={r.is_active ? "good" : "neutral"}>
                  {r.is_active ? "Active" : "Off"}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BlockedTokens({ data, onSaved }: { data: SourcesData; onSaved: () => void }) {
  // `reason` is nullable on the row and must not be in the form: a null in a controlled
  // input makes React drop back to uncontrolled, and the field then stops responding to
  // anything the component does to it. The server turns "" back into null on the way in.
  const [rows, setRows] = useState<{ pattern: string; reason: string }[]>(
    () => data.blocked.map((b) => ({ pattern: s(b.pattern), reason: s(b.reason) })));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  if (!data.canEditBlocked) {
    return (
      <Card className="p-6">
        <Eyebrow>Blocked tokens</Eyebrow>
        <Notice tone="brand" className="mt-3" icon={<Ban className="h-4 w-4" />}>
          These patterns drop candidate URLs for every tenant's scan, so they are managed
          from a developer tenant rather than per organisation.
        </Notice>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2.5">
        <Ban className="h-5 w-5 text-accent-600" />
        <Eyebrow>Blocked tokens</Eyebrow>
      </div>
      <p className="mt-1 mb-2 text-sm leading-relaxed text-ink-600">
        Each pattern is matched as a <strong>case-insensitive substring of the candidate
        URL</strong> during scanning. Any match and the link is rejected before scoring,
        and never becomes a record.
      </p>
      <p className="mb-4 text-xs text-ink-500">
        A bare domain (<code>cdc.gov</code>) blocks a whole site; a path fragment
        (<code>/donate</code>, <code>/careers</code>) blocks a section.
      </p>
      <SharedNote>
        This list applies to every organisation's scan, not only yours.
      </SharedNote>

      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <input
              className={`${fieldClass} min-w-48 flex-1 font-mono text-sm`}
              value={s(r.pattern)} placeholder="cdc.gov" aria-label={`Pattern ${i + 1}`}
              onChange={(e) => setRows(rows.map((x, j) =>
                (j === i ? { ...x, pattern: e.target.value } : x)))}
            />
            <input
              className={`${fieldClass} min-w-48 flex-1`} value={s(r.reason)}
              placeholder="Why it is blocked" aria-label={`Reason ${i + 1}`}
              onChange={(e) => setRows(rows.map((x, j) =>
                (j === i ? { ...x, reason: e.target.value } : x)))}
            />
            <button
              type="button" aria-label={`Remove ${s(r.pattern) || "pattern"}`}
              className="rounded p-1.5 text-ink-400 transition-colors hover:bg-bad-50 hover:text-bad-700"
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <Button className="mt-2" icon={<Plus className="h-4 w-4" />}
        onClick={() => setRows([...rows, { pattern: "", reason: "" }])}>
        Add a pattern
      </Button>

      <div className="mt-5 border-t border-ink-200 pt-5">
        <Button
          variant="primary" busy={busy} icon={<Save className="h-4 w-4" />}
          onClick={async () => {
            setBusy(true); setSaved(null); setFailed(null);
            try {
              const r = await saveBlockedTokens(rows);
              // The server's OWN answer, not the rows that were sent: it trims, drops
              // blanks and de-duplicates case-insensitively, so what came back is what
              // is actually in force. Showing the submitted list would claim otherwise.
              setRows(r.rows.map((x) => ({ pattern: s(x.pattern), reason: s(x.reason) })));
              setSaved(`${r.rows.length} pattern${r.rows.length === 1 ? "" : "s"} in force`
                + (r.removed ? `, ${r.removed} removed.` : "."));
              onSaved();
            } catch (e) {
              setFailed(e instanceof Error ? e.message : "Save failed.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Save blocked tokens
        </Button>
        {saved && (
          <Notice tone="good" className="mt-3" icon={<CheckCircle2 className="h-4 w-4" />}>
            {saved} Blank rows are dropped, and two spellings of one pattern are stored
            once — they are matched case-insensitively, so they were always one rule.
          </Notice>
        )}
        {failed && <Notice tone="bad" className="mt-3">{failed}</Notice>}
      </div>
    </Card>
  );
}

// ── Learning data ────────────────────────────────────────────────────────────

const SIGNAL_LABELS: Record<string, string> = {
  system_reject: "System rejects",
  human_decision: "Human decisions",
  feedback: "Thumbs up / down",
  reject_verification: "Reject verdicts",
};

export function LearningTab() {
  const { data, error } = useLoad<LearningData>(fetchLearning);
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Spinner label="Counting the captured signals…" />;

  const reasons = Object.entries(data.reasons).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-5">
      <Card className="p-6">
        <Eyebrow>Learning data — captured signals</Eyebrow>
        <p className="mt-1 text-sm leading-relaxed text-ink-600">{data.note}</p>
        <SharedNote>
          These signals are pooled across every organisation on the deployment — they are
          the labelled set the shared scoring model learns from, which is why they are
          visible here and not in any one organisation's pages.
        </SharedNote>

        {data.total === 0 ? (
          <Notice tone="neutral">
            No signals captured yet. Run a scan, set a decision, or rate a record — they
            appear here.
          </Notice>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              <Stat label="Total signals" value={num(data.total)} />
              {Object.entries(SIGNAL_LABELS).map(([k, label]) => (
                <Stat key={k} label={label} value={num(data.counts[k] ?? 0)} muted />
              ))}
            </div>
            <p className="mt-3 text-xs text-ink-500">
              The counts are exact over the whole table. They are not derived from the
              list below — a recent scan can fill a fetch window with fresh rejects and
              push older feedback out of it, which would report those signals as gone
              when only the window is capped.
            </p>
          </>
        )}
      </Card>

      {reasons.length > 0 && (
        <Card className="p-6">
          <Eyebrow>Rejects by reason</Eyebrow>
          <div className="mt-3 space-y-1.5">
            {reasons.map(([reason, count]) => {
              const pct = Math.round((count / (reasons[0][1] || 1)) * 100);
              return (
                <div key={reason} className="flex items-center gap-3">
                  <div className="min-w-56 flex-1 truncate text-sm text-ink-800" title={reason}>
                    {reason}
                  </div>
                  <div className="h-2 w-40 overflow-hidden rounded-full bg-ink-100">
                    <div className="h-full rounded-full bg-accent-500"
                      style={{ width: `${pct}%` }} />
                  </div>
                  <div className="w-16 text-right text-sm tabular-nums text-ink-600">
                    {num(count)}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <div className="text-[0.7rem] font-semibold tracking-[0.06em] text-ink-500 uppercase">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${
        muted ? "text-ink-700" : "text-brand-700"}`}>
        {value}
      </div>
    </div>
  );
}

// ── Suggestions ──────────────────────────────────────────────────────────────

export function SuggestionsTab() {
  const { data, error, reload } = useLoad<SuggestionsData>(fetchSuggestions);
  const [acting, setActing] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Spinner label="Reading the review queue…" />;

  if (!data.canReview) {
    return (
      <Card className="max-w-3xl p-6">
        <Eyebrow>Suggestions</Eyebrow>
        <Notice tone="brand" className="mt-3">
          The review queue holds proposed changes to resources every organisation shares —
          the donor catalogue and the funding sources — so it is reviewed from a developer
          tenant. You can still propose a change from the pages those resources appear on.
        </Notice>
      </Card>
    );
  }

  const act = async (id: string, decision: "approve" | "reject") => {
    setActing(id); setOutcome(null); setFailed(null);
    try {
      const r = decision === "approve"
        ? await approveSuggestion(id) : await rejectSuggestion(id);
      // The job is QUEUED, not applied — saying "approved" here would claim a write that
      // has not happened. The runner holds the rules about the shared catalogue.
      setOutcome(r.detail);
      await reload();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "Could not record that.");
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <div className="flex items-center gap-2.5">
          <GitPullRequestArrow className="h-5 w-5 text-accent-600" />
          <Eyebrow>Suggestions — {data.count} pending</Eyebrow>
        </div>
        <p className="mt-1 text-sm leading-relaxed text-ink-600">
          Proposed changes to the donor catalogue and the funding sources, from every
          organisation on the deployment. Approving one applies it for everybody.
        </p>
        {outcome && <Notice tone="good" className="mt-3">{outcome}</Notice>}
        {failed && <Notice tone="bad" className="mt-3">{failed}</Notice>}
        {data.pending.length === 0 && (
          <Notice tone="neutral" className="mt-3">
            Nothing waiting. Proposals appear here as they are made.
          </Notice>
        )}
      </Card>

      {data.pending.map((sug) => (
        <Card key={s(sug.id)} className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="accent">{s(sug.resource_type) || "resource"}</Badge>
                <span className="font-medium text-ink-900">
                  {s(sug.target_label) || s(sug.target_id) || "new record"}
                </span>
              </div>
              <p className="mt-1 text-xs text-ink-500">
                Proposed by {s(sug.created_by) || "somebody"}
                {sug.created_at ? ` on ${s(sug.created_at).slice(0, 10)}` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="primary" busy={acting === s(sug.id)}
                icon={<CheckCircle2 className="h-4 w-4" />}
                onClick={() => void act(s(sug.id), "approve")}
              >
                Approve
              </Button>
              <Button
                busy={acting === s(sug.id)} icon={<XCircle className="h-4 w-4" />}
                onClick={() => void act(s(sug.id), "reject")}
              >
                Reject
              </Button>
            </div>
          </div>
          <Diff proposed={sug.proposed_diff} base={sug.base_snapshot} />
          {s(sug.note) && (
            <p className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3 text-sm text-ink-700">
              {s(sug.note)}
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}

/** Field by field: what it is now, and what is being proposed. */
function Diff({ proposed, base }: { proposed: unknown; base: unknown }) {
  const p = (proposed && typeof proposed === "object" && !Array.isArray(proposed))
    ? proposed as Record<string, unknown> : {};
  const b = (base && typeof base === "object" && !Array.isArray(base))
    ? base as Record<string, unknown> : {};
  const keys = Object.keys(p);
  if (!keys.length) return <p className="mt-3 text-sm text-ink-500">No field changes.</p>;
  const show = (v: unknown) => {
    if (v === null || v === undefined || v === "") return "—";
    if (typeof v === "boolean") return v ? "yes" : "no";
    const t = Array.isArray(v) ? v.join(", ") : String(v);
    return t.length > 140 ? `${t.slice(0, 140)}…` : t;
  };
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-ink-200">
      <table className="w-full text-sm">
        <thead className="bg-ink-50 text-left text-xs font-semibold text-ink-600 uppercase">
          <tr>
            <th className="px-3 py-2">Field</th>
            <th className="px-3 py-2">Now</th>
            <th className="px-3 py-2">Proposed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {keys.map((k) => (
            <tr key={k}>
              <td className="px-3 py-2"><code className="text-xs">{k}</code></td>
              <td className="px-3 py-2 text-ink-500">{show(b[k])}</td>
              <td className="px-3 py-2 font-medium text-ink-900">{show(p[k])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
