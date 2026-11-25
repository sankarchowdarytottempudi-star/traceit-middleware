import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planPolicies, readPolicies } from "../src/rules/model.js";
import { checkPolicies, isBuiltIn } from "../src/rules/validate.js";
import { registerRuleRoutes } from "../src/rules/routes.js";
import { registerRoutes } from "../src/routes.js";
import { createAudit } from "../src/rules/audit.js";

const api = {
  id: "a1", name: "orders", transport: ["http", "https"], apiKeyHeader: "ApiKey", responseCachingEnabled: false, cacheTimeout: 300, maxTps: null,
  endpointConfig: { endpoint_type: "http", production_endpoints: { url: "http://x" }, sandbox_endpoints: { url: "http://x" } },
  operations: [{ verb: "GET", target: "/o", operationPolicies: { request: [{ policyName: "weaveAddressFilter", parameters: {} }, { policyName: "rewriteResourcePath", parameters: {} }], response: [], fault: [] } }],
};
const base = { ...readPolicies(api) };

describe("gateway policies", () => {
  it("reads defaults honestly", () => {
    expect(base).toMatchObject({ apiKeyHeader: "ApiKey", caching: { enabled: false }, jsonThreat: null, httpsOnly: false, schemaValidation: false, addHeaders: [], removeHeaders: [] });
  });
  it("validates input", () => {
    expect(() => checkPolicies({ ...base, apiKeyHeader: "bad header" })).toThrow(/API key header/);
    expect(() => checkPolicies({ ...base, jsonThreat: { maxJsonDepth: 1000, maxPropertyCount: 1, maxStringLength: 1, maxArrayElementCount: 1 } })).toThrow(/Max JSON depth/);
    expect(() => checkPolicies({ ...base, addHeaders: [{ name: "Authorization", value: "x" }] })).toThrow(/managed by the gateway/);
    expect(() => checkPolicies({ ...base, endpoint: { timeoutMs: 10 } })).toThrow(/Backend timeout/);
  });
  it("builds the definition and says what changes", () => {
    const v = checkPolicies({ ...base, httpsOnly: true, caching: { enabled: true, seconds: 60 }, endpoint: { timeoutMs: 15000, suspendMs: null },
      jsonThreat: { maxJsonDepth: 5, maxPropertyCount: 20, maxStringLength: 100, maxArrayElementCount: 50, maxKeyLength: 50 }, addHeaders: [{ name: "X-A", value: "1" }] });
    const p = planPolicies(api, v, { jsonValidator: "j1", addHeader: "h1" });
    expect(p.body.transport).toEqual(["https"]);
    expect(p.body.endpointConfig.production_endpoints.config).toEqual({ actionDuration: "15000", actionSelect: "fault" });
    const req = p.body.operations[0].operationPolicies.request.map((x: any) => x.policyName);
    expect(req).toEqual(["weaveAddressFilter", "jsonValidator", "addHeader", "rewriteResourcePath"]);
    expect(p.body.operations[0].operationPolicies.request[1]).toMatchObject({ policyId: "j1", policyType: "common", parameters: { maxJsonDepth: "5" } });
    expect(p.changes.some((c) => c.startsWith("JSON threat protection: off → on (depth ≤ 5"))).toBe(true);
    expect(p.changes.some((c) => c === "Plain HTTP: accepted → refused (HTTPS only).")).toBe(true);
    expect(planPolicies(api, checkPolicies(base), {}).changes).toEqual([]);
  });
  it("knows the built-in policies", () => {
    expect(isBuiltIn("advanced", "10KPerMin")).toBe(true);
    expect(isBuiltIn("advanced", "AroyaApiLimit")).toBe(false);
  });
});

const BASE = "https://apim.test";
let app: FastifyInstance;
beforeEach(async () => {
  nock.disableNetConnect();
  app = Fastify();
  app.decorate("tokenForRequest", async () => "tok");
  app.decorate("userForRequest", async () => "ops.lead");
  app.decorate("serviceToken", async () => "svc");
  const cfg: any = { APIM_BASE_URL: BASE, caPem: "", DATA_DIR: mkdtempSync(join(tmpdir(), "gw-")) };
  const audit = createAudit(join(cfg.DATA_DIR, "a.jsonl"));
  registerRoutes(app, cfg, audit);
  registerRuleRoutes(app, cfg, { audit });
  app.setErrorHandler((e: any, _r, reply) => { reply.code(e.statusCode ?? 500).send({ title: e.message }); });
  await app.ready();
});
afterEach(async () => { await app.close(); nock.cleanAll(); nock.enableNetConnect(); });

describe("safe policy clean-up", () => {
  it("never deletes built-in or used policies", async () => {
    const P = "/api/am/publisher/v4", A = "/api/am/admin/v4";
    nock(BASE).get(`${P}/apis?limit=500`).times(2).reply(200, { list: [{ id: "a1", name: "orders" }] })
      .get(`${P}/apis/a1`).reply(200, { id: "a1", name: "orders", policies: ["Unlimited"], apiThrottlingPolicy: "Used1", operations: [] })
      .get(`${P}/apis/a1/deployments`).reply(200, []).get(`${P}/subscriptions?apiId=a1&limit=200`).reply(200, { list: [] })
      .get(`${A}/applications?limit=500`).reply(200, { list: [] })
      .get(`${A}/throttling/policies/advanced`).reply(200, { list: [{ policyName: "Used1", policyId: "p1" }, { policyName: "Free1", policyId: "p2" }, { policyName: "10KPerMin", policyId: "p3" }] })
      .delete(`${A}/throttling/policies/advanced/p2`).reply(200, {});
    const r = await app.inject({ method: "POST", url: "/api/rules/policies/cleanup", payload: { kind: "advanced", names: ["Used1", "Free1", "10KPerMin"] } });
    expect(r.json().results).toEqual([
      { name: "Used1", action: "skip", reason: "in use (1 API uses, 0 subscriptions, 0 applications)", outcome: "skipped" },
      { name: "Free1", outcome: "deleted" },
      { name: "10KPerMin", action: "skip", reason: "built into API Manager", outcome: "skipped" },
    ]);
    expect(nock.pendingMocks()).toEqual([]);
  });
});

describe("governance", () => {
  it("reads real compliance results and rule findings with how to fix", async () => {
    const G = "/api/am/governance/v1";
    nock(BASE).get(`${G}/artifact-compliance/api?limit=500`).reply(200, { list: [{ id: "11111111-2222-3333-4444-555555555555", status: "NON_COMPLIANT", info: { name: "orders", version: "v1" },
        severityBasedRuleViolationSummary: [{ severity: "WARN", violatedRulesCount: 3 }, { severity: "ERROR", violatedRulesCount: 1 }] }] })
      .get(`${G}/artifact-compliance/api/summary`).reply(200, { total: 1, compliant: 0, nonCompliant: 1, notApplicable: 0 })
      .get(`${G}/policies?limit=100`).reply(200, { list: [{ id: "p", name: "Best Practices", labels: ["GLOBAL"], governableStates: ["API_UPDATE"], rulesets: ["r1"], actions: [] }] })
      .get(`${G}/rulesets?limit=100`).reply(200, { list: [{ id: "r1", name: "OWASP Top 10", documentationLink: "https://docs" }] });
    const s = (await app.inject({ method: "GET", url: "/api/compliance" })).json();
    expect(s).toMatchObject({ available: true, governed: 1, compliant: 0, errors: 1, warnings: 3, policies: [{ name: "Best Practices", rulesets: ["OWASP Top 10"], labels: ["GLOBAL"] }] });
    nock(BASE).get(`${G}/artifact-compliance/api/11111111-2222-3333-4444-555555555555`).reply(200, { governedPolicies: [{ name: "Best Practices", rulesetValidationResults: [{ id: "r1", name: "OWASP Top 10", status: "FAILED" }] }] })
      .get(`${G}/artifact-compliance/api/11111111-2222-3333-4444-555555555555/ruleset-validation-results/r1`).reply(200, { violatedRules: [{ name: "info-contact", severity: "WARN", message: "Info object should have contact", violatedPath: { path: "[info][contact]" }, description: "Add a contact object." }] });
    const d = (await app.inject({ method: "GET", url: "/api/compliance/11111111-2222-3333-4444-555555555555" })).json();
    expect(d.violations[0]).toEqual({ ruleName: "info-contact", severity: "WARN", message: "Info object should have contact", path: "[info][contact]", fix: "Add a contact object.", ruleset: "OWASP Top 10", policy: "Best Practices" });
  });
  it("says plainly when governance is not enabled", async () => {
    const G = "/api/am/governance/v1";
    nock(BASE).get(`${G}/artifact-compliance/api?limit=500`).reply(404, "").get(`${G}/artifact-compliance/api/summary`).reply(404, "")
      .get(`${G}/policies?limit=100`).reply(404, "").get(`${G}/rulesets?limit=100`).reply(404, "");
    const s = (await app.inject({ method: "GET", url: "/api/compliance" })).json();
    expect(s.available).toBe(false); expect(s.reason).toMatch(/not enabled/);
  });
});
