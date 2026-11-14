import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Flow, FlowEdge, FlowNode } from "@traceit/weave-flow";
import { loadConfig } from "../src/config.js";
import { Problem, Runtime } from "../src/runtime.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wr-engine-"));
const env = { DATA_DIR: tmp, SECRET_KEY_FILE: path.join(tmp, "secret.key"), RUNTIME_INTERNAL_KEY: "test-key", PORT: "0", GATEWAY_RECONCILE_SECONDS: "0" } as NodeJS.ProcessEnv;
let rt: Runtime; let server: http.Server; let base = "";
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let flaky = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const json = (status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.url?.startsWith("/items")) return json(200, { items: [{ id: 1, name: "alpha one", price: 2.5 }, { id: 2, name: "beta", price: 4 }] });
      if (req.url?.startsWith("/flaky")) { flaky++; return flaky < 3 ? json(503, { error: "busy" }) : json(200, { ok: true, attempts: flaky }); }
      if (req.url?.startsWith("/fail")) return json(500, { error: "boom" });
      if (req.url?.startsWith("/echo")) return json(200, { method: req.method, headers: req.headers, body: body ? JSON.parse(body) : null });
      if (req.url?.startsWith("/slow")) { setTimeout(() => json(200, { late: true }), 1500); return; }
      json(404, { error: "no such path" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  rt = new Runtime(loadConfig(env));
});
afterAll(async () => { await rt.close(); await new Promise((r) => server.close(r)); fs.rmSync(tmp, { recursive: true, force: true }); });

const node = (id: string, type: string, config: Record<string, unknown>, name = id): FlowNode => ({ id, type, name, position: { x: 0, y: 0 }, config } as FlowNode);
const edge = (a: string, b: string, port = "out"): FlowEdge => ({ id: `e_${a}_${port.replace(":", "_")}_${b}`, from: a, fromPort: port, to: b } as FlowEdge);
async function make(name: string, nodes: FlowNode[], edges: FlowEdge[]): Promise<Flow> {
  const f = await rt.createFlow({ name, flow: { nodes, edges } as never });
  return f;
}
const trig = (p = "/go", methods = ["GET", "POST"]) => node("n_in", "trigger.http", { methods, path: p });

describe("engine", () => {
  it("runs listener -> HTTP call -> mapping -> response and records a step trace", async () => {
    const f = await make("basic", [trig("/items/:kind"), node("n_call", "http.request", { method: "GET", url: `${base}/items`, query: [{ key: "kind", value: "{{ $request.params.kind }}" }] }),
      node("n_map", "transform.map", { mapping: { rules: [
        { id: "r1", target: "names", kind: "expr", expr: "[items.name]" },
        { id: "r2", target: "first", kind: "instruction", instruction: "add the _ inbetween if name came as two words (items[0].name)" },
        { id: "r3", target: "kind", kind: "expr", expr: "$request.params.kind" }, { id: "r4", target: "source", kind: "const", value: "test" }] } }),
      node("n_out", "respond", { status: "200", body: "$" })], [edge("n_in", "n_call"), edge("n_call", "n_map"), edge("n_map", "n_out")]);
    const ex = await rt.testFlow(f.id, { request: { method: "GET", path: "/items/books" } as never });
    expect(ex.status).toBe("success");
    expect(ex.response).toMatchObject({ status: 200, body: { names: ["alpha one", "beta"], first: "alpha_one", kind: "books", source: "test" } });
    expect(ex.steps.map((s) => [s.nodeId, s.status])).toEqual([["n_in", "success"], ["n_call", "success"], ["n_map", "success"], ["n_out", "success"]]);
    expect(ex.steps[1].meta?.http).toMatchObject({ method: "GET", status: 200 });
    expect(seen.at(-1)!.url).toBe("/items?kind=books");
    const stored = rt.store.getFlow(f.id)!;
    const rule = (stored.nodes.find((n) => n.id === "n_map")!.config as { mapping: { rules: { id: string; compiled?: { expr: string } }[] } }).mapping.rules.find((r) => r.id === "r2")!;
    expect(rule.compiled?.expr).toContain("$join");
  });

  it("retries a failing call and succeeds on a later attempt", async () => {
    flaky = 0;
    const f = await make("retry", [trig(), node("n_call", "http.request", { method: "GET", url: `${base}/flaky`, retries: 3, retryDelayMs: 5 }), node("n_out", "respond", { status: "200", body: "$" })], [edge("n_in", "n_call"), edge("n_call", "n_out")]);
    const ex = await rt.testFlow(f.id, { request: { method: "GET", path: "/go" } as never });
    expect(ex.status).toBe("success"); expect(ex.response?.body).toMatchObject({ ok: true, attempts: 3 });
  });

  it("follows the error port when one is wired, and fails the run when none is", async () => {
    const wired = await make("errors", [trig(), node("n_call", "http.request", { method: "GET", url: `${base}/fail` }), node("n_ok", "respond", { status: "200", body: "$" }),
      node("n_err", "respond", { status: "502", body: '{ "problem": $error.message, "upstream": $error.detail.status, "answer": $error.status }' })], [edge("n_in", "n_call"), edge("n_call", "n_ok"), edge("n_call", "n_err", "error")]);
    const ex = await rt.testFlow(wired.id, { request: { method: "GET", path: "/go" } as never });
    expect(ex.response?.status).toBe(502); expect(ex.response?.body).toMatchObject({ upstream: 500, answer: 502 });
    expect(ex.steps.find((s) => s.nodeId === "n_call")).toMatchObject({ status: "error", port: "error" });
    const bare = await make("errors bare", [trig(), node("n_call", "http.request", { method: "GET", url: `${base}/fail` }), node("n_ok", "respond", { status: "200", body: "$" })], [edge("n_in", "n_call"), edge("n_call", "n_ok")]);
    const ex2 = await rt.testFlow(bare.id, { request: { method: "GET", path: "/go" } as never });
    expect(ex2.status).toBe("error"); expect(ex2.error?.nodeId).toBe("n_call"); expect(ex2.response?.status).toBeGreaterThanOrEqual(500);
  });

  it("times out a slow call", async () => {
    const f = await make("slow", [trig(), node("n_call", "http.request", { method: "GET", url: `${base}/slow`, timeoutMs: 200 }), node("n_out", "respond", { status: "200", body: "$" })], [edge("n_in", "n_call"), edge("n_call", "n_out")]);
    const ex = await rt.testFlow(f.id, { request: { method: "GET", path: "/go" } as never });
    expect(ex.status).toBe("error"); expect(ex.error?.message).toMatch(/time|abort/i);
  });

  it("uses a connection, forwards chosen headers and never shows secrets in traces or the API", async () => {
    const conn = rt.createConnection({ name: "echo api", type: "http", config: { baseUrl: base, authType: "bearer" }, secrets: { token: "tok-SECRET-12345" } });
    expect(conn.secretsSet).toEqual(["token"]); expect(JSON.stringify(conn)).not.toContain("tok-SECRET-12345");
    expect(JSON.stringify(rt.listConnections())).not.toContain("tok-SECRET-12345");
    expect(fs.readFileSync(path.join(tmp, "connections", `${conn.id}.json`), "utf8")).not.toContain("tok-SECRET-12345");
    const f = await make("conn", [trig(), node("n_set", "vars.set", { assignments: [{ key: "who", value: "$request.query.who" }] }),
      node("n_call", "http.request", { connection: conn.id, method: "POST", url: "/echo", bodyMode: "json", body: { hello: "{{ $vars.who }}" }, forwardHeaders: ["x-correlation-id"], headers: [{ key: "x-static", value: "s1" }], resultTarget: "variable", resultVar: "echo" }),
      node("n_out", "respond", { status: "201", body: '{ "sent": $vars.echo.body, "auth": $vars.echo.headers.authorization, "corr": $vars.echo.headers.`x-correlation-id`, "payloadKept": $payload }', headers: [{ key: "x-flow", value: "conn" }] })],
      [edge("n_in", "n_set"), edge("n_set", "n_call"), edge("n_call", "n_out")]);
    const ex = await rt.testFlow(f.id, { request: { method: "POST", path: "/go", query: { who: "ada" }, headers: { "x-correlation-id": "c-77", "x-other": "no" }, body: { keep: 1 } } as never });
    expect(ex.response?.status).toBe(201);
    const last = seen.at(-1)!;
    expect(last.headers.authorization).toBe("Bearer tok-SECRET-12345"); expect(last.headers["x-correlation-id"]).toBe("c-77"); expect(last.headers["x-other"]).toBeUndefined(); expect(last.headers["x-static"]).toBe("s1");
    expect(JSON.parse(last.body)).toEqual({ hello: "ada" });
    expect(ex.response?.body).toMatchObject({ sent: { hello: "ada" }, corr: "c-77", payloadKept: { keep: 1 } });
    expect(JSON.stringify(ex)).not.toContain("tok-SECRET-12345");
    expect(JSON.stringify(rt.store.getExecution(ex.id))).not.toContain("tok-SECRET-12345");
  });

  it("branches with a choice and calls another flow", async () => {
    const child = await make("child", [node("n_start", "trigger.manual", {}), node("n_x", "transform.expr", { expr: '{ "doubled": n * 2 }' })], [edge("n_start", "n_x")]);
    const parent = await make("parent", [trig("/calc"), node("n_if", "logic.choice", { conditions: [{ id: "big", label: "Big", expr: "$number($request.query.n) > 10" }] }),
      node("n_big", "respond", { status: "200", body: '{ "size": "big" }' }),
      node("n_call", "flow.call", { flow: child.id, input: '{ "n": $number($request.query.n) }' }), node("n_small", "respond", { status: "200", body: '{ "size": "small", "result": $ }' })],
      [edge("n_in", "n_if"), edge("n_if", "n_big", "case:big"), edge("n_if", "n_call", "otherwise"), edge("n_call", "n_small")]);
    const big = await rt.testFlow(parent.id, { request: { method: "GET", path: "/calc", query: { n: "50" } } as never });
    expect(big.response?.body).toEqual({ size: "big" });
    const small = await rt.testFlow(parent.id, { request: { method: "GET", path: "/calc", query: { n: "4" } } as never });
    expect(small.response?.body).toEqual({ size: "small", result: { doubled: 8 } });
    expect(small.steps.find((s) => s.nodeId === "n_call")?.meta?.flow).toMatchObject({ id: child.id });
  });

  it("refuses to save over someone else's change and keeps versions", async () => {
    const f = await make("versions", [trig(), node("n_out", "respond", { status: "200", body: '"v1"' })], [edge("n_in", "n_out")]);
    const v2 = await rt.updateFlow(f.id, { ...f, description: "second" });
    expect(v2.revision).toBe(f.revision + 1);
    await expect(rt.updateFlow(f.id, { ...f, description: "stale" })).rejects.toMatchObject({ status: 409 });
    expect(rt.store.listVersions(f.id).map((v) => v.revision).sort()).toEqual([1, 2]);
    const restored = await rt.restoreVersion(f.id, 1);
    expect(restored.revision).toBe(3); expect(restored.description ?? "").not.toBe("second");
    const copy = await rt.duplicateFlow(f.id);
    expect(copy.id).not.toBe(f.id); expect(copy.slug).not.toBe(f.slug); expect(copy.settings.basePath).not.toBe(f.settings.basePath);
  });

  it("an instruction that cannot be compiled blocks deployment with a clear issue", async () => {
    const f = await make("bad words", [trig(), node("n_map", "transform.map", { mapping: { rules: [{ id: "r1", target: "first", kind: "instruction", instruction: "make it nice" }] } }), node("n_out", "respond", { status: "200", body: "$" })], [edge("n_in", "n_map"), edge("n_map", "n_out")]);
    const issues = await rt.validate(rt.store.getFlow(f.id)!);
    expect(issues.some((i) => i.level === "error" && i.nodeId === "n_map")).toBe(true);
    await expect(rt.deploy(f.id, { publishToGateway: false })).rejects.toBeInstanceOf(Problem);
    const ex = await rt.testFlow(f.id, { request: { method: "GET", path: "/go" } as never });
    expect(ex.status).toBe("error"); expect(JSON.stringify(ex.steps.find((s) => s.nodeId === "n_map"))).toMatch(/r1|first/);
  });

  it("serves a deployed flow on its listener path and brings it back after a restart", async () => {
    const f = await make("live one", [trig("/hello/:name", ["GET"]), node("n_out", "respond", { status: "200", body: '{ "hi": $request.params.name }' })], [edge("n_in", "n_out")]);
    await rt.deploy(f.id, { publishToGateway: false });
    const hit = rt.matchLive("GET", `${f.settings.basePath}/hello/ada`);
    expect("entry" in hit).toBe(true);
    if ("entry" in hit) { const r = await rt.runLive(hit, { method: "GET", query: {}, headers: {}, body: null }, "direct"); expect(r.response.status).toBe(200); expect(r.response.body).toEqual({ hi: "ada" }); expect(r.executionId).toMatch(/^ex_/); }
    expect(rt.matchLive("POST", `${f.settings.basePath}/hello/ada`)).toMatchObject({ status: 405 });
    expect(rt.matchLive("GET", "/nope/v1/x")).toMatchObject({ status: 404 });
    const again = new Runtime(loadConfig(env));
    try { again.refreshLive(); expect("entry" in again.matchLive("GET", `${f.settings.basePath}/hello/ada`)).toBe(true); expect(again.stats(1)).toBeTruthy(); } finally { await again.close(); }
    await rt.undeploy(f.id);
    expect(rt.matchLive("GET", `${f.settings.basePath}/hello/ada`)).toMatchObject({ status: 404 });
  });
});
