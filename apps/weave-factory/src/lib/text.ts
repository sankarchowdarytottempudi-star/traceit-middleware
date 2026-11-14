/** Render ANY backend value as text. React throws (error #31) if an object is used as a child,
 *  and the migration backend returns objects where we once assumed strings. */
export function txt(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(txt).filter(Boolean).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["step", "title", "name", "label", "summary", "message", "detail", "phase", "id"]) {
      if (typeof o[k] === "string" && o[k]) return o[k] as string;
    }
    try { return JSON.stringify(v); } catch { return ""; }
  }
  return String(v);
}
export function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
