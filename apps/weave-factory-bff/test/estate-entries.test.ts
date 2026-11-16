import { describe, it, expect } from "vitest";
import type { Flow } from "@traceit/weave-flow";
import { appendEntries, entryKind, intervalOf, scrub, whereOf, type ParityFlow } from "../src/estate/entries";
import type { StartState } from "../src/estate/starts";

const base = (): Flow => ({
  id: "estate:batch", name: "batch", slug: "batch", nodes: [
    { id: "n_001", type: "trigger.http", name: "ANY /clearObjectStore", position: { x: 0, y: 0 }, config: { methods: ["GET"], path: "/clearObjectStore" } },
    { id: "n_002", type: "respond", name: "Send response", position: { x: 280, y: 0 }, config: {} },
  ], edges: [{ id: "e1", from: "n_001", fromPort: "out", to: "n_002" }],
  settings: { basePath: "/batch/v1", gateway: { publish: false, version: "v1", security: "oauth2" } },
  revision: 1, createdAt: "", updatedAt: "", readOnly: true,
});

/** A batch-like old application: a timer with 40 sub-flows (two levels), a queue, an HTTP flow. */
function batchMap(): { flows: ParityFlow[] } {
  const modules = ["Accounts", "Contacts", "Reservation_Names", "Cabin_Info", "Addons", "Group_Agency", "Voyages", "Finance"];
  const flows: ParityFlow[] = [
    { name: "interfaceFlow", kind: "flow", trigger: "scheduler", uses: ["retrieve_date", "batch-implSub_Flow", "batch-aggregatorSub_Flow"], status: "complete" },
    { name: "active-MQFlow", kind: "flow", trigger: "jms listener", uses: ["active-MQ-implSub_Flow"], status: "complete" },
    { name: "interfaceFlow1", kind: "flow", trigger: "http ${app.name}/v1/clearObjectStore", uses: [], status: "complete" },
    { name: "retrieve_date", kind: "sub-flow", status: "complete" },
    { name: "batch-implSub_Flow", kind: "sub-flow", uses: ["Seaware_GraphQL_API_Sub_Flow", "oss-implSub_Flow"], status: "complete",
      calls: [{ what: "POST https://seaware.example.internal/graphql", found: true, where: "/root/api-migration-platform/services/batch/modules/core/job.bal:131" }],
      conditions: [{ value: "delta", found: true }], errors: [{ type: "HTTP:CONNECTIVITY", how: "continue", handled: true }] },
    { name: "Seaware_GraphQL_API_Sub_Flow", kind: "sub-flow", status: "complete" },
    { name: "oss-implSub_Flow", kind: "sub-flow", status: "complete" },
    { name: "batch-aggregatorSub_Flow", kind: "sub-flow", uses: ["Batch_zoho_modules"], status: "complete" },
    { name: "Batch_zoho_modules", kind: "sub-flow", uses: modules.map((m) => `zoho-${m}-Upsert`), status: "complete" },
    { name: "active-MQ-implSub_Flow", kind: "sub-flow", status: "gaps", missing: ["jms:publish errors"] },
  ];
  for (const m of modules) {
    flows.push({ name: `zoho-${m}-Upsert`, kind: "sub-flow", uses: [`zohoUpsert_${m}_Request`, `db-sys-${m}`, `retry-${m}`], status: "complete",
      calls: [{ what: `POST /crm/v6/${m}/upsert`, found: true, where: "services/batch/modules/core/job.bal:200" }] });
    flows.push({ name: `zohoUpsert_${m}_Request`, kind: "sub-flow", status: "complete" });
    flows.push({ name: `db-sys-${m}`, kind: "sub-flow", status: m === "Finance" ? "dead" : "complete" });
    flows.push({ name: `retry-${m}`, kind: "sub-flow", status: "complete" });
  }
  return { flows };
}
const starts: StartState[] = [
  { name: "interfaceFlow", starts: "runs on a timer", switch: "timer", on: true, live: "on", said: "ON, every 60.0s (mode delta, error e-mail on, OSS copy off)" },
  { name: "active-MQFlow", starts: "starts from a message queue", switch: "queue", on: false, live: "off", said: "off" },
];

describe("estate flow: entries that start by themselves and their old sub-flows", () => {
  it("adds a timer and a queue entry with the whole sub-flow tree, once each", () => {
    const f = appendEntries(base(), batchMap(), starts);
    const triggers = f.nodes.filter((n) => n.type.startsWith("trigger."));
    expect(triggers.map((t) => t.name)).toEqual(["ANY /clearObjectStore", "Timer: interfaceFlow", "Queue: active-MQFlow"]);
    const timer = triggers[1];
    expect(timer.type).toBe("trigger.schedule");
    expect(timer.config.everySeconds).toBe(60);
    expect(timer.notes).toContain("Every 60 s, switched on and running.");
    expect(triggers[2].notes).toContain("switched off");
    const subs = f.nodes.filter((n) => n.type === "flow.call");
    // timer: retrieve_date, batch-impl (+ Seaware, OSS), aggregator, Batch_zoho_modules = 6; 8 modules x 4 = 32; queue: 1
    expect(subs.length).toBe(6 + 32 + 1);
    expect(new Set(subs.map((n) => n.name)).size).toBe(subs.length);
    // every sub-flow hangs off a parent edge; the tree has depths 1..4
    const target = new Set(f.edges.map((e) => e.to));
    for (const n of subs) expect(target.has(n.id)).toBe(true);
    expect(Math.max(...subs.map((n) => n.config.__depth as number))).toBe(4);
    // HTTP entry is not duplicated
    expect(triggers.filter((t) => t.name.includes("clearObjectStore")).length).toBe(1);
  });

  it("marks status, calls, conditions, errors and where it lives in the new code, never hosts", () => {
    const f = appendEntries(base(), batchMap(), starts);
    const impl = f.nodes.find((n) => n.name === "batch-implSub_Flow")!;
    expect(impl.notes).toContain("found in the new code");
    expect(impl.notes).toContain("In the new code: services/batch/modules/core/job.bal:131");
    expect(impl.notes).toContain("Conditions: delta");
    expect(impl.notes).toContain("HTTP:CONNECTIVITY → continue");
    expect(JSON.stringify(f)).not.toContain("seaware.example.internal");
    expect(f.nodes.find((n) => n.name === "db-sys-Finance")!.notes).toContain("unused in the old app");
    expect(f.nodes.find((n) => n.name === "active-MQ-implSub_Flow")!.notes).toContain("not complete: jms:publish errors");
  });

  it("an HTTP-only service, or no map, stays exactly as it was", () => {
    const http = { flows: [{ name: "getOrder", kind: "flow", trigger: "http /orders/{id}", uses: ["lookup"], status: "complete" }, { name: "lookup", kind: "sub-flow", status: "complete" }] };
    expect(appendEntries(base(), http, [])).toEqual(base());
    expect(appendEntries(base(), null, [])).toEqual(base());
    expect(appendEntries(base(), { flows: [] }, [])).toEqual(base());
  });

  it("helpers", () => {
    expect(entryKind("scheduler")).toBe("timer");
    expect(entryKind("kafka listener")).toBe("topic");
    expect(entryKind("jms listener")).toBe("queue");
    expect(entryKind("http /x")).toBe("http");
    expect(entryKind("")).toBeNull();
    expect(intervalOf("ON, every 90.0s (x)")).toBe(90);
    expect(intervalOf("NOT STARTED")).toBeUndefined();
    expect(scrub("call https://a.b.c/x ops@x.com 10.1.2.3")).toBe("call <address> <mailbox> <ip>");
    expect(whereOf({ name: "x", calls: [{ what: "a", where: "/root/x/services/batch/job.bal:3" }] })).toBe("services/batch/job.bal:3");
  });

  it("a not-started timer says why", () => {
    const f = appendEntries(base(), { flows: [{ name: "interfaceFlow", trigger: "scheduler", status: "complete" }] },
      [{ name: "interfaceFlow", starts: "runs on a timer", on: true, live: "not-started", said: "NOT STARTED, the database could not be reached", why: "the database could not be reached" }]);
    expect(f.nodes.find((n) => n.name === "Timer: interfaceFlow")!.notes).toContain("switched on, not started: the database could not be reached");
  });
});
