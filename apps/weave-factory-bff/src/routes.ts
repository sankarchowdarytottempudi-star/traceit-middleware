import { sidOf } from "./auth.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { mtRequest, type MtClient } from "./mt.js";
import { createInferrer, type InferInput } from "./inference.js";
import { addressable, collisionOf, type MigrationLite } from "./migrate/options.js";

export function registerRoutes(app: FastifyInstance, cfg: Config) {
  const mt: MtClient = { base: cfg.MT_BASE_URL, token: cfg.MT_ADMIN_TOKEN };
  const inferrer = createInferrer(process.env.MODEL_URL || undefined);

  async function need(req: FastifyRequest): Promise<void> {
    const sid = sidOf(req);
    const t = await app.tokenFor(sid || "");
    if (!t) throw Object.assign(new Error("Not signed in"), { statusCode: 401 });
  }
  async function fwd(req: FastifyRequest, reply: any, method: string, path: string, body?: unknown) {
    await need(req);
    const { status, json } = await mtRequest(mt, method, path, body);
    reply.code(status === 0 ? 502 : status);
    return json ?? { ok: status < 400 };
  }

  // (GET /api/factory/workspaces lives in migrate/routes.ts: it merges the three places workspaces are kept.)
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

  // A step that writes a service (generate, test, deploy, scale) must not land on a service that
  // another migration already produced unless the user says so explicitly.
  const WRITES = new Set(["scaffold", "test", "deploy", "autorun", "spec", "optimize"]);
  async function guard(id: string, step: string, body: unknown): Promise<{ status: number; json: unknown } | null> {
    if (!WRITES.has(step) || (body as { confirmReplace?: boolean } | null)?.confirmReplace === true) return null;
    const r = await mtRequest(mt, "GET", "/api/migrations");
    const list = ((r.json as { migrations?: MigrationLite[] } | null)?.migrations || []) as MigrationLite[];
    const other = collisionOf(list, id);
    if (!other) return null;
    const me = list.find((m) => m.id === id);
    return { status: 409, json: { ok: false, needsConfirm: true, apiName: me?.apiName, otherMigration: { id: other.id, name: other.name },
      error: `The migration "${other.name || other.id}" already produced an API called ${me?.apiName}. Continuing would replace it.` } };
  }

  const ACTIONS = new Set(["verify", "parity", "optimize", "advance", "feedback"]);
  app.post("/api/factory/migrations/:id/:action", async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!ACTIONS.has(action)) { reply.code(404); return { error: "unknown action" }; }
    await need(req);
    const stop = await guard(id, action, req.body);
    if (stop) { reply.code(stop.status); return stop.json; }
    if (action === "parity" || action === "optimize") {
      // For an API it cannot address, the migration tool would send the request to a different service.
      const cur = await mtRequest(mt, "GET", `/api/migrations/${encodeURIComponent(id)}`);
      if (cur.status === 200 && !addressable((cur.json as { apiName?: string } | null)?.apiName, cfg.MT_COMPARE_APIS)) {
        reply.code(409);
        return { ok: false, error: action === "parity"
          ? "The migration tool cannot reach this API for a side by side comparison yet. Send the same request to the old and the new API from the Playground and compare the answers there."
          : "The migration tool cannot measure this API yet, so it cannot be optimised from here." };
      }
    }
    // Optimising takes no body; the other actions carry the user's request.
    return fwd(req, reply, "POST", `/api/migrations/${encodeURIComponent(id)}/${action}`, action === "optimize" ? undefined : req.body);
  });
  const PHASES = new Set(["document", "scaffold", "test", "deploy", "autorun", "spec"]);
  app.post("/api/factory/migrations/:id/run/:phase", async (req, reply) => {
    const { id, phase } = req.params as { id: string; phase: string };
    if (!PHASES.has(phase)) { reply.code(404); return { error: "unknown step" }; }
    await need(req);
    const stop = await guard(id, phase, req.body);
    if (stop) { reply.code(stop.status); return stop.json; }
    // "Run automatically" on a migration whose API name is not known yet only produces the documents:
    // generating the service waits until the name is known and has been checked against existing APIs.
    let run = phase;
    if (phase === "autorun") {
      const cur = await mtRequest(mt, "GET", `/api/migrations/${encodeURIComponent(id)}`);
      if (cur.status === 200 && !(cur.json as { apiName?: string } | null)?.apiName) run = "document";
    }
    // The migration tool takes no body for a step; whatever the screen sent (such as confirmReplace) stops here.
    const out = await fwd(req, reply, "POST", `/api/migrations/${encodeURIComponent(id)}/run/${run}`);
    return out && typeof out === "object" ? { ...(out as object), ran: run } : out;
  });
}
