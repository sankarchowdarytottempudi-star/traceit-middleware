// Executions of the migrated services: reading their structured log lines, following one call
// across the layers, pairing it with the gateway's record, and reading only what is new.
import { describe, it, expect } from "vitest";
import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLogs, type LogLine } from "../src/estate/k8s";
import { GatewayLog, MigratedExecutions, buildExecutions, groupLines, parseFields, parseGatewayLine, parseTraceLine, type ApiInfo, type GatewayEvent, type TraceLine } from "../src/estate/executions";

const APIS: ApiInfo[] = [
  { name: "orders-exp-api", layer: "exp", published: true, context: "/orders/v1" },
  { name: "orders-proc-api", layer: "proc", published: false },
  { name: "stock-sys-api", layer: "sys", published: false },
  { name: "billing-exp-api", layer: "exp", published: true, context: "/billing/v1" },
];
const T0 = Date.parse("2026-03-01T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const fmt = (ms: number, level: string, message: string, rest: string) => `${iso(ms)} time=${iso(ms)} level=${level} module=acme/x message="${message}" ${rest}`;
const line = (api: string, raw: string, component?: string): TraceLine => parseTraceLine(parseLogs(raw)[0], api, component)!;
/** One call through three layers, starting at `at` and taking `took` ms in the experience service. */
function call(cid: string, at: number, took: number, status = 200): TraceLine[] {
  return [
    line("orders-exp-api", fmt(at, "INFO", "EXP request started", `correlationId="${cid}" operationName="CreateOrder" rootField="createOrder" clientChannel="web"`)),
    line("orders-exp-api", fmt(at + 2, "INFO", "Requesting process API", `correlationId="${cid}" targetApi="/orders-proc-api"`)),
    line("stock-sys-api", fmt(at + 5, "INFO", "Requesting backend", `correlationId="${cid}" operation="reserve"`)),
    line("stock-sys-api", fmt(at + took - 4, "INFO", "Backend response received", `correlationId="${cid}" status=200 attempt=1`)),
    line("orders-exp-api", fmt(at + took, status >= 500 ? "ERROR" : "INFO", "EXP request completed", `correlationId="${cid}" operationName="CreateOrder" status=${status}`)),
  ];
}
const gw = (at: number, over: Partial<GatewayEvent> = {}): GatewayEvent => ({
  ms: at, at: iso(at), kind: "response", apiName: "orders-exp-api", context: "/orders/v1", method: "POST", resource: "/orders", status: 200, targetStatus: 200,
  responseLatency: 120, backendLatency: 118, application: "shop-app", keyType: "PRODUCTION", correlationId: `g-${at}-${Math.random()}`, ...over,
});

describe("structured log lines", () => {
  it("reads key=value pairs, quoted values, numbers and booleans", () => {
    expect(parseFields('time=2026-03-01T10:00:00.000Z level=INFO message="Cache \\"hit\\" for key" status=200 session=true elapsed=1.5 channel=web empty=""'))
      .toEqual({ time: "2026-03-01T10:00:00.000Z", level: "INFO", message: 'Cache "hit" for key', status: 200, session: true, elapsed: 1.5, channel: "web", empty: "" });
    expect(parseFields("error: no matching service found for path: /favicon.ico")).toBeNull();
  });
  it("reads a JSON line and keeps nested values as text", () => {
    expect(parseFields('{"time":"2026-03-01T10:00:00Z", "level":"INFO", "message":"Job finished", "durationMs":1500, "detail":{"n":2}, "gone":null}'))
      .toEqual({ time: "2026-03-01T10:00:00Z", level: "INFO", message: "Job finished", durationMs: 1500, detail: '{"n":2}' });
  });
  it("takes a line with a correlation id, in the service's own time, without the bookkeeping fields", () => {
    const [l] = parseLogs(`2026-03-01T10:00:00.250000000Z time=2026-03-01T10:00:00.123Z level=WARN module=acme/x message="Retrying process API call" correlationId="c-1" attempt=2 errorType="TIMEOUT"`);
    expect(parseTraceLine(l, "orders-exp-api")).toEqual({ ms: T0 + 123, api: "orders-exp-api", component: undefined, level: "warn", message: "Retrying process API call", fields: { attempt: 2, errorType: "TIMEOUT" }, correlationId: "c-1" });
    expect(parseTraceLine(parseLogs("2026-03-01T10:00:00Z orders-exp-api starting basePath=/x")[0], "orders-exp-api")).toBeNull();
  });
  it("never shows a credential that slipped into a line", () => {
    const l = line("orders-exp-api", fmt(T0, "INFO", "Calling backend", 'correlationId="c-2" authorization="Bearer abcdefghijklmnop" password=hunter22'));
    expect(JSON.stringify(l)).not.toMatch(/abcdefghijklmnop|hunter22/);
  });
});

describe("the gateway's request record", () => {
  const raw = (o: object, kind = "response") => `10:00:01,369 [-] [PassThroughMessageProcessor-294]  INFO ELKCounterMetric apimMetrics: apim:${kind}, properties :${JSON.stringify(o)}`;
  it("is read into what the screen needs", () => {
    const e = parseGatewayLine(raw({ apiName: "orders-exp-api", apiContext: "/orders/v1", apiVersion: "v1", apiMethod: "POST", apiResourceTemplate: "/orders", proxyResponseCode: 200, targetResponseCode: 200,
      responseLatency: 183, backendLatency: 181, requestMediationLatency: 1, responseMediationLatency: 1, applicationName: "shop-app", keyType: "PRODUCTION", userAgent: "Other", platform: "Other",
      requestTimestamp: "2026-03-01T10:00:01.186Z", responseCacheHit: false, correlationId: "g-1", properties: { responseSize: 512 } }))!;
    expect(e).toMatchObject({ ms: T0 + 1186, kind: "response", apiName: "orders-exp-api", context: "/orders/v1", method: "POST", resource: "/orders", status: 200, responseLatency: 183, backendLatency: 181, application: "shop-app", keyType: "PRODUCTION", cacheHit: false, responseSize: 512, correlationId: "g-1" });
    expect(e.userAgent).toBeUndefined(); // "Other" says nothing
  });
  it("ignores every other line", () => {
    expect(parseGatewayLine("10:00:01,369 INFO something else")).toBeNull();
    expect(parseGatewayLine(raw({ apiName: "x" }))).toBeNull(); // no time
    expect(parseGatewayLine("apimMetrics: apim:response, properties :{broken")).toBeNull();
  });
});

describe("executions rebuilt from the two sources", () => {
  it("follows one call across the layers and reports how it ended", () => {
    const [x] = buildExecutions(groupLines(call("c-1", T0, 120)).values(), [], APIS, T0 + 600_000);
    expect(x).toMatchObject({ id: "c-1", kind: "call", api: "orders-exp-api", layer: "exp", chain: ["orders-exp-api", "stock-sys-api"], operation: "CreateOrder", status: "success", httpStatus: 200, durationMs: 120, stepCount: 5, source: "logs", via: "unknown" });
    expect(x.steps.map((s) => `${s.api}:${s.message}@${s.offsetMs}`)).toEqual([
      "orders-exp-api:EXP request started@0", "orders-exp-api:Requesting process API@2", "stock-sys-api:Requesting backend@5", "stock-sys-api:Backend response received@116", "orders-exp-api:EXP request completed@120"]);
    expect(x.steps[0].fields).toEqual({ operationName: "CreateOrder", rootField: "createOrder", clientChannel: "web" });
  });
  it("starts at the experience service even when a lower layer's clock is a moment ahead", () => {
    const lines = call("c-skew", T0, 80);
    lines[2] = line("stock-sys-api", fmt(T0 - 1, "INFO", "Requesting backend", 'correlationId="c-skew" operation="reserve"'));
    const [x] = buildExecutions(groupLines(lines).values(), [], APIS, T0 + 600_000);
    expect(x.api).toBe("orders-exp-api");
    expect(x.chain).toEqual(["orders-exp-api", "stock-sys-api"]);
    expect(x.steps.every((s) => s.offsetMs >= 0)).toBe(true);
  });
  it("tells a failure, a call still running and one that never reported an end apart", () => {
    const failed = call("c-bad", T0, 90, 502);
    const open = call("c-open", T0 + 1000, 50).slice(0, 3);
    const lost = call("c-lost", T0 - 3_600_000, 50).slice(0, 2);
    const xs = buildExecutions(groupLines([...failed, ...open, ...lost]).values(), [], APIS, T0 + 20_000);
    const by = Object.fromEntries(xs.map((x) => [x.id, x]));
    expect(by["c-bad"]).toMatchObject({ status: "error", httpStatus: 502, errors: 1 });
    expect(by["c-open"]).toMatchObject({ status: "running", durationMs: undefined, finishedAt: undefined });
    expect(by["c-lost"].status).toBe("unknown");
    expect(xs.map((x) => x.id)).toEqual(["c-open", "c-bad", "c-lost"]); // newest first
  });
  it("counts retries as warnings and takes a single served line as a whole call", () => {
    const retried = call("c-retry", T0, 900);
    retried.splice(2, 0, line("orders-exp-api", fmt(T0 + 300, "WARN", "Retrying process API call", 'correlationId="c-retry" attempt=1 errorType="TIMEOUT"')));
    const served = line("orders-proc-api", `${iso(T0 + 5000)} {"time":"${iso(T0 + 5000)}","level":"INFO","message":"Cache request served","method":"POST","operation":"availableOrders","status":200,"bytes":2048,"elapsedMs":37,"correlationId":"c-cache"}`);
    const sys = [line("stock-sys-api", fmt(T0 + 7000, "INFO", "Requesting backend", 'correlationId="c-sys" operation="reserve"')), line("stock-sys-api", fmt(T0 + 7300, "INFO", "Backend response received", 'correlationId="c-sys" status=503 attempt=1'))];
    const by = Object.fromEntries(buildExecutions(groupLines([...retried, served, ...sys]).values(), [], APIS, T0 + 600_000).map((x) => [x.id, x]));
    expect(by["c-retry"]).toMatchObject({ status: "success", warnings: 1, stepCount: 6 });
    expect(by["c-cache"]).toMatchObject({ api: "orders-proc-api", operation: "availableOrders", status: "success", httpStatus: 200, durationMs: 37, via: "internal" });
    expect(by["c-sys"]).toMatchObject({ api: "stock-sys-api", operation: "reserve", status: "error", httpStatus: 503, durationMs: 300 });
  });
  it("shows a scheduled job of a companion part, keeping its start and newest lines when it is very long", () => {
    const j = (ms: number, level: string, message: string, extra: object) => line("orders-proc-api", `${iso(ms)} ${JSON.stringify({ time: iso(ms), level, message, ...extra, correlationId: "job-1" })}`, "orders-proc-loader");
    const lines = [j(T0, "INFO", "Job started", { job: "prices", trigger: "SCHEDULED", attempt: 1 })];
    for (let i = 1; i <= 1000; i++) lines.push(line("stock-sys-api", fmt(T0 + i * 10, "INFO", "Backend response received", `correlationId="job-1" status=200 attempt=1 n=${i}`)));
    lines.push(j(T0 + 11_000, "INFO", "Job finished", { job: "prices", trigger: "SCHEDULED", outcome: "SUCCEEDED", durationMs: 11000, detail: "refreshed 6 lists" }));
    const [x] = buildExecutions(groupLines(lines).values(), [gw(T0)], APIS, T0 + 600_000).filter((e) => e.id === "job-1");
    expect(x).toMatchObject({ kind: "job", api: "orders-proc-api", component: "orders-proc-loader", chain: ["orders-proc-loader", "stock-sys-api"], operation: "prices", trigger: "scheduled", status: "success", outcome: "SUCCEEDED", durationMs: 11000, stepCount: 1002, hiddenSteps: 602 });
    expect(x.via).toBeUndefined(); // a job is not a call: it is never paired with a gateway record
    expect(x.steps).toHaveLength(400);
    expect(x.steps[0].message).toBe("Job started");
    expect(x.steps[399].message).toBe("Job finished");
    const failed = buildExecutions(groupLines([j(T0, "INFO", "Job started", { job: "prices" }), j(T0 + 50, "ERROR", "Job finished", { job: "prices", outcome: "FAILED", durationMs: 50 })]).values(), [], APIS, T0 + 600_000)[0];
    expect(failed).toMatchObject({ kind: "job", status: "error", outcome: "FAILED" });
  });

  it("pairs a gateway record with the service's trace by time and adds who called", () => {
    const [x] = buildExecutions(groupLines(call("c-1", T0 + 8, 118)).values(), [gw(T0)], APIS, T0 + 600_000);
    expect(x).toMatchObject({ id: "c-1", via: "gateway", source: "both", application: "shop-app", route: "POST /orders", durationMs: 120, serviceMs: 118, httpStatus: 200, status: "success" });
    expect(x.gateway).toMatchObject({ matchedBy: "time", backendLatency: 118, keyType: "PRODUCTION" });
  });
  it("keeps calls that arrive at the same moment apart by how long each took", () => {
    const lines = [...call("slow", T0 + 6, 1400), ...call("fast", T0 + 9, 170)];
    const events = [gw(T0, { responseLatency: 185, backendLatency: 181, application: "app-fast" }), gw(T0 + 1, { responseLatency: 1410, backendLatency: 1405, application: "app-slow" })];
    const by = Object.fromEntries(buildExecutions(groupLines(lines).values(), events, APIS, T0 + 600_000).map((x) => [x.id, x]));
    expect(by.fast.application).toBe("app-fast");
    expect(by.slow.application).toBe("app-slow");
  });
  it("pairs a service that writes its first line late when both ended at the same moment", () => {
    // The gateway took 523 ms; the service logged its start 228 ms in and ran 290 ms from there.
    const lines = [...call("late-start", T0 + 228, 290), ...call("later", T0 + 640, 1046)];
    const events = [gw(T0, { responseLatency: 523, backendLatency: 520, application: "app-a" }), gw(T0 + 7, { responseLatency: 1691, backendLatency: 1688, application: "app-b" })];
    const by = Object.fromEntries(buildExecutions(groupLines(lines).values(), events, APIS, T0 + 600_000).map((x) => [x.id, x]));
    expect(by["late-start"]).toMatchObject({ source: "both", via: "gateway", application: "app-a", durationMs: 523, serviceMs: 290 });
    expect(by.later).toMatchObject({ source: "both", application: "app-b", durationMs: 1691, serviceMs: 1046 });
  });
  it("pairs by the shared end when the gateway stamped the call after the service had started on it", () => {
    // The service worked from T0 for 2693 ms; the gateway's record starts 2332 ms in and lasts 378 ms.
    const lines = [...call("early", T0, 2693), ...call("big-answer", T0 + 5070, 555)];
    const events = [gw(T0 + 2332, { responseLatency: 378, backendLatency: 375, application: "app-a" }), gw(T0 + 5000, { responseLatency: 809, backendLatency: 805, application: "app-b" })];
    const by = Object.fromEntries(buildExecutions(groupLines(lines).values(), events, APIS, T0 + 600_000).map((x) => [x.id, x]));
    expect(by.early).toMatchObject({ source: "both", application: "app-a", serviceMs: 2693, durationMs: 2710 }); // not the 378 ms of the late stamp
    expect(by["big-answer"]).toMatchObject({ source: "both", application: "app-b", durationMs: 809, serviceMs: 555 }); // ran inside the gateway's call
  });
  it("does not pair a late start that neither took as long nor ended with the gateway's call, and never pairs twice", () => {
    const lines = [...call("late", T0 + 300, 500), ...call("other", T0 + 2000, 60)];
    const events = [gw(T0, { responseLatency: 1210, backendLatency: 1205 }), gw(T0 + 150, { responseLatency: 40, backendLatency: 38, correlationId: "g-lonely" })];
    const xs = buildExecutions(groupLines(lines).values(), events, APIS, T0 + 600_000);
    const by = Object.fromEntries(xs.map((x) => [x.id, x]));
    expect(by.late.source).toBe("logs"); // 1205 ms at the gateway is not this 500 ms call that ended 400 ms earlier
    expect(by["gw:g-lonely"]).toMatchObject({ source: "gateway", via: "gateway", status: "success", route: "POST /orders", stepCount: 0, durationMs: 40 });
    expect(by.other).toMatchObject({ via: "direct", source: "logs" }); // the gateway was recording, yet has no record of it
    expect(xs.filter((x) => x.gateway).length).toBe(2);
  });
  it("lists a call only the gateway saw, takes a refused call as failed and leaves out what is not in the estate", () => {
    const events = [
      gw(T0, { apiName: "billing-exp-api", context: "/billing/v1", resource: "/invoices", method: "GET", correlationId: "g-b" }),
      gw(T0 + 10, { apiName: "BillingRenamed", context: "/billing/v1", resource: "/invoices", method: "GET", status: 503, kind: "fault", errorType: "TARGET_CONNECTIVITY", correlationId: "g-f" }),
      gw(T0 + 20, { apiName: "demo-reservation-manager", context: "/demo/v1", correlationId: "g-flow" }),
    ];
    const xs = buildExecutions([], events, APIS, T0 + 600_000);
    expect(xs.map((x) => x.id)).toEqual(["gw:g-f", "gw:g-b"]);
    expect(xs[0]).toMatchObject({ api: "billing-exp-api", status: "error", httpStatus: 503, route: "GET /invoices" });
    expect(xs[0].gateway).toMatchObject({ matchedBy: "record", errorType: "TARGET_CONNECTIVITY" });
  });
});

describe("the gateway's log file", () => {
  const rec = (n: number) => `10:00:00,000 INFO ELKCounterMetric apimMetrics: apim:response, properties :${JSON.stringify({ apiName: "orders-exp-api", proxyResponseCode: 200, requestTimestamp: iso(T0 + n * 1000), correlationId: `g-${n}` })}\n`;
  it("is read once, then only what was added, across a roll-over", () => {
    const dir = mkdtempSync(join(tmpdir(), "gwlog-"));
    const file = join(dir, "apim_metrics.log");
    writeFileSync(join(dir, "apim_metrics-02-28-2026-1.log"), rec(1) + rec(2));
    writeFileSync(file, rec(3));
    const log = new GatewayLog(file);
    log.refresh();
    expect(log.events.map((e) => e.correlationId)).toEqual(["g-1", "g-2", "g-3"]);
    appendFileSync(file, rec(4).slice(0, 40)); // half a line: wait for the rest
    log.refresh();
    expect(log.events).toHaveLength(3);
    appendFileSync(file, rec(4).slice(40));
    log.refresh(); log.refresh();
    expect(log.events.map((e) => e.correlationId)).toEqual(["g-1", "g-2", "g-3", "g-4"]);
    appendFileSync(file, rec(5)); // written just before the file is rolled over
    renameSync(file, join(dir, "apim_metrics-03-01-2026-1.log"));
    writeFileSync(file, rec(6));
    log.refresh();
    expect(log.events.map((e) => e.correlationId)).toEqual(["g-1", "g-2", "g-3", "g-4", "g-5", "g-6"]);
    expect(log.error).toBeUndefined();
  });
  it("says so when the file is not there, and is quiet when none is configured", () => {
    const missing = new GatewayLog(join(tmpdir(), "no-such-dir-xyz", "apim_metrics.log"));
    missing.refresh();
    expect(missing.error).toMatch(/not readable|not written/);
    const none = new GatewayLog(undefined);
    none.refresh();
    expect(none.configured).toBe(false);
    expect(none.error).toBeUndefined();
  });
});

describe("the feed", () => {
  const raw = (ms: number, message: string, rest: string) => `${iso(ms).replace("Z", "000000Z")} time=${iso(ms)} level=INFO module=acme/x message="${message}" ${rest}`;
  function feed(now: { v: number }, store: Record<string, string[]>, calls: { pod: string; since?: string }[]) {
    const k8s = { logs: async (pod: string, _tail: number, since?: string): Promise<LogLine[]> => {
      calls.push({ pod, since });
      if (pod === "broken-1") throw new Error("Logs of broken-1 are not available (500)");
      const all = parseLogs((store[pod] || []).join("\n"), pod);
      return since ? all.filter((l) => (l.at || "") >= since.slice(0, 19)) : all; // the cluster answers from the start of that second
    } };
    return new MigratedExecutions({ k8s, now: () => now.v, sources: async () => ({ apis: APIS, pods: Object.keys(store).map((pod) => ({ pod, api: pod.replace(/-\d+$/, "") })) }) });
  }
  it("reads everything once, then only new lines, and never counts a line twice", async () => {
    const now = { v: T0 + 60_000 };
    const store: Record<string, string[]> = {
      "orders-exp-api-1": [raw(T0, "EXP request started", 'correlationId="a" operationName="CreateOrder"'), raw(T0 + 90, "EXP request completed", 'correlationId="a" operationName="CreateOrder" status=200')],
      "stock-sys-api-1": [raw(T0 + 20, "Requesting backend", 'correlationId="a" operation="reserve"')],
    };
    const calls: { pod: string; since?: string }[] = [];
    const f = feed(now, store, calls);
    const first = await f.list(null);
    expect(first.executions).toHaveLength(1);
    expect(first.executions[0]).toMatchObject({ id: "a", chain: ["orders-exp-api", "stock-sys-api"], stepCount: 3, status: "success" });
    expect(first.executions[0]).not.toHaveProperty("steps");
    expect(calls.every((c) => c.since === undefined)).toBe(true);

    await f.list(null); // within the refresh interval: answered from memory
    expect(calls).toHaveLength(2);

    now.v += 10_000;
    store["orders-exp-api-1"].push(raw(T0 + 400, "EXP request started", 'correlationId="b" operationName="GetOrder"'));
    const second = await f.list(null);
    expect(calls.slice(2).map((c) => c.since)).toEqual([iso(T0 + 90), iso(T0 + 20)]);
    expect(second.executions.map((x) => `${x.id}:${x.stepCount}`)).toEqual(["b:1", "a:3"]);
    expect(second.sources.logs).toMatchObject({ available: true, parts: 2, lines: 4 });
    expect((await f.get(null, "a"))!.steps).toHaveLength(3);
    expect(await f.get(null, "nope")).toBeNull();
  });
  it("filters, counts per API and says what could not be read", async () => {
    const now = { v: T0 + 60_000 };
    const store: Record<string, string[]> = {
      "orders-exp-api-1": [
        raw(T0, "EXP request started", 'correlationId="a" operationName="CreateOrder"'), raw(T0 + 90, "EXP request completed", 'correlationId="a" operationName="CreateOrder" status=200'),
        raw(T0 + 1000, "EXP request started", 'correlationId="b" operationName="GetOrder"'), raw(T0 + 1090, "EXP request completed", 'correlationId="b" operationName="GetOrder" status=500'),
      ],
      "stock-sys-api-1": [raw(T0 + 1020, "Requesting backend", 'correlationId="b" operation="lookup"')],
      "broken-1": [],
    };
    const f = feed(now, store, []);
    const all = await f.list(null);
    expect(all).toMatchObject({ total: 2, recorded: 2, failed: 1 });
    expect(all.apis.find((a) => a.api === "orders-exp-api")).toEqual({ api: "orders-exp-api", total: 2, errors: 1 });
    expect(all.apis.find((a) => a.api === "billing-exp-api")).toEqual({ api: "billing-exp-api", total: 0, errors: 0 });
    expect(all.notes.join(" ")).toMatch(/could not be read/);
    expect(all.notes.join(" ")).toMatch(/gateway's request records are not connected/);
    expect((await f.list(null, { status: "error" })).executions.map((x) => x.id)).toEqual(["b"]);
    expect((await f.list(null, { api: "stock-sys-api" })).executions.map((x) => x.id)).toEqual(["b"]); // took part in it
    expect((await f.list(null, { q: "createorder" })).executions.map((x) => x.id)).toEqual(["a"]);
    expect((await f.list(null, { kind: "job" })).total).toBe(0);
    expect((await f.list(null, { limit: 1 })).executions).toHaveLength(1);
  });
});
