// Traffic figures from the Prometheus that scrapes the services (read-only instant and range queries).
export interface Metrics {
  total: number; errors: number; p50Ms: number; p95Ms: number;
  series: { at: string; total: number; errors: number }[];
  available: boolean; reason?: string;
}

const BUSINESS = 'src_service_resource="true",src_object_name!="/health",src_module!~"ballerinax/prometheus.*"';

async function call(base: string, path: string, params: Record<string, string>): Promise<any> {
  const u = new URL(base.replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Metrics store answered ${r.status}`);
  const j = (await r.json()) as { status: string; data?: any; error?: string };
  if (j.status !== "success") throw new Error(j.error || "Metrics query failed");
  return j.data;
}
const scalar = (data: any): number => {
  const v = data?.result?.[0]?.value?.[1];
  const n = v === undefined ? 0 : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const sel = (api: string, extra = "") => `{app_kubernetes_io_name="${api.replace(/["\\]/g, "")}",${BUSINESS}${extra}}`;

export interface RangeSeries { metric?: Record<string, string>; values?: [number, string][] }
const isError = (m: Record<string, string> | undefined) => /^(4|5)xx$/.test(m?.http_status_code_group ?? "");

/**
 * Exact counts per time bucket from raw counter samples. Each counter is followed on its own: a counter
 * that first appears inside the window counts in full, and one that restarts counts from zero again.
 * Nothing is extrapolated, so the figures are whole requests and the buckets add up to the total.
 */
export function increments(result: RangeSeries[], start: number, end: number, step: number, pick: (m: Record<string, string> | undefined) => boolean = () => true): number[] {
  const n = Math.max(0, Math.floor((end - start) / step));
  const out = new Array<number>(n).fill(0);
  for (const s of result) {
    if (!pick(s.metric)) continue;
    const at = new Map<number, number>((s.values || []).map(([t, v]) => [Math.round(t), Number(v) || 0]));
    let prev = at.get(start);
    for (let i = 0; i < n; i++) {
      const cur = at.get(start + step * (i + 1));
      if (cur === undefined) continue;
      out[i] += prev === undefined || cur < prev ? cur : cur - prev;
      prev = cur;
    }
  }
  return out.map((v) => Math.round(v));
}

export function stepFor(hours: number): number {
  return hours <= 1 ? 60 : hours <= 6 ? 300 : hours <= 24 ? 900 : 3600;
}

export async function apiMetrics(base: string | undefined, api: string, hours: number): Promise<Metrics> {
  const empty: Metrics = { total: 0, errors: 0, p50Ms: 0, p95Ms: 0, series: [], available: false };
  if (!base) return { ...empty, reason: "No metrics store is configured" };
  const h = Math.min(Math.max(hours || 1, 0.25), 24 * 14);
  const range = `${Math.round(h * 60)}m`;
  const step = stepFor(h);
  const end = Math.floor(Date.now() / 1000 / step) * step;
  const start = end - Math.round(h * 3600);
  try {
    const up = await call(base, "/api/v1/query", { query: `max(up{app_kubernetes_io_name="${api}"})` });
    if (!up.result?.length) return { ...empty, reason: "This service is not scraped by the metrics store" };
    const [p50, p95, mean, raw] = await Promise.all([
      call(base, "/api/v1/query", { query: `avg(avg_over_time((response_time_seconds${sel(api, ',quantile="0.5"')} > 0)[${range}:1m]))` }),
      call(base, "/api/v1/query", { query: `max(avg_over_time((response_time_seconds${sel(api, ',quantile="0.95"')} > 0)[${range}:1m]))` }),
      call(base, "/api/v1/query", { query: `sum(increase(response_time_nanoseconds_total_value${sel(api)}[${range}])) / sum(increase(requests_total_value${sel(api)}[${range}]))` }),
      call(base, "/api/v1/query_range", { query: `requests_total_value${sel(api)}`, start: String(start), end: String(end), step: String(step) }),
    ]);
    const counters = (raw.result || []) as RangeSeries[];
    const all = increments(counters, start, end, step);
    const bad = increments(counters, start, end, step, isError);
    const series: Metrics["series"] = all.map((total, i) => ({ at: new Date((start + step * (i + 1)) * 1000).toISOString(), total, errors: Math.min(total, bad[i] || 0) }));
    const meanMs = scalar(mean) / 1e6;
    const p50Ms = scalar(p50) * 1000 || meanMs;
    const p95Ms = scalar(p95) * 1000 || meanMs;
    const isUp = scalar(up) >= 1;
    const sum = series.reduce((n, p) => n + p.total, 0);
    if (!isUp && sum === 0 && !series.some((p) => p.total > 0)) {
      return { ...empty, series, reason: "The metrics store cannot reach the metrics endpoint of this service, so no traffic figures are recorded for it" };
    }
    return {
      total: sum, errors: series.reduce((n, p) => n + p.errors, 0), p50Ms: Math.round(p50Ms * 10) / 10, p95Ms: Math.round(Math.max(p95Ms, p50Ms) * 10) / 10, series,
      available: true, reason: isUp ? undefined : "The metrics endpoint of this service is not answering right now; figures may be incomplete",
    };
  } catch (e) {
    return { ...empty, reason: e instanceof Error ? e.message : "Metrics are not available" };
  }
}

/** Requests and errors per service over the last hour, for the landscape list. */
export async function hourTotals(base: string | undefined): Promise<Map<string, { total: number; errors: number; scraped: boolean }>> {
  const out = new Map<string, { total: number; errors: number; scraped: boolean }>();
  if (!base) return out;
  try {
    const end = Math.floor(Date.now() / 1000 / 60) * 60;
    const start = end - 3600;
    const [up, raw] = await Promise.all([
      call(base, "/api/v1/query", { query: "max by (app_kubernetes_io_name) (up)" }),
      call(base, "/api/v1/query_range", { query: `requests_total_value{${BUSINESS}}`, start: String(start), end: String(end), step: "60" }),
    ]);
    const at = (n: string) => out.get(n) || out.set(n, { total: 0, errors: 0, scraped: false }).get(n)!;
    for (const r of up.result || []) if (r.metric?.app_kubernetes_io_name) at(r.metric.app_kubernetes_io_name).scraped = Number(r.value?.[1]) >= 1;
    const byApi = new Map<string, RangeSeries[]>();
    for (const r of (raw.result || []) as RangeSeries[]) {
      const n = r.metric?.app_kubernetes_io_name;
      if (n) byApi.set(n, [...(byApi.get(n) || []), r]);
    }
    for (const [n, list] of byApi) {
      const total = increments(list, start, end, 60).reduce((a, b) => a + b, 0);
      at(n).total = total;
      at(n).errors = Math.min(total, increments(list, start, end, 60, isError).reduce((a, b) => a + b, 0));
    }
  } catch { /* the list still renders without traffic figures */ }
  return out;
}
