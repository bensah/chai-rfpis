/**
 * Settings → Accounts → Users. `views/account_sections.render_manage_users`.
 *
 * EVERY PERMISSION ANSWER ON THIS PAGE COMES FROM THE SERVER. `rights` says what this
 * actor may do to each account, `roles` what they may assign, `overrides` which options
 * each surface offers and what the role already grants. None of it is re-derived here,
 * and the reason is not economy: a browser copy of a permission rule decides what is
 * DRAWN while the real one decides what is ALLOWED, so the two disagree silently and the
 * page offers a grant the save refuses.
 *
 * What is drawn from those answers is therefore honest by construction: a control the
 * route would refuse is disabled with the reason on it, rather than enabled and then
 * apologised for.
 *
 * ADDING AND DELETING ARE NOT HERE. The payload says so in `addNote` and the page prints
 * it — an invitation needs the welcome email, which this API does not send yet, and an
 * account created without one is an account whose holder is never told.
 */
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, CheckCircle2, KeyRound, Save, Search, ShieldAlert, X,
} from "lucide-react";
import {
  fetchUsers, resetUserPassword, saveUser,
  type AdminUser, type AdminUsers, type ResetResult, type Warning,
} from "../api";
import {
  Badge, Button, Card, Notice, Select, Spinner, fieldClass,
} from "../ui";

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** A date as the roster shows it: the day for most columns, the minute for a login. */
const day = (v: unknown) => s(v).slice(0, 10);
const minute = (v: unknown) => s(v).slice(0, 16).replace("T", " ");

export default function UsersTab() {
  const [data, setData] = useState<AdminUsers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [roleF, setRoleF] = useState("All roles");
  const [statusF, setStatusF] = useState("All statuses");
  const [tenantF, setTenantF] = useState("All tenants");
  const [picked, setPicked] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = () => fetchUsers().then((d) => { setData(d); setError(null); })
    .catch((e: unknown) =>
      setError(e instanceof Error ? e.message : "Couldn't load the users."));
  useEffect(() => { void load(); }, []);

  const users = data?.users ?? [];
  const roles = useMemo(
    () => [...new Set(users.map((u) => u.role).filter(Boolean))].sort(), [users]);
  const tenants = useMemo(
    () => [...new Set(users.map((u) => u.tenant).filter(Boolean) as string[])].sort(), [users]);

  // The Streamlit page's own filter, field for field: a free-text blob over five columns,
  // then role, status and tenant. Done in the browser because the whole roster is already
  // here — it is tens of rows, not thousands, and a round trip per keystroke would make
  // searching slower than reading.
  const shown = useMemo(() => users.filter((u) => {
    const needle = q.trim().toLowerCase();
    if (needle) {
      const blob = [u.email, u.name, u.department, u.program, u.job_title]
        .map((v) => s(v)).join(" ").toLowerCase();
      if (!blob.includes(needle)) return false;
    }
    if (roleF !== "All roles" && u.role !== roleF) return false;
    if (statusF === "Active" && !u.is_active) return false;
    if (statusF === "Inactive" && u.is_active) return false;
    if (tenantF !== "All tenants" && (u.tenant ?? "") !== tenantF) return false;
    return true;
  }), [users, q, roleF, statusF, tenantF]);

  const target = users.find((u) => u.id === picked) ?? null;

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Spinner label="Loading the users…" />;

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <input
              className={`${fieldClass} pl-9`} value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, email, department…" aria-label="Search users"
            />
          </div>
          <Select value={roleF} onChange={(e) => setRoleF(e.target.value)}
            aria-label="Role filter" className="w-auto">
            {["All roles", ...roles].map((r) => <option key={r}>{r}</option>)}
          </Select>
          <Select value={statusF} onChange={(e) => setStatusF(e.target.value)}
            aria-label="Status filter" className="w-auto">
            {["All statuses", "Active", "Inactive"].map((r) => <option key={r}>{r}</option>)}
          </Select>
          {tenants.length > 1 && (
            <Select value={tenantF} onChange={(e) => setTenantF(e.target.value)}
              aria-label="Tenant filter" className="w-auto">
              {["All tenants", ...tenants].map((r) => <option key={r}>{r}</option>)}
            </Select>
          )}
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-ink-200">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs font-semibold text-ink-600 uppercase">
              <tr>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Role</th>
                {tenants.length > 0 && <th className="px-3 py-2">Tenant</th>}
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Department</th>
                <th className="px-3 py-2">Last login</th>
                <th className="px-3 py-2">Password set</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {shown.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-5 text-ink-400">
                  {users.length ? "No users match your search." : "No users yet."}
                </td></tr>
              )}
              {shown.map((u) => (
                <tr
                  key={u.id} onClick={() => setPicked(u.id === picked ? null : u.id)}
                  className={`cursor-pointer transition-colors ${
                    u.id === picked ? "bg-brand-50" : "hover:bg-ink-50"}`}
                >
                  <td className="px-3 py-2 font-medium text-ink-900">{u.email}</td>
                  <td className="px-3 py-2 text-ink-700">{u.name ?? "—"}</td>
                  <td className="px-3 py-2"><code className="text-xs">{u.role}</code></td>
                  {tenants.length > 0 && (
                    <td className="px-3 py-2 text-ink-600">{u.tenant ?? "—"}</td>
                  )}
                  <td className="px-3 py-2 whitespace-nowrap">{u.status}</td>
                  <td className="px-3 py-2 text-ink-600">{u.department ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-600">
                    {minute(u.last_login_at) || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-600">
                    {day(u.password_changed_at) || "—"}
                    {u.must_change_password && (
                      <Badge tone="warn" className="ml-1.5">reset due</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-ink-500">
          Showing {shown.length} of {users.length} user{users.length === 1 ? "" : "s"}.
          {!target && " Click a row to select somebody."}
        </p>

        {target && (
          <SelectedBar
            user={target}
            onEdit={() => setEditing(true)}
            onReset={() => setResetting(true)}
          />
        )}

        {!data.canAdd && (
          <Notice tone="brand" className="mt-4">{data.addNote}</Notice>
        )}
      </Card>

      {editing && target && (
        <EditDialog
          user={target} onClose={() => setEditing(false)}
          onSaved={async () => { setEditing(false); await load(); }}
        />
      )}
      {resetting && target && (
        <ResetDialog user={target} onClose={() => setResetting(false)}
          onDone={() => void load()} />
      )}
    </div>
  );
}

/**
 * What is possible on the selected account, said before any button is pressed.
 *
 * The Streamlit page writes the same three sentences and they are worth keeping: a
 * disabled button with no reason reads as a bug, and "outside your management scope" is
 * the whole explanation.
 */
function SelectedBar({ user, onEdit, onReset }: {
  user: AdminUser; onEdit: () => void; onReset: () => void;
}) {
  const none = !user.rights.profile;
  return (
    <div className="mt-4 rounded-lg border border-ink-200 bg-ink-50 p-4">
      {none ? (
        <Notice tone="bad" icon={<ShieldAlert className="h-4 w-4" />}>
          <strong>{user.email}</strong> is outside your management scope. No actions are
          available on this account.
        </Notice>
      ) : !user.rights.role ? (
        <Notice tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>
          This is <strong>your own</strong> account. You can edit your profile and your
          per-surface access; role, active, password reset and delete are locked — so
          nobody can demote or deactivate themselves out of the product.
        </Notice>
      ) : (
        <Notice tone="good" icon={<CheckCircle2 className="h-4 w-4" />}>
          <strong>{user.email}</strong> — role <code>{user.role}</code>. Full edit and
          password reset available.
        </Notice>
      )}
      {!none && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" onClick={onEdit} icon={<Save className="h-4 w-4" />}>
            Edit
          </Button>
          <Button
            onClick={onReset} disabled={!user.rights.reset}
            title={user.rights.reset ? undefined
              : "Use Profile → Change password for your own account."}
            icon={<KeyRound className="h-4 w-4" />}
          >
            Reset password
          </Button>
        </div>
      )}
    </div>
  );
}

function Dialog({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/40 p-4">
      <Card className="my-8 w-full max-w-3xl p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-bold text-brand-700">{title}</h2>
          <button
            type="button" onClick={onClose} aria-label="Close"
            className="rounded p-1 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </Card>
    </div>
  );
}

function EditDialog({ user, onClose, onSaved }: {
  user: AdminUser; onClose: () => void; onSaved: () => void | Promise<void>;
}) {
  const r = user.rights;
  const [f, setF] = useState({
    name: s(user.name), email: user.email, phone: s(user.phone),
    job_title: s(user.job_title), department: s(user.department), program: s(user.program),
    role: user.role, is_active: user.is_active,
  });
  const [ov, setOv] = useState<Record<string, string>>(() =>
    Object.fromEntries(user.overrides.map((o) => [o.surface, o.current])));
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const set = (k: keyof typeof f) => (v: unknown) => setF((p) => ({ ...p, [k]: v }));

  const save = async () => {
    setBusy(true); setProblems([]); setFailed(null); setWarnings([]);
    try {
      const payload: Record<string, unknown> = { ...f };
      // Role and active are sent only when the actor may change them. The route drops
      // them anyway, but sending a value somebody cannot set and having it silently
      // vanish is how a UI starts lying about what it did.
      if (!r.role) { delete payload.role; delete payload.is_active; }
      if (r.overrides) payload.access_overrides = ov;
      const res = await saveUser(user.id, payload);
      if (res.warnings?.length) {
        setWarnings(res.warnings);
        setBusy(false);
        return;                     // keep the dialog open so the warning is read
      }
      await onSaved();
    } catch (e) {
      const err = e as { message?: string; problems?: string[] };
      setProblems(err.problems ?? []);
      setFailed(err.message ?? "Save failed.");
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Edit user — ${user.email}`} onClose={onClose}>
      {!r.role && (
        <Notice tone="warn" className="mb-4">
          Your own account: role and active status are locked.
        </Notice>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Full name" value={f.name} onChange={set("name")} disabled={!r.profile} />
        <Field label="Email (login username)" value={f.email} onChange={set("email")}
          disabled={!r.profile}
          hint="Changing this changes how they sign in, from their next session." />
        <Field label="Phone" value={f.phone} onChange={set("phone")} disabled={!r.profile} />
        <Field label="Job title" value={f.job_title} onChange={set("job_title")}
          disabled={!r.profile} />
        <Field label="Department" value={f.department} onChange={set("department")}
          disabled={!r.profile} />
        <Field label="Programme areas" value={f.program} onChange={set("program")}
          disabled={!r.profile} />
      </div>

      <h3 className="mt-5 mb-2 text-sm font-bold text-brand-700">Access</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1.5 text-sm font-medium text-ink-700">Role</div>
          <Select value={f.role} onChange={(e) => set("role")(e.target.value)}
            disabled={!r.role}>
            {/* Only the roles the server said this actor may assign on this account. */}
            {user.roles.map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
        </div>
        <label className="flex items-center gap-2.5 self-end pb-2 text-sm text-ink-700">
          <input
            type="checkbox" className="h-4 w-4 accent-brand-700" disabled={!r.role}
            checked={f.is_active} onChange={(e) => set("is_active")(e.target.checked)}
          />
          Account active
        </label>
      </div>

      <h3 className="mt-5 mb-1 text-sm font-bold text-brand-700">
        Per-surface access overrides
      </h3>
      <p className="mb-3 text-xs text-ink-500">
        Default is the role policy. Pick anything else to override that surface for this
        user only. You can never grant more than you hold yourself.
      </p>
      <div className="space-y-1.5 rounded-lg border border-ink-200 bg-ink-50 p-3">
        {user.overrides.map((row) => (
          <div key={row.surface} className="flex flex-wrap items-center gap-3">
            <div className="min-w-56 flex-1 text-sm text-ink-800">
              <code className="text-xs">{row.surface}</code>
              <span className="ml-2 text-xs text-ink-500">
                default: {row.roleDefaultLabel}
              </span>
            </div>
            <Select
              className="w-auto min-w-44" disabled={!r.overrides}
              value={ov[row.surface] ?? row.current}
              onChange={(e) => setOv((p) => ({ ...p, [row.surface]: e.target.value }))}
              aria-label={`${row.surface} access`}
            >
              {row.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
          </div>
        ))}
      </div>

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
      {warnings.map((w) => (
        <Notice key={w.code} tone="warn" className="mt-4">{w.detail}</Notice>
      ))}

      <div className="mt-5 flex gap-2">
        <Button variant="primary" busy={busy} onClick={save} disabled={!r.profile}
          icon={<Save className="h-4 w-4" />}>
          Save changes
        </Button>
        <Button onClick={onClose}>{warnings.length ? "Close" : "Cancel"}</Button>
      </div>
    </Dialog>
  );
}

function ResetDialog({ user, onClose, onDone }: {
  user: AdminUser; onClose: () => void; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ResetResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  return (
    <Dialog title={`Reset password — ${user.email}`} onClose={onClose}>
      {!done ? (
        <>
          <Notice tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>
            This emails <strong>{user.email}</strong> a one-time link to choose a new
            password. It works once and expires in two hours.
            <span className="mt-1.5 block">
              Their current password keeps working until they use it, so this does not
              lock them out — and if the email never arrives, nothing has been broken.
            </span>
          </Notice>
          {failed && <Notice tone="bad" className="mt-3">{failed}</Notice>}
          <div className="mt-5 flex gap-2">
            <Button
              variant="primary" busy={busy} icon={<KeyRound className="h-4 w-4" />}
              onClick={async () => {
                setBusy(true); setFailed(null);
                try {
                  setDone(await resetUserPassword(user.id));
                  onDone();
                } catch (e) {
                  setFailed(e instanceof Error ? e.message : "Reset failed.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Reset and email
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </div>
        </>
      ) : (
        <>
          <Notice tone={done.sent ? "good" : "warn"}>{done.detail}</Notice>
          {done.code && (
            <div className="mt-3">
              <div className="text-xs font-semibold tracking-wide text-ink-500 uppercase">
                One-time code
              </div>
              <code className="mt-1 block rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 font-mono text-lg tracking-widest">
                {done.code}
              </code>
              <p className="mt-1.5 text-xs text-ink-500">
                Read this to them directly. It is the only copy — it is not stored
                anywhere you can look it up again.
              </p>
            </div>
          )}
          <div className="mt-5"><Button onClick={onClose}>Close</Button></div>
        </>
      )}
    </Dialog>
  );
}

function Field({ label, value, onChange, disabled, hint }: {
  label: string; value: string; onChange: (v: string) => void;
  disabled?: boolean; hint?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium text-ink-700">{label}</div>
      <input
        className={fieldClass} value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}
