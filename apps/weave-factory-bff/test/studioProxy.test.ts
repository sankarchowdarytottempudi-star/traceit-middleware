import { describe, expect, it } from "vitest";
import { readWithRetry, type StudioConfig } from "../src/studio.js";

const cfg: StudioConfig = { runtimeUrl: "http://127.0.0.1:1", internalKey: "k" };
const ok = { status: 200, headers: {}, text: "{}" };

describe("studio proxy: reads survive a dropped connection", () => {
  it("tries a read once more when the connection fails", async () => {
    let calls = 0;
    const r = await readWithRetry(cfg, "GET", "/v1/flows", undefined, "u", async () => { if (++calls === 1) throw new Error("connect ECONNREFUSED"); return ok; }, 1);
    expect(r.status).toBe(200);
    expect(calls).toBe(2);
  });
  it("gives up after the second failure", async () => {
    let calls = 0;
    await expect(readWithRetry(cfg, "GET", "/v1/flows", undefined, "u", async () => { calls++; throw new Error("socket hang up"); }, 1)).rejects.toThrow("socket hang up");
    expect(calls).toBe(2);
  });
  it("never repeats a request that changes data", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      let calls = 0;
      await expect(readWithRetry(cfg, method, "/v1/flows", {}, "u", async () => { calls++; throw new Error("connect ECONNRESET"); }, 1)).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });
  it("does not repeat a read that timed out", async () => {
    let calls = 0;
    await expect(readWithRetry(cfg, "GET", "/v1/flows", undefined, "u", async () => { calls++; throw new Error("runtime timeout"); }, 1)).rejects.toThrow("runtime timeout");
    expect(calls).toBe(1);
  });
  it("passes an answer straight through, whatever its status", async () => {
    let calls = 0;
    const r = await readWithRetry(cfg, "GET", "/v1/flows/x", undefined, "u", async () => { calls++; return { ...ok, status: 404 }; }, 1);
    expect(r.status).toBe(404);
    expect(calls).toBe(1);
  });
});
