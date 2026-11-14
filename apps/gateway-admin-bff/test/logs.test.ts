import { describe, it, expect } from "vitest";
import { mergeLogs, normLevel, parseLine, parseLogfmt, parsePodLog, createLogs } from "../src/logs.js";
import type { K8s, K8sPod } from "../src/k8s.js";
import type { Runtime } from "../src/runtime.js";

const CID = "0b9f7c1e-52a4-4d0e-9b1c-3f1f6a2d9e11";

describe("parseLine", () => {
  it("reads the Kubernetes timestamp and a Ballerina logfmt line", () => {
    const e = parseLine(`2026-11-14T12:21:55.714123456Z time=2026-11-14T12:21:55.714Z level=WARN module=acme/orders message="upstream slow" correlationId="${CID}" attempt=2`, "svc:orders", "orders-1");
    expect(e.t).toBe(Date.parse("2026-11-14T12:21:55.714Z"));
    expect(e.level).toBe("WARN"); expect(e.cid).toBe(CID);
    expect(e.msg).toBe("upstream slow · attempt=2 (acme/orders)");
    expect(e.text.startsWith("time=")).toBe(true);
  });
  it("reads a JSON line", () => {
    const e = parseLine(`2026-11-14T12:00:00.000000001Z {"time":"2026-11-14T12:00:00Z","level":"ERROR","module":"acme/cache","message":"refresh failed","correlationId":"${CID}"}`, "svc:cache", "cache-1");
    expect(e.level).toBe("ERROR"); expect(e.msg).toBe("refresh failed (acme/cache)"); expect(e.cid).toBe(CID);
  });
  it("reads a gateway log4j line and shortens the class", () => {
    const e = parseLine("2026-11-14T14:29:14.400Z TID: [-1234] [] [2026-11-14 14:29:14,384] ERROR {org.wso2.carbon.apimgt.gateway.handlers.security.APIAuthenticationHandler} - API authentication failure due to Invalid Credentials", "gw", "wso2am-1");
    expect(e.level).toBe("ERROR");
    expect(e.msg).toBe("API authentication failure due to Invalid Credentials (APIAuthenticationHandler)");
  });
  it("classifies raw lines", () => {
    expect(parseLine("2026-11-14T12:00:00Z error: no matching service found for path: /bad-request", "s", "p").level).toBe("ERROR");
    expect(parseLine("2026-11-14T12:00:00Z Picked up JAVA_TOOL_OPTIONS: -Xmx256m", "s", "p").level).toBe("");
    expect(parseLine("no timestamp here", "s", "p").t).toBe(0);
  });
  it("finds a correlation id mentioned in free text", () => {
    expect(parseLine(`2026-11-14T12:00:00Z [2026-11-14 12:00:00,001]  INFO {x.Y} - done, correlation-id: ${CID}`, "gw", "p").cid).toBe(CID);
  });
  it("normalises levels and parses logfmt escapes", () => {
    expect(normLevel("warning")).toBe("WARN"); expect(normLevel("FATAL")).toBe("ERROR"); expect(normLevel("trace")).toBe("DEBUG"); expect(normLevel("?")).toBe("");
    expect(parseLogfmt('a=1 b="two words" c="say \\"hi\\""')).toEqual({ a: "1", b: "two words", c: 'say "hi"' });
  });
});

describe("parsePodLog", () => {
  it("folds a stack trace into the line it belongs to", () => {
    const text = [
      "2026-11-14T12:00:00.000Z [2026-11-14 12:00:00,000] ERROR {a.B} - boom",
      "2026-11-14T12:00:00.001Z java.lang.IllegalStateException: boom",
      "2026-11-14T12:00:00.001Z \tat a.B.run(B.java:10)",
      "2026-11-14T12:00:00.001Z \tat a.C.call(C.java:20)",
      "2026-11-14T12:00:00.002Z Caused by: java.io.IOException: nope",
      "2026-11-14T12:00:00.002Z \t... 12 more",
      "2026-11-14T12:00:01.000Z [2026-11-14 12:00:01,000]  INFO {a.B} - next", "",
    ].join("\n");
    const out = parsePodLog(text, "gw", "p1");
    expect(out.map((e) => e.level)).toEqual(["ERROR", "", "INFO"]);
    expect(out[1].text.split("\n")).toHaveLength(5);
    expect(out[1].msg).toContain("Caused by: java.io.IOException");
  });
});

describe("mergeLogs", () => {
  const mk = (t: number, pod: string, level: any, msg: string, cid = "") => ({ t, source: "svc:x", pod, level, msg, cid, text: `${msg} ${cid}` });
  const a = [mk(1000, "a", "INFO", "a1"), mk(3000, "a", "ERROR", "a2 failed", CID), mk(3000, "a", "INFO", "a3")];
  const b = [mk(2000, "b", "WARN", "b1"), mk(3000, "b", "DEBUG", "b2"), mk(5000, "b", "", "b3 raw")];
  it("interleaves replicas by time and keeps each replica's order on ties", () => {
    expect(mergeLogs([a, b]).lines.map((l) => l.msg)).toEqual(["a1", "b1", "a2 failed", "a3", "b2", "b3 raw"]);
  });
  it("filters by minimum level (lines without a level count as INFO)", () => {
    expect(mergeLogs([a, b], { level: "WARN" }).lines.map((l) => l.msg)).toEqual(["b1", "a2 failed"]);
    expect(mergeLogs([a, b], { level: "INFO" }).lines.map((l) => l.msg)).toEqual(["a1", "b1", "a2 failed", "a3", "b3 raw"]);
    expect(mergeLogs([a, b], { level: "ERROR" }).lines).toHaveLength(1);
  });
  it("searches text case-insensitively and follows a correlation id", () => {
    expect(mergeLogs([a, b], { q: "FAILED" }).lines.map((l) => l.msg)).toEqual(["a2 failed"]);
    expect(mergeLogs([a, b], { cid: CID.toUpperCase() }).lines.map((l) => l.msg)).toEqual(["a2 failed"]);
  });
  it("keeps the newest lines when over the limit and reports how many matched", () => {
    const r = mergeLogs([a, b], { limit: 2 });
    expect(r.lines.map((l) => l.msg)).toEqual(["b2", "b3 raw"]); expect(r.matched).toBe(6); expect(r.scanned).toBe(6);
  });
});

describe("createLogs.read", () => {
  const pod = (name: string, app: string): K8sPod => ({ name, namespace: "ns", labels: { "app.kubernetes.io/name": app }, phase: "Running", ready: true, restarts: 0, startedAt: "", podIP: "", node: "", containers: ["api"], reason: "" });
  const k8s: K8s = {
    deployments: async () => [], services: async () => [],
    pods: async (ns) => (ns === "gwns" ? [pod("wso2am-1", "gw")] : [pod("orders-a", "orders"), pod("orders-b", "orders"), pod("other-a", "other")]),
    podLog: async (_ns, p) => {
      if (p === "orders-a") return `2026-11-14T12:00:01Z time=x level=INFO message="a one" correlationId="${CID}"\n2026-11-14T12:00:03Z time=x level=ERROR message="a two"\n`;
      if (p === "orders-b") return `2026-11-14T12:00:02Z time=x level=INFO message="b one"\n`;
      if (p === "wso2am-1") return `2026-11-14T12:00:00Z [2026-11-14 12:00:00,000]  INFO {g.H} - routed ${CID}\n`;
      throw new Error("HTTP 404");
    },
  };
  const runtime: Runtime = { configured: true, stats: async () => ({ ok: false, detail: "x" }), flows: async () => ({ ok: true, data: [{ id: "fl_1", name: "Ship list", slug: "ship-list" }] }),
    flowLogs: async () => ({ ok: true, data: [{ at: "2026-11-14T12:00:04Z", level: "info", message: "started", flowId: "fl_1", executionId: "ex_1", nodeName: "Trigger" }] }) };
  const logs = createLogs({ k8s, runtime, servicesNs: "ns", gatewayNs: "gwns", gatewayPodPrefix: "wso2am" });

  it("merges every replica of several sources into one timeline", async () => {
    const r = await logs.read({ sources: ["svc:orders", "gw", "flow:fl_1"] });
    expect(r.lines.map((l) => `${l.pod}|${l.msg}`)).toEqual([`wso2am-1|routed ${CID} (H)`, "orders-a|a one", "orders-b|b one", "orders-a|a two", "Trigger|[Trigger] started"]);
    expect(r.sources.map((s) => [s.id, s.replicas.length, s.lines])).toEqual([["svc:orders", 2, 3], ["gw", 1, 1], ["flow:fl_1", 1, 1]]);
  });
  it("follows one correlation id across the service and the gateway", async () => {
    const r = await logs.read({ sources: ["svc:orders", "gw"], cid: CID });
    expect(r.lines.map((l) => l.pod)).toEqual(["wso2am-1", "orders-a"]);
  });
  it("reports a source with no running replicas instead of failing", async () => {
    const r = await logs.read({ sources: ["svc:missing", "svc:orders"] });
    expect(r.sources[0]).toMatchObject({ id: "svc:missing", error: "No running replicas" });
    expect(r.lines).toHaveLength(3);
  });
  it("lists the available sources", async () => {
    const s = await logs.sources([{ name: "orders", kind: "service" }, { name: "other", kind: "component" }]);
    expect(s.list).toEqual([
      { id: "gw", label: "Gateway", kind: "gateway", replicas: 1 }, { id: "svc:orders", label: "orders", kind: "service", replicas: 2 },
      { id: "svc:other", label: "other", kind: "component", replicas: 1 }, { id: "flow:fl_1", label: "Ship list", kind: "flow", replicas: 1 }]);
  });
});
