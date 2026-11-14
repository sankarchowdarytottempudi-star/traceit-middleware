export const UNLIMITED = 2147483647;

/** WSO2 unlimited marker or a K-suffixed count. */
export function formatQuota(limit: number): string {
  if (limit >= UNLIMITED || limit < 0) return "Unlimited";
  if (limit >= 1000) {
    const k = limit / 1000;
    return (Number.isInteger(k) ? k.toString() : k.toFixed(1)) + "K";
  }
  return String(limit);
}

/** Log-scale width (0..100) so tiny and huge quotas both read on one bar. */
export function logBarWidth(value: number, max = UNLIMITED): number {
  if (value <= 0) return 0;
  if (value >= max) return 100;
  const w = (Math.log10(value) / Math.log10(max)) * 100;
  return Math.max(2, Math.min(100, Math.round(w)));
}

export function isLocalhost(host?: string): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1" || h === "localhost" || h === "127.0.0.1") return true;
  const base = h.split(":")[0];
  return base === "localhost" || base === "127.0.0.1";
}

export interface ApiFinding { name: string; errors: number; warnings: number; info?: number; }
export function rankApis<T extends ApiFinding>(apis: T[]): T[] {
  return [...apis].sort((a, b) => (b.errors - a.errors) || (b.warnings - a.warnings) || a.name.localeCompare(b.name));
}
export function severityTotals(apis: ApiFinding[]) {
  return apis.reduce((t, a) => ({ errors: t.errors + a.errors, warnings: t.warnings + a.warnings, info: t.info + (a.info ?? 0) }),
    { errors: 0, warnings: 0, info: 0 });
}

/** "In plain words" preview for a rate-limit policy. */
export function plainWords(limit: number, timeUnit: string): string {
  if (limit >= UNLIMITED) return "No limit; all requests pass.";
  return `Up to ${limit.toLocaleString()} requests every ${timeUnit}, then callers get HTTP 429.`;
}
