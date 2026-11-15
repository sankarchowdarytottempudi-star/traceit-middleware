// /api/factory/estate/* : the migrated services as the contract describes them
// (packages/weave-flow/CONTRACT.md, "Estate"). Read-only except clone, which creates a new
// editable flow in the Weave runtime and never touches the deployed service.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Connection } from "@traceit/weave-flow";
import type { Config } from "../config.js";
import type { ClientCreds } from "../auth.js";
import { mtRequest } from "../mt.js";
import { runtimeRequest } from "../studio.js";
import { K8s } from "./k8s.js";
import { GatewayCatalog } from "./gateway.js";
import { Estate } from "./service.js";
import { MigratedExecutions } from "./executions.js";
import { buildFlow } from "./flow.js";
import type { ConnectorModel } from "./model.js";

const problem = (reply: any, status: number, title: string, detail?: string) =>
  reply.code(status).type("application/problem+json").send({ type: "about:blank", title, status, detail });

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

/** Connection settings for a cloned connector. Never contains a secret. */
export function connectionConfig(c: ConnectorModel & { api?: string }, nodeUrl?: string): { type: string; config: Record<string, unknown>; note?: string } {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([^/:\s?#]+)(?::(\d+))?/i.exec(c.target);
  if (c.kind === "redis") return { type: "redis", config: { host: m?.[1] || "", port: Number(m?.[2] || 6379), db: 0, tls: /^rediss:/i.test(c.target), keyPrefix: "" } };
  if (c.kind === "postgres") return { type: "postgres", config: { host: m?.[1] || "", port: Number(m?.[2] || 5432), database: "", user: "", ssl: false } };
  const configured = /^https?:\/\//i.test(c.target) ? c.target.replace(/^(https?:\/\/)[^@/\s]*@/i, "$1").replace(/[?#].*$/, "") : "";
  const origin = configured.replace(/^(https?:\/\/[^/]+).*$/i, "$1");
  const baseUrl = nodeUrl || origin;
  return {
    type: "http", config: { baseUrl, authType: "none", defaultHeaders: [], timeoutMs: 30000, tlsVerify: true, healthPath: "" },
    note: nodeUrl && origin && nodeUrl !== origin ? `Reaches ${c.api} through its node port (${nodeUrl}); the deployed service uses ${origin}.` : !baseUrl ? "The address of this connector is not known from the configuration; enter it on the connection." : undefined,
  };
}

export function registerEstate(app: FastifyInstance, cfg: Config, creds?: ClientCreds): Estate {
  const k8s = new K8s({ apiUrl: cfg.K8S_API_URL || undefined, tokenFile: cfg.K8S_TOKEN_FILE || undefined, caFile: cfg.K8S_CA_FILE || undefined, namespace: cfg.K8S_NAMESPACE });
  const gateway = cfg.APIM_BASE_URL
    ? new GatewayCatalog({ baseUrl: cfg.APIM_BASE_URL, caPem: cfg.caPem }, creds ? { clientId: creds.clientId, clientSecret: creds.clientSecret, username: cfg.APIM_DCR_USERNAME, password: cfg.APIM_DCR_PASSWORD } : undefined)
    : undefined;
  const mt = { base: cfg.MT_BASE_URL, token: cfg.MT_ADMIN_TOKEN };
  const estate = new Estate({
    servicesDir: [cfg.SERVICES_DIR, cfg.ESTATE_EXTRA_SOURCES].filter(Boolean).join(",") || undefined, configDir: cfg.ESTATE_CONFIG_DIR || undefined, namespace: cfg.K8S_NAMESPACE,
    k8s, prometheusUrl: cfg.PROMETHEUS_URL || undefined, gateway, gatewayPublicUrl: cfg.GATEWAY_PUBLIC_URL || undefined,
    migrations: async () => {
      const r = await mtRequest(mt, "GET", "/api/migrations");
      const list = (r.json as { migrations?: any[] } | null)?.migrations;
      return Array.isArray(list) ? list.map((m) => ({ id: String(m.id), apiName: m.apiName || undefined, name: m.name || undefined, layer: m.layer || undefined })) : [];
    },
  });
  const runtime = { runtimeUrl: cfg.RUNTIME_URL, internalKey: cfg.RUNTIME_INTERNAL_KEY || "" };

  async function need(req: FastifyRequest): Promise<string> {
    const sid = req.unsignCookie(req.cookies.sid ?? "").value;
    const t = await app.tokenFor(sid || "");
    if (!t) throw Object.assign(new Error("Not signed in"), { statusCode: 401 });
    return t;
  }
  const apiName = (req: FastifyRequest) => String((req.params as { api: string }).api || "");

  app.get("/api/factory/estate", async (req) => {
    const token = await need(req);
    const q = req.query as { refresh?: string };
    return estate.overview(token, q.refresh === "1" || q.refresh === "true");
  });

  // Calls that went through the migrated services (their own logs plus the gateway's records).
  const executions = new MigratedExecutions({ k8s, metricsLog: cfg.APIM_METRICS_LOG || undefined, sources: (t) => estate.sources(t) });
  const one = (v: string | undefined, allowed: string[]) => (v && allowed.includes(v) ? v : undefined);

  app.get("/api/factory/estate/executions", async (req) => {
    const token = await need(req);
    const q = req.query as { api?: string; status?: string; kind?: string; via?: string; q?: string; limit?: string };
    return executions.list(token, {
      api: (q.api || "").slice(0, 120) || undefined, status: one(q.status, ["success", "error", "running", "unknown"]), kind: one(q.kind, ["call", "job"]),
      via: one(q.via, ["gateway", "direct", "internal", "unknown"]), q: (q.q || "").slice(0, 200) || undefined, limit: parseInt(q.limit || "200", 10) || 200,
    });
  });

  app.get("/api/factory/estate/executions/:id", async (req, reply) => {
    const token = await need(req);
    const x = await executions.get(token, String((req.params as { id: string }).id || ""));
    return x || problem(reply, 404, "This execution is no longer recorded", "Only what the services' logs and the gateway's records still hold can be shown.");
  });

  app.get("/api/factory/estate/:api", async (req, reply) => {
    const token = await need(req);
    const d = await estate.detail(apiName(req), token);
    return d || problem(reply, 404, "No such API in the estate");
  });

  app.get("/api/factory/estate/:api/flow", async (req, reply) => {
    const token = await need(req);
    const q = req.query as { operation?: string };
    const f = await estate.flow(apiName(req), q.operation || undefined, token);
    return f || problem(reply, 404, "No such API in the estate");
  });

  app.get("/api/factory/estate/:api/logs", async (req, reply) => {
    const token = await need(req);
    const q = req.query as { tail?: string; q?: string; level?: string; pod?: string };
    const tail = Math.min(Math.max(parseInt(q.tail || "200", 10) || 200, 1), 5000);
    const level = q.level && ["error", "warn", "info", "debug"].includes(q.level) ? q.level : undefined;
    const r = await estate.logs(apiName(req), { tail, q: (q.q || "").slice(0, 200) || undefined, level, pod: q.pod || undefined }, token);
    return r || problem(reply, 404, "No such API in the estate");
  });

  app.get("/api/factory/estate/:api/metrics", async (req, reply) => {
    const token = await need(req);
    const q = req.query as { hours?: string };
    const m = await estate.metrics(apiName(req), Number(q.hours || "1") || 1, token);
    return m || problem(reply, 404, "No such API in the estate");
  });

  app.post("/api/factory/estate/:api/clone", async (req, reply) => {
    const token = await need(req);
    const user = (await app.userFor(req)) || "unknown";
    const api = apiName(req);
    const name = String(((req.body ?? {}) as { name?: string }).name || "").trim().slice(0, 80);
    if (!name) return problem(reply, 400, "Give the copy a name");
    const input = await estate.cloneInput(api, token);
    if (!input) return problem(reply, 404, "This API cannot be copied", "Its source code is not readable on this server.");
    if (!runtime.internalKey) return problem(reply, 503, "The flow runtime is not configured");
    const rt = (method: string, path: string, body?: unknown) => runtimeRequest(runtime, method, path, body, user, 30_000);
    const snapshot = await estate.snapshot(token);
    try {
      const listed = await rt("GET", "/v1/connections");
      const existing: Connection[] = listed.status < 300 ? ((JSON.parse(listed.text) as { connections?: Connection[] }).connections || []) : [];
      const used = new Set(input.model.operations.flatMap((o) => o.calls.map((c) => c.connector)));
      const connections: Record<string, string> = {};
      const report: { connector: string; connection: string; id?: string; created: boolean; needsSecret: boolean; note?: string }[] = [];
      for (const c of input.connectors) {
        if (!used.has(c.name)) continue;
        const target = c.api ? snapshot.apis.find((a) => a.name === c.api) : undefined;
        const nodeUrl = target?.nodePort ? `http://${cfg.ESTATE_NODE_HOST}:${target.nodePort}` : undefined;
        const { type, config, note } = connectionConfig(c, nodeUrl);
        const cname = `${api} ${c.name}`.slice(0, 80);
        const needsSecret = c.secrets.length > 0;
        const found = existing.find((x) => x.name === cname && x.type === type);
        if (found) { connections[c.name] = found.id; report.push({ connector: c.name, connection: cname, id: found.id, created: false, needsSecret, note }); continue; }
        const made = await rt("POST", "/v1/connections", { name: cname, type, config });
        if (made.status < 300) {
          const id = (JSON.parse(made.text) as Connection).id;
          connections[c.name] = id; report.push({ connector: c.name, connection: cname, id, created: true, needsSecret, note });
        } else report.push({ connector: c.name, connection: cname, created: false, needsSecret, note: `The connection was not created (${made.status}); create it by hand.` });
      }
      const slug = slugOf(name) || slugOf(api) + "-copy";
      const flow = buildFlow(input.model, { apiOf: (cn) => input.connectors.find((x) => x.name === cn)?.api, editable: true, connections, basePath: `/${slug}/v1`, name });
      for (const n of flow.nodes) {
        const cn = n.config.__connector as string | undefined;
        const r = cn ? report.find((x) => x.connector === cn) : undefined;
        if (!r) continue;
        const extra = [
          r.needsSecret ? `Enter the credentials on the connection "${r.connection}" before running: secrets are never copied.` : "",
          r.id ? "" : `Create the connection "${r.connection}" and choose it here.`, r.note || "",
        ].filter(Boolean);
        if (extra.length) n.notes = [n.notes || "", ...extra].filter(Boolean).join("\n");
      }
      const body = (strip: boolean) => ({
        name, description: `Editable copy of ${api}. ${flow.description || ""}`.trim(),
        flow: {
          tags: flow.tags, edges: flow.edges, settings: { ...flow.settings, basePath: `/${slug}/v1`, gateway: { publish: false, security: "oauth2" as const } },
          nodes: strip ? flow.nodes.map((n) => ({ ...n, config: Object.fromEntries(Object.entries(n.config).filter(([k]) => !k.startsWith("__"))) })) : flow.nodes,
        },
        origin: { kind: "migrated" as const, ref: api },
      });
      let made = await rt("POST", "/v1/flows", body(false));
      if (made.status === 400 || made.status === 422) made = await rt("POST", "/v1/flows", body(true));
      if (made.status >= 300) {
        let detail = made.text.slice(0, 400);
        try { const p = JSON.parse(made.text) as { title?: string; detail?: string }; detail = [p.title, p.detail].filter(Boolean).join(": "); } catch { /* keep text */ }
        return problem(reply, made.status === 409 ? 409 : 502, "The flow runtime did not accept the copy", detail);
      }
      const created = JSON.parse(made.text) as { id: string };
      return { flowId: created.id, connections: report };
    } catch (e) {
      return problem(reply, 503, "The flow runtime is not reachable", e instanceof Error ? e.message : undefined);
    }
  });

  return estate;
}
