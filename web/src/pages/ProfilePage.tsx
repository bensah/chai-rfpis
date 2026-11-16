/**
 * My Profile — `app_pages/profile.py` and `views/account_sections.py`.
 *
 * Self-service only: this is the one page where a person edits their own record. Manage
 * Users and User Access are admin surfaces and live in Settings, which is why nothing
 * here takes a user id — the session decides whose row is shown, and the server keys
 * every read and write on it.
 *
 * TWO THINGS ON THIS PAGE CARRY MORE WEIGHT THAN THEY LOOK:
 *
 *   EMAIL IS THE LOGIN USERNAME. Changing it changes how you sign in next session, while
 *   the current token runs its ~8 hours. The field says so, and the save says so again
 *   afterwards, because the failure mode is somebody discovering it at the next sign-in.
 *
 *   PROGRAM AREAS ARE NOT DECORATION. What a person records here is read into the
 *   organisation's profile by `core.user_program_areas` as evidence of expertise in
 *   MUST-2, and the Report attributes scans by it. One colleague saying "this is what I
 *   work on" is harder evidence than a profile row nobody has revisited, which is exactly
 *   why it is weighted that way — so the field deserves its explanation.
 *
 * The login-history rail is the security half: twelve recent sign-ins with device and
 * address, so somebody can spot activity they do not recognise. Location is deliberately
 * not derived from the IP — that needs an external call, and device plus address answers
 * the question without sending anybody's IP to a third party.
 */
import { useEffect, useState } from "react";
import {
  AlertTriangle, Check, KeyRound, Monitor, Trash2, UserRound,
} from "lucide-react";
import {
  ApiError, changeMyPassword, deleteMyAccount, fetchFormOptions, fetchProfile, saveProfile,
  type FormOptions, type ProfilePatch, type ProfileView,
} from "../api";
import { Choice, Multi, Text } from "../opportunity/controls";
import { Button, Card, EmptyState, Notice, PageHeader, Spinner, fieldClass } from "../ui";
import { DataTable } from "../report/charts";

const dash = "—";

/** The ten editable columns, as the form holds them. */
type Form = {
  name: string; email: string; phone: string; job_title: string; department: string;
  program: string[]; address: string; city: string; state_region: string; country: string;
};

/** `program` is ONE text column holding a comma-separated list, not an array. */
const splitProgram = (v: string | null): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export default function ProfilePage() {
  const [data, setData] = useState<ProfileView | null>(null);
  // The country list and the programme areas come from the same route every other form
  // on this app reads — `core/dropdowns.load` for the browser — rather than a second
  // copy bundled here. See api/form_options.ts for why that route exists at all.
  const [opts, setOpts] = useState<FormOptions | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"profile" | "password">("profile");

  const [f, setF] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [saveError, setSaveError] = useState("");
  const [flash, setFlash] = useState("");

  const load = () =>
    fetchProfile()
      .then((d) => {
        setData(d);
        setF({
          name: d.profile.name ?? "", email: d.profile.email ?? "",
          phone: d.profile.phone ?? "", job_title: d.profile.job_title ?? "",
          department: d.profile.department ?? "", program: splitProgram(d.profile.program),
          address: d.profile.address ?? "", city: d.profile.city ?? "",
          state_region: d.profile.state_region ?? "", country: d.profile.country ?? "",
        });
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't load your profile."));

  useEffect(() => {
    void load();
    // A failed vocabulary read must not blank the page: the form still works, the two
    // pickers simply offer nothing until it succeeds.
    fetchFormOptions().then(setOpts).catch(() => undefined);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  if (error) return <EmptyState title="Your profile is unavailable">{error}</EmptyState>;
  if (!data || !f) return <Spinner label="Loading your profile…" />;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });

  async function save() {
    if (!f) return;
    setSaving(true);
    setProblems([]);
    setSaveError("");
    try {
      const fields: ProfilePatch = {
        name: f.name, email: f.email, phone: f.phone, job_title: f.job_title,
        department: f.department, program: f.program.join(", "),
        address: f.address, city: f.city, state_region: f.state_region, country: f.country,
      };
      const r = await saveProfile(fields);
      // The banner survives the reload, which is why it is state rather than a toast: the
      // Python sets a session flash for the same reason — a notice about your login
      // username changing is not one to let fade after four seconds.
      setFlash(`Profile saved.${r.notice ? ` ${r.notice}` : ""}`);
      await load();
    } catch (e) {
      if (e && typeof e === "object" && "problems" in e) {
        setProblems((e as { problems: string[] }).problems ?? []);
      }
      setSaveError(e instanceof Error ? e.message : "That didn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-4">
        <PageHeader title="My Profile"
          lead="Your own contact details and password. Only an administrator can change your role." />

        <div role="tablist" aria-label="Profile" className="flex gap-1 border-b border-ink-200">
          {([["profile", "Profile", UserRound], ["password", "Change Password", KeyRound]] as const)
            .map(([k, label, Icon]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
                  tab === k ? "border-accent-600 text-brand-700"
                    : "border-transparent text-ink-500 hover:text-ink-700"}`}>
                <Icon size={15} aria-hidden /> {label}
              </button>
            ))}
        </div>

        {tab === "profile" ? (
          <>
            {flash && <Notice tone="good" icon={<Check size={15} aria-hidden />}>{flash}</Notice>}
            <Card className="p-4">
              <h2 className="text-sm font-bold text-brand-700">Update your profile</h2>
              <p className="mb-4 mt-1 text-sm text-ink-500">
                Edit your own contact info, including email. <strong>Role is read-only</strong> —
                only an admin can change it. Changing your email also changes your login
                username on next session.
              </p>

              <div className="mb-4 max-w-xs">
                <div className="mb-1.5 text-sm font-medium text-ink-700">Role (read-only)</div>
                <input className={`${fieldClass} bg-ink-50`} value={data.profile.role ?? ""}
                  disabled readOnly aria-label="Role (read-only)" />
              </div>

              <Multi label="Program areas" options={opts?.programAreas ?? []}
                value={f.program} onChange={(v) => set("program", v)}
                hint="Treated as evidence of your organisation's expertise in MUST-2, and the
                      Report uses it to attribute scans by programme focus." />

              <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                <Text label="Full name" value={f.name} onChange={(v) => set("name", v)}
                  hint="Shown on the header, in reports, and on the team rota." />
                <Text label="Email (login username)" required value={f.email}
                  onChange={(v) => set("email", v)}
                  hint="⚠ This is your login username. Changing it means you'll sign in with
                        the new email next session; your current session runs until it expires." />
                <Text label="Phone" value={f.phone} onChange={(v) => set("phone", v)}
                  hint="Include country code (e.g. +237 6XX XX XX XX)." />
                <Text label="Job title" value={f.job_title} onChange={(v) => set("job_title", v)}
                  hint="e.g. 'BD Coordinator', 'Senior Programme Manager'." />
                <Text label="Department" value={f.department}
                  onChange={(v) => set("department", v)}
                  hint="e.g. 'Business Development', 'Programmes'." />
                <Text label="Address" value={f.address} onChange={(v) => set("address", v)}
                  hint="Street address / building." />
                <Text label="City / Town" value={f.city} onChange={(v) => set("city", v)} />
                <Text label="State / Province / Region" value={f.state_region}
                  onChange={(v) => set("state_region", v)} />
                <Choice label="Country" options={opts?.countries ?? []} value={f.country}
                  onChange={(v) => set("country", v)} blank="—" />
              </div>

              {saveError && (
                <Notice tone="bad" className="mb-3">
                  {saveError}
                  {problems.length > 0 && (
                    <ul className="mt-2 list-disc pl-5">
                      {problems.map((p) => <li key={p}>{p}</li>)}
                    </ul>
                  )}
                </Notice>
              )}

              <Button variant="primary" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save profile"}
              </Button>
            </Card>

            <Card className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
              <Metric label="Account created" value={data.metrics.created} />
              <Metric label="Last login" value={data.metrics.lastLogin} />
              <Metric label="Password set" value={data.metrics.passwordSet} />
            </Card>

            <DangerZone view={data} onDeleted={() => window.location.assign("/")} />
          </>
        ) : (
          <PasswordTab rules={data.passwordRules} />
        )}
      </div>

      <div className="min-w-0">
        <Card className="p-4">
          <h3 className="mb-1 flex items-center gap-2 text-sm font-bold text-brand-700">
            <Monitor size={15} aria-hidden /> Recent sign-ins
          </h3>
          <p className="mb-3 text-xs text-ink-500">
            Your last {data.logins.length || "few"} sign-ins. Spot anything you don't
            recognise? Change your password and tell an administrator.
          </p>
          <DataTable
            rows={data.logins} keyOf={(r, i) => `${r.at}-${i}`}
            empty="No sign-ins recorded yet."
            cols={[
              { head: "When", cell: (r) => (
                <span className="text-ink-700">{r.at.replace("T", " ").slice(0, 16)}</span>
              ) },
              { head: "Device", cell: (r) => <span className="text-ink-600">{r.device}</span> },
              { head: "IP", cell: (r) => (
                <span className="font-mono text-xs text-ink-500">{r.ip}</span>
              ) },
            ]}
          />
          <p className="mt-2 text-xs text-ink-400">
            Location isn't looked up — that would mean sending your address to a third
            party. Device and IP answer the same question.
          </p>
        </Card>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="text-xs text-ink-500">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-ink-800">{value ?? dash}</div>
    </div>
  );
}

/** The password tab. Four checks, all the server's — this form only collects. */
function PasswordTab({ rules }: { rules: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function go() {
    setBusy(true);
    setProblems([]);
    setError("");
    setDone(false);
    try {
      await changeMyPassword(current, next, confirm);
      setDone(true);
      setCurrent(""); setNext(""); setConfirm("");
    } catch (e) {
      if (e && typeof e === "object" && "problems" in e) {
        setProblems((e as { problems: string[] }).problems ?? []);
      }
      setError(e instanceof Error ? e.message : "The change didn't go through.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="max-w-md p-4">
      <h2 className="text-sm font-bold text-brand-700">Change password</h2>
      <p className="mb-4 mt-1 text-sm text-ink-500">
        You'll need your current password to confirm. {rules}
      </p>
      {done && (
        <Notice tone="good" className="mb-3" icon={<Check size={15} aria-hidden />}>
          Password changed. Future sign-ins will use the new one.
        </Notice>
      )}
      {["Current password", "New password", "Confirm new password"].map((label, i) => (
        <div key={label} className="mb-4">
          <label className="mb-1.5 block text-sm font-medium text-ink-700" htmlFor={`pw${i}`}>
            {label}
          </label>
          <input id={`pw${i}`} type="password" className={fieldClass}
            autoComplete={i === 0 ? "current-password" : "new-password"}
            value={[current, next, confirm][i]}
            onChange={(e) => [setCurrent, setNext, setConfirm][i](e.target.value)} />
        </div>
      ))}
      {error && (
        <Notice tone="bad" className="mb-3">
          {error}
          {problems.length > 0 && (
            <ul className="mt-2 list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          )}
        </Notice>
      )}
      <Button variant="primary" onClick={go} disabled={busy}>
        {busy ? "Changing…" : "Change password"}
      </Button>
    </Card>
  );
}

/**
 * Self-service account deletion.
 *
 * Collapsed by default, confirmed by typing the account's own email, and refused outright
 * for the last super_user — that last check is the SERVER's, which is why this only hides
 * the control rather than relying on hiding it. What goes is the ability to sign in;
 * meeting notes, engagements and submitted opportunities stay, which the copy says because
 * "delete my account" reasonably sounds like it takes them too.
 */
function DangerZone({ view, onDeleted }: { view: ProfileView; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const email = view.profile.email ?? "";
  const armed = typed.trim().toLowerCase() === email.trim().toLowerCase();

  return (
    <Card className="p-4">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-sm font-semibold text-ink-600 hover:text-bad-600">
        <AlertTriangle size={15} aria-hidden /> Danger zone — delete my account
      </button>
      {open && (
        <div className="mt-3 border-t border-ink-100 pt-3">
          <p className="text-sm text-ink-600">
            Permanently removes your login. Your contributed records — meeting notes,
            engagements, submitted opportunities — <strong>stay in the system</strong> for
            institutional memory; only your ability to sign in is removed. This cannot be
            undone.
          </p>
          {view.soleSuperUser ? (
            <Notice tone="warn" className="mt-3">
              You're the <strong>only Super User</strong> — deleting your account would lock
              everyone out of platform administration. Promote another Super User first
              (Settings → Accounts → Users).
            </Notice>
          ) : (
            <>
              <label className="mb-1.5 mt-3 block text-sm font-medium text-ink-700" htmlFor="delc">
                Type your email to confirm: <code className="font-mono">{email}</code>
              </label>
              <input id="delc" className={`${fieldClass} max-w-sm`} value={typed}
                onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
              {error && <Notice tone="bad" className="mt-3">{error}</Notice>}
              <div className="mt-3">
                <Button variant="danger" disabled={!armed || busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await deleteMyAccount(typed);
                      onDeleted();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "Delete failed.");
                    } finally {
                      setBusy(false);
                    }
                  }}>
                  <Trash2 size={15} aria-hidden />
                  {busy ? "Deleting…" : "Permanently delete my account"}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
