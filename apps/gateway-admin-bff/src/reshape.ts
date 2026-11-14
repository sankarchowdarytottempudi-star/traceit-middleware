// WSO2 response shapes come from the official API-M 4.5.0 OpenAPI specs (openapi/*.yaml ->
// wso2-admin.ts / wso2-governance.ts, generated with openapi-typescript). We reshape those
// into the view models the screens need; zod (schemas.ts) does edge validation of our output.
import type { components as Admin } from "./wso2-admin.ts";
import type { components as Gov } from "./wso2-governance.ts";

type SubPolicyDTO = Admin["schemas"]["SubscriptionThrottlePolicy"];
type AdvPolicyDTO = Admin["schemas"]["AdvancedThrottlePolicy"];
type EnvironmentDTO = Admin["schemas"]["Environment"];
type KeyManagerDTO = Admin["schemas"]["KeyManagerInfo"];

export const UNLIMITED = 2147483647;

export interface SubPolicyVM { policyId: string; name: string; displayName: string; quotaType: string; limit: number; unit: string; timeUnit: string; stopOnQuotaReach: boolean; }
export interface AdvPolicyVM { policyId: string; name: string; limit: number; timeUnit: string; }
export interface EnvVM { id: string; name: string; type: string; gatewayType: string; visibility: string; vhosts: { host: string; httpContext?: string }[]; reachable: boolean; }
export interface KeyManagerVM { id: string; name: string; type: string; enabled: boolean; }
export interface ApiVM { id: string; name: string; context: string; version: string; lifeCycleStatus: string; securityScheme: string[]; throttlingPolicy?: string; operations: { verb?: string; target?: string; authType: string }[]; backend?: string; }

export function reshapeSubPolicies(list: SubPolicyDTO[]): SubPolicyVM[] {
  return (list ?? []).map((p) => {
    const dl = p.defaultLimit;
    const rc = dl?.requestCount; const bw = dl?.bandwidth; const ev = dl?.eventCount;
    const type = dl?.type === "BANDWIDTHLIMIT" ? "bandwidth" : dl?.type === "EVENTCOUNTLIMIT" ? "eventCount" : "requestCount";
    const limit = type === "bandwidth" ? Number(bw?.dataAmount ?? 0) : type === "eventCount" ? Number(ev?.eventCount ?? 0) : Number(rc?.requestCount ?? 0);
    const timeUnit = rc?.timeUnit ?? bw?.timeUnit ?? ev?.timeUnit ?? "min";
    return { policyId: p.policyId ?? p.policyName, name: p.policyName, displayName: p.displayName ?? p.policyName,
      quotaType: type, limit, unit: bw?.dataUnit ?? "req", timeUnit, stopOnQuotaReach: p.stopOnQuotaReach ?? true };
  });
}

export function reshapeAdvanced(list: AdvPolicyDTO[]): AdvPolicyVM[] {
  return (list ?? []).map((p) => {
    const rc = p.defaultLimit?.requestCount;
    return { policyId: p.policyId ?? p.policyName, name: p.policyName, limit: Number(rc?.requestCount ?? 0), timeUnit: rc?.timeUnit ?? "min" };
  });
}

export function reshapeEnvironments(list: EnvironmentDTO[]): EnvVM[] {
  return (list ?? []).map((e) => {
    const vhosts = (e.vhosts ?? []).map((v) => ({ host: v.host, httpContext: v.httpContext }));
    const reachable = !vhosts.some((v) => isLocalhost(v.host));
    return { id: e.id ?? e.name, name: e.name, type: e.type ?? "hybrid", gatewayType: e.gatewayType ?? "Regular",
      visibility: "PUBLIC", vhosts, reachable };
  });
}

export function isLocalhost(host?: string): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1" || h === "localhost" || h === "127.0.0.1") return true;
  const base = h.split(":")[0];
  return base === "localhost" || base === "127.0.0.1";
}

export function reshapeKeyManagers(list: KeyManagerDTO[]): KeyManagerVM[] {
  return (list ?? []).map((k) => ({ id: k.id ?? k.name, name: k.name, type: k.type ?? "direct", enabled: k.enabled ?? true }));
}

// Publisher API (/api/am/publisher/v4/apis) is the Publisher REST API, NOT in the vendored
// admin/governance specs; its shape is defined locally. See openapi/PROVENANCE.txt.
export interface PublisherApiLike {
  id: string; name: string; context: string; version: string; lifeCycleStatus?: string;
  securityScheme?: string[]; apiThrottlingPolicy?: string;
  operations?: { verb?: string; target?: string; authType?: string }[];
  endpointConfig?: { production_endpoints?: { url?: string } };
}
export function reshapeApis(list: PublisherApiLike[]): ApiVM[] {
  return (list ?? []).map((a) => ({
    id: a.id, name: a.name, context: a.context, version: a.version,
    lifeCycleStatus: a.lifeCycleStatus ?? "CREATED", securityScheme: a.securityScheme ?? [],
    throttlingPolicy: a.apiThrottlingPolicy ?? undefined,
    operations: (a.operations ?? []).map((o) => ({ verb: o.verb, target: o.target, authType: o.authType ?? "None" })),
    backend: a.endpointConfig?.production_endpoints?.url,
  }));
}

type ApiComplianceRow = { name: string; errors: number; warnings: number; info?: number };
export function rankCompliance(summary: { governed: number; compliant: number; total: number; errors: number; warnings: number; info: number; apis: ApiComplianceRow[] }) {
  const apis = [...summary.apis].sort((a, b) => (b.errors - a.errors) || (b.warnings - a.warnings) || a.name.localeCompare(b.name));
  const apiCompliancePct = summary.total ? Math.round((summary.compliant / summary.total) * 100) : 0;
  const compliantPolicies = apis.filter((a) => a.errors === 0).length;
  const policyAdherencePct = apis.length ? Math.round((compliantPolicies / apis.length) * 100) : 0;
  return { ...summary, apis, apiCompliancePct, policyAdherencePct };
}

// Per-API governance compliance detail (from the governance spec).
export type GovArtifactCompliance = Gov["schemas"]["ArtifactComplianceDetails"];
