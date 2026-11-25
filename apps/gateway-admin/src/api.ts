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

export type AccessRole = "admin" | "migration" | "gateway";
export interface Me { user: string; role: string; name?: string; email?: string; provider?: "wso2" | "oidc" | "local"; roles?: AccessRole[]; canChangePassword?: boolean; }
/** Roles of the signed-in person. An older server without roles meant full access. */
export function rolesOf(me: Me | undefined): AccessRole[] { return me?.roles ?? ["admin", "migration", "gateway"]; }
export interface AccessUser {
  id: string; email: string; name: string; provider: "local" | "oidc" | "wso2"; subject?: string; roles: AccessRole[]; disabled: boolean;
  hasPassword: boolean; source?: string; createdAt: string; createdBy?: string; updatedAt: string; lastSignInAt?: string;
}
export interface GroupRole { group: string; label?: string; roles: AccessRole[]; }
export interface AccessList { configured: boolean; users: AccessUser[]; groupRoles: GroupRole[]; providers: string[]; groupsClaim: string | null; auditEnabled: boolean; me: string | null; }
export interface AuditEntry { time: string; user: string; action: string; target?: string; app?: string; provider?: string; via?: string; status?: number; ip?: string; detail?: string; }
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

export const apiClient = {
  me: () => j<Me>("/api/auth/me"),
  logout: () => j<{ ok: boolean }>("/api/auth/logout", { method: "POST", body: "{}" }),
  accessUsers: () => j<AccessList>("/api/access/users"),
  accessCreate: (body: { provider: string; email: string; name?: string; roles: AccessRole[]; password?: string }) => j<{ user: AccessUser }>("/api/access/users", { method: "POST", body: JSON.stringify(body) }),
  accessUpdate: (id: string, body: { roles?: AccessRole[]; disabled?: boolean; name?: string }) => j<{ user: AccessUser }>(`/api/access/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  accessResetPassword: (id: string, password: string) => j<{ ok: boolean }>(`/api/access/users/${encodeURIComponent(id)}/password`, { method: "POST", body: JSON.stringify({ password }) }),
  accessRemove: (id: string) => j<{ ok: boolean }>(`/api/access/users/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" }),
  accessGroups: (mappings: GroupRole[]) => j<{ groupRoles: GroupRole[] }>("/api/access/group-roles", { method: "PUT", body: JSON.stringify({ mappings }) }),
  accessAudit: (q?: string) => j<{ enabled: boolean; entries: AuditEntry[] }>(`/api/access/audit${qs({ limit: 300, q })}`),
  rateLimits: (type: string) => j<{ list: (SubPolicy | AdvPolicy)[] }>(`/api/ratelimits/${type}`),
  createPolicy: (type: string, body: unknown) => j(`/api/ratelimits/${type}`, { method: "POST", body: JSON.stringify(body) }),
  deletePolicy: (type: string, id: string) => j(`/api/ratelimits/${type}/${id}`, { method: "DELETE" }),
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
