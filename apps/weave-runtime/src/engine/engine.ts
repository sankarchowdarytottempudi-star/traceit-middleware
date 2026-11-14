// The flow engine. Semantics are specified in packages/weave-flow/CONTRACT.md ("Execution model").
import type { ConnectorDef, Execution, Flow, FlowEdge, FlowNode, HttpRequestSample, Json, LogLine, NodeTypeDef, StepTrace, TestNodeRequest, TestNodeResponse } from "@traceit/weave-flow";
import { BUILTIN_NODE_TYPES } from "@traceit/weave-flow";
import type { HttpClient } from "../clients/http.js";
import type { DataClients, ResolvedConnection } from "../clients/data.js";
import type { InstructionCompiler } from "../mapping/apply.js";
import type { ExprScope } from "../expr.js";
import { ExprError } from "../expr.js";
import { redact, truncate } from "../redact.js";
import { execId } from "../store.js";
import { HANDLERS, connectorHandler } from "./nodes.js";

export class FlowError extends Error {
  status?: number; nodeId?: string; nodeName?: string; detail?: Json;
  constructor(message: string, opts: { status?: number; detail?: unknown; nodeId?: string; nodeName?: string } = {}) {
    super(message);
    this.status = opts.status; this.nodeId = opts.nodeId; this.nodeName = opts.nodeName;
    if (opts.detail !== undefined) this.detail = opts.detail as Json;
  }
}
export interface RuntimeRequest {
  method: string; path: string;
  params: Record<string, string>;
  query: Record<string, unknown>;
  headers: Record<string, string>;
  body: unknown;
}
export interface FlowResponse { status: number; headers: Record<string, string>; body: unknown; contentType?: string; }
export interface EngineDeps {
  resolveConnection(id: string): ResolvedConnection | undefined;
  getConnector(id: string): ConnectorDef | undefined;
  /** The flow another flow calls: the deployed revision when live, the saved one when testing. */
  getFlowForCall(ref: string, mode: Execution["mode"]): Flow | undefined;
  http: HttpClient;
  data: DataClients;
  compileInstruction?: InstructionCompiler;
  onLog?(line: LogLine): void;
  onStart?(exec: Execution): void;
  onFinish?(exec: Execution): void;
}
export interface RunInput {
  flow: Flow;
  mode: Execution["mode"];
  via?: Execution["via"];
  triggerNodeId?: string;
  request?: RuntimeRequest;
  payload?: unknown;
  depth?: number;
  onRespond?(r: FlowResponse, executionId: string): void;
  warnings?: string[];
}
export interface RunResult { execution: Execution; response: FlowResponse; payload: unknown; }
export interface Scope { payload: unknown; item?: unknown; index?: number; error?: unknown; iteration?: number; branch?: string; }
export interface NodeResult { port?: string; end?: boolean; result?: unknown; output?: unknown; }
export interface NodeCtx { run: Run; node: FlowNode; cfg: Record<string, unknown>; scope: Scope; step: StepTrace; }
export type NodeHandler = (c: NodeCtx) => Promise<NodeResult>;

const TYPE_DEFS = new Map<string, NodeTypeDef>(BUILTIN_NODE_TYPES.map((t) => [t.type, t]));
export const isTrigger = (n: FlowNode) => n.type.startsWith("trigger.");
const MAX_STEPS = 5000;
const MAX_DEPTH = 8;

export class Run {
  exec: Execution;
  vars: Record<string, unknown> = {};
  nodes: Record<string, unknown> = {};
  secrets = new Set<string>();
  response?: FlowResponse;
  abort = new AbortController();
  request?: RuntimeRequest;
  private seq = 0;
  private byId = new Map<string, FlowNode>();
  private out = new Map<string, FlowEdge[]>();
  readonly logPayloads: boolean;
  readonly depth: number;

  constructor(readonly engine: Engine, readonly deps: EngineDeps, readonly flow: Flow, readonly input: RunInput) {
    for (const n of flow.nodes) this.byId.set(n.id, n);
    for (const e of flow.edges) { const k = `${e.from}|${e.fromPort || "out"}`; const l = this.out.get(k); if (l) l.push(e); else this.out.set(k, [e]); }
    this.logPayloads = flow.settings?.logPayloads !== false;
    this.depth = input.depth ?? 0;
    this.request = input.request;
    this.exec = {
      id: execId(), flowId: flow.id, flowName: flow.name, revision: flow.revision, mode: input.mode, via: input.via,
      trigger: { type: "trigger.manual" }, status: "running", startedAt: new Date().toISOString(), steps: [], logs: [],
    };
  }
  node(id: string) { return this.byId.get(id); }
  edges(nodeId: string, port: string) { return this.out.get(`${nodeId}|${port}`) ?? []; }
  es(scope: Scope, extra: Partial<ExprScope> = {}): ExprScope {
    return {
      payload: scope.payload, vars: this.vars, request: this.request, nodes: this.nodes, item: scope.item, index: scope.index, error: scope.error,
      env: { flowName: this.flow.name, executionId: this.exec.id, now: new Date().toISOString() }, ...extra,
    };
  }
  traceValue(v: unknown): { value: Json; truncated: boolean } { return truncate(redact(v, this.secrets)); }
  log(level: string, message: string, nodeName?: string) {
    const at = new Date().toISOString();
    const msg = String(redact(message, this.secrets));
    if (this.exec.logs!.length < 500) this.exec.logs!.push({ at, level, message: msg, nodeName });
    this.deps.onLog?.({ at, level, message: msg, flowId: this.flow.id, executionId: this.exec.id, nodeName });
  }
  respond(r: FlowResponse): boolean {
    if (this.response) return false;
    this.response = r;
    this.input.onRespond?.(r, this.exec.id);
    return true;
  }
  timeoutError() { return new FlowError(`The flow did not finish within ${this.flow.settings?.timeoutMs ?? 60000} ms`, { status: 504 }); }

  toFlowError(e: unknown, node: FlowNode): FlowError {
    if (e instanceof FlowError) { if (!e.nodeId) { e.nodeId = node.id; e.nodeName = node.name; } return e; }
    const x = e as { message?: string; code?: string };
    const status = e instanceof ExprError ? 500 : x?.code === "ETIMEDOUT" ? 504 : undefined;
    return new FlowError(x?.message || String(e), { status, nodeId: node.id, nodeName: node.name });
  }

  async runNode(nodeId: string, scopeIn: Scope): Promise<unknown> {
    const node = this.byId.get(nodeId);
    let scope = scopeIn;
    if (!node) return scope.payload;
    if (this.abort.signal.aborted) throw this.timeoutError();
    if (++this.seq > MAX_STEPS) throw new FlowError(`The flow ran more than ${MAX_STEPS} steps; it probably loops forever`, { status: 500, nodeId: node.id, nodeName: node.name });
    const started = Date.now();
    const step: StepTrace = { seq: this.seq, nodeId: node.id, nodeName: node.name, nodeType: node.type, status: "success", startedAt: new Date(started).toISOString(), durationMs: 0 };
    if (scope.iteration !== undefined) step.iteration = scope.iteration;
    if (scope.branch !== undefined) step.branch = scope.branch;
    if (this.logPayloads) { const t = this.traceValue(isTrigger(node) && this.request ? this.requestSample() : scope.payload); step.input = t.value; if (t.truncated) step.truncated = true; }
    this.exec.steps.push(step);
    let port = "out";
    if (node.disabled) {
      step.status = "skipped"; step.port = "out";
    } else {
      try {
        const r = await this.execNode(node, scope, step);
        port = r.port ?? "out";
        step.port = port;
        step.durationMs = Date.now() - started;
        if (r.end) { delete step.port; return scope.payload; }
      } catch (e) {
        const err = this.toFlowError(e, node);
        step.status = "error"; step.durationMs = Date.now() - started;
        step.error = { message: String(redact(err.message, this.secrets)), status: err.status, detail: err.detail === undefined ? undefined : this.traceValue(err.detail).value };
        if (this.edges(node.id, "error").length === 0) throw err;
        port = "error"; step.port = "error";
        scope = { ...scope, error: { message: err.message, status: err.status ?? 500, node: err.nodeName ?? node.name, detail: err.detail ?? null } };
      }
    }
    return this.follow(node.id, port, scope);
  }
  /** Runs every edge leaving a port, in order. Returns the payload at the end of the last path. */
  async follow(nodeId: string, port: string, scope: Scope): Promise<unknown> {
    let last = scope.payload;
    for (const e of this.edges(nodeId, port)) last = await this.runNode(e.to, { ...scope });
    return last;
  }
  async execNode(node: FlowNode, scope: Scope, step: StepTrace): Promise<NodeResult> {
    const handler: NodeHandler | undefined = HANDLERS[node.type] ?? (node.type.startsWith("connector:") ? connectorHandler : undefined);
    if (!handler) throw new FlowError(`This step type is not known to the runtime: ${node.type}`, { status: 500 });
    const cfg = { ...(TYPE_DEFS.get(node.type)?.defaults ?? {}), ...(node.config ?? {}) };
    const r = await handler({ run: this, node, cfg, scope, step });
    if ("result" in r) {
      const value = r.result === undefined ? null : r.result;
      if (cfg.resultTarget === "variable" && typeof cfg.resultVar === "string" && cfg.resultVar.trim()) this.vars[cfg.resultVar.trim()] = value;
      else scope.payload = value;
    }
    const output = "output" in r ? r.output : "result" in r ? r.result : scope.payload;
    this.nodes[node.name] = { output: output === undefined ? null : output };
    if (this.logPayloads) { const t = this.traceValue(output); step.output = t.value; if (t.truncated) step.truncated = true; }
    return r;
  }
  requestSample(): HttpRequestSample {
    const r = this.request!;
    return redact({ method: r.method, path: r.path, query: r.query, headers: r.headers, body: r.body }, this.secrets) as unknown as HttpRequestSample;
  }
}

export class Engine {
  constructor(readonly deps: EngineDeps) {}

  pickTrigger(flow: Flow, input: RunInput): FlowNode | undefined {
    const triggers = flow.nodes.filter((n) => isTrigger(n) && !n.disabled);
    if (input.triggerNodeId) return flow.nodes.find((n) => n.id === input.triggerNodeId && isTrigger(n));
    if (input.request) return triggers.find((n) => n.type === "trigger.http") ?? triggers[0];
    return triggers.find((n) => n.type === "trigger.manual") ?? triggers[0];
  }

  async run(input: RunInput): Promise<RunResult> {
    const flow = input.flow;
    const run = new Run(this, this.deps, flow, input);
    const exec = run.exec;
    const started = Date.now();
    const trigger = this.pickTrigger(flow, input);
    let finalPayload: unknown = null;
    let failure: FlowError | undefined;
    this.deps.onStart?.(exec);
    for (const w of input.warnings ?? []) run.log("warn", w);
    const timeoutMs = Number(flow.settings?.timeoutMs) > 0 ? Number(flow.settings.timeoutMs) : 60_000;
    const timer = setTimeout(() => run.abort.abort(), timeoutMs);
    try {
      if ((input.depth ?? 0) > MAX_DEPTH) throw new FlowError("Flows are calling each other too deeply (possible loop between flows)", { status: 500 });
      if (!trigger) throw new FlowError("This flow has no trigger to start from", { status: 400 });
      const cfg = trigger.config ?? {};
      let payload: unknown;
      if (trigger.type === "trigger.http") {
        if (!run.request) {
          const s = (cfg.sampleRequest ?? {}) as Partial<HttpRequestSample>;
          const methods = Array.isArray(cfg.methods) && cfg.methods.length ? (cfg.methods as string[]) : ["GET"];
          run.request = { method: String(s.method || methods[0]).toUpperCase(), path: String(s.path || cfg.path || "/"), params: {}, query: { ...(s.query ?? {}) }, headers: lowerKeys(s.headers ?? {}), body: s.body ?? (input.payload ?? null) };
        }
        payload = run.request.body ?? null;
        exec.trigger = { type: trigger.type, nodeId: trigger.id, method: run.request.method, path: run.request.path };
        exec.request = run.requestSample();
      } else {
        payload = input.payload !== undefined ? input.payload : trigger.type === "trigger.schedule" ? cfg.payload ?? {} : cfg.samplePayload ?? {};
        exec.trigger = { type: trigger.type, nodeId: trigger.id };
      }
      const abortP = new Promise<never>((_r, reject) => run.abort.signal.addEventListener("abort", () => reject(run.timeoutError()), { once: true }));
      abortP.catch(() => undefined);
      finalPayload = await Promise.race([run.runNode(trigger.id, { payload }), abortP]);
    } catch (e) {
      failure = e instanceof FlowError ? e : new FlowError((e as Error)?.message || String(e));
    } finally {
      clearTimeout(timer);
    }
    exec.finishedAt = new Date().toISOString();
    exec.durationMs = Date.now() - started;
    if (failure) {
      exec.status = "error";
      exec.error = { message: String(redact(failure.message, run.secrets)), nodeId: failure.nodeId, nodeName: failure.nodeName, status: failure.status ?? 500 };
      run.respond({ status: failure.status && failure.status >= 400 && failure.status < 600 ? failure.status : 500, headers: {}, body: { error: { message: exec.error.message, node: failure.nodeName ?? null } } });
      run.log("error", `Failed${failure.nodeName ? ` at "${failure.nodeName}"` : ""}: ${failure.message}`, failure.nodeName);
    } else {
      exec.status = "success";
      run.respond({ status: 200, headers: {}, body: finalPayload === undefined ? null : finalPayload });
    }
    const resp = run.response!;
    const body = run.logPayloads ? run.traceValue(resp.body).value : undefined;
    exec.response = { status: resp.status, headers: redact(resp.headers, run.secrets) as Record<string, string>, ...(body !== undefined ? { body } : {}) };
    if (input.mode === "live" && exec.trigger.type === "trigger.http") {
      run.log(exec.status === "error" ? "error" : "info", `${exec.trigger.method} ${exec.trigger.path} -> ${resp.status} in ${exec.durationMs} ms${input.via === "gateway" ? " (via gateway)" : ""}`);
    }
    this.deps.onFinish?.(exec);
    return { execution: exec, response: resp, payload: finalPayload };
  }

  /** Runs one node in isolation with a supplied context (the canvas "test this step" button). */
  async testNode(flow: Flow, nodeId: string, ctx: TestNodeRequest["context"]): Promise<TestNodeResponse> {
    const node = flow.nodes.find((n) => n.id === nodeId);
    if (!node) throw new FlowError("No such step in this flow", { status: 404 });
    const rq = ctx.request;
    const request: RuntimeRequest | undefined = rq ? { method: String(rq.method || "GET").toUpperCase(), path: rq.path || "/", params: {}, query: { ...(rq.query ?? {}) }, headers: lowerKeys(rq.headers ?? {}), body: rq.body ?? null } : undefined;
    const run = new Run(this, this.deps, flow, { flow, mode: "node-test", request });
    run.vars = { ...(ctx.vars ?? {}) };
    const scope: Scope = { payload: ctx.payload === undefined ? null : ctx.payload, item: ctx.item, index: ctx.index };
    const started = Date.now();
    const step: StepTrace = { seq: 1, nodeId: node.id, nodeName: node.name, nodeType: node.type, status: "success", startedAt: new Date(started).toISOString(), durationMs: 0 };
    const t = run.traceValue(scope.payload); step.input = t.value;
    const timer = setTimeout(() => run.abort.abort(), 60_000);
    try {
      // Only this node runs: its outgoing edges are ignored by giving the run an edge-less copy.
      const solo = new Run(this, this.deps, { ...flow, edges: [] }, { flow, mode: "node-test", request });
      solo.vars = run.vars; solo.secrets = run.secrets; solo.abort = run.abort;
      const r = await solo.execNode(node, scope, step);
      step.port = r.port ?? "out";
    } catch (e) {
      const err = run.toFlowError(e, node);
      step.status = "error";
      step.error = { message: String(redact(err.message, run.secrets)), status: err.status, detail: err.detail === undefined ? undefined : run.traceValue(err.detail).value };
    } finally { clearTimeout(timer); }
    step.durationMs = Date.now() - started;
    return { step, context: { payload: redact(scope.payload, run.secrets), vars: redact(run.vars, run.secrets) as Record<string, Json> } };
  }
}

export function lowerKeys(h: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) if (v !== undefined && v !== null) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  return out;
}
