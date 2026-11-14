// The API inventory: every service running in the cluster, every Weave Studio flow and every API
// on the gateway, joined into one list. Services are discovered from Kubernetes (nothing is
// hard-coded); a service with no API in front of it on the gateway is shown as "internal only".
import { readdirSync } from "node:fs";
import type { K8s, K8sDeployment, K8sPod, K8sService } from "./k8s.js";
import { selects } from "./k8s.js";
import type { Analytics, ApiRow, SourceState } from "./analytics.js";
import type { Runtime, RtFlow } from "./runtime.js";
import type { GatewayAnalytics, GwApiHour, GwStatus } from "./gwanalytics/index.js";
import { reason } from "./http.js";

export interface GatewayApi {
  id: string; name: string; context: string; version: string; lifeCycleStatus: string;
  security: string[]; throttling: string | null; tiers: string[];
  subscriptions: number | null; applications: string[];
  backend: string | null; cachingSeconds: number | null;
  operations: { verb: string; target: string; authType: string; throttling: string | null }[];
}
export interface Traffic { source: "service" | "gateway" | "runtime"; requests: number; errors: number; errorRate: number; avgMs: number | null; p95Ms: number | null; }
export interface InventoryItem {
  id: string; name: string;
  kind: "service" | "flow" | "gateway-api" | "component";
  role: string;                              // layer for services (system/process/experience), "worker"/"infrastructure" for components
  exposure: "published" | "draft" | "internal";
  gateway: GatewayApi[];
  cluster: { address: string; port: number | null; nodePort: number | null; namespace: string } | null;
  health: {
    state: "healthy" | "degraded" | "down" | "stopped" | "unknown";
    ready: number; desired: number; restarts: number; image: string;
    pods: { name: string; phase: string; ready: boolean; restarts: number; startedAt: string; reason: string }[];
  } | null;
  metricsExported: boolean | null;           // null = not applicable / unknown
  traffic: Traffic | null;                   // last hour
  factoryPath: string | null;                // appended to the Factory URL by the console
  logSource: string | null;
  description?: string;
}
export interface Inventory {
  generatedAt: string;
  sources: { kubernetes: SourceState; gateway: SourceState; metrics: SourceState; runtime: SourceState; gatewayAnalytics: GwStatus };
  summary: { services: number; published: number; internal: number; flows: number; gatewayOnly: number; unhealthy: number };
  items: InventoryItem[];
  components: InventoryItem[];
}

const SECURITY: Record<string, string> = { oauth2: "OAuth2 token", api_key: "API key", basic_auth: "Basic auth", mutualssl: "Mutual TLS" };
export function securityLabels(schemes: unknown, operations: { authType: string }[]): string[] {
  const list = (Array.isArray(schemes) ? schemes : []).map(String).filter((s) => !/_mandatory$/.test(s));
  const out = [...new Set(list.map((s) => SECURITY[s] ?? s))];
  if (operations.length && operations.every((o) => /^none$/i.test(o.authType))) return ["Open (no sign-in)"];
  return out;
}

/** Normalised first DNS label of a backend URL, plus host and port (for matching a gateway API to a service). */
export function backendTarget(url: string | null | undefined): { host: string; first: string; port: number | null } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return { host, first: host.split(".")[0].replace(/_/g, "-"), port: u.port ? Number(u.port) : null };
  } catch { return null; }
}

export function reshapeGatewayApi(a: any, subs: { count: number | null; applications: string[] }): GatewayApi {
  const operations = (Array.isArray(a?.operations) ? a.operations : []).map((o: any) => ({
    verb: String(o?.verb ?? ""), target: String(o?.target ?? ""), authType: String(o?.authType ?? "None"),
    throttling: typeof o?.throttlingPolicy === "string" ? o.throttlingPolicy : null }));
  const ec = a?.endpointConfig ?? {};
  const backend = ec?.production_endpoints?.url ?? ec?.sandbox_endpoints?.url ?? (Array.isArray(ec?.production_endpoints) ? ec.production_endpoints[0]?.url : null) ?? null;
  return {
    id: String(a?.id ?? ""), name: String(a?.name ?? ""), context: String(a?.context ?? ""), version: String(a?.version ?? ""),
    lifeCycleStatus: String(a?.lifeCycleStatus ?? "CREATED"),
    security: securityLabels(a?.securityScheme, operations),
    throttling: typeof a?.apiThrottlingPolicy === "string" && a.apiThrottlingPolicy ? a.apiThrottlingPolicy : null,
    tiers: (Array.isArray(a?.policies) ? a.policies : []).map(String),
    subscriptions: subs.count, applications: subs.applications,
    backend: typeof backend === "string" ? backend : null,
    cachingSeconds: a?.responseCachingEnabled ? Number(a?.cacheTimeout ?? 0) : null,
    operations,
  };
}

export function classify(d: K8sDeployment, serviceDirs: Set<string>): { kind: "service" | "component"; role: string } {
  const layerKey = Object.keys(d.labels).find((k) => k === "layer" || k.endsWith("/layer"));
  const layer = layerKey ? d.labels[layerKey] : "";
  const isApi = serviceDirs.has(d.name) || d.containers.some((c) => c.name === "api");
  if (isApi) return { kind: "service", role: layer || "service" };
  return { kind: "component", role: layer ? "worker" : "infrastructure" };
}

export function healthOf(d: K8sDeployment, pods: K8sPod[]): NonNullable<InventoryItem["health"]> {
  const state = d.desired === 0 ? "stopped" : d.ready >= d.desired ? "healthy" : d.ready > 0 ? "degraded" : "down";
  return {
    state, ready: d.ready, desired: d.desired, restarts: pods.reduce((n, p) => n + p.restarts, 0),
    image: d.containers[0]?.image ?? "",
    pods: pods.map((p) => ({ name: p.name, phase: p.phase, ready: p.ready, restarts: p.restarts, startedAt: p.startedAt, reason: p.reason })),
  };
}

function gwTraffic(apis: GatewayApi[], hour: Record<string, GwApiHour>): Traffic | null {
  let requests = 0; let errors = 0; let ms = 0; let p95 = 0; let seen = false;
  for (const a of apis) {
    const h = hour[a.name]; if (!h) continue;
    seen = true; requests += h.requests; errors += h.errors; ms += h.avgMs * h.requests; p95 = Math.max(p95, h.p95Ms);
  }
  if (!seen) return null;
  return { source: "gateway", requests, errors, errorRate: requests ? Math.round((errors / requests) * 10000) / 100 : 0, avgMs: requests ? Math.round((ms / requests) * 100) / 100 : null, p95Ms: requests ? p95 : null };
}
const fromRow = (r: ApiRow, source: Traffic["source"]): Traffic => ({ source, requests: r.requests, errors: r.errors, errorRate: r.errorRate, avgMs: r.avgMs ?? r.p50Ms, p95Ms: r.p95Ms });

export interface InventoryInput {
  deployments: K8sDeployment[]; pods: K8sPod[]; services: K8sService[]; serviceDirs: Set<string>;
  gatewayApis: GatewayApi[]; flows: RtFlow[];
  hour: { byName: Map<string, ApiRow>; flowsById: Map<string, ApiRow>; notExporting: Set<string>; ok: boolean };
  gwHour: Record<string, GwApiHour>; gwActive: boolean;
}

/** Pure join of everything we know into inventory rows. */
export function buildInventory(i: InventoryInput): { items: InventoryItem[]; components: InventoryItem[] } {
  const items: InventoryItem[] = []; const components: InventoryItem[] = [];
  const claimed = new Set<string>();
  const flowApiIds = new Map<string, RtFlow>();
  for (const f of i.flows) if (f.deployment?.gateway?.apiId) flowApiIds.set(f.deployment.gateway.apiId, f);

  for (const d of [...i.deployments].sort((a, b) => a.name.localeCompare(b.name))) {
    const { kind, role } = classify(d, i.serviceDirs);
    const pods = i.pods.filter((p) => selects(d.selector, p.labels));
    const svc = i.services.find((s) => selects(s.selector, d.selector) || s.name === d.name);
    const main = svc?.ports.find((p) => p.name === "http") ?? svc?.ports.find((p) => p.port === 80) ?? svc?.ports[0];
    const gateway = kind !== "service" ? [] : i.gatewayApis.filter((a) => {
      if (flowApiIds.has(a.id)) return false;
      const t = backendTarget(a.backend);
      if (t) return t.first === d.name || (!!svc && (t.host === svc.clusterIP || (!!t.port && svc.ports.some((p) => p.nodePort === t.port))));
      return a.name === d.name;
    });
    gateway.forEach((a) => claimed.add(a.id));
    const row = i.hour.byName.get(d.name);
    const exported = kind !== "service" ? null : !i.hour.ok ? null : !!row || !i.hour.notExporting.has(d.name);
    const traffic = row ? fromRow(row, "service") : gateway.length && i.gwActive ? gwTraffic(gateway, i.gwHour) ?? { source: "gateway" as const, requests: 0, errors: 0, errorRate: 0, avgMs: null, p95Ms: null } : null;
    const item: InventoryItem = {
      id: `svc:${d.name}`, name: d.name, kind, role,
      exposure: gateway.some((a) => a.lifeCycleStatus === "PUBLISHED") ? "published" : gateway.length ? "draft" : "internal",
      gateway,
      cluster: svc ? { address: `${svc.name}.${svc.namespace}.svc${main && main.port !== 80 ? `:${main.port}` : ""}`, port: main?.port ?? null, nodePort: main?.nodePort ?? null, namespace: svc.namespace } : null,
      health: healthOf(d, pods), metricsExported: exported, traffic,
      factoryPath: kind === "service" ? `/estate/${encodeURIComponent(d.name)}` : null,
      logSource: `svc:${d.name}`,
    };
    (kind === "service" ? items : components).push(item);
  }

  for (const f of i.flows) {
    const g = f.deployment?.gateway;
    const api = g?.apiId ? i.gatewayApis.find((a) => a.id === g.apiId) : undefined;
    if (api) claimed.add(api.id);
    const row = i.hour.flowsById.get(f.id);
    const deployed = f.deployment?.status === "deployed";
    items.push({
      id: `flow:${f.id}`, name: f.name || f.slug, kind: "flow", role: "flow",
      exposure: api ? (api.lifeCycleStatus === "PUBLISHED" ? "published" : "draft") : "internal",
      gateway: api ? [api] : [],
      cluster: null,
      health: { state: deployed ? "healthy" : "stopped", ready: deployed ? 1 : 0, desired: 1, restarts: 0, image: "", pods: [] },
      metricsExported: true, traffic: row ? fromRow(row, "runtime") : null,
      factoryPath: `/studio/flows/${encodeURIComponent(f.id)}`, logSource: `flow:${f.id}`,
      ...(f.description ? { description: f.description } : {}),
    });
  }

  for (const a of i.gatewayApis) {
    if (claimed.has(a.id)) continue;
    items.push({
      id: `gw:${a.id}`, name: a.name, kind: "gateway-api", role: "gateway",
      exposure: a.lifeCycleStatus === "PUBLISHED" ? "published" : "draft", gateway: [a], cluster: null, health: null,
      metricsExported: null, traffic: i.gwActive ? gwTraffic([a], i.gwHour) : null, factoryPath: null, logSource: "gw",
    });
  }
  return { items, components };
}

export interface InventoryDeps {
  k8s: K8s | null; servicesNs: string; servicesDir: string | undefined;
  runtime: Runtime; analytics: Analytics; gw: GatewayAnalytics;
  /** Calls the gateway's publisher API with the caller's token. */
  publisher: (token: string, path: string) => Promise<{ status: number; json: any }>;
}

export function createInventory(d: InventoryDeps) {
  let cluster: { at: number; value: Promise<{ deployments: K8sDeployment[]; pods: K8sPod[]; services: K8sService[] }> } | null = null;
  const detailCache = new Map<string, { at: number; value: GatewayApi }>();
  let last: { at: number; value: Promise<Inventory> } | null = null;

  function clusterState() {
    if (cluster && Date.now() - cluster.at < 5000) return cluster.value;
    const k = d.k8s!;
    const value = Promise.all([k.deployments(d.servicesNs), k.pods(d.servicesNs), k.services(d.servicesNs).catch(() => [] as K8sService[])])
      .then(([deployments, pods, services]) => ({ deployments, pods, services }));
    cluster = { at: Date.now(), value };
    value.catch(() => { cluster = null; });
    return value;
  }
  const serviceDirs = (): Set<string> => {
    if (!d.servicesDir) return new Set();
    try { return new Set(readdirSync(d.servicesDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name)); }
    catch { return new Set(); }
  };

  /** Names of everything that runs in the services namespace, by kind. */
  async function names(): Promise<{ name: string; kind: "service" | "component" }[]> {
    if (!d.k8s) return [];
    const dirs = serviceDirs();
    const c = await clusterState();
    return c.deployments.map((x) => ({ name: x.name, kind: classify(x, dirs).kind })).sort((a, b) => a.name.localeCompare(b.name));
  }
  const serviceNames = async () => (await names()).filter((n) => n.kind === "service").map((n) => n.name);

  async function gatewayApis(token: string): Promise<GatewayApi[]> {
    const { status, json } = await d.publisher(token, "/apis?limit=200");
    if (status >= 400 || status === 0) throw Object.assign(new Error(`HTTP ${status}`), { status });
    const list: any[] = json?.list ?? [];
    return Promise.all(list.map(async (s) => {
      const hit = detailCache.get(s.id);
      if (hit && Date.now() - hit.at < 60_000) return hit.value;
      const [det, subs] = await Promise.all([
        d.publisher(token, `/apis/${encodeURIComponent(s.id)}`).catch(() => ({ status: 0, json: null })),
        d.publisher(token, `/subscriptions?apiId=${encodeURIComponent(s.id)}&limit=100`).catch(() => ({ status: 0, json: null })),
      ]);
      const subList: any[] | null = subs.status === 200 ? (subs.json?.list ?? []) : null;
      const value = reshapeGatewayApi(det.status === 200 && det.json ? det.json : s, {
        count: subList ? Number(subs.json?.pagination?.total ?? subs.json?.count ?? subList.length) : null,
        applications: [...new Set((subList ?? []).map((x) => String(x?.applicationInfo?.name ?? "")).filter(Boolean))],
      });
      if (det.status === 200) detailCache.set(s.id, { at: Date.now(), value });
      return value;
    }));
  }

  async function build(token: string): Promise<Inventory> {
    const kubernetes: SourceState = { ok: false, configured: !!d.k8s };
    const gateway: SourceState = { ok: false, configured: true };
    let c = { deployments: [] as K8sDeployment[], pods: [] as K8sPod[], services: [] as K8sService[] };
    let apis: GatewayApi[] = [];
    const [cs, ga, fl, hour] = await Promise.all([
      d.k8s ? clusterState().then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e })) : Promise.resolve({ ok: false as const, e: new Error("not configured") }),
      gatewayApis(token).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e })),
      d.runtime.flows(),
      d.analytics.lastHour().catch(() => ({ ok: false, detail: "request failed", byName: new Map<string, ApiRow>(), flowsById: new Map<string, ApiRow>(), notExporting: new Set<string>() })),
    ]);
    if (cs.ok) { kubernetes.ok = true; c = cs.v; } else kubernetes.detail = d.k8s ? reason(cs.e) : "not configured";
    if (ga.ok) { gateway.ok = true; apis = ga.v; } else gateway.detail = reason(ga.e);
    const gwStatus = d.gw.status();
    const { items, components } = buildInventory({
      deployments: c.deployments, pods: c.pods, services: c.services, serviceDirs: serviceDirs(),
      gatewayApis: apis, flows: fl.ok ? fl.data : [], hour, gwHour: gwStatus.enabled ? d.gw.lastHourByApi() : {}, gwActive: gwStatus.enabled,
    });
    const services = items.filter((x) => x.kind === "service");
    return {
      generatedAt: new Date().toISOString(),
      sources: { kubernetes, gateway, metrics: { ok: hour.ok, configured: true, ...(hour.detail ? { detail: hour.detail } : {}) },
        runtime: { ok: fl.ok, configured: d.runtime.configured, ...(fl.ok ? {} : { detail: fl.detail }) }, gatewayAnalytics: gwStatus },
      summary: {
        services: services.length, published: services.filter((x) => x.exposure === "published").length,
        internal: services.filter((x) => x.exposure !== "published").length,
        flows: items.filter((x) => x.kind === "flow").length, gatewayOnly: items.filter((x) => x.kind === "gateway-api").length,
        unhealthy: items.filter((x) => x.health && (x.health.state === "down" || x.health.state === "degraded")).length,
      },
      items, components,
    };
  }

  function get(token: string): Promise<Inventory> {
    if (last && Date.now() - last.at < 8000) return last.value;
    const value = build(token);
    last = { at: Date.now(), value };
    value.catch(() => { last = null; });
    return value;
  }
  return { get, names, serviceNames };
}
export type InventoryService = ReturnType<typeof createInventory>;
