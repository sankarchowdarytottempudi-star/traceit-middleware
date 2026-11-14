// HTTP surface. /v1 = management API (loopback only, internal key). /run = live listeners
// (loopback + cluster bridge). The process never listens on a public interface.
import http from "node:http";
import crypto from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Flow, Json, SaveConnectionRequest, ValidationIssue } from "@traceit/weave-flow";
import type { Config } from "./config.js";
import { Problem, Runtime } from "./runtime.js";
import { compileInstruction } from "./mapping/instruction.js";
import { inferMapping } from "./mapping/infer.js";
import { importOpenApi } from "./openapi.js";
import { evalExpr, jsonToXml } from "./expr.js";
import type { FlowResponse } from "./engine/engine.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer"]);

function problem(reply: FastifyReply, status: number, title: string, detail?: string, issues?: ValidationIssue[], extra?: Record<string, unknown>) {
  return reply.code(status).type("application/problem+json").send(JSON.stringify({ type: "about:blank", title, status, ...(detail ? { detail } : {}), ...(issues ? { issues } : {}), ...(extra ?? {}) }));
}
function keyOk(given: unknown, want: string): boolean {
  if (typeof given !== "string" || !want) return false;
  const a = crypto.createHash("sha256").update(given).digest(), b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}
function jsonBody<T = Record<string, unknown>>(req: FastifyRequest): T {
  const b = req.body as Buffer | undefined;
  if (!b || !Buffer.isBuffer(b) || b.length === 0) return {} as T;
  try { return JSON.parse(b.toString("utf8")) as T; } catch { throw new Problem(400, "Bad request", "The request body is not valid JSON"); }
}
/** Body of a live request, by content type: JSON -> value, form -> object, anything textual -> string, binary -> base64. */
function liveBody(req: FastifyRequest): unknown {
  const b = req.body as Buffer | undefined;
  if (!b || !Buffer.isBuffer(b) || b.length === 0) return null;
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  const text = b.toString("utf8");
  if (ct.includes("json")) { try { return JSON.parse(text); } catch { throw new Problem(400, "Bad request", "The request body is not valid JSON"); } }
  if (ct.includes("x-www-form-urlencoded")) { const o: Record<string, unknown> = {}; for (const [k, v] of new URLSearchParams(text)) o[k] = o[k] === undefined ? v : ([] as unknown[]).concat(o[k], v); return o; }
  if (ct === "" && /^\s*[[{]/.test(text)) { try { return JSON.parse(text); } catch { return text; } }
  if (ct === "" || ct.startsWith("text/") || ct.includes("xml") || ct.includes("html") || ct.includes("graphql")) return text;
  return b.toString("base64");
}
function sendFlowResponse(reply: FastifyReply, r: FlowResponse, executionId: string) {
  reply.code(r.status);
  for (const [k, v] of Object.entries(r.headers ?? {})) if (!HOP.has(k.toLowerCase())) reply.header(k, v);
  reply.header("x-weave-execution-id", executionId);
  if (r.status === 204 || r.status === 304) return reply.send();
  const ct = r.contentType || r.headers?.["content-type"];
  const b = r.body;
  if (typeof b === "string") return reply.type(ct || (/^\s*</.test(b) ? "application/xml; charset=utf-8" : "text/plain; charset=utf-8")).send(b);
  if (ct && /xml/i.test(ct) && b && typeof b === "object") return reply.type(ct).send(jsonToXml(b));
  return reply.type(ct || "application/json; charset=utf-8").send(JSON.stringify(b === undefined ? null : b));
}

export interface RunningServer { app: FastifyInstance; rt: Runtime; close(): Promise<void>; addresses: string[]; }

export async function buildApp(cfg: Config, rt: Runtime): Promise<{ app: FastifyInstance; handler: http.RequestListener }> {
  let handler: http.RequestListener = () => undefined;
  const app = Fastify({
    logger: false, bodyLimit: 20 * 1024 * 1024, ignoreTrailingSlash: true, maxParamLength: 500,
    serverFactory: (h: http.RequestListener) => { handler = h; return http.createServer(h); },
  }) as unknown as FastifyInstance;
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof Problem) return problem(reply, err.status, err.title, err.detail, err.issues, err.extra);
    const e = err as { statusCode?: number; message?: string; code?: string };
    if (e.statusCode && e.statusCode < 500) return problem(reply, e.statusCode, e.statusCode === 413 ? "Payload too large" : "Bad request", e.message);
    console.error(`[weave-runtime] ${req.method} ${req.url.split("?")[0]} failed: ${e.message ?? String(err)}`);
    return problem(reply, 500, "Internal error", "The runtime hit an unexpected error; see its log");
  });
  app.setNotFoundHandler((_req, reply) => problem(reply, 404, "Not found"));

  app.addHook("onRequest", async (req, reply) => {
    const url = req.url;
    if (url === "/v1" || url.startsWith("/v1/")) {
      // The management API exists on loopback only; on any other address it does not exist.
      if (!LOOPBACK.has(req.socket.localAddress ?? "")) return problem(reply, 404, "Not found");
      if (url.split("?")[0] === "/v1/healthz") return;
      if (!keyOk(req.headers["x-weave-key"], cfg.internalKey)) return problem(reply, 401, "Unauthorized", "Missing or wrong internal key");
    }
  });

  const user = (req: FastifyRequest) => { const u = req.headers["x-weave-user"]; return typeof u === "string" && u.trim() ? u.trim().slice(0, 200) : undefined; };
  const P = <T extends Record<string, string>>(req: FastifyRequest) => req.params as T;
  const Q = (req: FastifyRequest) => req.query as Record<string, string | undefined>;

  // ---------------------------------------------------------------- /v1
  await app.register(async (v1) => {
    v1.get("/healthz", async () => ({ status: "UP", flowsDeployed: rt.flowsDeployed(), gateway: (await rt.gatewayReachable()) ? "reachable" : "unreachable" }));
    v1.get("/catalog", async () => rt.catalog());

    v1.get("/flows", async () => ({ flows: rt.listFlows() }));
    v1.post("/flows", async (req) => rt.createFlow(jsonBody(req), user(req)));
    v1.post("/flows/validate", async (req) => ({ issues: await rt.validate(jsonBody<{ flow: Flow }>(req).flow) }));
    v1.post("/flows/import", async (req) => rt.importFlow(jsonBody(req), user(req)));
    v1.get("/flows/:id", async (req) => rt.getFlow(P<{ id: string }>(req).id));
    v1.put("/flows/:id", async (req) => rt.updateFlow(P<{ id: string }>(req).id, jsonBody<Flow>(req), user(req)));
    v1.delete("/flows/:id", async (req) => { await rt.deleteFlow(P<{ id: string }>(req).id); return { ok: true }; });
    v1.post("/flows/:id/duplicate", async (req) => rt.duplicateFlow(P<{ id: string }>(req).id, jsonBody<{ name?: string }>(req).name, user(req)));
    v1.get("/flows/:id/versions", async (req) => ({ versions: rt.listVersions(P<{ id: string }>(req).id) }));
    v1.get("/flows/:id/versions/:revision", async (req) => rt.getVersion(P<{ id: string }>(req).id, Number(P<{ revision: string }>(req).revision)));
    v1.post("/flows/:id/versions/:revision/restore", async (req) => rt.restoreVersion(P<{ id: string }>(req).id, Number(P<{ revision: string }>(req).revision), user(req)));
    v1.get("/flows/:id/export", async (req) => rt.exportFlow(P<{ id: string }>(req).id));

    v1.post("/flows/:id/test", async (req) => rt.testFlow(P<{ id: string }>(req).id, jsonBody(req)));
    v1.post("/flows/:id/nodes/:nodeId/test", async (req) => rt.testNode(P<{ id: string }>(req).id, P<{ nodeId: string }>(req).nodeId, jsonBody(req)));
    v1.post("/flows/:id/deploy", async (req) => rt.deploy(P<{ id: string }>(req).id, jsonBody<{ publishToGateway?: boolean }>(req), user(req)));
    v1.post("/flows/:id/undeploy", async (req) => rt.undeploy(P<{ id: string }>(req).id));
    v1.post("/flows/:id/invoke", async (req) => rt.invoke(P<{ id: string }>(req).id, jsonBody(req)));
    v1.post("/gateway/resync", async () => ({ results: await rt.resync(true) }));

    v1.get("/executions", async (req) => { const q = Q(req); return { executions: rt.store.listExecutions({ flowId: q.flowId || undefined, status: q.status || undefined, mode: q.mode || undefined, limit: q.limit ? Number(q.limit) : undefined, before: q.before || undefined }) }; });
    v1.get("/executions/:id", async (req) => { const e = rt.store.getExecution(P<{ id: string }>(req).id); if (!e) throw new Problem(404, "Not found", "The execution does not exist (history is bounded per flow)"); return e; });
    v1.delete("/flows/:id/executions", async (req) => { rt.getFlow(P<{ id: string }>(req).id); rt.store.clearExecutions(P<{ id: string }>(req).id); return { ok: true }; });
    v1.get("/flows/:id/logs", async (req) => { const q = Q(req); rt.getFlow(P<{ id: string }>(req).id); return { lines: rt.store.readLogs(P<{ id: string }>(req).id, q.limit ? Number(q.limit) : 200, q.level || undefined) }; });
    v1.get("/stats", async (req) => rt.stats(Number(Q(req).hours ?? 24)));

    v1.get("/connections", async () => ({ connections: rt.listConnections() }));
    v1.post("/connections", async (req) => rt.createConnection(jsonBody<SaveConnectionRequest>(req)));
    v1.post("/connections/test", async (req) => rt.testConnection({ draft: jsonBody<SaveConnectionRequest>(req) }));
    v1.put("/connections/:id", async (req) => rt.updateConnection(P<{ id: string }>(req).id, jsonBody<SaveConnectionRequest>(req)));
    v1.delete("/connections/:id", async (req) => { rt.deleteConnection(P<{ id: string }>(req).id); return { ok: true }; });
    v1.post("/connections/:id/test", async (req) => rt.testConnection({ id: P<{ id: string }>(req).id }));

    v1.get("/connectors", async () => ({ connectors: rt.listConnectors() }));
    v1.post("/connectors", async (req) => rt.createConnector(jsonBody(req)));
    v1.post("/connectors/import-openapi", async (req) => { const b = jsonBody<{ name?: string; spec?: Json | string }>(req); try { return importOpenApi(b.spec, b.name); } catch (e) { throw new Problem(400, "Cannot read this API description", (e as Error).message); } });
    v1.put("/connectors/:id", async (req) => rt.updateConnector(P<{ id: string }>(req).id, jsonBody(req)));
    v1.delete("/connectors/:id", async (req) => { rt.deleteConnector(P<{ id: string }>(req).id); return { ok: true }; });

    v1.post("/mapping/preview", async (req) => rt.mappingPreview(jsonBody(req)));
    v1.post("/mapping/infer", async (req) => {
      const b = jsonBody<{ sampleSource?: Json; desiredOutput?: Json }>(req);
      if (b.sampleSource === undefined || b.desiredOutput === undefined) throw new Problem(400, "Bad request", "Send { sampleSource, desiredOutput }");
      return { rules: inferMapping(b.sampleSource, b.desiredOutput), engine: "rules" };
    });
    v1.post("/mapping/compile-instruction", async (req) => {
      const b = jsonBody<{ instruction?: string; target?: string; sampleSource?: Json; desiredValue?: Json }>(req);
      if (typeof b.instruction !== "string" || !b.instruction.trim()) throw new Problem(400, "Bad request", "Send { instruction }");
      const r = await compileInstruction({ instruction: b.instruction, target: b.target, sampleSource: b.sampleSource, desiredValue: b.desiredValue }, cfg.modelUrl ? { modelUrl: cfg.modelUrl, http: rt.http } : undefined);
      const out: Record<string, unknown> = { ok: r.ok, compiled: r.compiled, suggestions: r.suggestions, understood: r.understood, fields: r.fields, ...(r.reason ? { reason: r.reason } : {}) };
      if (r.compiled && b.sampleSource !== undefined) {
        try {
          const v = await evalExpr(r.compiled.expr, { payload: b.sampleSource, input: b.sampleSource });
          out.preview = v === undefined ? null : v;
          if (b.desiredValue !== undefined) out.matchesDesired = JSON.stringify(out.preview) === JSON.stringify(b.desiredValue);
        } catch (e) { out.previewError = (e as Error).message; }
      }
      return out;
    });
    v1.post("/expr/eval", async (req) => rt.evalExpression(jsonBody(req)));
  }, { prefix: "/v1" });

  // ---------------------------------------------------------------- /run (live listeners)
  const live = async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?")[0].slice("/run".length) || "/";
    let decoded = path; try { decoded = decodeURI(path); } catch { /* keep raw */ }
    const m = rt.matchLive(req.method, decoded);
    if ("status" in m) return problem(reply, m.status, m.status === 405 ? "Method not allowed" : "Not found", m.detail);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
    // Calls that arrive on the cluster bridge come through the API gateway pod.
    const via = LOOPBACK.has(req.socket.localAddress ?? "") && !headers["activityid"] ? "direct" : "gateway";
    const { response, executionId } = await rt.runLive(m, { method: req.method, query: { ...(req.query as Record<string, unknown>) }, headers, body: liveBody(req) }, via);
    return sendFlowResponse(reply, response, executionId);
  };
  app.route({ method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"], url: "/run", handler: live });
  app.route({ method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"], url: "/run/*", handler: live });

  await app.ready();
  return { app, handler };
}

/** Listens on every address in BIND (and only on those). */
export async function startServer(cfg: Config, rt: Runtime): Promise<RunningServer> {
  const { app, handler } = await buildApp(cfg, rt);
  const extra: http.Server[] = [];
  const addresses: string[] = [];
  await app.listen({ port: cfg.port, host: cfg.binds[0] });
  addresses.push(`${cfg.binds[0]}:${cfg.port}`);
  for (const host of cfg.binds.slice(1)) {
    const s = http.createServer(handler);
    await new Promise<void>((resolve, reject) => { s.once("error", reject); s.listen(cfg.port, host, () => { s.off("error", reject); resolve(); }); });
    extra.push(s); addresses.push(`${host}:${cfg.port}`);
  }
  return {
    app, rt, addresses,
    close: async () => { for (const s of extra) { s.closeAllConnections?.(); await new Promise<void>((r) => s.close(() => r())); } await app.close(); await rt.close(); },
  };
}
