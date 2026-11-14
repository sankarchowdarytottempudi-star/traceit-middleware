// Weave runtime (Studio flows) client: read-only stats, flow list and flow logs.
// Contract: packages/weave-flow/src/api.ts (prefix /v1, header x-weave-key). The runtime is internal only.
import { httpJson, reason } from "./http.js";

export interface RtFlow {
  id: string; name: string; slug: string; description?: string; tags?: string[]; revision?: number; updatedAt?: string;
  deployment?: { status?: string; gateway?: { status?: string; apiId?: string; context?: string; version?: string; url?: string; error?: string } };
  nodeCount?: number; triggers?: unknown[]; lastExecution?: unknown;
}
export interface RtStats {
  flows: { flowId: string; name: string; slug: string; deployed: boolean; total: number; errors: number; p50Ms: number; p95Ms: number; lastAt?: string }[];
  series: { at: string; total: number; errors: number }[];
}
export interface RtLogLine { at: string; level: string; message: string; flowId: string; executionId?: string; nodeName?: string; }
export type RtResult<T> = { ok: true; data: T } | { ok: false; detail: string };

export interface Runtime {
  configured: boolean;
  flows(): Promise<RtResult<RtFlow[]>>;
  stats(hours: number): Promise<RtResult<RtStats>>;
  flowLogs(id: string, limit: number, level?: string): Promise<RtResult<RtLogLine[]>>;
}

export function createRuntime(url: string | undefined, key: string | undefined): Runtime {
  const base = (url ?? "").replace(/\/+$/, "");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) headers["x-weave-key"] = key;
  async function get<T>(path: string, pick: (j: any) => T): Promise<RtResult<T>> {
    if (!base) return { ok: false, detail: "not configured" };
    try { return { ok: true, data: pick(await httpJson<any>(`${base}/v1${path}`, { headers, timeoutMs: 5000 })) }; }
    catch (e) { return { ok: false, detail: reason(e) }; }
  }
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    configured: !!base,
    flows: () => get("/flows", (j) => arr(j?.flows) as RtFlow[]),
    stats: (hours) => get(`/stats?hours=${Math.max(1, Math.ceil(hours))}`, (j) => ({ flows: arr(j?.flows), series: arr(j?.series) }) as RtStats),
    flowLogs: (id, limit, level) => get(`/flows/${encodeURIComponent(id)}/logs?limit=${limit}${level ? `&level=${encodeURIComponent(level)}` : ""}`,
      (j) => arr(j?.lines) as RtLogLine[]),
  };
}
