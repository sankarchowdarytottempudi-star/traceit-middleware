import type { Page } from "@playwright/test";

const compliance = {
  governed: 5, compliant: 2, total: 5, errors: 3, warnings: 105, info: 0,
  policyAdherencePct: 40, apiCompliancePct: 40,
  apis: [
    { apiId: "1", name: "financial-transactions-proc-api", version: "v1", errors: 1, warnings: 25, info: 0, policy: "WSO2 API Management Best Practices" },
    { apiId: "2", name: "loyalty-exp-api", version: "v1", errors: 1, warnings: 25, info: 0, policy: "WSO2 API Management Best Practices" },
    { apiId: "3", name: "telr-pay-gw-sys-api", version: "v1", errors: 1, warnings: 25, info: 0, policy: "WSO2 API Management Best Practices" },
    { apiId: "4", name: "cms-proc-api", version: "v1", errors: 0, warnings: 16, info: 0, policy: "WSO2 API Management Best Practices" },
    { apiId: "5", name: "reservation-mgr-exp-api", version: "v1", errors: 0, warnings: 14, info: 0, policy: "WSO2 API Management Best Practices" },
  ],
};
const subPolicies = {
  list: [
    { policyId: "g", name: "Gold", displayName: "Gold", quotaType: "requestCount", limit: 5000, unit: "req", timeUnit: "min", stopOnQuotaReach: true },
    { policyId: "u", name: "Unlimited", displayName: "Unlimited", quotaType: "requestCount", limit: 2147483647, unit: "req", timeUnit: "min", stopOnQuotaReach: false },
  ],
};
const environments = { list: [
  { id: "d", name: "Default", type: "hybrid", gatewayType: "Regular", visibility: "PUBLIC", vhosts: [{ host: "localhost" }], reachable: false },
  { id: "p", name: "Production", type: "production", gatewayType: "Regular", visibility: "PUBLIC", vhosts: [{ host: "gw.aroya.com" }], reachable: true },
] };
const keyManagers = { list: [{ id: "r", name: "Resident Key Manager", type: "direct", enabled: true }] };
const workflows = { types: [
  { type: "AM_SUBSCRIPTION_CREATION", label: "subscription creation", pending: 1, requests: [{ referenceId: "r1", type: "AM_SUBSCRIPTION_CREATION", requester: "alice", description: "Subscribe app to cms", createdTime: "2026-11-14" }] },
  { type: "AM_API_STATE", label: "api state", pending: 0, requests: [] },
] };
const apis = { list: [
  { id: "1", name: "cms-proc-api", context: "/cms", version: "v1", lifeCycleStatus: "PUBLISHED", securityScheme: ["oauth2"], throttlingPolicy: "AroyaApiLimit", operations: [{ verb: "GET", target: "/descriptions/{type}", authType: "None" }], backend: "http://cms-proc-api.wso2.svc/cms-proc-api/v1" },
] };

// ---- Observe screens: APIs, analytics, gateway analytics, logs (synthetic data) ----
const T0 = Date.UTC(2026, 10, 14, 9, 0, 0);
const ok = { ok: true, configured: true };
const gwStatus = { state: "active", enabled: true, file: "/var/log/gateway/metrics.log", fileSize: 51200, lastEventAt: new Date(T0 + 3500_000).toISOString(), lastReadAt: new Date(T0 + 3600_000).toISOString(), oldestAt: new Date(T0).toISOString(), eventsIndexed: 527, linesSkipped: 0 };
const pod = (name: string) => ({ name: `${name}-5b9f589f69-8zhcx`, phase: "Running", ready: true, restarts: 0, startedAt: "2026-11-14T08:00:00Z", reason: "" });
const svc = (name: string, role: string, published: boolean, metrics: boolean, nodePort: number) => ({
  id: `svc:${name}`, name, kind: "service", role, exposure: published ? "published" : "internal",
  gateway: published ? [{ id: `id-${name}`, name, context: `/${name.split("-")[0]}`, version: "v1", lifeCycleStatus: "PUBLISHED", security: ["OAuth2 token"], throttling: "Gold", tiers: ["Unlimited"], subscriptions: 1, applications: ["partner-portal"], backend: `http://${name}.apps.svc/${name}/v1`, cachingSeconds: null, operations: [{ verb: "GET", target: "/items/{id}", authType: "Application & Application User", throttling: "Unlimited" }] }] : [],
  cluster: { address: `${name}.apps.svc`, port: 80, nodePort, namespace: "apps" },
  health: { state: "healthy", ready: 1, desired: 1, restarts: 0, image: `${name}:1`, pods: [pod(name)] },
  metricsExported: metrics, traffic: metrics || published ? { source: metrics ? "service" : "gateway", requests: 110, errors: 5, errorRate: 4.55, avgMs: 178.7, p95Ms: 500 } : null,
  factoryPath: `/estate/${name}`, logSource: `svc:${name}`,
});
const inventory = {
  generatedAt: new Date(T0 + 3600_000).toISOString(),
  sources: { kubernetes: ok, gateway: ok, metrics: ok, runtime: ok, gatewayAnalytics: gwStatus },
  summary: { services: 4, published: 2, internal: 2, flows: 1, gatewayOnly: 0, unhealthy: 0 },
  items: [
    svc("cms-proc-api", "process", true, false, 30084), svc("reservation-mgr-exp-api", "experience", true, true, 30081),
    svc("seaware-sys-api", "system", false, true, 30090), svc("loyalty-proc-api", "process", false, false, 30086),
    { id: "flow:fl_1", name: "sample-ship-list", kind: "flow", role: "flow", exposure: "published", gateway: [{ id: "id-flow", name: "weave-sample-ship-list", context: "/weave/ships", version: "v1", lifeCycleStatus: "PUBLISHED", security: ["OAuth2 token"], throttling: "Unlimited", tiers: ["Unlimited"], subscriptions: 0, applications: [], backend: "http://runtime.internal/flows/fl_1", cachingSeconds: null, operations: [{ verb: "GET", target: "/", authType: "Application", throttling: "Unlimited" }] }],
      cluster: null, health: { state: "healthy", ready: 1, desired: 1, restarts: 0, image: "", pods: [] }, metricsExported: true, traffic: { source: "runtime", requests: 4, errors: 0, errorRate: 0, avgMs: null, p95Ms: 120 }, factoryPath: "/studio/flows/fl_1", logSource: "flow:fl_1" },
  ],
  components: [{ id: "svc:intg-postgres", name: "intg-postgres", kind: "component", role: "infrastructure", exposure: "internal", gateway: [], cluster: { address: "intg-postgres.apps.svc:5432", port: 5432, nodePort: null, namespace: "apps" }, health: { state: "healthy", ready: 1, desired: 1, restarts: 0, image: "postgres:16", pods: [pod("intg-postgres")] }, metricsExported: null, traffic: null, factoryPath: null, logSource: "svc:intg-postgres" }],
};
const wave = (i: number) => Math.round(6 + 5 * Math.sin(i / 5));
const overview = {
  range: "1h", from: T0, to: T0 + 3600_000, stepSeconds: 60, generatedAt: new Date(T0 + 3600_000).toISOString(), sources: { prometheus: ok, runtime: ok },
  totals: { requests: 372, errors: 14, errorRate: 3.76, avgMs: 239.4, p50Ms: 209.5, p95Ms: 371.3, p99Ms: 387.6 },
  series: Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * 60_000, end: T0 + (i + 1) * 60_000, requests: wave(i), errors: i % 9 === 0 ? 1 : 0, avgMs: i % 13 === 0 ? null : 200 + wave(i) * 6, p95Ms: i % 13 === 0 ? null : 320 + wave(i) * 9 })),
  apis: [
    { name: "seaware-sys-api", kind: "service", exportsMetrics: true, requests: 240, errors: 4, errorRate: 1.67, avgMs: 231, p50Ms: 202, p95Ms: 345, p99Ms: 390, spark: Array.from({ length: 30 }, (_, i) => wave(i)) },
    { name: "reservation-mgr-exp-api", kind: "service", exportsMetrics: true, requests: 128, errors: 10, errorRate: 7.8, avgMs: 259, p50Ms: 242, p95Ms: 488, p99Ms: 520, spark: Array.from({ length: 30 }, (_, i) => wave(i + 7)) },
    { name: "sample-ship-list", kind: "flow", exportsMetrics: true, requests: 4, errors: 0, errorRate: 0, avgMs: null, p50Ms: 80, p95Ms: 120, p99Ms: null, spark: [] },
  ],
  notExporting: ["cms-proc-api", "loyalty-proc-api"],
};
const apiDetail = {
  name: "reservation-mgr-exp-api", range: "1h", from: T0, to: T0 + 3600_000, stepSeconds: 60, generatedAt: new Date(T0 + 3600_000).toISOString(), kind: "service", exportsMetrics: true, source: ok,
  totals: { requests: 128, errors: 10, errorRate: 7.8, avgMs: 259.3, p50Ms: 242.2, p95Ms: 488.3, p99Ms: 520.1 },
  series: Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * 60_000, end: T0 + (i + 1) * 60_000, requests: wave(i), errors: i % 9 === 0 ? 1 : 0, avgMs: 200 + wave(i) * 6, s2xx: wave(i) - (i % 9 === 0 ? 1 : 0), s3xx: 0, s4xx: i % 18 === 0 ? 1 : 0, s5xx: i % 18 === 9 ? 1 : 0, p50Ms: 190, p95Ms: 320 + wave(i) * 9, p99Ms: 420 })),
  byStatus: [{ group: "2xx", requests: 118 }, { group: "4xx", requests: 6 }, { group: "5xx", requests: 4 }],
  operations: [{ method: "POST", path: "/reservation_mgr_exp_api/v1/init", requests: 90, errors: 8, errorRate: 8.9, avgMs: 270.6, p95Ms: 488.3 }, { method: "GET", path: "/reservation_mgr_exp_api/v1/health", requests: 38, errors: 2, errorRate: 5.3, avgMs: 12.1, p95Ms: 30 }],
  latency: [{ quantile: "0.5", label: "p50", ms: 242.2 }, { quantile: "0.75", label: "p75", ms: 310 }, { quantile: "0.95", label: "p95", ms: 488.3 }, { quantile: "0.99", label: "p99", ms: 520.1 }],
  downstream: [{ peer: "reservation-common-proc-api.apps.svc", requests: 90, errors: 0, avgMs: 184.4 }],
  replicas: 1,
};
const brk = (key: string, label: string, requests: number, faults: number, extra: Record<string, string>) => ({ key, label, requests, errors: faults, faults, throttled: 0, cacheHits: 0, avgResponseMs: 178.7, avgBackendMs: 164.7, p95Ms: 500, share: requests / 527, lastAt: T0 + 3500_000, extra });
const gwSummary = {
  range: "24h", from: T0 - 82800_000, to: T0 + 3600_000, stepSeconds: 900,
  totals: { requests: 527, success: 204, clientErrors: 313, serverErrors: 10, faults: 300, throttled: 6, cacheHits: 12, avgResponseMs: 64.1, avgBackendMs: 56.7, avgMediationMs: 7.4, p50Ms: 20.7, p95Ms: 235.8, p99Ms: 660, backendP50Ms: 14.9, backendP95Ms: 231.1 },
  series: Array.from({ length: 96 }, (_, i) => ({ t: T0 - 82800_000 + i * 900_000, requests: i > 60 ? wave(i) + 4 : 0, s2xx: i > 60 ? wave(i) : 0, s3xx: 0, s4xx: i > 60 ? 3 : 0, s5xx: i > 60 && i % 7 === 0 ? 1 : 0, faults: i > 60 ? 3 : 0, throttled: 0, cacheHits: 0, avgResponseMs: i > 60 ? 60 + wave(i) : 0, avgBackendMs: i > 60 ? 50 + wave(i) : 0, p95Ms: i > 60 ? 230 : 0 })),
  byApi: [brk("cms-proc-api", "cms-proc-api", 310, 150, { version: "v1", context: "/cms/v1" }), brk("reservation-mgr-exp-api", "reservation-mgr-exp-api", 217, 150, { version: "v1", context: "/reservation/v1" })],
  byApp: [brk("UNKNOWN", "UNKNOWN", 300, 300, { owner: "UNKNOWN" }), brk("partner-portal", "partner-portal", 227, 0, { owner: "admin" })],
  byOperation: [brk("cms-proc-api GET /items/{id}", "GET /items/{id}", 160, 0, { api: "cms-proc-api", method: "GET", resource: "/items/{id}" }), brk("cms-proc-api  ", "", 150, 150, { api: "cms-proc-api", method: "", resource: "" })],
  byStatus: [{ status: 401, requests: 300 }, { status: 200, requests: 204 }, { status: 404, requests: 13 }, { status: 502, requests: 10 }],
  byErrorType: [{ errorType: "AUTH", requests: 294 }, { errorType: "THROTTLED", requests: 6 }],
  latencyHistogram: [{ label: "<10 ms", response: 20, backend: 40 }, { label: "10-50 ms", response: 110, backend: 105 }, { label: "50-250 ms", response: 60, backend: 50 }, { label: "250 ms-1 s", response: 30, backend: 28 }, { label: ">1 s", response: 7, backend: 4 }],
  apis: ["cms-proc-api", "reservation-mgr-exp-api"], apps: ["UNKNOWN", "partner-portal"],
};
const gwRows = [
  { ts: T0 + 3500_000, type: "response", api: "cms-proc-api", version: "v1", context: "/cms/v1", method: "GET", resource: "/items/{id}", app: "partner-portal", appOwner: "admin", user: "admin", keyType: "PRODUCTION", status: 200, targetStatus: 200, responseLatency: 182, backendLatency: 170, requestMediationLatency: 8, responseMediationLatency: 4, cacheHit: false, throttled: false, errorType: "", errorCode: 0, errorMessage: "", userAgent: "curl/8.5.0", userIp: "10.0.0.7", correlationId: "153486ff-5fd1-4263-b77f-4cf841aa0001", gatewayType: "SYNAPSE", platform: "", destination: "http://cms-proc-api.apps.svc/cms-proc-api/v1" },
  { ts: T0 + 3400_000, type: "fault", api: "cms-proc-api", version: "v1", context: "/cms/v1", method: "", resource: "", app: "UNKNOWN", appOwner: "UNKNOWN", user: "", keyType: "UNKNOWN", status: 401, targetStatus: null, responseLatency: 0, backendLatency: 0, requestMediationLatency: 0, responseMediationLatency: 0, cacheHit: false, throttled: false, errorType: "AUTH", errorCode: 900902, errorMessage: "AUTHENTICATION_FAILURE", userAgent: "", userIp: "", correlationId: "153486ff-5fd1-4263-b77f-4cf841aa0002", gatewayType: "SYNAPSE", platform: "", destination: "" },
];
const logSources = { list: [
  { id: "gw", label: "Gateway", kind: "gateway", replicas: 2 }, { id: "svc:cms-proc-api", label: "cms-proc-api", kind: "service", replicas: 1 },
  { id: "svc:reservation-mgr-exp-api", label: "reservation-mgr-exp-api", kind: "service", replicas: 1 }, { id: "flow:fl_1", label: "sample-ship-list", kind: "flow", replicas: 1 },
  { id: "svc:intg-postgres", label: "intg-postgres", kind: "component", replicas: 1 },
], errors: [] };
const logLine = (i: number, level: string, msg: string, cid = "") => ({ t: T0 + 3000_000 + i * 1500, source: i % 3 === 0 ? "svc:reservation-mgr-exp-api" : "svc:cms-proc-api", pod: "cms-proc-api-5b9f589f69-8zhcx", level, msg, cid, text: `2026-11-14T09:50:0${i % 10}.000Z ${level} ${msg}` });
const logs = {
  lines: [
    logLine(0, "INFO", "Started CmsApplication in 4.2 seconds"), logLine(1, "INFO", "GET /cms-proc-api/v1/descriptions/ports 200 in 182 ms", "153486ff-5fd1-4263-b77f-4cf841aa0001"),
    logLine(2, "WARN", "Slow response from the content store: 1240 ms"), logLine(3, "ERROR", "Could not reach the reservation backend: connection refused. Retrying in 2 seconds (attempt 2 of 3) with a deliberately long message so that wrapping is exercised on narrow screens.", "153486ff-5fd1-4263-b77f-4cf841aa0003"),
    logLine(4, "", "plain line without a level"), logLine(5, "DEBUG", "cache miss key=ports"),
  ],
  matched: 6, scanned: 6, limit: 500,
  sources: [{ id: "svc:cms-proc-api", label: "cms-proc-api", replicas: ["cms-proc-api-5b9f589f69-8zhcx"], lines: 4 }, { id: "svc:reservation-mgr-exp-api", label: "reservation-mgr-exp-api", replicas: ["reservation-mgr-exp-api-7c9d-abcde"], lines: 2 }],
  generatedAt: new Date(T0 + 3600_000).toISOString(),
};

export async function mockApi(page: Page, opts: { signedIn?: boolean } = {}) {
  const json = (data: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  await page.route("**/healthz", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "UP" }) }));
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/auth/me")) {
      if (opts.signedIn === false) return route.fulfill({ status: 401, contentType: "application/problem+json", body: JSON.stringify({ title: "no", status: 401 }) });
      return route.fulfill(json({ user: "admin", role: "admin" }));
    }
    if (url.includes("/api/compliance/")) return route.fulfill(json({ apiId: "1", violations: [{ ruleName: "Define rate limiting", severity: "ERROR", message: "No throttling policy set", path: "/x" }] }));
    if (url.includes("/api/compliance")) return route.fulfill(json(compliance));
    if (url.includes("/api/ratelimits")) return route.fulfill(json(subPolicies));
    if (url.includes("/api/environments")) return route.fulfill(json(environments));
    if (url.includes("/api/key-managers")) return route.fulfill(json(keyManagers));
    if (url.includes("/api/workflows")) return route.fulfill(json(workflows));
    if (url.includes("/api/apis")) return route.fulfill(json(apis));
    if (url.includes("/api/inventory")) return route.fulfill(json(inventory));
    if (url.includes("/api/analytics/overview")) return route.fulfill(json(overview));
    if (url.includes("/api/analytics/api/")) return route.fulfill(json(apiDetail));
    if (url.includes("/api/gateway-analytics/summary")) return route.fulfill(json({ status: gwStatus, summary: gwSummary }));
    if (url.includes("/api/gateway-analytics/requests")) return route.fulfill(json({ status: gwStatus, total: 527, kept: 527, rows: gwRows }));
    if (url.includes("/api/gateway-analytics/status")) return route.fulfill(json(gwStatus));
    if (url.includes("/api/logs/sources")) return route.fulfill(json(logSources));
    if (url.includes("/api/logs")) return route.fulfill(json(logs));
    return route.fulfill(json({ ok: true }));
  });
}
