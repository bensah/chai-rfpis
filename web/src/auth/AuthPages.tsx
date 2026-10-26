/**
 * The public account screens — ports of auth/authenticator.py (login_gate, the activation
 * code box, the forgot-password form, handle_setup_token, _gate_must_change_password) and
 * app_pages/login.py, activate.py, password_reset.py. Wording is the Streamlit app's;
 * the layout is a two-panel one, CHAI Dark Blue on the left, the form on the right.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { CheckCircle2, ChevronDown, Loader2, Mail, ShieldCheck, Sparkles } from "lucide-react";
import {
  ApiError, forcedChange, login, peekToken, redeemToken, requestReset, type TokenInfo,
} from "../api";
import { navigate, setParams } from "../router";
import { Button, Field, Notice } from "../ui";

const PASSWORD_RULES_TEXT = "At least 8 characters, including at least one letter and one number. Spaces are allowed.";

const PITCH: { icon: ReactNode; title: string; body: string }[] = [
  { icon: <Sparkles className="h-4 w-4" />, title: "Discovery, every week",
    body: "The scan reads the funders you care about and brings back what is new." },
  { icon: <ShieldCheck className="h-4 w-4" />, title: "Eligibility, screened",
    body: "Every opportunity is scored against your organisation's own profile and policies." },
  { icon: <CheckCircle2 className="h-4 w-4" />, title: "Decisions, recorded",
    body: "Bid or drop, with the reasoning kept next to the opportunity." },
];

/** The shell: a brand panel that explains the app, and the form beside it. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="relative flex flex-col justify-between overflow-hidden bg-brand-700 px-6 py-8 text-white sm:px-10 lg:px-14 lg:py-14">
        {/* A single soft turquoise wash — enough depth without adding a colour. */}
        <div aria-hidden className="pointer-events-none absolute -top-24 -right-24 h-96 w-96 rounded-full bg-accent-600/25 blur-3xl" />
        <div className="relative">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15">
              <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
                <path d="M6 19V5h6.2a4 4 0 0 1 0 8H9.4l5.2 6" fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="17.6" cy="6.4" r="2" fill="#6bb8ce" />
              </svg>
            </span>
            <div className="leading-none">
              <div className="text-xl font-bold tracking-wide">RFPIS</div>
              <div className="mt-1 text-xs text-brand-200">Seeks funding seamlessly</div>
            </div>
          </div>
          <h1 className="mt-8 max-w-sm text-2xl leading-snug font-bold text-white lg:mt-12 lg:text-[2rem]">
            RFP Intelligence System
          </h1>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-brand-100">
            Weekly opportunity discovery, eligibility screening and decision support — in one place, for your whole team.
          </p>
          <ul className="mt-8 hidden max-w-sm space-y-5 lg:block">
            {PITCH.map((p) => (
              <li key={p.title} className="flex gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/10 text-accent-300">
                  {p.icon}
                </span>
                <span>
                  <span className="block text-sm font-semibold">{p.title}</span>
                  <span className="mt-0.5 block text-sm leading-relaxed text-brand-200">{p.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-10 hidden text-xs text-brand-300 lg:block">
          Clinton Health Access Initiative · RFPIS v1.0
        </p>
      </aside>

      <main className="flex items-center justify-center px-4 py-10 sm:px-8 lg:py-14">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}

function Problems({ error }: { error: ApiError | Error | null }) {
  if (!error) return null;
  const problems = error instanceof ApiError ? error.problems : [];
  return (
    <Notice tone="bad" role="alert" className="mb-4">
      {error.message}
      {problems.length > 0 && <ul className="mt-1 list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
    </Notice>
  );
}

function Expander({ title, open: initial = false, children }: { title: string; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-ink-200 bg-white">
      <button
        type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50"
      >
        {title}
        <ChevronDown className={`h-4 w-4 text-ink-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="border-t border-ink-100 px-4 py-4">{children}</div>}
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
      <h2 className="text-2xl font-bold text-brand-700">Sign in</h2>
      <p className="mt-1.5 mb-6 text-sm text-ink-500">Use the email address your administrator invited.</p>
      <form onSubmit={submit}>
        <Field id="email" label="Email" type="email" autoComplete="username" required value={email}
          onChange={(e) => setEmail(e.target.value)} />
        <Field id="password" label="Password" type="password" autoComplete="current-password" required
          value={password} onChange={(e) => setPassword(e.target.value)} />
        <Problems error={error} />
        <Button type="submit" variant="primary" busy={busy} className="w-full">Sign in</Button>
      </form>
      <Expander title="Have an activation or reset code?" open={activateOpen}>
        <CodeEntry />
      </Expander>
      <Expander title="Forgot your password?">
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
      <p className="mb-3 text-xs text-ink-500">
        If the button in your email did not open a password screen, paste the code printed underneath it here.
      </p>
      <Field id="code" label="Activation / reset code" value={code} onChange={(e) => setCode(e.target.value)} />
      <Problems error={error} />
      <Button type="submit" className="w-full">Continue</Button>
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
      <p className="mb-3 text-xs text-ink-500">
        Enter your email and request a reset. Once an admin approves it, the app emails you a one-time code and
        link to set a new password. Your current password keeps working until you use it.
      </p>
      <Field id="fp_email" label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <Problems error={error} />
      {done && <Notice tone="good" className="mb-3" icon={<CheckCircle2 className="h-4 w-4" />}>{done}</Notice>}
      <Button type="submit" busy={busy} icon={<Mail className="h-4 w-4" />} className="w-full">
        Request password reset
      </Button>
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
      <form onSubmit={async (e) => {
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
        <h2 className="text-2xl font-bold text-brand-700">Choose your password</h2>
        <Notice tone="warn" className="mt-4 mb-6">
          An administrator has asked you to choose a new password before continuing.
        </Notice>
        <Field id="fcp_current" label="Current (temporary) password" type="password" autoComplete="current-password"
          value={current} onChange={(e) => setCurrent(e.target.value)} />
        <Field id="fcp_new" label="New password" type="password" autoComplete="new-password" hint={PASSWORD_RULES_TEXT}
          value={next} onChange={(e) => setNext(e.target.value)} />
        <Field id="fcp_confirm" label="Confirm new password" type="password" autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <Problems error={error} />
        <Button type="submit" variant="primary" busy={busy} className="w-full">Save new password</Button>
        <button type="button" onClick={onCancel} className="mt-3 w-full text-center text-sm text-ink-500 hover:underline">
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
        <Notice tone="good" className="mb-6" icon={<CheckCircle2 className="h-4 w-4" />}>
          {done.purpose === "invite" ? "Account activated. Your password is set." : "Password changed."}
        </Notice>
        <h2 className="text-2xl font-bold text-brand-700">Sign in</h2>
        <p className="mt-1.5 mb-6 text-sm text-ink-500">Use your email and the password you just chose.</p>
        <Button variant="primary" className="w-full" onClick={() => navigate("/login", { replace: true })}>
          Go to sign in
        </Button>
      </Frame>
    );
  }
  if (!info) {
    return (
      <Frame>
        <div className="flex items-center gap-2.5 py-10 text-sm text-ink-500">
          <Loader2 className="h-5 w-5 animate-spin text-accent-600" /> Checking your link…
        </div>
      </Frame>
    );
  }
  if (!info.valid) {
    return (
      <Frame>
        <h2 className="mb-4 text-2xl font-bold text-brand-700">This link is no longer valid</h2>
        <Notice tone="bad">
          Setup and reset links can only be used once, and they expire. Ask an administrator to send you a new one.
        </Notice>
        <Button className="mt-5 w-full" onClick={() => navigate("/login", { replace: true })}>Go to sign in</Button>
      </Frame>
    );
  }
  const invite = info.purpose === "invite";
  if (invite && !confirmed) {
    return (
      <Frame>
        <h2 className="text-2xl font-bold text-brand-700">Activate your account</h2>
        <p className="mt-3 text-sm text-ink-700">This invitation is for <strong>{info.email}</strong>.</p>
        <p className="mt-2 mb-6 text-sm text-ink-500">
          Activating sets up your sign-in. You will choose your own password on the next screen - nobody else,
          including the administrator who invited you, knows it.
        </p>
        <Button variant="primary" className="w-full" onClick={() => setConfirmed(true)}>Activate account</Button>
      </Frame>
    );
  }
  return (
    <Frame>
      <form onSubmit={async (e) => {
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
          <Notice tone="good" className="mb-5" icon={<CheckCircle2 className="h-4 w-4" />}>
            Account activated. One step left: choose your password.
          </Notice>
        )}
        <h2 className="text-2xl font-bold text-brand-700">Choose your password</h2>
        <p className="mt-1.5 text-sm text-ink-500">
          {invite ? <>Setting the password for <strong>{info.email}</strong>.</> : <>Resetting the password for <strong>{info.email}</strong>.</>}
        </p>
        {!invite && (
          <Notice tone="brand" className="mt-4">Your current password keeps working until you save a new one here.</Notice>
        )}
        <p className="mt-4 mb-4 text-xs text-ink-500">{info.rules ?? PASSWORD_RULES_TEXT}</p>
        <Field id="tok_new" label="New password" type="password" autoComplete="new-password" hint={PASSWORD_RULES_TEXT}
          value={next} onChange={(e) => setNext(e.target.value)} />
        <Field id="tok_confirm" label="Confirm new password" type="password" autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <Problems error={error} />
        <Button type="submit" variant="primary" busy={busy} className="w-full">Save password</Button>
      </form>
    </Frame>
  );
}

/** app_pages/activate.py: the code box alone, open. */
export function ActivatePage() {
  return (
    <Frame>
      <h2 className="text-2xl font-bold text-brand-700">Activate your account</h2>
      <p className="mt-1.5 mb-5 text-sm text-ink-500">
        Paste the activation code from your invitation email. If you are resetting a forgotten password, the
        code from that email works here too.
      </p>
      <CodeEntry />
      <hr className="my-6 border-ink-200" />
      <p className="mb-3 text-sm text-ink-500">Already have a working password?</p>
      <Button className="w-full" onClick={() => navigate("/login")}>Go to sign in</Button>
    </Frame>
  );
}

/** app_pages/password_reset.py: redeem a code, or ask an admin for one. */
export function PasswordResetPage() {
  return (
    <Frame>
      <h2 className="mb-5 text-2xl font-bold text-brand-700">Reset your password</h2>
      <h3 className="mb-2 text-sm font-semibold text-ink-700">I have a reset code</h3>
      <CodeEntry />
      <hr className="my-6 border-ink-200" />
      <h3 className="mb-2 text-sm font-semibold text-ink-700">I do not have one yet</h3>
      <ResetRequestForm />
      <hr className="my-6 border-ink-200" />
      <Button className="w-full" onClick={() => navigate("/login")}>Back to sign in</Button>
    </Frame>
  );
}
