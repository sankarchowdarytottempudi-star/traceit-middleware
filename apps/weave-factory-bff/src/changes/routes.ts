// Change requests: pass-through to the migration tool, which runs a self-hosted code model on its
// build server (nothing leaves the server). The signed-in user is put in `by` here; a browser-sent
// `by` is ignored. Only the fields a change request takes travel on.
import { sidOf } from "../auth.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { mtRequest, type MtClient } from "../mt.js";
import { withoutSecrets } from "../migrate/options.js";

const API = /^[a-z0-9][a-z0-9-]{1,61}$/;
const CID = /^[0-9a-f]{12}$/;
const OP = /^(GET|POST|PUT|PATCH|DELETE) \/\S{0,300}$/;

/** A change request as the tool takes it, or why it cannot be sent. */
export function changeRequestBody(b: Record<string, unknown>): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const requirement = typeof b.requirement === "string" ? b.requirement.trim() : "";
  if (requirement.length < 10) return { ok: false, error: "Describe the requirement in a sentence or more." };
  if (requirement.length > 4000) return { ok: false, error: "Keep the requirement under 4000 characters." };
  const flow = typeof b.flow === "string" ? b.flow.trim().slice(0, 200) : "";
  const raw = Array.isArray(b.examples) ? b.examples : [];
  if (raw.length > 20) return { ok: false, error: "At most 20 examples." };
  const examples: Record<string, unknown>[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const x = e as Record<string, unknown>;
    const op = typeof x.op === "string" ? x.op.trim() : "";
    if (!OP.test(op)) return { ok: false, error: `Each example needs an operation like "GET /items/{id}" (got "${op.slice(0, 40)}").` };
    const row: Record<string, unknown> = { op };
    if (typeof x.name === "string") row.name = x.name.slice(0, 80);
    for (const k of ["query", "pathValues", "headers", "body", "backendReplies", "expectBodyHas", "expectCalls"]) if (k in x) row[k] = x[k];
    if (typeof x.expectStatus === "number" && x.expectStatus >= 100 && x.expectStatus < 600) row.expectStatus = Math.trunc(x.expectStatus);
    examples.push(row);
  }
  if (JSON.stringify(examples).length > 60000) return { ok: false, error: "The examples are too large." };
  return { ok: true, body: { requirement, flow, examples } };
}

export function registerChanges(app: FastifyInstance, cfg: Config) {
  const mt: MtClient = { base: cfg.MT_BASE_URL, token: cfg.MT_ADMIN_TOKEN };
  async function who(req: FastifyRequest): Promise<string> {
    const sid = sidOf(req);
    const t = await app.tokenFor(sid || "");
    if (!t) throw Object.assign(new Error("Not signed in"), { statusCode: 401 });
    const u = app.hasDecorator("userFor") ? await app.userFor(req) : null;
    return (u || "signed-in user").slice(0, 80);
  }
  const pass = (reply: any, r: { status: number; json: unknown }) => { reply.code(r.status === 0 ? 502 : r.status); return withoutSecrets(r.json ?? { ok: r.status < 400 }); };
  const bad = (reply: any, error: string, code = 400) => { reply.code(code); return { error }; };
  const call = async (reply: any, method: string, path: string, body?: unknown) => {
    try { return pass(reply, await mtRequest(mt, method, path, body)); } catch { return bad(reply, "The migration tool did not answer.", 502); }
  };
  const P = (req: FastifyRequest) => req.params as Record<string, string>;
  const B = (req: FastifyRequest) => ((req.body && typeof req.body === "object") ? req.body : {}) as Record<string, unknown>;

  app.get("/api/factory/changes/apis/:api", async (req, reply) => {
    await who(req); const { api } = P(req);
    return API.test(api) ? call(reply, "GET", `/api/changes/apis/${api}`) : bad(reply, "unknown API", 404);
  });
  app.post("/api/factory/changes/apis/:api", async (req, reply) => {
    const by = await who(req); const { api } = P(req);
    if (!API.test(api)) return bad(reply, "unknown API", 404);
    const v = changeRequestBody(B(req));
    if (!v.ok) return bad(reply, v.error);
    return call(reply, "POST", `/api/changes/apis/${api}`, { ...v.body, by });
  });
  app.post("/api/factory/changes/apis/:api/open-item", async (req, reply) => {
    const by = await who(req); const { api } = P(req);
    const b = B(req);
    const itemId = typeof b.itemId === "string" ? b.itemId.slice(0, 400) : "";
    if (!API.test(api) || !/^(op|entry|backend|code|start):.+/.test(itemId)) return bad(reply, "Choose an open item first.");
    return call(reply, "POST", `/api/changes/apis/${api}/open-item`, { itemId, by });
  });
  app.get("/api/factory/changes/:id", async (req, reply) => {
    await who(req); const { id } = P(req);
    return CID.test(id) ? call(reply, "GET", `/api/changes/${id}`) : bad(reply, "unknown change", 404);
  });
  app.post("/api/factory/changes/:id/:action", async (req, reply) => {
    const by = await who(req); const { id, action } = P(req);
    if (!CID.test(id) || !["propose", "approve", "reject"].includes(action)) return bad(reply, "unknown request", 404);
    return call(reply, "POST", `/api/changes/${id}/${action}`, { by });
  });
}
