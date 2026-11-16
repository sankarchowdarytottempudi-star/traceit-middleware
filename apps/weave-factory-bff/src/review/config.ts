// Settings of the Identity Review Workbench (AROYA guest identity resolution, plan v2.1 §15).
// Read from the environment so the rest of the Factory's configuration stays untouched.
// Secrets are read from files (never from the environment itself, never logged).
import { readFileSync } from "node:fs";

export type ReviewRole = "IDENTITY_REVIEWER" | "IDENTITY_SUPERVISOR" | "CRM_ADMINISTRATOR" | "AUDIT_REPORTING";
export const ROLES: readonly ReviewRole[] = ["IDENTITY_REVIEWER", "IDENTITY_SUPERVISOR", "CRM_ADMINISTRATOR", "AUDIT_REPORTING"];

export interface RoleMap { users: Record<string, ReviewRole[]>; domains: Record<string, ReviewRole[]> }

export interface ReviewConfig {
  enabled: boolean;
  /** Integration Service review API, e.g. http://identity-review-api.wso2.svc/identity-review/v1 — the ONLY backend. */
  apiUrl: string;
  apiToken: string;
  zohoAccountsUrl: string;
  zohoClientId: string;
  zohoClientSecret: string;
  /** Allowed parents for the Zoho Web Tab (CSP frame-ancestors). */
  frameAncestors: string[];
  /** Base of CRM record deep links (navigation only), e.g. https://crm.zoho.com/crm/org123 */
  crmLinkBase: string;
  roleMap: RoleMap;
  /** Business days allowed per case kind before it is overdue. */
  slaDays: Record<string, number>;
  /** Working days, 0 = Sunday. Saudi week by default. */
  workWeek: number[];
  idleMinutes: number;
  maxHours: number;
}

const fileText = (p?: string): string => {
  if (!p) return "";
  try { return readFileSync(p, "utf8").trim(); } catch { return ""; }
};

function roleList(v: unknown): ReviewRole[] {
  return Array.isArray(v) ? v.filter((r): r is ReviewRole => ROLES.includes(r as ReviewRole)) : [];
}

export function parseRoleMap(text: string): RoleMap {
  const out: RoleMap = { users: {}, domains: {} };
  if (!text) return out;
  try {
    const j = JSON.parse(text) as { users?: Record<string, unknown>; domains?: Record<string, unknown> };
    for (const [k, v] of Object.entries(j.users ?? {})) out.users[k.trim().toLowerCase()] = roleList(v);
    for (const [k, v] of Object.entries(j.domains ?? {})) out.domains[k.trim().toLowerCase().replace(/^@/, "")] = roleList(v);
  } catch { /* a broken file grants nothing */ }
  return out;
}

export const DEFAULT_SLA: Record<string, number> = {
  MULTIPLE_IDENTITY_CONFLICT: 1, REEVALUATION_CONFLICT: 1, GUARDRAIL: 1, FOUR_FIELD_REVIEW: 2, PAIR_REPAIR: 2, SHADOW_CANDIDATE: 5,
};

export function loadReviewConfig(env: NodeJS.ProcessEnv = process.env): ReviewConfig {
  let sla = { ...DEFAULT_SLA };
  try { if (env.REVIEW_SLA_DAYS) sla = { ...sla, ...(JSON.parse(env.REVIEW_SLA_DAYS) as Record<string, number>) }; } catch { /* keep defaults */ }
  const week = (env.REVIEW_WORKWEEK ?? "0,1,2,3,4").split(",").map((d) => Number(d.trim())).filter((d) => d >= 0 && d <= 6);
  return {
    enabled: /^(1|true|yes|on)$/i.test(env.REVIEW_WORKBENCH_ENABLED ?? ""),
    apiUrl: (env.REVIEW_API_URL ?? "").replace(/\/+$/, ""),
    apiToken: fileText(env.REVIEW_API_TOKEN_FILE),
    zohoAccountsUrl: (env.REVIEW_ZOHO_ACCOUNTS_URL ?? "https://accounts.zoho.com").replace(/\/+$/, ""),
    zohoClientId: env.REVIEW_ZOHO_CLIENT_ID ?? "",
    zohoClientSecret: fileText(env.REVIEW_ZOHO_CLIENT_SECRET_FILE),
    frameAncestors: (env.REVIEW_FRAME_ANCESTORS ?? "https://crm.zoho.com https://crm.zoho.sa https://crm.zoho.eu https://crm.zoho.in")
      .split(/\s+/).filter((s) => /^https:\/\/[A-Za-z0-9.*-]+(:\d+)?$/.test(s)),
    crmLinkBase: (env.REVIEW_CRM_LINK_BASE ?? "").replace(/\/+$/, ""),
    roleMap: parseRoleMap(fileText(env.REVIEW_ROLE_MAP_FILE)),
    slaDays: sla,
    workWeek: week.length ? week : [0, 1, 2, 3, 4],
    idleMinutes: Number(env.REVIEW_IDLE_MINUTES ?? 30) || 30,
    maxHours: Number(env.REVIEW_MAX_HOURS ?? 8) || 8,
  };
}

/** Roles of a signed-in Zoho user: explicit user entries win over domain entries. */
export function rolesFor(map: RoleMap, email: string, zuid: string): ReviewRole[] {
  const e = email.trim().toLowerCase();
  const byUser = map.users[e] ?? map.users[zuid];
  if (byUser) return byUser;
  const dom = e.includes("@") ? e.slice(e.lastIndexOf("@") + 1) : "";
  return dom ? (map.domains[dom] ?? []) : [];
}
