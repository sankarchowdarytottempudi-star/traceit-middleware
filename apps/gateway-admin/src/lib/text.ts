/** Render ANY backend value as text. React throws (error #31) if an object is used as a child. */
export function txt(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(txt).filter(Boolean).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["title", "name", "label", "summary", "message", "detail", "id"]) {
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
export function list<T = unknown>(v: unknown): T[] { return Array.isArray(v) ? (v as T[]) : []; }

/** 1284 -> "1,284" */
export function fmtInt(v: unknown): string { return Math.round(num(v)).toLocaleString("en-US"); }
/** 1284 -> "1,284", 12900 -> "12.9K", 4200000 -> "4.2M" */
export function fmtCompact(v: unknown): string {
  const n = num(v); const a = Math.abs(n);
  if (a < 10_000) return Math.round(n).toLocaleString("en-US");
  const unit = a >= 1e9 ? [1e9, "B"] as const : a >= 1e6 ? [1e6, "M"] as const : [1e3, "K"] as const;
  const x = n / unit[0];
  return `${Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 10) / 10}${unit[1]}`;
}
/** Milliseconds for people: "<1 ms", "42 ms", "1.24 s". null/undefined -> "—". */
export function fmtMs(v: unknown): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n > 0 && n < 1) return "<1 ms";
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 10_000) return `${(n / 1000).toFixed(2)} s`;
  return `${(n / 1000).toFixed(1)} s`;
}
/** A percentage that is already 0..100. */
export function fmtPct(v: unknown): string {
  const n = num(v);
  if (n === 0) return "0%";
  if (n < 0.1) return "<0.1%";
  return `${n < 10 ? Math.round(n * 10) / 10 : Math.round(n)}%`;
}
export function share(part: number, whole: number): number { return whole > 0 ? (part / whole) * 100 : 0; }

const two = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "14:05" */
export function fmtClock(ms: number): string { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}`; }
/** "14:05:09.123" */
export function fmtClockMs(ms: number): string { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`; }
/** "Nov 14" */
export function fmtDay(ms: number): string { const d = new Date(ms); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; }
/** "Nov 14, 14:05" */
export function fmtDateTime(ms: number): string { return `${fmtDay(ms)}, ${fmtClock(ms)}`; }
/** "Nov 14, 14:05:09" */
export function fmtDateTimeSec(ms: number): string { const d = new Date(ms); return `${fmtDay(ms)}, ${fmtClock(ms)}:${two(d.getSeconds())}`; }
/** "just now", "12 s ago", "5 min ago", "3 h ago", "2 d ago" */
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms || !Number.isFinite(ms)) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export function plural(n: number, one: string, many = `${one}s`): string { return `${fmtInt(n)} ${n === 1 ? one : many}`; }

const STATUS_NAMES: Record<number, string> = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No content", 301: "Moved", 302: "Found", 304: "Not modified",
  400: "Bad request", 401: "Not signed in", 403: "Not allowed", 404: "Not found", 405: "Method not allowed", 406: "Not acceptable", 408: "Request timed out",
  409: "Conflict", 413: "Too large", 415: "Unsupported type", 422: "Invalid data", 429: "Over the rate limit",
  500: "Server error", 501: "Not implemented", 502: "Bad gateway", 503: "Unavailable", 504: "Backend timed out",
};
export function statusName(code: number): string { return STATUS_NAMES[code] ?? (code >= 500 ? "Server error" : code >= 400 ? "Client error" : code >= 300 ? "Redirect" : code >= 200 ? "Success" : "Unknown"); }
export function statusClass(code: number): "ok" | "warn" | "bad" { return code >= 500 ? "bad" : code >= 400 ? "warn" : "ok"; }
