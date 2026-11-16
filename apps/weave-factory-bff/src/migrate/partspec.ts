// A chosen part of a Node.js project, checked (no other module needed here).
export interface PartSpec { prefix?: string; module?: string; routes?: string[]; workers?: true; name?: string }

const ROUTE = /^(?:(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ANY) )?\/\S{0,300}$/;
const SEG = /^[A-Za-z0-9_./{}:-]{1,200}$/;

/** A chosen part, checked: only its own fields travel on. */
export function partOf(body: unknown): { ok: true; spec: PartSpec; keepService: boolean; confirm: boolean } | { ok: false; error: string } {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const spec: PartSpec = {};
  if (b.routes !== undefined) {
    const rs = b.routes;
    if (!Array.isArray(rs) || rs.length === 0 || rs.length > 500 || !rs.every((x) => typeof x === "string" && ROUTE.test(x.trim())))
      return { ok: false, error: "Routes are given as \"METHOD /path\" or \"/path\" (at most 500)." };
    spec.routes = [...new Set((rs as string[]).map((x) => x.trim()))].sort();
  }
  for (const k of ["prefix", "module"] as const) {
    const v = b[k];
    if (v === undefined || v === "") continue;
    if (typeof v !== "string" || !SEG.test(v.trim()) || v.includes("..")) return { ok: false, error: `The ${k === "prefix" ? "route prefix" : "module folder"} has letters, digits and / . _ - only.` };
    spec[k] = v.trim();
  }
  if (!spec.routes && !spec.prefix && !spec.module) return { ok: false, error: "Choose the part: a route prefix, a module folder or routes from the list." };
  if (b.workers === true) spec.workers = true;
  if (b.name !== undefined && b.name !== "") {
    if (typeof b.name !== "string" || !/^[a-z][a-z0-9-]{2,60}$/.test(b.name.trim())) return { ok: false, error: "The service name has lower-case letters, digits and - (3 to 61 characters)." };
    spec.name = b.name.trim();
  }
  return { ok: true, spec, keepService: b.keepService === true, confirm: b.confirm === true };
}

/** The part chosen while starting a migration, as the X-Scope header the tool reads (or an error). */
export function scopeHeaderOf(raw: string | undefined): { ok: true; header?: string } | { ok: false; error: string } {
  if (!raw) return { ok: true };
  if (raw.length > 4000) return { ok: false, error: "The chosen part is too long." };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, error: "The chosen part could not be read." }; }
  const p = partOf(parsed);
  if (!p.ok) return p;
  return { ok: true, header: JSON.stringify(p.spec) };
}
