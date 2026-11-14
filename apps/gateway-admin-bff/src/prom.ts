// Prometheus access + the pure maths that turns raw counter samples into per-bucket increases.
//
// Why not PromQL increase(): traffic here is sparse. A label combination often appears for the
// first time with a value of 3 and then never moves; increase() reports 0 for it, and it also
// extrapolates. We read the raw samples on an aligned grid and compute the increases ourselves:
//   - a counter that goes down was reset (pod restart): the new value is the increase;
//   - a series that first appears inside the window started from 0, provided Prometheus was
//     already watching that target (otherwise its first value is only a baseline).
import { httpJson } from "./http.js";

export interface PromSeries { metric: Record<string, string>; values: [number, string][]; }
export interface PromSample { metric: Record<string, string>; value: [number, string]; }

export interface Prom {
  range(query: string, start: number, end: number, step: number): Promise<PromSeries[]>;
  instant(query: string, time?: number): Promise<PromSample[]>;
}

export function createProm(url: string | undefined): Prom | null {
  const base = (url ?? "").replace(/\/+$/, "");
  if (!base) return null;
  const post = async (path: string, params: Record<string, string>) => {
    const j = await httpJson<any>(`${base}${path}`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(), timeoutMs: 15_000,
    });
    if (j?.status !== "success") throw new Error("request failed");
    return j.data?.result ?? [];
  };
  return {
    range: (query, start, end, step) => post("/api/v1/query_range", { query, start: String(start), end: String(end), step: String(step) }),
    instant: (query, time) => post("/api/v1/query", time ? { query, time: String(time) } : { query }),
  };
}

export type RangeKey = "15m" | "1h" | "6h" | "24h" | "7d";
export const RANGES: Record<RangeKey, { seconds: number; step: number; label: string }> = {
  "15m": { seconds: 900, step: 30, label: "Last 15 minutes" },
  "1h": { seconds: 3600, step: 60, label: "Last hour" },
  "6h": { seconds: 21600, step: 300, label: "Last 6 hours" },
  "24h": { seconds: 86400, step: 900, label: "Last 24 hours" },
  "7d": { seconds: 604800, step: 3600, label: "Last 7 days" },
};
export function isRange(v: unknown): v is RangeKey { return typeof v === "string" && v in RANGES; }

export interface Grid {
  range: RangeKey; step: number;
  /** Sample times in seconds, ascending. Aligned to the step, plus "now" as the last point when
   *  it is not on the grid. Bucket i covers (points[i], points[i+1]]. */
  points: number[];
  from: number; to: number; alignedTo: number;
}
export function makeGrid(range: RangeKey, nowMs: number): Grid {
  const { seconds, step } = RANGES[range];
  const now = Math.floor(nowMs / 1000);
  const alignedTo = Math.floor(now / step) * step;
  const from = alignedTo - seconds + (now > alignedTo ? step : 0);
  const points: number[] = [];
  for (let t = from; t <= alignedTo; t += step) points.push(t);
  if (now > alignedTo) points.push(now);
  return { range, step, points, from, to: now, alignedTo };
}

export const seriesKey = (m: Record<string, string>) => Object.keys(m).sort().map((k) => `${k}=${m[k]}`).join(",");

/** Range samples on the aligned grid plus one instant sample at "now", merged per series. */
export async function fetchOnGrid(prom: Prom, query: string, g: Grid): Promise<PromSeries[]> {
  const [range, last] = await Promise.all([
    prom.range(query, g.from, g.alignedTo, g.step),
    g.to > g.alignedTo ? prom.instant(query, g.to) : Promise.resolve([] as PromSample[]),
  ]);
  return mergeInstant(range, last, g.to);
}
function noName(m: Record<string, string>): Record<string, string> { const metric = { ...m }; delete metric.__name__; return metric; }
export function mergeInstant(range: PromSeries[], last: PromSample[], at: number): PromSeries[] {
  const by = new Map<string, PromSeries>();
  for (const s of range) { const metric = noName(s.metric); by.set(seriesKey(metric), { metric, values: [...s.values] }); }
  for (const s of last) {
    const metric = noName(s.metric);
    const k = seriesKey(metric);
    const cur = by.get(k) ?? { metric, values: [] };
    cur.values.push([at, s.value[1]]);
    by.set(k, cur);
  }
  return [...by.values()];
}

export interface Watch {
  /** Was Prometheus scraping this job at time t (any target of the job had an `up` sample)? */
  watching(t: number): boolean;
  /** `up` of an instance at t: 1, 0, or undefined when the target did not exist yet. */
  up(instance: string, t: number): number | undefined;
}
export function watchFrom(upSeries: PromSeries[]): Watch {
  const any = new Set<number>(); const per = new Map<string, Map<number, number>>();
  for (const s of upSeries) {
    const inst = s.metric.instance ?? "";
    const m = per.get(inst) ?? new Map<number, number>(); per.set(inst, m);
    for (const [t, v] of s.values) { const k = Math.round(t); any.add(k); m.set(k, Math.max(m.get(k) ?? 0, Number(v))); }
  }
  return { watching: (t) => any.has(Math.round(t)), up: (i, t) => per.get(i)?.get(Math.round(t)) };
}
const ALWAYS: Watch = { watching: () => true, up: () => 1 };

export interface Increases { metric: Record<string, string>; inc: number[]; }

/** Per-series increase in every bucket of the grid (inc.length === points.length - 1). */
export function counterIncreases(series: PromSeries[], points: number[], watch: Watch = ALWAYS): Increases[] {
  const n = Math.max(0, points.length - 1);
  return series.map((s) => {
    const at = new Map<number, number>();
    for (const [t, v] of s.values) { const x = Number(v); if (Number.isFinite(x)) at.set(Math.round(t), x); }
    const inc = new Array<number>(n).fill(0);
    let last: number | undefined;
    for (let i = 0; i < points.length; i++) {
      const v = at.get(points[i]);
      if (v === undefined) continue;
      if (i > 0) {
        if (last === undefined) {
          const prev = points[i - 1];
          // Born inside the window: counts from zero only if we were watching and the target was not failing.
          inc[i - 1] = watch.watching(prev) && watch.up(s.metric.instance ?? "", prev) !== 0 ? v : 0;
        } else inc[i - 1] = v >= last ? v - last : v;
      }
      last = v;
    }
    return { metric: s.metric, inc };
  });
}

/** Sums increases per group. Series for which key() returns null are left out. */
export function sumBy(incs: Increases[], n: number, key: (m: Record<string, string>) => string | null): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const s of incs) {
    const k = key(s.metric);
    if (k === null) continue;
    let acc = out.get(k);
    if (!acc) { acc = new Array<number>(n).fill(0); out.set(k, acc); }
    for (let i = 0; i < n; i++) acc[i] += s.inc[i] ?? 0;
  }
  return out;
}
export const total = (a: number[] | undefined) => (a ?? []).reduce((x, y) => x + y, 0);

/** Gauge samples (already aggregated by PromQL) laid onto the buckets: the value at points[i+1] describes bucket i. */
export function gaugeBuckets(series: PromSeries[], points: number[], key: (m: Record<string, string>) => string | null): Map<string, (number | null)[]> {
  const n = Math.max(0, points.length - 1);
  const idx = new Map<number, number>(); points.forEach((p, i) => idx.set(p, i));
  const out = new Map<string, (number | null)[]>();
  for (const s of series) {
    const k = key(s.metric);
    if (k === null) continue;
    let acc = out.get(k);
    if (!acc) { acc = new Array<number | null>(n).fill(null); out.set(k, acc); }
    for (const [t, v] of s.values) {
      const i = idx.get(Math.round(t)); const x = Number(v);
      if (i === undefined || i === 0 || !Number.isFinite(x) || x <= 0) continue;
      acc[i - 1] = Math.max(acc[i - 1] ?? 0, x);
    }
  }
  return out;
}

export const round = (v: number, digits = 1) => { const f = 10 ** digits; return Math.round(v * f) / f; };
/** Nanoseconds total / request count -> average milliseconds (null when there were no requests). */
export const avgMs = (ns: number, requests: number) => (requests > 0 ? round(ns / requests / 1e6, 2) : null);
export const rate = (errors: number, requests: number) => (requests > 0 ? round((errors / requests) * 100, 2) : 0);
