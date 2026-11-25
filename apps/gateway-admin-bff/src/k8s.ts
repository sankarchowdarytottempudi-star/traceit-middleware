// Read-only Kubernetes client (service account token + cluster CA from files).
// Used for service discovery, health/replicas and pod logs. It never writes to the cluster.
import { readFileSync } from "node:fs";
import { httpJson, httpRequest } from "./http.js";
import { authOf, targetFromEnv, type KubeAccess, type TargetEnv } from "./kubeconfig.js";

export interface K8sConfig {
  apiUrl: string; tokenFile: string; caFile: string;
  /** Another cluster (kubeconfig.ts): used instead of apiUrl/tokenFile/caFile. */
  access?: KubeAccess;
  /** Configured but not usable (e.g. an unreadable kubeconfig): every call fails with this. */
  error?: string;
}

export interface K8sDeployment {
  name: string; namespace: string; labels: Record<string, string>;
  selector: Record<string, string>;
  desired: number; ready: number; available: number; updated: number;
  containers: { name: string; image: string; ports: { name?: string; containerPort: number }[] }[];
  createdAt: string;
}
export interface K8sPod {
  name: string; namespace: string; labels: Record<string, string>;
  phase: string; ready: boolean; restarts: number; startedAt: string; podIP: string; node: string;
  containers: string[]; reason: string;
}
export interface K8sService {
  name: string; namespace: string; type: string; clusterIP: string; selector: Record<string, string>;
  ports: { name?: string; port: number; targetPort?: number | string; nodePort?: number }[];
}
export interface PodLogOpts { container?: string; tailLines?: number; sinceSeconds?: number; limitBytes?: number; }

export interface K8s {
  deployments(ns: string): Promise<K8sDeployment[]>;
  pods(ns: string): Promise<K8sPod[]>;
  services(ns: string): Promise<K8sService[]>;
  podLog(ns: string, pod: string, o?: PodLogOpts): Promise<string>;
}

export function mapDeployment(d: any): K8sDeployment {
  const tpl = d?.spec?.template?.spec ?? {};
  return {
    name: d?.metadata?.name ?? "", namespace: d?.metadata?.namespace ?? "",
    labels: d?.metadata?.labels ?? {}, selector: d?.spec?.selector?.matchLabels ?? {},
    desired: Number(d?.spec?.replicas ?? 0), ready: Number(d?.status?.readyReplicas ?? 0),
    available: Number(d?.status?.availableReplicas ?? 0), updated: Number(d?.status?.updatedReplicas ?? 0),
    containers: (tpl.containers ?? []).map((c: any) => ({ name: c.name, image: c.image ?? "",
      ports: (c.ports ?? []).map((p: any) => ({ name: p.name, containerPort: Number(p.containerPort) })) })),
    createdAt: d?.metadata?.creationTimestamp ?? "",
  };
}
export function mapPod(p: any): K8sPod {
  const cs: any[] = p?.status?.containerStatuses ?? [];
  const waiting = cs.map((c) => c?.state?.waiting?.reason).find(Boolean);
  return {
    name: p?.metadata?.name ?? "", namespace: p?.metadata?.namespace ?? "", labels: p?.metadata?.labels ?? {},
    phase: p?.metadata?.deletionTimestamp ? "Terminating" : (p?.status?.phase ?? "Unknown"),
    ready: cs.length > 0 && cs.every((c) => c.ready === true),
    restarts: cs.reduce((n, c) => n + Number(c.restartCount ?? 0), 0),
    startedAt: p?.status?.startTime ?? "", podIP: p?.status?.podIP ?? "", node: p?.spec?.nodeName ?? "",
    containers: (p?.spec?.containers ?? []).map((c: any) => c.name), reason: waiting ?? p?.status?.reason ?? "",
  };
}
export function mapService(s: any): K8sService {
  return {
    name: s?.metadata?.name ?? "", namespace: s?.metadata?.namespace ?? "", type: s?.spec?.type ?? "ClusterIP",
    clusterIP: s?.spec?.clusterIP ?? "", selector: s?.spec?.selector ?? {},
    ports: (s?.spec?.ports ?? []).map((p: any) => ({ name: p.name, port: Number(p.port), targetPort: p.targetPort, nodePort: p.nodePort })),
  };
}
/** True when every selector label is present on the labels with the same value. */
export function selects(selector: Record<string, string>, labels: Record<string, string>): boolean {
  const keys = Object.keys(selector);
  return keys.length > 0 && keys.every((k) => labels[k] === selector[k]);
}

export function createK8s(cfg: Partial<K8sConfig>): K8s | null {
  if (cfg.error) {
    const fail = async (): Promise<never> => { throw new Error(cfg.error); };
    return { deployments: fail, pods: fail, services: fail, podLog: fail };
  }
  if (!cfg.access && (!cfg.apiUrl || !cfg.tokenFile)) return null;
  const base = (cfg.access?.apiUrl ?? cfg.apiUrl!).replace(/\/+$/, "");
  const auth = () => {
    if (cfg.access) {
      const a = authOf(cfg.access);
      return { headers: { ...a.headers, Accept: "application/json" }, ...a.tls };
    }
    // Re-read on every call: projected tokens rotate.
    const token = readFileSync(cfg.tokenFile!, "utf8").trim();
    let ca: string | undefined;
    try { ca = cfg.caFile ? readFileSync(cfg.caFile, "utf8") : undefined; } catch { ca = undefined; }
    return { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } as Record<string, string>, ca };
  };
  const list = async (path: string) => (await httpJson<any>(base + path, { ...auth(), timeoutMs: 8000 }))?.items ?? [];
  const ns = (n: string) => encodeURIComponent(n);
  return {
    deployments: async (n) => (await list(`/apis/apps/v1/namespaces/${ns(n)}/deployments`)).map(mapDeployment),
    pods: async (n) => (await list(`/api/v1/namespaces/${ns(n)}/pods`)).map(mapPod),
    services: async (n) => (await list(`/api/v1/namespaces/${ns(n)}/services`)).map(mapService),
    async podLog(n, pod, o = {}) {
      const q = new URLSearchParams({ timestamps: "true" });
      if (o.container) q.set("container", o.container);
      if (o.tailLines) q.set("tailLines", String(o.tailLines));
      if (o.sinceSeconds) q.set("sinceSeconds", String(o.sinceSeconds));
      const limit = o.limitBytes ?? 4 * 1024 * 1024;
      q.set("limitBytes", String(limit));
      const a = auth();
      const r = await httpRequest(`${base}/api/v1/namespaces/${ns(n)}/pods/${encodeURIComponent(pod)}/log?${q}`,
        { ...a, headers: { ...a.headers, Accept: "*/*" }, timeoutMs: 15_000, maxBytes: limit + 65536 });
      if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      return r.text;
    },
  };
}

/** Where the migrated APIs run: the deployment target (TARGET_*) when one is set, else this server's
 * cluster. The gateway itself always stays on this server's cluster. */
export function servicesCluster(cfg: { K8S_API_URL?: string; K8S_TOKEN_FILE?: string; K8S_CA_FILE?: string; K8S_NAMESPACE?: string } & TargetEnv, local: K8s | null):
  { k8s: K8s | null; namespace: string; cluster: "local" | "target" } {
  const t = targetFromEnv(cfg);
  if (!t) return { k8s: local, namespace: cfg.K8S_NAMESPACE || "wso2", cluster: "local" };
  return { k8s: createK8s({ access: t.access, error: t.error }), namespace: t.namespace || cfg.K8S_NAMESPACE || "wso2", cluster: "target" };
}
