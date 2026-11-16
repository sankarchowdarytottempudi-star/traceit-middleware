// Which part of a Node.js project a migration covers: the project's routes to choose from, and the
// chosen part (route prefix, module folder or chosen routes, background jobs on/off). The work is
// done by the migration tool; only the chosen part's description travels from here.
import { sidOf } from "../auth.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { mtRequest, type MtClient } from "../mt.js";
import { withoutSecrets } from "./options.js";
import { partOf } from "./partspec.js";

export { partOf, scopeHeaderOf } from "./partspec.js";
export type { PartSpec } from "./partspec.js";

export function registerParts(app: FastifyInstance, cfg: Config) {
  const mt: MtClient = { base: cfg.MT_BASE_URL, token: cfg.MT_ADMIN_TOKEN };
  async function need(req: FastifyRequest): Promise<void> {
    const t = await app.tokenFor(sidOf(req) || "");
    if (!t) throw Object.assign(new Error("Not signed in"), { statusCode: 401 });
  }
  const pass = (reply: any, r: { status: number; json: unknown }) => { reply.code(r.status === 0 ? 502 : r.status); return withoutSecrets(r.json ?? { ok: r.status < 400 }); };
  const idOf = (req: FastifyRequest) => encodeURIComponent((req.params as { id: string }).id);

  app.get("/api/factory/migrations/:id/routes", async (req, reply) => {
    await need(req);
    return pass(reply, await mtRequest(mt, "GET", `/api/migrations/${idOf(req)}/routes`));
  });
  app.post("/api/factory/migrations/:id/scope", async (req, reply) => {
    await need(req);
    const p = partOf(req.body);
    if (!p.ok) { reply.code(400); return { error: p.error }; }
    return pass(reply, await mtRequest(mt, "POST", `/api/migrations/${idOf(req)}/scope`,
      { ...p.spec, ...(p.keepService ? { keepService: true } : {}), ...(p.confirm ? { confirm: true } : {}) }));
  });
}
