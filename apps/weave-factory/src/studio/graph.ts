// Pure graph logic for the canvas: Flow <-> canvas graph conversion, node creation, connection
// rules, copy/paste, auto-layout and local validation. No React, no network: unit tested.
import type { Flow, FlowEdge, FlowNode, MappingRule, MappingSpec, NodeTypeDef, ValidationIssue } from "@traceit/weave-flow";
import { fieldVisible, isEmptyValue, portsFor, unknownType } from "./catalog.ts";

// ---------------------------------------------------------------- canvas graph (React Flow shaped)
export interface WsNodeData extends Record<string, unknown> {
  type: string;
  name: string;
  config: Record<string, unknown>;
  disabled?: boolean;
  notes?: string;
}
export interface WsNode {
  id: string;
  type: "step" | "note";
  position: { x: number; y: number };
  data: WsNodeData;
  selected?: boolean;
  dragging?: boolean;
  measured?: { width?: number; height?: number };
  width?: number; height?: number;
  [k: string]: unknown;
}
export interface WsEdge {
  id: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
  type?: string;
  selected?: boolean;
  [k: string]: unknown;
}
export interface FlowDoc { nodes: FlowNode[]; edges: FlowEdge[]; }

export const NODE_W = 232;
export const NOTE_TYPE = "note";

export function toWsNode(n: FlowNode, prev?: WsNode): WsNode {
  const node: WsNode = {
    id: n.id,
    type: n.type === NOTE_TYPE ? "note" : "step",
    position: { x: Number(n.position?.x) || 0, y: Number(n.position?.y) || 0 },
    data: { type: n.type, name: n.name, config: n.config ?? {}, disabled: n.disabled || undefined, notes: n.notes || undefined },
  };
  if (prev?.measured) node.measured = prev.measured;
  return node;
}
export function toWsEdge(e: FlowEdge): WsEdge {
  return { id: e.id, source: e.from, sourceHandle: e.fromPort || "out", target: e.to, targetHandle: "in", type: "ws" };
}
export function toFlowNode(n: WsNode): FlowNode {
  const out: FlowNode = {
    id: n.id, type: n.data.type, name: n.data.name,
    position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    config: n.data.config ?? {},
  };
  if (n.data.disabled) out.disabled = true;
  if (n.data.notes) out.notes = n.data.notes;
  return out;
}
export function toFlowEdge(e: WsEdge): FlowEdge {
  return { id: e.id, from: e.source, fromPort: e.sourceHandle || "out", to: e.target };
}
export function flowToGraph(flow: Pick<Flow, "nodes" | "edges">, prev: WsNode[] = []): { nodes: WsNode[]; edges: WsEdge[] } {
  const prevById = new Map(prev.map((n) => [n.id, n]));
  const nodes = (flow.nodes ?? []).map((n) => toWsNode(n, prevById.get(n.id)));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (flow.edges ?? []).filter((e) => ids.has(e.from) && ids.has(e.to)).map(toWsEdge);
  return { nodes, edges };
}
export function graphToDoc(nodes: WsNode[], edges: WsEdge[]): FlowDoc {
  return { nodes: nodes.map(toFlowNode), edges: edges.map(toFlowEdge) };
}
export function graphToFlow(base: Flow, meta: Partial<Pick<Flow, "name" | "description" | "tags" | "settings">>, nodes: WsNode[], edges: WsEdge[]): Flow {
  return { ...base, ...meta, ...graphToDoc(nodes, edges) };
}

// ---------------------------------------------------------------- ids and names
export function newId(prefix = "n"): string {
  let s = "";
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return `${prefix}_${s}`;
}
export function uniqueName(taken: Iterable<string>, base: string): string {
  const set = new Set(Array.from(taken, (t) => t.toLowerCase()));
  const clean = base.trim() || "Step";
  if (!set.has(clean.toLowerCase())) return clean;
  const m = /^(.*?)(?:\s+(\d+))?$/.exec(clean)!;
  const stem = m[1];
  for (let i = m[2] ? Number(m[2]) + 1 : 2; ; i++) {
    const cand = `${stem} ${i}`;
    if (!set.has(cand.toLowerCase())) return cand;
  }
}
export function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "flow";
}
function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** A new node of the given type with the catalog defaults filled in. */
export function createNode(def: NodeTypeDef, position: { x: number; y: number }, existing: { id: string; name: string }[]): FlowNode {
  const config: Record<string, unknown> = clone(def.defaults ?? {});
  for (const f of def.fields ?? []) if (config[f.key] === undefined && f.default !== undefined) config[f.key] = clone(f.default);
  const ids = new Set(existing.map((n) => n.id));
  let id = newId("n");
  while (ids.has(id)) id = newId("n");
  return { id, type: def.type, name: uniqueName(existing.map((n) => n.name), def.label), position: { x: Math.round(position.x), y: Math.round(position.y) }, config };
}

// ---------------------------------------------------------------- connections
export function reachableFrom(start: string, edges: { source: string; target: string }[]): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of edges) { const l = out.get(e.source); if (l) l.push(e.target); else out.set(e.source, [e.target]); }
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const t of out.get(cur) ?? []) if (!seen.has(t)) { seen.add(t); stack.push(t); }
  }
  return seen;
}
export type ConnectVerdict = { ok: true } | { ok: false; reason: string };
/** Whether an edge source:port -> target may be drawn. */
export function canConnect(nodes: WsNode[], edges: WsEdge[], source: string, port: string, target: string, defOf: (type: string) => NodeTypeDef | undefined): ConnectVerdict {
  if (!source || !target) return { ok: false, reason: "Pick two steps." };
  if (source === target) return { ok: false, reason: "A step cannot connect to itself." };
  const s = nodes.find((n) => n.id === source), t = nodes.find((n) => n.id === target);
  if (!s || !t) return { ok: false, reason: "Step not found." };
  const tdef = defOf(t.data.type);
  if (t.type === "note" || (tdef && !tdef.hasInput)) return { ok: false, reason: "That step starts a flow and cannot receive a connection." };
  if (s.type === "note") return { ok: false, reason: "Notes cannot be connected." };
  if (edges.some((e) => e.source === source && (e.sourceHandle || "out") === port && e.target === target)) return { ok: false, reason: "These steps are already connected." };
  if (reachableFrom(target, edges).has(source)) return { ok: false, reason: "That would create a loop. Use For Each to repeat steps." };
  return { ok: true };
}
export function makeEdge(source: string, port: string, target: string, existing: WsEdge[]): WsEdge {
  const ids = new Set(existing.map((e) => e.id));
  let id = newId("e");
  while (ids.has(id)) id = newId("e");
  return { id, source, sourceHandle: port || "out", target, targetHandle: "in", type: "ws" };
}
/** Drops edges that leave a port the node no longer has (a removed Choice case, a removed branch). */
export function pruneEdges(nodes: WsNode[], edges: WsEdge[], defOf: (type: string) => NodeTypeDef | undefined): WsEdge[] {
  const ports = new Map<string, Set<string> | null>();
  for (const n of nodes) {
    const def = defOf(n.data.type);
    ports.set(n.id, def ? new Set(portsFor(def, n.data.config).map((p) => p.id)) : null);
  }
  return edges.filter((e) => {
    if (!ports.has(e.source) || !ports.has(e.target)) return false;
    const p = ports.get(e.source);
    return p === null || p === undefined || p.has(e.sourceHandle || "out");
  });
}
/** First output port of `nodeId` that has no outgoing edge yet (used to chain a newly added step). */
export function firstFreePort(node: WsNode, edges: WsEdge[], def: NodeTypeDef | undefined): string | null {
  if (!def) return null;
  const used = new Set(edges.filter((e) => e.source === node.id).map((e) => e.sourceHandle || "out"));
  const ports = portsFor(def, node.data.config).filter((p) => p.kind !== "error");
  return ports.find((p) => !used.has(p.id))?.id ?? null;
}

// ---------------------------------------------------------------- copy / paste
export interface Clip { nodes: FlowNode[]; edges: FlowEdge[]; }
export function copySelection(nodes: WsNode[], edges: WsEdge[]): Clip | null {
  const sel = nodes.filter((n) => n.selected);
  if (!sel.length) return null;
  const ids = new Set(sel.map((n) => n.id));
  return { nodes: clone(sel.map(toFlowNode)), edges: clone(edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map(toFlowEdge)) };
}
/** Clones a clipboard into the graph with fresh ids and unique names. The new nodes come back selected. */
export function pasteClip(clip: Clip, nodes: WsNode[], edges: WsEdge[], offset = { x: 40, y: 40 }): { nodes: WsNode[]; edges: WsEdge[]; added: string[] } {
  const idMap = new Map<string, string>();
  const names = nodes.map((n) => n.data.name);
  const ids = new Set(nodes.map((n) => n.id));
  const addedNodes: WsNode[] = [];
  for (const n of clip.nodes) {
    let id = newId("n");
    while (ids.has(id)) id = newId("n");
    ids.add(id); idMap.set(n.id, id);
    const name = uniqueName(names, n.name);
    names.push(name);
    const ws = toWsNode({ ...clone(n), id, name, position: { x: n.position.x + offset.x, y: n.position.y + offset.y } });
    ws.selected = true;
    addedNodes.push(ws);
  }
  const allEdges = [...edges];
  for (const e of clip.edges) {
    const from = idMap.get(e.from), to = idMap.get(e.to);
    if (from && to) allEdges.push(makeEdge(from, e.fromPort, to, allEdges));
  }
  return { nodes: [...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...addedNodes], edges: allEdges, added: addedNodes.map((n) => n.id) };
}

// ---------------------------------------------------------------- auto layout (left to right)
export interface LayoutOptions { colGap?: number; rowGap?: number; origin?: { x: number; y: number }; heightOf?: (id: string) => number; }
/** Layered layout: column = longest path from a start node, rows follow the port order so
 *  branches stay in the order they are drawn on the node. Notes keep their position. */
export function autoLayout(nodes: { id: string; isNote?: boolean }[], edges: { source: string; target: string; port?: string }[], portOrder: (id: string) => string[], opts: LayoutOptions = {}): Map<string, { x: number; y: number }> {
  const colGap = opts.colGap ?? 300, rowGap = opts.rowGap ?? 36;
  const origin = opts.origin ?? { x: 60, y: 60 };
  const heightOf = opts.heightOf ?? (() => 72);
  const ids = nodes.filter((n) => !n.isNote).map((n) => n.id);
  const idSet = new Set(ids);
  const outs = new Map<string, { target: string; port: string }[]>();
  const indeg = new Map<string, number>(ids.map((i) => [i, 0]));
  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    const l = outs.get(e.source) ?? [];
    l.push({ target: e.target, port: e.port ?? "out" });
    outs.set(e.source, l);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  for (const [id, l] of outs) {
    const order = portOrder(id);
    l.sort((a, b) => (order.indexOf(a.port) + 1 || 99) - (order.indexOf(b.port) + 1 || 99));
  }
  // column = longest path (Kahn order; nodes left in a cycle fall back to column 0)
  const col = new Map<string, number>(ids.map((i) => [i, 0]));
  const deg = new Map(indeg);
  const queue = ids.filter((i) => (deg.get(i) ?? 0) === 0);
  const topo: string[] = [];
  while (queue.length) {
    const cur = queue.shift()!;
    topo.push(cur);
    for (const { target } of outs.get(cur) ?? []) {
      col.set(target, Math.max(col.get(target) ?? 0, (col.get(cur) ?? 0) + 1));
      deg.set(target, (deg.get(target) ?? 0) - 1);
      if (deg.get(target) === 0) queue.push(target);
    }
  }
  // rows: depth-first from the start nodes; a leaf takes the next free row, a parent sits level with its first child
  const y = new Map<string, number>();
  const placed = new Set<string>();
  let cursor = origin.y;
  const colBottom = new Map<number, number>();
  const place = (id: string): number => {
    if (placed.has(id)) return y.get(id)!;
    placed.add(id);
    const kids = (outs.get(id) ?? []).map((k) => k.target).filter((k) => !placed.has(k) && (col.get(k) ?? 0) > (col.get(id) ?? 0));
    const c = col.get(id) ?? 0;
    const h = heightOf(id);
    let top: number;
    if (!kids.length) {
      top = Math.max(cursor, colBottom.get(c) ?? origin.y);
    } else {
      const firstKid = place(kids[0]);
      for (const k of kids.slice(1)) place(k);
      top = Math.max(firstKid, colBottom.get(c) ?? origin.y);
    }
    y.set(id, top);
    colBottom.set(c, top + h + rowGap);
    cursor = Math.max(cursor, top + (kids.length ? 0 : h + rowGap));
    return top;
  };
  const starts = ids.filter((i) => (indeg.get(i) ?? 0) === 0);
  for (const s of [...starts, ...ids]) {
    if (placed.has(s)) continue;
    place(s);
    cursor = Math.max(cursor, ...Array.from(colBottom.values()));
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const id of ids) pos.set(id, { x: origin.x + (col.get(id) ?? 0) * colGap, y: y.get(id) ?? origin.y });
  return pos;
}

/** True when saved positions cannot be used as they are: no step was ever placed, or steps sit on top of
 *  each other (flows made by an import or a copy of a migrated service arrive like that). */
export function needsLayout(steps: { position?: { x: number; y: number } }[]): boolean {
  if (steps.length < 2) return false;
  const seen = new Set<string>();
  let atOrigin = 0;
  for (const s of steps) {
    const x = s.position?.x ?? 0, y = s.position?.y ?? 0;
    if (x === 0 && y === 0) atOrigin++;
    const key = `${Math.round(x / 24)}:${Math.round(y / 24)}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return atOrigin === steps.length;
}

export interface Box { x: number; y: number; w: number; h: number; }
export type OpeningView = { mode: "fit" } | { mode: "start"; x: number; y: number; zoom: number };
/** How a canvas opens: the whole flow when its steps stay readable at that size, otherwise the start of
 *  the flow at a readable size (the rest is reached by panning, the overview map or "fit"). */
export function openingView(boxes: Box[], start: Box | undefined, view: { width: number; height: number }, opts: { readable?: number; zoom?: number; padding?: number; margin?: number; top?: number } = {}): OpeningView {
  if (!boxes.length || view.width <= 0 || view.height <= 0) return { mode: "fit" };
  const readable = opts.readable ?? 0.62, zoom = opts.zoom ?? 0.8, padding = opts.padding ?? 0.18, margin = opts.margin ?? 28, top = opts.top ?? 56;
  const minX = Math.min(...boxes.map((b) => b.x)), minY = Math.min(...boxes.map((b) => b.y));
  const bw = Math.max(...boxes.map((b) => b.x + b.w)) - minX, bh = Math.max(...boxes.map((b) => b.y + b.h)) - minY;
  const fitZoom = Math.min(view.width / (bw * (1 + 2 * padding)), view.height / (bh * (1 + 2 * padding)));
  if (fitZoom >= readable) return { mode: "fit" };
  const s = start ?? boxes.reduce((a, b) => (b.x < a.x || (b.x === a.x && b.y < a.y) ? b : a));
  const room = view.height - top - margin;
  // the flow is short enough: centre it top to bottom; otherwise keep the first step near the top
  const y = bh * zoom <= room ? top + (room - bh * zoom) / 2 - minY * zoom : top + Math.min(room * 0.25, 120) - s.y * zoom;
  return { mode: "start", x: margin - s.x * zoom, y, zoom };
}

/** Approximate rendered height of a step node (used before the browser has measured it). */
export function estimateHeight(def: NodeTypeDef | undefined, config: Record<string, unknown>): number {
  if (!def) return 64;
  const rows = portsFor(def, config).filter((p) => p.id !== "out").length;
  return 64 + rows * 26 + (rows ? 8 : 0);
}

// ---------------------------------------------------------------- summaries and validation
function short(v: unknown, max = 44): string {
  const s = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
/** One-line description of what a node does, shown under its name. */
export function nodeSummary(type: string, config: Record<string, unknown>, def?: NodeTypeDef): string {
  const c = config ?? {};
  if (type === "trigger.http") return `${Array.isArray(c.methods) ? (c.methods as string[]).join(", ") : "GET"} ${short(c.path || "/")}`;
  if (type === "trigger.schedule") return c.mode === "cron" ? `Cron ${short(c.cron)}` : `Every ${short(c.everySeconds ?? 300)} s`;
  if (type === "http.request") return `${short(c.method || "GET")} ${short(c.url) || "(no URL yet)"}`;
  if (type === "graphql.request") return short(c.operationName || c.url || "GraphQL");
  if (type === "redis.command") return `${String(c.operation ?? "get").toUpperCase()} ${short(c.key)}`;
  if (type === "postgres.query") return short(c.sql) || "SQL";
  if (type === "transform.map") { const n = mappingOf(c.mapping).rules.length; return n === 1 ? "1 mapping rule" : `${n} mapping rules`; }
  if (type === "transform.expr") return short(c.expr);
  if (type === "logic.choice") { const n = Array.isArray(c.conditions) ? c.conditions.length : 0; return n === 1 ? "1 condition" : `${n} conditions`; }
  if (type === "logic.foreach") return `For each of ${short(c.items)}`;
  if (type === "respond") return `Status ${short(c.status ?? 200)}`;
  if (type === "log") return short(c.message);
  if (type === "logic.delay") return `${short(c.ms)} ms`;
  const src = c.__source as { file?: string; line?: number } | undefined;
  if (src?.file) return `${src.file}${src.line ? `:${src.line}` : ""}`;
  if (type.startsWith("connector:")) return def?.description ? short(def.description, 60) : "Custom connector";
  for (const k of ["url", "path", "key", "expr", "message", "name"]) if (typeof c[k] === "string" && c[k]) return short(c[k]);
  return def?.category === "trigger" ? "Starts the flow" : "";
}
export function mappingOf(v: unknown): MappingSpec {
  const m = (v && typeof v === "object" ? v : {}) as Partial<MappingSpec>;
  return { ...m, rules: Array.isArray(m.rules) ? m.rules : [] } as MappingSpec;
}
/** Why a mapping rule cannot run yet, or null when it is complete. */
export function ruleProblem(r: MappingRule, shapeKind?: string): string | null {
  if (r.enabled === false) return null;
  if (!r.target?.trim() && shapeKind !== "values" && shapeKind !== "value") return "Choose the output field this rule fills.";
  if (r.kind === "direct" && !r.source?.trim()) return "Choose the input field to copy.";
  if (r.kind === "expr" && !r.expr?.trim()) return "Write the expression.";
  if (r.kind === "instruction") {
    if (!r.instruction?.trim()) return "Describe the rule in your own words.";
    if (!r.compiled?.expr) return "This rule in your words has not been understood yet.";
  }
  return null;
}
/** Checks that need no server: used for badges while typing and as a safety net before deploy. */
export function localIssues(doc: FlowDoc, defOf: (type: string) => NodeTypeDef | undefined): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const steps = doc.nodes.filter((n) => n.type !== NOTE_TYPE);
  if (!steps.some((n) => defOf(n.type)?.category === "trigger" || n.type.startsWith("trigger."))) {
    issues.push({ level: "error", message: "Add a trigger (for example an HTTP Listener) so the flow has a starting point." });
  }
  const names = new Map<string, number>();
  for (const n of steps) names.set(n.name.toLowerCase(), (names.get(n.name.toLowerCase()) ?? 0) + 1);
  const incoming = new Set(doc.edges.map((e) => e.to));
  for (const n of steps) {
    const def = defOf(n.type);
    if (!n.name.trim()) issues.push({ level: "error", nodeId: n.id, field: "name", message: "Give this step a name." });
    else if ((names.get(n.name.toLowerCase()) ?? 0) > 1) issues.push({ level: "error", nodeId: n.id, field: "name", message: `Another step is also called "${n.name}". Names must be unique.` });
    if (!def) { issues.push({ level: "warning", nodeId: n.id, message: `Step type "${n.type}" is not available on this server.` }); continue; }
    if (n.disabled) continue;
    if (def.hasInput && !incoming.has(n.id)) issues.push({ level: "warning", nodeId: n.id, message: "Nothing is connected to this step, so it will never run." });
    for (const f of def.fields) {
      if (!fieldVisible(f, n.config)) continue;
      const v = n.config[f.key];
      if (f.kind === "mapping") {
        const spec = mappingOf(v);
        for (const r of spec.rules) {
          const p = ruleProblem(r, spec.shape?.kind);
          if (p) issues.push({ level: "error", nodeId: n.id, field: f.key, message: `Mapping rule for "${r.target || "(no field)"}": ${p}` });
        }
        continue;
      }
      if (f.required && isEmptyValue(v)) issues.push({ level: "error", nodeId: n.id, field: f.key, message: `"${f.label}" is required.` });
    }
  }
  return issues;
}
export function mergeIssues(local: ValidationIssue[], server: ValidationIssue[]): ValidationIssue[] {
  const key = (i: ValidationIssue) => `${i.level}|${i.nodeId ?? ""}|${i.field ?? ""}|${i.message}`;
  const exact = new Set(server.map(key));
  // a server issue for the same node + field supersedes the local wording
  const loose = new Set(server.filter((i) => i.nodeId && i.field).map((i) => `${i.nodeId}|${i.field}`));
  const out = [...server];
  for (const i of local) {
    if (exact.has(key(i))) continue;
    if (i.nodeId && i.field && loose.has(`${i.nodeId}|${i.field}`)) continue;
    exact.add(key(i));
    out.push(i);
  }
  return out;
}
/** Node ids reachable from a trigger, including the trigger (one API operation of the flow). */
export function operationNodes(triggerId: string, edges: FlowEdge[]): Set<string> {
  return reachableFrom(triggerId, edges.map((e) => ({ source: e.from, target: e.to })));
}
export function defResolver(byType: Map<string, NodeTypeDef>, edges: { fromPort?: string; from?: string }[] = [], nodes: { id: string; type: string }[] = []): (type: string) => NodeTypeDef {
  const cache = new Map<string, NodeTypeDef>();
  return (type: string) => {
    const hit = byType.get(type) ?? cache.get(type);
    if (hit) return hit;
    const ids = new Set(nodes.filter((n) => n.type === type).map((n) => n.id));
    const ports = edges.filter((e) => e.from && ids.has(e.from)).map((e) => e.fromPort || "out");
    const def = unknownType(type, ports);
    cache.set(type, def);
    return def;
  };
}
