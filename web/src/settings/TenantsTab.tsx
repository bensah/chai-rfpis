/**
 * Settings → Accounts → Tenants and Blacklisted.
 * `views/account_sections.render_manage_tenants` and `render_blacklisted`.
 *
 * THE PLATFORM CONSOLE. Everything here is about which organisations exist on this
 * deployment and what each may do — which is why an ordinary admin can READ it and only
 * a super_user can change it. That split is the Streamlit page's own, and the reason for
 * the read half is relevance rather than secrecy: an admin on a shared deployment needs
 * to know their organisation is active and who it belongs to; they do not need a list of
 * other people's clients, and do not get one.
 *
 * THE FOUR FLAGS ARE NOT INTERCHANGEABLE, and the page says what each does rather than
 * showing four switches in a row:
 *
 *   status       suspended stops everybody in it signing in.
 *   blacklisted  a hard block with an audit stamp — who did it and when.
 *   developer    its members get the cross-tenant tasks: the sources catalogue, the
 *                blocked tokens, extraction, the learning data.
 *   consortium   its profile may be read to score a call where it is named as a
 *                co-applicant on ANOTHER organisation's opportunity.
 *
 * Every write is queued, because two of them clear a cache in `core.applicant_graph`
 * that a TypeScript write would leave stale — see the `tenant_action` job.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Ban, Building2, CheckCircle2, Link2, Search, ShieldAlert, Wrench,
} from "lucide-react";
import { currentSession, fetchTenants, tenantAction, type TenantsData } from "../api";
import { hrefOf, Link } from "../router";
import { Badge, Button, Card, Eyebrow, Notice, Select, Spinner, fieldClass } from "../ui";

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const day = (v: unknown) => s(v).slice(0, 10);

export function TenantsPanel() {
  return <Console blacklistedOnly={false} />;
}

export function BlacklistedPanel() {
  return <Console blacklistedOnly />;
}

function Console({ blacklistedOnly }: { blacklistedOnly: boolean }) {
  const [data, setData] = useState<TenantsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [parentOf, setParentOf] = useState<string | null>(null);

  const load = () => fetchTenants().then((d) => { setData(d); setError(null); })
    .catch((e: unknown) =>
      setError(e instanceof Error ? e.message : "Couldn't load the organizations."));
  useEffect(() => { void load(); }, []);

  // Only a super_user may enter a view-as; `data.canManage` is an admin flag and an
  // admin of one tenant has no business opening another's. The server enforces this
  // anyway (`routes_auth.viewAs` refuses a non-super with 403) — this only decides
  // whether to offer a link that would be refused.
  const canViewAs = currentSession()?.user.role === "super_user";

  const all = data?.tenants ?? [];
  const rows = useMemo(() => all.filter((t) => {
    if (blacklistedOnly !== (t.status === "blacklisted")) return false;
    const needle = q.trim().toLowerCase();
    return !needle || `${t.name} ${t.slug ?? ""}`.toLowerCase().includes(needle);
  }), [all, q, blacklistedOnly]);

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Spinner label="Loading the organizations…" />;

  const act = async (body: Record<string, unknown>) => {
    setBusy(true); setNote(null);
    try {
      const r = await tenantAction({ ...body, tenant_ids: [...picked] });
      setNote(r.detail);
      setPicked(new Set());
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "That did not go through.");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2.5">
        {blacklistedOnly
          ? <Ban className="h-5 w-5 text-accent-600" />
          : <Building2 className="h-5 w-5 text-accent-600" />}
        <Eyebrow>{blacklistedOnly ? "Blacklisted" : "Organizations"}</Eyebrow>
      </div>
      <p className="mt-1 mb-3 text-sm leading-relaxed text-ink-600">
        {blacklistedOnly
          ? "Organizations blocked from this deployment. Nobody in one can sign in, and "
            + "the block is stamped with who applied it and when."
          : "Every organization on this deployment, what each may do, and who it belongs "
            + "to."}
      </p>
      {data.note && <Notice tone="brand" className="mb-4">{data.note}</Notice>}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input className={`${fieldClass} pl-9`} value={q} aria-label="Search organizations"
            placeholder="Search by name" onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {data.canManage && picked.size > 0 && (
        <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3">
          <div className="mb-2 text-sm font-medium text-ink-800">{picked.size} selected</div>
          <div className="flex flex-wrap gap-2">
            {blacklistedOnly ? (
              <Button variant="primary" busy={busy}
                icon={<CheckCircle2 className="h-4 w-4" />}
                onClick={() => void act({ action: "blacklist", on: false })}>
                Restore
              </Button>
            ) : (
              <>
                <Button busy={busy} onClick={() => void act({ action: "activate" })}>
                  Activate
                </Button>
                <Button busy={busy} onClick={() => void act({ action: "suspend" })}>
                  Suspend
                </Button>
                <Button busy={busy} icon={<Wrench className="h-4 w-4" />}
                  onClick={() => void act({ action: "developer", on: true })}>
                  Make a developer tenant
                </Button>
                <Button busy={busy}
                  onClick={() => void act({ action: "developer", on: false })}>
                  Clear developer
                </Button>
                <Button busy={busy}
                  onClick={() => void act({ action: "consortium", on: true })}>
                  Allow consortium sharing
                </Button>
                <Button busy={busy}
                  onClick={() => void act({ action: "consortium", on: false })}>
                  Stop sharing
                </Button>
                <Button variant="danger" busy={busy} icon={<Ban className="h-4 w-4" />}
                  onClick={() => void act({ action: "blacklist", on: true })}>
                  Blacklist
                </Button>
              </>
            )}
          </div>
          {!blacklistedOnly && (
            <p className="mt-2 text-xs text-ink-500">
              <strong>Developer</strong> gives its members the cross-tenant tasks — the
              sources catalogue, blocked tokens, extraction and the learning data.
              <strong> Consortium sharing</strong> lets its profile be read to score a
              call where it is named as a co-applicant on another organization's
              opportunity.
            </p>
          )}
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
              {data.canManage && <th className="w-8 px-3 py-2"><span className="sr-only">Pick</span></th>}
              <th className="px-3 py-2">Organization</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">People</th>
              <th className="px-3 py-2">Belongs to</th>
              {blacklistedOnly
                ? <th className="px-3 py-2">Blocked</th>
                : <th className="px-3 py-2">Flags</th>}
              <th className="px-3 py-2">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-5 text-ink-400">
                {blacklistedOnly
                  ? "No organization is blacklisted."
                  : "No organization matches."}
              </td></tr>
            )}
            {rows.map((t) => (
              <tr key={t.id} className={picked.has(t.id) ? "bg-brand-50" : "hover:bg-ink-50"}>
                {data.canManage && (
                  <td className="px-3 py-2">
                    <input type="checkbox" className="h-4 w-4 accent-brand-700"
                      aria-label={`Select ${t.name}`} checked={picked.has(t.id)}
                      onChange={() => toggle(t.id)} />
                  </td>
                )}
                {/* THE NAME IS THE WAY IN (owner, 2026-11-18: "if i go to tenant settings
                    and try to access any tenant via superuser, it will also work"). It was
                    plain text here, so the only route into a view-as was typing ?tenant=
                    into the address bar — while `views/account_sections.py:1252` has had
                    the Organization name as the entry link all along.

                    A link, not a button, and it carries ?tenant=<slug>: that is the
                    selector App reads, so the entry is the same one a bookmark or a
                    pasted URL uses rather than a second mechanism that can drift from it.
                    It opens Home, because a view-as is scoped across every page and Home
                    is where you would start reading a tenant.

                    Shown only to a super_user — `canManage` is an admin flag and an admin
                    of one tenant has no business entering another's. */}
                <td className="px-3 py-2 font-medium text-ink-900">
                  {canViewAs && (t.slug || t.id)
                    ? (
                      <Link
                        to={hrefOf("home", { tenant: t.slug ?? t.id })}
                        className="text-accent-700 hover:underline"
                        title={`Open ${t.name} as super_user`}
                      >
                        {t.name}
                      </Link>
                    )
                    : t.name}
                  {t.kind === "individual" && (
                    <Badge tone="neutral" className="ml-2">personal</Badge>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={t.status === "active" ? "good"
                    : t.status === "blacklisted" ? "bad" : "warn"}>
                    {t.status}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-700">
                  {t.members}
                  {t.pending > 0 && (
                    <span className="ml-1 text-xs text-ink-400">+{t.pending} pending</span>
                  )}
                </td>
                <td className="px-3 py-2 text-ink-600">
                  {t.parent_name ?? <span className="text-ink-300">—</span>}
                </td>
                {blacklistedOnly ? (
                  <td className="px-3 py-2 text-xs text-ink-600">
                    {day(t.blacklisted_at) || "—"}
                    {t.blacklisted_by && <div>by {t.blacklisted_by}</div>}
                    {t.blacklist_reason && <div className="italic">{t.blacklist_reason}</div>}
                  </td>
                ) : (
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {t.is_platform && <Badge tone="accent">platform</Badge>}
                      {t.is_developer && <Badge tone="warn">developer</Badge>}
                      {t.share_for_consortium_scoring && (
                        <Badge tone="neutral">consortium</Badge>
                      )}
                      {!t.is_platform && !t.is_developer
                        && !t.share_for_consortium_scoring && (
                        <span className="text-ink-300">—</span>
                      )}
                    </div>
                  </td>
                )}
                <td className="px-3 py-2 whitespace-nowrap text-ink-600">
                  {day(t.created_at) || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.canManage && !blacklistedOnly && (
        <div className="mt-4 rounded-lg border border-ink-200 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-800">
            <Link2 className="h-4 w-4 text-accent-600" />
            Link an organization to a parent
          </div>
          <p className="mt-1 mb-3 text-xs text-ink-500">
            A child inherits the parent&apos;s transferable standing when a call is
            scored — registration, signatory, relationships, competitiveness, geography.
            A link that would loop the chain is rejected by the database, which is the
            guard rather than an error to retry.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <div className="mb-1 text-xs font-medium text-ink-600">Organization</div>
              <Select className="w-auto min-w-48" value={parentOf ?? ""}
                aria-label="Child organization"
                onChange={(e) => setParentOf(e.target.value || null)}>
                <option value="">Pick one…</option>
                {all.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-ink-600">Belongs to</div>
              <Select
                className="w-auto min-w-48" aria-label="Parent organization"
                defaultValue=""
                onChange={(e) => {
                  if (!parentOf) return;
                  void (async () => {
                    setBusy(true); setNote(null);
                    try {
                      const r = await tenantAction({
                        action: "parent", child_id: parentOf,
                        parent_id: e.target.value || "",
                      });
                      setNote(r.detail);
                      await load();
                    } catch (err) {
                      setNote(err instanceof Error ? err.message : "That did not go through.");
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              >
                <option value="">Nothing (unlink)</option>
                {all.filter((t) => t.id !== parentOf)
                  .map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </div>
            {!parentOf && (
              <p className="pb-2 text-xs text-ink-400">Pick an organization first.</p>
            )}
          </div>
        </div>
      )}

      {!data.canManage && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-500">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Showing the organizations you belong to.
        </p>
      )}
    </Card>
  );
}
