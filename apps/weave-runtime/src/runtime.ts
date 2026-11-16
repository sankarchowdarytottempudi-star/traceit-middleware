// The runtime service: owns the store, the engine, the live listeners, the schedules and the
// gateway publisher. routes.ts is a thin HTTP layer over this class.
import type {
  CatalogResponse, Connection, ConnectorDef, CreateFlowRequest, Execution, Flow, FlowDeployment, FlowNode, FlowSummary, HttpRequestSample,
  InvokeRequest, InvokeResponse, Json, MappingPreviewResponse, MappingSpec, SaveConnectionRequest, StatsResponse, TestFlowRequest,
  TestNodeRequest, TestNodeResponse, ValidationIssue,
} from "@traceit/weave-flow";
import { BUILTIN_CONNECTION_TYPES } from "@traceit/weave-flow";
import { Cron } from "croner";
import type { Config } from "./config.js";
import { SecretBox } from "./crypto.js";
import { Store, newId, type StoredConnection } from "./store.js";
import { ClusterDns } from "./clients/dns.js";
import { HttpClient, readBody } from "./clients/http.js";
import { DataClients, type ResolvedConnection } from "./clients/data.js";
import { ENGINE_LABEL, explain as explainSql, connectProblem, whereOf } from "./clients/sqldb.js";
import { Engine, lowerKeys, type FlowResponse, type RuntimeRequest } from "./engine/engine.js";
import { authHeaders, joinUrl, matchRoutes, triggerRoutes, type TriggerRoute } from "./engine/nodes.js";
import { buildCatalog, templateGraph } from "./catalog.js";
import { SLUG_RE, validateFlow, type ValidateCtx } from "./validate.js";
import { applyMapping, diffJson, type InstructionCompiler } from "./mapping/apply.js";
import { compileInstruction } from "./mapping/instruction.js";
import { evalExpr, renderTemplate, type ExprScope } from "./expr.js";
import { redact } from "./redact.js";
import { NullGateway, type Gateway } from "./gateway/types.js";

export class Problem extends Error {
  constructor(readonly status: number, readonly title: string, readonly detail?: string, readonly issues?: ValidationIssue[], readonly extra?: Record<string, unknown>) { super(detail || title); }
}
const notFound = (what: string) => new Problem(404, "Not found", `${what} does not exist`);

interface LiveEntry { flow: Flow; basePath: string; routes: TriggerRoute[]; }
export interface LiveResult { response: FlowResponse; executionId: string; }

export function slugify(name: string): string {
  const s = String(name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return s || "flow";
}
const normPath = (p: string) => "/" + String(p || "").replace(/^\/+|\/+$/g, "");

export class Runtime {
  readonly store: Store;
  readonly box: SecretBox;
  readonly dns: ClusterDns;
  readonly http: HttpClient;
  readonly data: DataClients;
  readonly engine: Engine;
  gateway: Gateway = new NullGateway();
  private live = new Map<string, LiveEntry>();
  private jobs = new Map<string, { stop(): void }[]>();
  private resolved = new Map<string, { at: string; conn: ResolvedConnection }>();
  private gwReachable: { at: number; ok: boolean } = { at: 0, ok: false };
  private reconcileTimer?: NodeJS.Timeout;
  private reconciling = false;
  readonly startedAt = Date.now();
  readonly compiler: InstructionCompiler = async (rule, source) => {
    const r = await compileInstruction({ instruction: rule.instruction ?? "", target: rule.target, sampleSource: source as Json }, this.cfg.modelUrl ? { modelUrl: this.cfg.modelUrl, http: this.http } : undefined);
    return { compiled: r.compiled, reason: r.reason, suggestions: r.suggestions };
  };

  constructor(readonly cfg: Config) {
    this.store = new Store(cfg.dataDir, cfg.execHistoryPerFlow);
    this.box = SecretBox.fromFile(cfg.secretKeyFile);
    this.dns = new ClusterDns(cfg.clusterDns);
    this.http = new HttpClient(this.dns);
    this.data = new DataClients(this.dns);
    this.engine = new Engine({
      resolveConnection: (id) => this.resolveConnection(id),
      getConnector: (id) => this.store.getConnector(id),
      getFlowForCall: (ref, mode) => this.flowForCall(ref, mode),
      http: this.http, data: this.data, compileInstruction: this.compiler,
      onLog: (line) => this.store.appendLog(line),
      onStart: (e) => { if (e.mode !== "node-test") this.store.trackRunning(e); },
      onFinish: (e) => {
        if (e.mode === "node-test") return;
        this.store.addExecution(e);
        if (e.mode === "live") this.store.addMetric({ t: Date.parse(e.startedAt), flowId: e.flowId, ms: e.durationMs ?? 0, ok: e.status === "success" && (e.response?.status ?? 200) < 500 });   // a handled failure that still answers 5xx counts as an error
      },
    });
    this.refreshLive();
  }

  // ------------------------------------------------------------------ helpers
  private vctx(): ValidateCtx {
    return {
      getConnection: (id) => this.store.getConnection(id), getConnector: (id) => this.store.getConnector(id),
      getFlow: (id) => this.findFlow(id), reservedContexts: this.gateway.reservedContexts(),
    };
  }
  private findFlow(ref: string): Flow | undefined {
    return this.store.getFlow(ref) ?? this.store.listFlows().find((f) => f.slug === ref) ?? this.store.listFlows().find((f) => f.name === ref);
  }
  private flowForCall(ref: string, mode: Execution["mode"]): Flow | undefined {
    const f = this.findFlow(ref);
    if (!f) return undefined;
    if (mode === "live") return this.live.get(f.id)?.flow ?? f;
    return f;
  }
  private uniqueSlug(wanted: string, exceptId?: string): string {
    const taken = new Set(this.store.listFlows().filter((f) => f.id !== exceptId).map((f) => f.slug));
    if (!taken.has(wanted)) return wanted;
    for (let i = 2; ; i++) { const s = `${wanted.slice(0, 44)}-${i}`; if (!taken.has(s)) return s; }
  }
  private summary(f: Flow): FlowSummary {
    const last = this.store.lastExecution(f.id);
    return {
      id: f.id, name: f.name, slug: f.slug, description: f.description, tags: f.tags, origin: f.origin, revision: f.revision, updatedAt: f.updatedAt,
      deployment: f.deployment ?? null, nodeCount: f.nodes.filter((n) => n.type !== "note").length,
      triggers: f.nodes.filter((n) => n.type.startsWith("trigger.")).map((n) => n.type === "trigger.http" ? `${((n.config?.methods as string[] | undefined) ?? ["GET"]).join(",")} ${String(n.config?.path ?? "/")}` : n.type === "trigger.schedule" ? (n.config?.mode === "cron" ? `cron ${String(n.config?.cron ?? "")}` : `every ${String(n.config?.everySeconds ?? 300)}s`) : "manual"),
      lastExecution: last ? { status: last.status, at: last.startedAt } : null,
    };
  }
  /** Shapes whatever the client sent into a well-formed flow (no validation of meaning). */
  private shape(input: Partial<Flow>, base: Flow): Flow {
    const nodes: FlowNode[] = (Array.isArray(input.nodes) ? input.nodes : base.nodes).filter((n) => n && typeof n === "object").map((n) => ({
      ...n, id: String(n.id || newId("n")), type: String(n.type || ""), name: String(n.name ?? ""),
      position: { x: Number(n.position?.x) || 0, y: Number(n.position?.y) || 0 }, config: n.config && typeof n.config === "object" ? n.config : {},
    }));
    const edges = (Array.isArray(input.edges) ? input.edges : base.edges).filter((e) => e && typeof e === "object").map((e) => ({ id: String(e.id || newId("e")), from: String(e.from ?? ""), fromPort: String(e.fromPort || "out"), to: String(e.to ?? "") }));
    const s = { ...base.settings, ...(input.settings ?? {}) };
    const gw = { ...base.settings.gateway, ...(input.settings?.gateway ?? {}) };
    return {
      ...base,
      name: input.name !== undefined ? String(input.name).trim() : base.name,
      description: input.description !== undefined ? input.description : base.description,
      tags: Array.isArray(input.tags) ? input.tags.map(String) : base.tags,
      origin: input.origin ?? base.origin,
      nodes, edges,
      settings: {
        basePath: normPath(String(s.basePath || base.settings.basePath)),
        ...(s.timeoutMs !== undefined ? { timeoutMs: Math.max(100, Math.min(Number(s.timeoutMs) || 60000, 900_000)) } : {}),
        ...(s.logPayloads !== undefined ? { logPayloads: s.logPayloads !== false } : {}),
        gateway: {
          publish: gw.publish !== false, security: gw.security === "none" ? "none" : "oauth2",
          ...(gw.context ? { context: normPath(String(gw.context)) } : {}), ...(gw.version ? { version: String(gw.version) } : {}),
          ...(gw.throttlingPolicy ? { throttlingPolicy: String(gw.throttlingPolicy) } : {}),
        },
      },
    };
  }
  /** Fills `compiled` for plain-words mapping rules the local interpreter understands. */
  async prepare(flow: Flow): Promise<Flow> {
    for (const n of flow.nodes) {
      if (n.type !== "transform.map") continue;
      const spec = n.config?.mapping as MappingSpec | undefined;
      if (!spec || !Array.isArray(spec.rules)) continue;
      for (const r of spec.rules) {
        if (!r || r.kind !== "instruction" || !r.instruction || !r.instruction.trim()) continue;
        if (r.compiled && typeof r.compiled.expr === "string" && r.compiled.expr.trim()) continue;
        try { const c = await this.compiler(r, spec.sampleSource); if (c.compiled) r.compiled = c.compiled; } catch { /* stays uncompiled: validation reports it */ }
      }
    }
    return flow;
  }

  // ------------------------------------------------------------------ catalog & flows
  catalog(): CatalogResponse { return buildCatalog(this.store.listConnectors()); }
  listFlows(): FlowSummary[] { return this.store.listFlows().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((f) => this.summary(f)); }
  getFlow(id: string): Flow { const f = this.store.getFlow(id); if (!f) throw notFound("The flow"); return f; }

  async createFlow(req: CreateFlowRequest, user?: string): Promise<Flow> {
    const name = String(req?.name ?? req?.flow?.name ?? "").trim();
    if (!name) throw new Problem(400, "Bad request", "Give the flow a name");
    const now = new Date().toISOString();
    const wantedSlug = req.flow?.slug && SLUG_RE.test(req.flow.slug) ? req.flow.slug : slugify(name);
    const slug = this.uniqueSlug(wantedSlug);
    const tpl = req.flow?.nodes ? undefined : templateGraph(req.templateId ?? "blank-http");
    if (req.templateId && !tpl && !req.flow?.nodes) throw new Problem(400, "Bad request", `There is no template "${req.templateId}"`);
    const base: Flow = {
      id: newId("fl"), name, slug, description: req.description ?? req.flow?.description, tags: [], nodes: tpl?.nodes ?? [], edges: tpl?.edges ?? [],
      settings: { basePath: `/${slug}/v1`, timeoutMs: 60000, logPayloads: true, gateway: { publish: true, security: "oauth2", version: "v1", throttlingPolicy: "Unlimited" } },
      origin: req.origin ?? req.flow?.origin ?? (req.templateId ? { kind: "template", ref: req.templateId } : { kind: "blank" }),
      revision: 1, createdAt: now, updatedAt: now, updatedBy: user,
    };
    const flow = this.shape({ ...(req.flow ?? {}), name }, base);
    // An imported/cloned graph that still carries someone else's base path gets its own.
    if (this.store.listFlows().some((f) => f.settings.basePath === flow.settings.basePath)) flow.settings.basePath = `/${slug}/v1`;
    return this.store.saveFlow(await this.prepare(flow), { note: "Created" });
  }
  async updateFlow(id: string, body: Flow, user?: string): Promise<Flow> {
    const cur = this.getFlow(id);
    if (!body || typeof body !== "object") throw new Problem(400, "Bad request", "Send the flow as JSON");
    if (!Number.isInteger(body.revision)) throw new Problem(400, "Bad request", "Send the revision you edited");
    if (body.revision !== cur.revision) throw new Problem(409, "Edit conflict", `This flow was saved by ${cur.updatedBy || "someone else"} in the meantime (it is now at revision ${cur.revision}, you edited revision ${body.revision}). Reload it to continue.`, undefined, { currentRevision: cur.revision });
    const next = this.shape(body, cur);
    if (!next.name) throw new Problem(400, "Bad request", "The flow needs a name");
    if (body.slug !== undefined && body.slug !== cur.slug) {
      if (!SLUG_RE.test(String(body.slug))) throw new Problem(400, "Bad request", "The slug may contain lower-case letters, digits and dashes only");
      if (this.store.listFlows().some((f) => f.id !== id && f.slug === body.slug)) throw new Problem(409, "Conflict", `Another flow already uses the slug "${body.slug}"`);
      next.slug = body.slug;
    }
    next.revision = cur.revision + 1; next.updatedAt = new Date().toISOString(); next.updatedBy = user ?? cur.updatedBy;
    return this.store.saveFlow(await this.prepare(next));
  }
  async deleteFlow(id: string): Promise<void> {
    const f = this.getFlow(id);
    const used = this.store.listFlows().filter((o) => o.id !== id && o.nodes.some((n) => n.type === "flow.call" && n.config?.flow === id));
    if (used.length) throw new Problem(409, "In use", `This flow is called by: ${used.map((u) => u.name).join(", ")}. Remove those Call Flow steps first.`, undefined, { flows: used.map((u) => ({ id: u.id, name: u.name })) });
    if (f.deployment) await this.undeploy(id).catch(() => undefined);
    this.store.deleteFlow(id);
    this.refreshLive();
  }
  async duplicateFlow(id: string, name?: string, user?: string): Promise<Flow> {
    const src = this.getFlow(id);
    const { deployment: _d, ...rest } = src;
    const copy = JSON.parse(JSON.stringify(rest)) as Flow;
    const settings = { ...copy.settings, basePath: "", gateway: { ...copy.settings.gateway } };
    delete settings.gateway.context;
    const created = await this.createFlow({ name: (name && name.trim()) || `${src.name} copy`, description: src.description, flow: { nodes: copy.nodes, edges: copy.edges, tags: copy.tags, settings }, origin: { kind: "clone", ref: src.id } }, user);
    return created;
  }
  exportFlow(id: string): Flow { const { deployment: _d, ...f } = this.getFlow(id); return f as Flow; }
  async importFlow(body: { flow?: Flow; name?: string }, user?: string): Promise<Flow> {
    const f = body?.flow;
    if (!f || typeof f !== "object" || !Array.isArray(f.nodes)) throw new Problem(400, "Bad request", "This is not an exported flow (it has no nodes)");
    const name = (body.name && body.name.trim()) || f.name || "Imported flow";
    const settings = f.settings ? { ...f.settings, gateway: { ...(f.settings.gateway ?? { publish: true, security: "oauth2" as const }) } } : undefined;
    return this.createFlow({ name, description: f.description, flow: { nodes: f.nodes, edges: f.edges ?? [], tags: f.tags, slug: f.slug, ...(settings ? { settings } : {}) }, origin: f.origin ?? { kind: "clone", ref: f.id } }, user);
  }
  listVersions(id: string) { this.getFlow(id); return this.store.listVersions(id); }
  getVersion(id: string, revision: number): Flow {
    this.getFlow(id);
    const v = this.store.getVersion(id, revision);
    if (!v) throw notFound(`Revision ${revision}`);
    return v;
  }
  async restoreVersion(id: string, revision: number, user?: string): Promise<Flow> {
    const cur = this.getFlow(id); const v = this.getVersion(id, revision);
    const next: Flow = { ...cur, name: v.name, description: v.description, tags: v.tags, nodes: v.nodes, edges: v.edges, settings: v.settings, revision: cur.revision + 1, updatedAt: new Date().toISOString(), updatedBy: user ?? cur.updatedBy };
    return this.store.saveFlow(next, { note: `Restored from revision ${revision}` });
  }
  async validate(flow: Flow): Promise<ValidationIssue[]> {
    if (!flow || typeof flow !== "object") throw new Problem(400, "Bad request", "Send { flow }");
    const copy = JSON.parse(JSON.stringify(flow)) as Flow;
    if (!copy.settings) copy.settings = { basePath: `/${copy.slug || "flow"}/v1`, gateway: { publish: false, security: "oauth2" } };
    return validateFlow(await this.prepare(copy), this.vctx());
  }

  // ------------------------------------------------------------------ run & debug
  private testRequest(flow: Flow, trigger: FlowNode, rq?: HttpRequestSample): RuntimeRequest {
    const cfg = trigger.config ?? {};
    const s = (rq ?? cfg.sampleRequest ?? {}) as Partial<HttpRequestSample>;
    const methods = Array.isArray(cfg.methods) && cfg.methods.length ? (cfg.methods as string[]) : ["GET"];
    const method = String(s.method || methods[0]).toUpperCase();
    const path = String(s.path || cfg.path || "/");
    const m = matchRoutes(triggerRoutes({ nodes: [trigger] }), methods.map((x) => String(x).toUpperCase()).includes(method) ? method : String(methods[0]).toUpperCase(), path.split("?")[0]);
    const query: Record<string, unknown> = { ...(s.query ?? {}) };
    const qs = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
    for (const [k, v] of new URLSearchParams(qs)) if (query[k] === undefined) query[k] = v;
    return { method, path: path.split("?")[0], params: m && !m.methodMismatch ? m.params : {}, query, headers: lowerKeys(s.headers ?? {}), body: s.body ?? null };
  }
  async testFlow(id: string, req: TestFlowRequest): Promise<Execution> {
    const stored = this.store.getFlow(id);
    let flow = req?.draft && typeof req.draft === "object" && Array.isArray(req.draft.nodes) ? (JSON.parse(JSON.stringify(req.draft)) as Flow) : stored;
    if (!flow) throw notFound("The flow");
    if (stored) flow = { ...flow, id: stored.id, slug: flow.slug || stored.slug, name: flow.name || stored.name, revision: flow.revision ?? stored.revision, settings: flow.settings ?? stored.settings };
    else flow = { ...flow, id: flow.id || id, name: flow.name || "Draft", revision: flow.revision ?? 0, settings: flow.settings ?? { basePath: "/draft/v1", gateway: { publish: false, security: "oauth2" } }, edges: flow.edges ?? [] };
    await this.prepare(flow);
    const triggers = flow.nodes.filter((n) => n.type.startsWith("trigger.") && !n.disabled);
    let trigger: FlowNode | undefined;
    if (req?.triggerNodeId) { trigger = flow.nodes.find((n) => n.id === req.triggerNodeId && n.type.startsWith("trigger.")); if (!trigger) throw new Problem(400, "Bad request", "The chosen trigger is not in this flow"); }
    else if (req?.request) {
      const m = matchRoutes(triggerRoutes(flow), String(req.request.method || "GET").toUpperCase(), String(req.request.path || "/").split("?")[0]);
      trigger = (m && !m.methodMismatch ? flow.nodes.find((n) => n.id === m.nodeId) : undefined) ?? triggers.find((n) => n.type === "trigger.http");
    } else if (req?.payload !== undefined) trigger = triggers.find((n) => n.type !== "trigger.http") ?? triggers[0];
    else trigger = triggers[0];
    const request = trigger?.type === "trigger.http" ? this.testRequest(flow, trigger, req?.request) : undefined;
    if (request && req?.payload !== undefined && req.request?.body === undefined) request.body = req.payload;
    const r = await this.engine.run({ flow, mode: "test", triggerNodeId: trigger?.id, request, payload: req?.payload });
    return r.execution;
  }
  async testNode(id: string, nodeId: string, req: TestNodeRequest): Promise<TestNodeResponse> {
    const stored = this.store.getFlow(id);
    const flow = req?.draft && Array.isArray(req.draft.nodes) ? (JSON.parse(JSON.stringify(req.draft)) as Flow) : stored;
    if (!flow) throw notFound("The flow");
    if (stored) Object.assign(flow, { id: stored.id, settings: flow.settings ?? stored.settings });
    await this.prepare(flow);
    try { return await this.engine.testNode(flow, nodeId, req?.context ?? {}); }
    catch (e) { const s = (e as { status?: number }).status; throw new Problem(s === 404 ? 404 : 400, s === 404 ? "Not found" : "Bad request", (e as Error).message); }
  }

  // ------------------------------------------------------------------ live listeners & schedules
  refreshLive() {
    const next = new Map<string, LiveEntry>();
    for (const f of this.store.listFlows()) {
      const dep = f.deployment;
      if (!dep || dep.status === "stopped") continue;
      const snap = this.store.getVersion(f.id, dep.revision) ?? f;
      next.set(f.id, { flow: { ...snap, id: f.id }, basePath: normPath(snap.settings?.basePath || `/${f.slug}/v1`), routes: triggerRoutes(snap) });
    }
    this.live = next;
    for (const list of this.jobs.values()) for (const j of list) j.stop();
    this.jobs.clear();
    for (const [flowId, entry] of next) {
      const jobs: { stop(): void }[] = [];
      for (const n of entry.flow.nodes) {
        if (n.type !== "trigger.schedule" || n.disabled) continue;
        let busy = false;
        const fire = () => {
          if (busy) return; busy = true;
          const cur = this.live.get(flowId);
          if (!cur) { busy = false; return; }
          this.engine.run({ flow: cur.flow, mode: "live", via: "direct", triggerNodeId: n.id, payload: n.config?.payload ?? {} }).catch(() => undefined).finally(() => { busy = false; });
        };
        try {
          if (n.config?.mode === "cron") { const c = new Cron(String(n.config.cron), { protect: true }, fire); jobs.push({ stop: () => c.stop() }); }
          else { const t = setInterval(fire, Math.max(1, Number(n.config?.everySeconds) || 300) * 1000); t.unref(); jobs.push({ stop: () => clearInterval(t) }); }
        } catch (e) { this.store.appendLog({ at: new Date().toISOString(), level: "error", message: `Schedule "${n.name}" could not start: ${(e as Error).message}`, flowId }); }
      }
      if (jobs.length) this.jobs.set(flowId, jobs);
    }
  }
  flowsDeployed(): number { return this.live.size; }
  /** Finds the deployed flow and listener for a path below /run. */
  matchLive(method: string, path: string): { entry: LiveEntry; nodeId: string; params: Record<string, string>; rel: string } | { status: 404 | 405; detail: string } {
    const p = normPath(path);
    const candidates = [...this.live.values()].filter((e) => p === e.basePath || p.startsWith(e.basePath === "/" ? "/" : e.basePath + "/")).sort((a, b) => b.basePath.length - a.basePath.length);
    let wrongMethod = false;
    for (const entry of candidates) {
      const rel = p.slice(entry.basePath === "/" ? 0 : entry.basePath.length) || "/";
      const m = matchRoutes(entry.routes, method, rel);
      if (m?.methodMismatch) { wrongMethod = true; continue; }
      if (m) return { entry, nodeId: m.nodeId, params: m.params, rel };
    }
    return wrongMethod ? { status: 405, detail: `${method} is not allowed on ${p}` } : { status: 404, detail: `No deployed flow listens on ${method} ${p}` };
  }
  /** Runs a live request. Resolves as soon as the flow responds; the flow keeps running after that. */
  runLive(m: { entry: LiveEntry; nodeId: string; params: Record<string, string>; rel: string }, req: { method: string; query: Record<string, unknown>; headers: Record<string, string>; body: unknown }, via: "direct" | "gateway"): Promise<LiveResult> {
    return new Promise<LiveResult>((resolve, reject) => {
      const request: RuntimeRequest = { method: req.method.toUpperCase(), path: m.rel, params: m.params, query: req.query, headers: req.headers, body: req.body ?? null };
      this.engine.run({ flow: m.entry.flow, mode: "live", via, triggerNodeId: m.nodeId, request, onRespond: (response, executionId) => resolve({ response, executionId }) }).catch(reject);
    });
  }

  // ------------------------------------------------------------------ deploy
  private basePathClash(flow: Flow): Flow | undefined {
    const bp = normPath(flow.settings.basePath);
    for (const [id, e] of this.live) { if (id !== flow.id && (e.basePath === bp || bp.startsWith(e.basePath + "/") || e.basePath.startsWith(bp + "/"))) return this.store.getFlow(id); }
    return undefined;
  }
  async deploy(id: string, opts: { publishToGateway?: boolean } = {}, user?: string): Promise<{ flow: Flow; deployment: FlowDeployment; issues: ValidationIssue[] }> {
    let flow = this.getFlow(id);
    // Plain-words rules get compiled (and stored) before validation, so "deploy" never ships an uncompiled rule.
    const before = JSON.stringify(flow.nodes);
    const prepared = await this.prepare(JSON.parse(JSON.stringify(flow)) as Flow);
    if (JSON.stringify(prepared.nodes) !== before) { prepared.revision = flow.revision + 1; prepared.updatedAt = new Date().toISOString(); flow = this.store.saveFlow(prepared, { note: "Plain-words rules compiled" }); }
    const issues = validateFlow(flow, this.vctx());
    if (issues.some((i) => i.level === "error")) throw new Problem(422, "The flow has errors", "Fix the errors before deploying", issues);
    const clash = this.basePathClash(flow);
    if (clash) throw new Problem(409, "Conflict", `The base path ${flow.settings.basePath} overlaps with the deployed flow "${clash.name}" (${clash.settings.basePath})`, issues);
    const dep: FlowDeployment = {
      status: "deployed", revision: flow.revision, deployedAt: new Date().toISOString(), deployedBy: user,
      runtimeUrl: `http://127.0.0.1:${this.cfg.port}/run${normPath(flow.settings.basePath)}`,
    };
    const hasHttp = flow.nodes.some((n) => n.type === "trigger.http" && !n.disabled);
    const wantGateway = opts.publishToGateway ?? flow.settings.gateway?.publish !== false;
    // Listeners go live first: the gateway probes nothing, but a published API must have a backend.
    this.store.setDeployment(id, dep); this.refreshLive();
    if (!wantGateway || !hasHttp) {
      await this.gateway.remove(flow).catch(() => undefined);
      dep.gateway = { status: "skipped", ...(wantGateway && !hasHttp ? { error: "The flow has no HTTP Listener, so there is nothing to publish" } : {}) };
    } else {
      try {
        const g = await this.gateway.publish(flow);
        dep.gateway = { status: "published", apiId: g.apiId, context: g.context, version: g.version, url: g.url };
      } catch (e) {
        dep.gateway = { status: "failed", error: String(redact((e as Error).message)) };
        this.store.appendLog({ at: new Date().toISOString(), level: "error", message: `Gateway publish failed: ${dep.gateway.error}`, flowId: id });
      }
    }
    this.store.setDeployment(id, dep);
    this.store.appendLog({ at: new Date().toISOString(), level: "info", message: `Deployed revision ${flow.revision}${dep.gateway?.status === "published" ? ` and published on the gateway at ${dep.gateway.url}` : ""}`, flowId: id });
    return { flow: this.getFlow(id), deployment: dep, issues };
  }
  async undeploy(id: string): Promise<{ flow: Flow }> {
    const flow = this.getFlow(id);
    let gwError: string | undefined;
    if (flow.deployment) {
      try { await this.gateway.remove(flow); } catch (e) { gwError = (e as Error).message; }
      this.store.setDeployment(id, null);
      this.refreshLive();
      this.store.appendLog({ at: new Date().toISOString(), level: gwError ? "warn" : "info", message: gwError ? `Undeployed; removing the API from the gateway failed: ${gwError}` : "Undeployed", flowId: id });
    }
    return { flow: this.getFlow(id) };
  }
  async invoke(id: string, req: InvokeRequest): Promise<InvokeResponse> {
    const flow = this.getFlow(id);
    const dep = flow.deployment;
    if (!dep || dep.status !== "deployed") throw new Problem(409, "Not deployed", "Deploy the flow before calling it");
    const rq = req?.request ?? { method: "GET", path: "/" };
    if (req?.via === "gateway") {
      if (dep.gateway?.status !== "published") throw new Problem(409, "Not published", dep.gateway?.error ? `The flow is not on the gateway: ${dep.gateway.error}` : "The flow is not published on the gateway");
      try { return await this.gateway.invoke(flow, dep, rq); } catch (e) { throw new Problem(502, "Gateway call failed", (e as Error).message); }
    }
    const url = new URL(dep.runtimeUrl + normPath(String(rq.path || "/").split("?")[0]).replace(/^\/$/, ""));
    const qs = String(rq.path || "").includes("?") ? String(rq.path).slice(String(rq.path).indexOf("?") + 1) : "";
    for (const [k, v] of new URLSearchParams(qs)) url.searchParams.append(k, v);
    for (const [k, v] of Object.entries(rq.query ?? {})) url.searchParams.set(k, String(v));
    const headers = lowerKeys(rq.headers ?? {});
    let body: string | undefined;
    if (rq.body !== undefined && rq.body !== null && !["GET", "HEAD"].includes(String(rq.method).toUpperCase())) {
      body = typeof rq.body === "string" ? rq.body : JSON.stringify(rq.body);
      if (!headers["content-type"]) headers["content-type"] = typeof rq.body === "string" ? "text/plain" : "application/json";
    }
    const res = await this.http.request({ method: String(rq.method || "GET").toUpperCase(), url: url.toString(), headers, body, timeoutMs: (flow.settings.timeoutMs ?? 60000) + 5000 });
    return {
      status: res.status, headers: redact(res.headers) as Record<string, string>, body: readBody(res) as Json, ms: res.ms, url: url.toString(), executionId: res.headers["x-weave-execution-id"],
      curl: curlFor(String(rq.method || "GET").toUpperCase(), url.toString(), headers, body),
    };
  }

  // ------------------------------------------------------------------ gateway reconcile
  async gatewayReachable(): Promise<boolean> {
    if (!this.gateway.enabled) return false;
    if (Date.now() - this.gwReachable.at > 20_000) {
      this.gwReachable.at = Date.now();
      this.gateway.reachable().then((ok) => { this.gwReachable = { at: Date.now(), ok }; }, () => { this.gwReachable = { at: Date.now(), ok: false }; });
    }
    return this.gwReachable.ok;
  }
  async primeGateway() { try { this.gwReachable = { at: Date.now(), ok: await this.gateway.reachable() }; } catch { this.gwReachable = { at: Date.now(), ok: false }; } }
  /** Re-publishes deployed flows. force=false only repairs what is missing on the gateway. */
  async resync(force: boolean): Promise<{ flowId: string; status: string; error?: string }[]> {
    const results: { flowId: string; status: string; error?: string }[] = [];
    if (!this.gateway.enabled || this.reconciling) return results;
    this.reconciling = true;
    try {
      const wanted = this.store.listFlows().filter((f) => f.deployment?.status === "deployed" && f.deployment.gateway && f.deployment.gateway.status !== "skipped");
      if (!wanted.length) return results;
      let present: Awaited<ReturnType<Gateway["present"]>>;
      try { present = await this.gateway.present(); }
      catch (e) { for (const f of wanted) results.push({ flowId: f.id, status: "failed", error: `Gateway not reachable: ${(e as Error).message}` }); return results; }
      for (const f of wanted) {
        const dep = f.deployment!;
        const snap = this.live.get(f.id)?.flow ?? f;
        const there = present.get(this.gateway.apiName(snap));
        const healthy = !!there && there.lifeCycleStatus === "PUBLISHED" && dep.gateway?.status === "published";
        if (healthy && !force) { results.push({ flowId: f.id, status: "ok" }); continue; }
        try {
          const g = await this.gateway.publish(snap);
          dep.gateway = { status: "published", apiId: g.apiId, context: g.context, version: g.version, url: g.url };
          this.store.setDeployment(f.id, dep);
          if (!healthy) this.store.appendLog({ at: new Date().toISOString(), level: "warn", message: `The API was missing on the gateway and has been published again (${g.url})`, flowId: f.id });
          results.push({ flowId: f.id, status: healthy ? "ok" : "republished" });
        } catch (e) {
          const error = String(redact((e as Error).message));
          dep.gateway = { ...(dep.gateway ?? {}), status: "failed", error };
          this.store.setDeployment(f.id, dep);
          results.push({ flowId: f.id, status: "failed", error });
        }
      }
      return results;
    } finally { this.reconciling = false; }
  }
  startReconcile() {
    if (!this.gateway.enabled || !(this.cfg.reconcileSeconds > 0)) return;
    this.reconcileTimer = setInterval(() => { this.resync(false).catch(() => undefined); }, this.cfg.reconcileSeconds * 1000);
    this.reconcileTimer.unref();
    setTimeout(() => { this.resync(false).catch(() => undefined); }, 5000).unref();
  }

  // ------------------------------------------------------------------ connections
  private typeDef(type: string) { return BUILTIN_CONNECTION_TYPES.find((t) => t.type === type); }
  private publicConnection(c: StoredConnection): Connection {
    return { id: c.id, name: c.name, type: c.type, config: c.config, secretsSet: Object.keys(c.secrets).sort(), createdAt: c.createdAt, updatedAt: c.updatedAt };
  }
  listConnections(): Connection[] { return this.store.listConnections().map((c) => this.publicConnection(c)); }
  private buildConnection(req: SaveConnectionRequest, existing?: StoredConnection): StoredConnection {
    if (!req || typeof req !== "object") throw new Problem(400, "Bad request", "Send the connection as JSON");
    const name = String(req.name ?? existing?.name ?? "").trim();
    if (!name) throw new Problem(400, "Bad request", "Give the connection a name");
    const type = String(req.type ?? existing?.type ?? "");
    const def = this.typeDef(type);
    if (!def) throw new Problem(400, "Bad request", `Unknown connection type "${type}"`);
    if (existing && existing.type !== type) throw new Problem(400, "Bad request", "The type of a connection cannot be changed");
    if (this.store.listConnections().some((c) => c.id !== existing?.id && c.name.toLowerCase() === name.toLowerCase())) throw new Problem(409, "Conflict", `Another connection is already called "${name}"`);
    const secretKeys = new Set(def.fields.filter((f) => f.secret).map((f) => f.key));
    const config: Record<string, unknown> = {};
    const secrets: Record<string, string> = { ...(existing?.secrets ?? {}) };
    const put = (k: string, v: unknown) => { if (v === null || v === "") delete secrets[k]; else if (v !== undefined) secrets[k] = this.box.encrypt(String(v)); };
    for (const [k, v] of Object.entries(req.config ?? existing?.config ?? {})) { if (secretKeys.has(k)) put(k, v); else config[k] = v; }   // a secret sent in config is still stored encrypted
    for (const [k, v] of Object.entries(req.secrets ?? {})) { if (!secretKeys.has(k)) throw new Problem(400, "Bad request", `"${k}" is not a secret field of a ${type} connection`); put(k, v); }
    for (const f of def.fields) if (f.required && !f.secret && (config[f.key] === undefined || config[f.key] === null || String(config[f.key]).trim() === "")) throw new Problem(400, "Bad request", `"${f.label}" is required`);
    const now = new Date().toISOString();
    return { id: existing?.id ?? newId("cx"), name, type, config, secrets, createdAt: existing?.createdAt ?? now, updatedAt: now };
  }
  createConnection(req: SaveConnectionRequest): Connection { const c = this.buildConnection(req); this.store.saveConnection(c); return this.publicConnection(c); }
  updateConnection(id: string, req: SaveConnectionRequest): Connection {
    const cur = this.store.getConnection(id); if (!cur) throw notFound("The connection");
    const c = this.buildConnection(req, cur); this.store.saveConnection(c); this.resolved.delete(id); return this.publicConnection(c);
  }
  connectionUsers(id: string): { id: string; name: string }[] {
    const snaps = [...this.store.listFlows(), ...[...this.live.values()].map((e) => e.flow)];
    const out = new Map<string, string>();
    for (const f of snaps) if (f.nodes.some((n) => n.config?.connection === id)) out.set(f.id, f.name);
    return [...out].map(([fid, name]) => ({ id: fid, name }));
  }
  deleteConnection(id: string) {
    if (!this.store.getConnection(id)) throw notFound("The connection");
    const flows = this.connectionUsers(id);
    const connectors = this.store.listConnectors().filter((c) => c.defaultConnectionId === id);
    if (flows.length || connectors.length) throw new Problem(409, "In use", `This connection is used by ${[...flows.map((f) => `flow "${f.name}"`), ...connectors.map((c) => `connector "${c.name}"`)].join(", ")}`, undefined, { flows, connectors: connectors.map((c) => ({ id: c.id, name: c.name })) });
    this.store.deleteConnection(id); this.resolved.delete(id);
  }
  private decrypt(c: StoredConnection): ResolvedConnection {
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.secrets)) { try { secrets[k] = this.box.decrypt(v); } catch { /* unreadable with this key: treated as not set */ } }
    return { id: c.id, name: c.name, type: c.type, updatedAt: c.updatedAt, config: c.config, secrets };
  }
  resolveConnection(id: string): ResolvedConnection | undefined {
    const c = this.store.getConnection(id);
    if (!c) return undefined;
    const hit = this.resolved.get(id);
    if (hit && hit.at === c.updatedAt) return hit.conn;
    const conn = this.decrypt(c);
    this.resolved.set(id, { at: c.updatedAt, conn });
    return conn;
  }
  async testConnection(input: { id?: string; draft?: SaveConnectionRequest }): Promise<{ ok: boolean; ms: number; detail: string }> {
    let conn: ResolvedConnection;
    if (input.id) { const c = this.resolveConnection(input.id); if (!c) throw notFound("The connection"); conn = c; }
    else { const b = this.buildConnection({ ...(input.draft as SaveConnectionRequest), name: `__test_${Date.now()}` }); conn = this.decrypt(b); }
    const started = Date.now();
    const secretValues = Object.values(conn.secrets);
    const fail = (e: unknown) => ({ ok: false, ms: Date.now() - started, detail: String(redact((e as Error)?.message || String(e), secretValues)) });
    try {
      if (conn.type === "http") {
        const url = joinUrl(String(conn.config.baseUrl ?? ""), String(conn.config.healthPath ?? ""));
        const headers: Record<string, string> = { accept: "*/*" };
        for (const kv of Array.isArray(conn.config.defaultHeaders) ? (conn.config.defaultHeaders as { key?: string; value?: unknown }[]) : []) if (kv?.key && typeof kv.value === "string" && !kv.value.includes("{{")) headers[kv.key.toLowerCase()] = kv.value;
        Object.assign(headers, await authHeaders(conn, this.http));
        const r = await this.http.request({ method: "GET", url, headers, timeoutMs: Math.min(Number(conn.config.timeoutMs) || 10_000, 15_000), tlsVerify: conn.config.tlsVerify !== false, maxBytes: 5 * 1024 * 1024 });
        const strict = !!conn.config.healthPath;
        const ok = strict ? r.status < 400 : r.status < 500;
        return { ok, ms: r.ms, detail: ok ? `Reached ${url} (HTTP ${r.status})${!strict && r.status >= 400 ? ". The server answered, but with an error status for the base URL; set a health check path for a stricter test." : ""}` : `${url} answered HTTP ${r.status}` };
      }
      if (conn.type === "redis") {
        const client = await this.data.openRedis(conn);
        try { const pong = await client.ping(); return { ok: true, ms: Date.now() - started, detail: `Redis answered ${pong}` }; } finally { await client.disconnect().catch(() => undefined); }
      }
      if (conn.type === "postgres") {
        const reach = (e: unknown) => connectProblem("Postgres", e, whereOf(conn, 5432)) ?? e;
        const pool = await this.data.openPg(conn, 1).catch((e) => { throw reach(e); });
        try { const r = await pool.query("select current_database() as db, version() as v"); return { ok: true, ms: Date.now() - started, detail: `Connected to database "${String(r.rows[0]?.db)}" (${String(r.rows[0]?.v ?? "").split(",")[0]})` }; }
        catch (e) { throw reach(e); }
        finally { await pool.end().catch(() => undefined); }
      }
      if (conn.type === "mysql") {
        const pool = await this.data.sql.openMysql(conn, 1).catch((e) => { throw explainSql("mysql", e, { secrets: secretValues, database: String(conn.config.database ?? ""), ...whereOf(conn, 3306) }); });
        try {
          const [rows] = await pool.query({ sql: "select database() as db, version() as v", timeout: 10_000 });
          const r = (rows as { db?: string; v?: string }[])[0] ?? {};
          return { ok: true, ms: Date.now() - started, detail: `Connected to ${ENGINE_LABEL.mysql} ${String(r.v ?? "").split("-")[0]}${r.db ? `, database "${r.db}"` : ""}${conn.config.readOnly ? " (read-only)" : ""}` };
        } catch (e) { throw explainSql("mysql", e, { secrets: secretValues, database: String(conn.config.database ?? ""), ...whereOf(conn, 3306) }); }
        finally { await pool.end().catch(() => undefined); }
      }
      if (conn.type === "mssql") {
        const pool = await this.data.sql.openMssql(conn, 1).catch((e) => { throw explainSql("mssql", e, { secrets: secretValues, database: String(conn.config.database ?? ""), ...whereOf(conn, 1433) }); });
        try {
          const r = (await pool.request().query("select db_name() as db, cast(serverproperty('ProductVersion') as nvarchar(64)) as v")).recordset[0] ?? {};
          return { ok: true, ms: Date.now() - started, detail: `Connected to ${ENGINE_LABEL.mssql} ${String(r.v ?? "")}${r.db ? `, database "${r.db}"` : ""}${conn.config.readOnly ? " (read-only)" : ""}` };
        } catch (e) { throw explainSql("mssql", e, { secrets: secretValues, database: String(conn.config.database ?? ""), ...whereOf(conn, 1433) }); }
        finally { await pool.close().catch(() => undefined); }
      }
      return { ok: false, ms: 0, detail: `Connections of type "${conn.type}" cannot be tested` };
    } catch (e) { return fail(e); }
  }

  // ------------------------------------------------------------------ connectors
  listConnectors(): ConnectorDef[] { return this.store.listConnectors(); }
  private shapeConnector(body: Partial<ConnectorDef>, existing?: ConnectorDef): ConnectorDef {
    if (!body || typeof body !== "object") throw new Problem(400, "Bad request", "Send the connector as JSON");
    const name = String(body.name ?? existing?.name ?? "").trim();
    if (!name) throw new Problem(400, "Bad request", "Give the connector a name");
    const ops = Array.isArray(body.operations) ? body.operations : existing?.operations ?? [];
    const seen = new Set<string>();
    const operations = ops.map((o, i) => {
      if (!o || typeof o !== "object") throw new Problem(400, "Bad request", `Operation ${i + 1} is not an object`);
      let id = String(o.id || o.name || `op${i + 1}`).replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || `op${i + 1}`;
      while (seen.has(id)) id += "_2"; seen.add(id);
      if (!o.path || !String(o.path).trim()) throw new Problem(400, "Bad request", `Operation "${o.name || id}" has no path`);
      return { id, name: String(o.name || id), ...(o.description ? { description: String(o.description) } : {}), method: String(o.method || "GET").toUpperCase(), path: String(o.path), params: Array.isArray(o.params) ? o.params.filter((p) => p && p.key) : [],
        ...(Array.isArray(o.query) ? { query: o.query } : {}), ...(Array.isArray(o.headers) ? { headers: o.headers } : {}), ...(o.bodyTemplate ? { bodyTemplate: String(o.bodyTemplate) } : {}) };
    });
    if (body.defaultConnectionId && !this.store.getConnection(body.defaultConnectionId)) throw new Problem(400, "Bad request", "The default connection does not exist");
    const now = new Date().toISOString();
    return {
      id: existing?.id ?? newId("cn"), name, ...(body.description ?? existing?.description ? { description: String(body.description ?? existing?.description) } : {}),
      ...(body.icon ?? existing?.icon ? { icon: String(body.icon ?? existing?.icon) } : {}), connectionType: body.connectionType === "graphql" ? "graphql" : "http",
      ...(body.defaultConnectionId ? { defaultConnectionId: body.defaultConnectionId } : {}), operations, source: body.source ?? existing?.source ?? "manual",
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
  }
  createConnector(body: Partial<ConnectorDef>): ConnectorDef { const c = this.shapeConnector(body); this.store.saveConnector(c); return c; }
  updateConnector(id: string, body: Partial<ConnectorDef>): ConnectorDef {
    const cur = this.store.getConnector(id); if (!cur) throw notFound("The connector");
    const c = this.shapeConnector(body, cur); this.store.saveConnector(c); return c;
  }
  deleteConnector(id: string) {
    if (!this.store.getConnector(id)) throw notFound("The connector");
    const flows = this.store.listFlows().filter((f) => f.nodes.some((n) => n.type.startsWith(`connector:${id}:`)));
    if (flows.length) throw new Problem(409, "In use", `This connector is used by: ${flows.map((f) => f.name).join(", ")}`, undefined, { flows: flows.map((f) => ({ id: f.id, name: f.name })) });
    this.store.deleteConnector(id);
  }

  // ------------------------------------------------------------------ mapping & expressions
  async mappingPreview(body: { spec?: MappingSpec; source?: Json }): Promise<MappingPreviewResponse> {
    const spec = body?.spec;
    if (!spec || !Array.isArray(spec.rules)) throw new Problem(400, "Bad request", "Send { spec: { rules: [...] }, source }");
    const source = body.source !== undefined ? body.source : spec.sampleSource ?? null;
    const { output, rules } = await applyMapping(spec, source, { payload: source }, this.compiler);
    const out: MappingPreviewResponse = { output, rules };
    if (spec.sampleTarget !== undefined && spec.sampleTarget !== null) out.diff = diffJson(output, spec.sampleTarget);
    return out;
  }
  async evalExpression(body: { expr?: string; context?: TestNodeRequest["context"]; template?: boolean }): Promise<{ ok: boolean; result?: Json; error?: string }> {
    if (typeof body?.expr !== "string") throw new Problem(400, "Bad request", "Send { expr, context }");
    const c = body.context ?? {};
    const rq = c.request;
    const scope: ExprScope = {
      payload: c.payload === undefined ? null : c.payload, vars: c.vars ?? {}, item: c.item, index: c.index,
      request: rq ? { method: rq.method, path: rq.path, params: (rq as { params?: unknown }).params ?? {}, query: rq.query ?? {}, headers: lowerKeys(rq.headers ?? {}), body: rq.body ?? null } : undefined,
      nodes: (c as { nodes?: Record<string, unknown> }).nodes ?? {}, error: (c as { error?: unknown }).error,
      env: { flowName: "", executionId: "", now: new Date().toISOString() },
    };
    try {
      const v = body.template ? await renderTemplate(body.expr, scope) : await evalExpr(body.expr, scope);
      return { ok: true, result: (v === undefined ? null : v) as Json };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  // ------------------------------------------------------------------ stats
  stats(hours: number): StatsResponse {
    const h = Math.max(1, Math.min(Number.isFinite(hours) ? hours : 24, 24 * 14));
    const now = Date.now(); const since = now - h * 3600_000;
    const pts = this.store.metricsSince(since);
    const per = new Map<string, { ms: number[]; errors: number; last: number }>();
    for (const p of pts) { let s = per.get(p.flowId); if (!s) { s = { ms: [], errors: 0, last: 0 }; per.set(p.flowId, s); } s.ms.push(p.ms); if (!p.ok) s.errors++; if (p.t > s.last) s.last = p.t; }
    const pct = (arr: number[], q: number) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(q * a.length) - 1)]; };
    const flows = this.store.listFlows().map((f) => {
      const s = per.get(f.id);
      return { flowId: f.id, name: f.name, slug: f.slug, deployed: f.deployment?.status === "deployed", total: s?.ms.length ?? 0, errors: s?.errors ?? 0, p50Ms: pct(s?.ms ?? [], 0.5), p95Ms: pct(s?.ms ?? [], 0.95), ...(s?.last ? { lastAt: new Date(s.last).toISOString() } : {}) };
    }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const bucket = h <= 3 ? 60_000 : h <= 48 ? 3600_000 : 6 * 3600_000;
    const first = Math.floor(since / bucket) * bucket;
    const series: { at: string; total: number; errors: number }[] = [];
    for (let t = first; t <= now; t += bucket) series.push({ at: new Date(t).toISOString(), total: 0, errors: 0 });
    for (const p of pts) { const i = Math.floor((p.t - first) / bucket); if (series[i]) { series[i].total++; if (!p.ok) series[i].errors++; } }
    return { flows, series };
  }

  async close() {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const list of this.jobs.values()) for (const j of list) j.stop();
    await this.data.closeAll().catch(() => undefined);
  }
}

export function curlFor(method: string, url: string, headers: Record<string, string>, body?: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = ["curl", "-sS", "-X", method, q(url)];
  for (const [k, v] of Object.entries(redact(headers) as Record<string, string>)) parts.push("-H", q(`${k}: ${k === "authorization" ? "Bearer <token>" : v}`));
  if (body !== undefined) parts.push("--data", q(body.length > 2000 ? body.slice(0, 2000) + "..." : body));
  return parts.join(" ");
}
