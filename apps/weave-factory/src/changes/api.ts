// Browser client for change requests (BFF: src/changes/routes.ts). The code model runs on the
// migration tool's build server; nothing leaves the server.
import { at } from "../lib/base.ts";

export interface ChangeExample { op: string; name?: string; pathValues?: Record<string, string>; query?: string; body?: unknown;
  backendReplies?: { backend: string; method?: string; path?: string; status: number; body?: unknown }[]; expectStatus?: number; expectBodyHas?: string[] }
export interface ChangeStep { name: string; round?: number; state: string; detail?: string; at?: number }
export interface Change { id: string; api: string; status: "queued" | "running" | "ready" | "failed" | "applied" | "proposed" | "approved" | "rejected" | string;
  createdAt?: number; finishedAt?: number; by?: string; why?: string; explanation?: string; round?: number; steps?: ChangeStep[]; diff?: string; pr?: number; prUrl?: string; note?: string;
  request?: { requirement: string; flow?: string; examples?: ChangeExample[] };
  baseline?: { tests?: boolean; passing?: number; coverage?: number | null; parity?: string };
  results?: { tests?: number; coverage?: number | null; trial?: string; parity?: string }; modelSeconds?: number[]; requirement?: string }

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

export const changesApi = {
  list: (api: string) => j<{ ok: boolean; changes: Change[] }>(`/api/factory/changes/apis/${e(api)}`),
  start: (api: string, body: { requirement: string; flow?: string; examples?: ChangeExample[] }) => j<{ ok: boolean; id: string }>(`/api/factory/changes/apis/${e(api)}`, post(body)),
  fixItem: (api: string, itemId: string) => j<{ ok: boolean; id: string }>(`/api/factory/changes/apis/${e(api)}/open-item`, post({ itemId })),
  openItems: (migrationId: string) => j<{ items?: { id: string; kind: string; title: string }[] }>(`/api/factory/migrations/${e(migrationId)}/open-items`),
  get: (id: string) => j<Change>(`/api/factory/changes/${e(id)}`),
  act: (id: string, action: "propose" | "approve" | "reject") => j<{ ok?: boolean; error?: string; pr?: { number?: number; url?: string }; note?: string }>(`/api/factory/changes/${e(id)}/${action}`, post({})),
};
