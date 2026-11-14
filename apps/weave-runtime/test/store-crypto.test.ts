import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { SecretBox } from "../src/crypto.js";
import { Store, writeAtomic } from "../src/store.js";
import { MASK, redact, truncate } from "../src/redact.js";
import type { Flow } from "@traceit/weave-flow";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wr-store-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("secret box (AES-256-GCM)", () => {
  const box = new SecretBox(crypto.randomBytes(32));
  it("round-trips and never stores the plain text", () => {
    const enc = box.encrypt("s3cret-value");
    expect(enc.startsWith("v1:")).toBe(true); expect(enc).not.toContain("s3cret-value"); expect(box.decrypt(enc)).toBe("s3cret-value");
  });
  it("uses a fresh nonce every time", () => { expect(box.encrypt("x")).not.toBe(box.encrypt("x")); });
  it("refuses tampered text and a wrong key", () => {
    const parts = box.encrypt("hello").split(":"); const ct = Buffer.from(parts[3], "base64"); ct[0] ^= 1; parts[3] = ct.toString("base64");
    expect(() => box.decrypt(parts.join(":"))).toThrow();
    expect(() => new SecretBox(crypto.randomBytes(32)).decrypt(box.encrypt("hello"))).toThrow();
    expect(() => new SecretBox(Buffer.alloc(8))).toThrow();
  });
  it("creates the key file once, private to its owner, and reuses it", () => {
    const f = path.join(tmp, "k", "secret.key");
    const a = SecretBox.fromFile(f); const enc = a.encrypt("v");
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(SecretBox.fromFile(f).decrypt(enc)).toBe("v");
  });
});

describe("redaction", () => {
  it("masks sensitive keys and known secret values wherever they appear", () => {
    const out = redact({ headers: { authorization: "Bearer abc.def", "x-api-key": "k1", accept: "json" }, password: "pw", nested: [{ token: "t" }], note: "call with tok-12345 please" }, ["tok-12345"]) as Record<string, never>;
    const text = JSON.stringify(out);
    for (const s of ["abc.def", "k1", "\"pw\"", "tok-12345"]) expect(text).not.toContain(s);
    expect(text).toContain(MASK); expect(text).toContain("json");
  });
  it("truncates oversized traces", () => {
    const t = truncate("x".repeat(200_000) as never);
    expect(t.truncated).toBe(true); expect(JSON.stringify(t.value).length).toBeLessThan(70_000);
    expect(truncate({ a: 1 } as never).truncated).toBe(false);
  });
});

describe("file store", () => {
  const dir = path.join(tmp, "data");
  const flow = (rev: number): Flow => ({ id: "fl_test", name: "T", slug: "t", tags: [], nodes: [], edges: [], settings: { basePath: "/t/v1", gateway: { publish: false, security: "oauth2" } }, revision: rev, createdAt: "2026-01-01T00:00:00Z", updatedAt: `2026-01-0${rev}T00:00:00Z` } as unknown as Flow);
  it("writes atomically (no temp files left behind)", () => {
    const f = path.join(tmp, "atomic", "a.json"); fs.mkdirSync(path.dirname(f), { recursive: true });
    writeAtomic(f, "one"); writeAtomic(f, "two");
    expect(fs.readFileSync(f, "utf8")).toBe("two"); expect(fs.readdirSync(path.dirname(f))).toEqual(["a.json"]);
  });
  it("keeps flows, versions, deployments and connections across a restart", () => {
    const s = new Store(dir);
    s.saveFlow(flow(1)); s.saveFlow(flow(2)); s.saveFlow(flow(3));
    s.saveConnection({ id: "cx_1", name: "c", type: "http", config: { baseUrl: "http://x" }, secrets: { token: "v1:a:b:c" }, createdAt: "", updatedAt: "" });
    s.setDeployment("fl_test", { status: "deployed", revision: 3, deployedAt: "2026-01-03T00:00:00Z" } as never);
    const again = new Store(dir);
    expect(again.getFlow("fl_test")?.revision).toBe(3);
    expect(again.getFlow("fl_test")?.deployment?.revision).toBe(3);
    expect(again.listVersions("fl_test").map((v) => v.revision).sort()).toEqual([1, 2, 3]);
    expect(again.getVersion("fl_test", 2)?.revision).toBe(2);
    expect(again.listConnections().map((c) => c.id)).toEqual(["cx_1"]);
    again.deleteFlow("fl_test");
    expect(new Store(dir).getFlow("fl_test")).toBeUndefined();
  });
  it("caps execution history per flow", () => {
    const s = new Store(path.join(tmp, "data2"), 3);
    for (let i = 0; i < 6; i++) s.addExecution({ id: `ex_${i}`, flowId: "f", flowName: "F", revision: 1, mode: "live", trigger: { type: "trigger.http" }, status: "success", startedAt: new Date(Date.now() + i).toISOString(), steps: [] });
    const list = s.listExecutions({ flowId: "f" });
    expect(list.length).toBe(3); expect(s.getExecution("ex_5")?.id).toBe("ex_5"); expect(s.getExecution("ex_0")).toBeUndefined();
  });
});
