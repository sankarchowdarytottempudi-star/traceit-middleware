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

export const apiClient = {
  me: () => j<Me>("/api/auth/me"),
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
};
