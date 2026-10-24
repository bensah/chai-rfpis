/**
 * The app shell — a port of core/app_header.py::render_app_header and the sidebar:
 *   * left rail: RFPIS wordmark, the rail pages, "Signed in as … / Role", the footer;
 *   * top bar (green): app logo, "RFPIS" + slogan, 🔍 search, 🔔 notifications, 👤 menu;
 *   * under the bar: the tenant's logo + name (top right), the super_user view-as banner,
 *     breadcrumbs.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import { fetchShell, markAllRead, signOut, viewAs, type Shell, type User } from "../api";
import { goToCrumb, hrefOf, Link, navigate, navTrail, PAGES, type PageKey } from "../router";
import Popover from "./Popover";
import { fmtDay, fmtScan, nextScheduledScan, relativeTime } from "./time";

export const APP_NAME = "RFP Intelligence System";
export const APP_SHORT = "RFPIS";
export const APP_SLOGAN = "Seeks funding seamlessly";
export const APP_VERSION = "v1.0";

const isAdmin = (u: User) => u.role === "admin" || u.role === "super_user";

export default function Layout({ user, page, children }: { user: User; page: PageKey; children: ReactNode }) {
  const [shell, setShell] = useState<Shell | null>(null);
  const [railOpen, setRailOpen] = useState(false);

  const load = useCallback(() => {
    fetchShell().then(setShell).catch(() => undefined);
  }, []);
  // The feed is cached 60 s in Streamlit; refresh on that cadence, and when the viewed
  // tenant changes (view-as / tenant switch re-scope the feed and the badge).
  useEffect(() => {
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, [load, user.tenant?.id, user.view?.id]);

  return (
    <div className="flex min-h-screen bg-white">
      <Rail user={user} page={page} open={railOpen} onClose={() => setRailOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar user={user} shell={shell} onMenu={() => setRailOpen(true)} onRead={(seen) =>
          setShell((s) => (s ? { ...s, seen, unread: 0 } : s))} />
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
          <OrgBadge shell={shell} />
          <ViewAsBanner user={user} />
          <Breadcrumbs />
        </div>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 sm:px-6">{children}</main>
      </div>
    </div>
  );
}

function Rail({ user, page, open, onClose }: { user: User; page: PageKey; open: boolean; onClose: () => void }) {
  const items = (Object.keys(PAGES) as PageKey[])
    .filter((k) => PAGES[k].rail && (!PAGES[k].adminOnly || isAdmin(user)));
  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/30 lg:hidden" onClick={onClose} />}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-slate-200 bg-surface transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center justify-between px-5 pb-3 pt-5">
          <div className="text-2xl font-extrabold tracking-wide text-[#1e3a8a]">{APP_SHORT}</div>
          <button className="rounded p-1 text-slate-500 hover:bg-slate-200 lg:hidden" onClick={onClose} aria-label="Close menu">
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-3">
          {items.map((k) => (
            <Link
              key={k} to={hrefOf(k)} title={PAGES[k].title} onClick={onClose}
              className={`mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-[0.95rem] ${k === page ? "bg-brand-soft font-semibold text-brand-dark" : "text-slate-700 hover:bg-slate-200/60"}`}
            >
              <span className="w-5 text-center">{PAGES[k].icon}</span> {PAGES[k].title}
            </Link>
          ))}
        </nav>
        <div className="border-t border-slate-200 px-5 py-4 text-xs text-slate-600">
          <div>Signed in as <strong>{user.name || user.email}</strong></div>
          <div className="mt-0.5">Role: <code className="rounded bg-slate-200/70 px-1">{user.roleLabel}</code></div>
          <div className="mt-4 text-slate-500">
            <strong className="text-slate-700">{APP_NAME}</strong><br />
            {APP_SHORT} · {APP_VERSION}
          </div>
        </div>
      </aside>
    </>
  );
}

function TopBar({ user, shell, onMenu, onRead }: {
  user: User; shell: Shell | null; onMenu: () => void; onRead: (seen: number) => void;
}) {
  const unread = shell?.unread ?? 0;
  return (
    <header className="sticky top-0 z-30 flex h-[4.6rem] items-center gap-2 bg-[#014729] px-3 text-white sm:px-5">
      <button className="rounded-lg p-2 hover:bg-white/10 lg:hidden" onClick={onMenu} aria-label="Open menu">
        <Menu className="h-5 w-5" />
      </button>
      <Link to="/" className="flex min-w-0 flex-1 items-center gap-3">
        <img src="/rfpis_icon.svg" alt="" className="h-10 w-10 rounded-md bg-white/95 p-0.5" />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="text-[1.15rem] font-bold">{APP_SHORT}</span>
          <span className="truncate text-[0.82rem] font-medium italic text-[#bfe0cf]">{APP_SLOGAN}</span>
        </span>
      </Link>
      <SearchPopover />
      <Popover label="🔔" title="Notifications" badge={unread ? (unread < 100 ? String(unread) : "99+") : null} width="w-96">
        {(close) => <Notifications shell={shell} onRead={onRead} close={close} />}
      </Popover>
      <Popover label="👤" title="Account" width="w-64">
        {(close) => (
          <div>
            <div className="text-[0.95rem] font-semibold text-[#1e3a8a]">{user.name || user.email}</div>
            <div className="text-xs text-slate-500">{user.email}</div>
            <hr className="my-3 border-slate-200" />
            <MenuLink to={hrefOf("help")} icon="❓" label="Help" close={close} />
            <MenuLink to={hrefOf("organization")} icon="🏢" label="Tenant" close={close} />
            <MenuLink to={hrefOf("profile")} icon="👤" label="Profile" close={close} />
            {isAdmin(user) && <MenuLink to={hrefOf("settings")} icon="⚙️" label="Settings" close={close} />}
            <hr className="my-3 border-slate-200" />
            <button
              onClick={() => {
                close();
                signOut();
                try {
                  sessionStorage.removeItem("rfpis.trail");
                } catch {
                  // storage blocked
                }
                navigate("/login");
              }}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
            >
              🚪 Sign Out
            </button>
          </div>
        )}
      </Popover>
    </header>
  );
}

function MenuLink({ to, icon, label, close }: { to: string; icon: string; label: string; close: () => void }) {
  return (
    <Link to={to} onClick={close} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-100">
      <span>{icon}</span> {label}
    </Link>
  );
}

/** app_header._render_search: type, then land on the results page with ?q=. */
function SearchPopover() {
  const [q, setQ] = useState("");
  return (
    <Popover label="🔍" title="Search" width="w-72">
      {(close) => (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!q.trim()) return;
            close();
            navigate(hrefOf("search", { q: q.trim() }));
          }}
        >
          <input
            autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the site…"
            aria-label="Search"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
          <button type="submit" className="mt-2 w-full rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand-dark">
            Search
          </button>
          <p className="mt-2 text-xs text-slate-500">Searches pages, tabs, opportunities, donors + the web.</p>
          <Link to={hrefOf("search")} onClick={close} className="mt-1 block text-sm text-brand hover:underline">
            🔍 Open full search page
          </Link>
        </form>
      )}
    </Popover>
  );
}

/** app_header._render_notifications_popover */
function Notifications({ shell, onRead, close }: { shell: Shell | null; onRead: (seen: number) => void; close: () => void }) {
  const next = nextScheduledScan();
  const m = shell?.nextMeeting;
  const feed = shell?.feed ?? [];
  return (
    <div className="max-h-[70vh] overflow-y-auto">
      <div className="font-semibold">Notifications</div>
      <p className="mt-1 text-xs text-slate-500">⏰ Next auto-scan · {fmtScan(next)} ({relativeTime(next.getTime())})</p>
      {m && (
        <p className="mt-1 text-xs text-slate-500">
          📅 Next call · {fmtDay(m.date)} · Note-taker: {m.note_taker || "—"}; Presenter: {m.presenter || "—"}; Chair: {m.chair || "—"}
        </p>
      )}
      <hr className="my-3 border-slate-200" />
      {!feed.length ? (
        <p className="text-xs text-slate-500">No recent activity yet.</p>
      ) : (
        feed.slice(0, 15).map((it, i) => {
          const isNew = shell?.seen == null || it.ts > shell.seen;
          const to = it.nav === "opportunity" && it.uid ? hrefOf("opportunity", { uid: it.uid }) : hrefOf(it.nav as PageKey);
          return (
            <div key={i} className="mb-2">
              <Link to={to} onClick={close} title="Open this" className="block text-sm hover:underline">
                {isNew ? "🟢 " : ""}{it.icon} <strong>{it.title}</strong> · {relativeTime(it.ts)}
              </Link>
              <div className="text-[0.85rem] text-slate-500">{it.detail}</div>
            </div>
          );
        })
      )}
      <hr className="my-3 border-slate-200" />
      {(shell?.unread ?? 0) > 0 && (
        <button
          onClick={() => markAllRead().then((r) => onRead(r.seen)).catch(() => undefined)}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
        >
          Mark all as read
        </button>
      )}
    </div>
  );
}

/** app_header._render_org_identity: the tenant's logo + name, top right under the bar. */
function OrgBadge({ shell }: { shell: Shell | null }) {
  if (!shell) return <div className="h-14" />;
  const [primary, secondary] = shell.org.name.includes(" — ")
    ? [shell.org.name.split(" — ")[0], shell.org.name.split(" — ").slice(1).join(" — ")]
    : [shell.org.name, ""];
  return (
    <div className="flex items-center justify-end gap-3 py-3">
      {shell.org.logo && (
        <img src={`data:${shell.org.logo.mime};base64,${shell.org.logo.b64}`} alt="" className="h-10 max-w-[8rem] object-contain" />
      )}
      <div className="text-right leading-tight">
        <div className="font-semibold text-[#1e3a8a]">{primary}</div>
        {secondary && <div className="text-xs text-slate-500">{secondary}</div>}
      </div>
    </div>
  );
}

/** app_header._render_super_view_banner */
function ViewAsBanner({ user }: { user: User }) {
  if (!user.view) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <span>👁 Viewing <strong>{user.view.name || "another tenant"}</strong> as super_user — every page is scoped to this
        tenant. (Cross-tenant analytics live in Settings → Analytics.)</span>
      <button
        onClick={() => viewAs(null).catch(() => undefined)}
        className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-medium hover:bg-amber-100"
      >
        ← Return to my account
      </button>
    </div>
  );
}

/** ui_links.render_breadcrumbs: nothing for a trail of one; the last crumb is a label. */
function Breadcrumbs() {
  const trail = navTrail();
  if (trail.length < 2) return null;
  return (
    <nav aria-label="Breadcrumb" className="mb-2 flex flex-wrap items-center gap-1.5 text-sm">
      {trail.map((c, i) => {
        const name = PAGES[c.page]?.title ?? "Home";
        if (i === trail.length - 1) return <span key={i} className="font-medium text-slate-700">{name}</span>;
        return (
          <span key={i} className="flex items-center gap-1.5">
            <button onClick={() => goToCrumb(trail, i)} title={`Back to ${name}`} className="text-brand hover:underline">{name}</button>
            <span className="text-slate-400">›</span>
          </span>
        );
      })}
    </nav>
  );
}
