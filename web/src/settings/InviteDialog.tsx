/**
 * Settings → Accounts → Users → Add a user.
 *
 * AN INVITATION, NOT A PASSWORD, and the dialog says so in its first sentence because the
 * obvious question — "what password do I give them?" — has a non-obvious answer. The
 * account is created with a hash nobody knows and is unreachable until the one-time link
 * is used, so there is no interim credential for anyone to intercept, the administrator
 * who created it included.
 *
 * IT WAITS ON A JOB rather than a response, and that is not an accident of plumbing:
 * creating an account also resolves or CREATES a tenant, which is `_create_user_account`'s
 * to decide. The dialog reports what the job says, including the activation link when no
 * email went out — that link is the only credential this flow produces, and there is no
 * second copy of it anywhere.
 */
import { useState } from "react";
import { CheckCircle2, UserPlus } from "lucide-react";
import {
  inviteUser, type AdminUsers, type InviteQueued, type Job,
} from "../api";
import { JOB_STATUS_LABEL, useJob } from "../jobs";
import { Badge, Button, Notice, Select } from "../ui";
import { Dialog, Field } from "./dialog";

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const FINAL = new Set(["done", "failed", "cancelled"]);

export default function InviteDialog({ data, onClose, onDone }: {
  data: AdminUsers; onClose: () => void; onDone: () => void;
}) {
  const roles = data.assignableRoles?.length ? data.assignableRoles : ["collaborator"];
  const [f, setF] = useState({
    email: "", name: "", role: roles[0], department: "", program: "",
    tenantMode: "own", newTenantName: "", tenantKind: "organization",
  });
  const [started, setStarted] = useState<Job | null>(null);
  const [queued, setQueued] = useState<InviteQueued | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const job = useJob(started);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const result = (job?.result ?? {}) as Record<string, unknown>;
  const created = job?.status === "done" && result.ok === true;
  const link = s(result.link);
  const warnings = Array.isArray(result.warnings) ? result.warnings.map(s) : [];
  const running = !!job && !FINAL.has(job.status);

  const submit = async () => {
    setBusy(true); setProblems([]); setFailed(null);
    try {
      const r = await inviteUser(f);
      setQueued(r);
      // The job row carries the outcome, polled the way every other job is.
      setStarted({ id: r.job_id, status: r.dispatched ? "dispatched" : "queued" } as Job);
    } catch (e) {
      const err = e as { message?: string; problems?: string[] };
      setProblems(err.problems ?? []);
      setFailed(err.message ?? "Could not create the account.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Add a user" onClose={onClose}>
      {!queued ? (
        <>
          <Notice tone="brand" className="mb-4">
            This creates the account and emails a one-time activation link.{" "}
            <strong>No password is generated or sent.</strong> The account cannot be used
            until they follow the link and choose one — it works once and expires in seven
            days.
          </Notice>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Email (their login)" value={f.email} onChange={set("email")} />
            <Field label="Full name" value={f.name} onChange={set("name")} />
            <div>
              <div className="mb-1.5 text-sm font-medium text-ink-700">Role</div>
              <Select value={f.role} onChange={(e) => set("role")(e.target.value)}>
                {roles.map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
            </div>
            <Field label="Department" value={f.department} onChange={set("department")} />
            <Field label="Programme areas" value={f.program} onChange={set("program")} />
          </div>

          {data.canChooseTenant ? (
            <div className="mt-5 rounded-lg border border-ink-200 bg-ink-50 p-4">
              <div className="mb-2 text-sm font-medium text-ink-800">
                Which organisation?
              </div>
              <Select
                value={f.tenantMode} aria-label="Organisation"
                onChange={(e) => set("tenantMode")(e.target.value)}
              >
                <option value="own">My own organisation</option>
                <option value="new">A new one, named below</option>
              </Select>
              {f.tenantMode === "new" && (
                <div className="mt-3">
                  <Field
                    label="New organisation name" value={f.newTenantName}
                    onChange={set("newTenantName")}
                    hint="An existing organisation of the same name is reused — which is how a whole team lands in one place."
                  />
                  <label className="mt-2 flex items-center gap-2.5 text-sm text-ink-700">
                    <input
                      type="checkbox" className="h-4 w-4 accent-brand-700"
                      checked={f.tenantKind === "individual"}
                      onChange={(e) =>
                        set("tenantKind")(e.target.checked ? "individual" : "organization")}
                    />
                    A personal account, not a team
                  </label>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-4 text-xs text-ink-500">
              The account joins your organisation.
            </p>
          )}

          {failed && (
            <Notice tone="bad" className="mt-4">
              {failed}
              {problems.length > 0 && (
                <ul className="mt-1.5 list-disc pl-5 text-sm">
                  {problems.map((p) => <li key={p}>{p}</li>)}
                </ul>
              )}
            </Notice>
          )}

          <div className="mt-5 flex gap-2">
            <Button variant="primary" busy={busy} onClick={submit}
              icon={<UserPlus className="h-4 w-4" />}>
              Create and send the link
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={created ? "good" : job?.status === "failed" ? "bad" : "accent"}>
              {created && <CheckCircle2 className="h-3 w-3" />}
              {job ? JOB_STATUS_LABEL[job.status] : "Queued"}
            </Badge>
            {job?.progress?.message && (
              <span className="text-sm text-ink-600">{job.progress.message}</span>
            )}
          </div>
          <p className="mt-3 text-sm text-ink-700">{s(result.summary) || queued.detail}</p>

          {link && (
            <div className="mt-4">
              <div className="text-xs font-semibold tracking-wide text-ink-500 uppercase">
                Activation link
              </div>
              <code className="mt-1 block overflow-x-auto rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 font-mono text-xs break-all">
                {link}
              </code>
              <p className="mt-1.5 text-xs text-ink-500">
                No email went out, so pass this on yourself. It is the only copy — nothing
                stores it and it cannot be shown again.
              </p>
            </div>
          )}
          {warnings.map((w) => <Notice key={w} tone="warn" className="mt-3">{w}</Notice>)}
          {job?.status === "failed" && job.message && (
            <Notice tone="bad" className="mt-3">{job.message}</Notice>
          )}

          <div className="mt-5">
            <Button
              variant="primary" disabled={running}
              onClick={() => { onDone(); onClose(); }}
            >
              Done
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

