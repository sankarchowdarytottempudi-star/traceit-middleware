import type { TComplianceSummary, TMigratedApi } from "./schemas.js";

export const UNLIMITED = 2147483647;

/** WSO2 subscription throttling policies -> view model rows. */
export function reshapeSubPolicies(list: any[]): any[] {
  return (list ?? []).map((p) => {
    const dl = p.defaultLimit ?? {};
    const rc = dl.requestCount ?? {}; const bw = dl.bandwidth ?? {}; const ev = dl.eventCount ?? {};
    const type = dl.type === "BANDWIDTHLIMIT" ? "bandwidth" : dl.type === "EVENTCOUNTLIMIT" ? "eventCount" : "requestCount";
    const limit = type === "bandwidth" ? Number(bw.dataAmount ?? 0) : type === "eventCount" ? Number(ev.eventCount ?? 0) : Number(rc.requestCount ?? 0);
    const timeUnit = rc.timeUnit ?? bw.timeUnit ?? ev.timeUnit ?? "min";
    return { policyId: p.policyId ?? p.policyName, name: p.policyName, displayName: p.displayName ?? p.policyName,
      quotaType: type, limit, unit: bw.dataUnit ?? "req", timeUnit, stopOnQuotaReach: p.stopOnQuotaReach ?? true };
  });
}

export function reshapeAdvanced(list: any[]): any[] {
  return (list ?? []).map((p) => {
    const rc = p.defaultLimit?.requestCount ?? {};
    return { policyId: p.policyId ?? p.policyName, name: p.policyName, limit: Number(rc.requestCount ?? 0), timeUnit: rc.timeUnit ?? "min" };
  });
}

export function reshapeEnvironments(list: any[]): any[] {
  return (list ?? []).map((e) => {
    const vhosts = (e.vhosts ?? []).map((v: any) => ({ host: v.host, httpContext: v.httpContext }));
    const reachable = !vhosts.some((v: any) => isLocalhost(v.host));
    return { id: e.id ?? e.name, name: e.name, type: e.type ?? "hybrid", gatewayType: e.gatewayType ?? "Regular",
      visibility: e.visibility ?? "PUBLIC", vhosts, reachable };
  });
}

export function isLocalhost(host?: string): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1" || h === "localhost" || h === "127.0.0.1") return true;
  const base = h.split(":")[0];
  return base === "localhost" || base === "127.0.0.1";
}

export function reshapeKeyManagers(list: any[]): any[] {
  return (list ?? []).map((k) => ({ id: k.id ?? k.name, name: k.name, type: k.type ?? "direct", enabled: k.enabled ?? true }));
}

export function reshapeApis(list: any[]): TMigratedApi[] {
  return (list ?? []).map((a) => ({
    id: a.id, name: a.name, context: a.context, version: a.version,
    lifeCycleStatus: a.lifeCycleStatus ?? "CREATED",
    securityScheme: a.securityScheme ?? [],
    throttlingPolicy: a.apiThrottlingPolicy ?? undefined,
    operations: (a.operations ?? []).map((o: any) => ({ verb: o.verb, target: o.target, authType: o.authType ?? "None" })),
    backend: a.endpointConfig?.production_endpoints?.url,
  }));
}

/** Compliance: rank by errors then warnings; compute severity totals and percentages. */
export function rankCompliance(summary: Omit<TComplianceSummary, "apiCompliancePct" | "policyAdherencePct"> & { apis: any[] }): TComplianceSummary {
  const apis = [...summary.apis].sort((a, b) => (b.errors - a.errors) || (b.warnings - a.warnings) || a.name.localeCompare(b.name));
  const apiCompliancePct = summary.total ? Math.round((summary.compliant / summary.total) * 100) : 0;
  const compliantPolicies = apis.filter((a) => a.errors === 0).length;
  const policyAdherencePct = apis.length ? Math.round((compliantPolicies / apis.length) * 100) : 0;
  return { ...summary, apis, apiCompliancePct, policyAdherencePct };
}
