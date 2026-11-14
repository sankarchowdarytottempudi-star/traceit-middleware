import { describe, it, expect } from "vitest";
import { BUILTIN_NODE_TYPES, type Flow, type FlowEdge, type FlowNode, type NodeTypeDef } from "@traceit/weave-flow";
import {
  autoLayout, canConnect, copySelection, createNode, firstFreePort, flowToGraph, graphToDoc, graphToFlow, localIssues, makeEdge, mergeIssues,
  needsLayout, nodeSummary, openingView, operationNodes, pasteClip, pruneEdges, ruleProblem, slugify, uniqueName, defResolver, type WsEdge, type WsNode,
} from "../src/studio/graph";
import { portsFor, unknownType } from "../src/studio/catalog";

const byType = new Map<string, NodeTypeDef>(BUILTIN_NODE_TYPES.map((d) => [d.type, d]));
const defOf = (t: string) => byType.get(t);

const node = (id: string, type: string, name: string, config: Record<string, unknown> = {}, x = 0, y = 0): FlowNode => ({ id, type, name, position: { x, y }, config });
const edge = (id: string, from: string, to: string, fromPort = "out"): FlowEdge => ({ id, from, fromPort, to });
const sampleFlow = (): Flow => ({
  id: "fl_1", name: "Orders", slug: "orders", status: "draft", revision: 3,
  nodes: [
    node("t", "trigger.http", "HTTP Listener", { methods: ["GET"], path: "/orders/:id" }, 60, 60),
    node("h", "http.request", "Get order", { method: "GET", url: "/orders/1" }, 360.4, 60.6),
    { ...node("m", "transform.map", "Shape", { input: "$", mapping: { rules: [{ id: "r1", target: "ref", kind: "direct", source: "id" }] } }, 660, 60), notes: "why", disabled: true },
    node("r", "respond", "Respond", { status: 200, body: "$" }, 960, 60),
    node("s", "note", "Note", { text: "hello" }, 60, -120),
  ],
  edges: [edge("e1", "t", "h"), edge("e2", "h", "m"), edge("e3", "m", "r"), edge("e4", "h", "r", "error")],
} as unknown as Flow);

describe("flow <-> canvas graph", () => {
  it("round-trips nodes, edges, ports, notes and the disabled flag", () => {
    const flow = sampleFlow();
    const g = flowToGraph(flow);
    expect(g.nodes.map((n) => n.type)).toEqual(["step", "step", "step", "step", "note"]);
    expect(g.edges.find((e) => e.id === "e4")).toMatchObject({ source: "h", sourceHandle: "error", target: "r", targetHandle: "in" });
    const doc = graphToDoc(g.nodes, g.edges);
    expect(doc.edges).toEqual(flow.edges);
    expect(doc.nodes[2]).toMatchObject({ id: "m", disabled: true, notes: "why" });
    expect(doc.nodes[0]).not.toHaveProperty("disabled");
    // positions are stored as whole numbers
    expect(doc.nodes[1].position).toEqual({ x: 360, y: 61 });
    expect(doc.nodes.map((n) => n.config)).toEqual(flow.nodes.map((n) => n.config));
  });
  it("drops edges that point at a step that does not exist", () => {
    const flow = sampleFlow();
    flow.edges.push(edge("e9", "h", "ghost"));
    expect(flowToGraph(flow).edges.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
  });
  it("defaults a missing port to the main output and a missing position to the origin", () => {
    const g = flowToGraph({ nodes: [{ id: "a", type: "log", name: "A", config: {} } as unknown as FlowNode, node("b", "log", "B")], edges: [{ id: "e", from: "a", to: "b" } as FlowEdge] });
    expect(g.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(g.edges[0].sourceHandle).toBe("out");
  });
  it("keeps measured sizes of nodes that were already on the canvas", () => {
    const flow = sampleFlow();
    const first = flowToGraph(flow);
    first.nodes[0].measured = { width: 232, height: 80 };
    expect(flowToGraph(flow, first.nodes).nodes[0].measured).toEqual({ width: 232, height: 80 });
  });
  it("graphToFlow keeps server fields and applies the edited name and settings", () => {
    const flow = sampleFlow();
    const g = flowToGraph(flow);
    const out = graphToFlow(flow, { name: "Orders v2", settings: { basePath: "/orders/v2" } as Flow["settings"] }, g.nodes, g.edges);
    expect(out).toMatchObject({ id: "fl_1", revision: 3, name: "Orders v2", settings: { basePath: "/orders/v2" } });
    expect(out.nodes).toHaveLength(5);
  });
});

describe("names and ids", () => {
  it("makes step names unique without regard to case", () => {
    expect(uniqueName([], "HTTP Request")).toBe("HTTP Request");
    expect(uniqueName(["HTTP Request"], "http request")).toBe("http request 2");
    expect(uniqueName(["Log", "Log 2", "Log 3"], "Log 2")).toBe("Log 4");
    expect(uniqueName(["x"], "  ")).toBe("Step");
  });
  it("slugifies a flow name", () => {
    expect(slugify("  Ship List (v2)! ")).toBe("ship-list-v2");
    expect(slugify("???")).toBe("flow");
  });
  it("creates a node with the catalog defaults, a fresh id and a unique name", () => {
    const def = defOf("http.request")!;
    const n = createNode(def, { x: 10.6, y: 20.2 }, [{ id: "a", name: def.label }]);
    expect(n.type).toBe("http.request");
    expect(n.name).toBe(`${def.label} 2`);
    expect(n.position).toEqual({ x: 11, y: 20 });
    expect(n.config.method).toBe("GET");
    // defaults are copied, never shared with the catalog
    const choice = createNode(defOf("logic.choice")!, { x: 0, y: 0 }, []);
    expect(choice.config.conditions).toEqual(defOf("logic.choice")!.defaults!.conditions);
    expect(choice.config.conditions).not.toBe(defOf("logic.choice")!.defaults!.conditions);
  });
});

describe("connections", () => {
  const g = () => flowToGraph(sampleFlow());
  it("refuses self loops, cycles, duplicates, triggers as targets and notes", () => {
    const { nodes, edges } = g();
    expect(canConnect(nodes, edges, "h", "out", "h", defOf)).toMatchObject({ ok: false });
    expect(canConnect(nodes, edges, "r", "out", "h", defOf)).toMatchObject({ ok: false, reason: expect.stringContaining("loop") });
    expect(canConnect(nodes, edges, "t", "out", "h", defOf)).toMatchObject({ ok: false, reason: expect.stringContaining("already") });
    expect(canConnect(nodes, edges, "h", "out", "t", defOf)).toMatchObject({ ok: false, reason: expect.stringContaining("starts a flow") });
    expect(canConnect(nodes, edges, "s", "out", "h", defOf)).toMatchObject({ ok: false });
    expect(canConnect(nodes, edges, "h", "out", "s", defOf)).toMatchObject({ ok: false });
    expect(canConnect(nodes, edges, "h", "out", "nope", defOf)).toMatchObject({ ok: false });
  });
  it("allows a second port to the same target and a new forward edge", () => {
    const { nodes, edges } = g();
    expect(canConnect(nodes, edges, "t", "out", "r", defOf)).toEqual({ ok: true });
    expect(canConnect(nodes, edges, "m", "error", "r", defOf)).toEqual({ ok: true });
  });
  it("makes edges with ids that are not taken", () => {
    const { edges } = g();
    const e = makeEdge("t", "", "r", edges);
    expect(e).toMatchObject({ source: "t", sourceHandle: "out", target: "r", type: "ws" });
    expect(edges.some((x) => x.id === e.id)).toBe(false);
  });
  it("finds the first free non-error port of a step", () => {
    const { nodes, edges } = g();
    const h = nodes.find((n) => n.id === "h")!;
    expect(firstFreePort(h, edges, defOf("http.request"))).toBeNull(); // out is used, error is never chained automatically
    expect(firstFreePort(h, [], defOf("http.request"))).toBe("out");
    expect(firstFreePort(h, [], undefined)).toBeNull();
  });
  it("prunes edges of a Choice case that was removed, keeps edges of unknown step types", () => {
    const choice: WsNode = { id: "c", type: "step", position: { x: 0, y: 0 }, data: { type: "logic.choice", name: "Choice", config: { conditions: [{ id: "a", label: "A", expr: "true" }] } } };
    const a: WsNode = { id: "a", type: "step", position: { x: 0, y: 0 }, data: { type: "log", name: "A", config: {} } };
    const x: WsNode = { id: "x", type: "step", position: { x: 0, y: 0 }, data: { type: "legacy.thing", name: "X", config: {} } };
    const edges: WsEdge[] = [
      { id: "1", source: "c", sourceHandle: "case:a", target: "a" },
      { id: "2", source: "c", sourceHandle: "case:gone", target: "a" },
      { id: "3", source: "c", sourceHandle: "otherwise", target: "a" },
      { id: "4", source: "x", sourceHandle: "whatever", target: "a" },
      { id: "5", source: "missing", sourceHandle: "out", target: "a" },
    ];
    expect(pruneEdges([choice, a, x], edges, defOf).map((e) => e.id)).toEqual(["1", "3", "4"]);
  });
  it("lists the steps of one operation (everything reachable from its trigger)", () => {
    const flow = sampleFlow();
    expect([...operationNodes("t", flow.edges)].sort()).toEqual(["h", "m", "r", "t"]);
    expect([...operationNodes("m", flow.edges)].sort()).toEqual(["m", "r"]);
  });
});

describe("ports", () => {
  it("puts the cases of a Choice before Otherwise", () => {
    const def = defOf("logic.choice")!;
    expect(portsFor(def, { conditions: [{ id: "vip", label: "VIP" }, { id: "", label: "ignored" }, { id: "std" }] }).map((p) => [p.id, p.label])).toEqual([["case:vip", "VIP"], ["case:std", "std"], ["otherwise", "Otherwise"]]);
  });
  it("gives an unknown step type a neutral definition with the ports its edges use", () => {
    const def = unknownType("connector:gone:op", ["out", "error", "custom"]);
    expect(def.hasInput).toBe(true);
    expect(def.outputs.map((p) => p.id)).toEqual(["out", "error", "custom"]);
    expect(def.outputs[1].kind).toBe("error");
    expect(unknownType("trigger.kafka").hasInput).toBe(false);
  });
  it("defResolver falls back to an unknown definition and remembers it", () => {
    const r = defResolver(byType, [{ from: "z", fromPort: "ok" }], [{ id: "z", type: "odd.type" }]);
    expect(r("respond")).toBe(byType.get("respond"));
    const d = r("odd.type");
    expect(d.outputs.map((p) => p.id)).toEqual(["out", "ok"]);
    expect(r("odd.type")).toBe(d);
  });
});

describe("copy and paste", () => {
  it("copies the selected steps with the edges between them only", () => {
    const g = flowToGraph(sampleFlow());
    expect(copySelection(g.nodes, g.edges)).toBeNull();
    const nodes = g.nodes.map((n) => ({ ...n, selected: n.id === "h" || n.id === "m" }));
    const clip = copySelection(nodes, g.edges)!;
    expect(clip.nodes.map((n) => n.id)).toEqual(["h", "m"]);
    expect(clip.edges.map((e) => e.id)).toEqual(["e2"]);
  });
  it("pastes with new ids, unique names, an offset and the copies selected", () => {
    const g = flowToGraph(sampleFlow());
    const nodes = g.nodes.map((n) => ({ ...n, selected: n.id === "h" || n.id === "m" }));
    const clip = copySelection(nodes, g.edges)!;
    const r = pasteClip(clip, nodes, g.edges, { x: 10, y: 20 });
    expect(r.nodes).toHaveLength(7);
    expect(r.added).toHaveLength(2);
    const added = r.nodes.filter((n) => r.added.includes(n.id));
    expect(added.map((n) => n.data.name)).toEqual(["Get order 2", "Shape 2"]);
    expect(added[0].position).toEqual({ x: 370, y: 81 });
    expect(r.nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(r.added);
    const newEdge = r.edges[r.edges.length - 1];
    expect([newEdge.source, newEdge.target]).toEqual(r.added);
    expect(new Set(r.edges.map((e) => e.id)).size).toBe(r.edges.length);
    // the copy does not share its settings object with the original
    (added[1].data.config.mapping as { rules: unknown[] }).rules.push({});
    expect((g.nodes[2].data.config.mapping as { rules: unknown[] }).rules).toHaveLength(1);
  });
});

describe("auto layout", () => {
  const ports = () => ["out"];
  it("lays a chain out left to right on one row", () => {
    const pos = autoLayout([{ id: "a" }, { id: "b" }, { id: "c" }], [{ source: "a", target: "b" }, { source: "b", target: "c" }], ports, { colGap: 300, origin: { x: 0, y: 0 } });
    expect([pos.get("a"), pos.get("b"), pos.get("c")]).toEqual([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 600, y: 0 }]);
  });
  it("stacks branches in port order and never overlaps steps of one column", () => {
    const pos = autoLayout(
      [{ id: "c" }, { id: "no" }, { id: "yes" }, { id: "end" }],
      [{ source: "c", target: "no", port: "otherwise" }, { source: "c", target: "yes", port: "case:a" }, { source: "yes", target: "end" }, { source: "no", target: "end" }],
      (id) => (id === "c" ? ["case:a", "otherwise"] : ["out"]), { rowGap: 30, heightOf: () => 70, origin: { x: 0, y: 0 } },
    );
    expect(pos.get("yes")!.y).toBeLessThan(pos.get("no")!.y);
    expect(pos.get("no")!.y - pos.get("yes")!.y).toBeGreaterThanOrEqual(100);
    expect(pos.get("yes")!.x).toBe(pos.get("no")!.x);
    // the join sits one column after its deepest input
    expect(pos.get("end")!.x).toBe(600);
    expect(pos.get("c")!.y).toBe(pos.get("yes")!.y);
  });
  it("leaves notes where they are and survives a cycle and loose steps", () => {
    const pos = autoLayout([{ id: "n", isNote: true }, { id: "a" }, { id: "b" }, { id: "lone" }], [{ source: "a", target: "b" }, { source: "b", target: "a" }], ports);
    expect(pos.has("n")).toBe(false);
    expect(pos.size).toBe(3);
    const ys = ["a", "b", "lone"].map((i) => `${pos.get(i)!.x}:${pos.get(i)!.y}`);
    expect(new Set(ys).size).toBe(3);
  });
});

describe("summaries and local checks", () => {
  it("describes a step in one line", () => {
    expect(nodeSummary("trigger.http", { methods: ["GET", "POST"], path: "/a" })).toBe("GET, POST /a");
    expect(nodeSummary("http.request", { method: "POST" })).toBe("POST (no URL yet)");
    expect(nodeSummary("transform.map", { mapping: { rules: [{}, {}] } })).toBe("2 mapping rules");
    expect(nodeSummary("transform.map", {})).toBe("0 mapping rules");
    expect(nodeSummary("legacy.step", { __source: { file: "src/a.ts", line: 12 } })).toBe("src/a.ts:12");
  });
  it("explains why a mapping rule cannot run yet", () => {
    expect(ruleProblem({ id: "1", target: "", kind: "direct", source: "a" })).toMatch(/output field/);
    expect(ruleProblem({ id: "1", target: "a", kind: "direct" })).toMatch(/input field/);
    expect(ruleProblem({ id: "1", target: "a", kind: "expr", expr: " " })).toMatch(/expression/);
    expect(ruleProblem({ id: "1", target: "a", kind: "instruction", instruction: "join the names" })).toMatch(/not been understood/);
    expect(ruleProblem({ id: "1", target: "a", kind: "instruction", instruction: "join", compiled: { expr: "a & b", explanation: "", confidence: 1, source: "builtin" } as never })).toBeNull();
    expect(ruleProblem({ id: "1", target: "", kind: "direct", enabled: false })).toBeNull();
    expect(ruleProblem({ id: "1", target: "a", kind: "const", value: "" })).toBeNull();
  });
  it("reports a rule in plain words that was not understood as an error on its step", () => {
    const flow = sampleFlow();
    (flow.nodes[2] as FlowNode).disabled = false;
    (flow.nodes[2].config.mapping as { rules: unknown[] }).rules.push({ id: "r2", target: "name", kind: "instruction", instruction: "frobnicate" });
    const issues = localIssues(flow, defOf);
    expect(issues.filter((i) => i.level === "error")).toEqual([expect.objectContaining({ nodeId: "m", field: "mapping", message: expect.stringContaining('"name"') })]);
  });
  it("asks for a trigger, unique names, required settings and warns about loose steps", () => {
    const doc = { nodes: [node("a", "http.request", "Call", { method: "GET" }), node("b", "http.request", "call", { method: "GET", url: "/x" }), node("z", "gone.type", "Old")], edges: [] };
    const issues = localIssues(doc, defOf);
    expect(issues.some((i) => !i.nodeId && /trigger/.test(i.message))).toBe(true);
    expect(issues.filter((i) => i.field === "name").map((i) => i.nodeId)).toEqual(["a", "b"]);
    expect(issues.some((i) => i.nodeId === "a" && i.field === "url" && i.level === "error")).toBe(true);
    expect(issues.some((i) => i.nodeId === "b" && i.field === "url")).toBe(false);
    expect(issues.some((i) => i.nodeId === "a" && i.level === "warning" && /never run/.test(i.message))).toBe(true);
    expect(issues.some((i) => i.nodeId === "z" && /not available/.test(i.message))).toBe(true);
  });
  it("skips a disabled step and a healthy flow has no issues", () => {
    const flow = sampleFlow();
    expect(localIssues(flow, defOf)).toEqual([]);
  });
  it("merges local and server issues without repeating a field the server already reported", () => {
    const local = [{ level: "error" as const, nodeId: "a", field: "url", message: '"URL" is required.' }, { level: "warning" as const, nodeId: "b", message: "Nothing is connected" }];
    const server = [{ level: "error" as const, nodeId: "a", field: "url", message: "url must not be empty" }, { level: "warning" as const, nodeId: "b", message: "Nothing is connected" }];
    expect(mergeIssues(local, server)).toEqual(server);
    expect(mergeIssues(local, [])).toEqual(local);
  });
});

describe("needsLayout", () => {
  const at = (x: number, y: number) => ({ position: { x, y } });
  it("is false for a single step and for steps that are spread out", () => {
    expect(needsLayout([at(0, 0)])).toBe(false);
    expect(needsLayout([at(0, 0), at(300, 0), at(300, 150)])).toBe(false);
  });
  it("is true when no step was ever placed", () => {
    expect(needsLayout([at(0, 0), at(0, 0), at(0, 0)])).toBe(true);
    expect(needsLayout([{}, {}])).toBe(true);
  });
  it("is true when two steps sit on top of each other", () => {
    expect(needsLayout([at(0, 0), at(1680, 0), at(1684, 3), at(1960, 150)])).toBe(true);
  });
});

describe("openingView", () => {
  const box = (x: number, y: number) => ({ x, y, w: 232, h: 70 });
  const view = { width: 1000, height: 700 };
  it("shows a small flow whole", () => {
    expect(openingView([box(60, 60), box(360, 60), box(660, 60)], undefined, view)).toEqual({ mode: "fit" });
    expect(openingView([], undefined, view)).toEqual({ mode: "fit" });
  });
  it("opens a long flow at its first step, at a readable size", () => {
    const boxes = Array.from({ length: 12 }, (_, i) => box(60 + i * 300, 60 + (i % 3) * 110));
    const v = openingView(boxes, boxes[0], view, { zoom: 0.8 });
    expect(v.mode).toBe("start");
    if (v.mode !== "start") return;
    expect(v.zoom).toBe(0.8);
    // the first step is near the left edge and fully inside the view
    const left = boxes[0].x * v.zoom + v.x, top = boxes[0].y * v.zoom + v.y;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThan(80);
    expect(top).toBeGreaterThan(40);
    expect(top + boxes[0].h * v.zoom).toBeLessThan(view.height);
  });
  it("keeps the first step near the top when the flow is also tall", () => {
    const boxes = [box(60, 60), ...Array.from({ length: 30 }, (_, i) => box(360 + (i % 10) * 300, 60 + i * 110))];
    const v = openingView(boxes, boxes[0], view);
    expect(v.mode).toBe("start");
    if (v.mode !== "start") return;
    const top = boxes[0].y * v.zoom + v.y;
    expect(top).toBeGreaterThan(40);
    expect(top).toBeLessThan(view.height / 2);
  });
  it("uses the top-left step when no first step is given", () => {
    const boxes = [box(900, 400), box(60, 500), box(60, 60), ...Array.from({ length: 12 }, (_, i) => box(1200 + i * 300, 60))];
    const v = openingView(boxes, undefined, view);
    expect(v.mode === "start" && Math.round(60 * v.zoom + v.x)).toBe(28);
  });
});
