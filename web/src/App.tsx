import { useEffect, useState, useSyncExternalStore } from "react";
import { currentSession, fetchShell, me, onSessionChange, sessionVersion, signOut, viewAs } from "./api";
import { ActivatePage, ChoosePasswordGate, LoginScreen, PasswordResetPage, TokenScreen } from "./auth/AuthPages";
import { navigate, PAGES, recordVisit, setParams, useLocation, type PageKey } from "./router";
import Layout from "./shell/Layout";
import ClassicPage from "./pages/ClassicPage";
import DonorsPage from "./pages/DonorsPage";
import SettingsPage from "./pages/SettingsPage";

export default function App() {
  useSyncExternalStore(onSessionChange, sessionVersion);
  const session = currentSession();
  const { page, params } = useLocation();
  const token = params.get("token")?.trim() ?? "";

  // App.py runs the public pages, and any ?token= link, before the login gate.
  if (token) return <TokenScreen token={token} />;
  if (page === "activate-account") return <ActivatePage />;
  if (page === "password-reset") return <PasswordResetPage />;

  if (!session) {
    return <LoginScreen onSignedIn={() => {
      // /login has nothing to say once signed in: Home is where they were going.
      if (page === "login") navigate("/", { replace: true });
    }} />;
  }
  if (session.mustChangePassword) {
    return <ChoosePasswordGate onDone={() => undefined} onCancel={() => signOut()} />;
  }
  return <SignedIn page={page} params={params} />;
}

function SignedIn({ page, params }: { page: PageKey | null; params: URLSearchParams }) {
  const user = currentSession()!.user;
  const [classicUrl, setClassicUrl] = useState<string | null>(null);

  // Re-check the account on every app load (a deactivated account or a revoked membership
  // ends the session here), and fetch the fields only /me returns.
  useEffect(() => {
    me().catch(() => undefined);
    fetchShell().then((s) => setClassicUrl(s.classicUrl)).catch(() => undefined);
  }, []);

  // ?tenant= — app_header._apply_tenant_url: for a super_user it SELECTS a view-as tenant;
  // for everyone else it only DESCRIBES the tenant being shown (an incoming value is ignored).
  const key = params.get("tenant");
  const shownSlug = user.view?.slug ?? user.tenant?.slug ?? null;
  useEffect(() => {
    if (user.role === "super_user" && key && key !== user.view?.slug && key !== user.view?.id &&
      key !== user.tenant?.slug && key !== user.tenant?.id) {
      viewAs(key).catch((e) => window.alert(e.message));
      return;
    }
    setParams({ tenant: shownSlug });
  }, [key, shownSlug, user.role, user.view?.slug, user.view?.id, user.tenant?.slug, user.tenant?.id]);

  const shown: PageKey = page && !PAGES[page].public ? page : "home";
  // /login (or another public page) while signed in: Home is where they were going.
  useEffect(() => {
    if (page && PAGES[page].public) navigate("/", { replace: true });
  }, [page]);
  useEffect(() => {
    recordVisit(shown, params);
  }, [shown, params]);
  useEffect(() => {
    document.title = `${PAGES[shown].title} · RFPIS`;
  }, [shown]);

  let body;
  if (!page) {
    body = <p className="pt-10 text-slate-600">Page not found.</p>;
  } else if (shown === "donors") {
    body = <DonorsPage />;
  } else if (shown === "settings") {
    body = user.role === "admin" || user.role === "super_user"
      ? <SettingsPage user={user} classicUrl={classicUrl} />
      : <p className="pt-10 text-slate-600">You don't have access to Settings.</p>;
  } else {
    body = <ClassicPage page={shown} classicUrl={classicUrl} />;
  }
  return <Layout user={user} page={shown}>{body}</Layout>;
}
