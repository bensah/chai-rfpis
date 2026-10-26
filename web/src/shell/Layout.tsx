/**
 * The app shell.
 *
 * The layout is deliberately not the Streamlit one: a single CHAI Dark Blue
 * sidebar runs the full height of the window — it crosses the header band
 * rather than sitting under it — and the white top bar starts at the sidebar's
 * right edge. The sidebar collapses to an icon rail on a wide screen and
 * becomes a drawer on a narrow one.
 *
 * It still carries everything core/app_header.py did: the rail pages, search,
 * notifications with an unread count, the account menu, the tenant identity,
 * the super_user view-as banner, breadcrumbs and the version footer.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Bell, ChevronsLeft, ChevronsRight, Eye, HelpCircle, LogOut, Menu, Search, Settings, User as UserIcon, X,
} from "lucide-react";
import { fetchShell, markAllRead, signOut, viewAs, type Shell, type User } from "../api";
import { goToCrumb, hrefOf, Link, navigate, navTrail, PAGES, type PageKey } from "../router";
import { NAV_ICON } from "./navIcons";
import Popover from "./Popover";
import { fmtDay, fmtScan, nextScheduledScan, relativeTime } from "./time";
import { Badge, Button, IconButton, Notice, fieldClass } from "../ui";

export const APP_NAME = "RFP Intelligence System";
export const APP_SHORT = "RFPIS";
export const APP_SLOGAN = "Seeks funding seamlessly";
export const APP_VERSION = "v1.0";

const COLLAPSE_KEY = "rfpis.rail.collapsed";
const isAdmin = (u: User) => u.role === "admin" || u.role === "super_user";

/** The rail in two groups: the daily surfaces, then the organisation's own pages. */
const GROUPS: { label: string; pages: PageKey[] }[] = [
  { label: "Workspace", pages: ["home", "pipelines", "grants", "actions", "report", "donors"] },
  { label: "Organisation", pages: ["organization", "submit-new-rfp", "settings"] },
];

export default function Layout({ user, page, children }: { user: User; page: PageKey; children: ReactNode }) {
  const [shell, setShell] = useState<Shell | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const toggleCollapsed = () => setCollapsed((c) => {
    try {
      localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
    } catch {
      // storage blocked — the rail just forgets between loads
    }
    return !c;
  });

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

  // Escape closes the drawer, like every other overlay in the app.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);

  return (
    <div className="min-h-screen bg-canvas">
      <Sidebar
        user={user} page={page} collapsed={collapsed} drawer={drawer}
        onClose={() => setDrawer(false)} onToggleCollapse={toggleCollapsed}
      />
      <div className={`flex min-h-screen flex-col transition-[padding] duration-200 ${collapsed ? "lg:pl-[4.75rem]" : "lg:pl-64"}`}>
        <TopBar
          user={user} shell={shell} page={page} collapsed={collapsed}
          onMenu={() => setDrawer(true)} onToggleCollapse={toggleCollapsed}
          onRead={(seen) => setShell((s) => (s ? { ...s, seen, unread: 0 } : s))}
        />
        <main className="flex-1 px-4 pt-6 pb-14 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-[82rem]">
            <ViewAsBanner user={user} />
            {children}
          </div>
        </main>
        <footer className="px-4 pb-8 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-[82rem] border-t border-ink-200 pt-4 text-xs text-ink-400">
            {APP_NAME} · {APP_SHORT} {APP_VERSION}
          </div>
        </footer>
      </div>
    </div>
  );
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({ user, page, collapsed, drawer, onClose, onToggleCollapse }: {
  user: User; page: PageKey; collapsed: boolean; drawer: boolean;
  onClose: () => void; onToggleCollapse: () => void;
}) {
  const allowed = (k: PageKey) => PAGES[k].rail && (!PAGES[k].adminOnly || isAdmin(user));
  return (
    <>
      {drawer && <div className="fixed inset-0 z-40 bg-brand-950/50 backdrop-blur-[2px] lg:hidden" onClick={onClose} />}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-brand-700 text-white transition-[transform,width] duration-200 lg:translate-x-0 ${
          collapsed ? "lg:w-[4.75rem]" : "lg:w-64"
        } ${drawer ? "translate-x-0" : "-translate-x-full"}`}
      >
        {/* The brand block is the height of the top bar, so the two line up across the seam. */}
        <div className={`flex h-16 shrink-0 items-center border-b border-white/10 ${collapsed ? "lg:justify-center lg:px-0" : ""} px-4`}>
          <Link to="/" onClick={onClose} className="flex min-w-0 items-center gap-2.5" title={APP_NAME}>
            <Logomark />
            <span className={`flex min-w-0 flex-col leading-none ${collapsed ? "lg:hidden" : ""}`}>
              <span className="text-[1.05rem] font-bold tracking-wide">{APP_SHORT}</span>
              <span className="mt-1 truncate text-[0.68rem] text-brand-200">{APP_SLOGAN}</span>
            </span>
          </Link>
          {/* Wrapped rather than given `lg:hidden`: the button's own `inline-flex` and a
              display utility in the same layer fight, and the wrapper settles it. */}
          <div className="ml-auto lg:hidden">
            <IconButton label="Close menu" onClick={onClose} className="text-white/70 hover:bg-white/10 hover:text-white">
              <X className="h-5 w-5" />
            </IconButton>
          </div>
        </div>

        <nav className="scroll-on-dark flex-1 overflow-y-auto px-3 py-4">
          {GROUPS.map((g) => {
            const pages = g.pages.filter(allowed);
            if (!pages.length) return null;
            return (
              <div key={g.label} className="mb-5 last:mb-0">
                <div className={`mb-1.5 px-3 text-[0.65rem] font-semibold tracking-[0.1em] text-brand-300 uppercase ${collapsed ? "lg:hidden" : ""}`}>
                  {g.label}
                </div>
                {pages.map((k) => <NavItem key={k} page={k} active={k === page} collapsed={collapsed} onClose={onClose} />)}
              </div>
            );
          })}
        </nav>

        <div className="shrink-0 border-t border-white/10 p-3">
          <div className={`flex items-center gap-2.5 rounded-lg px-2 py-2 ${collapsed ? "lg:justify-center lg:px-0" : ""}`}>
            <Avatar user={user} onDark />
            <div className={`min-w-0 flex-1 leading-tight ${collapsed ? "lg:hidden" : ""}`}>
              <div className="truncate text-sm font-medium">{user.name || user.email}</div>
              <div className="truncate text-xs text-brand-200">{user.roleLabel}</div>
            </div>
          </div>
          <button
            onClick={onToggleCollapse}
            title={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
            className={`mt-1 hidden w-full items-center gap-2.5 rounded-lg px-4 py-2 text-xs font-medium text-brand-200 transition-colors hover:bg-white/10 hover:text-white lg:flex ${collapsed ? "lg:justify-center lg:px-0" : ""}`}
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" /> Collapse</>}
          </button>
        </div>
      </aside>
    </>
  );
}

function NavItem({ page, active, collapsed, onClose }: { page: PageKey; active: boolean; collapsed: boolean; onClose: () => void }) {
  const Icon = NAV_ICON[page];
  const title = PAGES[page].title;
  return (
    <Link
      to={hrefOf(page)} onClick={onClose} title={title}
      aria-current={active ? "page" : undefined}
      className={`relative mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
        active ? "bg-white/12 font-semibold text-white" : "text-brand-100 hover:bg-white/8 hover:text-white"
      } ${collapsed ? "lg:justify-center lg:px-0" : ""}`}
    >
      {active && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-accent-300" />}
      <Icon className="h-[1.15rem] w-[1.15rem] shrink-0" strokeWidth={active ? 2.2 : 1.8} />
      <span className={collapsed ? "lg:hidden" : ""}>{title}</span>
    </Link>
  );
}

/** The RFPIS mark, drawn inline so it stays crisp and sits white on the blue. */
function Logomark() {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
        <path d="M6 19V5h6.2a4 4 0 0 1 0 8H9.4l5.2 6" fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="17.6" cy="6.4" r="2" fill="#6bb8ce" />
      </svg>
    </span>
  );
}

function initials(user: User) {
  const src = (user.name || user.email || "?").trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || src[0].toUpperCase();
}

function Avatar({ user, onDark = false }: { user: User; onDark?: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
        onDark ? "bg-white/15 text-white ring-1 ring-white/20" : "bg-brand-100 text-brand-700"
      }`}
    >
      {initials(user)}
    </span>
  );
}

// ── Top bar ──────────────────────────────────────────────────────────────────

function TopBar({ user, shell, page, collapsed, onMenu, onToggleCollapse, onRead }: {
  user: User; shell: Shell | null; page: PageKey; collapsed: boolean;
  onMenu: () => void; onToggleCollapse: () => void; onRead: (seen: number) => void;
}) {
  const unread = shell?.unread ?? 0;
  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 border-b border-ink-200 bg-white/85 px-4 backdrop-blur-md sm:px-6 lg:px-8">
      <div className="lg:hidden">
        <IconButton label="Open menu" onClick={onMenu}>
          <Menu className="h-5 w-5" />
        </IconButton>
      </div>
      <div className="hidden lg:block">
        <IconButton label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"} onClick={onToggleCollapse}>
          {collapsed ? <ChevronsRight className="h-[1.15rem] w-[1.15rem]" /> : <ChevronsLeft className="h-[1.15rem] w-[1.15rem]" />}
        </IconButton>
      </div>

      <Breadcrumbs page={page} />

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <QuickSearch />
        <OrgBadge shell={shell} />
        <Popover
          title="Notifications" width="w-[22rem] sm:w-96"
          label={<Bell className="h-[1.15rem] w-[1.15rem]" />}
          badge={unread ? (unread < 100 ? String(unread) : "99+") : null}
        >
          {(close) => <Notifications shell={shell} onRead={onRead} close={close} />}
        </Popover>
        <Popover title="Account" width="w-72" label={<Avatar user={user} />} triggerClass="h-9 w-9 p-0">
          {(close) => <AccountMenu user={user} close={close} />}
        </Popover>
      </div>
    </header>
  );
}

function AccountMenu({ user, close }: { user: User; close: () => void }) {
  return (
    <div>
      <div className="flex items-center gap-3 px-1 pb-3">
        <Avatar user={user} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-brand-700">{user.name || user.email}</div>
          <div className="truncate text-xs text-ink-500">{user.email}</div>
        </div>
      </div>
      <Badge tone="brand" className="mb-3 ml-1">{user.roleLabel}</Badge>
      <div className="border-t border-ink-100 pt-2">
        <MenuLink to={hrefOf("help")} icon={<HelpCircle className="h-4 w-4" />} label="Help" close={close} />
        <MenuLink to={hrefOf("organization")} icon={<NAV_ICON.organization className="h-4 w-4" />} label="Tenant" close={close} />
        <MenuLink to={hrefOf("profile")} icon={<UserIcon className="h-4 w-4" />} label="Profile" close={close} />
        {isAdmin(user) && <MenuLink to={hrefOf("settings")} icon={<Settings className="h-4 w-4" />} label="Settings" close={close} />}
      </div>
      <div className="mt-2 border-t border-ink-100 pt-2">
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
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink-600 transition-colors hover:bg-bad-50 hover:text-bad-700"
        >
          <LogOut className="h-4 w-4" /> Sign out
        </button>
      </div>
    </div>
  );
}

function MenuLink({ to, icon, label, close }: { to: string; icon: ReactNode; label: string; close: () => void }) {
  return (
    <Link
      to={to} onClick={close}
      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink-700 transition-colors hover:bg-brand-50 hover:text-brand-700"
    >
      <span className="text-ink-400">{icon}</span> {label}
    </Link>
  );
}

/**
 * app_header._render_search. A real field on a wide screen — search is used often
 * enough to deserve the space — and a popover where there isn't room for one.
 */
function QuickSearch() {
  const [q, setQ] = useState("");
  const go = (term: string) => {
    if (!term.trim()) return;
    setQ("");
    navigate(hrefOf("search", { q: term.trim() }));
  };
  return (
    <>
      <form
        onSubmit={(e) => { e.preventDefault(); go(q); }}
        className="relative hidden md:block"
      >
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-400" />
        <input
          value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search"
          placeholder="Search pages, opportunities, donors…"
          className={`${fieldClass} h-9 w-56 bg-ink-50 py-0 pl-9 lg:w-72`}
        />
      </form>
      <div className="md:hidden">
        <Popover title="Search" width="w-72" label={<Search className="h-[1.15rem] w-[1.15rem]" />}>
          {(close) => (
            <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) { close(); go(q); } }}>
              <input
                autoFocus value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search"
                placeholder="Search the site…" className={fieldClass}
              />
              <Button type="submit" variant="primary" className="mt-2 w-full">Search</Button>
              <p className="mt-2 text-xs text-ink-500">Searches pages, tabs, opportunities, donors and the web.</p>
            </form>
          )}
        </Popover>
      </div>
    </>
  );
}

/** app_header._render_notifications_popover */
function Notifications({ shell, onRead, close }: { shell: Shell | null; onRead: (seen: number) => void; close: () => void }) {
  const next = nextScheduledScan();
  const m = shell?.nextMeeting;
  const feed = shell?.feed ?? [];
  return (
    <div className="max-h-[70vh] overflow-y-auto">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-brand-700">Notifications</span>
        {(shell?.unread ?? 0) > 0 && <Badge tone="accent">{shell?.unread} new</Badge>}
      </div>
      <div className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
        <div>Next auto-scan · {fmtScan(next)} ({relativeTime(next.getTime())})</div>
        {m && (
          <div className="mt-1">
            Next call · {fmtDay(m.date)} · Note-taker: {m.note_taker || "—"}; Presenter: {m.presenter || "—"}; Chair: {m.chair || "—"}
          </div>
        )}
      </div>
      <div className="mt-3 space-y-2.5">
        {!feed.length && <p className="py-4 text-center text-xs text-ink-500">No recent activity yet.</p>}
        {feed.slice(0, 15).map((it, i) => {
          const isNew = shell?.seen == null || it.ts > shell.seen;
          const to = it.nav === "opportunity" && it.uid ? hrefOf("opportunity", { uid: it.uid }) : hrefOf(it.nav as PageKey);
          return (
            <Link
              key={i} to={to} onClick={close} title="Open this"
              className="flex gap-2.5 rounded-lg p-2 transition-colors hover:bg-brand-50"
            >
              <span aria-hidden className="mt-0.5 text-base leading-none">{it.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium text-ink-800">
                  {isNew && <span aria-label="New" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-600" />}
                  <span className="truncate">{it.title}</span>
                </span>
                <span className="block text-xs text-ink-500">{it.detail}</span>
                <span className="block text-[0.7rem] text-ink-400">{relativeTime(it.ts)}</span>
              </span>
            </Link>
          );
        })}
      </div>
      {(shell?.unread ?? 0) > 0 && (
        <div className="mt-3 border-t border-ink-100 pt-3">
          <Button
            size="sm" className="w-full"
            onClick={() => markAllRead().then((r) => onRead(r.seen)).catch(() => undefined)}
          >
            Mark all as read
          </Button>
        </div>
      )}
    </div>
  );
}

/** app_header._render_org_identity: whose data is on screen, kept in the bar. */
function OrgBadge({ shell }: { shell: Shell | null }) {
  if (!shell) return null;
  const [primary, secondary] = shell.org.name.includes(" — ")
    ? [shell.org.name.split(" — ")[0], shell.org.name.split(" — ").slice(1).join(" — ")]
    : [shell.org.name, ""];
  return (
    <div className="mr-1 hidden items-center gap-2.5 border-r border-ink-200 pr-3 lg:flex" title={shell.org.name}>
      {shell.org.logo && (
        <img src={`data:${shell.org.logo.mime};base64,${shell.org.logo.b64}`} alt="" className="h-8 max-w-[6rem] object-contain" />
      )}
      <div className="max-w-[12rem] text-right leading-tight">
        <div className="truncate text-sm font-semibold text-brand-700">{primary}</div>
        {secondary && <div className="truncate text-xs text-ink-500">{secondary}</div>}
      </div>
    </div>
  );
}

/** ui_links.render_breadcrumbs: nothing for a trail of one, so show the page name instead. */
function Breadcrumbs({ page }: { page: PageKey }) {
  const trail = navTrail();
  if (trail.length < 2) {
    return <span className="truncate text-[0.95rem] font-semibold text-brand-700">{PAGES[page].title}</span>;
  }
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
      {trail.map((c, i) => {
        const name = PAGES[c.page]?.title ?? "Home";
        const last = i === trail.length - 1;
        // Below sm there is only room for where you are — the whole crumb goes, separator
        // included, or the bar fills with orphaned slashes.
        return last ? (
          <span key={i} className="truncate font-semibold text-brand-700">{name}</span>
        ) : (
          <span key={i} className="hidden min-w-0 items-center gap-1 sm:flex">
            <button
              onClick={() => goToCrumb(trail, i)} title={`Back to ${name}`}
              className="truncate rounded px-1 text-ink-500 transition-colors hover:text-accent-700 hover:underline"
            >
              {name}
            </button>
            <span className="text-ink-300">/</span>
          </span>
        );
      })}
    </nav>
  );
}

/** app_header._render_super_view_banner */
function ViewAsBanner({ user }: { user: User }) {
  if (!user.view) return null;
  return (
    <Notice tone="warn" icon={<Eye className="h-4 w-4" />} className="mb-5 items-center">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>
          Viewing <strong>{user.view.name || "another tenant"}</strong> as super_user — every page is scoped to this
          tenant. Cross-tenant analytics live in Settings → Analytics.
        </span>
        <Button size="sm" onClick={() => viewAs(null).catch(() => undefined)}>Return to my account</Button>
      </div>
    </Notice>
  );
}
