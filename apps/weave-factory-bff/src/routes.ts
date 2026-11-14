import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { mtRequest, type MtClient } from "./mt.js";
import { createInferrer, type InferInput } from "./inference.js";

export function registerRoutes(app: FastifyInstance, cfg: Config) {
  const mt: MtClient = { base: cfg.MT_BASE_URL, token: cfg.MT_ADMIN_TOKEN };
  const inferrer = createInferrer(process.env.MODEL_URL || undefined);

  async function need(req: FastifyRequest): Promise<void> {
    const sid = req.unsignCookie(req.cookies.sid ?? "").value;
    const t = sid ? await app.tokenFor(sid) : null;
    if (!t) throw Object.assign(new Error("Not signed in"), { statusCode: 401 });
  }
  async function fwd(req: FastifyRequest, reply: any, method: string, path: string, body?: unknown) {
    await need(req);
    const { status, json } = await mtRequest(mt, method, path, body);
    reply.code(status === 0 ? 502 : status);
    return json ?? { ok: status < 400 };
  }

  app.get("/api/factory/workspaces", (req, reply) => fwd(req, reply, "GET", "/api/workspace-configs"));
  app.get("/api/factory/phases", (req, reply) => fwd(req, reply, "GET", "/api/phases"));
  app.get("/api/factory/migrations", (req, reply) => fwd(req, reply, "GET", "/api/migrations"));
  app.get("/api/factory/knowledge", (req, reply) => fwd(req, reply, "GET", "/api/knowledge"));
  app.get("/api/factory/migrations/:id", (req, reply) => {
    const { id } = req.params as { id: string };
    return fwd(req, reply, "GET", `/api/migrations/${encodeURIComponent(id)}`);
  });
  app.get("/api/factory/migrations/:id/feedback", (req, reply) => {
    const { id } = req.params as { id: string };
    return fwd(req, reply, "GET", `/api/migrations/${encodeURIComponent(id)}/feedback`);
  });
  app.get("/api/factory/migrations/:id/docs", (req, reply) => {
    const { id } = req.params as { id: string };
    return fwd(req, reply, "GET", `/api/migrations/${encodeURIComponent(id)}/docs`);
  });

  // Playground: send a per-API request, get the REAL response (engine lives in the backend).
  app.post("/api/factory/proxy", (req, reply) => fwd(req, reply, "POST", "/api/proxy", req.body));

  // By-example data-mapping inference (in-estate; no external AI).
  app.post("/api/factory/infer-mapping", async (req, reply) => {
    await need(req);
    const body = (req.body ?? {}) as InferInput;
    return reply.send(await inferrer.infer({ sampleSource: body.sampleSource ?? {}, desiredOutput: body.desiredOutput ?? {} }));
  });

  const ACTIONS = new Set(["verify", "parity", "optimize", "advance", "feedback"]);
  app.post("/api/factory/migrations/:id/:action", (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!ACTIONS.has(action)) { reply.code(404); return { error: "unknown action" }; }
    return fwd(req, reply, "POST", `/api/migrations/${encodeURIComponent(id)}/${action}`, req.body);
  });
  app.post("/api/factory/migrations/:id/run/:phase", (req, reply) => {
    const { id, phase } = req.params as { id: string; phase: string };
    return fwd(req, reply, "POST", `/api/migrations/${encodeURIComponent(id)}/run/${encodeURIComponent(phase)}`, req.body);
  });
}
