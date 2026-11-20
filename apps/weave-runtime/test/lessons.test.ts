// Production lessons (packages/weave-flow/lessons/lessons.json) applied by default in the Factory:
// L1 session reuse, L2 shared/cached reads, L3 background sends, L4 timeouts and idempotent-only retries.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { BUILTIN_NODE_TYPES, LESSON_CHECKS, describeFlow, isIdempotentCall, isLoginLike, isNotificationLike, type ConnectorDef, type Flow, type FlowEdge, type FlowNode } from "@traceit/weave-flow";
import { loadConfig } from "../src/config.js";
import { Runtime } from "../src/runtime.js";
import { connectorNodeTypes } from "../src/catalog.js";
import { validateFlow, type ValidateCtx } from "../src/validate.js";
import { ReadShare, httpShare } from "../src/engine/share.js";

const CATALOGUE = path.resolve(__dirname, "../../../packages/weave-flow/lessons/lessons.json");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wr-lessons-"));
const env = { DATA_DIR: tmp, SECRET_KEY_FILE: path.join(tmp, "secret.key"), RUNTIME_INTERNAL_KEY: "test-key", PORT: "0", GATEWAY_RECONCILE_SECONDS: "0" } as NodeJS.ProcessEnv;
let rt: Runtime; let server: http.Server; let base = "";
const hits: Record<string, number> = {};
let mailFails = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
      const p = (req.url ?? "/").split("?")[0];
      const key = `${req.method} ${p}`;
      hits[key] = (hits[key] ?? 0) + 1;
      const json = (status: number, v: unknown, delay = 0) => setTimeout(() => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); }, delay);
      if (p === "/price") return json(200, { price: 10, n: hits[key] }, 150);
      if (p === "/login") return json(200, { session: `s${hits[key]}` }, 50);
      if (p === "/busy") return json(503, { error: "busy" });
      if (p === "/book") return json(503, { error: "busy" });
      if (p === "/mail") { if (mailFails > 0) { mailFails--; return json(503, { error: "busy" }); } return json(202, { sent: true }, 300); }
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
const trig = (p = "/go", methods = ["GET", "POST"]) => node("n_in", "trigger.http", { methods, path: p });
const flowOf = (nodes: FlowNode[], edges: FlowEdge[]): Flow => ({ id: "fl_l", name: "lessons", slug: "lessons", nodes, edges, settings: { basePath: "/l/v1" }, revision: 1, createdAt: "", updatedAt: "" } as unknown as Flow);
const mailer: ConnectorDef = { id: "cn_mail", name: "Mailer", connectionType: "http", createdAt: "", updatedAt: "", operations: [
  { id: "sendEmail", name: "Send e-mail", method: "POST", path: "/mail", params: [] },
  { id: "getTemplate", name: "Get template", method: "GET", path: "/templates/{id}", params: [] },
  { id: "login", name: "Log in", method: "POST", path: "/auth/login", params: [] },
] };
const ctx = (conns: Record<string, { authType: string }> = {}): ValidateCtx => ({
  getConnection: (id) => (conns[id] ? { id, name: id, type: "http", config: conns[id] } : undefined),
  getConnector: (id) => (id === mailer.id ? mailer : undefined),
  getFlow: () => undefined,
});
const lessonIssues = (f: Flow, c = ctx()) => validateFlow(f, c).filter((i) => i.lesson);

describe("lessons catalogue", () => {
  it("the Factory's check ids and fix texts are the catalogue's", () => {
    const cat = JSON.parse(fs.readFileSync(CATALOGUE, "utf8")) as { lessons: { id: string; checks: { id: string; fix: string; title: string }[] }[] };
    const all = new Map(cat.lessons.flatMap((l) => l.checks.map((c) => [c.id, { ...c, lesson: l.id }] as const)));
    for (const c of Object.values(LESSON_CHECKS)) {
      expect(all.get(c.id), c.id).toBeDefined();
      expect(c.fix).toBe(all.get(c.id)!.fix);
      expect(c.title).toBe(all.get(c.id)!.title);
      expect(c.lesson).toBe(all.get(c.id)!.lesson);
    }
  });
  it("recognises idempotent calls, logins and notification sends by fixed rules", () => {
    expect(isIdempotentCall("GET")).toBe(true);
    expect(isIdempotentCall("POST")).toBe(false);
    expect(isIdempotentCall("POST", ["Idempotency-Key"])).toBe(true);
    expect(isIdempotentCall("DELETE")).toBe(false);
    expect(isIdempotentCall("POST", [], undefined, "/crm/v8/Leads/upsert")).toBe(true);
    expect(isIdempotentCall("POST", [], undefined, "/crm/v8/Leads")).toBe(false);
    expect(isIdempotentCall("POST", [], "query { voyages { id } }")).toBe(true);
    expect(isIdempotentCall("POST", [], "mutation { book(id: 1) { ok } }")).toBe(false);
    expect(isLoginLike("/seaware/login")).toBe(true);
    expect(isLoginLike("/oauth/token")).toBe(true);
    expect(isLoginLike("Get session")).toBe(true);
    expect(isLoginLike("/voyages/{{ $request.params.id }}")).toBe(false);
    expect(isNotificationLike("/email/send")).toBe(true);
    expect(isNotificationLike("Send SMS")).toBe(true);
    expect(isNotificationLike("/voyages")).toBe(false);
  });
});

describe("catalog defaults (L2, L3, L4)", () => {
  it("HTTP Request has an explicit timeout below the gateway's, back-off and idempotent-only retries", () => {
    const def = BUILTIN_NODE_TYPES.find((t) => t.type === "http.request")!;
    expect(def.defaults).toMatchObject({ timeoutMs: 20000, retries: 2, retryDelaysMs: "1000, 3000" });
    const f = (k: string) => def.fields.find((x) => x.key === k)!;
    expect(f("retryUnsafe").default).toBe(false);
    expect(f("cacheSeconds")).toMatchObject({ default: 0, showIf: { key: "method", equals: "GET" } });
    expect(f("cacheSeconds").help).toMatch(/0 = off/);
    expect(f("shareIdentical").default).toBe(false);
    expect(f("background")).toMatchObject({ label: "Send in background (don't wait)", default: false });
    expect(f("reuseSession").default).toBe(false);
  });
  it("connector operations: reads may be shared, a notification may go in the background, a login may be reused", () => {
    const types = connectorNodeTypes(mailer);
    const keys = (id: string) => types.find((t) => t.type === `connector:cn_mail:${id}`)!.fields.map((f) => f.key);
    expect(keys("sendEmail")).toContain("background");
    expect(keys("sendEmail")).not.toContain("cacheSeconds");
    expect(keys("getTemplate")).toEqual(expect.arrayContaining(["cacheSeconds", "shareIdentical"]));
    expect(keys("getTemplate")).not.toContain("background");
    expect(keys("login")).toContain("reuseSession");
    expect(types[0].defaults).toMatchObject({ timeoutMs: 20000, retryDelaysMs: "1000, 3000" });
  });
});

describe("ReadShare (L2)", () => {
  it("identical in-flight calls share one call; nothing is kept when keepMs is 0", async () => {
    const s = new ReadShare<{ n: number }>(); let calls = 0;
    const call = () => new Promise<{ n: number }>((r) => setTimeout(() => r({ n: ++calls }), 30));
    const out = await Promise.all([1, 2, 3].map(() => s.run("k", { keepMs: 0, share: true, inflightMaxMs: 5000 }, call)));
    expect(calls).toBe(1);
    expect(out.map((o) => o.via).sort()).toEqual(["call", "shared", "shared"]);
    expect(s.inFlight()).toBe(0); expect(s.size()).toBe(0);
  });
  it("errors are never kept, waiters of a failed call make their own call, and the mark is released", async () => {
    const s = new ReadShare<number>(); let calls = 0;
    const failing = () => new Promise<number>((_r, j) => setTimeout(() => { calls++; j(new Error("boom")); }, 20));
    const ok = () => Promise.resolve(++calls);
    const a = s.run("k", { keepMs: 60_000, share: true, inflightMaxMs: 5000 }, failing);
    const b = s.run("k", { keepMs: 60_000, share: true, inflightMaxMs: 5000 }, ok);
    await expect(a).rejects.toThrow("boom");
    expect((await b).via).toBe("call");
    expect(s.inFlight()).toBe(0);
    expect((await s.run("k", { keepMs: 60_000, share: true, inflightMaxMs: 5000 }, ok)).via).toBe("kept");
  });
  it("a stuck in-flight mark expires: the waiter calls by itself after the limit", async () => {
    const s = new ReadShare<string>();
    void s.run("k", { keepMs: 0, share: true, inflightMaxMs: 50 }, () => new Promise<string>(() => undefined)).catch(() => undefined);
    const t0 = Date.now();
    const r = await s.run("k", { keepMs: 0, share: true, inflightMaxMs: 50 }, () => Promise.resolve("own"));
    expect(r).toEqual({ value: "own", via: "call" });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("a kept answer is a copy, expires, and can be forgotten", async () => {
    let now = 1000; const s = new ReadShare<{ a: number[] }>(10, () => now);
    await s.run("o|x", { keepMs: 100, share: false, inflightMaxMs: 1000 }, async () => ({ a: [1] }));
    const k = await s.run("o|x", { keepMs: 100, share: false, inflightMaxMs: 1000 }, async () => ({ a: [2] }));
    expect(k.via).toBe("kept"); k.value.a.push(9);
    expect((await s.run("o|x", { keepMs: 100, share: false, inflightMaxMs: 1000 }, async () => ({ a: [3] }))).value).toEqual({ a: [1] });
    now += 200;
    expect((await s.run("o|x", { keepMs: 100, share: false, inflightMaxMs: 1000 }, async () => ({ a: [4] }))).value).toEqual({ a: [4] });
    s.forget("o|"); expect(s.size()).toBe(0);
  });
});

describe("runtime (L1-L4)", () => {
  it("shares identical parallel reads and keeps the answer for the set seconds", async () => {
    httpShare.clear(); hits["GET /price"] = 0;
    const f = await rt.createFlow({ name: "price", flow: { nodes: [trig("/p"), node("n_call", "http.request", { method: "GET", url: `${base}/price`, shareIdentical: true, cacheSeconds: 60 }), node("n_out", "respond", { status: "200", body: "$" })], edges: [edge("n_in", "n_call"), edge("n_call", "n_out")] } as never });
    const runs = await Promise.all([1, 2, 3].map(() => rt.testFlow(f.id, { request: { method: "GET", path: "/p" } as never })));
    expect(runs.every((r) => r.status === "success")).toBe(true);
    expect(hits["GET /price"]).toBe(1);
    await rt.testFlow(f.id, { request: { method: "GET", path: "/p" } as never });
    expect(hits["GET /price"]).toBe(1);
  });
  it("does not share or keep a write even when asked", async () => {
    httpShare.clear(); hits["POST /price"] = 0;
    const f = await rt.createFlow({ name: "price-post", flow: { nodes: [trig("/pp"), node("n_call", "http.request", { method: "POST", url: `${base}/price`, shareIdentical: true, cacheSeconds: 60, bodyMode: "json", body: {} }), node("n_out", "respond", { status: "200", body: "$" })], edges: [edge("n_in", "n_call"), edge("n_call", "n_out")] } as never });
    await Promise.all([1, 2].map(() => rt.testFlow(f.id, { request: { method: "GET", path: "/pp" } as never })));
    expect(hits["POST /price"]).toBe(2);
  });
  it("reuses a login once per backend instead of logging in on every request (L1)", async () => {
    httpShare.clear(); hits["POST /login"] = 0;
    const f = await rt.createFlow({ name: "login", flow: { nodes: [trig("/s"), node("n_login", "http.request", { method: "POST", url: `${base}/login`, bodyMode: "json", body: { user: "svc" }, reuseSession: true, sessionSeconds: 120 }), node("n_out", "respond", { status: "200", body: "$" })], edges: [edge("n_in", "n_login"), edge("n_login", "n_out")] } as never });
    const runs = await Promise.all(Array.from({ length: 5 }, () => rt.testFlow(f.id, { request: { method: "GET", path: "/s" } as never })));
    expect(hits["POST /login"]).toBe(1);
    expect(new Set(runs.map((r) => JSON.stringify(r.response?.body))).size).toBe(1);
  });
  it("retries a read with back-off but never a POST without an Idempotency-Key (L4)", async () => {
    hits["GET /busy"] = 0; hits["POST /book"] = 0;
    const read = await rt.createFlow({ name: "busy-read", flow: { nodes: [trig("/b"), node("n_call", "http.request", { method: "GET", url: `${base}/busy`, retries: 2, retryDelaysMs: "5, 5" }), node("n_out", "respond", { status: "200", body: "$" })], edges: [edge("n_in", "n_call"), edge("n_call", "n_out")] } as never });
    await rt.testFlow(read.id, { request: { method: "GET", path: "/b" } as never });
    expect(hits["GET /busy"]).toBe(3);
    const write = await rt.createFlow({ name: "busy-write", flow: { nodes: [trig("/w"), node("n_call", "http.request", { method: "POST", url: `${base}/book`, retries: 2, retryDelaysMs: "5, 5", bodyMode: "json", body: {} }), node("n_out", "respond", { status: "200", body: "$" })], edges: [edge("n_in", "n_call"), edge("n_call", "n_out")] } as never });
    const ex = await rt.testFlow(write.id, { request: { method: "GET", path: "/w" } as never });
    expect(hits["POST /book"]).toBe(1);
    expect(JSON.stringify(ex.logs)).toContain("[L4]");
    const keyed = await rt.createFlow({ name: "busy-keyed", flow: { nodes: [trig("/k"), node("n_call", "http.request", { method: "POST", url: `${base}/book`, retries: 2, retryDelaysMs: "5, 5", bodyMode: "json", body: {}, headers: [{ key: "Idempotency-Key", value: "abc" }] }), node("n_out", "respond", { status: "200", body: "$" })], edges: [edge("n_in", "n_call"), edge("n_call", "n_out")] } as never });
    await rt.testFlow(keyed.id, { request: { method: "GET", path: "/k" } as never });
    expect(hits["POST /book"]).toBe(4);
  });
  it("sends in the background: the answer does not wait, a failure is retried and logged (L3)", async () => {
    hits["POST /mail"] = 0; mailFails = 1;
    const f = await rt.createFlow({ name: "mail-bg", flow: { nodes: [trig("/m"), node("n_mail", "http.request", { method: "POST", url: `${base}/mail`, bodyMode: "json", body: { to: "x" }, background: true }), node("n_out", "respond", { status: "200", body: "{ \"ok\": true }" })], edges: [edge("n_in", "n_mail"), edge("n_mail", "n_out")] } as never });
    const t0 = Date.now();
    const ex = await rt.testFlow(f.id, { request: { method: "GET", path: "/m" } as never });
    expect(ex.status).toBe("success");
    expect(ex.response?.body).toEqual({ ok: true });
    expect(Date.now() - t0).toBeLessThan(250);
    const until = Date.now() + 5000;
    while ((hits["POST /mail"] ?? 0) < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(hits["POST /mail"]).toBe(2);
  });
});

describe("validation warns on lesson violations", () => {
  it("login inside a loop (L1.login-in-loop) and per request although the connection has a token (L1.login-per-request)", () => {
    const loop = flowOf([trig(), node("n_each", "logic.foreach", { items: "$" }), node("n_login", "http.request", { method: "POST", url: "https://x.invalid/login" }, "Login"), node("n_out", "respond", {})],
      [edge("n_in", "n_each"), edge("n_each", "n_login", "each"), edge("n_each", "n_out", "done")]);
    expect(lessonIssues(loop).map((i) => i.lesson)).toContain("L1.login-in-loop");
    const per = flowOf([trig(), node("n_login", "http.request", { connection: "c1", method: "POST", url: "/auth/token" }, "Get token"), node("n_out", "respond", {})], [edge("n_in", "n_login"), edge("n_login", "n_out")]);
    const hit = lessonIssues(per, ctx({ c1: { authType: "oauth2cc" } })).find((i) => i.lesson === "L1.login-per-request")!;
    expect(hit.message).toMatch(/^\[L1 L1\.login-per-request\] Get token: .*already supplies a token.*Fix: /);
    const reused = flowOf([trig(), node("n_login", "http.request", { connection: "c1", method: "POST", url: "/auth/token", reuseSession: true }, "Get token"), node("n_out", "respond", {})], [edge("n_in", "n_login"), edge("n_login", "n_out")]);
    expect(lessonIssues(reused, ctx({ c1: { authType: "oauth2cc" } })).map((i) => i.lesson)).not.toContain("L1.login-per-request");
  });
  it("no timeout (L4.no-timeout) and a timeout not below the flow's (L4.timeout-too-long)", () => {
    const f = flowOf([trig(), node("n_a", "http.request", { method: "GET", url: "https://x.invalid/a", timeoutMs: "" }, "A"), node("n_b", "http.request", { method: "GET", url: "https://x.invalid/b", timeoutMs: 90000 }, "B")], [edge("n_in", "n_a"), edge("n_a", "n_b")]);
    const ids = lessonIssues(f).map((i) => `${i.nodeId} ${i.lesson}`);
    expect(ids).toEqual(expect.arrayContaining(["n_a L4.no-timeout", "n_b L4.timeout-too-long"]));
  });
  it("retry on POST without an idempotency key (L4.retry-non-idempotent); none with the key", () => {
    const bad = flowOf([trig(), node("n_a", "http.request", { method: "POST", url: "https://x.invalid/book", retries: 3, retryUnsafe: true }, "Book")], [edge("n_in", "n_a")]);
    expect(lessonIssues(bad).map((i) => i.lesson)).toContain("L4.retry-non-idempotent");
    const ok = flowOf([trig(), node("n_a", "http.request", { method: "POST", url: "https://x.invalid/book", retries: 3, retryUnsafe: true, headers: [{ key: "Idempotency-Key", value: "{{ $request.headers.x }}" }] }, "Book")], [edge("n_in", "n_a")]);
    expect(lessonIssues(ok).map((i) => i.lesson)).not.toContain("L4.retry-non-idempotent");
  });
  it("an e-mail send the answer waits for (L3.notify-blocks-answer); none in the background", () => {
    const wait = flowOf([trig(), node("n_m", "connector:cn_mail:sendEmail", { connection: "c1" }, "Send welcome")], [edge("n_in", "n_m")]);
    expect(lessonIssues(wait, ctx({ c1: { authType: "none" } })).map((i) => i.lesson)).toContain("L3.notify-blocks-answer");
    const bg = flowOf([trig(), node("n_m", "connector:cn_mail:sendEmail", { connection: "c1", background: true }, "Send welcome")], [edge("n_in", "n_m")]);
    expect(lessonIssues(bg, ctx({ c1: { authType: "none" } })).map((i) => i.lesson)).not.toContain("L3.notify-blocks-answer");
  });
  it("lesson findings are warnings: they never block a deploy", () => {
    const f = flowOf([trig(), node("n_a", "http.request", { method: "POST", url: "https://x.invalid/login", timeoutMs: "" }, "Login")], [edge("n_in", "n_a")]);
    expect(lessonIssues(f).length).toBeGreaterThan(0);
    expect(lessonIssues(f).every((i) => i.level === "warning")).toBe(true);
  });
});

describe("Describe the flow understands the lessons' phrases", () => {
  const c = { connections: [{ id: "c_api", name: "booking-api", type: "http", baseUrl: "https://b.invalid" }] };
  it("send the e-mail in the background", () => {
    const r = describeFlow("When POST /guests arrives\nCall POST /email/send on booking-api with email\nSend the e-mail in the background\nAnswer 200 with message \"ok\"", c);
    const call = r.flow.nodes.find((n) => n.type === "http.request")!;
    expect(call.config.background).toBe(true);
    expect(r.lines.every((l) => l.status !== "not-understood")).toBe(true);
    const inline = describeFlow("When POST /guests arrives\nCall POST /email/send on booking-api with email, in the background", c);
    expect(inline.flow.nodes.find((n) => n.type === "http.request")!.config.background).toBe(true);
  });
  it("cache for 60 seconds (reads only)", () => {
    const r = describeFlow("When GET /prices arrives\nCall GET /prices on booking-api\nCache it for 60 seconds", c);
    expect(r.flow.nodes.find((n) => n.type === "http.request")!.config).toMatchObject({ cacheSeconds: 60, shareIdentical: true });
    const m = describeFlow("When GET /prices arrives\nCall GET /prices on booking-api, cache the answer for 2 minutes", c);
    expect(m.flow.nodes.find((n) => n.type === "http.request")!.config.cacheSeconds).toBe(120);
    const w = describeFlow("When POST /book arrives\nCall POST /book on booking-api\nCache the answer for 60 seconds", c);
    expect(w.flow.nodes.find((n) => n.type === "http.request")!.config.cacheSeconds).toBeUndefined();
    expect(w.lines.some((l) => l.status === "warning")).toBe(true);
  });
  it("reuse the session", () => {
    const r = describeFlow("When GET /voyages arrives\nCall POST /login on booking-api\nReuse the session\nCall GET /voyages on booking-api", c);
    expect(r.flow.nodes.find((n) => n.name.includes("login") || String(n.config.url).includes("/login"))!.config).toMatchObject({ reuseSession: true, sessionSeconds: 240 });
    const t = describeFlow("When GET /voyages arrives\nCall POST /login on booking-api\nReuse the session for 4 minutes", c);
    expect(t.flow.nodes.find((n) => n.type === "http.request")!.config.sessionSeconds).toBe(240);
  });
});
