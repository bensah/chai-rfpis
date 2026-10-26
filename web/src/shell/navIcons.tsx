/**
 * One line-icon per page, replacing the emoji the Streamlit rail used. A single
 * icon family at one stroke weight is most of what makes a sidebar look settled.
 * PAGES[k].icon (the emoji) is still what the notification feed renders.
 */
import {
  BookOpen, Briefcase, Building2, ClipboardList, FilePlus, Globe, KeyRound, LayoutDashboard,
  Layers, Lock, LogIn, Search, Settings, Target, TrendingUp, User,
  type LucideIcon,
} from "lucide-react";
import type { PageKey } from "../router";

export const NAV_ICON: Record<PageKey, LucideIcon> = {
  home: LayoutDashboard,
  pipelines: Layers,
  grants: Briefcase,
  actions: ClipboardList,
  report: TrendingUp,
  donors: Globe,
  organization: Building2,
  "submit-new-rfp": FilePlus,
  opportunity: Target,
  profile: User,
  help: BookOpen,
  search: Search,
  settings: Settings,
  login: LogIn,
  "activate-account": KeyRound,
  "password-reset": Lock,
};
