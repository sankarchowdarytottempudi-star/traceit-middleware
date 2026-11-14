import { describe, it, expect } from "vitest";
import { avgMs, counterIncreases, gaugeBuckets, makeGrid, mergeInstant, rate, sumBy, total, watchFrom, type PromSeries } from "../src/prom.js";
import { createAnalytics } from "../src/analytics.js";
import type { Prom, PromSample } from "../src/prom.js";
import type { Runtime } from "../src/runtime.js";

const s = (metric: Record<string, string>, values: [number, number][]): PromSeries => ({ metric, values: values.map(([t, v]) => [t, String(v)]) });

describe("makeGrid", () => {
  it("aligns to the step and adds 'now' as a final partial point", () => {
    const g = makeGrid("1h", 1_000_000_030_000); // 30 s past a minute boundary
    expect(g.step).toBe(60);
    expect(g.to).toBe(1_000_000_030);
    expect(g.alignedTo % 60).toBe(0);
    expect(g.points[g.points.length - 1]).toBe(g.to);
    expect(g.points.length - 1).toBe(60);               // 60 buckets
    expect(g.points[1] - g.points[0]).toBe(60);
  });
  it("has no partial point when now is on the grid", () => {
    const g = makeGrid("15m", 1_000_000_020_000);
    expect(g.to).toBe(g.alignedTo);
    expect(g.points.length - 1).toBe(30);
    expect(g.from).toBe(g.to - 900);
  });
  it("covers 7 days in hourly buckets", () => {
    const g = makeGrid("7d", Date.UTC(2026, 10, 14, 20, 30, 0));
    expect(g.points.length - 1).toBe(168);
  });
});

describe("counterIncreases", () => {
  const pts = [100, 160, 220, 280, 340];
  it("computes plain increases against the first sample as baseline", () => {
    const [r] = counterIncreases([s({ instance: "a" }, [[100, 10], [160, 12], [220, 12], [280, 20], [340, 21]])], pts);
    expect(r.inc).toEqual([2, 0, 8, 1]);
  });
  it("treats a drop as a counter reset (pod restart)", () => {
    const [r] = counterIncreases([s({ instance: "a" }, [[100, 50], [160, 55], [220, 3], [280, 4]])], pts);
    expect(r.inc).toEqual([5, 3, 1, 0]);
  });
  it("counts a series born inside the window from zero when the target was being watched", () => {
    const up = watchFrom([s({ instance: "a" }, [[100, 1], [160, 1], [220, 1], [280, 1], [340, 1]])]);
    const [r] = counterIncreases([s({ instance: "a" }, [[220, 3], [280, 3], [340, 5]])], pts, up);
    expect(r.inc).toEqual([0, 3, 0, 2]);
  });
  it("counts a new replica from zero (no `up` sample for it yet, but the job was watched)", () => {
    const up = watchFrom([s({ instance: "old" }, [[100, 1], [160, 1], [220, 1]])]);
    const [r] = counterIncreases([s({ instance: "new" }, [[220, 4], [280, 6]])], pts, up);
    expect(r.inc).toEqual([0, 4, 2, 0]);
  });
  it("uses the first value only as a baseline when the target was failing or nothing was watched", () => {
    const failing = watchFrom([s({ instance: "a" }, [[100, 0], [160, 0], [220, 1]])]);
    expect(counterIncreases([s({ instance: "a" }, [[220, 900], [280, 905]])], pts, failing)[0].inc).toEqual([0, 0, 5, 0]);
    const blind = watchFrom([]);
    expect(counterIncreases([s({ instance: "a" }, [[220, 900], [280, 905]])], pts, blind)[0].inc).toEqual([0, 0, 5, 0]);
  });
  it("does not double count after a gap in the samples", () => {
    const [r] = counterIncreases([s({ instance: "a" }, [[100, 10], [160, 12], [340, 15]])], pts);
    expect(r.inc).toEqual([2, 0, 0, 3]);
  });
  it("ignores non-numeric samples", () => {
    const r = counterIncreases([{ metric: {}, values: [[100, "NaN"], [160, "4"], [220, "6"]] }], pts, watchFrom([]));
    expect(r[0].inc).toEqual([0, 2, 0, 0]);
  });
});

describe("sumBy / gaugeBuckets / helpers", () => {
  it("groups increases and skips series whose key is null", () => {
    const incs = [{ metric: { app: "a", g: "2xx" }, inc: [1, 2] }, { metric: { app: "a", g: "5xx" }, inc: [0, 1] }, { metric: { app: "b", g: "2xx" }, inc: [5, 5] }];
    const by = sumBy(incs, 2, (m) => m.app);
    expect(by.get("a")).toEqual([1, 3]); expect(by.get("b")).toEqual([5, 5]);
    expect(sumBy(incs, 2, (m) => (m.g === "5xx" ? m.app : null)).get("a")).toEqual([0, 1]);
    expect(total(by.get("a"))).toBe(4); expect(total(undefined)).toBe(0);
  });
  it("lays gauges onto buckets, keeps the larger value and treats 0 as 'no traffic'", () => {
    const pts = [100, 160, 220];
    const by = gaugeBuckets([s({ q: "0.95" }, [[160, 0.2], [220, 0]]), s({ q: "0.95" }, [[160, 0.5]])], pts, (m) => m.q);
    expect(by.get("0.95")).toEqual([0.5, null]);
  });
  it("averages and rates", () => {
    expect(avgMs(3e9, 2)).toBe(1500); expect(avgMs(1, 0)).toBeNull();
    expect(rate(1, 8)).toBe(12.5); expect(rate(0, 0)).toBe(0);
  });
  it("merges the instant sample at 'now' into the range series and drops __name__", () => {
    const merged = mergeInstant([s({ __name__: "x", instance: "a" }, [[100, 1]])], [{ metric: { __name__: "x", instance: "a" }, value: [130, "2"] }, { metric: { instance: "b" }, value: [130, "7"] }], 130);
    expect(merged).toHaveLength(2);
    expect(merged.find((m) => m.metric.instance === "a")!.values).toEqual([[100, "1"], [130, "2"]]);
    expect(merged[0].metric.__name__).toBeUndefined();
  });
});

describe("analytics overview (fake Prometheus)", () => {
  const NOW = 1_000_000_020_000; // on the 60 s grid
  const runtime: Runtime = { configured: true, flows: async () => ({ ok: false, detail: "connection refused" }), stats: async () => ({ ok: false, detail: "connection refused" }), flowLogs: async () => ({ ok: false, detail: "x" }) };
  function fake(): Prom {
    const g = makeGrid("1h", NOW); const t = g.points;
    const range = async (q: string): Promise<PromSeries[]> => {
      if (q.startsWith("up{")) return [s({ app_kubernetes_io_name: "orders", instance: "i1" }, t.map((x) => [x, 1])), s({ app_kubernetes_io_name: "silent", instance: "i2" }, t.map((x) => [x, 0]))];
      if (q.startsWith("requests_total_value")) return [
        s({ app_kubernetes_io_name: "orders", instance: "i1", http_status_code_group: "2xx", http_method: "GET", http_url: "/orders" }, t.map((x, i) => [x, 100 + i])),          // +1 per minute = 60
        s({ app_kubernetes_io_name: "orders", instance: "i1", http_status_code_group: "5xx", http_method: "GET", http_url: "/orders" }, [[t[58], 4], [t[59], 4], [t[60], 6]]),     // born: 4, then +2 = 6
      ];
      if (q.startsWith("response_time_nanoseconds_total_value")) return [
        s({ app_kubernetes_io_name: "orders", instance: "i1", http_status_code_group: "2xx", http_method: "GET", http_url: "/orders" }, t.map((x, i) => [x, i * 2e8])),            // 200 ms each
      ];
      if (q.includes("max_over_time")) return [s({ app_kubernetes_io_name: "orders" }, [[t[60], 0.4]])];
      return [];
    };
    const instant = async (q: string): Promise<PromSample[]> => (q.includes("avg_over_time") ? [
      { metric: { app_kubernetes_io_name: "orders", quantile: "0.5" }, value: [0, "0.18"] },
      { metric: { app_kubernetes_io_name: "orders", quantile: "0.95" }, value: [0, "0.4"] },
    ] : []);
    return { range, instant };
  }
  it("adds up requests and errors, flags services without metrics and survives a missing runtime", async () => {
    const a = createAnalytics({ prom: fake(), runtime, job: "apis", knownServices: async () => ["orders", "silent", "unscraped"], now: () => NOW });
    const o = await a.overview("1h");
    expect(o.sources.prometheus.ok).toBe(true);
    expect(o.sources.runtime).toEqual({ ok: false, configured: true, detail: "connection refused" });
    expect(o.series).toHaveLength(60);
    expect(o.totals.requests).toBe(66); expect(o.totals.errors).toBe(6);
    expect(o.totals.errorRate).toBeCloseTo(9.09, 2);
    const row = o.apis.find((r) => r.name === "orders")!;
    expect(row.requests).toBe(66); expect(row.p95Ms).toBe(400); expect(row.p50Ms).toBe(180); expect(row.p99Ms).toBeNull();
    expect(row.spark.reduce((x, y) => x + y, 0)).toBe(66);
    expect(o.series[59].p95Ms).toBe(400);
    expect(o.notExporting).toEqual(["silent", "unscraped"]);
    const d = await a.detail("orders", "1h");
    expect(d.totals.requests).toBe(66);
    expect(d.byStatus).toEqual([{ group: "2xx", requests: 60 }, { group: "5xx", requests: 6 }]);
    expect(d.operations[0]).toMatchObject({ method: "GET", path: "/orders", requests: 66, errors: 6 });
    expect(d.series.reduce((x, p) => x + p.s5xx, 0)).toBe(6);
  });
  it("reports an honest empty state when Prometheus cannot be reached", async () => {
    const down: Prom = { range: async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:9090"); }, instant: async () => { throw new Error("connect ECONNREFUSED"); } };
    const a = createAnalytics({ prom: down, runtime, job: "apis", knownServices: async () => ["orders"], now: () => NOW });
    const o = await a.overview("15m");
    expect(o.sources.prometheus).toEqual({ ok: false, configured: true, detail: "connection refused" });
    expect(o.totals.requests).toBe(0); expect(o.apis).toEqual([]); expect(o.notExporting).toEqual(["orders"]);
    const none = createAnalytics({ prom: null, runtime, job: "apis", knownServices: async () => [], now: () => NOW });
    expect((await none.overview("1h")).sources.prometheus).toEqual({ ok: false, configured: false, detail: "not configured" });
  });
});
