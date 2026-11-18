// /api/factory/power : the on/off switch on the cards of the Flows page.
//   GET  /api/factory/power                 live state of every migrated service and flow (any signed-in user)
//   POST /api/factory/power/services/:name  { on: boolean }  scale a migrated service (admins only)
//   POST /api/factory/power/flows/:id       { on: boolean }  take a flow offline / put it live again (admins only)
// Every switch is recorded in the audit file (who, when, what, before -> after).
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { FlowSummary } from "@traceit/weave-flow";
import { runtimeRequest, type StudioConfig } from "../studio.js";
import { AuditLog, Power, PowerError, type AuditRecord, type KubeApi } from "./power.js";

export interface FlowPower { id: string; name: string; state: "on" | "off"; published?: boolean; last?: AuditRecord }

type Runtime = (method: string, path: string, body: unknown, user: string) => Promise<{ status: number; text: string }>;

export interface PowerDeps {
  kube: KubeApi | null;          // null: cluster access is not configured
  namespace: string;
  dataDir: string;
  runtime?: Runtime;             // null when the flow runtime is not configured
  now?: () => Date;
}

const problem = (reply: any, status: number, title: string, detail?: string) =>
  reply.code(status).type("application/problem+json").send({ type: "about:blank", title, status, detail });

export function runtimeOf(cfg: StudioConfig): Runtime | undefined {
  return cfg.runtimeUrl && cfg.internalKey ? (m, p, b, u) => runtimeRequest(cfg, m, p, b, u, 60_000) : undefined;
}

/** Flows that have a switch: the ones that are live, and the ones the switch took offline. */
export function flowPowers(flows: FlowSummary[], latest: Map<string, AuditRecord>): FlowPower[] {
  const out: FlowPower[] = [];
  for (const f of flows) {
    const last = latest.get(`flow:${f.id}`);
    const live = f.deployment?.status === "deployed";
    if (live) out.push({ id: f.id, name: f.name, state: "on", published: f.deployment?.gateway?.status === "published", ...(last ? { last } : {}) });
    else if (last?.action === "stop") out.push({ id: f.id, name: f.name, state: "off", published: last.detail?.published === true, last });
  }
  return out;
}

export function registerPower(app: FastifyInstance, d: PowerDeps): { power: Power | null; audit: AuditLog } {
  const audit = new AuditLog(join(d.dataDir, "power-audit.jsonl"));
  const power = d.kube ? new Power({ kube: d.kube, namespace: d.namespace, audit, now: d.now }) : null;
  const stamp = () => (d.now ? d.now() : new Date()).toISOString();

  async function who(req: FastifyRequest, admin: boolean): Promise<string> {
    const user = await app.userFor(req);
    if (!user) throw Object.assign(new Error("Not signed in"), { statusCode: 401 });
    if (admin && (await app.roleFor(req)) !== "admin") throw Object.assign(new Error("Only an admin can switch an API on or off"), { statusCode: 403 });
    return user.slice(0, 80);
  }
  const wantOn = (req: FastifyRequest): boolean | null => {
    const on = ((req.body ?? {}) as { on?: unknown }).on;
    return typeof on === "boolean" ? on : null;
  };

  app.get("/api/factory/power", async (req) => {
    await who(req, false);
    const canToggle = (await app.roleFor(req)) === "admin";
    const notes: string[] = [];
    let services: Awaited<ReturnType<Power["services"]>> = [];
    if (!power) notes.push("Cluster access is not configured, so migrated services cannot be switched from here.");
    else {
      try { services = await power.services(); }
      catch (e) { notes.push(`The live state of the migrated services is not available: ${(e as Error).message}`); }
    }
    let flows: FlowPower[] = [];
    if (d.runtime) {
      try {
        const r = await d.runtime("GET", "/v1/flows", undefined, "power-view");
        if (r.status < 300) flows = flowPowers((JSON.parse(r.text) as { flows?: FlowSummary[] }).flows || [], audit.latest());
        else notes.push(`The flow runtime answered ${r.status}.`);
      } catch { notes.push("The flow runtime cannot be reached."); }
    }
    return { canToggle, namespace: d.namespace, services, flows, notes };
  });

  app.post("/api/factory/power/services/:name", async (req, reply) => {
    const by = await who(req, true);
    const on = wantOn(req);
    if (on === null) return problem(reply, 400, "Say whether to switch it on or off", "Send { \"on\": true } or { \"on\": false }.");
    if (!power) return problem(reply, 503, "Cluster access is not configured");
    const name = String((req.params as { name: string }).name || "");
    try { return await (on ? power.start(name, by) : power.stop(name, by)); }
    catch (e) {
      if (e instanceof PowerError) return problem(reply, e.statusCode, e.message);
      throw e;
    }
  });

  app.post("/api/factory/power/flows/:id", async (req, reply) => {
    const by = await who(req, true);
    const on = wantOn(req);
    if (on === null) return problem(reply, 400, "Say whether to switch it on or off", "Send { \"on\": true } or { \"on\": false }.");
    if (!d.runtime) return problem(reply, 503, "The flow runtime is not configured");
    const id = String((req.params as { id: string }).id || "");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return problem(reply, 404, "No such flow");
    const got = await d.runtime("GET", `/v1/flows/${encodeURIComponent(id)}`, undefined, by);
    if (got.status === 404) return problem(reply, 404, "No such flow");
    if (got.status >= 300) return problem(reply, 502, "The flow runtime did not answer", `It answered ${got.status}.`);
    const flow = JSON.parse(got.text) as FlowSummary;
    const live = flow.deployment?.status === "deployed";
    const published = flow.deployment?.gateway?.status === "published";
    const last = audit.latest().get(`flow:${id}`);
    if (on === live) return { id, name: flow.name, state: live ? "on" : "off", published, ...(last ? { last } : {}) } satisfies FlowPower;
    const rec = (ok: boolean, extra: Partial<AuditRecord>): AuditRecord => {
      const r: AuditRecord = { at: stamp(), by, kind: "flow", target: id, action: on ? "start" : "stop", from: live ? `live${published ? ", on the gateway" : ""}` : "offline", to: on ? "live" : "offline", ok, ...extra };
      audit.append(r); return r;
    };
    // Put live again the way it was: on the gateway only if it was published when it was taken offline.
    const wasPublished = last?.action === "stop" && last.detail?.published === true;
    const r = on
      ? await d.runtime("POST", `/v1/flows/${encodeURIComponent(id)}/deploy`, { publishToGateway: wasPublished }, by)
      : await d.runtime("POST", `/v1/flows/${encodeURIComponent(id)}/undeploy`, {}, by);
    if (r.status >= 300) {
      let detail = r.text.slice(0, 300);
      try { const p = JSON.parse(r.text) as { title?: string; detail?: string }; detail = [p.title, p.detail].filter(Boolean).join(": "); } catch { /* keep text */ }
      rec(false, { error: detail });
      return problem(reply, r.status === 409 || r.status === 422 ? r.status : 502, on ? `${flow.name} was not put live` : `${flow.name} was not taken offline`, detail);
    }
    let nowPublished = published;
    if (on) { try { nowPublished = (JSON.parse(r.text) as { deployment?: FlowSummary["deployment"] }).deployment?.gateway?.status === "published"; } catch { nowPublished = false; } }
    const done = rec(true, { detail: { name: flow.name, published: nowPublished } });
    return { id, name: flow.name, state: on ? "on" : "off", published: nowPublished, last: done } satisfies FlowPower;
  });

  return { power, audit };
}
