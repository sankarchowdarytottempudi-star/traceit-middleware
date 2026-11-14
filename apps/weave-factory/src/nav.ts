import type { LucideIcon } from "lucide-react";
export interface NavItem { to: string; label: string; icon: LucideIcon; end?: boolean; }
export interface NavGroup { title: string; items: NavItem[]; }
