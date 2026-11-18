// On/off switch for a running API, used from its card on the Flows page.
//
// A migrated service is a Deployment in the `wso2` namespace. Stop remembers what is needed to
// bring it back in annotations on the Deployment itself (so a lost Factory data dir loses nothing),
// removes its autoscaler if it has one (an autoscaler would scale it straight back up and cannot be
// set to 0), then scales it to 0. Start scales it back to the remembered count (1 when nothing was
// remembered, e.g. it was stopped with kubectl), recreates the autoscaler exactly as it was and
// clears the annotations. The state is always read live from the cluster.
// Nothing outside the namespace and none of the shared infrastructure can be switched.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const POWER_NAMESPACE = "wso2";
/** Shared infrastructure that every service depends on: never switched from the Factory. */
export const PROTECTED = new Set(["intg-postgres", "intg-redis"]);
export const ANN = {
  replicas: "weave.traceit/stopped-replicas",
  hpa: "weave.traceit/stopped-hpa",
  by: "weave.traceit/stopped-by",
  at: "weave.traceit/stopped-at",
} as const;

export interface DeploymentObj {
  metadata: { name: string; namespace?: string; annotations?: Record<string, string> };
  spec?: { replicas?: number };
  status?: { replicas?: number; readyReplicas?: number };
}
export interface HpaObj {
  apiVersion?: string; kind?: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string>; [k: string]: unknown };
  spec: { scaleTargetRef: { kind: string; name: string; apiVersion?: string }; minReplicas?: number; maxReplicas: number; [k: string]: unknown };
  status?: unknown;
}

/** The cluster calls the switch makes. The real one is `kubeApiOf(k8s)`; tests use a stand-in. */
export interface KubeApi {
  listDeployments(ns: string): Promise<DeploymentObj[]>;
  getDeployment(ns: string, name: string): Promise<DeploymentObj | null>;
  /** Sets (string) or removes (null) annotations on the Deployment; never touches its pod template. */
  annotate(ns: string, name: string, annotations: Record<string, string | null>): Promise<void>;
  scale(ns: string, name: string, replicas: number): Promise<void>;
  listHpas(ns: string): Promise<HpaObj[]>;
  createHpa(ns: string, hpa: HpaObj): Promise<void>;
  deleteHpa(ns: string, name: string): Promise<void>;
}

export type PowerState = "on" | "off" | "starting" | "stopping";
export interface AuditRecord {
  at: string; by: string; kind: "service" | "flow"; target: string; action: "stop" | "start";
  from: string; to: string; ok: boolean; error?: string; detail?: Record<string, unknown>;
}
export interface ServicePower {
  name: string; state: PowerState; ready: number; wanted: number; current: number;
  /** How many copies Start will ask for. */
  startsWith: number;
  autoscaler?: { min: number; max: number; stored: boolean };
  protected: boolean;
  stoppedBy?: string; stoppedAt?: string;
  /** Off, and the Factory did not stop it (kubectl or another tool). */
  stoppedOutside?: boolean;
  last?: AuditRecord;
}

export class PowerError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export function stateOf(d: DeploymentObj): PowerState {
  const wanted = d.spec?.replicas ?? 0, ready = d.status?.readyReplicas ?? 0, current = d.status?.replicas ?? 0;
  if (wanted === 0) return current > 0 ? "stopping" : "off";
  return ready >= wanted ? "on" : "starting";
}

/** Why a service may not be switched, or null when it may. */
export function refusal(ns: string, name: string): string | null {
  if (ns !== POWER_NAMESPACE) return `Only services in the ${POWER_NAMESPACE} namespace can be switched on or off here.`;
  if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(name)) return "This is not a service name.";
  if (PROTECTED.has(name)) return `${name} is shared infrastructure that other services need; it cannot be switched off from here.`;
  return null;
}

export const hpaFor = (hpas: HpaObj[], name: string): HpaObj | undefined =>
  hpas.find((h) => h.spec?.scaleTargetRef?.kind === "Deployment" && h.spec.scaleTargetRef.name === name);

/** The autoscaler as it can be created again: its name, labels, annotations and spec, nothing the cluster adds. */
export function storableHpa(h: HpaObj): HpaObj {
  const metadata: HpaObj["metadata"] = { name: h.metadata.name };
  if (h.metadata.labels && Object.keys(h.metadata.labels).length) metadata.labels = { ...h.metadata.labels };
  if (h.metadata.annotations && Object.keys(h.metadata.annotations).length) metadata.annotations = { ...h.metadata.annotations };
  return { apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", metadata, spec: JSON.parse(JSON.stringify(h.spec)) };
}

export function parseStoredHpa(text: string | undefined, name: string): HpaObj | undefined {
  if (!text) return undefined;
  try {
    const h = JSON.parse(text) as HpaObj;
    const ok = h && h.metadata && typeof h.metadata.name === "string" && h.spec && h.spec.scaleTargetRef?.name === name && typeof h.spec.maxReplicas === "number";
    return ok ? h : undefined;
  } catch { return undefined; }
}

/** Copies Start asks for: the remembered count (1 when none), kept inside the autoscaler's range. */
export function startCount(annotations: Record<string, string>, hpa?: HpaObj): number {
  const n = parseInt(annotations[ANN.replicas] ?? "", 10);
  let replicas = Number.isFinite(n) && n >= 1 ? Math.min(n, 50) : 1;
  if (hpa) replicas = Math.min(Math.max(replicas, hpa.spec.minReplicas ?? 1), hpa.spec.maxReplicas);
  return replicas;
}

const copies = (n: number) => `${n} cop${n === 1 ? "y" : "ies"}`;

// ---- audit: one JSON object per line in the Factory data dir
export class AuditLog {
  constructor(private file: string) {}
  get path(): string { return this.file; }
  append(r: AuditRecord): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(r) + "\n", { mode: 0o600 });
  }
  all(limit = 5000): AuditRecord[] {
    if (!existsSync(this.file)) return [];
    const out: AuditRecord[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n").slice(-limit)) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line) as AuditRecord; if (r && r.target && r.action) out.push(r); } catch { /* a torn line is skipped */ }
    }
    return out;
  }
  /** The newest successful record per `kind:target`. */
  latest(): Map<string, AuditRecord> {
    const m = new Map<string, AuditRecord>();
    for (const r of this.all()) if (r.ok) m.set(`${r.kind}:${r.target}`, r);
    return m;
  }
}

export interface PowerOptions { kube: KubeApi; namespace: string; audit: AuditLog; now?: () => Date }

export class Power {
  constructor(private o: PowerOptions) {}
  private now(): string { return (this.o.now ? this.o.now() : new Date()).toISOString(); }

  private view(d: DeploymentObj, hpas: HpaObj[], last?: AuditRecord): ServicePower {
    const ann = d.metadata.annotations || {};
    const name = d.metadata.name;
    const live = hpaFor(hpas, name);
    const stored = parseStoredHpa(ann[ANN.hpa], name);
    const h = live || stored;
    const state = stateOf(d);
    const v: ServicePower = {
      name, state, ready: d.status?.readyReplicas ?? 0, wanted: d.spec?.replicas ?? 0, current: d.status?.replicas ?? 0,
      startsWith: startCount(ann, stored), protected: !!refusal(this.o.namespace, name),
      ...(h ? { autoscaler: { min: h.spec.minReplicas ?? 1, max: h.spec.maxReplicas, stored: !live } } : {}),
    };
    if (state === "off" || state === "stopping") {
      if (ann[ANN.by]) { v.stoppedBy = ann[ANN.by]; v.stoppedAt = ann[ANN.at]; }
      else v.stoppedOutside = true;
    }
    if (last) v.last = last;
    return v;
  }

  async services(): Promise<ServicePower[]> {
    const ns = this.o.namespace;
    const [deps, hpas] = await Promise.all([this.o.kube.listDeployments(ns), this.o.kube.listHpas(ns).catch(() => [] as HpaObj[])]);
    const latest = this.o.audit.latest();
    return deps.map((d) => this.view(d, hpas, latest.get(`service:${d.metadata.name}`))).sort((a, b) => a.name.localeCompare(b.name));
  }

  async service(name: string): Promise<ServicePower | null> {
    const ns = this.o.namespace;
    const d = await this.o.kube.getDeployment(ns, name);
    if (!d) return null;
    const hpas = await this.o.kube.listHpas(ns).catch(() => [] as HpaObj[]);
    return this.view(d, hpas, this.o.audit.latest().get(`service:${name}`));
  }

  private async target(name: string): Promise<DeploymentObj> {
    const why = refusal(this.o.namespace, name);
    if (why) throw new PowerError(403, why);
    const d = await this.o.kube.getDeployment(this.o.namespace, name);
    if (!d) throw new PowerError(404, `There is no service called ${name}.`);
    return d;
  }

  private record(r: Omit<AuditRecord, "at" | "kind">): AuditRecord {
    const rec: AuditRecord = { at: this.now(), kind: "service", ...r };
    this.o.audit.append(rec);
    return rec;
  }

  async stop(name: string, by: string): Promise<ServicePower> {
    const ns = this.o.namespace;
    const d = await this.target(name);
    const ann = d.metadata.annotations || {};
    const wanted = d.spec?.replicas ?? 0, ready = d.status?.readyReplicas ?? 0;
    const hpa = hpaFor(await this.o.kube.listHpas(ns), name);
    if (wanted === 0 && !hpa) return (await this.service(name))!; // already off: nothing to change, nothing to record
    const from = `${copies(wanted)} wanted, ${ready} running${hpa ? ` (autoscaler ${hpa.spec.minReplicas ?? 1}-${hpa.spec.maxReplicas})` : ""}`;
    // Remembered first, on the Deployment itself: if a later step fails, nothing is lost and Start still works.
    const remember: Record<string, string> = { [ANN.by]: by, [ANN.at]: this.now() };
    if (wanted > 0) remember[ANN.replicas] = String(wanted);
    else if (!ann[ANN.replicas]) remember[ANN.replicas] = String(hpa?.spec.minReplicas ?? 1);
    if (hpa) remember[ANN.hpa] = JSON.stringify(storableHpa(hpa));
    try {
      await this.o.kube.annotate(ns, name, remember);
      if (hpa) await this.o.kube.deleteHpa(ns, hpa.metadata.name);
      await this.o.kube.scale(ns, name, 0);
    } catch (e) {
      const msg = clusterMessage(e);
      this.record({ by, target: name, action: "stop", from, to: "0 copies", ok: false, error: msg });
      throw new PowerError(502, `${name} was not stopped: ${msg}`);
    }
    this.record({ by, target: name, action: "stop", from, to: "0 copies", ok: true, detail: { replicas: wanted, ...(hpa ? { autoscaler: { min: hpa.spec.minReplicas ?? 1, max: hpa.spec.maxReplicas } } : {}) } });
    return (await this.service(name))!;
  }

  async start(name: string, by: string): Promise<ServicePower> {
    const ns = this.o.namespace;
    const d = await this.target(name);
    const ann = d.metadata.annotations || {};
    const wanted = d.spec?.replicas ?? 0;
    const stored = parseStoredHpa(ann[ANN.hpa], name);
    const remembered = Object.values(ANN).some((k) => k in ann);
    if (wanted > 0 && !remembered) return (await this.service(name))!; // already on
    const replicas = startCount(ann, stored);
    const to = `${copies(wanted > 0 ? wanted : replicas)}${stored ? ` (autoscaler ${stored.spec.minReplicas ?? 1}-${stored.spec.maxReplicas})` : ""}`;
    try {
      if (wanted === 0) await this.o.kube.scale(ns, name, replicas);
      if (stored && !hpaFor(await this.o.kube.listHpas(ns), name)) await this.o.kube.createHpa(ns, stored);
      // Cleared last: if the autoscaler could not be created, its stored copy stays for the next try.
      await this.o.kube.annotate(ns, name, Object.fromEntries(Object.values(ANN).map((k) => [k, null])));
    } catch (e) {
      const msg = clusterMessage(e);
      this.record({ by, target: name, action: "start", from: `${copies(wanted)} wanted`, to, ok: false, error: msg });
      throw new PowerError(502, `${name} was not started: ${msg}`);
    }
    this.record({ by, target: name, action: "start", from: `${copies(wanted)} wanted`, to, ok: true, detail: { replicas: wanted > 0 ? wanted : replicas, ...(stored ? { autoscalerRestored: true } : {}) } });
    return (await this.service(name))!;
  }
}

function clusterMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /\b403\b/.test(m) ? "the Factory is not allowed to change this in the cluster (403)" : m.slice(0, 300);
}

// ---- the real cluster
interface Sender { send(method: string, path: string, body?: unknown, contentType?: string): Promise<{ status: number; text: string }>; forget?(): void }

export function kubeApiOf(k: Sender): KubeApi {
  const dep = (ns: string, name = "") => `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments${name ? "/" + encodeURIComponent(name) : ""}`;
  const hpa = (ns: string, name = "") => `/apis/autoscaling/v2/namespaces/${encodeURIComponent(ns)}/horizontalpodautoscalers${name ? "/" + encodeURIComponent(name) : ""}`;
  const ok = async (what: string, p: Promise<{ status: number; text: string }>) => {
    const r = await p;
    if (r.status >= 400) {
      let reason = "";
      try { reason = (JSON.parse(r.text) as { reason?: string }).reason || ""; } catch { /* not JSON */ }
      throw new Error(`the cluster answered ${r.status}${reason ? ` ${reason}` : ""} to ${what}`);
    }
    k.forget?.();
    return r;
  };
  const items = async <T>(what: string, path: string) => (JSON.parse((await ok(what, k.send("GET", path))).text) as { items?: T[] }).items || [];
  return {
    listDeployments: (ns) => items<DeploymentObj>("listing the services", dep(ns)),
    async getDeployment(ns, name) {
      const r = await k.send("GET", dep(ns, name));
      if (r.status === 404) return null;
      if (r.status >= 400) throw new Error(`the cluster answered ${r.status} to reading ${name}`);
      return JSON.parse(r.text) as DeploymentObj;
    },
    async annotate(ns, name, annotations) { await ok(`annotating ${name}`, k.send("PATCH", dep(ns, name), { metadata: { annotations } }, "application/merge-patch+json")); },
    async scale(ns, name, replicas) { await ok(`scaling ${name}`, k.send("PATCH", dep(ns, name) + "/scale", { spec: { replicas } }, "application/merge-patch+json")); },
    listHpas: (ns) => items<HpaObj>("listing the autoscalers", hpa(ns)),
    async createHpa(ns, h) { await ok(`creating the autoscaler ${h.metadata.name}`, k.send("POST", hpa(ns), h)); },
    async deleteHpa(ns, name) { await ok(`removing the autoscaler ${name}`, k.send("DELETE", hpa(ns, name))); },
  };
}
