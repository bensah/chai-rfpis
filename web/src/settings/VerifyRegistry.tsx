/**
 * Settings → Sources → Verify Registry. `views/verification._render_source_registry`.
 *
 * WHAT THIS IS FOR. The scanner meets hosts it was never told about — a funder's own
 * page, an aggregator that republishes other people's calls, a job board that looks like
 * one. The registry is where somebody says which is which, and the answer decides what
 * every tenant's scan crawls afterwards. It is a judgement about a host, not an edit to
 * a row, which is why it has its own screen rather than a column in the catalogue.
 *
 * ONE RULE GOVERNS THE BUTTON THAT MATTERS: `push_primaries` pushes a host into the
 * catalogue only if it is classified PRIMARY and marked CONFIRMED. Anything else is
 * skipped and named. That gate is what keeps an unverified aggregator out of every
 * organisation's scan list, so the page states it rather than letting a skipped push
 * look like a failure.
 *
 * EVERY WRITE IS QUEUED. core/source_registry.py owns a column whitelist, host
 * normalisation and the dedupe-by-host upsert into the catalogue; the page sends an
 * action and shows what the job says.
 */
import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2, Search, ShieldCheck, Trash2, UploadCloud,
} from "lucide-react";
import {
  fetchRegistry, registryAction, type RegistryData,
} from "../api";
import { Badge, Button, Card, Eyebrow, Notice, Select, Spinner, fieldClass } from "../ui";

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** The classifications the registry uses, in the order a reviewer decides between them. */
const CLASSES = ["primary", "aggregator", "resource", "irrelevant"];

export default function VerifyRegistry() {
  const [data, setData] = useState<RegistryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [only, setOnly] = useState("Unclassified");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = () => fetchRegistry().then((d) => { setData(d); setError(null); })
    .catch((e: unknown) =>
      setError(e instanceof Error ? e.message : "Couldn't load the registry."));
  useEffect(() => { void load(); }, []);

  const rows = data?.rows ?? [];
  const shown = useMemo(() => rows.filter((r) => {
    const needle = q.trim().toLowerCase();
    if (needle) {
      const blob = [r.host, r.donor_name, r.listings_url, r.notes]
        .map((v) => s(v)).join(" ").toLowerCase();
      if (!blob.includes(needle)) return false;
    }
    if (only === "Unclassified") return !s(r.classification).trim();
    if (only === "Primary") return s(r.classification) === "primary";
    if (only === "Aggregator") return s(r.classification) === "aggregator";
    if (only === "Confirmed") return s(r.status).toLowerCase() === "confirmed";
    if (only === "In the catalogue") return !!r.in_catalogue;
    return true;
  }), [rows, q, only]);

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Spinner label="Loading the source registry…" />;

  const act = async (body: Record<string, unknown>) => {
    setBusy(true); setNote(null);
    try {
      const r = await registryAction({ ...body, hosts: [...picked] });
      setNote(r.detail);
      setPicked(new Set());
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "That did not go through.");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (host: string) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(host)) next.delete(host); else next.add(host);
    return next;
  });

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2.5">
        <ShieldCheck className="h-5 w-5 text-accent-600" />
        <Eyebrow>Verify registry</Eyebrow>
      </div>
      <p className="mt-1 mb-3 text-sm leading-relaxed text-ink-600">
        Every host the scanner has met. Classify one as a <strong>primary</strong> funder,
        an <strong>aggregator</strong> that republishes other people's calls, a resource
        page or something irrelevant — then push the primaries into the catalogue the scan
        crawls.
      </p>

      <div className="mb-3 flex flex-wrap gap-3 text-sm">
        <Badge tone="neutral">{data.counts.total} hosts</Badge>
        <Badge tone={data.counts.unclassified ? "warn" : "good"}>
          {data.counts.unclassified} unclassified
        </Badge>
        <Badge tone="neutral">{data.counts.confirmed} confirmed</Badge>
        <Badge tone="accent">{data.counts.inCatalogue} in the catalogue</Badge>
      </div>

      <Notice tone="brand" className="mb-4">{data.pushRule}</Notice>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input className={`${fieldClass} pl-9`} value={q} aria-label="Search hosts"
            placeholder="host, funder, listing URL…"
            onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select className="w-auto" value={only} aria-label="Filter"
          onChange={(e) => setOnly(e.target.value)}>
          {["Unclassified", "All", "Primary", "Aggregator", "Confirmed", "In the catalogue"]
            .map((o) => <option key={o}>{o}</option>)}
        </Select>
      </div>

      {data.canEdit && picked.size > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-ink-200 bg-ink-50 p-3">
          <span className="text-sm font-medium text-ink-800">
            {picked.size} selected
          </span>
          {CLASSES.map((c) => (
            <Button key={c} busy={busy}
              onClick={() => void act({ action: "classify", classification: c })}>
              Mark {c}
            </Button>
          ))}
          <Button
            variant="primary" busy={busy} icon={<UploadCloud className="h-4 w-4" />}
            onClick={() => void act({ action: "push" })}
          >
            Push to the catalogue
          </Button>
          <Button variant="danger" busy={busy} icon={<Trash2 className="h-4 w-4" />}
            onClick={() => void act({ action: "delete" })}>
            Delete
          </Button>
        </div>
      )}
      {note && (
        <Notice tone="good" className="mt-3" icon={<CheckCircle2 className="h-4 w-4" />}>
          {note}
        </Notice>
      )}

      <div className="mt-3 overflow-x-auto rounded-lg border border-ink-200">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs font-semibold text-ink-600 uppercase">
            <tr>
              {data.canEdit && <th className="w-8 px-3 py-2"><span className="sr-only">Pick</span></th>}
              <th className="px-3 py-2">Host</th>
              <th className="px-3 py-2">Funder</th>
              <th className="px-3 py-2">Classification</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Hits</th>
              <th className="px-3 py-2">Last seen</th>
              <th className="px-3 py-2">In catalogue</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {shown.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-5 text-ink-400">
                {rows.length ? "No hosts match." : "The registry is empty."}
              </td></tr>
            )}
            {shown.slice(0, 200).map((r) => {
              const host = s(r.host);
              const cls = s(r.classification);
              return (
                <tr key={host} className={picked.has(host) ? "bg-brand-50" : "hover:bg-ink-50"}>
                  {data.canEdit && (
                    <td className="px-3 py-2">
                      <input
                        type="checkbox" className="h-4 w-4 accent-brand-700"
                        aria-label={`Select ${host}`} checked={picked.has(host)}
                        onChange={() => toggle(host)}
                      />
                    </td>
                  )}
                  <td className="px-3 py-2 font-medium text-ink-900">
                    {s(r.listings_url) ? (
                      <a href={s(r.listings_url)} target="_blank" rel="noreferrer"
                        className="text-accent-700 hover:underline">{host}</a>
                    ) : host}
                  </td>
                  <td className="px-3 py-2 text-ink-700">{s(r.donor_name) || "—"}</td>
                  <td className="px-3 py-2">
                    {cls ? (
                      <Badge tone={cls === "primary" ? "good"
                        : cls === "aggregator" ? "warn" : "neutral"}>{cls}</Badge>
                    ) : <span className="text-ink-300">—</span>}
                  </td>
                  <td className="px-3 py-2 text-ink-600">{s(r.status) || "—"}</td>
                  <td className="px-3 py-2 tabular-nums text-ink-600">{s(r.hits) || "0"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-600">
                    {s(r.last_seen).slice(0, 10) || "—"}
                  </td>
                  <td className="px-3 py-2">
                    {r.in_catalogue
                      ? <Badge tone="accent">yes</Badge>
                      : <span className="text-ink-300">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-500">
        Showing {Math.min(shown.length, 200)} of {shown.length} matching, {rows.length} in
        all.{!data.canEdit && " Read-only: classifying a host changes what every "
          + "organisation's scan crawls, so it needs a developer-tenant administrator."}
      </p>
    </Card>
  );
}
