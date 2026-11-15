// Typed client for the Weave runtime, reached through the Factory BFF at /api/studio/*
// (1:1 with the runtime's /v1 routes, see packages/weave-flow/src/api.ts), plus the estate
// endpoints served by the BFF itself. Nothing here talks to any other host.
import { at } from "../lib/base.ts";
import type {
  CatalogResponse, CompileInstructionRequest, CompileInstructionResponse, Connection, ConnectorDef, CreateFlowRequest,
  Execution, ExecutionSummary, Flow, FlowDeployment, FlowSummary, FlowVersion, HttpRequestSample, InvokeRequest,
  InvokeResponse, Json, LogLine, MappingPreviewResponse, MappingRule, MappingSpec, SaveConnectionRequest, StatsResponse,
  StepTrace, TestFlowRequest, TestNodeRequest, TestNodeResponse, ValidationIssue,
} from "@traceit/weave-flow";

export class ApiError extends Error {
  status: number;
  detail?: string;
  issues?: ValidationIssue[];
  body?: unknown;
  constructor(message: string, status: number, extra?: { detail?: string; issues?: ValidationIssue[]; body?: unknown }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = extra?.detail;
    this.issues = extra?.issues;
    this.body = extra?.body;
  }
}

/** A sentence a functional user can act on, for any failure. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 502 || e.status === 503 || e.status === 504) return "The Weave runtime is not reachable right now. Your work is kept on this screen; try again in a moment.";
    if (e.status === 401) return "Your session has ended. Sign in again to continue.";
    const d = e.detail && e.detail !== e.message ? ` ${e.detail}` : "";
    return `${e.message}${d}`.trim() || `Request failed (${e.status})`;
  }
  if (e instanceof Error) return e.message === "Failed to fetch" ? "Could not reach the server. Check your connection and try again." : e.message;
  return String(e);
}
export function isUnavailable(e: unknown): boolean {
  return e instanceof ApiError ? [404, 502, 503, 504].includes(e.status) : e instanceof TypeError;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "include", headers: { accept: "application/json" } };
  if (body !== undefined) { (init.headers as Record<string, string>)["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const r = await fetch(at(url), init);
  const text = await r.text();
  let data: unknown = undefined;
  if (text) { try { data = JSON.parse(text); } catch { data = undefined; } }
  if (!r.ok) {
    const p = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const title = typeof p.title === "string" ? p.title : typeof p.error === "string" ? p.error : typeof p.message === "string" ? p.message : r.statusText || `Request failed (${r.status})`;
    throw new ApiError(title, r.status, {
      detail: typeof p.detail === "string" ? p.detail : undefined,
      issues: Array.isArray(p.issues) ? (p.issues as ValidationIssue[]) : undefined,
      body: data ?? text,
    });
  }
  return data as T;
}
const S = "/api/studio";
const F = "/api/factory";
const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const enc = encodeURIComponent;

export interface ExprContext { payload?: Json; vars?: Record<string, Json>; request?: HttpRequestSample; item?: Json; index?: number; nodes?: Record<string, Json>; error?: Json; }
export interface ExprEvalResponse { ok: boolean; result?: Json; error?: string; }
export interface ConnectionTestResult { ok: boolean; ms: number; detail: string; }
export interface DeployResponse { flow: Flow; deployment: FlowDeployment; issues: ValidationIssue[]; }
export interface HealthResponse { status: string; flowsDeployed?: number; gateway?: string; }
export type ConnectorDraft = Omit<ConnectorDef, "id" | "createdAt" | "updatedAt"> & { id?: string };

// ---- estate (already-migrated services), served by the Factory BFF
export interface EstateApi {
  name: string; layer?: string; technology?: string; status?: string; replicas?: number; nodePort?: number; basePath?: string;
  gateway?: { published: boolean; context?: string }; operations?: number; connectors?: number; migrationId?: string;
}
export interface EstateApiDetail extends Omit<EstateApi, "operations" | "connectors"> {
  operations?: { id: string; method: string; path: string; summary?: string; implemented?: boolean; file?: string; line?: number }[];
  connectors?: { name: string; kind: string; target: string; usedBy?: string[]; auth?: string }[];
  mappings?: { id: string; operation?: string; name: string; kind: string; file?: string; line?: number; code?: string; fields?: { target: string; source: string }[] }[];
  config?: { key: string; value: string }[];
}
export interface EstateLogLine { at?: string; level?: string; text: string; }

export const studioApi = {
  health: () => call<HealthResponse>("GET", `${S}/healthz`),
  catalog: () => call<CatalogResponse>("GET", `${S}/catalog`),

  flows: () => call<{ flows: FlowSummary[] }>("GET", `${S}/flows`),
  flow: (id: string) => call<Flow>("GET", `${S}/flows/${enc(id)}`),
  createFlow: (req: CreateFlowRequest) => call<Flow>("POST", `${S}/flows`, req),
  saveFlow: (flow: Flow) => call<Flow>("PUT", `${S}/flows/${enc(flow.id)}`, flow),
  deleteFlow: (id: string) => call<{ ok: boolean }>("DELETE", `${S}/flows/${enc(id)}`),
  duplicateFlow: (id: string, name?: string) => call<Flow>("POST", `${S}/flows/${enc(id)}/duplicate`, { name }),
  versions: (id: string) => call<{ versions: FlowVersion[] }>("GET", `${S}/flows/${enc(id)}/versions`),
  version: (id: string, revision: number) => call<Flow>("GET", `${S}/flows/${enc(id)}/versions/${revision}`),
  validate: (flow: Flow) => call<{ issues: ValidationIssue[] }>("POST", `${S}/flows/validate`, { flow }),
  exportFlow: (id: string) => call<Flow>("GET", `${S}/flows/${enc(id)}/export`),
  importFlow: (flow: unknown, name?: string) => call<Flow>("POST", `${S}/flows/import`, { flow, name }),

  testFlow: (id: string, req: TestFlowRequest) => call<Execution>("POST", `${S}/flows/${enc(id)}/test`, req),
  testNode: (id: string, nodeId: string, req: TestNodeRequest) => call<TestNodeResponse>("POST", `${S}/flows/${enc(id)}/nodes/${enc(nodeId)}/test`, req),

  deploy: (id: string, publishToGateway?: boolean) => call<DeployResponse>("POST", `${S}/flows/${enc(id)}/deploy`, { publishToGateway }),
  undeploy: (id: string) => call<{ flow: Flow }>("POST", `${S}/flows/${enc(id)}/undeploy`, {}),
  invoke: (id: string, req: InvokeRequest) => call<InvokeResponse>("POST", `${S}/flows/${enc(id)}/invoke`, req),
  resync: () => call<{ results: { flowId: string; status: string; error?: string }[] }>("POST", `${S}/gateway/resync`, {}),

  executions: (p: { flowId?: string; status?: string; mode?: string; limit?: number; before?: string } = {}) =>
    call<{ executions: ExecutionSummary[] }>("GET", `${S}/executions${qs(p)}`),
  execution: (id: string) => call<Execution>("GET", `${S}/executions/${enc(id)}`),
  clearExecutions: (flowId: string) => call<{ ok: boolean }>("DELETE", `${S}/flows/${enc(flowId)}/executions`),
  logs: (flowId: string, p: { limit?: number; level?: string } = {}) => call<{ lines: LogLine[] }>("GET", `${S}/flows/${enc(flowId)}/logs${qs(p)}`),
  stats: (hours = 24) => call<StatsResponse>("GET", `${S}/stats${qs({ hours })}`),

  connections: () => call<{ connections: Connection[] }>("GET", `${S}/connections`),
  createConnection: (req: SaveConnectionRequest) => call<Connection>("POST", `${S}/connections`, req),
  updateConnection: (id: string, req: SaveConnectionRequest) => call<Connection>("PUT", `${S}/connections/${enc(id)}`, req),
  deleteConnection: (id: string) => call<{ ok: boolean }>("DELETE", `${S}/connections/${enc(id)}`),
  testConnection: (id: string) => call<ConnectionTestResult>("POST", `${S}/connections/${enc(id)}/test`, {}),
  testConnectionDraft: (req: SaveConnectionRequest) => call<ConnectionTestResult>("POST", `${S}/connections/test`, req),

  connectors: () => call<{ connectors: ConnectorDef[] }>("GET", `${S}/connectors`),
  createConnector: (c: ConnectorDraft) => call<ConnectorDef>("POST", `${S}/connectors`, c),
  updateConnector: (id: string, c: ConnectorDraft) => call<ConnectorDef>("PUT", `${S}/connectors/${enc(id)}`, c),
  deleteConnector: (id: string) => call<{ ok: boolean }>("DELETE", `${S}/connectors/${enc(id)}`),
  /** `spec` is the document itself (object or text); `url` asks the runtime to fetch it server-side. */
  importOpenApi: (req: { name?: string; spec?: Json | string; url?: string }) => call<ConnectorDef>("POST", `${S}/connectors/import-openapi`, req),

  mappingPreview: (spec: MappingSpec, source: Json) => call<MappingPreviewResponse>("POST", `${S}/mapping/preview`, { spec, source }),
  mappingInfer: (sampleSource: Json, desiredOutput: Json) => call<{ rules: MappingRule[]; engine: string }>("POST", `${S}/mapping/infer`, { sampleSource, desiredOutput }),
  compileInstruction: (req: CompileInstructionRequest) => call<CompileInstructionResponse>("POST", `${S}/mapping/compile-instruction`, req),
  evalExpr: (expr: string, context: ExprContext, template?: boolean) => call<ExprEvalResponse>("POST", `${S}/expr/eval`, { expr, context, template }),

  estate: () => call<{ apis: EstateApi[]; links?: unknown[] }>("GET", `${F}/estate`),
  estateApi: (api: string) => call<EstateApiDetail>("GET", `${F}/estate/${enc(api)}`),
  estateFlow: (api: string, operation?: string) => call<Flow>("GET", `${F}/estate/${enc(api)}/flow${qs({ operation })}`),
  estateLogs: (api: string, p: { tail?: number; q?: string } = {}) => call<{ lines: EstateLogLine[] }>("GET", `${F}/estate/${enc(api)}/logs${qs(p)}`),
  estateClone: (api: string, name: string) => call<{ flowId: string }>("POST", `${F}/estate/${enc(api)}/clone`, { name }),
};

export type { StepTrace, Execution, ExecutionSummary, Flow, FlowSummary };
