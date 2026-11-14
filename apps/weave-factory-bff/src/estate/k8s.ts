// Read-only view of the cluster through the Kubernetes API (service-account token + CA from
// files). Only get/list on deployments, services, pods and pod logs; nothing is ever changed.
import https from "node:https";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

export interface K8sOptions { apiUrl?: string; tokenFile?: string; caFile?: string; namespace: string; }
export interface K8sDeployment {
  name: string; labels: Record<string, string>; selector: Record<string, string>;
  replicas: number; ready: number; updated: number; images: string[]; createdAt?: string; lastDeployedAt?: string;
}
export interface K8sService { name: string; type: string; selector: Record<string, string>; ports: { name?: string; port: number; nodePort?: number; targetPort?: string | number }[]; }
export interface K8sPod { name: string; labels: Record<string, string>; phase: string; ready: boolean; restarts: number; startedAt?: string; containers: string[]; }
export interface LogLine { at?: string; level?: string; text: string; pod?: string; }

const CACHE_MS = 10_000;

export class K8s {
  private cache = new Map<string, { at: number; value: unknown }>();
  constructor(private o: K8sOptions) {}
  get namespace(): string { return this.o.namespace; }
  get configured(): boolean { return !!(this.o.apiUrl && this.o.tokenFile); }

  private get(path: string, timeoutMs = 8000): Promise<{ status: number; text: string }> {
    if (!this.configured) return Promise.reject(new Error("Cluster access is not configured"));
    const u = new URL(this.o.apiUrl + path);
    let token = "", ca: string | undefined;
    try { token = readFileSync(this.o.tokenFile!, "utf8").trim(); } catch { return Promise.reject(new Error("Cluster token file is not readable")); }
    try { ca = this.o.caFile ? readFileSync(this.o.caFile, "utf8") : undefined; } catch { ca = undefined; }
    return new Promise((resolve, reject) => {
      const req = https.request({
        method: "GET", hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json, */*" }, ca, timeout: timeoutMs,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("timeout", () => req.destroy(new Error("The cluster did not answer in time")));
      req.on("error", reject);
      req.end();
    });
  }
  private async list<T>(key: string, path: string, map: (item: any) => T): Promise<T[]> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T[];
    const r = await this.get(path);
    if (r.status >= 400) throw new Error(`Cluster answered ${r.status} for ${key}`);
    const items = ((JSON.parse(r.text) as { items?: unknown[] }).items || []).map(map);
    this.cache.set(key, { at: Date.now(), value: items });
    return items;
  }

  deployments(): Promise<K8sDeployment[]> {
    return this.list("deployments", `/apis/apps/v1/namespaces/${this.o.namespace}/deployments`, (d) => {
      const conds = (d.status?.conditions || []) as { type: string; lastUpdateTime?: string }[];
      const prog = conds.find((c) => c.type === "Progressing");
      return {
        name: d.metadata.name, labels: d.metadata.labels || {}, selector: d.spec?.selector?.matchLabels || {},
        replicas: d.spec?.replicas ?? 0, ready: d.status?.readyReplicas ?? 0, updated: d.status?.updatedReplicas ?? 0,
        images: ((d.spec?.template?.spec?.containers || []) as { image?: string }[]).map((c) => (c.image || "").replace(/^.*\//, "")),
        createdAt: d.metadata.creationTimestamp, lastDeployedAt: prog?.lastUpdateTime || d.metadata.creationTimestamp,
      };
    });
  }
  services(): Promise<K8sService[]> {
    return this.list("services", `/api/v1/namespaces/${this.o.namespace}/services`, (s) => ({
      name: s.metadata.name, type: s.spec?.type || "ClusterIP", selector: s.spec?.selector || {},
      ports: ((s.spec?.ports || []) as any[]).map((p) => ({ name: p.name, port: p.port, nodePort: p.nodePort, targetPort: p.targetPort })),
    }));
  }
  pods(): Promise<K8sPod[]> {
    return this.list("pods", `/api/v1/namespaces/${this.o.namespace}/pods`, (p) => {
      const cs = (p.status?.containerStatuses || []) as { ready?: boolean; restartCount?: number }[];
      return {
        name: p.metadata.name, labels: p.metadata.labels || {}, phase: p.metadata.deletionTimestamp ? "Terminating" : p.status?.phase || "Unknown",
        ready: cs.length > 0 && cs.every((c) => c.ready), restarts: cs.reduce((n, c) => n + (c.restartCount || 0), 0),
        startedAt: p.status?.startTime, containers: ((p.spec?.containers || []) as { name: string }[]).map((c) => c.name),
      };
    });
  }
  async podsOf(dep: K8sDeployment): Promise<K8sPod[]> {
    const sel = Object.entries(dep.selector);
    if (!sel.length) return [];
    return (await this.pods()).filter((p) => sel.every(([k, v]) => p.labels[k] === v));
  }
  async logs(pod: string, tail: number): Promise<LogLine[]> {
    const r = await this.get(`/api/v1/namespaces/${this.o.namespace}/pods/${encodeURIComponent(pod)}/log?tailLines=${tail}&timestamps=true`, 15000);
    if (r.status >= 400) throw new Error(`Logs of ${pod} are not available (${r.status})`);
    return parseLogs(r.text, pod);
  }
}

const LEVELS: Record<string, string> = { error: "error", err: "error", fatal: "error", severe: "error", warn: "warn", warning: "warn", info: "info", debug: "debug", trace: "debug" };

/** Credentials that may appear in a log line are blanked before it is shown. */
export function maskLog(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 ***")
    .replace(/((?:authorization|pass(?:word|wd)?|secret|token|api[-_]?key|client[-_]?secret|x-admin-key)[\w-]*["']?\s*[:=]\s*["']?)(?!\*\*\*)[^\s"',;&}]{3,}/gi, "$1***")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s"']+:[^/@\s"']+@/gi, "$1***@");
}

function isoUtc(stamp: string): string {
  const d = new Date(stamp.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(d.getTime()) ? stamp : d.toISOString();
}

export function parseLogs(raw: string, pod?: string): LogLine[] {
  const out: LogLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))\s?(.*)$/.exec(line);
    const text = maskLog(m ? m[2] : line);
    const lv = /\blevel\s*=\s*"?(\w+)/i.exec(text) || /"level"\s*:\s*"(\w+)"/i.exec(text) || /^\s*(error|warn(?:ing)?|info|debug)\s*:/i.exec(text) || /\b(ERROR|WARN(?:ING)?|INFO|DEBUG|FATAL|SEVERE)\b/.exec(text);
    const level = lv ? LEVELS[lv[1].toLowerCase()] : /\b(exception|panic|stack ?trace)\b|^\s+at\s/i.test(text) ? "error" : undefined;
    // continuation lines of a stack trace belong to the line before them
    if (!m && out.length && /^\s+/.test(line)) { out[out.length - 1].text += "\n" + text; continue; }
    out.push({ at: m ? isoUtc(m[1]) : undefined, level, text, pod });
  }
  return out;
}

/** Merge lines of several replicas in time order and keep the newest `tail`. */
export function mergeLogs(sets: LogLine[][], tail: number, q?: string, level?: string): LogLine[] {
  let all = sets.flat();
  all.sort((a, b) => (a.at || "").localeCompare(b.at || ""));
  if (q) { const needle = q.toLowerCase(); all = all.filter((l) => l.text.toLowerCase().includes(needle)); }
  if (level) all = all.filter((l) => l.level === level);
  return all.slice(-tail);
}
