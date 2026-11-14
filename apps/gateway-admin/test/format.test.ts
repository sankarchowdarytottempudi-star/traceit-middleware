import { describe, it, expect } from "vitest";
import { formatQuota, logBarWidth, isLocalhost, rankApis, severityTotals, plainWords, UNLIMITED } from "../src/lib/format";

describe("formatQuota", () => {
  it("shows Unlimited for the WSO2 marker", () => { expect(formatQuota(UNLIMITED)).toBe("Unlimited"); });
  it("K-suffixes thousands", () => { expect(formatQuota(6000)).toBe("6K"); expect(formatQuota(1500)).toBe("1.5K"); });
  it("keeps small numbers", () => { expect(formatQuota(50)).toBe("50"); });
});
describe("logBarWidth", () => {
  it("is 0 at zero and 100 at max", () => { expect(logBarWidth(0)).toBe(0); expect(logBarWidth(UNLIMITED)).toBe(100); });
  it("is monotonic", () => { expect(logBarWidth(100)).toBeLessThan(logBarWidth(100000)); });
});
describe("isLocalhost", () => {
  it("detects loopback hosts", () => { ["localhost", "127.0.0.1", "::1", "LOCALHOST:8243"].forEach((h) => expect(isLocalhost(h)).toBe(true)); });
  it("passes real hosts", () => { expect(isLocalhost("gw.example.com")).toBe(false); expect(isLocalhost(undefined)).toBe(false); });
});
describe("rankApis + severityTotals", () => {
  const apis = [{ name: "b", errors: 0, warnings: 2 }, { name: "a", errors: 2, warnings: 0 }, { name: "c", errors: 2, warnings: 5 }];
  it("ranks by errors then warnings then name", () => { expect(rankApis(apis).map((a) => a.name)).toEqual(["c", "a", "b"]); });
  it("totals severities", () => { expect(severityTotals(apis)).toEqual({ errors: 4, warnings: 7, info: 0 }); });
});
describe("plainWords", () => {
  it("reads naturally", () => { expect(plainWords(6000, "min")).toContain("6,000 requests every min"); });
});
