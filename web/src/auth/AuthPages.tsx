/**
 * The public account screens — ports of auth/authenticator.py (login_gate, the activation
 * code box, the forgot-password form, handle_setup_token, _gate_must_change_password) and
 * app_pages/login.py, activate.py, password_reset.py. Wording is the Streamlit app's.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  ApiError, forcedChange, login, peekToken, redeemToken, requestReset, type TokenInfo,
} from "../api";
import { navigate, setParams } from "../router";

const PASSWORD_RULES_TEXT = "At least 8 characters, including at least one letter and one number. Spaces are allowed.";

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-start justify-center bg-surface px-4 py-10">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

function Brand() {
  return (
    <div className="mb-6 text-center">
      <div className="text-[2.2rem] font-extrabold tracking-wide text-[#1e3a8a]">RFPIS</div>
      <div className="-mt-1 text-[1.05rem] font-semibold text-brand">RFP Intelligence System</div>
      <div className="mt-1.5 text-sm text-slate-600">
        Weekly opportunities discovery, eligibility screening and decision support.
      </div>
    </div>
  );
}

const card = "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm";
const input = "w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";
const primary = "flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand-dark disabled:opacity-60";
const secondary = "w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50";

function Field({ id, label, ...rest }: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="mb-4">
      <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor={id}>{label}</label>
      <input id={id} className={input} {...rest} />
    </div>
  );
}

function Problems({ error }: { error: ApiError | Error | null }) {
  if (!error) return null;
  const problems = error instanceof ApiError ? error.problems : [];
  return (
    <div role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
      {error.message}
      {problems.length > 0 && <ul className="mt-1 list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
    </div>
  );
}

function Expander({ title, open: initial = false, children }: { title: string; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-white">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-slate-700">
        {title} <span className="text-slate-400">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="border-t border-slate-100 px-4 py-3">{children}</div>}
    </div>
  );
}

// ── Sign in ──────────────────────────────────────────────────────────────────

export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const activateOpen = new URLSearchParams(window.location.search).has("activate");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Sign-in failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame>
      <Brand />
      <form onSubmit={submit} className={card}>
        <Field id="email" label="Email" type="email" autoComplete="username" required value={email}
          onChange={(e) => setEmail(e.target.value)} />
        <Field id="password" label="Password" type="password" autoComplete="current-password" required
          value={password} onChange={(e) => setPassword(e.target.value)} />
        <Problems error={error} />
        <button type="submit" disabled={busy} className={primary}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Login
        </button>
      </form>
      <Expander title="🔑 Have an activation or reset code?" open={activateOpen}>
        <CodeEntry />
      </Expander>
      <Expander title="🔐 Forgot password?">
        <ResetRequestForm />
      </Expander>
    </Frame>
  );
}

/** activation_code_entry: the code goes into the URL, and the token screen owns the verdict. */
function CodeEntry() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<Error | null>(null);
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (!code.trim()) return setError(new Error("Paste the code from your email."));
      setParams({ token: code.trim() });
    }}>
      <p className="mb-3 text-xs text-slate-500">
        If the button in your email did not open a password screen, paste the code printed underneath it here.
      </p>
      <Field id="code" label="Activation / reset code" value={code} onChange={(e) => setCode(e.target.value)} />
      <Problems error={error} />
      <button type="submit" className={secondary}>Continue</button>
    </form>
  );
}

/** password_reset_request_form: same answer whether or not the address exists. */
function ResetRequestForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      setError(null);
      setDone(null);
      if (!email || !email.includes("@")) return setError(new Error("Enter a valid email."));
      setBusy(true);
      try {
        setDone((await requestReset(email)).message);
        setEmail("");
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Could not record request."));
      } finally {
        setBusy(false);
      }
    }}>
      <p className="mb-3 text-xs text-slate-500">
        Enter your email and request a reset. Once an admin approves it, the app emails you a one-time code and
        link to set a new password. Your current password keeps working until you use it.
      </p>
      <Field id="fp_email" label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <Problems error={error} />
      {done && <p className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">✅ {done}</p>}
      <button type="submit" disabled={busy} className={secondary}>📨 Request password reset</button>
    </form>
  );
}

// ── Must change password ─────────────────────────────────────────────────────

/** _gate_must_change_password: nothing else is reachable until this is done. */
export function ChoosePasswordGate({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  return (
    <Frame>
      <form className={card} onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await forcedChange(current, next, confirm);
          onDone();
        } catch (err) {
          setError(err instanceof Error ? err : new Error("Save failed."));
        } finally {
          setBusy(false);
        }
      }}>
        <h1 className="mb-2 text-2xl font-bold text-navy">🔐 Choose your password</h1>
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          An administrator has asked you to choose a new password before continuing.
        </p>
        <Field id="fcp_current" label="Current (temporary) password" type="password" autoComplete="current-password"
          value={current} onChange={(e) => setCurrent(e.target.value)} />
        <Field id="fcp_new" label="New password" type="password" autoComplete="new-password" title={PASSWORD_RULES_TEXT}
          value={next} onChange={(e) => setNext(e.target.value)} />
        <Field id="fcp_confirm" label="Confirm new password" type="password" autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <Problems error={error} />
        <button type="submit" disabled={busy} className={primary}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} 🔐 Save new password
        </button>
        <button type="button" onClick={onCancel} className="mt-3 w-full text-center text-sm text-slate-500 hover:underline">
          Sign out
        </button>
      </form>
    </Frame>
  );
}

// ── Setup / reset links ──────────────────────────────────────────────────────

/** handle_setup_token: one screen per state — invalid, activate (invites), choose, done. */
export function TokenScreen({ token }: { token: string }) {
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [done, setDone] = useState<{ email: string; purpose: string } | null>(null);

  useEffect(() => {
    setInfo(null);
    peekToken(token).then(setInfo).catch((e) => setInfo({ valid: false, error: e.message }));
  }, [token]);

  if (done) {
    return (
      <Frame>
        <div className={card}>
          <p className="mb-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
            {done.purpose === "invite" ? "Account activated. Your password is set." : "Password changed."}
          </p>
          <h2 className="mb-1 text-lg font-semibold">Sign in</h2>
          <p className="mb-4 text-sm text-slate-500">Use your email and the password you just chose.</p>
          <button className={primary} onClick={() => navigate("/login", { replace: true })}>Go to sign in</button>
        </div>
      </Frame>
    );
  }
  if (!info) {
    return <Frame><div className="flex items-center gap-2 py-10 text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /> Checking your link…</div></Frame>;
  }
  if (!info.valid) {
    return (
      <Frame>
        <div className={card}>
          <h1 className="mb-3 text-2xl font-bold text-navy">This link is no longer valid</h1>
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            Setup and reset links can only be used once, and they expire. Ask an administrator to send you a new one.
          </p>
          <button className={`${secondary} mt-4`} onClick={() => navigate("/login", { replace: true })}>Go to sign in</button>
        </div>
      </Frame>
    );
  }
  const invite = info.purpose === "invite";
  if (invite && !confirmed) {
    return (
      <Frame>
        <div className={card}>
          <h1 className="mb-2 text-2xl font-bold text-navy">🔑 Activate your account</h1>
          <p className="mb-2">This invitation is for <strong>{info.email}</strong>.</p>
          <p className="mb-5 text-sm text-slate-500">
            Activating sets up your sign-in. You will choose your own password on the next screen - nobody else,
            including the administrator who invited you, knows it.
          </p>
          <button className={primary} onClick={() => setConfirmed(true)}>Activate account</button>
        </div>
      </Frame>
    );
  }
  return (
    <Frame>
      <form className={card} onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await redeemToken(token, next, confirm);
          setParams({ token: null, activate: null });
          setDone({ email: r.email, purpose: r.purpose });
        } catch (err) {
          setError(err instanceof Error ? err : new Error("Could not save the password."));
        } finally {
          setBusy(false);
        }
      }}>
        {invite && (
          <p className="mb-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
            Account activated. One step left: choose your password.
          </p>
        )}
        <h1 className="mb-1 text-2xl font-bold text-navy">Choose your password</h1>
        <p className="mb-3 text-sm text-slate-500">
          {invite ? <>Setting the password for <strong>{info.email}</strong>.</> : <>Resetting the password for <strong>{info.email}</strong>.</>}
        </p>
        {!invite && (
          <p className="mb-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900">
            Your current password keeps working until you save a new one here.
          </p>
        )}
        <p className="mb-3 text-xs text-slate-500">{info.rules ?? PASSWORD_RULES_TEXT}</p>
        <Field id="tok_new" label="New password" type="password" autoComplete="new-password" title={PASSWORD_RULES_TEXT}
          value={next} onChange={(e) => setNext(e.target.value)} />
        <Field id="tok_confirm" label="Confirm new password" type="password" autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <Problems error={error} />
        <button type="submit" disabled={busy} className={primary}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save password
        </button>
      </form>
    </Frame>
  );
}

/** app_pages/activate.py: the code box alone, open. */
export function ActivatePage() {
  return (
    <Frame>
      <div className={card}>
        <h1 className="mb-1 text-2xl font-bold text-navy">🔑 Activate your account</h1>
        <p className="mb-4 text-sm text-slate-500">
          Paste the activation code from your invitation email. If you are resetting a forgotten password, the
          code from that email works here too.
        </p>
        <CodeEntry />
        <hr className="my-5 border-slate-200" />
        <p className="mb-2 text-sm text-slate-500">Already have a working password?</p>
        <button className={secondary} onClick={() => navigate("/login")}>Go to sign in</button>
      </div>
    </Frame>
  );
}

/** app_pages/password_reset.py: redeem a code, or ask an admin for one. */
export function PasswordResetPage() {
  return (
    <Frame>
      <div className={card}>
        <h1 className="mb-4 text-2xl font-bold text-navy">🔓 Reset your password</h1>
        <h2 className="mb-2 font-semibold">I have a reset code</h2>
        <CodeEntry />
        <hr className="my-5 border-slate-200" />
        <h2 className="mb-2 font-semibold">I do not have one yet</h2>
        <ResetRequestForm />
        <hr className="my-5 border-slate-200" />
        <button className={secondary} onClick={() => navigate("/login")}>Back to sign in</button>
      </div>
    </Frame>
  );
}
