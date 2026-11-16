// Browser client for customer servers, environments and releases (BFF: src/servers/routes.ts).
import { at } from "../lib/base.ts";

export interface Step { step: string; state: "run" | "ok" | "skip" | "fail" | string; message?: string; help?: string }
export interface CustomerServer {
  host: string; port: number; username: string; provisioned?: boolean; hostname?: string; mgmtHostname?: string; tls?: string; expose?: string; mode?: string;
  hostKey?: string; keyInstalled?: boolean; install?: { state?: string; steps?: Step[]; at?: string } | null; status?: Record<string, unknown> | null; provisionNote?: string;
}
export interface CustomerEnv { name: string; server: string; namespace?: string; order: number; approval: boolean }
export interface CustomerWorkspace { id: string; name: string; createdAt?: string; servers: Record<string, CustomerServer>; environments: CustomerEnv[] }
export interface Job { id: string; kind: string; state: "running" | "done" | "failed"; startedAt?: string; endedAt?: string; result?: { ok?: boolean; error?: string; refused?: string[]; message?: string; steps?: Step[]; release?: Release; entry?: Record<string, unknown> } }
export interface Gates { trialPassed?: boolean; trialSummary?: string; parityComplete?: boolean; paritySummary?: string; responseParity?: boolean | null }
export interface Release { id: string; api: string; version: string; archiveSha256?: string; createdAt?: string; createdBy?: string; requiredKeys?: number; gates?: Gates }
export interface Lane { env: string; server: string; approval: boolean; approvedFor?: boolean; release: { id: string; version: string; archiveSha256?: string } | null; since?: string | null; lastResult?: string | null; canRollback?: boolean }
export interface AuditRow { at: string; who: string; action: string; api?: string; env?: string; version?: string; result?: string; approvedBy?: string | null; [k: string]: unknown }

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
const W = (id: string) => `/api/factory/workspace-configs/${e(id)}`;

export const sapi = {
  workspace: (id: string) => j<CustomerWorkspace>(W(id)),
  publicKey: (id: string, tier: string) => j<{ publicKey: string }>(`${W(id)}/servers/${e(tier)}/key`),
  status: (id: string, tier: string) => j<{ ok: boolean; status?: Record<string, unknown>; error?: string }>(`${W(id)}/servers/${e(tier)}/status`),
  scanHostKey: (id: string, tier: string) => j<{ ok: boolean; fingerprints?: string[]; error?: string }>(`${W(id)}/servers/${e(tier)}/scan-host-key`, post()),
  trustHostKey: (id: string, tier: string, fingerprint: string) => j<{ ok: boolean; message?: string }>(`${W(id)}/servers/${e(tier)}/trust-host-key`, post({ fingerprint })),
  installKey: (id: string, tier: string, password: string) => j<{ ok: boolean; message?: string }>(`${W(id)}/servers/${e(tier)}/install-key`, post({ password })),
  preflight: (id: string, tier: string) => j<{ ok: boolean; message: string; plan?: string[] }>(`${W(id)}/servers/${e(tier)}/preflight`, post()),
  install: (id: string, tier: string, dryRun: boolean) => j<{ started: boolean; job: Job; plan?: string[] }>(`${W(id)}/servers/${e(tier)}/install`, post({ dryRun })),
  uninstall: (id: string, tier: string, purge: boolean) => j<{ started: boolean; job: Job }>(`${W(id)}/servers/${e(tier)}/uninstall`, post({ confirm: true, purge })),
  saveEnvironments: (id: string, environments: { name: string; server: string; approval: boolean }[]) => j<{ ok: boolean; environments: CustomerEnv[] }>(`${W(id)}/environments`, post({ environments })),
  pushSettings: (id: string, env: string, api: string, text: string) => j<{ ok: boolean; keys: number; message?: string; help?: string }>(`${W(id)}/environments/${e(env)}/settings/${e(api)}`, post({ text })),
  lanes: (id: string, api: string) => j<{ api: string; environments: Lane[] }>(`${W(id)}/apis/${e(api)}/environments`),
  deploy: (id: string, env: string, releaseId: string) => j<{ job: Job }>(`${W(id)}/deploy`, post({ env, releaseId })),
  promote: (id: string, api: string, from: string, to: string) => j<{ job: Job }>(`${W(id)}/promote`, post({ api, from, to })),
  rollback: (id: string, api: string, env: string) => j<{ job: Job }>(`${W(id)}/rollback`, post({ api, env })),
  makeRelease: (migrationId: string, version?: string) => j<{ job: Job }>(`/api/factory/migrations/${e(migrationId)}/releases`, post(version ? { version } : {})),
  releases: (api: string) => j<{ releases: Release[] }>(`/api/factory/releases?api=${e(api)}`),
  approve: (releaseId: string, env: string, approver: string, note: string) => j<{ ok: boolean; message?: string }>(`/api/factory/releases/${e(releaseId)}/approve`, post({ env, approver, note })),
  audit: (api: string) => j<{ audit: AuditRow[] }>(`/api/factory/audit?api=${e(api)}`),
  job: (jid: string) => j<Job>(`/api/factory/jobs/${e(jid)}`),
};

export const STEP_WORDS: Record<string, string> = {
  connect: "Connect", preflight: "Check the server", k3s: "Kubernetes", helm: "Helm", namespaces: "Namespaces", "apim-secret": "WSO2 admin account",
  apim: "WSO2 API Manager", ingress: "Gateway address and TLS", health: "Health check", ready: "Ready", uninstall: "Remove",
  settings: "Settings", deploy: "Deploy", publish: "Publish on the gateway", image: "Load the release", checksum: "Check the release",
};
export const TIER_WORDS: Record<string, string> = { dev: "Development", qa: "Test (QA)", uat: "Acceptance (UAT)", prod: "Production" };
