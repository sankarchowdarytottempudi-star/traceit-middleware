// Tier-1 analytics: what the services themselves report (Prometheus) plus the Weave runtime's
// flow statistics. Needs no change on the gateway. Pure reshaping lives in prom.ts.
import {
  avgMs, counterIncreases, fetchOnGrid, gaugeBuckets, makeGrid, rate, round, sumBy, total, watchFrom,
  RANGES, type Grid, type Prom, type PromSample, type RangeKey,
} from "./prom.js";
import { reason } from "./http.js";
import type { Runtime, RtStats } from "./runtime.js";

export interface SourceState { ok: boolean; configured: boolean; detail?: string; }
export interface Totals {
  requests: number; errors: number; errorRate: number;
  avgMs: number | null; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null;
}
export interface OverviewPoint { t: number; end: number; requests: number; errors: number; avgMs: number | null; p95Ms: number | null; }
export interface ApiRow extends Totals {
  name: string; kind: "service" | "flow"; id?: string;
  exportsMetrics: boolean; spark: number[]; lastAt?: string; windowNote?: string;
}
export interface Overview {
  range: RangeKey; from: number; to: number; stepSeconds: number; generatedAt: string;
  sources: { prometheus: SourceState; runtime: SourceState };
  totals: Totals; series: OverviewPoint[]; apis: ApiRow[];
  /** Services that exist but do not publish metrics (so they cannot appear in the numbers above). */
  notExporting: string[];
  /** Flow runs counted by the runtime in its window (at least one hour) that belong to no flow that still exists. */
  removedFlowRuns: number;
}
export interface DetailPoint extends OverviewPoint { s2xx: number; s3xx: number; s4xx: number; s5xx: number; p50Ms: number | null; p99Ms: number | null; }
export interface OperationRow { method: string; path: string; requests: number; errors: number; errorRate: number; avgMs: number | null; p95Ms: number | null; }
export interface ApiDetail {
  name: string; kind: "service" | "flow"; id?: string; exportsMetrics: boolean;
  range: RangeKey; from: number; to: number; stepSeconds: number; generatedAt: string;
  source: SourceState; totals: Totals; series: DetailPoint[];
  byStatus: { group: string; requests: number }[];
  operations: OperationRow[];
  /** Service-reported latency percentiles (typical value over the range, slowest operation). */
  latency: { quantile: string; label: string; ms: number }[];
  downstream: { peer: string; requests: number; errors: number; avgMs: number | null }[];
  replicas: number;
  windowNote?: string;
}

const APP = "app_kubernetes_io_name";
const QLABEL: Record<string, string> = { "0.33": "p33", "0.5": "p50", "0.66": "p66", "0.75": "p75", "0.95": "p95", "0.99": "p99", "0.999": "p99.9" };
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const ms = (seconds: number | undefined | null) => (seconds && seconds > 0 ? round(seconds * 1000, 2) : null);
const isErr = (m: Record<string, string>) => /^[45]/.test(m.http_status_code_group ?? "");

export interface AnalyticsDeps {
  prom: Prom | null; runtime: Runtime; job: string;
  /** Names of every known service (from Kubernetes), to report the ones without metrics. */
  knownServices: () => Promise<string[]>;
  now?: () => number;
}

export function createAnalytics(d: AnalyticsDeps) {
  const now = d.now ?? Date.now;
  // Inbound business requests only: no health probes, no metrics scrapes.
  const inbound = (extra = "") => `job="${esc(d.job)}",src_service_resource="true",entrypoint_service_name!~"/health|ballerinax_prometheus_svc_.*"${extra}`;
  const quantWindow = (g: Grid) => (RANGES[g.range].seconds <= 3600 ? { tw: "60000", res: 60 } : { tw: "300000", res: 300 });
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  function cached<T>(key: string, ttlMs: number, make: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = make();
    cache.set(key, { at: now(), value });
    value.catch(() => cache.delete(key));
    if (cache.size > 200) for (const [k, v] of cache) if (now() - v.at > 60_000) cache.delete(k);
    return value;
  }

  function flowBuckets(stats: RtStats | null, g: Grid) {
    const n = g.points.length - 1;
    const requests = new Array<number>(n).fill(0); const errors = new Array<number>(n).fill(0);
    for (const p of stats?.series ?? []) {
      const t = Date.parse(p.at) / 1000;
      if (!Number.isFinite(t) || t < g.points[0] || t > g.points[n]) continue;
      let i = n - 1;
      for (let k = 0; k < n; k++) if (t < g.points[k + 1]) { i = k; break; }
      requests[i] += Number(p.total) || 0; errors[i] += Number(p.errors) || 0;
    }
    return { requests, errors };
  }
  const weighted = (rows: { requests: number; v: number | null }[]) => {
    let w = 0; let s = 0;
    for (const r of rows) if (r.v !== null && r.requests > 0) { w += r.requests; s += r.v * r.requests; }
    return w > 0 ? round(s / w, 2) : null;
  };
  const quantMap = (samples: PromSample[], by: string) => {
    const out = new Map<string, Record<string, number>>();
    for (const s of samples) {
      const k = s.metric[by] ?? ""; const q = s.metric.quantile ?? ""; const v = Number(s.value[1]);
      if (!Number.isFinite(v) || v <= 0) continue;
      const rec = out.get(k) ?? {}; rec[q] = v; out.set(k, rec);
    }
    return out;
  };

  async function overviewRaw(range: RangeKey): Promise<Overview> {
    const g = makeGrid(range, now()); const n = g.points.length - 1;
    const hours = RANGES[range].seconds / 3600;
    const prometheus: SourceState = { ok: false, configured: !!d.prom };
    const rows: ApiRow[] = []; const notExporting: string[] = [];
    const reqAll = new Array<number>(n).fill(0); const errAll = new Array<number>(n).fill(0); const nsAll = new Array<number>(n).fill(0);
    let p95All: (number | null)[] = new Array<number | null>(n).fill(null);

    const [rt, known] = await Promise.all([d.runtime.stats(hours), d.knownServices().catch(() => [] as string[])]);
    const runtime: SourceState = { ok: rt.ok, configured: d.runtime.configured, ...(rt.ok ? {} : { detail: rt.detail }) };
    const exporting = new Set<string>();

    if (d.prom) {
      try {
        const { tw, res } = quantWindow(g);
        const sel = inbound();
        const [up, req, ns, qSeries, qHead] = await Promise.all([
          fetchOnGrid(d.prom, `up{job="${esc(d.job)}"}`, g),
          fetchOnGrid(d.prom, `requests_total_value{${sel}}`, g),
          fetchOnGrid(d.prom, `response_time_nanoseconds_total_value{${sel}}`, g),
          fetchOnGrid(d.prom, `max by (${APP}) (max_over_time(response_time_seconds{${sel},timeWindow="${tw}",quantile="0.95"}[${g.step}s]))`, g),
          d.prom.instant(`max by (${APP}, quantile) (avg_over_time((response_time_seconds{${sel},timeWindow="${tw}",quantile=~"0.5|0.95|0.99"} > 0)[${RANGES[range].seconds}s:${res}s]))`, g.to),
        ]);
        prometheus.ok = true;
        const watch = watchFrom(up);
        for (const s of up) if (s.values.some(([, v]) => Number(v) === 1)) exporting.add(s.metric[APP] ?? "");
        const targets = new Set(up.map((s) => s.metric[APP] ?? "").filter(Boolean));
        const reqInc = counterIncreases(req, g.points, watch); const nsInc = counterIncreases(ns, g.points, watch);
        const byApp = (m: Record<string, string>) => m[APP] ?? null;
        const reqBy = sumBy(reqInc, n, byApp); const errBy = sumBy(reqInc, n, (m) => (isErr(m) ? m[APP] ?? null : null));
        const nsBy = sumBy(nsInc, n, byApp);
        const p95By = gaugeBuckets(qSeries, g.points, byApp);
        const head = quantMap(qHead, APP);
        const names = new Set<string>([...exporting, ...reqBy.keys()]); names.delete("");
        for (const name of [...names].sort()) {
          const r = reqBy.get(name) ?? new Array<number>(n).fill(0); const e = errBy.get(name) ?? []; const z = nsBy.get(name) ?? [];
          const requests = Math.round(total(r)); const errors = Math.round(total(e));
          for (let i = 0; i < n; i++) { reqAll[i] += r[i] ?? 0; errAll[i] += e[i] ?? 0; nsAll[i] += z[i] ?? 0; }
          const p = p95By.get(name);
          if (p) p95All = p95All.map((v, i) => (p[i] === null ? v : Math.max(v ?? 0, p[i] as number)));
          const h = head.get(name) ?? {};
          rows.push({ name, kind: "service", exportsMetrics: true, requests, errors, errorRate: rate(errors, requests),
            avgMs: avgMs(total(z), total(r)), p50Ms: ms(h["0.5"]), p95Ms: ms(h["0.95"]), p99Ms: ms(h["0.99"]), spark: r.map((v) => Math.round(v)) });
        }
        for (const name of new Set([...targets, ...known])) if (name && !exporting.has(name)) notExporting.push(name);
      } catch (e) { prometheus.ok = false; prometheus.detail = reason(e); }
    } else prometheus.detail = "not configured";
    if (!prometheus.ok) for (const name of known) notExporting.push(name);

    const fb = flowBuckets(rt.ok ? rt.data : null, g);
    // The runtime's timeline counts every run, also those of flows deleted since; its per-flow list cannot.
    const removedFlowRuns = rt.ok ? Math.max(0, Math.round(rt.data.series.reduce((x, p) => x + (Number(p.total) || 0), 0) - rt.data.flows.reduce((x, f) => x + (Number(f.total) || 0), 0))) : 0;
    if (rt.ok) {
      for (const f of rt.data.flows) {
        if (!f.deployed && !f.total) continue;
        rows.push({ name: f.name || f.slug, kind: "flow", id: f.flowId, exportsMetrics: true, requests: f.total, errors: f.errors,
          errorRate: rate(f.errors, f.total), avgMs: null, p50Ms: f.total ? f.p50Ms : null, p95Ms: f.total ? f.p95Ms : null, p99Ms: null,
          spark: [], ...(f.lastAt ? { lastAt: f.lastAt } : {}), ...(hours < 1 ? { windowNote: "last hour" } : {}) });
      }
    }
    const series: OverviewPoint[] = [];
    for (let i = 0; i < n; i++) {
      series.push({ t: g.points[i] * 1000, end: g.points[i + 1] * 1000, requests: Math.round(reqAll[i] + fb.requests[i]),
        errors: Math.round(errAll[i] + fb.errors[i]), avgMs: avgMs(nsAll[i], reqAll[i]), p95Ms: ms(p95All[i]) });
    }
    const requests = series.reduce((a, p) => a + p.requests, 0); const errors = series.reduce((a, p) => a + p.errors, 0);
    const pick = (k: "p50Ms" | "p95Ms" | "p99Ms") => weighted(rows.map((r) => ({ requests: r.requests, v: r[k] })));
    rows.sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));
    return {
      range, from: g.from * 1000, to: g.to * 1000, stepSeconds: g.step, generatedAt: new Date(now()).toISOString(),
      sources: { prometheus, runtime },
      totals: { requests, errors, errorRate: rate(errors, requests), avgMs: avgMs(total(nsAll), total(reqAll)), p50Ms: pick("p50Ms"), p95Ms: pick("p95Ms"), p99Ms: pick("p99Ms") },
      series, apis: rows, notExporting: [...new Set(notExporting)].sort(), removedFlowRuns,
    };
  }

  async function flowDetail(name: string, range: RangeKey): Promise<ApiDetail | null> {
    const g = makeGrid(range, now()); const n = g.points.length - 1; const hours = RANGES[range].seconds / 3600;
    const rt = await d.runtime.stats(hours);
    if (!rt.ok) return null;
    const f = rt.data.flows.find((x) => x.flowId === name || x.name === name || x.slug === name);
    if (!f) return null;
    // The runtime reports one combined time series for all flows, so a single flow has totals only.
    return {
      name: f.name || f.slug, kind: "flow", id: f.flowId, exportsMetrics: true, range, from: g.from * 1000, to: g.to * 1000, stepSeconds: g.step,
      generatedAt: new Date(now()).toISOString(), source: { ok: true, configured: true },
      totals: { requests: f.total, errors: f.errors, errorRate: rate(f.errors, f.total), avgMs: null, p50Ms: f.total ? f.p50Ms : null, p95Ms: f.total ? f.p95Ms : null, p99Ms: null },
      series: Array.from({ length: n }, (_, i) => ({ t: g.points[i] * 1000, end: g.points[i + 1] * 1000, requests: 0, errors: 0, avgMs: null, p95Ms: null, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, p50Ms: null, p99Ms: null })),
      byStatus: f.total ? [{ group: "ok", requests: f.total - f.errors }, { group: "failed", requests: f.errors }].filter((x) => x.requests > 0) : [],
      operations: [], latency: f.total ? [{ quantile: "0.5", label: "p50", ms: f.p50Ms }, { quantile: "0.95", label: "p95", ms: f.p95Ms }] : [],
      downstream: [], replicas: 0, ...(hours < 1 ? { windowNote: "last hour" } : {}),
    };
  }

  async function detailRaw(name: string, range: RangeKey): Promise<ApiDetail> {
    const g = makeGrid(range, now()); const n = g.points.length - 1;
    const base = { name, range, from: g.from * 1000, to: g.to * 1000, stepSeconds: g.step, generatedAt: new Date(now()).toISOString() };
    const empty = (source: SourceState, exportsMetrics: boolean): ApiDetail => ({
      ...base, kind: "service", exportsMetrics, source,
      totals: { requests: 0, errors: 0, errorRate: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
      series: Array.from({ length: n }, (_, i) => ({ t: g.points[i] * 1000, end: g.points[i + 1] * 1000, requests: 0, errors: 0, avgMs: null, p95Ms: null, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, p50Ms: null, p99Ms: null })),
      byStatus: [], operations: [], latency: [], downstream: [], replicas: 0,
    });
    if (!d.prom) return (await flowDetail(name, range)) ?? empty({ ok: false, configured: false, detail: "not configured" }, false);
    try {
      const { tw, res } = quantWindow(g);
      const app = `,${APP}="${esc(name)}"`; const sel = inbound(app); const secs = RANGES[range].seconds;
      const out = `job="${esc(d.job)}",src_client_remote="true",src_object_name="ballerina/http/HttpClient"${app}`;
      const qsel = `response_time_seconds{${sel},timeWindow="${tw}"}`;
      const [up, req, ns, qSeries, qHead, qOps, oReq, oNs] = await Promise.all([
        fetchOnGrid(d.prom, `up{job="${esc(d.job)}"${app}}`, g),
        fetchOnGrid(d.prom, `requests_total_value{${sel}}`, g),
        fetchOnGrid(d.prom, `response_time_nanoseconds_total_value{${sel}}`, g),
        fetchOnGrid(d.prom, `max by (quantile) (max_over_time(response_time_seconds{${sel},timeWindow="${tw}",quantile=~"0.5|0.95|0.99"}[${g.step}s]))`, g),
        d.prom.instant(`max by (quantile) (avg_over_time((${qsel} > 0)[${secs}s:${res}s]))`, g.to),
        d.prom.instant(`max by (http_method, http_url) (avg_over_time((response_time_seconds{${sel},timeWindow="${tw}",quantile="0.95"} > 0)[${secs}s:${res}s]))`, g.to),
        fetchOnGrid(d.prom, `requests_total_value{${out}}`, g),
        fetchOnGrid(d.prom, `response_time_nanoseconds_total_value{${out}}`, g),
      ]);
      const exportsMetrics = up.some((s) => s.values.some(([, v]) => Number(v) === 1));
      if (!up.length && !req.length) {
        const flow = await flowDetail(name, range);
        if (flow) return flow;
      }
      const watch = watchFrom(up);
      const reqInc = counterIncreases(req, g.points, watch); const nsInc = counterIncreases(ns, g.points, watch);
      const one = () => "all";
      const r = sumBy(reqInc, n, one).get("all") ?? new Array<number>(n).fill(0);
      const z = sumBy(nsInc, n, one).get("all") ?? new Array<number>(n).fill(0);
      const byGroup = sumBy(reqInc, n, (m) => m.http_status_code_group ?? "other");
      const grp = (k: string, i: number) => Math.round(byGroup.get(k)?.[i] ?? 0);
      const quant = gaugeBuckets(qSeries, g.points, (m) => m.quantile ?? null);
      const series: DetailPoint[] = [];
      for (let i = 0; i < n; i++) {
        const s4 = grp("4xx", i); const s5 = grp("5xx", i);
        series.push({ t: g.points[i] * 1000, end: g.points[i + 1] * 1000, requests: Math.round(r[i]), errors: s4 + s5, avgMs: avgMs(z[i], r[i]),
          s2xx: grp("2xx", i), s3xx: grp("3xx", i) + grp("1xx", i), s4xx: s4, s5xx: s5,
          p50Ms: ms(quant.get("0.5")?.[i]), p95Ms: ms(quant.get("0.95")?.[i]), p99Ms: ms(quant.get("0.99")?.[i]) });
      }
      const requests = Math.round(total(r));
      const errors = Math.round(total(byGroup.get("4xx")) + total(byGroup.get("5xx")));
      const head: Record<string, number> = {};
      for (const s of qHead) { const v = Number(s.value[1]); if (Number.isFinite(v) && v > 0) head[s.metric.quantile ?? ""] = v; }
      const opKey = (m: Record<string, string>) => `${m.http_method ?? ""} ${m.http_url ?? m.src_resource_path ?? ""}`;
      const opReq = sumBy(reqInc, n, opKey); const opErr = sumBy(reqInc, n, (m) => (isErr(m) ? opKey(m) : null)); const opNs = sumBy(nsInc, n, opKey);
      const opP95 = new Map<string, number>();
      for (const s of qOps) { const v = Number(s.value[1]); if (Number.isFinite(v) && v > 0) opP95.set(opKey(s.metric), v); }
      const operations: OperationRow[] = [...opReq.entries()].map(([k, v]) => {
        const sp = k.indexOf(" "); const rq = Math.round(total(v)); const er = Math.round(total(opErr.get(k)));
        return { method: k.slice(0, sp), path: k.slice(sp + 1), requests: rq, errors: er, errorRate: rate(er, rq), avgMs: avgMs(total(opNs.get(k)), total(v)), p95Ms: ms(opP95.get(k)) };
      }).sort((a, b) => b.requests - a.requests || a.path.localeCompare(b.path));
      const oInc = counterIncreases(oReq, g.points, watch); const oNsInc = counterIncreases(oNs, g.points, watch);
      const peer = (m: Record<string, string>) => m.peer_address ?? "unknown";
      const dReq = sumBy(oInc, n, peer); const dErr = sumBy(oInc, n, (m) => (isErr(m) ? peer(m) : null)); const dNs = sumBy(oNsInc, n, peer);
      const downstream = [...dReq.entries()].map(([k, v]) => ({ peer: k, requests: Math.round(total(v)), errors: Math.round(total(dErr.get(k))), avgMs: avgMs(total(dNs.get(k)), total(v)) }))
        .filter((x) => x.requests > 0).sort((a, b) => b.requests - a.requests);
      return {
        ...base, kind: "service", exportsMetrics, source: { ok: true, configured: true },
        totals: { requests, errors, errorRate: rate(errors, requests), avgMs: avgMs(total(z), total(r)), p50Ms: ms(head["0.5"]), p95Ms: ms(head["0.95"]), p99Ms: ms(head["0.99"]) },
        series,
        byStatus: [...byGroup.entries()].map(([group, v]) => ({ group, requests: Math.round(total(v)) })).filter((x) => x.requests > 0).sort((a, b) => a.group.localeCompare(b.group)),
        operations,
        latency: Object.keys(QLABEL).filter((q) => head[q] !== undefined).map((q) => ({ quantile: q, label: QLABEL[q], ms: round(head[q] * 1000, 2) })),
        downstream,
        replicas: new Set(up.filter((s) => Number(s.values[s.values.length - 1]?.[1]) === 1).map((s) => s.metric.instance)).size,
      };
    } catch (e) {
      return empty({ ok: false, configured: true, detail: reason(e) }, false);
    }
  }

  /** Last-hour numbers per service name, for the API inventory. */
  async function lastHour(): Promise<{ ok: boolean; detail?: string; byName: Map<string, ApiRow>; flowsById: Map<string, ApiRow>; notExporting: Set<string> }> {
    const o = await overview("1h");
    const byName = new Map<string, ApiRow>(); const flowsById = new Map<string, ApiRow>();
    for (const r of o.apis) { if (r.kind === "service") byName.set(r.name, r); else if (r.id) flowsById.set(r.id, r); }
    return { ok: o.sources.prometheus.ok, detail: o.sources.prometheus.detail, byName, flowsById, notExporting: new Set(o.notExporting) };
  }

  const overview = (range: RangeKey) => cached(`o:${range}`, 8000, () => overviewRaw(range));
  const detail = (name: string, range: RangeKey) => cached(`d:${name}:${range}`, 8000, () => detailRaw(name, range));
  return { overview, detail, lastHour };
}
export type Analytics = ReturnType<typeof createAnalytics>;
