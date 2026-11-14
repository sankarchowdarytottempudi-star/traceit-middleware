// Editor state for one flow. A small external store (no library): the canvas keeps React Flow
// shaped nodes/edges, the Flow document is derived from them, undo/redo works on document
// snapshots. Components subscribe with useEditor(selector).
import { createContext, useContext, useSyncExternalStore } from "react";
import { applyEdgeChanges, applyNodeChanges, type EdgeChange, type NodeChange } from "@xyflow/react";
import type { Execution, Flow, FlowSettings, NodeTypeDef, StepTrace, ValidationIssue } from "@traceit/weave-flow";
import {
  autoLayout, canConnect, copySelection, createNode, estimateHeight, flowToGraph, graphToDoc, graphToFlow, localIssues, makeEdge,
  mergeIssues, pasteClip, pruneEdges, firstFreePort, toWsNode, NODE_W, NOTE_TYPE,
  type Clip, type ConnectVerdict, type FlowDoc, type WsEdge, type WsNode, type WsNodeData,
} from "./graph.ts";
import { canRedo, canUndo, historyInit, historyPush, historyRedo, historyUndo, type History } from "./history.ts";
import { portsFor, unknownType } from "./catalog.ts";

export interface EditorMeta { name: string; description?: string; tags?: string[]; settings: FlowSettings; }
interface Snapshot { doc: FlowDoc; meta: EditorMeta; }

export interface EditorState {
  base: Flow;
  meta: EditorMeta;
  nodes: WsNode[];
  edges: WsEdge[];
  readOnly: boolean;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** ids of selected nodes, in canvas order */
  selection: string[];
  /** bumps whenever the document (nodes, edges, meta) changes */
  version: number;
  issues: ValidationIssue[];
  issuesByNode: Record<string, ValidationIssue[]>;
  /** last test run shown on the canvas */
  run: Execution | null;
  tracesByNode: Record<string, StepTrace[]>;
  /** node whose configuration panel is open (small screens open it explicitly) */
  hasClipboard: boolean;
}

export const DEFAULT_SETTINGS: FlowSettings = { basePath: "/flow/v1", timeoutMs: 60000, logPayloads: true, gateway: { publish: true, security: "oauth2" } };

export function metaOf(flow: Flow): EditorMeta {
  const s = (flow.settings ?? {}) as Partial<FlowSettings>;
  return {
    name: flow.name ?? "", description: flow.description, tags: flow.tags,
    settings: { ...DEFAULT_SETTINGS, basePath: `/${flow.slug || "flow"}/v1`, ...s, gateway: { ...DEFAULT_SETTINGS.gateway, ...(s.gateway ?? {}) } },
  };
}
function groupIssues(issues: ValidationIssue[]): Record<string, ValidationIssue[]> {
  const out: Record<string, ValidationIssue[]> = {};
  for (const i of issues) if (i.nodeId) (out[i.nodeId] ??= []).push(i);
  return out;
}
function groupTraces(run: Execution | null): Record<string, StepTrace[]> {
  const out: Record<string, StepTrace[]> = {};
  for (const s of run?.steps ?? []) (out[s.nodeId] ??= []).push(s);
  return out;
}
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

let clipboard: Clip | null = null; // survives moving between flows in the same tab

export class EditorStore {
  private state: EditorState;
  private listeners = new Set<() => void>();
  private history: History<Snapshot>;
  private savedKey: string;
  private serverIssues: ValidationIssue[] = [];
  private byType = new Map<string, NodeTypeDef>();

  constructor(flow: Flow, opts: { readOnly?: boolean } = {}) {
    const g = flowToGraph(flow);
    const meta = metaOf(flow);
    const snap: Snapshot = { doc: graphToDoc(g.nodes, g.edges), meta };
    this.history = historyInit(snap);
    this.savedKey = JSON.stringify(snap);
    this.state = {
      base: flow, meta, nodes: g.nodes, edges: g.edges, readOnly: !!(opts.readOnly || flow.readOnly), dirty: false, canUndo: false, canRedo: false,
      selection: [], version: 0, issues: [], issuesByNode: {}, run: null, tracesByNode: {}, hasClipboard: !!clipboard,
    };
  }

  // ---- subscription
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getState = () => this.state;
  private set(patch: Partial<EditorState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // ---- catalog
  setCatalog(byType: Map<string, NodeTypeDef>) {
    this.byType = byType;
    this.refreshIssues();
  }
  defOf = (type: string): NodeTypeDef | undefined => this.byType.get(type);
  /** Never undefined: unknown types get a neutral definition so the canvas always renders. */
  defFor = (type: string): NodeTypeDef => {
    const hit = this.byType.get(type);
    if (hit) return hit;
    const ids = new Set(this.state.nodes.filter((n) => n.data.type === type).map((n) => n.id));
    return unknownType(type, this.state.edges.filter((e) => ids.has(e.source)).map((e) => e.sourceHandle || "out"));
  };

  // ---- document
  toFlow(): Flow {
    const s = this.state;
    return graphToFlow(s.base, s.meta, s.nodes, s.edges);
  }
  private snapshot(): Snapshot {
    return { doc: graphToDoc(this.state.nodes, this.state.edges), meta: this.state.meta };
  }
  private refreshIssues(extra: Partial<EditorState> = {}) {
    const local = this.byType.size ? localIssues(graphToDoc(extra.nodes ?? this.state.nodes, extra.edges ?? this.state.edges), this.defOf) : [];
    const issues = mergeIssues(local, this.serverIssues);
    this.set({ ...extra, issues, issuesByNode: groupIssues(issues) });
  }
  /** Records the current document as an undo step (no-op when nothing changed). */
  commit = (key?: string) => {
    const snap = this.snapshot();
    const k = JSON.stringify(snap);
    if (k === JSON.stringify(this.history.present)) return;
    this.history = historyPush(this.history, snap, key);
    this.serverIssues = this.serverIssues.filter((i) => !i.nodeId || snap.doc.nodes.some((n) => n.id === i.nodeId));
    this.refreshIssues({ dirty: k !== this.savedKey, canUndo: canUndo(this.history), canRedo: canRedo(this.history), version: this.state.version + 1 });
  };
  private restore(snap: Snapshot) {
    const g = flowToGraph(snap.doc, this.state.nodes);
    this.refreshIssues({
      nodes: g.nodes, edges: g.edges, meta: snap.meta, selection: [], dirty: JSON.stringify(snap) !== this.savedKey,
      canUndo: canUndo(this.history), canRedo: canRedo(this.history), version: this.state.version + 1,
    });
  }
  undo = () => { if (this.state.readOnly || !canUndo(this.history)) return; this.history = historyUndo(this.history); this.restore(this.history.present); };
  redo = () => { if (this.state.readOnly || !canRedo(this.history)) return; this.history = historyRedo(this.history); this.restore(this.history.present); };

  /** The server accepted a save: `flow` is the stored document (new revision). */
  markSaved(flow: Flow) {
    this.savedKey = JSON.stringify(this.snapshot());
    this.set({ base: { ...flow, readOnly: this.state.base.readOnly }, dirty: false });
  }
  /** Server-side fields changed without a save (deploy, undeploy). */
  setBase(patch: Partial<Flow>) { this.set({ base: { ...this.state.base, ...patch } }); }
  /** Replaces the document (restore a version, reload after a conflict). Undoable unless `asSaved`. */
  load(flow: Flow, opts: { asSaved?: boolean } = {}) {
    const g = flowToGraph(flow, this.state.nodes);
    const meta = metaOf(flow);
    if (opts.asSaved) {
      const snap: Snapshot = { doc: graphToDoc(g.nodes, g.edges), meta };
      this.history = historyInit(snap);
      this.savedKey = JSON.stringify(snap);
      this.serverIssues = [];
      this.refreshIssues({ base: flow, nodes: g.nodes, edges: g.edges, meta, selection: [], dirty: false, canUndo: false, canRedo: false, version: this.state.version + 1, run: null, tracesByNode: {} });
      return;
    }
    this.set({ nodes: g.nodes, edges: g.edges, meta, selection: [] });
    this.commit();
  }

  // ---- React Flow change handlers
  onNodesChange = (changes: NodeChange[]) => {
    const ro = this.state.readOnly;
    const allowed = ro ? changes.filter((c) => c.type === "select" || c.type === "dimensions") : changes;
    if (!allowed.length) return;
    const nodes = applyNodeChanges(allowed as NodeChange<never>[], this.state.nodes as never[]) as unknown as WsNode[];
    const removed = allowed.some((c) => c.type === "remove");
    const selection = nodes.filter((n) => n.selected).map((n) => n.id);
    const patch: Partial<EditorState> = { nodes };
    if (!sameIds(selection, this.state.selection)) patch.selection = selection;
    if (removed) {
      const ids = new Set(nodes.map((n) => n.id));
      patch.edges = this.state.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    }
    this.set(patch);
    if (removed) this.commit();
  };
  onEdgesChange = (changes: EdgeChange[]) => {
    const allowed = this.state.readOnly ? changes.filter((c) => c.type === "select") : changes;
    if (!allowed.length) return;
    this.set({ edges: applyEdgeChanges(allowed as EdgeChange<never>[], this.state.edges as never[]) as unknown as WsEdge[] });
    if (allowed.some((c) => c.type === "remove")) this.commit();
  };

  // ---- actions
  verdict(source: string, port: string, target: string): ConnectVerdict {
    return canConnect(this.state.nodes, this.state.edges, source, port, target, this.defOf);
  }
  connect(source: string, port: string | null | undefined, target: string): ConnectVerdict {
    if (this.state.readOnly) return { ok: false, reason: "This flow is read-only." };
    const p = port || "out";
    const v = this.verdict(source, p, target);
    if (!v.ok) return v;
    this.set({ edges: [...this.state.edges, makeEdge(source, p, target, this.state.edges)] });
    this.commit();
    return v;
  }
  removeEdge(id: string) {
    if (this.state.readOnly) return;
    this.set({ edges: this.state.edges.filter((e) => e.id !== id) });
    this.commit();
  }
  /** Adds a step. Without a position it is placed after the selected step and connected to it. */
  addNode(type: string, position?: { x: number; y: number }, opts: { connect?: boolean } = {}): string | null {
    if (this.state.readOnly) return null;
    const def = this.defOf(type);
    if (!def) return null;
    const { nodes, edges } = this.state;
    const sel = nodes.filter((n) => n.selected && n.type === "step");
    const anchor = sel.length === 1 ? sel[0] : undefined;
    let pos = position;
    let chain: { from: WsNode; port: string } | null = null;
    if (anchor && def.hasInput && opts.connect !== false) {
      const port = firstFreePort(anchor, edges, this.defOf(anchor.data.type));
      if (port) chain = { from: anchor, port };
    }
    if (!pos) {
      if (anchor) {
        const kids = edges.filter((e) => e.source === anchor.id).length;
        pos = { x: anchor.position.x + NODE_W + 68, y: anchor.position.y + kids * 96 };
      } else {
        const steps = nodes.filter((n) => n.type === "step");
        const maxX = steps.length ? Math.max(...steps.map((n) => n.position.x)) : -240;
        const minY = steps.length ? Math.min(...steps.map((n) => n.position.y)) : 80;
        pos = def.type === NOTE_TYPE ? { x: 80, y: minY - 150 } : { x: maxX + NODE_W + 68, y: steps.length ? minY : 80 };
      }
    }
    const fn = createNode(def, pos, nodes.map((n) => ({ id: n.id, name: n.data.name })));
    const ws = toWsNode(fn);
    ws.selected = true;
    const nextNodes = [...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ws];
    const nextEdges = chain && canConnect(nextNodes, edges, chain.from.id, chain.port, ws.id, this.defOf).ok ? [...edges, makeEdge(chain.from.id, chain.port, ws.id, edges)] : edges;
    this.set({ nodes: nextNodes, edges: nextEdges, selection: [ws.id] });
    this.commit();
    return ws.id;
  }
  updateNode(id: string, patch: Partial<WsNodeData>, key?: string) {
    if (this.state.readOnly) return;
    let touched = false;
    const nodes = this.state.nodes.map((n) => {
      if (n.id !== id) return n;
      touched = true;
      return { ...n, data: { ...n.data, ...patch } };
    });
    if (!touched) return;
    const node = nodes.find((n) => n.id === id)!;
    const def = this.defOf(node.data.type);
    const edges = patch.config && def?.dynamicPorts ? pruneEdges(nodes, this.state.edges, this.defOf) : this.state.edges;
    this.set({ nodes, edges });
    this.commit(key);
  }
  setConfig(id: string, field: string, value: unknown) {
    const node = this.state.nodes.find((n) => n.id === id);
    if (!node) return;
    const config = { ...node.data.config };
    if (value === undefined) delete config[field]; else config[field] = value;
    this.updateNode(id, { config }, `cfg:${id}:${field}`);
  }
  select(ids: string[]) {
    const set = new Set(ids);
    this.set({
      nodes: this.state.nodes.map((n) => (!!n.selected === set.has(n.id) ? n : { ...n, selected: set.has(n.id) })),
      edges: this.state.edges.map((e) => (e.selected ? { ...e, selected: false } : e)),
      selection: this.state.nodes.filter((n) => set.has(n.id)).map((n) => n.id),
    });
  }
  selectAll() { this.select(this.state.nodes.map((n) => n.id)); }
  remove(ids: string[]) {
    if (this.state.readOnly || !ids.length) return;
    const set = new Set(ids);
    this.set({
      nodes: this.state.nodes.filter((n) => !set.has(n.id)),
      edges: this.state.edges.filter((e) => !set.has(e.source) && !set.has(e.target)),
      selection: this.state.selection.filter((i) => !set.has(i)),
    });
    this.commit();
  }
  removeSelected() {
    if (this.state.readOnly) return;
    const edgeSel = this.state.edges.filter((e) => e.selected).map((e) => e.id);
    if (edgeSel.length) this.set({ edges: this.state.edges.filter((e) => !e.selected) });
    if (this.state.selection.length) this.remove(this.state.selection); else this.commit();
  }
  toggleDisabled(ids: string[]) {
    if (this.state.readOnly || !ids.length) return;
    const set = new Set(ids);
    const anyEnabled = this.state.nodes.some((n) => set.has(n.id) && !n.data.disabled);
    this.set({ nodes: this.state.nodes.map((n) => (set.has(n.id) && n.type === "step" ? { ...n, data: { ...n.data, disabled: anyEnabled || undefined } } : n)) });
    this.commit();
  }
  copy(): number {
    const clip = copySelection(this.state.nodes, this.state.edges);
    if (!clip) return 0;
    clipboard = clip;
    this.set({ hasClipboard: true });
    return clip.nodes.length;
  }
  paste(offset = { x: 48, y: 48 }): number {
    if (this.state.readOnly || !clipboard) return 0;
    const r = pasteClip(clipboard, this.state.nodes, this.state.edges, offset);
    // shift the clipboard so repeated pastes cascade instead of stacking
    clipboard = { nodes: clipboard.nodes.map((n) => ({ ...n, position: { x: n.position.x + offset.x, y: n.position.y + offset.y } })), edges: clipboard.edges };
    this.set({ nodes: r.nodes, edges: r.edges, selection: r.added });
    this.commit();
    return r.added.length;
  }
  duplicate(ids: string[]): number {
    if (this.state.readOnly || !ids.length) return 0;
    const set = new Set(ids);
    const clip = copySelection(this.state.nodes.map((n) => ({ ...n, selected: set.has(n.id) })), this.state.edges);
    if (!clip) return 0;
    const r = pasteClip(clip, this.state.nodes, this.state.edges, { x: 40, y: 72 });
    this.set({ nodes: r.nodes, edges: r.edges, selection: r.added });
    this.commit();
    return r.added.length;
  }
  /** Tidies the canvas left to right. */
  layout() {
    if (this.state.readOnly) return;
    this.set({ nodes: this.arranged() });
    this.commit();
  }
  /** Layout positions without recording history (used for read-only views that carry no positions). */
  arranged(): WsNode[] {
    const { nodes, edges } = this.state;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const pos = autoLayout(
      nodes.map((n) => ({ id: n.id, isNote: n.type === "note" })),
      edges.map((e) => ({ source: e.source, target: e.target, port: e.sourceHandle || "out" })),
      (id) => { const n = byId.get(id); return n ? portsFor(this.defFor(n.data.type), n.data.config).map((p) => p.id) : []; },
      { heightOf: (id) => { const n = byId.get(id); return n?.measured?.height ?? (n ? estimateHeight(this.defFor(n.data.type), n.data.config) : 72); } },
    );
    return nodes.map((n) => (pos.has(n.id) ? { ...n, position: pos.get(n.id)! } : n));
  }
  setNodes(nodes: WsNode[]) { this.set({ nodes }); }
  setMeta(patch: Partial<EditorMeta>, key = "meta") {
    if (this.state.readOnly) return;
    this.set({ meta: { ...this.state.meta, ...patch } });
    this.commit(key);
  }
  setSettings(patch: Partial<FlowSettings>, key = "settings") {
    this.setMeta({ settings: { ...this.state.meta.settings, ...patch, gateway: { ...this.state.meta.settings.gateway, ...(patch.gateway ?? {}) } } }, key);
  }

  // ---- validation and runs
  setServerIssues(issues: ValidationIssue[]) {
    this.serverIssues = Array.isArray(issues) ? issues : [];
    this.refreshIssues();
  }
  setRun(run: Execution | null) { this.set({ run, tracesByNode: groupTraces(run) }); }
  /** Result of testing a single step: shown on that node without discarding the last full run. */
  setNodeRun(step: StepTrace) {
    this.set({ tracesByNode: { ...this.state.tracesByNode, [step.nodeId]: [step] } });
  }
}

// ---- React bindings
export const EditorContext = createContext<EditorStore | null>(null);
export function useEditorStore(): EditorStore {
  const s = useContext(EditorContext);
  if (!s) throw new Error("Editor store is not available here");
  return s;
}
/** Subscribes to a slice of the editor state. The selector must return a stable value
 *  (a primitive or a reference held in the state), not a freshly built object. */
export function useEditor<T>(selector: (s: EditorState) => T): T {
  const store = useEditorStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}
export function useOptionalEditor<T>(selector: (s: EditorState) => T, fallback: T): T {
  const store = useContext(EditorContext);
  return useSyncExternalStore(store ? store.subscribe : noSub, () => (store ? selector(store.getState()) : fallback));
}
const noSub = () => () => {};
