// Routes for the API inventory, analytics (service metrics + native gateway analytics) and logs.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { api } from "./wso2.js";
import { createK8s } from "./k8s.js";
import { createProm, isRange } from "./prom.js";
import { createRuntime } from "./runtime.js";
import { createAnalytics } from "./analytics.js";
import { createInventory } from "./inventory.js";
import { createLogs } from "./logs.js";
import { createGatewayAnalytics, type GwRange, type GwRecentQuery } from "./gwanalytics/index.js";

const GW_RANGES: GwRange[] = ["15m", "1h", "6h", "24h", "7d", "30d"];
const STATUSES = ["all", "2xx", "4xx", "5xx", "fault", "throttled"] as const;

export function registerInsightRoutes(app: FastifyInstance, cfg: Config) {
  const w = { baseUrl: cfg.APIM_BASE_URL, caPem: cfg.caPem };
  const servicesNs = cfg.K8S_NAMESPACE || "wso2";
  const k8s = createK8s({ apiUrl: cfg.K8S_API_URL || undefined, tokenFile: cfg.K8S_TOKEN_FILE || undefined, caFile: cfg.K8S_CA_FILE || undefined });
  const prom = createProm(cfg.PROMETHEUS_URL || undefined);
  const runtime = createRuntime(cfg.RUNTIME_URL || undefined, cfg.RUNTIME_INTERNAL_KEY || undefined);
  const gw = createGatewayAnalytics({ logDir: cfg.APIM_LOG_DIR || undefined, dataDir: cfg.DATA_DIR, log: (m) => app.log.info({ gatewayAnalytics: m }) });
  // eslint-disable-next-line prefer-const
  let inventory: ReturnType<typeof createInventory>;
  const analytics = createAnalytics({ prom, runtime, job: cfg.PROMETHEUS_JOB || "wso2-apis", knownServices: () => inventory.serviceNames() });
  inventory = createInventory({ k8s, servicesNs, servicesDir: cfg.SERVICES_DIR || undefined, runtime, analytics, gw,
    publisher: (token, path) => api(w, token, "GET", `/api/am/publisher/v4${path}`) });
  const logs = createLogs({ k8s, runtime, servicesNs, gatewayNs: cfg.GATEWAY_NAMESPACE || "apim", gatewayPodPrefix: cfg.GATEWAY_POD_PREFIX || "wso2am" });

  gw.start();
  app.decorate("gwAnalytics", gw);
  app.addHook("onClose", async () => { await gw.stop(); });

  async function need(req: FastifyRequest): Promise<string> {
    const t = await app.tokenForRequest(req);
    if (!t) throw Object.assign(new Error("Not signed in"), { statusCode: 401 });
    return t;
  }
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const int = (v: unknown, def: number, min: number, max: number) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : def; };

  app.get("/api/inventory", async (req) => inventory.get(await need(req)));

  app.get("/api/analytics/overview", async (req) => {
    await need(req);
    const r = str((req.query as any)?.range);
    return analytics.overview(isRange(r) ? r : "1h");
  });
  app.get("/api/analytics/api/:name", async (req) => {
    await need(req);
    const r = str((req.query as any)?.range);
    return analytics.detail(str((req.params as any)?.name).slice(0, 200), isRange(r) ? r : "1h");
  });

  app.get("/api/gateway-analytics/status", async (req) => { await need(req); return gw.status(); });
  app.get("/api/gateway-analytics/summary", async (req) => {
    await need(req);
    const q = req.query as Record<string, unknown>;
    const r = str(q.range) as GwRange;
    return { status: gw.status(), summary: gw.summary({ range: GW_RANGES.includes(r) ? r : "1h", api: str(q.api) || undefined, app: str(q.app) || undefined }) };
  });
  app.get("/api/gateway-analytics/requests", async (req) => {
    await need(req);
    const q = req.query as Record<string, unknown>;
    const status = str(q.status) as NonNullable<GwRecentQuery["status"]>;
    return { status: gw.status(), ...gw.recent({ search: str(q.search).slice(0, 200) || undefined, api: str(q.api) || undefined, app: str(q.app) || undefined,
      status: (STATUSES as readonly string[]).includes(status) ? status : "all", correlationId: str(q.cid).slice(0, 100) || undefined, limit: int(q.limit, 200, 1, 1000) }) };
  });

  app.get("/api/logs/sources", async (req) => {
    await need(req);
    const names = await inventory.names().catch(() => []);
    return logs.sources(names);
  });
  app.get("/api/logs", async (req) => {
    await need(req);
    const q = req.query as Record<string, unknown>;
    const sources = str(q.sources).split(",").map((s) => s.trim()).filter((s) => /^(gw|svc:[a-z0-9][a-z0-9.-]{0,100}|flow:[A-Za-z0-9_.-]{1,100})$/.test(s));
    if (!sources.length) throw Object.assign(new Error("Choose at least one API"), { statusCode: 400 });
    return logs.read({ sources, tail: int(q.tail, 500, 10, 5000), sinceSeconds: int(q.sinceSeconds, 0, 0, 7 * 86400) || undefined,
      level: str(q.level) || undefined, q: str(q.q).slice(0, 200) || undefined, cid: str(q.cid).slice(0, 100) || undefined });
  });
}
