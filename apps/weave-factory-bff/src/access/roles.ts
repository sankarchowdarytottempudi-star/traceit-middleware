// Areas of Weave a person can be given. Each one is granted on its own:
//   admin     - manage users, roles and the group mapping; read the audit log
//   migration - the Factory (migrations and the integration studio)
//   gateway   - the Gateway console
// NOTE: this folder (src/access) is kept identical in gateway-admin-bff and weave-factory-bff;
// test/access-sync.test.ts in gateway-admin-bff fails when the two copies differ.
export const ROLES = ["admin", "migration", "gateway"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin (users and access)",
  migration: "Migration (Factory)",
  gateway: "Gateway console",
};

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

/** Known roles only, each once, in a fixed order. */
export function cleanRoles(v: unknown): Role[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : [];
  const set = new Set(list.map((x) => String(x).trim().toLowerCase()).filter(isRole));
  return ROLES.filter((r) => set.has(r));
}

export interface GroupRole { group: string; label?: string; roles: Role[] }

/** Roles given through directory groups: a group matches by object id or name, ignoring case. */
export function rolesFromGroups(groups: readonly string[] | undefined, mapping: readonly GroupRole[]): Role[] {
  if (!groups?.length || !mapping.length) return [];
  const have = new Set(groups.map((g) => g.trim().toLowerCase()));
  const out = new Set<Role>();
  for (const m of mapping) if (have.has(m.group.trim().toLowerCase())) for (const r of m.roles) out.add(r);
  return ROLES.filter((r) => out.has(r));
}

export function unionRoles(...lists: readonly (readonly Role[])[]): Role[] {
  const s = new Set<Role>(); for (const l of lists) for (const r of l) s.add(r);
  return ROLES.filter((r) => s.has(r));
}
