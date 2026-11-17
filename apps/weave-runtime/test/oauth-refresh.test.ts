// HTTP connections with "OAuth2 refresh token" sign-in (Zoho Self Client and similar) and retry back-off.
// A stand-in token endpoint and API on loopback; no real Zoho.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FlowEdge, FlowNode } from "@traceit/weave-flow";
import { loadConfig } from "../src/config.js";
import { Runtime } from "../src/runtime.js";
import { delayList } from "../src/engine/nodes.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wr-oauth-"));
const env = { DATA_DIR: tmp, SECRET_KEY_FILE: path.join(tmp, "secret.key"), RUNTIME_INTERNAL_KEY: "test-key", PORT: "0", GATEWAY_RECONCILE_SECONDS: "0" } as NodeJS.ProcessEnv;
let rt: Runtime; let server: http.Server; let base = "";
const REFRESH = "rt-not-real-1234567890", SECRET = "cs-not-real-0987654321";
const tokenCalls: { body: URLSearchParams; auth?: string }[] = [];
const apiCalls: { auth?: string; at: number }[] = [];
let issued = 0;
let valid = new Set<string>();
let tokenStatus = 200;
let tokenError: string | null = null;
let apiMode: "ok" | "always401" | "flaky" = "ok";
let flaky = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
      const json = (s: number, v: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.url === "/oauth/v2/token") {
        tokenCalls.push({ body: new URLSearchParams(raw), auth: req.headers.authorization });
        if (tokenStatus !== 200) return json(tokenStatus, { error: "invalid_client", secret_echo: SECRET });
        if (tokenError) return json(200, { error: tokenError, secret_echo: SECRET });
        const t = `at-${++issued}`; valid.add(t);
        return json(200, { access_token: t, expires_in: 3600, api_domain: "x" });
      }
      apiCalls.push({ auth: req.headers.authorization, at: Date.now() });
      if (apiMode === "flaky") { flaky++; return flaky < 3 ? json(503, { error: "busy" }) : json(200, { ok: true, tries: flaky }); }
      const tok = /^Zoho-oauthtoken (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      if (apiMode === "always401" || !tok || !valid.has(tok)) return json(401, { code: "INVALID_TOKEN" });
      return json(200, { data: [{ status: "success" }] });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  rt = new Runtime(loadConfig(env));
});
afterAll(async () => { await rt.close(); await new Promise((r) => server.close(r)); fs.rmSync(tmp, { recursive: true, force: true }); });

let n = 0;
const conn = (extra: Record<string, unknown> = {}) => rt.createConnection({ name: `zoho-${++n}`, type: "http", config: { baseUrl: base, authType: "oauth2refresh", tokenUrl: `${base}/oauth/v2/token`, clientId: "client-1", tokenPrefix: "Zoho-oauthtoken", ...extra }, secrets: { clientSecret: SECRET, refreshToken: REFRESH } });
const node = (id: string, type: string, config: Record<string, unknown>): FlowNode => ({ id, type, name: id, position: { x: 0, y: 0 }, config } as FlowNode);
const edge = (a: string, b: string): FlowEdge => ({ id: `e_${a}_${b}`, from: a, fromPort: "out", to: b } as FlowEdge);
async function flowFor(connectionId: string, extra: Record<string, unknown> = {}) {
  return rt.createFlow({ name: `oauth-${++n}`, flow: { nodes: [node("in", "trigger.manual", {}), node("call", "http.request", { connection: connectionId, method: "POST", url: "/crm/v8/Leads/upsert", bodyMode: "json", body: { data: [] }, ...extra }), node("out", "respond", { status: "200", body: "$" })], edges: [edge("in", "call"), edge("call", "out")] } as never });
}
const reset = () => { tokenError = null; issued = 0; tokenCalls.length = 0; apiCalls.length = 0; valid = new Set(); tokenStatus = 200; apiMode = "ok"; flaky = 0; };

describe("OAuth2 refresh token sign-in", () => {
  it("is offered on HTTP connections with its fields", () => {
    const t = rt.catalog().connectionTypes.find((x) => x.type === "http")!;
    expect(t.fields.find((f) => f.key === "authType")!.options!.map((o) => o.value)).toContain("oauth2refresh");
    for (const k of ["tokenUrl", "clientId", "clientSecret", "refreshToken", "scope", "clientAuth", "tokenPrefix"]) expect(t.fields.some((f) => f.key === k), k).toBe(true);
    expect(t.fields.find((f) => f.key === "refreshToken")!.secret).toBe(true);
    expect(t.fields.find((f) => f.key === "clientAuth")!.default).toBe("body");
  });
  it("form body: sends refresh token and client credentials in the body, uses the prefix, and caches the token", async () => {
    reset();
    const c = conn({ scope: "ZohoCRM.modules.leads.ALL" });
    const f = await flowFor(c.id);
    for (let i = 0; i < 3; i++) expect((await rt.testFlow(f.id, {})).status).toBe("success");
    expect(tokenCalls).toHaveLength(1);
    const b = tokenCalls[0].body;
    expect(Object.fromEntries(b)).toEqual({ grant_type: "refresh_token", refresh_token: REFRESH, client_id: "client-1", client_secret: SECRET, scope: "ZohoCRM.modules.leads.ALL" });
    expect(tokenCalls[0].auth).toBeUndefined();
    expect(apiCalls.map((a) => a.auth)).toEqual(["Zoho-oauthtoken at-1", "Zoho-oauthtoken at-1", "Zoho-oauthtoken at-1"]);
  });
  it("Basic header: client id and secret go in the Authorization header, not the body; default prefix is Bearer", async () => {
    reset();
    const c = conn({ clientAuth: "basic", tokenPrefix: "" });
    const ex = await rt.testFlow((await flowFor(c.id)).id, {});
    expect(ex.status).toBe("success");
    expect(tokenCalls[0].auth).toBe(`Basic ${Buffer.from(`client-1:${SECRET}`).toString("base64")}`);
    expect(tokenCalls[0].body.get("client_secret")).toBeNull();
    expect(tokenCalls[0].body.get("refresh_token")).toBe(REFRESH);
    expect(apiCalls[0].auth).toMatch(/^Bearer at-\d+$/);
  });
  it("on a 401 it drops the cached token, refreshes once and repeats the call once", async () => {
    reset();
    const c = conn();
    const f = await flowFor(c.id);
    expect((await rt.testFlow(f.id, {})).status).toBe("success");
    valid.clear();                                   // the token expired at the API
    const ex = await rt.testFlow(f.id, {});
    expect(ex.status).toBe("success");
    expect(tokenCalls).toHaveLength(2);
    expect(apiCalls.map((a) => a.auth)).toEqual(["Zoho-oauthtoken at-1", "Zoho-oauthtoken at-1", "Zoho-oauthtoken at-2"]);
  });
  it("refreshes only once when the API keeps answering 401", async () => {
    reset();
    const c = conn();
    apiMode = "always401";
    const ex = await rt.testFlow((await flowFor(c.id, { retries: 2, retryDelayMs: 1 })).id, {});
    expect(ex.status).toBe("error");
    expect(tokenCalls).toHaveLength(2);
    expect(apiCalls).toHaveLength(2);
  });
  it("never shows the refresh token, client secret or access token in traces, logs or errors", async () => {
    reset();
    const c = conn();
    const ex = await rt.testFlow((await flowFor(c.id)).id, {});
    const text = JSON.stringify(ex) + JSON.stringify(rt.store.listConnections());
    for (const s of [REFRESH, SECRET, "at-1"]) expect(text).not.toContain(s);
  });
  it("Test connection gets a token first and says so; a failing token call reports the HTTP status and error code only", async () => {
    reset();
    const c = conn();
    const ok = await rt.testConnection({ id: c.id });
    expect(ok.detail).toMatch(/^Got an access token with the refresh token\. Reached /);
    expect(tokenCalls).toHaveLength(1);
    tokenStatus = 401;
    const bad = await rt.testConnection({ id: c.id });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/Could not refresh the token for connection "zoho-\d+" \(HTTP 401, invalid_client\)/);
    expect(bad.detail).not.toContain(SECRET);
    expect(bad.detail).not.toContain("secret_echo");
  });
});

describe("pasted values and token errors", () => {
  it("trims pasted secrets and settings (spaces, a line break)", async () => {
    reset();
    const c = rt.createConnection({ name: `trim-${++n}`, type: "http", config: { baseUrl: ` ${base} `, authType: "oauth2refresh", tokenUrl: `${base}/oauth/v2/token `, clientId: " client-1\n", tokenPrefix: "Zoho-oauthtoken" }, secrets: { clientSecret: `  ${SECRET}\n`, refreshToken: `${REFRESH} \r\n` } });
    expect((await rt.testFlow((await flowFor(c.id)).id, {})).status).toBe("success");
    expect(Object.fromEntries(tokenCalls[0].body)).toMatchObject({ refresh_token: REFRESH, client_id: "client-1", client_secret: SECRET });
  });
  it("Zoho answers 200 with an error code: the test shows the code and the status, never other body values", async () => {
    reset();
    const c = conn();
    tokenError = "invalid_code";
    const r = await rt.testConnection({ id: c.id });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("(HTTP 200, invalid_code)");
    expect(r.detail).toMatch(/refresh token is not accepted/);
    expect(r.detail).not.toContain(SECRET);
    tokenError = "invalid_client";
    expect((await rt.testConnection({ id: c.id })).detail).toMatch(/\(HTTP 200, invalid_client\)\. The client id or client secret is not accepted/);
    tokenError = "<script>alert(1)</script>";
    expect((await rt.testConnection({ id: c.id })).detail).not.toContain("script");
  });
});

describe("retry back-off", () => {
  it("reads a list of waits", () => { expect(delayList("1000, 3000")).toEqual([1000, 3000]); expect(delayList("x, 5")).toEqual([5]); expect(delayList(undefined)).toEqual([]); });
  it("waits the listed time before each retry, in order", async () => {
    reset();
    apiMode = "flaky";
    const plain = rt.createConnection({ name: `plain-${++n}`, type: "http", config: { baseUrl: base, authType: "none" } });
    const ex = await rt.testFlow((await flowFor(plain.id, { retries: 2, retryDelayMs: 5, retryDelaysMs: "60, 240" })).id, {});
    expect(ex.status).toBe("success");
    expect(apiCalls).toHaveLength(3);
    const gap1 = apiCalls[1].at - apiCalls[0].at, gap2 = apiCalls[2].at - apiCalls[1].at;
    expect(gap1).toBeGreaterThanOrEqual(55);
    expect(gap2).toBeGreaterThanOrEqual(230);
    expect(gap2).toBeGreaterThan(gap1);
  });
});

describe("testing an edited connection (2026-11-17)", () => {
  it("a draft tested against a saved connection uses the stored secrets for secret fields left empty", async () => {
    reset();
    const c = conn();
    // the edit dialog sends the changed config without the secrets (empty means keep what is stored)
    const draft = { name: c.name, type: "http", config: { baseUrl: base, authType: "oauth2refresh", tokenUrl: `${base}/oauth/v2/token`, clientId: "client-1", clientAuth: "body", tokenPrefix: "Zoho-oauthtoken", healthPath: "/health" } };
    const r = await rt.testConnection({ draft: draft as never, baseId: c.id });
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].body.get("client_secret")).toBe(SECRET);
    expect(tokenCalls[0].body.get("refresh_token")).toBe(REFRESH);
    expect(r.detail).not.toContain(SECRET);
    // the saved connection is not changed by a test
    expect(rt.listConnections().find((x) => x.id === c.id)?.updatedAt).toBe(c.updatedAt);
  });
  it("a draft for a connection that does not exist is refused", async () => {
    await expect(rt.testConnection({ draft: { name: "x", type: "http", config: { baseUrl: base } } as never, baseId: "cx_missing" })).rejects.toThrow();
  });
});

describe("swapped Zoho client id and secret", () => {
  it("says they look swapped when the secret has the client id shape and the id is hex", async () => {
    const { tokenHint } = await import("../src/engine/nodes.js");
    expect(tokenHint("invalid_client", "0123456789abcdef0123456789abcdef0123456789", "1000.ABCDEFGHIJ0123456789KLMNOPQRST")).toMatch(/look swapped/);
    expect(tokenHint("invalid_client", "1000.ABCDEFGHIJ0123456789KLMNOPQRST", "0123456789abcdef0123456789abcdef0123456789")).not.toMatch(/swapped/);
    expect(tokenHint("invalid_grant", "0123456789abcdef0123456789abcdef0123456789", "1000.ABCDEFGHIJ0123456789KLMNOPQRST")).not.toMatch(/swapped/);
  });
});
