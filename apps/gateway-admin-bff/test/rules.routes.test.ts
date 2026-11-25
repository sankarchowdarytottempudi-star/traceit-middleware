import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRuleRoutes } from "../src/rules/routes.js";
import { registerRoutes } from "../src/routes.js";
import { createAudit } from "../src/rules/audit.js";

const BASE = "https://apim.test";
const PUB = "/api/am/publisher/v4", ADMIN = "/api/am/admin/v4", DEV = "/api/am/devportal/v3";
const ID = "11111111-2222-3333-4444-555555555555";
const APP = "aaaaaaaa-2222-3333-4444-555555555555";
const SUB = "bbbbbbbb-2222-3333-4444-555555555555";

const apiDef = () => ({
  id: ID, name: "cs-gw-test-orders", context: "/cs-gw-test-orders", version: "v1", lifeCycleStatus: "PUBLISHED", provider: "admin",
  policies: ["Unlimited"], apiThrottlingPolicy: null, securityScheme: ["oauth2", "oauth_basic_auth_api_key_mandatory"],
  corsConfiguration: { corsConfigurationEnabled: false, accessControlAllowOrigins: ["*"], accessControlAllowHeaders: [], accessControlAllowMethods: [], accessControlAllowCredentials: false },
  operations: [{ verb: "GET", target: "/orders", authType: "Application & Application User", throttlingPolicy: "Unlimited" }],
});
const subPolicies = { list: [{ policyName: "Unlimited", defaultLimit: { type: "REQUESTCOUNTLIMIT", requestCount: { requestCount: 2147483647, timeUnit: "min", unitTime: 1 } } },
  { policyName: "Gold", defaultLimit: { type: "REQUESTCOUNTLIMIT", requestCount: { requestCount: 5000, timeUnit: "min", unitTime: 1 } } }] };
const advPolicies = { list: [{ policyName: "cs-gw-test-3", defaultLimit: { type: "REQUESTCOUNTLIMIT", requestCount: { requestCount: 3, timeUnit: "min", unitTime: 1 } } }] };
const revisions = (n: number) => ({ list: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, displayName: `Revision ${i + 1}`, createdTime: 1000 + i, deploymentInfo: i === n - 1 ? [{ name: "Default", vhost: "localhost" }] : [] })) });

let app: FastifyInstance; let auditFile: string; let userToken: string | null;

function policiesMock() {
  nock(BASE).get(`${ADMIN}/throttling/policies/subscription`).reply(200, subPolicies)
    .get(`${ADMIN}/throttling/policies/advanced`).reply(200, advPolicies)
    .get(`${ADMIN}/throttling/policies/application`).reply(200, { list: [] });
}
/** The person's token sees the API list (so no fallback). */
function seesApis(token = "user-tok") { nock(BASE, { reqheaders: { authorization: `Bearer ${token}` } }).get(`${PUB}/apis?limit=500`).reply(200, { list: [apiDef()] }); }

beforeEach(async () => {
  nock.disableNetConnect();
  auditFile = join(mkdtempSync(join(tmpdir(), "gw-audit-")), "audit.jsonl");
  userToken = "user-tok";
  app = Fastify();
  app.decorate("tokenForRequest", async () => userToken);
  app.decorate("userForRequest", async () => "ops.lead");
  app.decorate("serviceToken", async () => "svc-tok");
  const cfg: any = { APIM_BASE_URL: BASE, caPem: "", DATA_DIR: "", GATEWAY_STAGE: "production" };
  const audit = createAudit(auditFile);
  registerRoutes(app, cfg, audit);
  registerRuleRoutes(app, cfg, { audit });
  app.setErrorHandler((e: any, _r, reply) => { reply.code(e.statusCode ?? 500).send({ title: e.message, status: e.statusCode ?? 500 }); });
  await app.ready();
});
afterEach(async () => { await app.close(); nock.cleanAll(); nock.enableNetConnect(); });
const auditLines = () => (existsSync(auditFile) ? readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

describe("who can see the APIs", () => {
  it("refuses callers who are not signed in", async () => {
    userToken = null;
    expect((await app.inject({ method: "GET", url: "/api/rules/apis" })).statusCode).toBe(401);
  });
  it("falls back to the service credentials when the person's token sees no APIs", async () => {
    nock(BASE, { reqheaders: { authorization: "Bearer user-tok" } }).get(`${PUB}/apis?limit=500`).reply(200, { list: [] });
    nock(BASE, { reqheaders: { authorization: "Bearer svc-tok" } }).get(`${PUB}/apis?limit=500`).reply(200, { list: [apiDef()] });
    const r = await app.inject({ method: "GET", url: "/api/rules/apis" });
    expect(r.json()).toMatchObject({ via: "service", list: [{ id: ID, name: "cs-gw-test-orders" }] });
  });
});

describe("traffic limits on a live API", () => {
  const body = { tiers: ["Gold"], apiPolicy: "cs-gw-test-3", operations: [] };
  it("previews in plain words without touching the gateway", async () => {
    seesApis();
    nock(BASE).get(`${PUB}/apis/${ID}`).reply(200, apiDef()); policiesMock();
    nock(BASE).get(`${PUB}/apis/${ID}/deployments`).reply(200, [{ name: "Default", vhost: "localhost", revisionUuid: "r4" }])
      .get(`${PUB}/apis/${ID}/revisions`).reply(200, revisions(5));
    const r = await app.inject({ method: "POST", url: `/api/rules/apis/${ID}/traffic?preview=1`, payload: body });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.applied).toBe(false);
    expect(j.sentence).toBe("This changes the live gateway for cs-gw-test-orders in Production (Default (localhost)). Gateways pick it up within about 15 seconds of saving.");
    expect(j.changes).toEqual([
      "Plans consumers can pick: Unlimited → Gold. Each plan is a limit per consumer application: Gold (5,000 requests per minute per consumer application).",
      "Limit for the whole API: no limit → cs-gw-test-3 (3 requests per minute, shared by every caller of this API).",
    ]);
    expect(j.pruneRevision).toEqual({ id: "r0", displayName: "Revision 1" });
    expect(nock.pendingMocks()).toEqual([]);
    expect(auditLines()).toEqual([]);
  });
  it("applies: update, make room, new revision, deploy, audit", async () => {
    seesApis();
    nock(BASE).get(`${PUB}/apis/${ID}`).reply(200, apiDef()); policiesMock();
    nock(BASE).get(`${PUB}/apis/${ID}/deployments`).reply(200, [{ name: "Default", vhost: "localhost", revisionUuid: "r4" }])
      .get(`${PUB}/apis/${ID}/revisions`).reply(200, revisions(5))
      .put(`${PUB}/apis/${ID}`, (b: any) => b.apiThrottlingPolicy === "cs-gw-test-3" && b.policies[0] === "Gold").reply(200, {})
      .delete(`${PUB}/apis/${ID}/revisions/r0`).reply(200, {})
      .post(`${PUB}/apis/${ID}/revisions`, (b: any) => /^traffic limits by ops\.lead/.test(b.description) && b.description.length <= 250).reply(201, { id: "r9", displayName: "Revision 9" })
      .post(`${PUB}/apis/${ID}/deploy-revision?revisionId=r9`, (b: any) => b[0].name === "Default" && b[0].vhost === "localhost").reply(201, []);
    const r = await app.inject({ method: "POST", url: `/api/rules/apis/${ID}/traffic`, payload: body });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ applied: true, revision: { id: "r9", displayName: "Revision 9" } });
    expect(nock.pendingMocks()).toEqual([]);
    const [line] = auditLines();
    expect(line).toMatchObject({ user: "ops.lead", action: "traffic limits", apiId: ID, apiName: "cs-gw-test-orders", outcome: "ok", revision: "Revision 9", environment: "Default (localhost)" });
    expect(line.after).toMatch(/cs-gw-test-3/); expect(line.detail).toMatch(/Revision 1/);
  });
  it("says honestly when the change was saved but did not go live", async () => {
    seesApis();
    nock(BASE).get(`${PUB}/apis/${ID}`).reply(200, apiDef()); policiesMock();
    nock(BASE).get(`${PUB}/apis/${ID}/deployments`).reply(200, [{ name: "Default", vhost: "localhost", revisionUuid: "r1" }])
      .get(`${PUB}/apis/${ID}/revisions`).reply(200, revisions(2))
      .put(`${PUB}/apis/${ID}`).reply(200, {})
      .post(`${PUB}/apis/${ID}/revisions`).reply(201, { id: "r9", displayName: "Revision 9" })
      .post(`${PUB}/apis/${ID}/deploy-revision?revisionId=r9`).reply(500, { code: 500, message: "Internal error" });
    const r = await app.inject({ method: "POST", url: `/api/rules/apis/${ID}/traffic`, payload: body });
    expect(r.statusCode).toBe(502);
    expect(r.json().title).toMatch(/^Saved on API Manager but not live: could not deploy the revision/);
    expect(auditLines()[0]).toMatchObject({ outcome: "failed", action: "traffic limits" });
  });
  it("rejects invalid input before calling API Manager for writes", async () => {
    seesApis();
    nock(BASE).get(`${PUB}/apis/${ID}`).reply(200, apiDef()); policiesMock();
    const r = await app.inject({ method: "POST", url: `/api/rules/apis/${ID}/traffic`, payload: { tiers: ["Platinum"], apiPolicy: null, operations: [] } });
    expect(r.statusCode).toBe(400); expect(r.json().title).toMatch(/Plan "Platinum" does not exist/);
    expect((await app.inject({ method: "POST", url: `/api/rules/apis/not-an-id/traffic`, payload: body })).statusCode).toBe(400);
  });
});

describe("access", () => {
  it("uploads the address policy once and attaches it before the update", async () => {
    seesApis();
    nock(BASE).get(`${PUB}/apis/${ID}`).reply(200, apiDef())
      .get(`${PUB}/apis/${ID}/operation-policies?limit=100`).reply(200, { list: [] })
      .get(`${PUB}/apis/${ID}/deployments`).reply(200, [{ name: "Default", vhost: "localhost", revisionUuid: "r1" }])
      .get(`${PUB}/apis/${ID}/revisions`).reply(200, revisions(2))
      .post(`${PUB}/apis/${ID}/operation-policies`, (b: string) => b.includes('name="policySpecFile"') && b.includes("weaveAddressFilter") && b.includes("{% if denyRegex %}")).reply(201, { id: "pol-7" })
      .put(`${PUB}/apis/${ID}`, (b: any) => b.operations[0].operationPolicies.request[0].policyId === "pol-7" && b.operations[0].operationPolicies.request[0].parameters.denyList === "10.0.0.0/8")
      .reply(200, {})
      .post(`${PUB}/apis/${ID}/revisions`).reply(201, { id: "r9", displayName: "Revision 3" })
      .post(`${PUB}/apis/${ID}/deploy-revision?revisionId=r9`).reply(201, []);
    const r = await app.inject({ method: "POST", url: `/api/rules/apis/${ID}/access`, payload: {
      security: "oauth2", cors: { enabled: false, origins: [], headers: [], methods: [], credentials: false }, ipAllow: [], ipDeny: ["10.0.0.0/8"] } });
    expect(r.statusCode).toBe(200);
    expect(r.json().changes).toEqual(["Addresses blocked: none → 10.0.0.0/8."]);
    expect(nock.pendingMocks()).toEqual([]);
  });
  it("refuses to open a production API without the typed confirmation", async () => {
    seesApis();
    nock(BASE).get(`${PUB}/apis/${ID}`).reply(200, apiDef());
    const r = await app.inject({ method: "POST", url: `/api/rules/apis/${ID}/access?preview=1`, payload: {
      security: "none", cors: { enabled: false, origins: [], headers: [], methods: [], credentials: false }, ipAllow: [], ipDeny: [] } });
    expect(r.statusCode).toBe(400); expect(r.json().title).toMatch(/callable by anyone/);
  });
});

describe("rollback", () => {
  it("restores and deploys an earlier revision", async () => {
    seesApis();
    nock(BASE).get(`${PUB}/apis/${ID}`).reply(200, apiDef())
      .get(`${PUB}/apis/${ID}/revisions`).reply(200, revisions(3))
      .get(`${PUB}/apis/${ID}/deployments`).reply(200, [{ name: "Default", vhost: "localhost", revisionUuid: "r2" }])
      .post(`${PUB}/apis/${ID}/restore-revision?revisionId=r0`).reply(201, {})
      .post(`${PUB}/apis/${ID}/deploy-revision?revisionId=r0`).reply(201, []);
    const r = await app.inject({ method: "POST", url: `/api/rules/apis/${ID}/rollback`, payload: { revisionId: "r0" } });
    expect(r.statusCode).toBe(400); // r0 is not an id shape: guarded
    nock.cleanAll();
  });
  it("restores and deploys an earlier revision (real ids)", async () => {
    const R0 = "cccccccc-2222-3333-4444-555555555555", R2 = "dddddddd-2222-3333-4444-555555555555";
    seesApis();
    nock(BASE).get(`${PUB}/apis/${ID}`).reply(200, apiDef())
      .get(`${PUB}/apis/${ID}/revisions`).reply(200, { list: [{ id: R0, displayName: "Revision 1", description: "before", createdTime: 1, deploymentInfo: [] }, { id: R2, displayName: "Revision 2", createdTime: 2, deploymentInfo: [{ name: "Default" }] }] })
      .get(`${PUB}/apis/${ID}/deployments`).reply(200, [{ name: "Default", vhost: "localhost", revisionUuid: R2 }])
      .post(`${PUB}/apis/${ID}/restore-revision?revisionId=${R0}`).reply(201, {})
      .post(`${PUB}/apis/${ID}/deploy-revision?revisionId=${R0}`).reply(201, []);
    const r = await app.inject({ method: "POST", url: `/api/rules/apis/${ID}/rollback`, payload: { revisionId: R0 } });
    expect(r.statusCode).toBe(200);
    expect(r.json().changes[0]).toBe('Live definition: Revision 2 → Revision 1 ("before").');
    expect(auditLines()[0]).toMatchObject({ action: "roll back", before: "Revision 2", after: "Revision 1", outcome: "ok" });
  });
});

describe("blocking rules", () => {
  it("validates, creates and audits", async () => {
    seesApis();
    nock(BASE).post(`${ADMIN}/throttling/deny-policies`, (b: any) => b.conditionType === "IPRANGE" && b.conditionValue.startingIp === "10.9.0.0").reply(201, { conditionId: "dddddddd-0000-0000-0000-000000000001" });
    const r = await app.inject({ method: "POST", url: "/api/rules/blocking", payload: { type: "IPRANGE", value: "10.9.0.0/16" } });
    expect(r.statusCode).toBe(201);
    expect(auditLines()[0]).toMatchObject({ action: "add blocking rule", target: "Addresses 10.9.0.0 to 10.9.255.255", outcome: "ok" });
    const bad = await app.inject({ method: "POST", url: "/api/rules/blocking", payload: { type: "IP", value: "10.9.0" } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("applications and keys", () => {
  it("shows a new secret once and never on read", async () => {
    seesApis();
    nock(BASE).get(`${DEV}/applications/${APP}`).times(2).reply(200, { applicationId: APP, name: "cs-gw-test-app", throttlingPolicy: "Unlimited" })
      .get(`${DEV}/key-managers`).reply(200, { list: [{ name: "Resident Key Manager", enabled: true }] })
      .get(`${DEV}/applications/${APP}/oauth-keys`).reply(200, { list: [] })
      .post(`${DEV}/applications/${APP}/generate-keys`, (b: any) => b.keyType === "PRODUCTION" && b.keyManager === "Resident Key Manager").reply(200, { keyMappingId: "k1", keyType: "PRODUCTION", consumerKey: "ck", consumerSecret: "cs" })
      .get(`${DEV}/applications/${APP}/oauth-keys`).reply(200, { list: [{ keyMappingId: "k1", keyType: "PRODUCTION", consumerKey: "ck", consumerSecret: "cs" }] })
      .get(`${DEV}/subscriptions?applicationId=${APP}&limit=200`).reply(200, { list: [] });
    const g = await app.inject({ method: "POST", url: `/api/rules/applications/${APP}/keys`, payload: { keyType: "PRODUCTION" } });
    expect(g.json()).toMatchObject({ consumerKey: "ck", consumerSecret: "cs", shownOnce: true });
    const d = await app.inject({ method: "GET", url: `/api/rules/applications/${APP}` });
    expect(JSON.stringify(d.json())).not.toContain('"cs"');
    expect(auditLines()[0]).toMatchObject({ action: "generate keys", outcome: "ok" });
    expect(JSON.stringify(auditLines())).not.toContain('"cs"');
  });
  it("needs the typed name before removing keys", async () => {
    seesApis();
    nock(BASE).get(`${DEV}/applications/${APP}`).reply(200, { applicationId: APP, name: "cs-gw-test-app" });
    const r = await app.inject({ method: "POST", url: `/api/rules/applications/${APP}/keys/eeeeeeee-0000-0000-0000-000000000001/revoke`, payload: {} });
    expect(r.statusCode).toBe(400);
  });
  it("only subscribes with a plan the API offers", async () => {
    seesApis();
    nock(BASE).get(`${DEV}/applications/${APP}`).reply(200, { applicationId: APP, name: "cs-gw-test-app" }).get(`${PUB}/apis/${ID}`).reply(200, apiDef());
    const r = await app.inject({ method: "POST", url: `/api/rules/applications/${APP}/subscriptions`, payload: { apiId: ID, plan: "Gold" } });
    expect(r.statusCode).toBe(400); expect(r.json().title).toMatch(/does not offer plan Gold/);
  });
});

describe("consumers", () => {
  it("blocks a subscription and records it", async () => {
    seesApis();
    nock(BASE).get(`${PUB}/apis/${ID}`).reply(200, apiDef())
      .get(`${PUB}/subscriptions?apiId=${ID}&limit=200`).reply(200, { list: [{ subscriptionId: SUB, applicationInfo: { name: "cs-gw-test-app" }, subscriptionStatus: "UNBLOCKED", throttlingPolicy: "Unlimited" }] })
      .post(`${PUB}/subscriptions/block-subscription?subscriptionId=${SUB}&blockState=BLOCKED`).reply(200, {});
    const r = await app.inject({ method: "POST", url: `/api/rules/subscriptions/${SUB}/state`, payload: { state: "BLOCKED", apiId: ID } });
    expect(r.statusCode).toBe(200);
    expect(auditLines()[0]).toMatchObject({ action: "subscription state", before: "active", after: "blocked (no calls)", outcome: "ok" });
  });
});

describe("rate limiting screen writes", () => {
  it("validates and audits policy creation", async () => {
    nock(BASE).post(`${ADMIN}/throttling/policies/advanced`).reply(201, { policyId: "p1" });
    const ok = await app.inject({ method: "POST", url: "/api/ratelimits/advanced", payload: { policyName: "cs_gw_test_9", defaultLimit: { type: "REQUESTCOUNTLIMIT", requestCount: { requestCount: 9, timeUnit: "min", unitTime: 1 } } } });
    expect(ok.statusCode).toBe(201);
    expect(auditLines()[0]).toMatchObject({ action: "create advanced limit", target: "cs_gw_test_9", after: "9 requests per minute", outcome: "ok" });
    expect((await app.inject({ method: "POST", url: "/api/ratelimits/deny", payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/ratelimits/advanced", payload: { policyName: "x y", defaultLimit: { type: "REQUESTCOUNTLIMIT", requestCount: { requestCount: 9, timeUnit: "min" } } } })).statusCode).toBe(400);
  });
});
