// Browser client for versions in git (BFF: src/versions/routes.ts).
import { at } from "../lib/base.ts";
import type { Job } from "../servers/api.ts";

export interface VersionRow {
  version: number; at?: string; by?: string; what?: string; commit?: string; image?: string; revertOf?: number; clonedFrom?: string;
  summary?: { files?: number; changed?: string[] }; results?: Record<string, { status?: string; detail?: string }>;
}
export interface VersionList { ok: boolean; versions: VersionRow[]; total: number; pending?: number; remote?: string; error?: string }
export interface VersionDiff { ok: boolean; stat?: string; patch?: string; truncated?: boolean; settingsAdded?: string[]; settingsRemoved?: string[]; error?: string }
export interface Change { number: number; title?: string; url?: string; branch?: string; by?: string; createdAt?: string }
export interface Changes { ok: boolean; pulls: Change[]; localBranches?: string[]; error?: string }
export interface VersionStatus { ok: boolean; remote?: string; pending?: number; tokenSet?: boolean; lastPush?: string; lastPushError?: string; publicKey?: string; workspace?: string; error?: string }

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(at(path), { credentials: "include", ...(init?.body != null ? { headers: { "Content-Type": "application/json" } } : {}), ...init });
  if (r.status === 401) throw Object.assign(new Error("unauthorized"), { status: 401 });
  let body: any = null;
  try { body = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw Object.assign(new Error(body?.error || body?.message || `Request failed (${r.status})`), { status: r.status, body });
  return body as T;
}
const post = (body?: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body ?? {}) });
const e = encodeURIComponent;
const V = "/api/factory/versions";

export const vapi = {
  status: () => j<VersionStatus>(`${V}/status`),
  list: (api: string, limit = 10) => j<VersionList>(`${V}/apis/${e(api)}?limit=${limit}`),
  diff: (api: string, from: number, to: number) => j<VersionDiff>(`${V}/apis/${e(api)}/diff?from=${from}&to=${to}`),
  revert: (api: string, version: number) => j<Job>(`${V}/apis/${e(api)}/revert`, post({ version })),
  clone: (api: string, name: string) => j<Job>(`${V}/apis/${e(api)}/clone`, post({ name })),
  propose: (api: string, title: string) => j<{ ok: boolean; branch?: string; pr?: { number: number; url: string } | null; note?: string; error?: string; refused?: string[] }>(`${V}/apis/${e(api)}/propose`, post({ title })),
  changes: (api: string) => j<Changes>(`${V}/apis/${e(api)}/changes`),
  approve: (api: string, n: number) => j<Job>(`${V}/apis/${e(api)}/changes/${n}/approve`, post()),
  close: (api: string, n: number) => j<{ ok: boolean; error?: string }>(`${V}/apis/${e(api)}/changes/${n}/close`, post()),
};
