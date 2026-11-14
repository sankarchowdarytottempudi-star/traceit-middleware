import { describe, it, expect } from "vitest";
import { reshapeSubPolicies, reshapeApis, isLocalhost, rankCompliance } from "../src/reshape";

describe("reshapeSubPolicies", () => {
  it("maps WSO2 request-count policy to a row", () => {
    const [p] = reshapeSubPolicies([{ policyName: "Gold", defaultLimit: { type: "REQUESTCOUNTLIMIT", requestCount: { requestCount: 5000, timeUnit: "min" } } }]);
    expect(p).toMatchObject({ name: "Gold", quotaType: "requestCount", limit: 5000, timeUnit: "min" });
  });
});
describe("reshapeApis", () => {
  it("extracts backend + operations", () => {
    const [a] = reshapeApis([{ id: "1", name: "cms", context: "/cms", version: "v1", lifeCycleStatus: "PUBLISHED", securityScheme: ["oauth2"], apiThrottlingPolicy: "AroyaApiLimit", operations: [{ verb: "GET", target: "/x", authType: "None" }], endpointConfig: { production_endpoints: { url: "http://cms.svc" } } }]);
    expect(a.backend).toBe("http://cms.svc"); expect(a.operations[0].verb).toBe("GET"); expect(a.throttlingPolicy).toBe("AroyaApiLimit");
  });
});
describe("isLocalhost", () => { it("detects loopback", () => { expect(isLocalhost("127.0.0.1")).toBe(true); expect(isLocalhost("gw.x")).toBe(false); }); });
describe("rankCompliance", () => {
  it("ranks and computes percentages", () => {
    const r = rankCompliance({ governed: 2, compliant: 1, total: 2, errors: 2, warnings: 1, info: 0,
      apis: [{ name: "ok", errors: 0, warnings: 0 }, { name: "bad", errors: 2, warnings: 1 }] as any });
    expect(r.apis[0].name).toBe("bad"); expect(r.apiCompliancePct).toBe(50); expect(r.policyAdherencePct).toBe(50);
  });
});
