// Browser-side client of the Factory BFF. Every call goes to this server only.
export interface ApiError extends Error { status?: number; body?: Record<string, unknown>; }

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  // Only a request that carries a body states a content type: the server refuses a DELETE that
  // announces JSON and then sends nothing.
  const r = await fetch(path, { credentials: "include", ...(init?.body != null ? { headers: { "Content-Type": "application/json" } } : {}), ...init });
  if (r.status === 401) throw Object.assign(new Error("unauthorized"), { status: 401 });
  if (!r.ok) {
    let detail = r.statusText; let body: Record<string, unknown> | undefined;
    try { const p = await r.json(); body = p; detail = p.detail ?? p.title ?? p.error ?? p.message ?? detail; } catch { /* ignore */ }
    throw Object.assign(new Error(typeof detail === "string" && detail ? detail : `Request failed (${r.status})`), { status: r.status, body });
  }
  return (await r.json()) as T;
}
async function text(path: string): Promise<string> {
  const r = await fetch(path, { credentials: "include" });
  if (!r.ok) {
    let detail = r.statusText;
    try { const p = await r.json(); detail = p.error ?? p.title ?? detail; } catch { /* ignore */ }
    throw Object.assign(new Error(detail || `Request failed (${r.status})`), { status: r.status });
  }
  return r.text();
}
const enc = encodeURIComponent;
function qs(p: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}
const post = (body?: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body ?? {}) });

export interface Me { user: string; role: string; }

// ---- migrations (the migration tool, through the BFF)
export interface PhaseStep { key: string; title: string; status: string; detail?: string; }
export interface Phase { key: string; title: string; mode: string; status: string; percent: number; weight?: number; detail?: string; startedAt?: string | null; finishedAt?: string | null; steps: PhaseStep[]; }
export interface StepRef { phase?: string; phaseKey?: string; step?: string; stepKey?: string; status?: string; }
export interface Progress { overallPercent: number; majorPhase: string; majorPhaseKey?: string | null; currentStep?: StepRef | string | null; nextStep?: StepRef | string | null; done: boolean; outcome: string; }
export interface LogEntry { t?: string; level?: string; line?: string; }
export interface Migration {
  id: string; name?: string; apiName?: string | null; workspace?: string; technology?: string; targetTech?: string; sourceType?: string; sourceFile?: string;
  layer?: string | null; estimateDays?: number | null; createdAt?: string; updatedAt?: string; serviceDir?: string; lessonsApplied?: number;
  busy?: boolean; phases: Phase[]; progress: Progress; log?: LogEntry[];
  verifiedEnv?: string; verifiedAt?: string; verifyMs?: number;
  optimization?: { beforeMs?: number; afterMs?: number; actions?: string[]; meetsTarget?: boolean; at?: string };
  testNodePort?: number | string; testBasePath?: string; discoveredEnvs?: { name?: string; candidates?: string[] }[];
}
export interface PhaseDef { key: string; title: string; weight: number; mode: string; steps: { key: string; title: string }[]; }
export interface Lesson { id: string; scope: string; technology?: string | null; summary: string; mistakes?: string[]; apiName?: string; workspace?: string; status?: string; createdAt?: string; phase?: string; docType?: string; migrationId?: string; rating?: number | null; appliedIn?: string[]; }
export interface ProxyResult { status: number; body: string; ms: number; slo: string; }
export interface MappingRule { target: string; kind: "direct" | "expr" | "const"; source?: string; expr?: string; note?: string; }
export interface InferResult { rules: MappingRule[]; engine: string; needsModel: boolean; }

export interface SourceTechnology { id: string; label: string; upload: string; hint?: string; sourceType?: string; }
export interface TargetTechnology { id: string; label: string; depth: string; hint?: string; }
export interface MigrateOptions { technologies: SourceTechnology[]; targets: TargetTechnology[]; extensions: string[]; maxUploadMb: number; }

export interface Environment { id: string; name: string; workspace?: string | null; baseUrl: string; createdAt?: string; hasToken?: boolean; tokenSet?: boolean; }
export interface TargetServer { host?: string; port?: number; username?: string; hasPassword?: boolean; passwordSet?: boolean; provisioned?: boolean; }
export interface WorkspaceConfig { id: string; name: string; createdAt?: string; servers?: Record<string, TargetServer | undefined>; }
export interface WorkspaceMigration { id: string; name?: string; apiName?: string | null; technology?: string; layer?: string | null; outcome?: string; percent?: number; busy?: boolean; }
export interface Workspace { name: string; total: number; deployed: number; failed: number; inProgress: number; migrations: WorkspaceMigration[]; environments: Environment[]; config: WorkspaceConfig | null; }
/** Kept for older imports. */
export type WorkspaceCfg = Workspace;

export interface RunResult { ok?: boolean; message?: string; ran?: string; needsConfirm?: boolean; error?: string; }
export interface VerifyResult { ok: boolean; status: number; body: string; ms: number; slo: string; finding?: { klass?: string; root_cause?: string; fix?: string } | null; }
export interface ParitySide { status: number; ms: number; slo: string; body: string; }
export interface ParityResult { legacy: ParitySide; migrated: ParitySide; match: boolean; diff: unknown[]; }
export interface OptimizeResult { beforeMs: number; afterMs: number; actions: string[]; meetsTarget: boolean; fastMs?: number; maxMs?: number; }

// ---- estate (the APIs that are already running)
export type Health = "healthy" | "degraded" | "down" | "unknown";
export interface EstateGateway { published: boolean; context?: string; version?: string; url?: string; known?: boolean; lifecycle?: string; }
export interface EstateComponent { name: string; role?: string; status?: string; replicas?: number; readyReplicas?: number; }
export interface EstateApi {
  name: string; layer?: string; technology?: string; status?: string; replicas?: number; readyReplicas?: number; nodePort?: number; basePath?: string;
  gateway?: EstateGateway; operations?: number; connectors?: number; migrationId?: string; health?: Health; deployed?: boolean; sourceAvailable?: boolean;
  internalUrl?: string; lastDeployedAt?: string; image?: string; notMigrated?: number; features?: string[];
  requestsLastHour?: number; errorsLastHour?: number; metricsAvailable?: boolean; components?: EstateComponent[];
}
export interface EstateLink { from: string; to: string; via?: string; label?: string; toKind?: "api" | "backend"; connector?: string; component?: string; }
export interface EstateCall { connector?: string; kind?: string; op?: string; method?: string; path?: string; mapping?: string; headers?: string[]; forwarded?: string[]; file?: string; line?: number; }
export interface EstateOperation {
  id: string; method: string; path: string; summary?: string; implemented?: boolean; file?: string; line?: number; endLine?: number; code?: string; relativePath?: string;
  params?: { name: string; type?: string; in?: string }[]; responses?: { status?: number; message?: string; when?: string }[];
  features?: string[]; headersForwarded?: string[]; headersRead?: string[]; calls?: EstateCall[];
}
export interface EstateConnector {
  name: string; kind: string; target: string; usedBy?: string[]; configKey?: string; auth?: string; component?: string; file?: string; line?: number; code?: string;
  paths?: string[]; settings?: { key: string; value: string }[]; secrets?: string[]; api?: string; backend?: string; exampleValues?: boolean;
}
export interface EstateMapping { id: string; operation?: string; name: string; kind: string; file?: string; line?: number; code?: string; fields?: { target: string; source: string }[]; summary?: string; usedBy?: string[]; }
export interface EstateConfigEntry { key: string; value: string; source?: string; secret?: boolean; component?: string; doc?: string; }
export interface EstatePod { name: string; phase?: string; ready?: boolean; restarts?: number; startedAt?: string; component?: string; }
export interface EstateApiDetail extends Omit<EstateApi, "operations" | "connectors"> {
  operationCount?: number; connectorCount?: number;
  operations?: EstateOperation[]; connectors?: EstateConnector[]; mappings?: EstateMapping[]; config?: EstateConfigEntry[]; configSource?: string;
  sourceComponents?: { name: string; dir?: string; files?: number; lines?: number }[]; warnings?: string[]; links?: EstateLink[]; pods?: EstatePod[];
}
export interface EstateLogLine { at?: string; level?: string; text: string; pod?: string; }
export interface EstateLogs { lines: EstateLogLine[]; pods?: EstatePod[]; errors?: string[]; }
export interface EstateMetrics { total: number; errors: number; p50Ms: number; p95Ms: number; series: { at: string; total: number; errors: number }[]; available?: boolean; reason?: string; }

// ---- calls that went through the migrated services
export type MigratedStatus = "success" | "error" | "running" | "unknown";
export type MigratedVia = "gateway" | "direct" | "internal" | "unknown";
export interface MigratedExecutionSummary {
  id: string; kind: "call" | "job"; api: string; component?: string; layer?: string; chain: string[];
  operation?: string; route?: string; startedAt: string; finishedAt?: string; durationMs?: number; serviceMs?: number;
  status: MigratedStatus; httpStatus?: number; outcome?: string; errors: number; warnings: number;
  via?: MigratedVia; application?: string; trigger?: string; stepCount: number; source?: "logs" | "gateway" | "both";
}
export interface MigratedExecutionStep { at: string; offsetMs: number; api: string; component?: string; level?: string; message: string; fields: Record<string, string | number | boolean>; }
export interface MigratedGatewayRecord {
  at: string; method?: string; context?: string; version?: string; resource?: string; status: number; targetStatus?: number;
  responseLatency?: number; backendLatency?: number; requestMediationLatency?: number; responseMediationLatency?: number;
  application?: string; keyType?: string; userAgent?: string; platform?: string; userIp?: string; userName?: string; cacheHit?: boolean;
  responseSize?: number; errorType?: string; errorMessage?: string; matchedBy: "time" | "record";
}
export interface MigratedExecution extends MigratedExecutionSummary { correlationId?: string; steps: MigratedExecutionStep[]; hiddenSteps: number; gateway?: MigratedGatewayRecord; }
export interface MigratedExecutionList {
  executions: MigratedExecutionSummary[]; total: number; recorded: number; failed: number;
  apis: { api: string; total: number; errors: number }[]; window: { from?: string; to?: string };
  sources: { logs: { available: boolean; parts: number; lines: number }; gateway: { configured: boolean; available: boolean; records: number; from?: string; to?: string } };
  notes: string[]; generatedAt: string;
}

export interface UploadInput { name: string; workspace: string; file: File; sourceType?: string; target?: string; }
/** Upload with progress. The file is the request body; everything else travels in the address. */
export function uploadMigration(input: UploadInput, onProgress?: (fraction: number) => void): { promise: Promise<Migration>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Migration>((resolve, reject) => {
    xhr.open("POST", `/api/factory/migrations${qs({ name: input.name, workspace: input.workspace, filename: input.file.name, sourceType: input.sourceType, target: input.target })}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
    xhr.onabort = () => reject(Object.assign(new Error("Upload cancelled"), { aborted: true }));
    xhr.onload = () => {
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && body && body.id) { resolve(body as Migration); return; }
      const msg = (body && (body.error || body.title || body.detail)) || (xhr.status === 413 ? "The file is too large" : `The upload was not accepted (${xhr.status})`);
      reject(Object.assign(new Error(String(msg)), { status: xhr.status, body }));
    };
    xhr.send(input.file);
  });
  return { promise, abort: () => xhr.abort() };
}

const F = "/api/factory";
export const api = {
  me: () => j<Me>("/api/auth/me"),

  migrations: () => j<{ migrations: Migration[] }>(`${F}/migrations`),
  migration: (id: string) => j<Migration>(`${F}/migrations/${enc(id)}`),
  phases: () => j<{ phases: PhaseDef[] }>(`${F}/phases`),
  options: () => j<MigrateOptions>(`${F}/migrate/options`),
  run: (id: string, phase: string, confirmReplace = false) => j<RunResult>(`${F}/migrations/${enc(id)}/run/${enc(phase)}`, post(confirmReplace ? { confirmReplace: true } : {})),
  advance: (id: string, body: { phase: string; step?: string; status?: string; detail?: string }) => j<Migration>(`${F}/migrations/${enc(id)}/advance`, post(body)),
  verify: (id: string, body: { envId: string; path: string; method: string; headers?: Record<string, string>; body?: string }) => j<VerifyResult>(`${F}/migrations/${enc(id)}/verify`, post(body)),
  parity: (id: string, body: { envId: string; path: string; method: string; headers?: Record<string, string>; body?: string }) => j<ParityResult>(`${F}/migrations/${enc(id)}/parity`, post(body)),
  optimize: (id: string, confirmReplace = false) => j<OptimizeResult>(`${F}/migrations/${enc(id)}/optimize`, post(confirmReplace ? { confirmReplace: true } : {})),
  feedback: (id: string) => j<{ feedback: Lesson[] }>(`${F}/migrations/${enc(id)}/feedback`),
  addFeedback: (id: string, body: { summary: string; scope: string; phase?: string; mistakes?: string[]; technology?: string }) => j<Lesson>(`${F}/migrations/${enc(id)}/feedback`, post(body)),
  deleteMigration: (id: string) => j<{ ok: boolean }>(`${F}/migrations/${enc(id)}`, { method: "DELETE" }),
  docs: (id: string) => j<{ docs: { name: string }[] }>(`${F}/migrations/${enc(id)}/docs`),
  doc: (id: string, name: string) => text(`${F}/migrations/${enc(id)}/docs/${enc(name)}`),
  docUrl: (id: string, name: string) => `${F}/migrations/${enc(id)}/docs/${enc(name)}?download=1`,

  workspaces: () => j<{ workspaces: Workspace[] }>(`${F}/workspaces`),
  addWorkspaceConfig: (body: { name: string; servers: Record<string, { host: string; port?: number; username?: string; password?: string }> }) => j<WorkspaceConfig>(`${F}/workspace-configs`, post(body)),
  deleteWorkspaceConfig: (id: string) => j<{ ok: boolean }>(`${F}/workspace-configs/${enc(id)}`, { method: "DELETE" }),
  checkServer: (id: string, tier: string) => j<{ started?: boolean; plan?: unknown; note?: string }>(`${F}/workspace-configs/${enc(id)}/check/${enc(tier)}`, post({})),
  environments: () => j<{ environments: Environment[] }>(`${F}/environments`),
  addEnvironment: (body: { name: string; baseUrl: string; workspace?: string; token?: string }) => j<Environment>(`${F}/environments`, post(body)),
  deleteEnvironment: (id: string) => j<{ ok: boolean }>(`${F}/environments/${enc(id)}`, { method: "DELETE" }),

  knowledge: () => j<{ feedback: Lesson[] }>(`${F}/knowledge`),
  proxy: (body: { service?: string; envId?: string; path: string; method: string; headers?: Record<string, string>; body?: string }) => j<ProxyResult>(`${F}/proxy`, post(body)),
  inferMapping: (sampleSource: unknown, desiredOutput: unknown) => j<InferResult>(`${F}/infer-mapping`, post({ sampleSource, desiredOutput })),

  estate: (refresh = false) => j<{ apis: EstateApi[]; links: EstateLink[]; notes?: string[]; generatedAt?: string }>(`${F}/estate${qs({ refresh: refresh ? 1 : undefined })}`),
  estateApi: (name: string) => j<EstateApiDetail>(`${F}/estate/${enc(name)}`),
  estateLogs: (name: string, p: { tail?: number; q?: string; level?: string; pod?: string } = {}) => j<EstateLogs>(`${F}/estate/${enc(name)}/logs${qs(p)}`),
  estateMetrics: (name: string, hours: number) => j<EstateMetrics>(`${F}/estate/${enc(name)}/metrics${qs({ hours })}`),
  estateExecutions: (p: { api?: string; status?: string; kind?: string; via?: string; q?: string; limit?: number } = {}) => j<MigratedExecutionList>(`${F}/estate/executions${qs(p)}`),
  estateExecution: (id: string) => j<MigratedExecution>(`${F}/estate/executions/${enc(id)}`),
  estateClone: (name: string, flowName: string) => j<{ flowId: string }>(`${F}/estate/${enc(name)}/clone`, post({ name: flowName })),
};
