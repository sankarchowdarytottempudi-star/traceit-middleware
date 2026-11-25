import { describe, it, expect } from "vitest";
import {
  addressesRegex, blockBody, checkAccess, checkApp, checkTraffic, cidrRange, newPolicyBody, normaliseAddresses, rateWords,
} from "../src/rules/validate.js";
import { planAccess, planTraffic, readAddresses, readSecurity, revisionToPrune, securityPatch, policyWords, type PolicyBook } from "../src/rules/model.js";

const ops = [{ verb: "GET", target: "/orders" }, { verb: "POST", target: "/orders" }];
const known = { subscription: ["Gold", "Unlimited", "cs-gw-test-plan"], advanced: ["10PerMin", "AroyaApiLimit"] };
const book: PolicyBook = {
  subscription: [{ name: "Gold", limit: 5000, timeUnit: "min", unitTime: 1, quotaType: "REQUESTCOUNTLIMIT" }, { name: "Unlimited", limit: 2147483647, timeUnit: "min", unitTime: 1 }],
  advanced: [{ name: "10PerMin", limit: 10, timeUnit: "min", unitTime: 1, quotaType: "REQUESTCOUNTLIMIT" }, { name: "AroyaApiLimit", limit: 500, timeUnit: "min", unitTime: 1, quotaType: "REQUESTCOUNTLIMIT" }],
};
const api = {
  id: "a1", name: "orders", policies: ["Unlimited"], apiThrottlingPolicy: null, securityScheme: ["oauth2", "oauth_basic_auth_api_key_mandatory"],
  corsConfiguration: { corsConfigurationEnabled: false, accessControlAllowOrigins: ["*"], accessControlAllowHeaders: ["authorization"], accessControlAllowMethods: ["GET"], accessControlAllowCredentials: false },
  operations: [
    { verb: "GET", target: "/orders", authType: "Application & Application User", throttlingPolicy: "Unlimited", operationPolicies: { request: [{ policyName: "addHeader", parameters: {} }], response: [], fault: [] } },
    { verb: "POST", target: "/orders", authType: "Application & Application User", throttlingPolicy: "Unlimited" },
  ],
};

describe("plain words", () => {
  it("says limits like a person would", () => {
    expect(rateWords(100, "min")).toBe("100 requests per minute");
    expect(rateWords(1, "sec")).toBe("1 request per second");
    expect(rateWords(1000, "min", 5)).toBe("1,000 requests every 5 minutes");
    expect(rateWords(2147483647, "min")).toBe("no limit");
    expect(policyWords("Gold", book.subscription, "plan")).toBe("Gold (5,000 requests per minute per consumer application)");
    expect(policyWords("10PerMin", book.advanced, "api")).toBe("10PerMin (10 requests per minute, shared by every caller of this API)");
    expect(policyWords("Nope", book.advanced, "api")).toMatch(/not found/);
  });
});

describe("traffic validation", () => {
  it("accepts a valid change and normalises it", () => {
    const v = checkTraffic({ tiers: ["Gold", " Gold "], apiPolicy: "", operations: [{ verb: "get", target: "/orders", policy: "10PerMin" }] }, ops, known);
    expect(v).toEqual({ tiers: ["Gold"], apiPolicy: null, operations: [{ verb: "GET", target: "/orders", policy: "10PerMin" }], environments: undefined });
  });
  it("refuses empty plans, unknown policies, foreign operations and mixed levels", () => {
    expect(() => checkTraffic({ tiers: [], apiPolicy: null, operations: [] }, ops, known)).toThrow(/at least one plan/);
    expect(() => checkTraffic({ tiers: ["Platinum"], apiPolicy: null, operations: [] }, ops, known)).toThrow(/Plan "Platinum" does not exist/);
    expect(() => checkTraffic({ tiers: ["Gold"], apiPolicy: "Huge", operations: [] }, ops, known)).toThrow(/Limit "Huge" does not exist/);
    expect(() => checkTraffic({ tiers: ["Gold"], apiPolicy: null, operations: [{ verb: "DELETE", target: "/x", policy: null }] }, ops, known)).toThrow(/not part of this API/);
    expect(() => checkTraffic({ tiers: ["Gold"], apiPolicy: "10PerMin", operations: [{ verb: "GET", target: "/orders", policy: "AroyaApiLimit" }] }, ops, known)).toThrow(/either one limit for the whole API/);
    expect(() => checkTraffic({ tiers: "Gold" }, ops, known)).toThrow(/expected shape/);
  });
});

describe("access validation", () => {
  const base = { security: "oauth2", cors: { enabled: true, origins: ["https://app.example.com/"], headers: ["Authorization"], methods: ["get"], credentials: false }, ipAllow: [], ipDeny: [] };
  it("normalises origins and methods", () => {
    const v = checkAccess(base, { apiName: "orders", stage: "production" });
    expect(v.cors.origins).toEqual(["https://app.example.com"]); expect(v.cors.methods).toEqual(["GET"]);
  });
  it("refuses unsafe or malformed settings", () => {
    expect(() => checkAccess({ ...base, cors: { ...base.cors, origins: ["*"], credentials: true } }, { apiName: "orders", stage: "uat" })).toThrow(/credentials with origin \*/);
    expect(() => checkAccess({ ...base, cors: { ...base.cors, origins: ["app.example.com/x"] } }, { apiName: "orders", stage: "uat" })).toThrow(/not a web origin/);
    expect(() => checkAccess({ ...base, cors: { ...base.cors, headers: ["bad header"] } }, { apiName: "orders", stage: "uat" })).toThrow(/not a valid header/);
    expect(() => checkAccess({ ...base, ipAllow: ["10.0.0.1"], ipDeny: ["10.0.0.1"] }, { apiName: "orders", stage: "uat" })).toThrow(/both allowed and blocked/);
  });
  it("demands the API name before turning sign-in off on production only", () => {
    expect(() => checkAccess({ ...base, security: "none" }, { apiName: "orders", stage: "production" })).toThrow(/Type the API name/);
    expect(checkAccess({ ...base, security: "none", confirmNoSecurity: "orders" }, { apiName: "orders", stage: "production" }).security).toBe("none");
    expect(checkAccess({ ...base, security: "none" }, { apiName: "orders", stage: "uat" }).security).toBe("none");
  });
});

describe("addresses", () => {
  it("validates and normalises ranges", () => {
    expect(cidrRange("10.20.0.0/16")).toEqual({ start: "10.20.0.0", end: "10.20.255.255" });
    expect(normaliseAddresses([" 10.0.0.1 ", "10.0.0.1", "192.168.0.0/24", "2001:db8::1"], "x")).toEqual(["10.0.0.1", "192.168.0.0/24", "2001:db8::1"]);
    expect(() => normaliseAddresses(["10.0.0.5/24"], "x")).toThrow(/Did you mean 10.0.0.0\/24/);
    expect(() => normaliseAddresses(["0.0.0.0/0"], "x")).toThrow(/every address/);
    expect(() => normaliseAddresses(["999.1.1.1"], "x")).toThrow(/not an IP address/);
  });
  it("builds a pattern that matches exactly the listed callers", () => {
    const re = new RegExp(addressesRegex(["10.0.0.1", "192.168.4.0/22"]));
    for (const ok of ["10.0.0.1", "192.168.4.0", "192.168.7.255", " 192.168.5.9 , 70.1.1.1"]) expect(re.test(ok)).toBe(true);
    for (const no of ["10.0.0.10", "110.0.0.1", "192.168.8.1", "192.168.3.255", "70.1.1.1, 10.0.0.1"]) expect(re.test(no)).toBe(false);
    expect(addressesRegex([])).toBe("");
    expect(addressesRegex(["10.0.0.0/8"])).not.toMatch(/[<>&"]/);
  });
});

describe("blocking rules", () => {
  const ctx = { apiContexts: ["/orders/v1"], appNames: [] };
  it("maps plain input to API Manager deny policies", () => {
    expect(blockBody({ type: "IP", value: "1.2.3.4" }, ctx)).toEqual({ conditionType: "IP", conditionValue: { fixedIp: "1.2.3.4", invert: false }, conditionStatus: true });
    expect(blockBody({ type: "IPRANGE", value: "10.1.0.0/16" }, ctx).conditionValue).toEqual({ startingIp: "10.1.0.0", endingIp: "10.1.255.255", invert: false });
    expect(blockBody({ type: "APPLICATION", value: "admin:mobile", enabled: false }, ctx)).toEqual({ conditionType: "APPLICATION", conditionValue: "admin:mobile", conditionStatus: false });
    expect(blockBody({ type: "API", value: "orders/v1" }, ctx).conditionValue).toBe("/orders/v1");
  });
  it("refuses what API Manager would reject or misread", () => {
    expect(() => blockBody({ type: "IP", value: "nope" }, ctx)).toThrow(/not an IP/);
    expect(() => blockBody({ type: "IPRANGE", value: "10.0.0.9", endIp: "10.0.0.1" }, ctx)).toThrow(/comes after/);
    expect(() => blockBody({ type: "APPLICATION", value: "mobile" }, ctx)).toThrow(/owner:application-name/);
    expect(() => blockBody({ type: "API", value: "/nothing/v1" }, ctx)).toThrow(/No API is published/);
    expect(() => blockBody({ type: "USER", value: "" }, ctx)).toThrow(/Say what to block/);
  });
});

describe("policies and applications", () => {
  it("builds a request-count policy and refuses duplicates", () => {
    const p = newPolicyBody({ kind: "advanced", name: "cs_gw_test_5", requests: 5, timeUnit: "min" }, ["Gold"]);
    expect(p.body).toMatchObject({ policyName: "cs_gw_test_5", defaultLimit: { type: "REQUESTCOUNTLIMIT", requestCount: { requestCount: 5, timeUnit: "min", unitTime: 1 } } });
    expect(newPolicyBody({ kind: "subscription", name: "P1", requests: 5, timeUnit: "min" }, []).body).toMatchObject({ billingPlan: "FREE", stopOnQuotaReach: true });
    expect(() => newPolicyBody({ kind: "advanced", name: "gold", requests: 5, timeUnit: "min" }, ["Gold"])).toThrow(/already exists/);
    expect(() => newPolicyBody({ kind: "advanced", name: "has space", requests: 5, timeUnit: "min" }, [])).toThrow(/Name the limit/);
    expect(() => newPolicyBody({ kind: "advanced", name: "cs-gw-test-5", requests: 5, timeUnit: "min" }, [])).toThrow(/refuses dashes/);
    expect(() => newPolicyBody({ kind: "advanced", name: "x", requests: 0, timeUnit: "min" }, [])).toThrow(/between 1/);
  });
  it("checks new applications", () => {
    expect(checkApp({ name: " mobile app ", plan: "Unlimited" }, ["Unlimited"], [])).toEqual({ name: "mobile app", plan: "Unlimited", description: "" });
    expect(() => checkApp({ name: "Mobile App", plan: "Unlimited" }, ["Unlimited"], ["mobile app"])).toThrow(/already exists/);
    expect(() => checkApp({ name: "m", plan: "Gold" }, ["Unlimited"], [])).toThrow(/does not exist/);
  });
});

describe("plans for a live API", () => {
  it("describes a traffic change and builds the new definition", () => {
    const p = planTraffic(api, { tiers: ["Gold"], apiPolicy: null, operations: [{ verb: "GET", target: "/orders", policy: "10PerMin" }] }, book);
    expect(p.body.policies).toEqual(["Gold"]);
    expect(p.body.operations[0].throttlingPolicy).toBe("10PerMin");
    expect(p.body.operations[1].throttlingPolicy).toBe("Unlimited");
    expect(p.changes).toEqual([
      "Plans consumers can pick: Unlimited → Gold. Each plan is a limit per consumer application: Gold (5,000 requests per minute per consumer application).",
      "GET /orders: no limit → 10PerMin (10 requests per minute, shared by every caller of this operation).",
    ]);
    expect(planTraffic(api, { tiers: ["Unlimited"], apiPolicy: null, operations: [] }, book).changes).toEqual([]);
  });
  it("reads and sets security without dropping other schemes", () => {
    expect(readSecurity(api)).toBe("oauth2");
    expect(readSecurity({ ...api, operations: api.operations.map((o) => ({ ...o, authType: "None" })) })).toBe("none");
    expect(readSecurity({ ...api, securityScheme: ["oauth2", "api_key"] })).toBe("both");
    const s = securityPatch({ ...api, securityScheme: ["oauth2", "mutualssl"] }, "apikey");
    expect(s.securityScheme).toEqual(["api_key", "mutualssl", "oauth_basic_auth_api_key_mandatory"]);
    expect(securityPatch(api, "none").operations.every((o: any) => o.authType === "None")).toBe(true);
  });
  it("puts the address rules first on every operation and keeps other policies", () => {
    const p = planAccess(api, { security: "oauth2", cors: { enabled: false, origins: [], headers: [], methods: [], credentials: false }, ipAllow: [], ipDeny: ["10.0.0.0/8"] }, "pol-1", "");
    expect(p.changes).toEqual(["Addresses blocked: none → 10.0.0.0/8."]);
    const req0 = p.body.operations[0].operationPolicies.request;
    expect(req0[0]).toMatchObject({ policyName: "weaveAddressFilter", policyId: "pol-1", parameters: { denyList: "10.0.0.0/8", allowList: "" } });
    expect(req0[1].policyName).toBe("addHeader");
    expect(readAddresses(p.body)).toEqual({ allow: [], deny: ["10.0.0.0/8"] });
    const off = planAccess(p.body, { security: "oauth2", cors: { enabled: false, origins: [], headers: [], methods: [], credentials: false }, ipAllow: [], ipDeny: [] }, null, "");
    expect(off.body.operations[0].operationPolicies.request.map((x: any) => x.policyName)).toEqual(["addHeader"]);
  });
  it("frees the oldest undeployed revision only when the limit is reached", () => {
    const r = (id: string, t: number, deployed = false) => ({ id, createdTime: t, deploymentInfo: deployed ? [{ name: "Default" }] : [] });
    expect(revisionToPrune([r("a", 1), r("b", 2)])).toBeNull();
    expect(revisionToPrune([r("a", 5, true), r("b", 2), r("c", 3), r("d", 1), r("e", 4)])?.id).toBe("d");
    expect(revisionToPrune([1, 2, 3, 4, 5].map((i) => r(String(i), i, true)))).toBeNull();
  });
});
