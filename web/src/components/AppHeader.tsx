import { LogOut } from "lucide-react";
import type { User } from "../api";

export default function AppHeader({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
        <img src="/favicon.svg" alt="" className="h-8 w-8" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-bold text-navy">RFP Intelligence System</div>
          <div className="truncate text-xs text-slate-500">
            {user.tenant?.name ? `${user.tenant.name} · ` : ""}React preview
          </div>
        </div>
        <div className="hidden text-right sm:block">
          <div className="text-sm font-medium text-slate-800">{user.name}</div>
          <div className="text-xs text-slate-500">{user.roleLabel}</div>
        </div>
        <button
          onClick={onSignOut} title="Sign out"
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
        >
          <LogOut className="h-4 w-4" /> <span className="hidden sm:inline">Sign out</span>
        </button>
      </div>
    </header>
  );
}
