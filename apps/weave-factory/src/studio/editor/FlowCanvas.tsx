// The flow canvas (React Flow): step nodes with typed ports, sticky notes, edges, drag and
// drop from the palette, keyboard shortcuts and the zoom / tidy controls.
import { createContext, memo, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import {
  Background, BackgroundVariant, BaseEdge, EdgeLabelRenderer, Handle, MiniMap, NodeToolbar, Panel, Position, ReactFlow, ReactFlowProvider,
  getBezierPath, useNodesInitialized, useReactFlow, useUpdateNodeInternals, type Connection, type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import { AlertCircle, AlertTriangle, Check, Copy, LayoutGrid, Maximize, Minus, Play, Plus, Power, Settings2, StickyNote, Trash2, X } from "lucide-react";
import type { NodeTypeDef, StepTrace } from "@traceit/weave-flow";
import { accentOf, portsFor } from "../catalog.ts";
import { NODE_W, nodeSummary, openingView, type WsNodeData } from "../graph.ts";
import { iconFor } from "../icons.ts";
import { useEditor, useEditorStore } from "../store.ts";
import { cx, fmtDuration, IconButton, toast } from "../ui.tsx";
import { useTheme } from "../../theme.tsx";
import { txt } from "../../lib/text.ts";
import { DND_NODE } from "./Palette.tsx";

export interface CanvasApi {
  /** Shows the whole flow, however small that makes it. */
  fit: () => void;
  /** The view a flow opens with: whole when it stays readable, otherwise its first step at a readable size. */
  open: () => void;
  focusNode: (id: string) => void;
  /** Pans (without zooming) so the step is on screen; does nothing when it already is. */
  ensureVisible: (id: string) => void;
  /** Shows a step that was just added: the whole flow when it stays readable, otherwise the step and what leads to it. */
  reveal: (id: string) => void;
  center: () => { x: number; y: number };
}
/** Below this zoom the step names can no longer be read. */
const READABLE_ZOOM = 0.62;
interface CanvasUi {
  defFor: (type: string) => NodeTypeDef;
  onOpen: (id: string) => void;
  onTest?: (id: string) => void;
  compact: boolean;
}
const Ui = createContext<CanvasUi>({ defFor: () => { throw new Error("no canvas"); }, onOpen: () => {}, compact: false });

function runOf(traces: StepTrace[] | undefined): { status: "success" | "error" | "skipped"; ms: number; count: number } | null {
  if (!traces?.length) return null;
  const ms = traces.reduce((a, t) => a + (Number(t.durationMs) || 0), 0);
  const status = traces.some((t) => t.status === "error") ? "error" : traces.every((t) => t.status === "skipped") ? "skipped" : "success";
  return { status, ms, count: traces.length };
}

// ---------------------------------------------------------------- step node
const StepNode = memo(function StepNode({ id, data, selected }: NodeProps) {
  const d = data as WsNodeData;
  const ui = useContext(Ui);
  const store = useEditorStore();
  const def = ui.defFor(d.type);
  const issues = useEditor((s) => s.issuesByNode[id]);
  const traces = useEditor((s) => s.tracesByNode[id]);
  const readOnly = useEditor((s) => s.readOnly);
  const single = useEditor((s) => s.selection.length === 1 && s.selection[0] === id);
  const ports = useMemo(() => portsFor(def, d.config), [def, d.config]);
  const portKey = ports.map((p) => p.id).join("|");
  const update = useUpdateNodeInternals();
  useEffect(() => { update(id); }, [portKey, id, update]);

  const Icon = iconFor(def.icon);
  const out = ports.find((p) => p.id === "out");
  const rows = ports.filter((p) => p.id !== "out");
  const errors = issues?.filter((i) => i.level === "error") ?? [];
  const warnings = issues?.filter((i) => i.level !== "error") ?? [];
  const run = runOf(traces);
  const summary = nodeSummary(d.type, d.config, def);
  return (
    <div
      className={cx("ws-node", selected && "ws-node-sel", d.disabled && "ws-node-off", run && `ws-node-${run.status}`, errors.length > 0 && "ws-node-invalid")}
      style={{ width: NODE_W, ["--acc" as string]: accentOf(def) }}
      data-node-name={d.name} data-node-type={d.type}
      onDoubleClick={() => ui.onOpen(id)}
    >
      <NodeToolbar isVisible={single} position={Position.Top} offset={10} className="ws-node-tools nodrag nopan">
        <IconButton label={readOnly ? "Show details" : "Configure step"} icon={Settings2} onClick={() => ui.onOpen(id)} />
        {!readOnly && ui.onTest && def.category !== "trigger" && <IconButton label="Test this step" icon={Play} onClick={() => ui.onTest!(id)} />}
        {!readOnly && <IconButton label={d.disabled ? "Enable step" : "Disable step"} icon={Power} active={!!d.disabled} onClick={() => store.toggleDisabled([id])} />}
        {!readOnly && <IconButton label="Duplicate step" icon={Copy} onClick={() => store.duplicate([id])} />}
        {!readOnly && <IconButton label="Delete step" icon={Trash2} tone="danger" onClick={() => store.remove([id])} />}
      </NodeToolbar>
      {def.hasInput && <Handle type="target" position={Position.Left} id="in" className="ws-handle ws-handle-in" />}
      <div className="ws-node-head">
        <span className="ws-node-icon"><Icon size={17} aria-hidden /></span>
        <span className="ws-node-text">
          <span className="ws-node-name">{txt(d.name) || txt(def.label)}</span>
          <span className="ws-node-sum">{summary || txt(def.label)}</span>
        </span>
        {out && <Handle type="source" position={Position.Right} id="out" className="ws-handle ws-handle-out" title={out.label} />}
      </div>
      {rows.length > 0 && (
        <div className="ws-node-ports">
          {rows.map((p) => (
            <div key={p.id} className={cx("ws-port", p.kind === "error" && "ws-port-err", p.kind === "branch" && "ws-port-branch")} data-port={p.id}>
              <span className="ws-port-label">{txt(p.label)}</span>
              <Handle type="source" position={Position.Right} id={p.id} className={cx("ws-handle ws-handle-out", p.kind === "error" && "ws-handle-err")} title={p.label} />
            </div>
          ))}
        </div>
      )}
      {(errors.length > 0 || warnings.length > 0) && (
        <span className={cx("ws-node-flag", errors.length ? "ws-node-flag-bad" : "ws-node-flag-warn")} title={(errors.length ? errors : warnings).map((i) => i.message).join("\n")} data-flag={errors.length ? "error" : "warning"}>
          {errors.length ? <AlertCircle size={13} aria-hidden /> : <AlertTriangle size={13} aria-hidden />}
          <span className="mf-sr">{errors.length ? `${errors.length} problem(s)` : `${warnings.length} warning(s)`}</span>
        </span>
      )}
      {run && (
        <span className={cx("ws-node-run", `ws-node-run-${run.status}`)} data-run={run.status}>
          {run.status === "error" ? <X size={11} aria-hidden /> : run.status === "skipped" ? <Minus size={11} aria-hidden /> : <Check size={11} aria-hidden />}
          {fmtDuration(run.ms)}{run.count > 1 ? ` · ${run.count}×` : ""}
        </span>
      )}
      {d.disabled && <span className="ws-node-offtag">Disabled</span>}
    </div>
  );
});

// ---------------------------------------------------------------- sticky note
const NoteNode = memo(function NoteNode({ id, data, selected }: NodeProps) {
  const d = data as WsNodeData;
  const store = useEditorStore();
  const readOnly = useEditor((s) => s.readOnly);
  const text = typeof d.config?.text === "string" ? d.config.text : "";
  return (
    <div className={cx("ws-note", selected && "ws-note-sel")} data-node-type="note">
      <div className="ws-note-bar"><StickyNote size={12} aria-hidden /> Note
        {!readOnly && selected && <button type="button" className="ws-note-del nodrag" aria-label="Delete note" onClick={() => store.remove([id])}><X size={12} /></button>}
      </div>
      {readOnly
        ? <p className="ws-note-text">{text || "(empty note)"}</p>
        : <textarea className="ws-note-input nodrag nowheel" aria-label="Note text" value={text} placeholder="Write a note for whoever opens this flow next" onChange={(e) => store.setConfig(id, "text", e.target.value)} rows={Math.min(12, Math.max(3, text.split("\n").length + 1))} />}
    </div>
  );
});

// ---------------------------------------------------------------- edge
const WsEdgeView = memo(function WsEdgeView({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, sourceHandleId, selected }: EdgeProps) {
  const store = useEditorStore();
  const readOnly = useEditor((s) => s.readOnly);
  const port = sourceHandleId || "out";
  const taken = useEditor((s) => {
    const from = s.tracesByNode[source];
    if (!from || !s.tracesByNode[target]) return false;
    return from.some((t) => (t.port ?? "out") === port);
  });
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const err = port === "error" || port === "catch";
  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={26} className={cx("ws-edge", err && "ws-edge-err", taken && "ws-edge-run", selected && "ws-edge-sel")} />
      {selected && !readOnly && (
        <EdgeLabelRenderer>
          <button type="button" className="ws-edge-del nodrag nopan" aria-label="Remove connection" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }} onClick={() => store.removeEdge(id)}>
            <X size={12} />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

const NODE_TYPES = { step: StepNode, note: NoteNode };
const EDGE_TYPES = { ws: WsEdgeView };
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest("input, textarea, select, [contenteditable='true'], .mf-modal, .mf-sheet, .mf-menu");

// ---------------------------------------------------------------- canvas
interface CanvasProps {
  defFor: (type: string) => NodeTypeDef;
  onOpenNode: (id: string) => void;
  onTestNode?: (id: string) => void;
  onAddStep?: () => void;
  /** right-click on a step: change it in your own words */
  onNodeMenu?: (id: string) => void;
  compact?: boolean;
  apiRef?: Ref<CanvasApi>;
  emptyHint?: React.ReactNode;
}
function CanvasInner({ defFor, onOpenNode, onTestNode, onAddStep, onNodeMenu, compact = false, apiRef, emptyHint }: CanvasProps) {
  const store = useEditorStore();
  const nodes = useEditor((s) => s.nodes);
  const edges = useEditor((s) => s.edges);
  const readOnly = useEditor((s) => s.readOnly);
  const { resolved } = useTheme();
  const rf = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);

  const fit = useCallback(() => { void rf.fitView({ padding: 0.12, duration: 260, maxZoom: 1.1 }); }, [rf]);
  // the whole flow when it stays readable at that size, otherwise its first step at a readable size
  const open = useCallback((animate = false) => {
    const r = wrap.current?.getBoundingClientRect();
    const st = store.getState();
    if (!r || !st.nodes.length) return;
    const box = (n: (typeof st.nodes)[number]) => ({ x: n.position.x, y: n.position.y, w: n.measured?.width ?? NODE_W, h: n.measured?.height ?? 70 });
    const targets = new Set(st.edges.map((e) => e.target));
    const first = st.nodes.filter((n) => n.type !== "note" && !targets.has(n.id)).sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)[0];
    const v = openingView(st.nodes.map(box), first ? box(first) : undefined, { width: r.width, height: r.height }, { readable: READABLE_ZOOM, zoom: compact ? 0.7 : 0.8 });
    if (v.mode === "start") void rf.setViewport({ x: v.x, y: v.y, zoom: v.zoom }, animate ? { duration: 260 } : undefined);
    else void rf.fitView({ padding: 0.18, maxZoom: 1.05, duration: animate ? 260 : 0 });
  }, [rf, store, compact]);
  const ready = useNodesInitialized();
  const opened = useRef(false);
  useEffect(() => {
    if (!ready || opened.current) return;
    opened.current = true;
    open();
  }, [ready, open]);
  // steps were laid out automatically after the canvas opened: show the flow again
  const arrangedAt = useEditor((s) => s.arrangedAt);
  useEffect(() => {
    if (!opened.current || !arrangedAt) return;
    const t = window.setTimeout(() => open(), 60);
    return () => window.clearTimeout(t);
  }, [arrangedAt, open]);
  useImperativeHandle(apiRef, () => ({
    fit,
    open: () => open(true),
    focusNode: (id: string) => {
      const n = store.getState().nodes.find((x) => x.id === id);
      if (!n) return;
      store.select([id]);
      void rf.setCenter(n.position.x + NODE_W / 2, n.position.y + (n.measured?.height ?? 70) / 2, { zoom: Math.max(rf.getZoom(), 0.9), duration: 260 });
    },
    ensureVisible: (id: string) => {
      const n = store.getState().nodes.find((x) => x.id === id);
      const r = wrap.current?.getBoundingClientRect();
      if (!n || !r) return;
      const h = n.measured?.height ?? 70;
      const a = rf.flowToScreenPosition({ x: n.position.x, y: n.position.y });
      const b = rf.flowToScreenPosition({ x: n.position.x + NODE_W, y: n.position.y + h });
      const m = 20;
      if (a.x >= r.left + m && a.y >= r.top + m + 44 && b.x <= r.right - m && b.y <= r.bottom - m) return;
      void rf.setCenter(n.position.x + NODE_W / 2, n.position.y + h / 2, { zoom: rf.getZoom(), duration: 220 });
    },
    reveal: (id: string) => {
      const all = store.getState().nodes;
      const n = all.find((x) => x.id === id);
      const r = wrap.current?.getBoundingClientRect();
      if (!n || !r || !all.length) return;
      const xs = all.map((x) => x.position.x), ys = all.map((x) => x.position.y);
      const bw = Math.max(...xs) + NODE_W - Math.min(...xs), bh = Math.max(...ys) + 90 - Math.min(...ys);
      const zoom = Math.min(r.width / (bw * 1.24), r.height / (bh * 1.24));
      if (zoom >= READABLE_ZOOM) { fit(); return; }
      // too large to show whole: keep the new step readable, a little right of the middle so the step before it stays in view
      const z = Math.min(Math.max(rf.getZoom(), 0.8), 1);
      void rf.setCenter(n.position.x + NODE_W / 2 - (r.width * 0.18) / z, n.position.y + (n.measured?.height ?? 70) / 2, { zoom: z, duration: 260 });
    },
    center: () => {
      const r = wrap.current?.getBoundingClientRect();
      return r ? rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 120, y: 120 };
    },
  }), [fit, open, rf, store]);

  // keyboard shortcuts (ignored while typing in a field or when a dialog is open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector(".mf-modal-scrim, .mf-sheet")) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if ((k === "delete" || k === "backspace") && !readOnly) { e.preventDefault(); store.removeSelected(); return; }
      if (!mod) return;
      if (k === "z" && !readOnly) { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); }
      else if (k === "y" && !readOnly) { e.preventDefault(); store.redo(); }
      else if (k === "c") { const n = store.copy(); if (n) toast(n === 1 ? "Step copied" : `${n} steps copied`, "info"); }
      else if (k === "v" && !readOnly) { if (store.paste()) e.preventDefault(); }
      else if (k === "d" && !readOnly) { e.preventDefault(); store.duplicate(store.getState().selection); }
      else if (k === "a") { e.preventDefault(); store.selectAll(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [store, readOnly]);

  // A browser scrolls even a clipped container to reveal a focused or clicked step that lies outside
  // the view. That would shift the whole canvas under its own controls, so any such scroll is undone
  // at once and the step is brought into view by moving the canvas instead.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onScroll = (e: Event) => {
      const t = e.target;
      if (!(t instanceof HTMLElement) || t.closest(".react-flow__node")) return;
      if (!t.scrollTop && !t.scrollLeft) return;
      t.scrollTop = 0; t.scrollLeft = 0;
      const id = document.activeElement?.closest?.(".react-flow__node")?.getAttribute("data-id");
      const n = id ? store.getState().nodes.find((x) => x.id === id) : undefined;
      if (n) void rf.setCenter(n.position.x + NODE_W / 2, n.position.y + (n.measured?.height ?? 70) / 2, { zoom: rf.getZoom(), duration: 200 });
    };
    el.addEventListener("scroll", onScroll, true);
    return () => el.removeEventListener("scroll", onScroll, true);
  }, [rf, store]);

  const onConnect = useCallback((c: Connection) => {
    const v = store.connect(c.source, c.sourceHandle, c.target);
    if (!v.ok) toast(v.reason, "bad");
  }, [store]);
  const isValid = useCallback((c: Connection | Edge) => !!c.source && !!c.target && store.verdict(c.source, c.sourceHandle || "out", c.target).ok, [store]);
  const onDrop = useCallback((e: React.DragEvent) => {
    const type = e.dataTransfer.getData(DND_NODE);
    if (!type) return;
    e.preventDefault();
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    store.addNode(type, { x: p.x - NODE_W / 2, y: p.y - 28 }, { connect: false });
  }, [rf, store]);
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes(DND_NODE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);
  const catalogRev = useEditor((s) => s.catalogRev);
  // a new object when the step definitions change, so every step redraws with them
  const ui = useMemo<CanvasUi>(() => ({ defFor, onOpen: onOpenNode, onTest: onTestNode, compact }), [defFor, onOpenNode, onTestNode, compact, catalogRev]);
  const commit = useCallback(() => store.commit(), [store]);

  return (
    <Ui.Provider value={ui}>
      <div className="ws-canvas" ref={wrap} onDrop={onDrop} onDragOver={onDragOver} data-readonly={readOnly ? "true" : "false"}>
        <ReactFlow
          nodes={nodes as unknown as Node[]} edges={edges as unknown as Edge[]}
          nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
          onNodesChange={store.onNodesChange} onEdgesChange={store.onEdgesChange}
          onConnect={onConnect} isValidConnection={isValid}
          onNodeDragStop={commit} onSelectionDragStop={commit}
          // Small screens have no room for a settings column: a tap on a step opens its settings as a sheet.
          onNodeContextMenu={onNodeMenu ? (e, n) => { if (n.type === "note") return; e.preventDefault(); onNodeMenu(n.id); } : undefined}
          onNodeClick={compact ? (e, n) => { if (n.type !== "note" && !e.shiftKey && !e.metaKey && !e.ctrlKey) onOpenNode(n.id); } : undefined}
          nodesDraggable={!readOnly} nodesConnectable={!readOnly} edgesFocusable={!readOnly} elementsSelectable
          deleteKeyCode={null} multiSelectionKeyCode={["Meta", "Control", "Shift"]} selectionKeyCode="Shift"
          connectOnClick connectionRadius={28}
          minZoom={0.2} maxZoom={1.8}
          colorMode={resolved === "dark" ? "dark" : "light"}
          proOptions={{ hideAttribution: true }}
          zoomOnDoubleClick={false}
          aria-label="Flow canvas"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} />
          {!compact && <MiniMap pannable zoomable className="ws-minimap" style={{ width: 168, height: 112 }} nodeStrokeWidth={2} nodeColor="var(--ws-edge)" maskColor="transparent" ariaLabel="Flow overview" />}
          <Panel position="bottom-left" className="ws-zoom">
            <IconButton label="Zoom out" icon={Minus} onClick={() => void rf.zoomOut({ duration: 160 })} />
            <IconButton label="Zoom in" icon={Plus} onClick={() => void rf.zoomIn({ duration: 160 })} />
            <IconButton label="Fit the flow on screen" icon={Maximize} onClick={fit} />
            {!readOnly && <IconButton label="Tidy up the layout" icon={LayoutGrid} onClick={() => { store.layout(); window.setTimeout(fit, 60); }} />}
          </Panel>
          {onAddStep && !readOnly && (
            <Panel position="top-left" className="ws-addpanel">
              <button type="button" className="mf-button mf-button-primary mf-button-sm" onClick={onAddStep}><Plus size={15} aria-hidden /><span>Add step</span></button>
            </Panel>
          )}
        </ReactFlow>
        {nodes.length === 0 && emptyHint && <div className="ws-canvas-empty">{emptyHint}</div>}
      </div>
    </Ui.Provider>
  );
}
export function FlowCanvas(props: CanvasProps) {
  return <ReactFlowProvider><CanvasInner {...props} /></ReactFlowProvider>;
}
