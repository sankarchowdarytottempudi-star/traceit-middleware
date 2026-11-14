import { describe, it, expect } from "vitest";
import { backendTarget, buildInventory, classify, reshapeGatewayApi, securityLabels } from "../src/inventory.js";
import { mapDeployment, mapPod, mapService, selects } from "../src/k8s.js";

const dep = (name: string, container = "api", labels: Record<string, string> = { "x.example/layer": "process" }, ready = 1, desired = 1) => mapDeployment({
  metadata: { name, namespace: "ns", labels }, spec: { replicas: desired, selector: { matchLabels: { "app.kubernetes.io/name": name } }, template: { spec: { containers: [{ name: container, image: `${name}:1`, ports: [{ name: "http", containerPort: 8081 }] }] } } },
  status: { readyReplicas: ready } });
const pod = (name: string, app: string, ready = true, restarts = 0) => mapPod({ metadata: { name, namespace: "ns", labels: { "app.kubernetes.io/name": app } }, spec: { containers: [{ name: "api" }] }, status: { phase: "Running", containerStatuses: [{ ready, restartCount: restarts }] } });
const svc = (name: string, nodePort?: number) => mapService({ metadata: { name, namespace: "ns" }, spec: { type: "NodePort", clusterIP: "10.0.0.9", selector: { "app.kubernetes.io/name": name }, ports: [{ name: "http", port: 80, nodePort }] } });
const gapi = (id: string, name: string, backend: string, state = "PUBLISHED") => reshapeGatewayApi({ id, name, context: `/${name}`, version: "v1", lifeCycleStatus: state, securityScheme: ["oauth2", "oauth_basic_auth_api_key_mandatory"], apiThrottlingPolicy: "Gold",
  operations: [{ verb: "GET", target: "/x", authType: "Application & Application User" }], endpointConfig: { production_endpoints: { url: backend } } }, { count: 2, applications: ["app-a", "app-b"] });
const hour = { byName: new Map(), flowsById: new Map(), notExporting: new Set<string>(["billing"]), ok: true };

describe("inventory helpers", () => {
  it("labels security schemes for people", () => {
    expect(securityLabels(["oauth2", "api_key", "oauth_basic_auth_api_key_mandatory"], [{ authType: "Any" }])).toEqual(["OAuth2 token", "API key"]);
    expect(securityLabels(["oauth2"], [{ authType: "None" }])).toEqual(["Open (no sign-in)"]);
  });
  it("normalises backend hosts", () => {
    expect(backendTarget("http://orders_api.ns.svc:8080/v1")).toEqual({ host: "orders_api.ns.svc", first: "orders-api", port: 8080 });
    expect(backendTarget("not a url")).toBeNull(); expect(backendTarget(null)).toBeNull();
  });
  it("classifies deployments without a hard-coded list", () => {
    expect(classify(dep("orders"), new Set())).toEqual({ kind: "service", role: "process" });
    expect(classify(dep("loader", "loader"), new Set())).toEqual({ kind: "component", role: "worker" });
    expect(classify(dep("db", "postgres", {}), new Set())).toEqual({ kind: "component", role: "infrastructure" });
    expect(classify(dep("legacy", "main", {}), new Set(["legacy"]))).toEqual({ kind: "service", role: "service" });
  });
  it("matches selectors", () => {
    expect(selects({ a: "1" }, { a: "1", b: "2" })).toBe(true); expect(selects({ a: "1" }, { a: "2" })).toBe(false); expect(selects({}, { a: "1" })).toBe(false);
  });
});

describe("buildInventory", () => {
  const input = {
    deployments: [dep("orders", "api", { "x.example/layer": "experience" }, 2, 2), dep("billing", "api", { "x.example/layer": "system" }, 0, 1), dep("stock"), dep("db", "postgres", {})],
    pods: [pod("orders-1", "orders"), pod("orders-2", "orders", true, 3), pod("billing-1", "billing", false)],
    services: [svc("orders", 30080), svc("billing"), svc("stock")], serviceDirs: new Set<string>(),
    gatewayApis: [gapi("a1", "orders-public", "http://orders.ns.svc/orders/v1"), gapi("a2", "partner-feed", "https://partner.example.com/feed", "CREATED"), gapi("a3", "ship-list", "http://10.1.1.1:8790/run/ship-list/v1")],
    flows: [{ id: "fl_1", name: "Ship list", slug: "ship-list", deployment: { status: "deployed", gateway: { status: "published", apiId: "a3" } } }, { id: "fl_2", name: "Draft flow", slug: "draft" }],
    hour, gwHour: { "orders-public": { requests: 10, errors: 2, avgMs: 40, p95Ms: 90, lastAt: 1 } }, gwActive: true,
  };
  const { items, components } = buildInventory(input);
  const by = (name: string) => items.find((i) => i.name === name)!;

  it("lists every service, published or not", () => {
    expect(items.filter((i) => i.kind === "service").map((i) => [i.name, i.exposure])).toEqual([["billing", "internal"], ["orders", "published"], ["stock", "internal"]]);
    expect(components.map((c) => [c.name, c.role])).toEqual([["db", "infrastructure"]]);
  });
  it("joins a service with its gateway API, health and traffic", () => {
    const o = by("orders");
    expect(o.gateway[0]).toMatchObject({ context: "/orders-public", version: "v1", security: ["OAuth2 token"], throttling: "Gold", subscriptions: 2, applications: ["app-a", "app-b"] });
    expect(o.cluster).toEqual({ address: "orders.ns.svc", port: 80, nodePort: 30080, namespace: "ns" });
    expect(o.health).toMatchObject({ state: "healthy", ready: 2, desired: 2, restarts: 3 });
    expect(o.traffic).toEqual({ source: "gateway", requests: 10, errors: 2, errorRate: 20, avgMs: 40, p95Ms: 90 });
    expect(o.factoryPath).toBe("/estate/orders"); expect(o.logSource).toBe("svc:orders");
  });
  it("reports health honestly and knows which services publish no metrics", () => {
    expect(by("billing").health!.state).toBe("down"); expect(by("billing").metricsExported).toBe(false); expect(by("billing").traffic).toBeNull();
    expect(by("stock").metricsExported).toBe(true);
  });
  it("adds flows and gateway-only APIs", () => {
    expect(by("Ship list")).toMatchObject({ kind: "flow", exposure: "published", factoryPath: "/studio/flows/fl_1", logSource: "flow:fl_1" });
    expect(by("Ship list").gateway[0].id).toBe("a3");
    expect(by("Draft flow")).toMatchObject({ kind: "flow", exposure: "internal" }); expect(by("Draft flow").health!.state).toBe("stopped");
    expect(by("partner-feed")).toMatchObject({ kind: "gateway-api", exposure: "draft", health: null, logSource: "gw" });
  });
  it("prefers the service's own metrics when it publishes them", () => {
    const h = { ...hour, byName: new Map([["orders", { name: "orders", kind: "service" as const, exportsMetrics: true, spark: [], requests: 7, errors: 1, errorRate: 14.29, avgMs: 12, p50Ms: 10, p95Ms: 30, p99Ms: 31 }]]) };
    const o = buildInventory({ ...input, hour: h }).items.find((i) => i.name === "orders")!;
    expect(o.traffic).toEqual({ source: "service", requests: 7, errors: 1, errorRate: 14.29, avgMs: 12, p95Ms: 30 }); expect(o.metricsExported).toBe(true);
  });
});
