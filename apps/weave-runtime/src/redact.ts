// Masking and truncation for anything that is stored or shown: step traces, executions, logs.
import type { Json } from "@traceit/weave-flow";

export const MASK = "***";
const SENSITIVE = /(authorization|cookie|client[-_]?auth|api[-_]?key|secret|password|passwd|token|credential)/i;
export const isSensitiveKey = (k: string) => SENSITIVE.test(k);

/** Deep copy with sensitive keys masked and known secret values blanked wherever they appear. */
export function redact(value: unknown, secretValues?: Iterable<string>): Json {
  const secrets = secretValues ? [...secretValues].filter((s) => s && s.length >= 4) : [];
  const str = (s: string) => {
    let out = s;
    for (const sec of secrets) if (out.includes(sec)) out = out.split(sec).join(MASK);
    if (out.length < 4096 && /[?&](access_token|api[-_]?key|token|client_secret|password)=/i.test(out)) {
      out = out.replace(/([?&](?:access_token|api[-_]?key|token|client_secret|password)=)[^&\s#]+/gi, `$1${MASK}`);
    }
    return out;
  };
  const walk = (v: unknown, depth: number): Json => {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return str(v);
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "boolean") return v;
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function" || typeof v === "symbol") return null;
    if (depth > 60) return "[too deep]";
    if (Buffer.isBuffer(v)) return `[binary ${v.length} bytes]`;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) {
      // keyvalue pairs: [{ key: "Authorization", value: "..." }]
      return v.map((x) => {
        if (x && typeof x === "object" && typeof (x as { key?: unknown }).key === "string" && "value" in (x as object) && isSensitiveKey((x as { key: string }).key)) {
          return { ...(walk(x, depth + 1) as object), value: MASK } as Json;
        }
        return walk(x, depth + 1);
      });
    }
    const out: { [k: string]: Json } = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined || typeof val === "function") continue;
      out[k] = isSensitiveKey(k) && val !== null && val !== "" && typeof val !== "boolean" ? MASK : walk(val, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

export const TRACE_LIMIT = 64 * 1024;

function shrink(v: Json, maxItems: number, maxStr: number): Json {
  if (typeof v === "string") return v.length > maxStr ? v.slice(0, maxStr) + `… [${v.length - maxStr} more characters]` : v;
  if (Array.isArray(v)) {
    const head = v.slice(0, maxItems).map((x) => shrink(x, maxItems, maxStr));
    if (v.length > maxItems) head.push(`… [${v.length - maxItems} more items]`);
    return head;
  }
  if (v && typeof v === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v)) out[k] = shrink(x, maxItems, maxStr);
    return out;
  }
  return v;
}
/** Keeps a trace value under ~64 KB by shortening long arrays and strings, keeping the shape readable. */
export function truncate(v: Json, limit = TRACE_LIMIT): { value: Json; truncated: boolean } {
  let s: string;
  try { s = JSON.stringify(v) ?? "null"; } catch { return { value: "[unserialisable]", truncated: true }; }
  if (s.length <= limit) return { value: v, truncated: false };
  for (const [items, strLen] of [[50, 4000], [20, 1000], [5, 300], [2, 120]] as const) {
    const t = shrink(v, items, strLen);
    if (JSON.stringify(t).length <= limit) return { value: t, truncated: true };
  }
  return { value: s.slice(0, limit) + `… [${s.length - limit} more characters]`, truncated: true };
}
