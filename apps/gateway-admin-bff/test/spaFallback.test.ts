import { describe, it, expect } from "vitest";
import { classifyUnmatched } from "../src/spaFallback.js";

describe("classifyUnmatched", () => {
  it("treats /api and everything under it as API calls", () => {
    for (const u of ["/api", "/api/", "/api/unknown", "/api/logs?sources=gw"]) expect(classifyUnmatched(u)).toBe("api");
  });
  it("serves the console page for screens, including the APIs screen", () => {
    for (const u of ["/", "/apis", "/apis?view=internal", "/logs?api=gw,svc:cms-proc-api", "/gateway-analytics", "/analytics/api/cms-proc-api", "/analytics/api/orders.v2?range=1h"]) expect(classifyUnmatched(u)).toBe("page");
  });
  it("never serves the page in place of a missing file", () => {
    for (const u of ["/assets/index-abc123.js", "/favicon.ico", "/assets/old.css?v=1"]) expect(classifyUnmatched(u)).toBe("file");
  });
});
