import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mtRequest } from "../src/mt.js";

// Stands in for the migration tool: like it, reads exactly Content-Length bytes and nothing else.
let server: http.Server;
let base = "";
const seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const n = Number(req.headers["content-length"] || 0);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const all = Buffer.concat(chunks);
      const body = req.headers["transfer-encoding"] ? "" : all.subarray(0, n).toString("utf8");
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ got: body ? JSON.parse(body) : {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("migration tool client", () => {
  it("states the length of a JSON body so the tool can read it", async () => {
    const body = { service: "sample-sys-api", method: "GET", path: "/health/readiness", note: "café" };
    const r = await mtRequest({ base, token: "t" }, "POST", "/api/proxy", body);
    const last = seen[seen.length - 1];
    expect(last.headers["transfer-encoding"]).toBeUndefined();
    expect(last.headers["content-length"]).toBe(String(Buffer.byteLength(JSON.stringify(body))));
    expect(last.headers["content-type"]).toBe("application/json");
    expect(last.headers["x-admin-token"]).toBe("t");
    expect(r.status).toBe(200);
    expect((r.json as { got: unknown }).got).toEqual(body);
  });

  it("sends an empty object as a body too, and no body at all for a plain read", async () => {
    await mtRequest({ base, token: "t" }, "POST", "/api/x", {});
    expect(seen[seen.length - 1].body).toBe("{}");
    await mtRequest({ base, token: "t" }, "GET", "/api/migrations");
    const get = seen[seen.length - 1];
    expect(get.headers["content-length"]).toBeUndefined();
    expect(get.headers["content-type"]).toBeUndefined();
  });
});
