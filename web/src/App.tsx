import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { currentSession, fetchShell, me, onSessionChange, sessionVersion, signOut, viewAs, type Shell } from "./api";
import { ActivatePage, ChoosePasswordGate, LoginScreen, PasswordResetPage, TokenScreen } from "./auth/AuthPages";
import { navigate, PAGES, recordVisit, setParams, useLocation, type PageKey } from "./router";
import Layout from "./shell/Layout";
import ClassicPage from "./pages/ClassicPage";
import ReportPage from "./pages/ReportPage";
import GrantsPage from "./pages/GrantsPage";
import ActionsPage from "./pages/ActionsPage";
import DonorsPage from "./pages/DonorsPage";
import AlertsPage from "./pages/AlertsPage";
import HomePage from "./pages/HomePage";
import OpportunityPage from "./pages/OpportunityPage";
import PipelinePage from "./pages/PipelinePage";
import SettingsPage from "./pages/SettingsPage";
import SubmitPage from "./pages/SubmitPage";
import SearchPage from "./pages/SearchPage";
import OrganizationPage from "./pages/OrganizationPage";
import ProfilePage from "./pages/ProfilePage";
import HelpPage from "./pages/HelpPage";
import { viewAsUrlAction } from "./shell/viewAsUrl";
import { EmptyState } from "./ui";

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
  // The WHOLE shell, not just the one field it used to keep. Help needs the admin
  // contact address from it, and a third fetch of a response this component already
  // makes would be a round trip for a string.
  const [shell, setShell] = useState<Shell | null>(null);
  const classicUrl = shell?.classicUrl ?? null;

  // Re-check the account on every app load (a deactivated account or a revoked membership
  // ends the session here), and fetch the fields only /me returns.
  //
  // The scoring engine is NOT warmed here any more. It used to be, because the rail needed
  // it on every signed-in page; the rail is now ranked server-side, and the only surface
  // left that needs Python is the Opportunity page's decision aid. That page starts the
  // engine itself when it mounts, so nobody downloads a Python runtime to read Home.
  useEffect(() => {
    me().catch(() => undefined);
    fetchShell().then(setShell).catch(() => undefined);
  }, []);

  // ?tenant= — app_header._apply_tenant_url: for a super_user it SELECTS a view-as tenant;
  // for everyone else it only DESCRIBES the tenant being shown (an incoming value is ignored).
  //
  // WHY THERE IS A GUARD HERE (owner, 2026-11-18: "clicking Return to my account refuses to
  // do so"). The URL param SELECTS the view, and "Return to my account" only cleared the
  // SESSION. So the sequence was:
  //
  //   1. viewing chai-cameroon, URL ?tenant=chai-cameroon, user.view.slug = chai-cameroon
  //   2. Return -> viewAs(null) -> session reissued with view = null
  //   3. this effect re-runs: key is STILL chai-cameroon, and now it matches neither
  //      user.view (null) nor user.tenant (the super's own), so every clause passes
  //   4. viewAs("chai-cameroon") fires again and puts them straight back
  //
  // The server was never at fault — `routes_auth.viewAs` with an empty key returns a
  // session with view null, correctly. The button worked; the URL undid it within the same
  // tick, so from the outside it looked like the button did nothing at all.
  //
  // Streamlit does not have this problem because its handler deletes the query param in the
  // same callback (`core/app_header.py:1200`, `del st.query_params["tenant"]`). Clearing it
  // here is not enough on its own: the effect re-runs between the clear and the session
  // update and re-stamps the slug of the view that is still set, which lands us back at
  // step 3. So the INTENT has to outlive the round trip, and that is what this ref is.
  // The decision itself is `shell/viewAsUrl.viewAsUrlAction`, a pure function with its own
  // tests — this effect only carries it out.
  const key = params.get("tenant");
  const leavingView = useRef(false);
  useEffect(() => {
    const act = viewAsUrlAction({
      role: user.role,
      key,
      viewSlug: user.view?.slug, viewId: user.view?.id,
      tenantSlug: user.tenant?.slug, tenantId: user.tenant?.id,
      leaving: leavingView.current,
    });
    if (act.do === "settled") leavingView.current = false;
    else if (act.do === "clear") setParams({ tenant: null });
    else if (act.do === "enter") viewAs(act.key).catch((e) => window.alert(e.message));
    else setParams({ tenant: act.slug });
  }, [key, user.role, user.view, user.tenant?.slug, user.tenant?.id]);

  /** Leave a super_user view-as and go back to our own account.
   *
   *  Both halves, in this order, or the URL wins: raise the intent flag so the effect above
   *  stops re-applying the stale param, THEN ask the server. The errors are not swallowed —
   *  the old handler ended in `.catch(() => undefined)`, so a genuine failure and a
   *  successful return that the URL immediately reversed looked identical from the outside.
   */
  const returnToMyAccount = useCallback(async () => {
    leavingView.current = true;
    try {
      await viewAs(null);
      setParams({ tenant: null });
    } catch (e) {
      leavingView.current = false;
      window.alert(e instanceof Error ? e.message : "Couldn't return to your account.");
    }
  }, []);

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
    body = <EmptyState title="Page not found">That address doesn't match any page in RFPIS.</EmptyState>;
  } else if (shown === "home") {
    body = <HomePage user={user} />;
  } else if (shown === "opportunity") {
    body = <OpportunityPage uid={params.get("uid")?.trim() ?? ""} user={user} />;
  } else if (shown === "opportunities") {
    // TRIAGE MOVED INTO Pipeline > Screened (owner, 2026-11-18), so this key renders the
    // Pipeline page and the list appears in its section there. The key is kept precisely
    // so it does not 404: every Dashboard tile links hrefOf("opportunities", {bucket}),
    // and `PipelinePage` opens on Screened by default and reads the same ?bucket= the
    // list has always read. Changing those tiles to /pipelines links would work too, and
    // would still leave every bookmark made while Triage was a page pointing at nothing.
    body = <PipelinePage user={user} />;
  } else if (shown === "pipelines") {
    body = <PipelinePage user={user} />;
  } else if (shown === "alerts") {
    body = <AlertsPage />;
  } else if (shown === "actions") {
    body = <ActionsPage user={user} />;
  } else if (shown === "grants") {
    body = <GrantsPage />;
  } else if (shown === "report") {
    body = <ReportPage />;
  } else if (shown === "profile") {
    body = <ProfilePage />;
  } else if (shown === "help") {
    body = <HelpPage user={user} shell={shell} />;
  } else if (shown === "organization") {
    body = <OrganizationPage user={user} />;
  } else if (shown === "search") {
    body = <SearchPage />;
  } else if (shown === "submit-new-rfp") {
    body = <SubmitPage user={user} />;
  } else if (shown === "donors") {
    body = <DonorsPage />;
  } else if (shown === "settings") {
    body = user.role === "admin" || user.role === "super_user"
      ? <SettingsPage user={user} classicUrl={classicUrl} shell={shell} />
      : <EmptyState title="Settings is for administrators">Ask an administrator if you need something changed here.</EmptyState>;
  } else {
    body = <ClassicPage page={shown} classicUrl={classicUrl} />;
  }
  return (
    <Layout user={user} page={shown} onReturnToMyAccount={() => void returnToMyAccount()}>
      {body}
    </Layout>
  );
}
