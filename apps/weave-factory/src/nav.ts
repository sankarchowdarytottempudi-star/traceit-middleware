import type { LucideIcon } from "lucide-react";
export interface NavItem {
  to: string; label: string; icon: LucideIcon; end?: boolean;
  /** Optional custom "is this item current" test (pathname in, boolean out). */
  match?: (pathname: string) => boolean;
}
export interface NavGroup { title: string; items: NavItem[]; }
