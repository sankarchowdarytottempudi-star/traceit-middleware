async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  if (r.status === 401) throw Object.assign(new Error("unauthorized"), { status: 401 });
  if (!r.ok) {
    let detail = r.statusText;
    try { const p = await r.json(); detail = p.title ?? p.error ?? detail; } catch { /* ignore */ }
    throw Object.assign(new Error(detail), { status: r.status });
  }
  return (await r.json()) as T;
}

export interface Me { user: string; role: string; }
export interface PhaseStep { key: string; title: string; status: string; detail?: string; }
export interface Phase { key: string; title: string; mode: string; status: string; percent: number; steps: PhaseStep[]; }
export interface StepRef { phase?: string; phaseKey?: string; step?: string; stepKey?: string; status?: string; }
export interface Progress { overallPercent: number; majorPhase: string; majorPhaseKey?: string | null; currentStep?: StepRef | string | null; nextStep?: StepRef | string | null; done: boolean; outcome: string; }
export interface Migration { id: string; apiName?: string; workspace?: string; technology?: string; busy?: boolean; phases: Phase[]; progress: Progress; verifiedEnv?: string; }
export interface WorkspaceCfg { id?: string; name: string; servers?: Record<string, { host?: string; port?: number; username?: string } | undefined>; }
export interface Lesson { id: string; scope: string; technology?: string | null; summary: string; mistakes?: string[]; apiName?: string; workspace?: string; status?: string; createdAt?: string; phase?: string; }
export interface ProxyResult { status: number; body: string; ms: number; slo: string; }
export interface MappingRule { target: string; kind: "direct" | "expr" | "const"; source?: string; expr?: string; note?: string; }
export interface InferResult { rules: MappingRule[]; engine: string; needsModel: boolean; }

export const api = {
  me: () => j<Me>("/api/auth/me"),
  workspaces: () => j<{ workspaces: WorkspaceCfg[] }>("/api/factory/workspaces"),
  migrations: () => j<{ migrations: Migration[] }>("/api/factory/migrations"),
  migration: (id: string) => j<Migration>(`/api/factory/migrations/${id}`),
  knowledge: () => j<{ feedback: Lesson[] }>("/api/factory/knowledge"),
  proxy: (body: unknown) => j<ProxyResult>("/api/factory/proxy", { method: "POST", body: JSON.stringify(body) }),
  inferMapping: (sampleSource: unknown, desiredOutput: unknown) => j<InferResult>("/api/factory/infer-mapping", { method: "POST", body: JSON.stringify({ sampleSource, desiredOutput }) }),
};
