// The estate: every migrated service, assembled from four read-only sources: the service source
// code (parsed locally, see model.ts), the cluster, the metrics store and the API gateway.
// Nothing here changes any of them and nothing leaves this server.
import type { Flow } from "@traceit/weave-flow";
import { buildApi, discoverSources, type ApiModel, type ConnectorModel, type Layer } from "./model.js";
import { buildFlow } from "./flow.js";
import { K8s, mergeLogs, type K8sDeployment, type K8sPod, type K8sService, type LogLine } from "./k8s.js";
import { apiMetrics, hourTotals, type Metrics } from "./prom.js";
import { GatewayCatalog, matchGateway, type GatewayEntry } from "./gateway.js";
import { scrubUrl } from "./toml.js";
import { isHealthOnlyWarning, runSummary, startStates, type StartPart } from "./starts.js";

export interface EstateOptions {
  servicesDir?: string; configDir?: string; namespace: string;
  k8s: K8s; prometheusUrl?: string; gateway?: GatewayCatalog; gatewayPublicUrl?: string;
  /** Migrations known to the migration tool: [{ id, apiName, layer }] */
  migrations: () => Promise<{ id: string; apiName?: string; name?: string; layer?: string }[]>;
  /** The migration tool's check of every service: is anything of the old application still unwritten? */
  readiness?: () => Promise<ReadinessReport[]>;
}
export interface ReadinessReport {
  api: string; ready: boolean; exists?: boolean; summary?: string;
  placeholders?: { operation: string }[]; missingBackends?: string[]; missingEntries?: { name: string; starts: string }[];
  /** Parts of the service that start by themselves (timer, queue, topic) and their switch. */
  starts?: StartPart[];
}
/** Why a running service is not finished, in the words shown to the user. */
export interface Unfinished { summary: string; operations: string[]; entries: string[]; backends: string[]; }
export function unfinishedOf(report: ReadinessReport | undefined, notMigratedInCode: number): Unfinished | undefined {
  if (report && report.exists !== false) {
    if (report.ready) return undefined;
    return {
      summary: report.summary || "Part of the old application has not been written yet.",
      operations: (report.placeholders || []).map((p) => String(p.operation)),
      entries: (report.missingEntries || []).map((e) => `${e.name} (${e.starts})`),
      backends: (report.missingBackends || []).map(String),
    };
  }
  // no report for this service (the tool is unreachable, or the service is not one of its own): the code still tells
  return notMigratedInCode > 0
    ? { summary: `${notMigratedInCode} operation${notMigratedInCode === 1 ? " still answers" : "s still answer"} "not migrated"`, operations: [], entries: [], backends: [] }
    : undefined;
}

export type Via = "http" | "graphql" | "redis" | "postgres" | "other";
export interface EstateLink { from: string; to: string; via: Via; label?: string; toKind: "api" | "backend"; connector: string; component?: string; }
export interface EstateComponent { name: string; role: string; status: "running" | "down"; replicas: number; readyReplicas: number; }
export interface EstatePod { name: string; phase: string; ready: boolean; restarts: number; startedAt?: string; component?: string; }
export interface EstateApi {
  name: string; layer: Layer; technology: string; status: "running" | "down"; replicas: number; nodePort?: number; basePath?: string;
  gateway?: { published: boolean; context?: string; version?: string; url?: string; known: boolean; lifecycle?: string };
  operations: number; connectors: number; migrationId?: string;
  // additive
  readyReplicas: number; health: "healthy" | "degraded" | "down" | "unknown"; deployed: boolean; sourceAvailable: boolean;
  internalUrl?: string; lastDeployedAt?: string; image?: string; notMigrated: number; features: string[];
  requestsLastHour?: number; errorsLastHour?: number; metricsAvailable: boolean; components: EstateComponent[];
  /** Set when the service is installed but does not yet do everything the old application did. */
  unfinished?: Unfinished;
  /** How many parts of it start by themselves (timer, queue, topic). */
  startsBySelf: number;
}

const LAYERS: Record<string, Layer> = { experience: "exp", exp: "exp", process: "proc", proc: "proc", system: "sys", sys: "sys" };
export function layerOf(name: string, label?: string, mtLayer?: string): Layer {
  const l = LAYERS[(label || "").toLowerCase()] || LAYERS[(mtLayer || "").toLowerCase()];
  if (l) return l;
  if (/-exp(-|$)/.test(name)) return "exp";
  if (/-proc(ess)?(-|$)/.test(name)) return "proc";
  if (/-sys(-|$)/.test(name)) return "sys";
  return "other";
}

function hostOf(target: string): { host: string; port: string; path: string } | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([^/:\s?#]+)(?::(\d+))?([^\s?#]*)/i.exec(target.trim());
  return m ? { host: m[1], port: m[2] || "", path: m[3] || "" } : null;
}

/** Which other API of the estate a connector points at, if any. */
export function targetApi(conn: ConnectorModel, self: string, names: string[], nodePorts: Map<number, string>): string | undefined {
  if (conn.kind !== "http" && conn.kind !== "graphql") return undefined;
  const others = names.filter((n) => n !== self);
  const h = hostOf(conn.target);
  if (h) {
    const first = h.host.split(".")[0].toLowerCase();
    const byHost = others.find((n) => n.toLowerCase() === first);
    if (byHost) return byHost;
  }
  const segs = [h?.path || "", ...conn.paths].flatMap((p) => p.split("/")).map((s) => s.toLowerCase());
  const byPath = others.find((n) => segs.includes(n.toLowerCase()));
  if (byPath) return byPath;
  if (h?.port && nodePorts.has(Number(h.port))) { const n = nodePorts.get(Number(h.port))!; if (n !== self) return n; }
  return undefined;
}

/** A short name for something outside the estate: the host as configured, never credentials. */
export function backendLabel(conn: ConnectorModel, example = false): string {
  const h = hostOf(conn.target);
  // an example file's "localhost" says nothing about where the deployed service really points
  if (!h || (example && /^(localhost|127\.0\.0\.1)$/.test(h.host))) return conn.kind === "redis" ? "Redis" : conn.kind === "postgres" ? "Database" : conn.name.replace(/Client$/, "") || "Backend";
  const host = /^(localhost|127\.0\.0\.1)$/.test(h.host) ? `${h.host}${h.port ? ":" + h.port : ""}` : h.host.replace(/\.svc(\.cluster\.local)?$/, "");
  return host;
}

const VIA = new Set<Via>(["http", "graphql", "redis", "postgres"]);

/** When a service's real configuration is not readable (it lives in a cluster secret), the base path in
 *  the example file is only a sample. Work out the deployed base path from how the other APIs call it. */
export function correctBasePaths(models: ApiModel[]): void {
  for (const m of models) {
    if (m.configSource === "deployed" || !m.operations.length) continue;
    const marker = `/${m.name}/`;
    let found: string | undefined;
    for (const other of models) {
      if (other === m) continue;
      for (const c of other.connectors) for (const p of c.paths) {
        if (!p.startsWith(marker) || found) continue;
        const op = m.operations.find((o) => o.path !== "/" && p.endsWith(o.path));
        if (op) found = p.slice(0, p.length - op.path.length);
      }
    }
    if (!found) continue;
    const first = m.operations[0].service;
    const firstBase = m.basePaths[0] || "";
    const dropped = m.operations.filter((o) => o.service !== first).map((o) => o.id);
    m.operations = m.operations.filter((o) => o.service === first);
    for (const o of m.operations) o.fullPath = found + o.path;
    for (const c of m.connectors) c.usedBy = c.usedBy.filter((u) => !dropped.includes(u));
    for (const mp of m.mappings) if (mp.usedBy) mp.usedBy = mp.usedBy.filter((u) => !dropped.includes(u));
    // the reader has already said that the installed settings file cannot be opened
    const told = m.warnings.some((w) => w.includes("cannot be read by the Factory"));
    m.warnings.push(`${told ? "" : "The deployed configuration of this service is kept in a cluster secret and is not readable here. "}The base path ${found} is taken from how other services call it${firstBase && firstBase !== found ? ` (the example file says ${firstBase})` : ""}; other settings show the example values.`);
    m.basePath = found; m.basePaths = [found];
  }
}

interface Cluster { deployments: K8sDeployment[]; services: K8sService[]; pods: K8sPod[]; error?: string; }
export interface EstateCounts { services: number; finished: number; unfinished: number; migrations: number; migratedApis: number; }
interface Snapshot { at: number; starts: Map<string, StartPart[]>; counts: EstateCounts; apis: EstateApi[]; links: EstateLink[]; cluster: Cluster; companions: Map<string, K8sDeployment[]>; gateway: { known: boolean; error?: string }; notes: string[]; }

export class Estate {
  private modelCache?: { at: number; models: Map<string, ApiModel>; error?: string };
  private snap?: Snapshot;
  private inflight?: Promise<Snapshot>;
  constructor(private o: EstateOptions) {}

  /** Parsed source of every service (re-read every five minutes, or at once with refresh). */
  models(refresh = false): Map<string, ApiModel> {
    if (this.modelCache && !refresh && Date.now() - this.modelCache.at < 300_000) return this.modelCache.models;
    const models: ApiModel[] = [];
    const configDirs = (this.o.configDir || "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const entry of discoverSources(this.o.servicesDir)) {
      try { models.push(buildApi(entry, configDirs)); } catch { /* an unreadable service is listed without source */ }
    }
    correctBasePaths(models);
    this.modelCache = { at: Date.now(), models: new Map(models.map((m) => [m.name, m])) };
    return this.modelCache.models;
  }

  private async cluster(): Promise<Cluster> {
    if (!this.o.k8s.configured) return { deployments: [], services: [], pods: [], error: "Cluster access is not configured" };
    try {
      const [deployments, services, pods] = await Promise.all([this.o.k8s.deployments(), this.o.k8s.services(), this.o.k8s.pods()]);
      return { deployments, services, pods };
    } catch (e) { return { deployments: [], services: [], pods: [], error: e instanceof Error ? e.message : "The cluster is not reachable" }; }
  }

  async snapshot(userToken?: string | null, refresh = false): Promise<Snapshot> {
    if (this.snap && !refresh && Date.now() - this.snap.at < 10_000) return this.snap;
    if (this.inflight) return this.inflight;
    this.inflight = this.assemble(userToken, refresh).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async assemble(userToken: string | null | undefined, refresh: boolean): Promise<Snapshot> {
    const models = this.models(refresh);
    const [cluster, migrations, readiness, gw, totals] = await Promise.all([
      this.cluster(),
      this.o.migrations().catch(() => []),
      this.o.readiness ? this.o.readiness().catch(() => [] as ReadinessReport[]) : Promise.resolve([] as ReadinessReport[]),
      this.o.gateway ? this.o.gateway.entries(userToken) : Promise.resolve({ entries: [] as GatewayEntry[], known: false, error: "No gateway is configured" }),
      hourTotals(this.o.prometheusUrl),
    ]);
    const layerLabel = (d: K8sDeployment) => Object.entries(d.labels).find(([k]) => k.endsWith("/layer"))?.[1];
    const partOf = (d: K8sDeployment) => d.labels["app.kubernetes.io/part-of"];
    const labelled = cluster.deployments.filter((d) => layerLabel(d) !== undefined);
    // a labelled deployment without source that shares its group with exactly one service that has source is a part of that service
    const companions = new Map<string, K8sDeployment[]>();
    // with live cluster data, source that was generated but never deployed is not part of the running estate
    const live = !cluster.error && cluster.deployments.length > 0;
    const names = new Set<string>([...models.keys()].filter((n) => !live || cluster.deployments.some((d) => d.name === n)));
    for (const d of labelled) {
      if (models.has(d.name)) continue;
      const group = partOf(d);
      const owners = group ? labelled.filter((x) => x !== d && partOf(x) === group && models.has(x.name)) : [];
      const model = owners.length === 1 ? models.get(owners[0].name) : undefined;
      if (model && (model.components.length > 1 || d.name.startsWith(owners[0].name.replace(/-api$/, "")))) companions.set(owners[0].name, [...(companions.get(owners[0].name) || []), d]);
      else names.add(d.name);
    }
    const nodePorts = new Map<number, string>();
    const svcOf = (name: string) => cluster.services.find((s) => s.name === name) || cluster.services.find((s) => s.selector["app.kubernetes.io/name"] === name);
    for (const n of names) for (const p of svcOf(n)?.ports || []) if (p.nodePort) nodePorts.set(p.nodePort, n);
    const all = [...names].sort();

    const apis: EstateApi[] = all.map((name) => {
      const model = models.get(name);
      const dep = cluster.deployments.find((d) => d.name === name);
      const svc = svcOf(name);
      const port = svc?.ports.find((p) => p.nodePort) || svc?.ports[0];
      const mig = migrations.find((m) => m.apiName === name) || migrations.find((m) => m.name === name);
      const g = gw.known ? matchGateway(gw.entries, name, port?.nodePort, model?.basePath) : undefined;
      const t = totals.get(name);
      const notMigrated = model ? model.operations.filter((o) => !o.implemented).length : 0;
      const ready = dep?.ready ?? 0, want = dep?.replicas ?? 0;
      const parts: EstateComponent[] = (companions.get(name) || []).map((c) => ({ name: c.name, role: c.name.replace(name.replace(/-api$/, ""), "").replace(/^-+/, "") || "worker", status: c.ready > 0 ? "running" : "down", replicas: c.replicas, readyReplicas: c.ready }));
      const publicBase = (this.o.gatewayPublicUrl || "").replace(/\/+$/, "");
      return {
        name, layer: layerOf(name, dep ? layerLabel(dep) : undefined, mig?.layer), technology: model?.technology || "Ballerina",
        status: ready > 0 ? "running" : "down", replicas: want, nodePort: port?.nodePort, basePath: model?.basePath,
        gateway: gw.known
          ? (g ? { published: g.published, context: g.context, version: g.version, lifecycle: g.status, known: true, url: publicBase ? publicBase + g.context : undefined } : { published: false, known: true })
          : { published: false, known: false },
        operations: model?.operations.length ?? 0, connectors: model?.connectors.length ?? 0, migrationId: mig?.id,
        readyReplicas: ready, deployed: !!dep, sourceAvailable: !!model,
        health: cluster.error ? "unknown" : !dep || ready === 0 ? "down" : ready < want ? "degraded" : "healthy",
        internalUrl: svc && port ? `http://${svc.name}.${this.o.namespace}.svc:${port.port}` : undefined,
        lastDeployedAt: dep?.lastDeployedAt, image: dep?.images[0], notMigrated,
        unfinished: unfinishedOf(readiness.find((r) => r.api === name), notMigrated),
        startsBySelf: (readiness.find((r) => r.api === name)?.starts || []).length,
        features: model?.features || [], requestsLastHour: t?.scraped || t?.total ? t.total : undefined, errorsLastHour: t?.scraped || t?.total ? t.errors : undefined,
        metricsAvailable: !!t?.scraped, components: parts,
      };
    });

    const links: EstateLink[] = [];
    const seen = new Set<string>();
    for (const name of all) {
      const model = models.get(name);
      if (!model) continue;
      for (const c of model.connectors) {
        const to = targetApi(c, name, all, nodePorts);
        const via: Via = VIA.has(c.kind as Via) ? (c.kind as Via) : "other";
        const link: EstateLink = { from: name, to: to || backendLabel(c, model.configSource !== "deployed"), via, toKind: to ? "api" : "backend", connector: c.name, component: c.component,
          label: c.component ? `${c.component.replace(/^.*-/, "")}: ${c.paths[0] || via}` : c.paths.filter((p) => !p.includes("{")).slice(0, 1)[0] || undefined };
        const key = `${link.from}|${link.to}|${link.via}`;
        if (seen.has(key)) continue;
        seen.add(key); links.push(link);
      }
    }
    const notes: string[] = [];
    if (cluster.error) notes.push(`Live status is not available: ${cluster.error}.`);
    if (!models.size) notes.push("The service source code is not readable on this server, so operations, connectors and mappings cannot be shown.");
    if (!gw.known) notes.push(`Gateway status is not available${gw.error ? `: ${gw.error}` : ""}.`);
    const counts: EstateCounts = {
      services: apis.length, unfinished: apis.filter((a) => a.unfinished).length, finished: apis.filter((a) => !a.unfinished).length,
      migrations: migrations.length, migratedApis: new Set(migrations.map((m) => m.apiName || m.name || m.id)).size,
    };
    const starts = new Map<string, StartPart[]>(readiness.filter((r) => (r.starts || []).length).map((r) => [r.api, r.starts!]));
    this.snap = { at: Date.now(), starts, counts, apis, links, cluster, companions, gateway: { known: gw.known, error: gw.error }, notes };
    return this.snap;
  }

  async overview(userToken?: string | null, refresh = false) {
    const s = await this.snapshot(userToken, refresh);
    return { apis: s.apis, counts: s.counts, links: s.links, notes: s.notes, generatedAt: new Date(s.at).toISOString() };
  }

  async detail(name: string, userToken?: string | null) {
    const s = await this.snapshot(userToken);
    const api = s.apis.find((a) => a.name === name);
    if (!api) return null;
    const model = this.models().get(name);
    const pods = await this.podsOf(name, s);
    const names = s.apis.map((a) => a.name);
    const nodePorts = new Map<number, string>(s.apis.filter((a) => a.nodePort).map((a) => [a.nodePort!, a.name]));
    const parts = s.starts.get(name) || [];
    let selfStarting: ReturnType<typeof startStates> = [];
    let runs: ReturnType<typeof runSummary>;
    if (parts.length) {
      const pod = pods.find((p) => p.phase === "Running" && !p.component);
      const lines = pod && !s.cluster.error ? await this.o.k8s.logs(pod.name, 5000).catch(() => []) : [];
      selfStarting = startStates(parts, lines);
      runs = runSummary(lines);
    }
    return {
      ...api,
      selfStarting, runs,
      operationCount: api.operations, connectorCount: api.connectors,
      operations: (model?.operations || []).map((o) => ({
        id: o.id, method: o.method, path: o.fullPath, summary: o.summary, implemented: o.implemented, file: o.file, line: o.line,
        endLine: o.endLine, code: o.code, relativePath: o.path, params: o.params, responses: o.responses, features: o.features,
        headersForwarded: o.headersForwarded, headersRead: o.headersRead,
        calls: o.calls.map((c) => ({ connector: c.connector, kind: c.kind, op: c.op, method: c.method, path: c.path, mapping: c.mapping, headers: c.headers, forwarded: c.forwarded, file: c.src.file, line: c.src.line })),
      })),
      connectors: (model?.connectors || []).map((c) => {
        const to = targetApi(c, name, names, nodePorts);
        return { name: c.name, kind: c.kind, target: scrubUrl(c.target), usedBy: c.usedBy, configKey: c.configKey, auth: c.auth, component: c.component,
          file: c.file, line: c.line, code: c.code, paths: c.paths, settings: c.settings, secrets: c.secrets, api: to, backend: to ? undefined : backendLabel(c, model?.configSource !== "deployed"), exampleValues: model?.configSource !== "deployed" };
      }),
      mappings: model?.mappings || [],
      config: (model?.config || []).map((c) => ({ key: c.key, value: c.value, source: c.source, secret: c.secret, component: c.component, doc: c.doc })),
      configSource: model?.configSource, sourceComponents: model?.components || [],
      // a job that works from a timer or a queue has no operations on purpose: it does not "answer health checks only"
      warnings: (model?.warnings || []).filter((w) => !(parts.length && isHealthOnlyWarning(w))),
      links: s.links.filter((l) => l.from === name || l.to === name),
      pods,
    };
  }

  private async podsOf(name: string, s: Snapshot): Promise<EstatePod[]> {
    const out: EstatePod[] = [];
    const dep = s.cluster.deployments.find((d) => d.name === name);
    const sel = (d: K8sDeployment) => Object.entries(d.selector);
    const match = (d: K8sDeployment) => s.cluster.pods.filter((p) => sel(d).length > 0 && sel(d).every(([k, v]) => p.labels[k] === v));
    if (dep) for (const p of match(dep)) out.push({ name: p.name, phase: p.phase, ready: p.ready, restarts: p.restarts, startedAt: p.startedAt });
    for (const c of s.companions.get(name) || []) for (const p of match(c)) out.push({ name: p.name, phase: p.phase, ready: p.ready, restarts: p.restarts, startedAt: p.startedAt, component: c.name });
    return out;
  }

  /** Which running part belongs to which API: where the executions view reads its lines from. */
  async sources(userToken?: string | null): Promise<{ apis: { name: string; layer: Layer; published: boolean; context?: string }[]; pods: { pod: string; api: string; component?: string }[]; error?: string }> {
    const s = await this.snapshot(userToken);
    const pods: { pod: string; api: string; component?: string }[] = [];
    for (const a of s.apis) for (const p of await this.podsOf(a.name, s)) if (p.phase === "Running") pods.push({ pod: p.name, api: a.name, component: p.component });
    return { apis: s.apis.map((a) => ({ name: a.name, layer: a.layer, published: !!a.gateway?.published, context: a.gateway?.context })), pods, error: s.cluster.error };
  }

  async flow(name: string, operation: string | undefined, userToken?: string | null): Promise<Flow | null> {
    const s = await this.snapshot(userToken);
    const api = s.apis.find((a) => a.name === name);
    if (!api) return null;
    const model = this.models().get(name) || emptyModel(name);
    const names = s.apis.map((a) => a.name);
    const nodePorts = new Map<number, string>(s.apis.filter((a) => a.nodePort).map((a) => [a.nodePort!, a.name]));
    const byName = new Map(model.connectors.filter((c) => !c.component).map((c) => [c.name, c]));
    return buildFlow(model, {
      apiOf: (c) => { const conn = byName.get(c); return conn ? targetApi(conn, name, names, nodePorts) : undefined; },
      gateway: api.gateway?.known ? { published: api.gateway.published, context: api.gateway.context, version: api.gateway.version } : undefined,
      operation,
    });
  }

  async logs(name: string, opts: { tail: number; q?: string; level?: string; pod?: string }, userToken?: string | null): Promise<{ lines: LogLine[]; pods: EstatePod[]; errors: string[] } | null> {
    const s = await this.snapshot(userToken);
    if (!s.apis.some((a) => a.name === name)) return null;
    if (s.cluster.error) throw Object.assign(new Error(`Logs are not available: ${s.cluster.error}`), { statusCode: 503 });
    const pods = await this.podsOf(name, s);
    const wanted = opts.pod ? pods.filter((p) => p.name === opts.pod) : pods;
    const errors: string[] = [];
    // when searching, look further back so the filter still fills the screen
    const fetchTail = opts.q || opts.level ? Math.min(Math.max(opts.tail * 10, 1000), 5000) : opts.tail;
    const sets = await Promise.all(wanted.map((p) => this.o.k8s.logs(p.name, fetchTail).catch((e: Error) => { errors.push(e.message); return [] as LogLine[]; })));
    return { lines: mergeLogs(sets, opts.tail, opts.q, opts.level), pods, errors };
  }

  async metrics(name: string, hours: number, userToken?: string | null): Promise<Metrics | null> {
    const s = await this.snapshot(userToken);
    if (!s.apis.some((a) => a.name === name)) return null;
    return apiMetrics(this.o.prometheusUrl, name, hours);
  }

  /** What a clone needs: the model and the connectors to recreate (no secrets). */
  async cloneInput(name: string, userToken?: string | null): Promise<{ model: ApiModel; connectors: (ConnectorModel & { api?: string; internalUrl?: string })[] } | null> {
    const s = await this.snapshot(userToken);
    const model = this.models().get(name);
    if (!model || !s.apis.some((a) => a.name === name)) return null;
    const names = s.apis.map((a) => a.name);
    const nodePorts = new Map<number, string>(s.apis.filter((a) => a.nodePort).map((a) => [a.nodePort!, a.name]));
    return { model, connectors: model.connectors.filter((c) => !c.component).map((c) => {
      const to = targetApi(c, name, names, nodePorts);
      return { ...c, api: to, internalUrl: to ? s.apis.find((a) => a.name === to)?.internalUrl : undefined };
    }) };
  }
}

export function emptyModel(name: string): ApiModel {
  return { name, org: "", packageName: name, technology: "Ballerina", sourceAvailable: false, basePaths: [], operations: [], connectors: [], mappings: [], config: [], configSource: "defaults", components: [], features: [], warnings: ["The source code of this service is not readable on this server."] };
}
