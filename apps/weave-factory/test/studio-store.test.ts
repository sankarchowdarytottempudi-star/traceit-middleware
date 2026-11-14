import { describe, it, expect, beforeEach } from "vitest";
import { BUILTIN_NODE_TYPES, type Flow, type NodeTypeDef } from "@traceit/weave-flow";
import { EditorStore, metaOf } from "../src/studio/store";

const byType = new Map<string, NodeTypeDef>(BUILTIN_NODE_TYPES.map((d) => [d.type, d]));
const emptyFlow = (over: Partial<Flow> = {}): Flow => ({ id: "fl_1", name: "Orders", slug: "orders", status: "draft", revision: 1, nodes: [], edges: [], ...over } as unknown as Flow);
const make = (flow: Flow = emptyFlow(), opts?: { readOnly?: boolean }) => { const s = new EditorStore(flow, opts); s.setCatalog(byType); return s; };
const names = (s: EditorStore) => s.getState().nodes.map((n) => n.data.name);
const ports = (s: EditorStore) => s.getState().edges.map((e) => `${e.source}:${e.sourceHandle}>${e.target}`);

describe("editor store", () => {
  let s: EditorStore;
  beforeEach(() => { s = make(); });

  it("starts clean and derives the settings of a flow that has none", () => {
    expect(s.getState()).toMatchObject({ dirty: false, canUndo: false, canRedo: false, selection: [] });
    expect(metaOf(emptyFlow()).settings).toMatchObject({ basePath: "/orders/v1", gateway: { publish: true, security: "oauth2" } });
    expect(metaOf(emptyFlow({ settings: { basePath: "/x", gateway: { publish: false } } as Flow["settings"] })).settings).toMatchObject({ basePath: "/x", gateway: { publish: false, security: "oauth2" } });
  });

  it("click-to-add chains each new step after the selected one", () => {
    const t = s.addNode("trigger.http")!;
    const h = s.addNode("http.request")!;
    const r = s.addNode("respond")!;
    expect(s.getState().nodes).toHaveLength(3);
    expect(ports(s)).toEqual([`${t}:out>${h}`, `${h}:out>${r}`]);
    expect(s.getState().selection).toEqual([r]);
    const xs = s.getState().nodes.map((n) => n.position.x);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    expect(s.getState().dirty).toBe(true);
  });

  it("a dropped step is placed where it was dropped and not connected", () => {
    s.addNode("trigger.http");
    const id = s.addNode("log", { x: 500, y: 300 }, { connect: false })!;
    expect(s.getState().edges).toHaveLength(0);
    expect(s.getState().nodes.find((n) => n.id === id)!.position).toEqual({ x: 500, y: 300 });
  });

  it("does not chain a trigger and ignores step types the catalog does not know", () => {
    s.addNode("trigger.http");
    s.addNode("trigger.schedule");
    expect(s.getState().edges).toHaveLength(0);
    expect(s.addNode("no.such.type")).toBeNull();
  });

  it("undo and redo walk through added steps, edges and settings", () => {
    const t = s.addNode("trigger.http")!;
    const h = s.addNode("http.request")!;
    s.setConfig(h, "url", "/orders");
    expect(s.toFlow().nodes[1].config.url).toBe("/orders");
    s.undo();
    expect(s.toFlow().nodes[1].config.url || "").toBe("");
    s.undo();
    expect(s.getState().nodes.map((n) => n.id)).toEqual([t]);
    expect(s.getState().edges).toHaveLength(0);
    s.undo();
    expect(s.getState().nodes).toHaveLength(0);
    expect(s.getState()).toMatchObject({ canUndo: false, canRedo: true, dirty: false });
    s.redo(); s.redo(); s.redo();
    expect(s.toFlow().nodes[1].config.url).toBe("/orders");
    expect(ports(s)).toEqual([`${t}:out>${h}`]);
    expect(s.getState().canRedo).toBe(false);
  });

  it("typing in one setting is one undo step", () => {
    const h = s.addNode("http.request")!;
    for (const v of ["/", "/o", "/or", "/ord"]) s.setConfig(h, "url", v);
    s.undo();
    expect(s.toFlow().nodes[0].config.url || "").toBe("");
    expect(s.getState().nodes).toHaveLength(1);
  });

  it("refuses loops and double connections and reports why", () => {
    const t = s.addNode("trigger.http")!;
    const a = s.addNode("log")!;
    const b = s.addNode("log")!;
    expect(s.connect(b, "out", a)).toMatchObject({ ok: false });
    expect(s.connect(t, "out", a)).toMatchObject({ ok: false });
    expect(s.connect(a, "out", t)).toMatchObject({ ok: false });
    expect(s.connect(t, null, b)).toEqual({ ok: true });
    expect(s.getState().edges).toHaveLength(3);
  });

  it("deleting a step removes its connections, and undo brings both back", () => {
    s.addNode("trigger.http");
    const a = s.addNode("log")!;
    s.addNode("respond");
    s.remove([a]);
    expect(s.getState().nodes).toHaveLength(2);
    expect(s.getState().edges).toHaveLength(0);
    s.undo();
    expect(s.getState().nodes).toHaveLength(3);
    expect(s.getState().edges).toHaveLength(2);
  });

  it("removing a Choice case removes the connection that left it", () => {
    s.addNode("trigger.http");
    const c = s.addNode("logic.choice")!;
    s.setConfig(c, "conditions", [{ id: "a", label: "A", expr: "true" }, { id: "b", label: "B", expr: "false" }]);
    const x = s.addNode("log", { x: 900, y: 0 }, { connect: false })!;
    const y = s.addNode("log", { x: 900, y: 200 }, { connect: false })!;
    expect(s.connect(c, "case:a", x).ok).toBe(true);
    expect(s.connect(c, "case:b", y).ok).toBe(true);
    s.setConfig(c, "conditions", [{ id: "a", label: "A", expr: "true" }]);
    expect(ports(s).filter((p) => p.startsWith(`${c}:`))).toEqual([`${c}:case:a>${x}`]);
  });

  it("copy and paste make independent copies with unique names; duplicate does the same", () => {
    s.addNode("trigger.http");
    const a = s.addNode("log")!;
    const b = s.addNode("respond")!;
    s.select([a, b]);
    expect(s.copy()).toBe(2);
    expect(s.paste()).toBe(2);
    expect(s.getState().nodes).toHaveLength(5);
    expect(new Set(names(s)).size).toBe(5);
    expect(s.getState().edges).toHaveLength(3); // the edge between the two copies came along
    expect(s.getState().selection).toHaveLength(2);
    expect(s.duplicate([a])).toBe(1);
    expect(s.getState().nodes).toHaveLength(6);
    s.undo(); s.undo();
    expect(s.getState().nodes).toHaveLength(3);
  });

  it("disables and re-enables steps", () => {
    const a = s.addNode("log")!;
    s.toggleDisabled([a]);
    expect(s.toFlow().nodes[0].disabled).toBe(true);
    s.toggleDisabled([a]);
    expect(s.toFlow().nodes[0].disabled).toBeUndefined();
  });

  it("tidy-up lays the steps out left to right and can be undone", () => {
    const t = s.addNode("trigger.http", { x: 900, y: 500 })!;
    s.select([t]);
    const a = s.addNode("log", { x: 10, y: 10 })!;
    s.connect(t, "out", a);
    s.layout();
    const pos = Object.fromEntries(s.getState().nodes.map((n) => [n.id, n.position]));
    expect(pos[t].x).toBeLessThan(pos[a].x);
    expect(pos[t].y).toBe(pos[a].y);
    s.undo();
    expect(s.getState().nodes.find((n) => n.id === t)!.position).toEqual({ x: 900, y: 500 });
  });

  it("knows when it is saved and when a change makes it dirty again", () => {
    const a = s.addNode("log")!;
    expect(s.getState().dirty).toBe(true);
    s.markSaved({ ...s.toFlow(), revision: 2 });
    expect(s.getState()).toMatchObject({ dirty: false, base: { revision: 2 } });
    s.setConfig(a, "message", "hi");
    expect(s.getState().dirty).toBe(true);
    s.undo();
    expect(s.getState().dirty).toBe(false);
  });

  it("settings and name are part of the document and its history", () => {
    s.setMeta({ name: "Orders API" });
    s.setSettings({ gateway: { publish: false } as never });
    expect(s.toFlow()).toMatchObject({ name: "Orders API", settings: { gateway: { publish: false, security: "oauth2" } } });
    s.undo(); s.undo();
    expect(s.toFlow().name).toBe("Orders");
  });

  it("loading a restored version is undoable; loading a server copy resets history", () => {
    s.addNode("trigger.http");
    const other = emptyFlow({ nodes: [{ id: "x", type: "log", name: "Only", position: { x: 0, y: 0 }, config: {} }] as Flow["nodes"] });
    s.load(other);
    expect(names(s)).toEqual(["Only"]);
    s.undo();
    expect(names(s)).toEqual(["HTTP Listener"]);
    s.load(other, { asSaved: true });
    expect(s.getState()).toMatchObject({ dirty: false, canUndo: false });
  });

  it("a read-only flow cannot be changed", () => {
    const ro = make(emptyFlow({ nodes: [{ id: "x", type: "log", name: "Only", position: { x: 0, y: 0 }, config: {} }] as Flow["nodes"] }), { readOnly: true });
    expect(ro.addNode("log")).toBeNull();
    ro.remove(["x"]); ro.setConfig("x", "message", "nope"); ro.toggleDisabled(["x"]); ro.layout(); ro.setMeta({ name: "changed" });
    expect(ro.connect("x", "out", "x")).toMatchObject({ ok: false });
    expect(ro.toFlow()).toMatchObject({ name: "Orders", nodes: [{ id: "x", config: {} }] });
    expect(ro.getState().dirty).toBe(false);
    ro.select(["x"]);
    expect(ro.getState().selection).toEqual(["x"]);
  });

  it("shows local problems per step and merges what the server reports", () => {
    const h = s.addNode("http.request")!;
    expect(s.getState().issuesByNode[h]?.some((i) => i.field === "url")).toBe(true);
    expect(s.getState().issues.some((i) => !i.nodeId && /trigger/.test(i.message))).toBe(true);
    s.setServerIssues([{ level: "error", nodeId: h, message: "Unknown connection" }, { level: "error", nodeId: "gone", message: "stale" }]);
    expect(s.getState().issuesByNode[h].map((i) => i.message)).toContain("Unknown connection");
    s.setConfig(h, "url", "/x");
    // server issues of steps that no longer exist are dropped with the next change
    expect(s.getState().issues.some((i) => i.nodeId === "gone")).toBe(false);
  });

  it("groups the traces of a test run by step and keeps a single-step test apart", () => {
    const step = (seq: number, nodeId: string) => ({ seq, nodeId, nodeName: nodeId, nodeType: "log", status: "success", startedAt: "", durationMs: 1 });
    s.setRun({ id: "ex", steps: [step(1, "a"), step(2, "b"), step(3, "b")] } as never);
    expect(Object.fromEntries(Object.entries(s.getState().tracesByNode).map(([k, v]) => [k, v.length]))).toEqual({ a: 1, b: 2 });
    s.setNodeRun(step(9, "a") as never);
    expect(s.getState().tracesByNode.a[0].seq).toBe(9);
    expect(s.getState().run?.id).toBe("ex");
  });

  it("tells subscribers about changes", () => {
    let calls = 0;
    const off = s.subscribe(() => { calls++; });
    s.addNode("log");
    expect(calls).toBeGreaterThan(0);
    const before = calls;
    off();
    s.addNode("log");
    expect(calls).toBe(before);
  });
});
