// Browser-side client of the Factory BFF. Every call goes to this server only.
import { at } from "./lib/base.ts";
export interface ApiError extends Error { status?: number; body?: Record<string, unknown>; }

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  // Only a request that carries a body states a content type: the server refuses a DELETE that
  // announces JSON and then sends nothing.
  const r = await fetch(at(path), { credentials: "include", ...(init?.body != null ? { headers: { "Content-Type": "application/json" } } : {}), ...init });
  if (r.status === 401) throw Object.assign(new Error("unauthorized"), { status: 401 });
  if (!r.ok) {
    let detail = r.statusText; let body: Record<string, unknown> | undefined;
    try { const p = await r.json(); body = p; detail = p.detail ?? p.title ?? p.error ?? p.message ?? detail; } catch { /* ignore */ }
    throw Object.assign(new Error(typeof detail === "string" && detail ? detail : `Request failed (${r.status})`), { status: r.status, body });
  }
  return (await r.json()) as T;
}
async function text(path: string): Promise<string> {
  const r = await fetch(at(path), { credentials: "include" });
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

export type AccessRole = "admin" | "migration" | "gateway";
export interface Me { user: string; role: string; name?: string; email?: string; provider?: "wso2" | "oidc" | "local"; roles?: AccessRole[]; }
/** Roles of the signed-in person. An older server without roles meant full access. */
export function rolesOf(me: Me | undefined): AccessRole[] { return me?.roles ?? ["admin", "migration", "gateway"]; }

// ---- migrations (the migration tool, through the BFF)
/** Plain-words explanation of a failed or blocked step, written by the migration tool. */
export interface StepHelp { kind?: string; what?: string; why?: string; todo?: string[]; retry?: boolean; operations?: string[]; backends?: string[]; }
export interface StepFailure { phase?: string; phaseKey?: string; step?: string; stepKey?: string; status?: string; detail?: string; help?: StepHelp | null; output?: string; }
export interface PhaseStep { key: string; title: string; status: string; detail?: string; help?: StepHelp | null; }
export interface Phase { key: string; title: string; mode: string; status: string; percent: number; weight?: number; detail?: string; startedAt?: string | null; finishedAt?: string | null; steps: PhaseStep[]; }
export interface StepRef { phase?: string; phaseKey?: string; step?: string; stepKey?: string; status?: string; }
export interface Progress { overallPercent: number; majorPhase: string; majorPhaseKey?: string | null; currentStep?: StepRef | string | null; nextStep?: StepRef | string | null; done: boolean; outcome: string; failure?: StepFailure | null;
  /** Parts that start by themselves (timer, queue, topic) that are switched off in the service's settings. */
  partsOff?: number; starts?: { name: string; starts?: string; switch?: string | null; on?: boolean | null }[] }
/** The old application item by item, and where the new service does each item. */
export interface ParityTotals { found: number; of: number; percent: number }
export interface ParityFlow { name: string; kind?: string; trigger?: string; status: string; missing?: string[];
  calls?: { what: string; found: boolean | null }[]; fields?: { name: string; found: boolean; where?: string; common?: boolean }[];
  conditions?: { value: string; found: boolean }[]; errors?: string[]; unchecked?: string[] }
export interface ParityMap { ok: boolean; error?: string; api?: string; complete?: boolean; flowCount?: number; flowsWithGaps?: number; summary?: string;
  totals?: { calls?: ParityTotals; fields?: ParityTotals; conditions?: ParityTotals; tables?: ParityTotals };
  flows?: ParityFlow[]; connections?: { config: string; kind?: string; settingsKey?: string; set?: boolean }[]; examples?: { operation: string; file?: string }[] }
export interface RuntimePropsResult { applied?: { property: string; setting: string }[]; unknown?: string[]; unchanged?: string[]; message?: string; changed?: boolean;
  selectors?: { property: string; meaning?: string }[]; runtimeOnly?: string[]; waiting?: { property: string; reason?: string }[]; ignored?: string[] }
/** The last trial run of the built service (closed network, stand-ins with made-up data). */
export interface TrialReport { ran: boolean; reason?: string; at?: string; started?: boolean; startSeconds?: number; why?: string; passed?: boolean; summary?: string; faults?: string[];
  examples?: number; ownReplies?: boolean;
  operations?: { op: string; case?: string; status?: number | null; result: string; calls?: string[]; note?: string; seen?: TrialSeen[] }[];
  parts?: { name: string; scenario?: string; about?: string; starts?: string; result: string; calls?: string[]; said?: string; note?: string; seen?: TrialSeen[] }[] }
export interface TrialSeen { what: string; n: number; failed?: number }
/** A part of the service that starts by itself, with its switch in the service's settings. */
export interface StartPart { name: string; starts?: string; kind?: string; switch?: string | null; on?: boolean | null;
  empty?: { key: string; secret?: boolean; secretSet?: boolean }[]; setHere?: { key: string; secret?: boolean; secretSet?: boolean }[] }
export interface LogEntry { t?: string; level?: string; line?: string; }
export interface Migration {
  id: string; name?: string; apiName?: string | null; workspace?: string; technology?: string; targetTech?: string; sourceType?: string; sourceFile?: string; sourceAttachedAt?: string;
  layer?: string | null; estimateDays?: number | null; createdAt?: string; updatedAt?: string; serviceDir?: string; lessonsApplied?: number;
  busy?: boolean; phases: Phase[]; progress: Progress; log?: LogEntry[];
  /** Place in the line of projects taken from a repository (0 or absent: not waiting). */
  queued?: number; source?: { kind?: string; repoName?: string; path?: string; branch?: string; commit?: string };
  verifiedEnv?: string; verifiedAt?: string; verifyMs?: number;
  optimization?: { beforeMs?: number; afterMs?: number; actions?: string[]; meetsTarget?: boolean; at?: string };
  testNodePort?: number | string; testBasePath?: string; discoveredEnvs?: { name?: string; candidates?: string[] }[];
  trial?: TrialReport;
  parity?: { complete?: boolean; summary?: string; flowsWithGaps?: number; totals?: ParityMap["totals"] };
  /** Where the service's settings came from: the running application's properties, or only the uploaded file. */
  settingsSource?: "runtime" | "file" | string;
  /** Pasted code, one file or part of a project: what the documents could not know and a person must supply. */
  partialSource?: PartialSource | null;
  /** For another platform: the file to import there (Workato package, webMethods IS package, ...). */
  packageFile?: string;
  /** The upload is a package generated by Weave: it was only checked, not migrated again. */
  checkOnly?: boolean;
  /** Corrections a person made to the analysis (Excel workbook), oldest first. */
  corrections?: CorrectionRecord[];
  /** New from requirements (sourceType "requirements"): what the factory read from the requirement document. */
  requirements?: RequirementsState | null;
  /** Documents a person replaced with their own version (names). */
  docEdits?: string[];
  /** Steps where the agent stopped for a person's choice. */
  decisionsCounts?: { open: number; answered: number } | null;
  /** Boomi / Workato: import into the saved account after each build. */
  autoImport?: boolean;
  /** The last import into the target platform. */
  importResult?: ImportResult | null;
  /** The import step (Boomi / Workato) as the tool summarises it. */
  import?: ImportState | null;
}
/** A service built from a requirement document: what was read, the reviews, and the last generation. */
export interface RequirementsState {
  name?: string; document?: string; readAt?: string; readAgainAt?: string; model?: string;
  counts?: Record<string, number>;
  coverage?: { requirementStatements?: number; turnedIntoItems?: number; leftAsOpenQuestions?: number; contextOnly?: number };
  openQuestions?: number;
  reviews?: RequirementsReview[];
  generated?: { at?: string; target?: string; service?: string; line?: string; openQuestions?: number } | null;
  /** The review changed the requirements after the service was generated: generate again. */
  changedSinceGenerate?: boolean;
}
export interface RequirementsChange { action?: string; id?: string; sheet?: string; row?: number; fields?: string[]; answer?: string }
export interface RequirementsReview { at?: string; by?: string; changes?: number; openQuestions?: number; summary?: RequirementsChange[] }
export interface RequirementsResult { ok: boolean; message?: string; changes?: RequirementsChange[]; openQuestions?: number; review?: RequirementsReview }
// ---- open decisions of the agent, edited documents, target platform accounts and the import there
export type DecisionKind = "connector" | "builtin" | "java" | "dynamic-call" | "unknown";
export type AnswerType = "connector" | "expression" | "code" | "call" | "drop" | "manual";
export type DecisionAnswer =
  | { type: "connector"; connector: string; operation: string }
  | { type: "expression"; text: string }
  | { type: "code"; language: string; text: string }
  | { type: "call"; services: string[] }
  | { type: "drop" }
  | { type: "manual" };
export type DecisionScope = "api" | "workspace";
export interface DecisionOption { connector: string; operation: string; label?: string }
/** One step where the agent stopped because a person has to choose. */
export interface AgentDecision {
  id: string; where?: string; flow?: string; source?: string; kind?: DecisionKind | string; construct?: string; summary?: string; why?: string;
  answerTypes?: AnswerType[]; options?: DecisionOption[]; answer?: DecisionAnswer | null; answeredBy?: string | null; answeredAt?: string | null; scope?: DecisionScope | string | null; note?: string | null;
}
export interface DecisionsView { api?: string; decisions: AgentDecision[]; counts?: { open: number; answered: number } }
export interface DecisionAnswerInput { id: string; answer: DecisionAnswer; scope: DecisionScope; note?: string }
export interface DecisionRowError { id?: string; problem?: string }
/** A document a person replaced with their own version (kept when the migration is rebuilt). */
export interface DocEdit { doc: string; by?: string; at?: string; note?: string; size?: number }
/** A target platform account of this workspace. The token never comes back; ids come back masked. */
export interface TargetAccount { target: string; label?: string; configured: boolean; hasToken?: boolean; accountId?: string; user?: string; apiBase?: string; updated?: string; updatedBy?: string; folderParentId?: string; parentFolderId?: string }
export interface BoomiAccountInput { accountId: string; user: string; token: string; apiBase?: string; folderParentId?: string }
export interface WorkatoAccountInput { apiBase: string; token: string; parentFolderId?: string }
export interface ImportFailure { component?: string; file?: string; reason?: string }
export interface ImportResult { target?: string; status?: "imported" | "partial" | "failed" | string; created?: number; total?: number; folder?: string; folderId?: string; failures?: ImportFailure[]; at?: string; packageId?: string }
/** The import step of a Boomi / Workato migration as the tool summarises it. */
export interface ImportState { key?: string; title?: string; status?: "pending" | "running" | "done" | "partial" | "failed" | string; detail?: string; result?: ImportResult | null; autoImport?: boolean; accountConfigured?: boolean; available?: boolean; label?: string }
/** Corrections of the analysis: counts of one corrected workbook. */
export interface CorrectionCounts { changed: number; added: number; deleted: number; marked: number }
export interface CorrectionChange { sheet?: string; id?: string; action?: string; summary?: string }
export interface CorrectionRowError { sheet?: string; row?: number | string | null; problem?: string }
export interface CorrectionRecord { at?: string; by?: string; applied?: Partial<CorrectionCounts>; changes?: CorrectionChange[]; total?: number }
export interface CorrectionsResult { ok: boolean; rerun?: boolean; message?: string; applied?: Partial<CorrectionCounts>; changes?: CorrectionChange[]; correction?: CorrectionRecord }
export interface PartialSource { source?: string; tool?: string; why?: string; unknowns?: ({ what?: string; supply?: string } | string)[]; evidence?: string[] }
/** "Finish this migration": what is left of a generated service and what the old application did there. */
export interface SourceCall { method: string; path: string; config: string; backend?: string }
export interface SourceView { flow: string; file?: string; steps: number; parts: number; does: string[]; more?: number; calls: SourceCall[]; transforms: number; simple?: boolean;
  /** What a pass-on would leave undone here, in plain words (empty when the old code made one plain call). */
  loses?: string[] }
export interface OpenItem {
  id: string; kind: "operation" | "entry" | "backend" | "code"; title: string; starts?: string; sourceName?: string; fromSource?: string[]; source?: SourceView | null;
  can: string[]; suggest?: { backend: string; method: string; path: string } | null; params?: string[]; notes?: { t?: string; text?: string }[];
  /** A part that starts by itself and has a generated, switched-off placeholder in the service. */
  placeholder?: { file?: string; function?: string; each?: string; started?: boolean } | null;
}
export interface ClosedItem { id: string; kind?: string; title: string; how: string; detail?: string; t?: string; canReopen?: boolean }
export interface OpenItems { api: string; exists: boolean; ready: boolean; summary?: string; items: OpenItem[]; closed: ClosedItem[]; backends: string[]; needsBuild?: boolean; pending?: string[]; busy?: boolean; installed?: boolean;
  /** The tool can add an API this service does not know yet while a call is passed on. */
  canAddBackend?: boolean;
  starts?: StartPart[] }
export type Decision =
  | { id: string; action: "forward"; backend: string; method: string; path: string; confirm?: true }
  | { id: string; action: "forward"; newBackend: { name: string; url: string }; method: string; path: string; confirm?: true }
  | { id: string; action: "not_needed"; reason: string }
  | { id: string; action: "address"; url: string }
  | { id: string; action: "address"; from: string }
  | { id: string; action: "note"; note: string }
  | { id: string; action: "reopen" }
  | { id: string; action: "switch"; on: boolean; confirm?: true }
  | { id: string; action: "setting"; key: string; value: string };
export interface ResolveResult { ok: boolean; message: string; changed: boolean; openItems: OpenItems }
export interface PhaseDef { key: string; title: string; weight: number; mode: string; steps: { key: string; title: string }[]; }
export interface Lesson { id: string; scope: string; technology?: string | null; summary: string; mistakes?: string[]; apiName?: string; workspace?: string; status?: string; createdAt?: string; phase?: string; docType?: string; migrationId?: string; rating?: number | null; appliedIn?: string[]; }
export interface ProxyResult { status: number; body: string; ms: number; slo: string; }
export interface MappingRule { target: string; kind: "direct" | "expr" | "const"; source?: string; expr?: string; note?: string; }
export interface InferResult { rules: MappingRule[]; engine: string; needsModel: boolean; }

export interface SourceTechnology { id: string; label: string; upload: string; hint?: string; sourceType?: string; }
export interface TargetTechnology { id: string; label: string; depth: string; maturity?: "complete" | "complete-unverified" | "partial" | "skeleton"; hint?: string; }
export interface PasteOptions { technologies: { id: string; label: string }[]; maxSnippets: number; maxSnippetKb: number; maxTotalKb: number }
export interface MigrateOptions { technologies: SourceTechnology[]; targets: TargetTechnology[]; extensions: string[]; maxUploadMb: number;
  /** One source file is wrapped into a project by the server (older servers do not send these). */
  singleFileExtensions?: string[]; integrationFileExtensions?: string[]; singleFileMb?: number; paste?: PasteOptions;
  /** New from requirements: the document types and size the server accepts (older servers do not send it). */
  requirements?: { extensions: string[]; maxMb: number }; }
export interface PasteInput { name: string; workspace: string; target: string; technology: string; snippets: { name: string; text: string }[] }

export interface Environment { id: string; name: string; workspace?: string | null; baseUrl: string; createdAt?: string; hasToken?: boolean; tokenSet?: boolean; }
export interface TargetServer { host?: string; port?: number; username?: string; hasPassword?: boolean; passwordSet?: boolean; provisioned?: boolean; }
export interface WorkspaceConfig { id: string; name: string; createdAt?: string; servers?: Record<string, TargetServer | undefined>; }
export interface WorkspaceMigration { id: string; name?: string; apiName?: string | null; technology?: string; layer?: string | null; outcome?: string; percent?: number; busy?: boolean; }
export interface Workspace { name: string; total: number; deployed: number; unfinished?: number; failed: number; inProgress: number; migrations: WorkspaceMigration[]; environments: Environment[]; config: WorkspaceConfig | null; }
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
  /** How many parts of it start by themselves (timer, queue, topic). */
  startsBySelf?: number;
}
/** A part of a service that starts by itself, with its switch and what the running service said. */
export interface EstateStart { name: string; starts?: string; kind?: string; switch?: string; on?: boolean | null; live?: "on" | "off" | "not-started" | "unknown"; said?: string; why?: string }
export interface EstateRuns { finished?: number; failed?: number; lastAt?: string; last?: "finished" | "failed"; lastReason?: string }
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
  selfStarting?: EstateStart[]; runs?: EstateRuns;
}
export interface EstateLogLine { at?: string; level?: string; text: string; pod?: string; }
export interface EstateLogs { lines: EstateLogLine[]; pods?: EstatePod[]; errors?: string[]; }
export interface EstateMetrics { total: number; errors: number; p50Ms: number; p95Ms: number; series: { at: string; total: number; errors: number }[]; available?: boolean; reason?: string; }

// ---- projects taken from a git repository (read by the migration tool on its build server)
export interface RepoProject { path: string; name: string; technology?: string; flows?: number; files?: number; bytes?: number; settings?: string[]; encrypted?: boolean; migrations?: { id: string; name?: string; outcome?: string; queued?: boolean }[]; }
export interface Repo { id: string; name: string; url: string; branch?: string; username?: string; hasToken?: boolean; state: string; message?: string; readAt?: string | null; commit?: string; onBranch?: string; committedAt?: string; bytes?: number; projects?: RepoProject[]; environments?: { name: string; projects: number }[]; }
export interface RepoImportResult { created: { id: string; name: string; path: string }[]; refused: { path: string; error: string }[]; workspace: string; }

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

export interface UploadInput { name: string; workspace: string; file: File; sourceType?: string; target?: string; scope?: string; }
/** Upload with progress. The file is the request body; everything else travels in the address. */
export function uploadMigration(input: UploadInput, onProgress?: (fraction: number) => void): { promise: Promise<Migration>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Migration>((resolve, reject) => {
    xhr.open("POST", at(`/api/factory/migrations${qs({ name: input.name, workspace: input.workspace, filename: input.file.name, sourceType: input.sourceType, target: input.target, scope: input.scope })}`));
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

export interface SourceUploadResult { ok: boolean; summary?: string; parity?: { ok?: boolean; summary?: string; complete?: boolean; error?: string } }
/** The old application's archive for an existing migration: the reference of the parity map. The
 * tool never generates the service again from it. `force` confirms an archive whose names do not match. */
export function uploadOldCode(id: string, file: File, force: boolean, onProgress?: (fraction: number) => void): { promise: Promise<SourceUploadResult>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<SourceUploadResult>((resolve, reject) => {
    xhr.open("POST", at(`/api/factory/migrations/${encodeURIComponent(id)}/source${qs({ filename: file.name, force: force ? "1" : undefined })}`));
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
    xhr.onabort = () => reject(Object.assign(new Error("Upload cancelled"), { aborted: true }));
    xhr.onload = () => {
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && body && body.ok) { resolve(body as SourceUploadResult); return; }
      const msg = (body && (body.error || body.detail)) || (xhr.status === 413 ? "The file is too large" : `The upload was not accepted (${xhr.status})`);
      reject(Object.assign(new Error(String(msg)), { status: xhr.status, body }));
    };
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

/** A corrected analysis workbook: the tool keeps the corrections and writes the documents and the
 * project again. Rows that need fixing come back on the error's body as `errors`; then nothing changed. */
export function uploadCorrections(id: string, file: File, onProgress?: (fraction: number) => void): { promise: Promise<CorrectionsResult>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<CorrectionsResult>((resolve, reject) => {
    xhr.open("POST", at(`/api/factory/migrations/${encodeURIComponent(id)}/corrections`));
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
    xhr.onabort = () => reject(Object.assign(new Error("Upload cancelled"), { aborted: true }));
    xhr.onload = () => {
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && body && body.ok) { resolve(body as CorrectionsResult); return; }
      const msg = (body && (body.error || body.detail)) || (xhr.status === 413 ? "The workbook is larger than 10 MB." : `The workbook was not accepted (${xhr.status})`);
      reject(Object.assign(new Error(String(msg)), { status: xhr.status, body }));
    };
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

/** A reviewed requirements workbook: applied to the spec; row errors come back with status 400 and change nothing. */
export function uploadRequirements(id: string, file: File, onProgress?: (fraction: number) => void): { promise: Promise<RequirementsResult>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<RequirementsResult>((resolve, reject) => {
    xhr.open("POST", at(`/api/factory/migrations/${encodeURIComponent(id)}/requirements`));
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
    xhr.onabort = () => reject(Object.assign(new Error("Upload cancelled"), { aborted: true }));
    xhr.onload = () => {
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && body && body.ok) { resolve(body as RequirementsResult); return; }
      const msg = (body && (body.error || body.detail)) || (xhr.status === 413 ? "The workbook is larger than 10 MB." : `The workbook was not accepted (${xhr.status})`);
      reject(Object.assign(new Error(String(msg)), { status: xhr.status, body }));
    };
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

/** The review workbook of a requirements migration, or the blank requirement template (no id). */
export async function requirementsWorkbook(id: string | null, which: "review" | "template" = "review"): Promise<{ blob: Blob; filename: string }> {
  const path = which === "template"
    ? (id ? `/api/factory/migrations/${encodeURIComponent(id)}/requirements-template.xlsx` : "/api/factory/requirements/template.xlsx")
    : `/api/factory/migrations/${encodeURIComponent(id ?? "")}/requirements.xlsx`;
  const r = await fetch(at(path), { credentials: "include" });
  if (!r.ok) {
    let detail = "";
    try { const p = await r.json(); detail = p.error ?? ""; } catch { /* ignore */ }
    throw Object.assign(new Error(detail || (r.status === 401 ? "Sign in again to download the workbook." : `The workbook is not available right now (${r.status}).`)), { status: r.status });
  }
  const fallback = which === "template" ? "requirements-template.xlsx" : `${id}-requirements-review.xlsx`;
  const filename = (/filename="([^"]+)"/.exec(r.headers.get("content-disposition") || "") || [])[1] || fallback;
  return { blob: await r.blob(), filename };
}

/** The analysis of one API as an editable Excel workbook; a plain-words error when there is none. */
export async function correctionsWorkbook(id: string): Promise<{ blob: Blob; filename: string }> {
  const r = await fetch(at(`/api/factory/migrations/${encodeURIComponent(id)}/corrections.xlsx`), { credentials: "include" });
  if (!r.ok) {
    let detail = "";
    try { const p = await r.json(); detail = p.error ?? ""; } catch { /* ignore */ }
    throw Object.assign(new Error(detail || (r.status === 401 ? "Sign in again to download the workbook." : `The workbook is not available right now (${r.status}).`)), { status: r.status });
  }
  const filename = (/filename="([^"]+)"/.exec(r.headers.get("content-disposition") || "") || [])[1] || `${id}-corrections.xlsx`;
  return { blob: await r.blob(), filename };
}

const F = "/api/factory";
/** The latest corpus run of the migration tool (every upload through the whole pipeline, in a sandbox). */
export interface ToolHealthStop { stage: string; class: string; what: string; count?: number; item?: string; backend?: string; value?: number | null }
export interface ToolHealthProject { name?: string; archive?: string; operations?: number; ported?: number; openItems?: Record<string, number>;
  build?: { rc: number; errors: number }; tests?: { coverage?: number | null; passed?: number; failed?: number }; parity?: { summary?: string };
  trial?: { ran?: boolean; started?: boolean; passed?: boolean }; stops?: ToolHealthStop[] }
export interface ToolHealth { ok: boolean; error?: string; run?: string; started?: string; finished?: string; projects?: ToolHealthProject[];
  backlog?: { stage: string; gap: string; projects: string[]; count: number }[]; decisions?: (ToolHealthStop & { project: string })[];
  fixed?: { gap: string; before: number; after: number; at?: string }[] }
export const api = {
  me: () => j<Me>("/api/auth/me"),

  migrations: () => j<{ migrations: Migration[] }>(`${F}/migrations`),
  migration: (id: string) => j<Migration>(`${F}/migrations/${enc(id)}`),
  phases: () => j<{ phases: PhaseDef[] }>(`${F}/phases`),
  options: () => j<MigrateOptions>(`${F}/migrate/options`),
  /** "Paste code": the server wraps the snippets into a minimal project and creates the migration. */
  pasteMigration: (input: PasteInput) => j<Migration>(`${F}/migrations/paste`, post(input)),
  run: (id: string, phase: string, confirmReplace = false) => j<RunResult>(`${F}/migrations/${enc(id)}/run/${enc(phase)}`, post(confirmReplace ? { confirmReplace: true } : {})),
  advance: (id: string, body: { phase: string; step?: string; status?: string; detail?: string }) => j<Migration>(`${F}/migrations/${enc(id)}/advance`, post(body)),
  verify: (id: string, body: { envId: string; path: string; method: string; headers?: Record<string, string>; body?: string }) => j<VerifyResult>(`${F}/migrations/${enc(id)}/verify`, post(body)),
  parity: (id: string, body: { envId: string; path: string; method: string; headers?: Record<string, string>; body?: string }) => j<ParityResult>(`${F}/migrations/${enc(id)}/parity`, post(body)),
  optimize: (id: string, confirmReplace = false) => j<OptimizeResult>(`${F}/migrations/${enc(id)}/optimize`, post(confirmReplace ? { confirmReplace: true } : {})),
  openItems: (id: string) => j<OpenItems>(`${F}/migrations/${enc(id)}/open-items`),
  parityMap: (id: string) => j<ParityMap>(`${F}/migrations/${enc(id)}/parity`),
  runtimeProperties: (id: string, text: string) => j<RuntimePropsResult>(`${F}/migrations/${enc(id)}/runtime-properties`, post({ text })),
  resolve: (id: string, body: Decision) => j<ResolveResult>(`${F}/migrations/${enc(id)}/resolve`, post(body)),
  feedback: (id: string) => j<{ feedback: Lesson[] }>(`${F}/migrations/${enc(id)}/feedback`),
  addFeedback: (id: string, body: { summary: string; scope: string; phase?: string; mistakes?: string[]; technology?: string }) => j<Lesson>(`${F}/migrations/${enc(id)}/feedback`, post(body)),
  deleteMigration: (id: string) => j<{ ok: boolean }>(`${F}/migrations/${enc(id)}`, { method: "DELETE" }),
  docs: (id: string) => j<{ docs: { name: string }[] }>(`${F}/migrations/${enc(id)}/docs`),
  doc: (id: string, name: string) => text(`${F}/migrations/${enc(id)}/docs/${enc(name)}`),
  docUrl: (id: string, name: string) => at(`${F}/migrations/${enc(id)}/docs/${enc(name)}?download=1`),
  projectUrl: (id: string) => at(`${F}/migrations/${enc(id)}/project`),
  packageUrl: (id: string) => at(`${F}/migrations/${enc(id)}/package`),
  correctionsUrl: (id: string) => at(`${F}/migrations/${enc(id)}/corrections.xlsx`),
  requirementsUrl: (id: string) => at(`${F}/migrations/${enc(id)}/requirements.xlsx`),
  requirementsTemplateUrl: () => at(`${F}/requirements/template.xlsx`),

  // the agent's open decisions; documents a person edits; the target platform accounts and the import there
  decisions: (id: string) => j<DecisionsView>(`${F}/migrations/${enc(id)}/decisions`),
  answerDecisions: (id: string, answers: DecisionAnswerInput[]) => j<{ ok: boolean; applied?: number }>(`${F}/migrations/${enc(id)}/decisions`, post({ answers })),
  docSource: (id: string, name: string) => text(`${F}/migrations/${enc(id)}/documents/${enc(name)}/source`),
  saveDocSource: (id: string, name: string, body: { text: string; note?: string }) => j<{ ok?: boolean }>(`${F}/migrations/${enc(id)}/documents/${enc(name)}/source`, { method: "PUT", body: JSON.stringify(body) }),
  revertDoc: (id: string, name: string) => j<{ ok?: boolean }>(`${F}/migrations/${enc(id)}/documents/${enc(name)}/source`, { method: "DELETE" }),
  docEdits: async (id: string): Promise<DocEdit[]> => {
    const r = await j<DocEdit[] | { edits?: DocEdit[] }>(`${F}/migrations/${enc(id)}/documents/edits`);
    return Array.isArray(r) ? r : Array.isArray(r?.edits) ? r.edits : [];
  },
  targetAccounts: async (): Promise<TargetAccount[]> => {
    const r = await j<TargetAccount[] | { accounts?: TargetAccount[] }>(`${F}/target-accounts`);
    return Array.isArray(r) ? r : Array.isArray(r?.accounts) ? r.accounts : [];
  },
  saveTargetAccount: (target: string, body: BoomiAccountInput | WorkatoAccountInput) => j<TargetAccount>(`${F}/target-accounts/${enc(target)}`, { method: "PUT", body: JSON.stringify(body) }),
  removeTargetAccount: (target: string) => j<{ ok?: boolean }>(`${F}/target-accounts/${enc(target)}`, { method: "DELETE" }),
  testTargetAccount: (target: string) => j<{ ok: boolean; message?: string }>(`${F}/target-accounts/${enc(target)}/test`, post({})),
  importNow: (id: string) => j<{ ok?: boolean; message?: string }>(`${F}/migrations/${enc(id)}/import`, post({})),
  renameApi: (id: string, name: string) => j<{ ok?: boolean; message?: string; apiName?: string }>(`${F}/migrations/${enc(id)}/rename`, post({ name })),
  setMigrationOptions: (id: string, body: { autoImport: boolean }) => j<{ ok?: boolean }>(`${F}/migrations/${enc(id)}/options`, post(body)),
  repos: () => j<{ repos: Repo[] }>(`${F}/repos`),
  connectRepo: (body: { name: string; url: string; branch?: string; username?: string; token?: string }) => j<Repo>(`${F}/repos`, post(body)),
  readRepo: (id: string, body: { token?: string } = {}) => j<Repo>(`${F}/repos/${enc(id)}/refresh`, post(body)),
  importRepo: (id: string, body: { paths: string[]; workspace: string; environment?: string; build?: boolean }) => j<RepoImportResult>(`${F}/repos/${enc(id)}/import`, post(body)),
  removeRepo: (id: string) => j<{ ok: boolean }>(`${F}/repos/${enc(id)}`, { method: "DELETE" }),
  workspaces: () => j<{ workspaces: Workspace[] }>(`${F}/workspaces`),
  addWorkspaceConfig: (body: { name: string; servers: Record<string, { host: string; port?: number; username?: string; password?: string; hostname?: string }> }) => j<WorkspaceConfig>(`${F}/workspace-configs`, post(body)),
  deleteWorkspaceConfig: (id: string) => j<{ ok: boolean }>(`${F}/workspace-configs/${enc(id)}`, { method: "DELETE" }),
  checkServer: (id: string, tier: string) => j<{ started?: boolean; plan?: unknown; note?: string }>(`${F}/workspace-configs/${enc(id)}/check/${enc(tier)}`, post({})),
  environments: () => j<{ environments: Environment[] }>(`${F}/environments`),
  addEnvironment: (body: { name: string; baseUrl: string; workspace?: string; token?: string }) => j<Environment>(`${F}/environments`, post(body)),
  deleteEnvironment: (id: string) => j<{ ok: boolean }>(`${F}/environments/${enc(id)}`, { method: "DELETE" }),

  knowledge: () => j<{ feedback: Lesson[] }>(`${F}/knowledge`),
  toolHealth: () => j<ToolHealth>(`${F}/tool-health`),
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
