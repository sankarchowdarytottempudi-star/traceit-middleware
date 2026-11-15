// Reshaping: model -> contract Flow, links between APIs, log parsing, metrics steps, gateway
// matching and the assembled overview (with a stand-in for the cluster).
import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApi, discoverSources, type ConnectorModel } from "../src/estate/model";
import { buildFlow, triggerPath, mappingRules } from "../src/estate/flow";
import { Estate, layerOf, targetApi, backendLabel, correctBasePaths, unfinishedOf } from "../src/estate/service";
import { parseLogs, mergeLogs, maskLog, type K8s } from "../src/estate/k8s";
import { stepFor, apiMetrics, increments } from "../src/estate/prom";
import { matchGateway, type GatewayEntry } from "../src/estate/gateway";
import { connectionConfig, insideUrl } from "../src/estate/routes";

const F = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "estate");
const model = (name: string, config = true) => buildApi(discoverSources(join(F, "services")).find((e) => e.name === name)!, config ? [join(F, "config")] : []);
const conn = (over: Partial<ConnectorModel>): ConnectorModel => ({ name: "xClient", kind: "http", target: "", auth: "", usedBy: [], file: "f.bal", line: 1, code: "", paths: [], secrets: [], settings: [], ...over });
afterEach(() => nock.cleanAll());

describe("flow of a migrated API", () => {
  const flow = () => buildFlow(model("orders-proc-api"), { apiOf: (c) => (c === "stockClient" ? "stock-sys-api" : undefined) });

  it("is one read-only flow with a trigger per operation", () => {
    const f = flow();
    expect(f.id).toBe("estate:orders-proc-api");
    expect(f.readOnly).toBe(true);
    expect(f.origin).toEqual({ kind: "migrated", ref: "orders-proc-api" });
    expect(f.settings.basePath).toBe("/orders-proc-api/v1");
    const triggers = f.nodes.filter((n) => n.type === "trigger.http");
    expect(triggers.map((n) => `${(n.config as any).methods.join("|")} ${(n.config as any).path}`)).toEqual(["GET /orders/:orderId", "POST /orders", "DELETE /orders/:orderId"]);
  });

  it("draws calls in order, links to other estate APIs and keeps the source of every step", () => {
    const f = flow();
    const types = f.nodes.map((n) => n.type);
    expect(types.filter((t) => t === "flow.call")).toHaveLength(1);
    expect(types.filter((t) => t === "http.request")).toHaveLength(1);
    const call = f.nodes.find((n) => n.type === "flow.call")!;
    expect((call.config as any).flow).toBe("estate:stock-sys-api");
    expect(call.notes).toContain("Answers 400 when");
    for (const n of f.nodes.filter((x) => x.type !== "respond")) {
      const src = (n.config as any).__source;
      expect(src?.file, n.name).toBeTruthy();
      expect(src.line).toBeGreaterThan(0);
      expect(src.endLine).toBeGreaterThanOrEqual(src.line);
      expect(typeof src.code).toBe("string");
    }
    const ids = new Set(f.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.nodes.length);
    for (const e of f.edges) { expect(ids.has(e.from)).toBe(true); expect(ids.has(e.to)).toBe(true); }
    expect(new Set(f.nodes.map((n) => n.name)).size).toBe(f.nodes.length);
    const stub = f.nodes.find((n) => n.type === "respond" && (n.config as any).status === "501")!;
    expect(stub.name).toBe("Not migrated yet");
  });

  it("can be limited to one operation", () => {
    const f = buildFlow(model("orders-proc-api"), { apiOf: () => undefined, operation: "post-orders" });
    expect(f.nodes.filter((n) => n.type === "trigger.http")).toHaveLength(1);
    expect(f.nodes.some((n) => n.type === "transform.map")).toBe(true);
  });

  it("builds an editable copy that uses connections instead of references to other flows", () => {
    const f = buildFlow(model("orders-proc-api"), { apiOf: (c) => (c === "stockClient" ? "stock-sys-api" : undefined), editable: true, connections: { stockClient: "conn_1", billingClient: "conn_2" }, basePath: "/copy/v1", name: "Copy" });
    expect(f.readOnly).toBe(false);
    expect(f.name).toBe("Copy");
    expect(f.settings.basePath).toBe("/copy/v1");
    expect(f.nodes.some((n) => n.type === "flow.call")).toBe(false);
    expect(f.nodes.filter((n) => n.type === "http.request").map((n) => (n.config as any).connection).sort()).toEqual(["conn_1", "conn_2"]);
  });

  it("turns recovered fields into mapping rules and path parameters into router parameters", () => {
    const m = model("orders-proc-api").mappings.find((x) => x.id === "core.toChargeRequest");
    const rules = mappingRules(m);
    expect(rules.map((r) => r.target)).toEqual(["orderRef", "amount", "currency", "customer.email"]);
    expect(rules.every((r) => typeof r.id === "string" && r.id.length > 0)).toBe(true);
    expect(triggerPath("/a/{id}/b/{rest*}")).toBe("/a/:id/b/:rest");
    expect(triggerPath("")).toBe("/");
  });
});

describe("links between APIs", () => {
  const names = ["orders-proc-api", "stock-sys-api", "shop-exp-api"];
  it("recognises another API by host name, by path segment or by node port", () => {
    expect(targetApi(conn({ target: "http://stock-sys-api.shop.svc:80" }), "orders-proc-api", names, new Map())).toBe("stock-sys-api");
    expect(targetApi(conn({ target: "http://10.0.0.5:8080", paths: ["/stock-sys-api/v1/stock/{id}"] }), "orders-proc-api", names, new Map())).toBe("stock-sys-api");
    expect(targetApi(conn({ target: "http://10.0.0.5:30123" }), "orders-proc-api", names, new Map([[30123, "shop-exp-api"]]))).toBe("shop-exp-api");
    expect(targetApi(conn({ target: "https://billing.example.test" }), "orders-proc-api", names, new Map())).toBeUndefined();
    expect(targetApi(conn({ target: "http://orders-proc-api.shop.svc" }), "orders-proc-api", names, new Map())).toBeUndefined();
    expect(targetApi(conn({ kind: "redis", target: "redis://stock-sys-api:6379" }), "orders-proc-api", names, new Map())).toBeUndefined();
  });
  it("names a backend by host without credentials and hides example localhost values", () => {
    expect(backendLabel(conn({ target: "https://user:pw@billing.example.test/pay" }))).toBe("billing.example.test");
    expect(backendLabel(conn({ target: "redis://cache.shop.svc:6379", kind: "redis" }))).toBe("cache.shop");
    expect(backendLabel(conn({ target: "redis://localhost:6379", kind: "redis" }), true)).toBe("Redis");
    expect(backendLabel(conn({ target: "http://localhost:9090", name: "stockClient" }), true)).toBe("stock");
    expect(backendLabel(conn({ target: "http://localhost:9090" }), false)).toBe("localhost:9090");
  });
  it("derives the layer from the label, the migration record or the name", () => {
    expect(layerOf("anything", "experience")).toBe("exp");
    expect(layerOf("anything", undefined, "System")).toBe("sys");
    expect(layerOf("orders-proc-api")).toBe("proc");
    expect(layerOf("orders-process-api")).toBe("proc");
    expect(layerOf("shop-exp-api")).toBe("exp");
    expect(layerOf("stock-sys-api-new")).toBe("sys");
    expect(layerOf("misc")).toBe("other");
  });
  it("takes the base path from callers when only example configuration is readable", () => {
    const callee = model("orders-proc-api", false);
    callee.basePaths = ["/sample"]; callee.basePath = "/sample";
    for (const o of callee.operations) o.fullPath = "/sample" + o.path;
    const caller = model("stock-sys-api", false);
    caller.connectors.push(conn({ target: "http://orders-proc-api.shop.svc", paths: ["/orders-proc-api/v2/orders"] }));
    correctBasePaths([callee, caller]);
    expect(callee.basePath).toBe("/orders-proc-api/v2");
    expect(callee.operations.map((o) => o.fullPath)).toContain("/orders-proc-api/v2/orders");
    expect(callee.warnings.join(" ")).toContain("cluster secret");
  });
});

describe("pod logs", () => {
  const raw = [
    "2026-01-02T10:00:00.123456789+01:00 time=2026-01-02T09:00:00.120Z level=INFO module=acme/orders message=\"started\"",
    "2026-01-02T10:00:01.000000000+01:00 error: no matching resource found for path : /x , method : GET",
    "2026-01-02T10:00:02.000000000+01:00 {\"time\":\"t\", \"level\":\"WARN\", \"message\":\"slow\"}",
    "2026-01-02T10:00:03.000000000+01:00 java.lang.IllegalStateException: boom",
    "\tat acme.Orders.run(Orders.java:10)",
    "2026-01-02T10:00:04.000000000+01:00 calling upstream with Authorization: Bearer abcdefghijklmnop password=hunter22 url=https://bob:pw123@host/x",
    "",
  ].join("\n");
  it("splits the time stamp in UTC, detects the level and joins stack traces", () => {
    const lines = parseLogs(raw, "pod-a");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatchObject({ at: "2026-01-02T09:00:00.123Z", level: "info", pod: "pod-a" });
    expect(lines[1].level).toBe("error");
    expect(lines[2].level).toBe("warn");
    expect(lines[3].level).toBe("error");
    expect(lines[3].text).toContain("\n");
  });
  it("blanks credentials that appear in a line", () => {
    const text = parseLogs(raw)[4].text;
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("hunter22");
    expect(text).not.toContain("pw123");
    expect(maskLog("client_secret: \"s3cr3tvalue\"")).not.toContain("s3cr3tvalue");
  });
  it("merges replicas in time order, filters and keeps the newest lines", () => {
    const a = parseLogs("2026-01-02T10:00:00Z level=INFO one\n2026-01-02T10:00:04Z level=ERROR four", "a");
    const b = parseLogs("2026-01-02T10:00:02Z level=INFO two\n2026-01-02T10:00:03Z level=WARN three", "b");
    expect(mergeLogs([a, b], 10).map((l) => l.pod)).toEqual(["a", "b", "b", "a"]);
    expect(mergeLogs([a, b], 2).map((l) => l.text)).toEqual(["level=WARN three", "level=ERROR four"]);
    expect(mergeLogs([a, b], 10, "TWO")).toHaveLength(1);
    expect(mergeLogs([a, b], 10, undefined, "error")).toHaveLength(1);
  });
});

describe("metrics", () => {
  it("counts whole requests from the raw counters without extrapolating", () => {
    const ok = { metric: { http_status_code_group: "2xx" }, values: [[0, "40"], [60, "40"], [120, "45"], [180, "45"]] as [number, string][] };
    const fresh = { metric: { http_status_code_group: "5xx" }, values: [[120, "2"], [180, "3"]] as [number, string][] };      // first seen inside the window
    const restarted = { metric: { http_status_code_group: "2xx" }, values: [[0, "90"], [60, "91"], [120, "1"], [180, "4"]] as [number, string][] };
    expect(increments([ok], 0, 180, 60)).toEqual([0, 5, 0]);
    expect(increments([ok, fresh, restarted], 0, 180, 60)).toEqual([1, 8, 4]);
    expect(increments([ok, fresh, restarted], 0, 180, 60, (m) => m?.http_status_code_group === "5xx")).toEqual([0, 2, 1]);
    expect(increments([], 0, 180, 60)).toEqual([0, 0, 0]);
  });
  it("picks a step that keeps the chart readable", () => {
    expect(stepFor(1)).toBeLessThanOrEqual(120);
    expect(stepFor(24)).toBeGreaterThan(stepFor(1));
    expect(24 * 3600 / stepFor(24)).toBeLessThanOrEqual(300);
  });
  it("reports unavailable instead of zeros when nothing is configured or scraped", async () => {
    expect(await apiMetrics(undefined, "orders-proc-api", 1)).toMatchObject({ available: false, total: 0 });
    nock("http://prom.test").get(/\/api\/v1\/query/).times(20).reply(200, { status: "success", data: { resultType: "vector", result: [] } })
      .get(/\/api\/v1\/query_range/).times(5).reply(200, { status: "success", data: { resultType: "matrix", result: [] } });
    const m = await apiMetrics("http://prom.test", "orders-proc-api", 1);
    expect(m.available).toBe(false);
    expect(m.reason).toBeTruthy();
  });
});

describe("gateway matching", () => {
  const e = (over: Partial<GatewayEntry>): GatewayEntry => ({ id: "1", name: "x", context: "/x", version: "1.0.0", published: true, status: "PUBLISHED", ...over });
  it("prefers the entry whose endpoint points at the service", () => {
    const entries = [e({ id: "a", name: "Orders", context: "/orders", endpoint: "http://orders-proc-api.shop.svc:80/orders-proc-api/v1" }), e({ id: "b", name: "orders-proc-api", context: "/other" })];
    expect(matchGateway(entries, "orders-proc-api")?.id).toBe("a");
    expect(matchGateway([e({ id: "c", context: "/s", endpoint: "http://10.0.0.1:30123/v1" })], "stock-sys-api", 30123)?.id).toBe("c");
    expect(matchGateway([e({ id: "d", name: "Stock Sys API", context: "/stock" })], "stock-sys-api")?.id).toBe("d");
    expect(matchGateway(entries, "stock-sys-api")).toBeUndefined();
  });
});

describe("connections of a clone", () => {
  it("carries addresses but never credentials", () => {
    const http = connectionConfig(conn({ target: "https://user:pw@billing.example.test/pay?token=abc" }));
    expect(http).toMatchObject({ type: "http", config: { baseUrl: "https://billing.example.test", authType: "none" } });
    expect(JSON.stringify(http)).not.toContain("pw");
    expect(connectionConfig(conn({ kind: "redis", target: "redis://:pw@cache.shop.svc:6380" }))).toMatchObject({ type: "redis", config: { host: "cache.shop.svc", port: 6380 } });
    const viaNode = connectionConfig({ ...conn({ target: "http://stock-sys-api.shop.svc:80" }), api: "stock-sys-api" }, "http://127.0.0.1:30123");
    expect(viaNode.config.baseUrl).toBe("http://127.0.0.1:30123");
    expect(viaNode.note).toContain("node port");
    expect(connectionConfig(conn({ target: "" })).note).toContain("not known");
    // a service without a node port is reached at its address inside the cluster
    const svc = (name: string, clusterIP: string | undefined, port = 80) => ({ name, type: "ClusterIP", clusterIP, selector: {}, ports: [{ name: "metrics", port: 9797 }, { name: "http", port }] });
    expect(insideUrl([svc("stock-sys-api", "10.43.0.9")], "stock-sys-api")).toBe("http://10.43.0.9");
    expect(insideUrl([svc("stock-sys-api", "10.43.0.9", 8080)], "stock-sys-api")).toBe("http://10.43.0.9:8080");
    expect(insideUrl([svc("stock-sys-api", "None")], "stock-sys-api")).toBeUndefined();
    expect(insideUrl([svc("stock-sys-api", "10.43.0.9")], "other-api")).toBeUndefined();
    const inside = connectionConfig({ ...conn({ target: "http://stock-sys-api.shop.svc:80" }), api: "stock-sys-api" }, "http://10.43.0.9", "its address inside the cluster");
    expect(inside.config.baseUrl).toBe("http://10.43.0.9");
    expect(inside.note).toContain("its address inside the cluster");
  });
});

describe("assembled estate", () => {
  const dep = (name: string, layer: string, ready = 1) => ({ name, labels: { "integration.test/layer": layer, "app.kubernetes.io/name": name }, selector: { "app.kubernetes.io/name": name }, replicas: 1, ready, updated: 1, images: [`${name}:1`], lastDeployedAt: "2026-01-01T00:00:00Z" });
  const svc = (name: string, nodePort: number) => ({ name, type: "NodePort", selector: { "app.kubernetes.io/name": name }, ports: [{ port: 80, nodePort }] });
  const k8s = (deployments: unknown[]) => ({ configured: true, namespace: "shop", deployments: async () => deployments, services: async () => [svc("orders-proc-api", 30001), svc("stock-sys-api", 30002)], pods: async () => [], podsOf: async () => [], logs: async () => "" }) as unknown as K8s;
  const estate = (deployments: unknown[]) => new Estate({ servicesDir: join(F, "services"), configDir: join(F, "config"), namespace: "shop", k8s: k8s(deployments), migrations: async () => [{ id: "m1", apiName: "orders-proc-api" }] });

  it("lists every deployed service with layer, health, counts, migration and links", async () => {
    const o = await estate([dep("orders-proc-api", "process"), dep("stock-sys-api", "system", 0)]).overview();
    expect(o.apis.map((a) => a.name)).toEqual(["orders-proc-api", "stock-sys-api"]);
    const orders = o.apis[0];
    expect(orders).toMatchObject({ layer: "proc", status: "running", health: "healthy", replicas: 1, nodePort: 30001, basePath: "/orders-proc-api/v1", operations: 3, connectors: 2, migrationId: "m1", notMigrated: 1 });
    expect(orders.gateway).toMatchObject({ published: false, known: false });
    expect(o.apis[1]).toMatchObject({ layer: "sys", status: "down", health: "down" });
    expect(o.links).toContainEqual(expect.objectContaining({ from: "orders-proc-api", to: "stock-sys-api", via: "http", toKind: "api" }));
    expect(o.links).toContainEqual(expect.objectContaining({ from: "orders-proc-api", to: "billing.example.test", toKind: "backend" }));
  });

  it("leaves out source that was generated but never deployed, and keeps deployments without source", async () => {
    const o = await estate([dep("orders-proc-api", "process"), dep("ghost-exp-api", "experience")]).overview();
    expect(o.apis.map((a) => a.name)).toEqual(["ghost-exp-api", "orders-proc-api"]);
    expect(o.apis[0]).toMatchObject({ sourceAvailable: false, layer: "exp", operations: 0 });
  });

  it("serves detail and a flow whose calls point at the other API", async () => {
    const e = estate([dep("orders-proc-api", "process"), dep("stock-sys-api", "system")]);
    const d = (await e.detail("orders-proc-api"))!;
    expect(d.operations).toHaveLength(3);
    expect(d.connectors.find((c) => c.name === "stockClient")).toMatchObject({ api: "stock-sys-api" });
    expect(d.connectors.find((c) => c.name === "billingClient")).toMatchObject({ backend: "billing.example.test" });
    expect(JSON.stringify(d)).not.toContain("fixture-not-a-real-value");
    expect(await e.detail("nope")).toBeNull();
    const f = (await e.flow("orders-proc-api", undefined))!;
    expect(f.readOnly).toBe(true);
    expect(f.nodes.some((n) => n.type === "flow.call" && (n.config as any).flow === "estate:stock-sys-api")).toBe(true);
  });
});

describe("a running service that is not finished", () => {
  it("is finished when the check says so, whatever else", () => {
    expect(unfinishedOf({ api: "a", ready: true }, 0)).toBeUndefined();
  });
  it("says what is missing: operations, parts with no code, addresses", () => {
    const u = unfinishedOf({ api: "a", ready: false, summary: "1 starting point of the old application has no code yet",
      placeholders: [{ operation: "GET /x" }], missingEntries: [{ name: "nightly", starts: "runs on a timer" }], missingBackends: ["db"] }, 0)!;
    expect(u.summary).toContain("starting point");
    expect(u.operations).toEqual(["GET /x"]);
    expect(u.entries).toEqual(["nightly (runs on a timer)"]);
    expect(u.backends).toEqual(["db"]);
  });
  it("falls back to the code when there is no check for the service", () => {
    expect(unfinishedOf(undefined, 0)).toBeUndefined();
    expect(unfinishedOf(undefined, 1)!.summary).toBe('1 operation still answers "not migrated"');
    expect(unfinishedOf({ api: "a", ready: false, exists: false }, 3)!.summary).toBe('3 operations still answer "not migrated"');
  });
});
