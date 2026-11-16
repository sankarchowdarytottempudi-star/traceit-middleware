// Customer servers, environments and releases: pass-through to the migration tool, which drives
// the customer's servers over SSH (provisioner) and moves releases between environments (promote).
// Write-only fields — the one-time SSH password and the settings text — are forwarded only: never
// logged, stored here or sent back. The signed-in user is put in `by` here; a browser-sent `by`
// is ignored.
import { sidOf } from "../auth.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { mtRequest, type MtClient } from "../mt.js";
import { withoutSecrets } from "../migrate/options.js";

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const TIER = /^[a-z0-9-]{2,20}$/;
const API = /^[a-z0-9][a-z0-9-]{1,61}$/;
const SERVER_ACTIONS = new Set(["scan-host-key", "trust-host-key", "install-key", "preflight", "install", "uninstall"]);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Only the fields each action takes travel on. */
export function serverActionBody(action: string, b: Record<string, unknown>): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  switch (action) {
    case "trust-host-key": {
      const fp = str(b.fingerprint, 120).trim();
      return /^SHA256:[A-Za-z0-9+/=]{20,}$/.test(fp) ? { ok: true, body: { fingerprint: fp } } : { ok: false, error: "Give the SHA256 fingerprint exactly as shown." };
    }
    case "install-key": {
      const pw = typeof b.password === "string" ? b.password : "";
      if (!pw || pw.length > 200 || /[\r\n]/.test(pw)) return { ok: false, error: "Enter the password of the SSH user once (one line)." };
      return { ok: true, body: { password: pw } };
    }
    case "install": return { ok: true, body: { dryRun: b.dryRun === true } };
    case "uninstall": return { ok: true, body: { confirm: b.confirm === true, purge: b.purge === true } };
    default: return { ok: true, body: {} };
  }
}

export function environmentsBody(b: Record<string, unknown>): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const list = Array.isArray(b.environments) ? b.environments : null;
  if (!list || !list.length || list.length > 10) return { ok: false, error: "Give between 1 and 10 environments." };
  const out = [];
  for (const e of list) {
    const x = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    const name = str(x.name, 20).trim().toLowerCase(), server = str(x.server, 20).trim().toLowerCase();
    if (!TIER.test(name) || !TIER.test(server)) return { ok: false, error: "Each environment needs a short name and its server." };
    out.push({ name, server, approval: x.approval === true });
  }
  return { ok: true, body: { environments: out } };
}

export function settingsBody(b: Record<string, unknown>): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const text = typeof b.text === "string" ? b.text : "";
  if (!text.trim()) return { ok: false, error: "Paste the settings of this API for this environment." };
  if (Buffer.byteLength(text) > 200 * 1024) return { ok: false, error: "The settings are larger than 200 KB." };
  return { ok: true, body: { text } };
}

export function registerServers(app: FastifyInstance, cfg: Config) {
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
  const e = encodeURIComponent;

  app.get("/api/factory/workspace-configs/:id", async (req, reply) => {
    await who(req); const { id } = P(req);
    return ID.test(id) ? call(reply, "GET", `/api/workspace-configs/${e(id)}`) : bad(reply, "bad workspace");
  });
  app.get("/api/factory/workspace-configs/:id/servers/:tier/:what", async (req, reply) => {
    await who(req); const { id, tier, what } = P(req);
    if (!ID.test(id) || !TIER.test(tier) || !["key", "status"].includes(what)) return bad(reply, "unknown request", 404);
    return call(reply, "GET", `/api/workspace-configs/${e(id)}/servers/${e(tier)}/${what}`);
  });
  app.post("/api/factory/workspace-configs/:id/servers/:tier/:action", async (req, reply) => {
    const by = await who(req); const { id, tier, action } = P(req);
    if (!ID.test(id) || !TIER.test(tier) || !SERVER_ACTIONS.has(action)) return bad(reply, "unknown request", 404);
    const v = serverActionBody(action, B(req));
    if (!v.ok) return bad(reply, v.error);
    return call(reply, "POST", `/api/workspace-configs/${e(id)}/servers/${e(tier)}/${action}`, { ...v.body, by });
  });
  app.post("/api/factory/workspace-configs/:id/environments", async (req, reply) => {
    const by = await who(req); const { id } = P(req);
    if (!ID.test(id)) return bad(reply, "bad workspace");
    const v = environmentsBody(B(req));
    return v.ok ? call(reply, "POST", `/api/workspace-configs/${e(id)}/environments`, { ...v.body, by }) : bad(reply, v.error);
  });
  app.post("/api/factory/workspace-configs/:id/environments/:env/settings/:api", async (req, reply) => {
    const by = await who(req); const { id, env, api } = P(req);
    if (!ID.test(id) || !TIER.test(env) || !API.test(api)) return bad(reply, "unknown request", 404);
    const v = settingsBody(B(req));
    return v.ok ? call(reply, "POST", `/api/workspace-configs/${e(id)}/environments/${e(env)}/settings/${e(api)}`, { ...v.body, by }) : bad(reply, v.error);
  });
  app.get("/api/factory/workspace-configs/:id/apis/:api/environments", async (req, reply) => {
    await who(req); const { id, api } = P(req);
    return ID.test(id) && API.test(api) ? call(reply, "GET", `/api/workspace-configs/${e(id)}/apis/${e(api)}/environments`) : bad(reply, "unknown request", 404);
  });
  for (const action of ["deploy", "promote", "rollback"] as const) {
    app.post(`/api/factory/workspace-configs/:id/${action}`, async (req, reply) => {
      const by = await who(req); const { id } = P(req);
      if (!ID.test(id)) return bad(reply, "bad workspace");
      const b = B(req);
      const body = action === "deploy" ? { env: str(b.env, 20), releaseId: str(b.releaseId, 40) }
        : action === "promote" ? { api: str(b.api, 62), from: str(b.from, 20), to: str(b.to, 20) }
        : { api: str(b.api, 62), env: str(b.env, 20) };
      return call(reply, "POST", `/api/workspace-configs/${e(id)}/${action}`, { ...body, by });
    });
  }
  app.post("/api/factory/migrations/:id/releases", async (req, reply) => {
    const by = await who(req); const { id } = P(req);
    const version = str(B(req).version, 60).trim();
    if (!ID.test(id) || (version && !/^[A-Za-z0-9._-]{1,60}$/.test(version))) return bad(reply, "A version may use letters, digits, . _ and - only.");
    return call(reply, "POST", `/api/migrations/${e(id)}/releases`, { ...(version ? { version } : {}), by });
  });
  app.get("/api/factory/releases", async (req, reply) => {
    await who(req); const api = str((req.query as Record<string, unknown>).api, 62);
    return api && !API.test(api) ? bad(reply, "bad API") : call(reply, "GET", `/api/releases${api ? `?api=${e(api)}` : ""}`);
  });
  app.post("/api/factory/releases/:rid/approve", async (req, reply) => {
    const by = await who(req); const { rid } = P(req); const b = B(req);
    const approver = str(b.approver, 80).trim(), env = str(b.env, 20);
    if (!ID.test(rid) || !TIER.test(env)) return bad(reply, "unknown request", 404);
    if (approver.length < 3) return bad(reply, "Name the person who approves (first and last name).");
    return call(reply, "POST", `/api/releases/${e(rid)}/approve`, { env, approver, note: str(b.note, 300), by });
  });
  app.get("/api/factory/audit", async (req, reply) => {
    await who(req); const api = str((req.query as Record<string, unknown>).api, 62);
    return api && !API.test(api) ? bad(reply, "bad API") : call(reply, "GET", `/api/audit${api ? `?api=${e(api)}` : ""}`);
  });
  app.get("/api/factory/jobs/:jid", async (req, reply) => {
    await who(req); const { jid } = P(req);
    return ID.test(jid) ? call(reply, "GET", `/api/jobs/${e(jid)}`) : bad(reply, "unknown job", 404);
  });
}
