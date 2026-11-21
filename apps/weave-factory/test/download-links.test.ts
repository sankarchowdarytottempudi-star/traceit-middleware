import { afterEach, describe, expect, it, vi } from "vitest";

// Under the shared Weave address the Factory lives at /factory: a plain link must carry that prefix,
// or the browser asks the Gateway and gets "File wasn't available on site".
describe("download links", () => {
  afterEach(() => { document.head.querySelector('meta[name="weave-base"]')?.remove(); vi.resetModules(); });
  it("carry the address the Factory is served at", async () => {
    const meta = document.createElement("meta");
    meta.name = "weave-base"; meta.content = "/factory";
    document.head.appendChild(meta);
    vi.resetModules();
    const { api } = await import("../src/api.ts");
    expect(api.docUrl("m1", "ESTIMATE.md")).toBe("/factory/api/factory/migrations/m1/docs/ESTIMATE.md?download=1");
    expect(api.projectUrl("m1")).toBe("/factory/api/factory/migrations/m1/project");
  });
  it("have no prefix when the Factory has its own host", async () => {
    vi.resetModules();
    const { api } = await import("../src/api.ts");
    expect(api.projectUrl("m1")).toBe("/api/factory/migrations/m1/project");
  });
});
