import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "../src/api";

afterEach(() => vi.unstubAllGlobals());

function capture() {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}
const contentType = (init: RequestInit) => new Headers(init.headers).get("content-type");

describe("requests to the server", () => {
  it("states a content type only when there is a body", async () => {
    const calls = capture();
    await api.deleteEnvironment("e1");
    await api.deleteMigration("m1");
    await api.deleteWorkspaceConfig("w1");
    for (const c of calls) { expect(c.init.method).toBe("DELETE"); expect(contentType(c.init)).toBeNull(); expect(c.init.body).toBeUndefined(); }
    await api.environments();
    expect(contentType(calls[3].init)).toBeNull();
    await api.addEnvironment({ name: "Test", baseUrl: "http://t" });
    expect(calls[4].init.method).toBe("POST");
    expect(contentType(calls[4].init)).toBe("application/json");
    expect(JSON.parse(String(calls[4].init.body))).toEqual({ name: "Test", baseUrl: "http://t" });
    expect(calls.every((c) => c.init.credentials === "include")).toBe(true);
  });
});
