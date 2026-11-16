// Versions in git: pass-through to the migration tool (versions_routes.py), which keeps one private
// repository per workspace on the build server and pushes it. The signed-in user is put in `by`
// here; a browser-sent `by` is ignored. Settings values are never part of any answer.
import { sidOf } from "../auth.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { mtRequest, type MtClient } from "../mt.js";
import { withoutSecrets } from "../migrate/options.js";
import { runtimeRequest, type StudioConfig } from "../studio.js";

const API = /^[a-z0-9][a-z0-9-]{1,61}$/;
const FLOW = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;
const REMOTE = /^(git@github\.com:[\w.-]+\/[\w.-]+?(\.git)?|ssh:\/\/git@github\.com\/[\w.-]+\/[\w.-]+?(\.git)?)$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

export function revertBody(b: Record<string, unknown>) {
  const v = b.version;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? { ok: true as const, body: { version: v } } : { ok: false as const, error: "Choose the version to go back to." };
}
export function cloneBody(b: Record<string, unknown>, api: string) {
  const name = str(b.name, 62).trim().toLowerCase();
  return API.test(name) && name !== api ? { ok: true as const, body: { name } } : { ok: false as const, error: "Give the copy a new name: lower-case letters, digits and dashes." };
}
export function connectBody(b: Record<string, unknown>) {
  const remote = str(b.remote, 300).trim();
  return REMOTE.test(remote) ? { ok: true as const, body: { remote } } : { ok: false as const, error: "Give the repository's SSH address, for example git@github.com:<owner>/<repo>.git" };
}

export function registerVersions(app: FastifyInstance, cfg: Config) {
  const mt: MtClient = { base: cfg.MT_BASE_URL, token: cfg.MT_ADMIN_TOKEN };
  async function who(req: FastifyRequest): Promise<string> {
    const t = await app.tokenFor(sidOf(req) || "");
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
  const Q = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string>;
  const e = encodeURIComponent;
  const wsq = (req: FastifyRequest) => { const w = str(Q(req).workspace, 80); return w ? `?workspace=${e(w)}` : ""; };

  app.get("/api/factory/versions/status", async (req, reply) => { await who(req); return call(reply, "GET", `/api/versions/status${wsq(req)}`); });
  app.get("/api/factory/versions/token-check", async (req, reply) => { await who(req); return call(reply, "GET", `/api/versions/token-check${wsq(req)}`); });
  app.post("/api/factory/versions/connect", async (req, reply) => {
    await who(req); const v = connectBody(B(req));
    return v.ok ? call(reply, "POST", `/api/versions/connect${wsq(req)}`, v.body) : bad(reply, v.error);
  });
  app.post("/api/factory/versions/push", async (req, reply) => { await who(req); return call(reply, "POST", `/api/versions/push${wsq(req)}`, {}); });
  app.post("/api/factory/versions/seed", async (req, reply) => { const by = await who(req); return call(reply, "POST", `/api/versions/seed${wsq(req)}`, { by }); });
  app.get("/api/factory/versions/apis/:api", async (req, reply) => {
    await who(req); const { api } = P(req); const lim = /^\d{1,3}$/.test(str(Q(req).limit, 3)) ? `?limit=${Q(req).limit}` : "";
    return API.test(api) ? call(reply, "GET", `/api/versions/apis/${e(api)}${lim}`) : bad(reply, "unknown API", 404);
  });
  app.get("/api/factory/versions/apis/:api/diff", async (req, reply) => {
    await who(req); const { api } = P(req); const { from, to } = Q(req);
    if (!API.test(api) || !/^\d+$/.test(String(from)) || !/^\d+$/.test(String(to))) return bad(reply, "Give two version numbers.");
    return call(reply, "GET", `/api/versions/apis/${e(api)}/diff?from=${from}&to=${to}`);
  });
  app.get("/api/factory/versions/apis/:api/changes", async (req, reply) => {
    await who(req); const { api } = P(req);
    return API.test(api) ? call(reply, "GET", `/api/versions/apis/${e(api)}/changes`) : bad(reply, "unknown API", 404);
  });
  app.post("/api/factory/versions/apis/:api/:action", async (req, reply) => {
    const by = await who(req); const { api, action } = P(req);
    if (!API.test(api)) return bad(reply, "unknown API", 404);
    const b = B(req);
    if (action === "revert") { const v = revertBody(b); return v.ok ? call(reply, "POST", `/api/versions/apis/${e(api)}/revert`, { ...v.body, by }) : bad(reply, v.error); }
    if (action === "clone") { const v = cloneBody(b, api); return v.ok ? call(reply, "POST", `/api/versions/apis/${e(api)}/clone`, { ...v.body, by }) : bad(reply, v.error); }
    if (action === "propose") return call(reply, "POST", `/api/versions/apis/${e(api)}/propose`, { title: str(b.title, 120), by });
    return bad(reply, "unknown request", 404);
  });
  app.post("/api/factory/versions/apis/:api/changes/:n/:action", async (req, reply) => {
    const by = await who(req); const { api, n, action } = P(req);
    if (!API.test(api) || !/^\d{1,7}$/.test(n) || !["approve", "close"].includes(action)) return bad(reply, "unknown request", 404);
    return call(reply, "POST", `/api/versions/apis/${e(api)}/changes/${n}/${action}`, { by });
  });
  app.get("/api/factory/versions/flows/:id", async (req, reply) => {
    await who(req); const { id } = P(req);
    return FLOW.test(id) ? call(reply, "GET", `/api/versions/flows/${e(id)}`) : bad(reply, "unknown flow", 404);
  });
}

/** After a flow is deployed from the Studio, its definition (without secrets) becomes the next
 *  version in git. Never blocks or fails the deploy. */
export function flowVersionRecorder(cfg: Config, studio: StudioConfig) {
  const mt: MtClient = { base: cfg.MT_BASE_URL, token: cfg.MT_ADMIN_TOKEN };
  return (flowId: string, user: string) => {
    if (!FLOW.test(flowId)) return;
    void (async () => {
      try {
        const r = await runtimeRequest(studio, "GET", `/v1/flows/${encodeURIComponent(flowId)}`, undefined, user, 20_000);
        if (r.status >= 300) return;
        await mtRequest(mt, "POST", `/api/versions/flows/${encodeURIComponent(flowId)}`, { flow: JSON.parse(r.text), by: user.slice(0, 80), what: "deployed" });
      } catch { /* the deploy already succeeded; the version is recorded on the next deploy */ }
    })();
  };
}
