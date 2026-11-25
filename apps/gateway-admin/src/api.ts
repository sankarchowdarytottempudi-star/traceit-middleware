async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  if (r.status === 401) throw Object.assign(new Error("unauthorized"), { status: 401 });
  if (!r.ok) {
    let detail = r.statusText;
    try { const p = await r.json(); detail = p.title ?? detail; } catch { /* ignore */ }
    throw Object.assign(new Error(detail), { status: r.status });
  }
  return (await r.json()) as T;
}

export interface Me { user: string; role: string; }
export interface SubPolicy { policyId: string; name: string; displayName?: string; quotaType: string; limit: number; unit: string; timeUnit: string; stopOnQuotaReach: boolean; }
export interface AdvPolicy { policyId: string; name: string; limit: number; timeUnit: string; }
export interface Environment { id: string; name: string; type: string; gatewayType: string; visibility?: string; vhosts: { host: string; httpContext?: string }[]; reachable: boolean; }
export interface KeyManager { id: string; name: string; type: string; enabled: boolean; }
export interface ApiCompliance { apiId: string; name: string; version: string; errors: number; warnings: number; info: number; policy: string; }
export interface ComplianceSummary { governed: number; compliant: number; total: number; errors: number; warnings: number; info: number; policyAdherencePct: number; apiCompliancePct: number; apis: ApiCompliance[]; }
export interface RuleViolation { ruleName: string; severity: "ERROR" | "WARN" | "INFO"; message: string; path?: string; }
export interface WorkflowGroup { type: string; label: string; pending: number; requests: { referenceId: string; type: string; requester: string; description: string; createdTime: string }[]; }
export interface MigratedApi { id: string; name: string; context: string; version: string; lifeCycleStatus: string; securityScheme: string[]; throttlingPolicy?: string; operations: { verb: string; target: string; authType: string }[]; backend?: string; }

// ---- Observe: inventory, analytics, gateway analytics, logs ----
export interface SourceState { ok: boolean; configured: boolean; detail?: string; }
export interface GatewayApi {
  id: string; name: string; context: string; version: string; lifeCycleStatus: string;
  security: string[]; throttling: string | null; tiers: string[];
  subscriptions: number | null; applications: string[]; backend: string | null; cachingSeconds: number | null;
  operations: { verb: string; target: string; authType: string; throttling: string | null }[];
}
export interface Traffic { source: "service" | "gateway" | "runtime"; requests: number; errors: number; errorRate: number; avgMs: number | null; p95Ms: number | null; }
export interface PodInfo { name: string; phase: string; ready: boolean; restarts: number; startedAt: string; reason: string; }
export interface Health { state: "healthy" | "degraded" | "down" | "stopped" | "unknown"; ready: number; desired: number; restarts: number; image: string; pods: PodInfo[]; }
export interface InventoryItem {
  id: string; name: string; kind: "service" | "flow" | "gateway-api" | "component"; role: string;
  exposure: "published" | "draft" | "internal"; gateway: GatewayApi[];
  cluster: { address: string; port: number | null; nodePort: number | null; namespace: string } | null;
  health: Health | null; metricsExported: boolean | null; traffic: Traffic | null;
  factoryPath: string | null; logSource: string | null; description?: string;
}
export interface GwStatus {
  state: "not-configured" | "waiting-for-file" | "active" | "error"; enabled: boolean;
  file: string | null; fileSize: number; lastEventAt: string | null; lastReadAt: string | null; oldestAt: string | null;
  eventsIndexed: number; linesSkipped: number; detail?: string;
}
export interface Inventory {
  generatedAt: string;
  sources: { kubernetes: SourceState; gateway: SourceState; metrics: SourceState; runtime: SourceState; gatewayAnalytics: GwStatus };
  summary: { services: number; published: number; internal: number; flows: number; gatewayOnly: number; unhealthy: number };
  items: InventoryItem[]; components: InventoryItem[];
}
export type Range = "15m" | "1h" | "6h" | "24h" | "7d";
export type GwRange = Range | "30d";
export interface Totals { requests: number; errors: number; errorRate: number; avgMs: number | null; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; }
export interface OverviewPoint { t: number; end: number; requests: number; errors: number; avgMs: number | null; p95Ms?: number | null; }
export interface ApiRow extends Totals { name: string; kind: "service" | "flow"; id?: string; exportsMetrics: boolean; spark: number[]; lastAt?: string; windowNote?: string; }
export interface AnalyticsOverview {
  range: Range; from: number; to: number; stepSeconds: number; generatedAt: string;
  sources: { prometheus: SourceState; runtime: SourceState };
  totals: Totals; series: OverviewPoint[]; apis: ApiRow[]; notExporting: string[]; removedFlowRuns?: number;
}
export interface DetailPoint extends OverviewPoint { s2xx: number; s3xx: number; s4xx: number; s5xx: number; p50Ms?: number | null; p99Ms?: number | null; }
export interface ApiDetail {
  name: string; kind: "service" | "flow"; id?: string; exportsMetrics: boolean;
  range: Range; from: number; to: number; stepSeconds: number; generatedAt: string;
  source: SourceState; totals: Totals; series: DetailPoint[];
  byStatus: { group: string; requests: number }[];
  operations: { method: string; path: string; requests: number; errors: number; errorRate: number; avgMs: number | null; p95Ms: number | null }[];
  latency: { quantile: string; label: string; ms: number }[];
  downstream: { peer: string; requests: number; errors: number; avgMs: number | null }[];
  replicas: number; windowNote?: string;
}
export interface GwTotals {
  requests: number; success: number; clientErrors: number; serverErrors: number; faults: number; throttled: number; cacheHits: number;
  avgResponseMs: number; avgBackendMs: number; avgMediationMs: number; p50Ms: number; p95Ms: number; p99Ms: number; backendP50Ms: number; backendP95Ms: number;
}
export interface GwSeriesPoint { t: number; requests: number; s2xx: number; s3xx: number; s4xx: number; s5xx: number; faults: number; throttled: number; cacheHits: number; avgResponseMs: number; avgBackendMs: number; p95Ms: number; }
export interface GwBreakdownRow {
  key: string; label: string; requests: number; errors: number; faults: number; throttled: number; cacheHits: number;
  avgResponseMs: number; avgBackendMs: number; p95Ms: number; share: number; lastAt: number | null; extra?: Record<string, string>;
}
export interface GwSummary {
  range: GwRange; from: number; to: number; stepSeconds: number; totals: GwTotals; series: GwSeriesPoint[];
  byApi: GwBreakdownRow[]; byApp: GwBreakdownRow[]; byOperation: GwBreakdownRow[];
  byStatus: { status: number; requests: number }[]; byErrorType: { errorType: string; requests: number }[];
  latencyHistogram: { leMs: number | null; label: string; response: number; backend: number }[];
  apis: string[]; apps: string[];
}
export interface GwEvent {
  ts: number; type: "response" | "fault"; api: string; version: string; context: string; method: string; resource: string;
  app: string; appOwner: string; user: string; keyType: string; status: number; targetStatus: number | null;
  responseLatency: number; backendLatency: number; requestMediationLatency: number; responseMediationLatency: number;
  cacheHit: boolean; throttled: boolean; errorType: string; errorCode: number | string | null; errorMessage: string;
  userAgent: string; userIp: string; correlationId: string; gatewayType: string; platform: string; destination: string;
}
export type GwStatusFilter = "all" | "2xx" | "4xx" | "5xx" | "fault" | "throttled";
export interface LogSource { id: string; label: string; kind: "service" | "gateway" | "flow" | "component"; replicas: number; }
export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "";
export interface LogEntry { t: number; source: string; pod: string; level: LogLevel; msg: string; cid: string; text: string; }
export interface LogResult {
  lines: LogEntry[]; matched: number; scanned: number; limit: number;
  sources: { id: string; label: string; replicas: string[]; lines: number; error?: string }[]; generatedAt: string;
}
function qs(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

// ---- Gateway rules (live API changes) ----
export interface PolicyInfo { name: string; limit: number; timeUnit: string; unitTime: number; quotaType?: string; description?: string; }
export interface RulesApi { id: string; name: string; context: string; version: string; lifeCycleStatus: string; provider?: string; lastUpdatedTime?: string | null; type?: string; }
export interface EnvRef { name: string; displayName: string; vhost: string; }
export interface Cors { enabled: boolean; origins: string[]; headers: string[]; methods: string[]; credentials: boolean; }
export type Security = "oauth2" | "apikey" | "both" | "none";
export interface ApiRules {
  stage: "production" | "uat"; stageWord: string; via: "user" | "service"; api: RulesApi;
  traffic: { tiers: string[]; apiPolicy: string | null; operations: { verb: string; target: string; policy: string | null }[] };
  policies: { subscription: PolicyInfo[]; advanced: PolicyInfo[]; application?: PolicyInfo[] };
  access: { security: Security; securityWords: string; cors: Cors; ipAllow: string[]; ipDeny: string[]; clientIpHeader: string };
  deployments: { name: string; vhost: string; revisionUuid: string; deployedTime: number | null; status?: string }[];
  environments: EnvRef[];
}
export interface ChangePlan {
  api: RulesApi; changes: string[]; noChange: boolean; environments: { name: string; vhost: string }[]; sentence: string;
  pruneRevision?: { id: string; displayName: string } | null; applied: boolean; revision?: { id: string; displayName: string } | null;
}
export interface TrafficBody { tiers: string[]; apiPolicy: string | null; operations: { verb: string; target: string; policy: string | null }[]; environments?: string[]; }
export interface AccessBody { security: Security; cors: Cors; ipAllow: string[]; ipDeny: string[]; confirmNoSecurity?: string; environments?: string[]; }
export interface Consumer { subscriptionId: string; applicationId: string; application: string; owner: string; plan: string; status: string; }
export interface Counts { requests: number; errors: number; throttled: number; refused: number; }
export interface LiveStatus {
  api: RulesApi; measured: boolean; analytics: { state: string; detail: string | null; lastEventAt: string | null } | null;
  last5m: Counts | null; last1h: Counts | null;
  deployments: { name: string; vhost: string; revision: string; revisionId: string; deployedTime: number | null }[];
  lastChange: { at: string | null; by: string | null; action: string; outcome: string; what: string };
}
export interface AuditLine { at: string; user: string; action: string; outcome: "ok" | "failed"; apiId?: string; apiName?: string; target?: string; environment?: string; revision?: string; before?: string; after?: string; detail?: string; }
export interface Revision { id: string; displayName: string; description: string; createdTime: number | null; deployedTo: { name: string; vhost: string; deployedTime: number | null }[]; }
export interface BlockRule { id: string; type: string; value: unknown; enabled: boolean; words: string; }
export interface AppRow { id: string; name: string; plan: string; description: string; owner: string; subscriptions: number; status: string; }
export interface AppKey { keyMappingId: string; keyType: string; keyManager: string; consumerKey: string | null; state: string | null; grantTypes: string[]; }
export interface AppDetail { id: string; name: string; plan: string; description: string; owner: string; keys: AppKey[];
  subscriptions: { subscriptionId: string; apiId: string; apiName: string; apiVersion: string; plan: string; status: string }[]; }
export interface Usage { usage: Record<string, { apis: { id: string; name: string; how: string }[]; applications: string[] }>; apis: { id: string; name: string }[]; }
export interface Signals {
  stage: string; stageWord: string; via: string; total: number; published: number;
  environments: Record<string, { live: number; apis: string[] }>; notDeployed: { id: string; name: string }[];
  open: { id: string; name: string; live: boolean }[]; blocking: { total: number; active: number } | null;
  traffic: { requests: number; throttled: number; refused: number; errors: number; topThrottled: { name: string; throttled: number }[] } | null;
  analytics: { state: string; detail: string | null } | null;
  recent: { at: string; by: string | null; action: string; apiId: string | null; apiName: string; outcome: string; what: string }[];
}
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body ?? {}) });

export const rulesClient = {
  context: () => j<{ stage: string; stageWord: string; user: string; via: string; clientIpHeader: string; environments: EnvRef[] }>("/api/rules/context"),
  apis: () => j<{ via: string; list: RulesApi[] }>("/api/rules/apis"),
  api: (id: string) => j<ApiRules>(`/api/rules/apis/${id}`),
  traffic: (id: string, body: TrafficBody, preview: boolean) => j<ChangePlan>(`/api/rules/apis/${id}/traffic${preview ? "?preview=1" : ""}`, post(body)),
  access: (id: string, body: AccessBody, preview: boolean) => j<ChangePlan>(`/api/rules/apis/${id}/access${preview ? "?preview=1" : ""}`, post(body)),
  consumers: (id: string) => j<{ list: Consumer[] }>(`/api/rules/apis/${id}/consumers`),
  subscriptionState: (subId: string, apiId: string, state: "BLOCKED" | "PROD_ONLY_BLOCKED" | "UNBLOCKED") => j(`/api/rules/subscriptions/${subId}/state`, post({ apiId, state })),
  live: (id: string) => j<LiveStatus>(`/api/rules/apis/${id}/live`),
  history: (id: string) => j<{ revisions: Revision[]; audit: AuditLine[]; maxRevisions: number }>(`/api/rules/apis/${id}/history`),
  rollback: (id: string, revisionId: string, preview: boolean) => j<ChangePlan & { revision: { id: string; displayName: string } }>(`/api/rules/apis/${id}/rollback${preview ? "?preview=1" : ""}`, post({ revisionId })),
  createPolicy: (body: { kind: "subscription" | "advanced" | "application"; name: string; requests: number; timeUnit: string }) => j<{ ok: boolean; name: string }>("/api/rules/policies", post(body)),
  usage: () => j<Usage>("/api/rules/policies/usage"),
  overview: () => j<Signals>("/api/rules/overview"),
  blocking: () => j<{ list: BlockRule[] }>("/api/rules/blocking"),
  addBlock: (body: { type: string; value: string; endIp?: string; invert?: boolean; enabled: boolean }) => j<{ id: string; words: string }>("/api/rules/blocking", post(body)),
  setBlock: (id: string, enabled: boolean) => j(`/api/rules/blocking/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  removeBlock: (id: string) => j(`/api/rules/blocking/${id}`, { method: "DELETE", body: "{}" }),
  applications: () => j<{ owner: string; plans: PolicyInfo[]; list: AppRow[] }>("/api/rules/applications"),
  application: (id: string) => j<AppDetail>(`/api/rules/applications/${id}`),
  createApplication: (body: { name: string; plan: string; description?: string }) => j<{ id: string; name: string }>("/api/rules/applications", post(body)),
  deleteApplication: (id: string, confirm: string) => j(`/api/rules/applications/${id}`, { method: "DELETE", body: JSON.stringify({ confirm }) }),
  generateKeys: (id: string, keyType: "PRODUCTION" | "SANDBOX") => j<AppKey & { consumerSecret: string | null }>(`/api/rules/applications/${id}/keys`, post({ keyType })),
  regenerateSecret: (id: string, km: string) => j<{ consumerKey: string | null; consumerSecret: string | null }>(`/api/rules/applications/${id}/keys/${km}/regenerate`, post({})),
  revokeKeys: (id: string, km: string, confirm: string) => j(`/api/rules/applications/${id}/keys/${km}/revoke`, post({ confirm })),
  subscribe: (id: string, apiId: string, plan: string) => j<{ subscriptionId: string }>(`/api/rules/applications/${id}/subscriptions`, post({ apiId, plan })),
  unsubscribe: (id: string, subId: string) => j(`/api/rules/applications/${id}/subscriptions/${subId}`, { method: "DELETE", body: "{}" }),
};

export const apiClient = {
  me: () => j<Me>("/api/auth/me"),
  rateLimits: (type: string) => j<{ list: (SubPolicy | AdvPolicy)[] }>(`/api/ratelimits/${type}`),
  createPolicy: (type: string, body: unknown) => j(`/api/ratelimits/${type}`, { method: "POST", body: JSON.stringify(body) }),
  deletePolicy: (type: string, id: string) => j(`/api/ratelimits/${type}/${id}`, { method: "DELETE", body: "{}" }),
  environments: () => j<{ list: Environment[] }>("/api/environments"),
  keyManagers: () => j<{ list: KeyManager[] }>("/api/key-managers"),
  compliance: () => j<ComplianceSummary>("/api/compliance"),
  complianceApi: (id: string) => j<{ apiId: string; violations: RuleViolation[] }>(`/api/compliance/${id}`),
  workflows: () => j<{ types: WorkflowGroup[] }>("/api/workflows"),
  decideWorkflow: (ref: string, status: "APPROVED" | "REJECTED", description: string) =>
    j(`/api/workflows/${ref}`, { method: "POST", body: JSON.stringify({ status, description }) }),
  apis: () => j<{ list: MigratedApi[] }>("/api/apis"),
  inventory: () => j<Inventory>("/api/inventory"),
  analyticsOverview: (range: Range) => j<AnalyticsOverview>(`/api/analytics/overview${qs({ range })}`),
  analyticsApi: (name: string, range: Range) => j<ApiDetail>(`/api/analytics/api/${encodeURIComponent(name)}${qs({ range })}`),
  gwSummary: (range: GwRange, api?: string, app?: string) => j<{ status: GwStatus; summary: GwSummary }>(`/api/gateway-analytics/summary${qs({ range, api, app })}`),
  gwRequests: (q: { search?: string; api?: string; app?: string; status?: GwStatusFilter; cid?: string; limit?: number }) =>
    j<{ status: GwStatus; total: number; kept: number; rows: GwEvent[] }>(`/api/gateway-analytics/requests${qs(q)}`),
  logSources: () => j<{ list: LogSource[]; errors: string[] }>("/api/logs/sources"),
  logs: (q: { sources: string[]; tail?: number; sinceSeconds?: number; level?: string; q?: string; cid?: string }) =>
    j<LogResult>(`/api/logs${qs({ ...q, sources: q.sources.join(",") })}`),
};
