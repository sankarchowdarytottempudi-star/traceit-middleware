// The on/off switch of a running API, against a stand-in of the Kubernetes API: no real service is touched.
import { describe, it, expect, beforeEach, vi } from "vitest";
// The first Fastify app of a run can take seconds to start on a busy server.
vi.setConfig({ testTimeout: 20_000 });
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { ANN, AuditLog, Power, PowerError, kubeApiOf, refusal, startCount, stateOf, type DeploymentObj, type HpaObj, type KubeApi } from "../src/estate/power";
import { registerPower, flowPowers } from "../src/estate/powerRoutes";

/** In-memory cluster: deployments and autoscalers of one namespace; every call is logged. */
class FakeKube implements KubeApi {
  deps = new Map<string, DeploymentObj>();
  hpas = new Map<string, HpaObj>();
  calls: string[] = [];
  failOn?: string;
  constructor(public ns = "wso2") {}
  add(name: string, replicas: number, ready = replicas, annotations: Record<string, string> = {}) {
    this.deps.set(name, { metadata: { name, namespace: this.ns, annotations: { "meta.helm.sh/release-name": name, ...annotations } }, spec: { replicas }, status: { replicas: ready, readyReplicas: ready } });
  }
  private check(what: string) { this.calls.push(what); if (this.failOn && what.startsWith(this.failOn)) throw new Error("the cluster answered 403 Forbidden to " + what); }
  async listDeployments(ns: string) { this.check(`list ${ns}`); return ns === this.ns ? [...this.deps.values()].map((d) => structuredClone(d)) : []; }
  async getDeployment(ns: string, name: string) { this.check(`get ${ns}/${name}`); const d = ns === this.ns ? this.deps.get(name) : undefined; return d ? structuredClone(d) : null; }
  async annotate(ns: string, name: string, a: Record<string, string | null>) {
    this.check(`annotate ${ns}/${name}`);
    const d = this.deps.get(name)!; const cur = { ...(d.metadata.annotations || {}) };
    for (const [k, v] of Object.entries(a)) { if (v === null) delete cur[k]; else cur[k] = v; }
    d.metadata.annotations = cur;
  }
  async scale(ns: string, name: string, replicas: number) { this.check(`scale ${ns}/${name} ${replicas}`); const d = this.deps.get(name)!; d.spec = { replicas }; d.status = { replicas: 0, readyReplicas: 0 }; }
  async listHpas(ns: string) { this.check(`list-hpa ${ns}`); return ns === this.ns ? [...this.hpas.values()].map((h) => structuredClone(h)) : []; }
  async createHpa(ns: string, h: HpaObj) { this.check(`create-hpa ${ns}/${h.metadata.name}`); this.hpas.set(h.metadata.name, structuredClone(h)); }
  async deleteHpa(ns: string, name: string) { this.check(`delete-hpa ${ns}/${name}`); this.hpas.delete(name); }
}

const cmsHpa = (): HpaObj => ({
  apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler",
  metadata: { name: "cms-proc-api", namespace: "wso2", labels: { app: "cms-proc-api" }, annotations: { "meta.helm.sh/release-name": "cms-proc-api" }, uid: "u-1", resourceVersion: "99", creationTimestamp: "2026-11-16T00:00:00Z" },
  spec: { scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "cms-proc-api" }, minReplicas: 2, maxReplicas: 2, metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } }] },
  status: { currentReplicas: 2 },
});

let kube: FakeKube, dir: string, audit: AuditLog, power: Power;
const NOW = new Date("2026-11-18T11:00:00Z");
beforeEach(() => {
  kube = new FakeKube();
  dir = mkdtempSync(join(tmpdir(), "power-"));
  audit = new AuditLog(join(dir, "power-audit.jsonl"));
  power = new Power({ kube, namespace: "wso2", audit, now: () => NOW });
});

describe("state read from the cluster", () => {
  it("names on, off, starting and stopping from wanted / running copies", () => {
    expect(stateOf({ metadata: { name: "a" }, spec: { replicas: 2 }, status: { replicas: 2, readyReplicas: 2 } })).toBe("on");
    expect(stateOf({ metadata: { name: "a" }, spec: { replicas: 2 }, status: { replicas: 1, readyReplicas: 1 } })).toBe("starting");
    expect(stateOf({ metadata: { name: "a" }, spec: { replicas: 0 }, status: { replicas: 1, readyReplicas: 1 } })).toBe("stopping");
    expect(stateOf({ metadata: { name: "a" }, spec: { replicas: 0 }, status: {} })).toBe("off");
  });
  it("shows a service stopped with kubectl (no annotations) as off, stopped outside the Factory, starting with 1", async () => {
    kube.add("batch", 0, 0);
    const [v] = await power.services();
    expect(v).toMatchObject({ name: "batch", state: "off", wanted: 0, startsWith: 1, stoppedOutside: true, protected: false });
  });
});

describe("scale logic", () => {
  it("stop remembers the copies, then scales to 0, and start brings the same count back", async () => {
    kube.add("seaware-sys-api", 3);
    const off = await power.stop("seaware-sys-api", "owner@x");
    expect(kube.calls.filter((c) => !c.startsWith("get") && !c.startsWith("list"))).toEqual(["annotate wso2/seaware-sys-api", "scale wso2/seaware-sys-api 0"]);
    const ann = kube.deps.get("seaware-sys-api")!.metadata.annotations!;
    expect(ann[ANN.replicas]).toBe("3");
    expect(ann[ANN.by]).toBe("owner@x");
    expect(ann["meta.helm.sh/release-name"]).toBe("seaware-sys-api");
    expect(off).toMatchObject({ state: "off", wanted: 0, startsWith: 3, stoppedBy: "owner@x" });

    kube.calls = [];
    const on = await power.start("seaware-sys-api", "owner@x");
    expect(kube.calls).toContain("scale wso2/seaware-sys-api 3");
    expect(on.wanted).toBe(3);
    const after = kube.deps.get("seaware-sys-api")!.metadata.annotations!;
    expect(Object.keys(after).filter((k) => k.startsWith("weave.traceit/"))).toEqual([]);
    expect(after["meta.helm.sh/release-name"]).toBe("seaware-sys-api");
  });
  it("start of a service scaled to 0 by hand asks for 1 copy", async () => {
    kube.add("otalio-batch-proc-api", 0, 0);
    const on = await power.start("otalio-batch-proc-api", "owner");
    expect(kube.calls).toContain("scale wso2/otalio-batch-proc-api 1");
    expect(on.wanted).toBe(1);
  });
  it("does nothing (and records nothing) when it is already in the asked state", async () => {
    kube.add("zoho-sys-api", 1); kube.add("batch", 0, 0);
    await power.start("zoho-sys-api", "owner");
    await power.stop("batch", "owner");
    expect(kube.calls.some((c) => /^(scale|annotate)/.test(c))).toBe(false);
    expect(audit.all()).toEqual([]);
  });
  it("startCount keeps a remembered count, falls back to 1 and stays inside the autoscaler range", () => {
    expect(startCount({})).toBe(1);
    expect(startCount({ [ANN.replicas]: "x" })).toBe(1);
    expect(startCount({ [ANN.replicas]: "4" })).toBe(4);
    expect(startCount({ [ANN.replicas]: "1" }, cmsHpa())).toBe(2);
    expect(startCount({ [ANN.replicas]: "9" }, cmsHpa())).toBe(2);
  });
  it("a failed step is reported and audited, and what was remembered stays", async () => {
    kube.add("email-sys-api", 2);
    kube.failOn = "scale";
    await expect(power.stop("email-sys-api", "owner")).rejects.toThrow(/not allowed .*403/);
    expect(kube.deps.get("email-sys-api")!.metadata.annotations![ANN.replicas]).toBe("2");
    expect(audit.all()[0]).toMatchObject({ action: "stop", target: "email-sys-api", ok: false });
  });
});

describe("autoscaler handling", () => {
  beforeEach(() => { kube.add("cms-proc-api", 2); kube.hpas.set("cms-proc-api", cmsHpa()); });

  it("stop stores the autoscaler, removes only the autoscaler, then scales to 0", async () => {
    const off = await power.stop("cms-proc-api", "owner");
    const writes = kube.calls.filter((c) => !c.startsWith("get") && !c.startsWith("list"));
    expect(writes).toEqual(["annotate wso2/cms-proc-api", "delete-hpa wso2/cms-proc-api", "scale wso2/cms-proc-api 0"]);
    expect(kube.deps.has("cms-proc-api")).toBe(true);
    const stored = JSON.parse(kube.deps.get("cms-proc-api")!.metadata.annotations![ANN.hpa]);
    expect(stored.metadata).toEqual({ name: "cms-proc-api", labels: { app: "cms-proc-api" }, annotations: { "meta.helm.sh/release-name": "cms-proc-api" } });
    expect(stored.status).toBeUndefined();
    expect(stored.spec).toEqual(cmsHpa().spec);
    expect(off.autoscaler).toEqual({ min: 2, max: 2, stored: true });
  });
  it("start scales back and recreates the autoscaler exactly as it was", async () => {
    await power.stop("cms-proc-api", "owner");
    kube.calls = [];
    const on = await power.start("cms-proc-api", "owner");
    const writes = kube.calls.filter((c) => !c.startsWith("get") && !c.startsWith("list"));
    expect(writes).toEqual(["scale wso2/cms-proc-api 2", "create-hpa wso2/cms-proc-api", "annotate wso2/cms-proc-api"]);
    const back = kube.hpas.get("cms-proc-api")!;
    expect(back.spec).toEqual(cmsHpa().spec);
    expect(back.metadata.labels).toEqual({ app: "cms-proc-api" });
    expect(on.autoscaler).toEqual({ min: 2, max: 2, stored: false });
  });
  it("keeps the stored autoscaler when recreating it fails, so Start can be tried again", async () => {
    await power.stop("cms-proc-api", "owner");
    kube.failOn = "create-hpa";
    await expect(power.start("cms-proc-api", "owner")).rejects.toThrow(PowerError);
    expect(kube.deps.get("cms-proc-api")!.metadata.annotations![ANN.hpa]).toBeTruthy();
    kube.failOn = undefined;
    await power.start("cms-proc-api", "owner");
    expect(kube.hpas.has("cms-proc-api")).toBe(true);
  });
  it("does not create a second autoscaler when one is already there", async () => {
    await power.stop("cms-proc-api", "owner");
    kube.hpas.set("cms-proc-api", cmsHpa()); // put back by hand meanwhile
    kube.calls = [];
    await power.start("cms-proc-api", "owner");
    expect(kube.calls.some((c) => c.startsWith("create-hpa"))).toBe(false);
  });
});

describe("protected names", () => {
  it("refuses shared infrastructure and anything outside wso2", async () => {
    kube.add("intg-postgres", 1); kube.add("intg-redis", 1);
    await expect(power.stop("intg-postgres", "owner")).rejects.toMatchObject({ statusCode: 403 });
    await expect(power.stop("intg-redis", "owner")).rejects.toMatchObject({ statusCode: 403 });
    expect(kube.calls.some((c) => /^(scale|annotate|delete)/.test(c))).toBe(false);
    expect(refusal("apim", "wso2am-green")).toMatch(/Only services in the wso2 namespace/);
    expect(refusal("kube-system", "coredns")).toBeTruthy();
    expect(refusal("wso2", "../apim")).toBeTruthy();
    const other = new Power({ kube: new FakeKube("apim"), namespace: "apim", audit, now: () => NOW });
    await expect(other.stop("wso2am-green", "owner")).rejects.toMatchObject({ statusCode: 403 });
    const views = await power.services();
    expect(views.every((v) => v.protected)).toBe(true);
  });
  it("answers 404 for a service that does not exist", async () => {
    await expect(power.start("nope-api", "owner")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("audit", () => {
  it("records who, when, what and before -> after, one JSON object per line", async () => {
    kube.add("cms-proc-api", 2); kube.hpas.set("cms-proc-api", cmsHpa());
    await power.stop("cms-proc-api", "owner@x");
    await power.start("cms-proc-api", "admin2");
    const lines = readFileSync(audit.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ at: NOW.toISOString(), by: "owner@x", kind: "service", target: "cms-proc-api", action: "stop", from: "2 copies wanted, 2 running (autoscaler 2-2)", to: "0 copies", ok: true });
    expect(lines[1]).toMatchObject({ by: "admin2", action: "start", from: "0 copies wanted", to: "2 copies (autoscaler 2-2)", ok: true });
    const [v] = await power.services();
    expect(v.last).toMatchObject({ action: "start", by: "admin2" });
  });
});

describe("real cluster calls", () => {
  it("uses the scale subresource, merge patches and the autoscaling/v2 API", async () => {
    const sent: { method: string; path: string; body?: unknown; type?: string }[] = [];
    const api = kubeApiOf({ send: async (method, path, body, type) => { sent.push({ method, path, body, type }); return { status: 200, text: "{\"items\":[]}" }; } });
    await api.scale("wso2", "batch", 0);
    await api.annotate("wso2", "batch", { [ANN.replicas]: null });
    await api.deleteHpa("wso2", "cms-proc-api");
    expect(sent[0]).toEqual({ method: "PATCH", path: "/apis/apps/v1/namespaces/wso2/deployments/batch/scale", body: { spec: { replicas: 0 } }, type: "application/merge-patch+json" });
    expect(sent[1]).toMatchObject({ method: "PATCH", path: "/apis/apps/v1/namespaces/wso2/deployments/batch", body: { metadata: { annotations: { [ANN.replicas]: null } } } });
    expect(sent[2]).toMatchObject({ method: "DELETE", path: "/apis/autoscaling/v2/namespaces/wso2/horizontalpodautoscalers/cms-proc-api" });
    const denied = kubeApiOf({ send: async () => ({ status: 403, text: "{\"reason\":\"Forbidden\"}" }) });
    await expect(denied.scale("wso2", "batch", 0)).rejects.toThrow(/403 Forbidden/);
  });
});

describe("routes", () => {
  function app(role: "admin" | "viewer" | null, runtime?: Parameters<typeof registerPower>[1]["runtime"]) {
    const a = Fastify();
    a.decorate("tokenFor", async () => (role ? "t" : null));
    a.decorate("userFor", async () => (role ? `${role}-user` : null));
    a.decorate("roleFor", async () => role);
    registerPower(a as any, { kube, namespace: "wso2", dataDir: dir, runtime, now: () => NOW });
    return a;
  }
  it("lets everyone signed in read the state, but only an admin switch", async () => {
    kube.add("batch", 0, 0);
    const viewer = app("viewer");
    const r = await viewer.inject({ method: "GET", url: "/api/factory/power" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ canToggle: false, services: [{ name: "batch", state: "off" }] });
    const denied = await viewer.inject({ method: "POST", url: "/api/factory/power/services/batch", payload: { on: true } });
    expect(denied.statusCode).toBe(403);
    expect(kube.calls.some((c) => c.startsWith("scale"))).toBe(false);
    expect((await app(null).inject({ method: "GET", url: "/api/factory/power" })).statusCode).toBe(401);

    const admin = app("admin");
    const ok = await admin.inject({ method: "POST", url: "/api/factory/power/services/batch", payload: { on: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ name: "batch", wanted: 1 });
    expect(audit.all()[0]).toMatchObject({ by: "admin-user", action: "start", target: "batch" });
    expect((await admin.inject({ method: "POST", url: "/api/factory/power/services/batch", payload: {} })).statusCode).toBe(400);
  });
  it("refuses a protected name through the route", async () => {
    kube.add("intg-redis", 1);
    const r = await app("admin").inject({ method: "POST", url: "/api/factory/power/services/intg-redis", payload: { on: false } });
    expect(r.statusCode).toBe(403);
    expect(r.json().title).toMatch(/shared infrastructure/);
  });
  it("takes a flow offline and puts it live again as it was, through the runtime", async () => {
    const flow = { id: "f1", name: "Demo", deployment: { status: "deployed", gateway: { status: "published" } } as any };
    const calls: string[] = [];
    const runtime = async (m: string, p: string, b: unknown) => {
      calls.push(`${m} ${p} ${b ? JSON.stringify(b) : ""}`.trim());
      if (m === "GET" && p === "/v1/flows/f1") return { status: 200, text: JSON.stringify(flow) };
      if (p.endsWith("/undeploy")) { flow.deployment = undefined; return { status: 200, text: JSON.stringify({ flow }) }; }
      if (p.endsWith("/deploy")) { flow.deployment = { status: "deployed", gateway: { status: (b as any).publishToGateway ? "published" : "skipped" } }; return { status: 200, text: JSON.stringify({ flow, deployment: flow.deployment }) }; }
      if (p === "/v1/flows") return { status: 200, text: JSON.stringify({ flows: [flow] }) };
      return { status: 404, text: "" };
    };
    const a = app("admin", runtime);
    const off = await a.inject({ method: "POST", url: "/api/factory/power/flows/f1", payload: { on: false } });
    expect(off.json()).toMatchObject({ state: "off" });
    const listed = (await a.inject({ method: "GET", url: "/api/factory/power" })).json();
    expect(listed.flows).toEqual([expect.objectContaining({ id: "f1", state: "off", published: true })]);
    const on = await a.inject({ method: "POST", url: "/api/factory/power/flows/f1", payload: { on: true } });
    expect(on.json()).toMatchObject({ state: "on", published: true });
    expect(calls).toContain("POST /v1/flows/f1/deploy {\"publishToGateway\":true}");
    expect(audit.all().map((r) => `${r.kind} ${r.action} ${r.from} -> ${r.to}`)).toEqual(["flow stop live, on the gateway -> offline", "flow start offline -> live"]);
    expect((await app("viewer", runtime).inject({ method: "POST", url: "/api/factory/power/flows/f1", payload: { on: false } })).statusCode).toBe(403);
  });
  it("lists only live flows and the ones the switch took offline", () => {
    const flows = [{ id: "a", name: "A", deployment: { status: "deployed" } }, { id: "b", name: "B" }, { id: "c", name: "C" }] as any;
    const latest = new Map([["flow:c", { at: "", by: "x", kind: "flow", target: "c", action: "stop", from: "", to: "", ok: true } as const]]);
    expect(flowPowers(flows, latest as any).map((f) => `${f.id}:${f.state}`)).toEqual(["a:on", "c:off"]);
    expect(existsSync(join(dir, "nothing"))).toBe(false);
  });
});

describe("roles", async () => {
  const { roleOfTokens } = await import("../src/auth");
  const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  it("is admin only when the sign-in granted apim:admin", () => {
    expect(roleOfTokens({ access_token: "opaque", scope: "openid apim:admin apim:api_view" })).toBe("admin");
    expect(roleOfTokens({ access_token: "opaque", scope: "openid apim:api_view" })).toBe("viewer");
    expect(roleOfTokens({ access_token: jwt({ scope: "openid apim:admin" }) })).toBe("admin");
    expect(roleOfTokens({ access_token: "opaque" })).toBe("viewer");
    expect(roleOfTokens(undefined)).toBe("viewer");
  });
});
