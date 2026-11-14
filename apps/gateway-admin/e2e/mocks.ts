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
    return route.fulfill(json({ ok: true }));
  });
}
