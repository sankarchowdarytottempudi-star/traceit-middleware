// Inventory and logs of migrated APIs read from the deployment target (another cluster); the gateway stays local.
import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createK8s, servicesCluster, type K8s, type K8sPod } from "../src/k8s.js";
import { createLogs } from "../src/logs.js";
import type { Runtime } from "../src/runtime.js";

const pod = (name: string, app: string, ns: string): K8sPod => ({ name, namespace: ns, labels: { "app.kubernetes.io/name": app }, phase: "Running", ready: true, restarts: 0, startedAt: "", podIP: "", node: "", containers: ["api"], reason: "" });
const runtime: Runtime = { configured: false, stats: async () => ({ ok: false, detail: "x" }), flows: async () => ({ ok: false, detail: "off" }), flowLogs: async () => ({ ok: false, detail: "off" }) };

describe("servicesCluster", () => {
  const local = { deployments: async () => [], pods: async () => [], services: async () => [], podLog: async () => "" } as K8s;
  it("is this server's cluster when no target is set", () => {
    expect(servicesCluster({ K8S_NAMESPACE: "" }, local)).toEqual({ k8s: local, namespace: "wso2", cluster: "local" });
    expect(servicesCluster({ K8S_NAMESPACE: "apis" }, null)).toEqual({ k8s: null, namespace: "apis", cluster: "local" });
  });
  it("is the target when TARGET_* is set, and an unusable target fails instead of showing the local cluster", async () => {
    const t = servicesCluster({ TARGET_K8S_API_URL: "https://remote:6443", TARGET_K8S_TOKEN_FILE: "/run/t", TARGET_K8S_NAMESPACE: "cs-apis" }, local);
    expect(t.cluster).toBe("target"); expect(t.namespace).toBe("cs-apis"); expect(t.k8s).not.toBe(local);
    const bad = servicesCluster({ TARGET_KUBECONFIG: "/nonexistent/kubeconfig" }, local);
    expect(bad.cluster).toBe("target");
    await expect(bad.k8s!.pods("x")).rejects.toThrow(/kubeconfig file is not readable/);
  });
});

describe("a kubeconfig target is called with its own token", () => {
  const seen: { url: string; auth?: string }[] = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url || "", auth: req.headers.authorization });
    if (req.url?.includes("/log")) { res.end("2026-11-25T10:00:00Z time=x level=INFO message=\"hello from the target\"\n"); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ items: [{ metadata: { name: "pay-api-1", namespace: "cs-apis", labels: { "app.kubernetes.io/name": "pay-api" } }, spec: { containers: [{ name: "api" }] }, status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 0 }] } }] }));
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));

  it("lists pods and reads logs of the target namespace", async () => {
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), "kc-"));
    writeFileSync(join(dir, "kubeconfig"), `apiVersion: v1\nclusters:\n- name: t\n  cluster:\n    server: http://127.0.0.1:${port}\ncontexts:\n- name: t\n  context:\n    cluster: t\n    user: u\n    namespace: cs-apis\ncurrent-context: t\nusers:\n- name: u\n  user:\n    token: target-token\n`);
    const t = servicesCluster({ TARGET_KUBECONFIG: join(dir, "kubeconfig"), K8S_NAMESPACE: "wso2" }, null);
    expect(t.namespace).toBe("cs-apis");
    const pods = await t.k8s!.pods(t.namespace);
    expect(pods.map((p) => p.name)).toEqual(["pay-api-1"]);
    expect(await t.k8s!.podLog(t.namespace, "pay-api-1", { tailLines: 5 })).toContain("hello from the target");
    expect(seen.every((s) => s.auth === "Bearer target-token")).toBe(true);
    expect(seen[0].url).toBe("/api/v1/namespaces/cs-apis/pods");
  });
  it("an unusable target is reported, never replaced", () => {
    expect(createK8s({ error: "Target cluster: x" })).not.toBeNull();
    expect(createK8s({})).toBeNull();
  });
});

describe("logs with services on the target and the gateway on this server", () => {
  const target: K8s = {
    deployments: async () => [], services: async () => [],
    pods: async (ns) => (ns === "cs-apis" ? [pod("pay-api-1", "pay-api", ns)] : []),
    podLog: async (ns, p) => { if (ns !== "cs-apis") throw new Error("HTTP 404"); return `2026-11-25T10:00:02Z time=x level=INFO message="paid" pod=${p}\n`; },
  };
  const local: K8s = {
    deployments: async () => [], services: async () => [],
    pods: async (ns) => (ns === "apim" ? [pod("wso2am-1", "gw", ns)] : ns === "cs-apis" ? [] : [pod("old-local-1", "pay-api", ns)]),
    podLog: async (ns) => { if (ns !== "apim") throw new Error("the local cluster was asked for a service log"); return "2026-11-25T10:00:01Z [2026-11-25 10:00:01,000]  INFO {g.H} - routed\n"; },
  };
  const logs = createLogs({ k8s: target, gwK8s: local, runtime, servicesNs: "cs-apis", gatewayNs: "apim", gatewayPodPrefix: "wso2am" });

  it("reads a service from the target and the gateway from this server, in one timeline", async () => {
    const r = await logs.read({ sources: ["svc:pay-api", "gw"] });
    expect(r.sources.map((s) => [s.id, s.replicas, s.error])).toEqual([["svc:pay-api", ["pay-api-1"], undefined], ["gw", ["wso2am-1"], undefined]]);
    expect(r.lines.map((l) => l.pod)).toEqual(["wso2am-1", "pay-api-1"]);
  });
  it("lists the gateway from this server and the services from the target", async () => {
    const s = await logs.sources([{ name: "pay-api", kind: "service" }]);
    expect(s.list.slice(0, 2)).toEqual([{ id: "gw", label: "Gateway", kind: "gateway", replicas: 1 }, { id: "svc:pay-api", label: "pay-api", kind: "service", replicas: 1 }]);
  });
  it("keeps one cluster for both when no gateway cluster is given (today's behaviour)", async () => {
    const one = createLogs({ k8s: local, runtime, servicesNs: "wso2", gatewayNs: "apim", gatewayPodPrefix: "wso2am" });
    const r = await one.read({ sources: ["gw"] });
    expect(r.sources[0].replicas).toEqual(["wso2am-1"]);
  });
});
