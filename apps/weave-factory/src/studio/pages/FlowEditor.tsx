// The flow editor: canvas with palette and step settings, plus Mappings, Connections,
// Executions, Logs, Versions and Settings for the same flow.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ArrowLeftRight, Copy, Download, FlaskConical, History, LayoutGrid, MoreHorizontal, PenLine, Plug, Redo2, Rocket, Save, ScrollText, Settings, Trash2, Undo2, Workflow } from "lucide-react";
import type { Execution, Flow, HttpRequestSample, Json } from "@traceit/weave-flow";
import { ApiError, errorText, isUnavailable, studioApi } from "../api.ts";
import { useCatalog, type Catalog } from "../catalog.ts";
import { mappingOf } from "../graph.ts";
import { contextForNode } from "../runctx.ts";
import { EditorContext, EditorStore, useEditor, useEditorStore } from "../store.ts";
import { Button, Callout, confirmDialog, cx, downloadJson, Empty, IconButton, Menu, Modal, Sheet, Spinner, Tabs, toast, useBreakpoint, useDebounced, useDocumentTitle, type MenuItem, type TabDef } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { DeployDialog, deploymentBadge, IssueList } from "../editor/DeployDialog.tsx";
import { ExecutionsList, LogsView, Unreachable } from "../editor/Executions.tsx";
import { FlowCanvas, type CanvasApi } from "../editor/FlowCanvas.tsx";
import { MapperDialog } from "../editor/Mapper.tsx";
import { NodePanel } from "../editor/NodePanel.tsx";
import { Palette } from "../editor/Palette.tsx";
import { ConnectionsTab, MappingsTab, SettingsTab, VersionsTab } from "../editor/tabs.tsx";
import { TestPanel } from "../editor/TestPanel.tsx";
import { DescribeDialog } from "../editor/DescribeDialog.tsx";
import { EditDialog } from "../editor/EditDialog.tsx";
import type { EditTarget } from "@traceit/weave-flow";

type TabId = "canvas" | "mappings" | "connections" | "executions" | "logs" | "versions" | "settings";
const TAB_IDS: TabId[] = ["canvas", "mappings", "connections", "executions", "logs", "versions", "settings"];

/** Asks before leaving with unsaved changes: closing the tab and following a link inside the app. */
export function useUnsavedGuard(dirty: boolean) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!dirty) return;
    const before = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download") || a.origin !== window.location.origin) return;
      if (a.pathname === window.location.pathname) return;
      e.preventDefault(); e.stopPropagation();
      void confirmDialog({ title: "Leave without saving?", body: "This flow has changes that are not saved yet. They will be lost if you leave.", confirmLabel: "Leave", cancelLabel: "Stay", danger: true })
        .then((ok) => { if (ok) { window.removeEventListener("beforeunload", before); navigate(a.pathname + a.search + a.hash); } });
    };
    window.addEventListener("beforeunload", before);
    document.addEventListener("click", click, true);
    return () => { window.removeEventListener("beforeunload", before); document.removeEventListener("click", click, true); };
  }, [dirty, navigate]);
}

export function FlowEditorPage() {
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: ["studio", "flow", id], queryFn: () => studioApi.flow(id), retry: 0, refetchOnWindowFocus: false, staleTime: Infinity, gcTime: 0 });
  useDocumentTitle(q.data?.name ? `${q.data.name} · Flows` : "Flows");
  if (q.isLoading) return <div className="ws-editor ws-editor-msg"><Spinner label="Opening the flow…" /></div>;
  if (q.isError || !q.data) {
    const missing = q.error instanceof ApiError && q.error.status === 404 && !/unreachable|upstream/i.test(q.error.message);
    return (
      <div className="ws-editor ws-editor-msg">
        {missing
          ? <Empty icon={Workflow} title="This flow does not exist" hint="It may have been deleted, or the link is wrong." action={<Link className="mf-button mf-button-primary" to="/studio">Back to flows</Link>} />
          : <div style={{ maxWidth: 560, width: "100%" }} className="mf-stack"><Unreachable error={q.error} what="This flow" onRetry={() => void q.refetch()} /><div><Link className="mf-linkbtn" to="/studio">Back to flows</Link></div></div>}
      </div>
    );
  }
  return <Editor key={`${q.data.id}:${q.dataUpdatedAt}`} flow={q.data} />;
}

/** The mapper of one step. Its sample input is what the step's "Input" expression produced in the last test run. */
function MapperHost({ nodeId, fieldKey, sample, examples, onClose }: { nodeId: string; fieldKey: string; sample: HttpRequestSample | null; examples: string[]; onClose: () => void }) {
  const store = useEditorStore();
  const node = useEditor((s) => s.nodes.find((n) => n.id === nodeId));
  const graph = useEditor((s) => s.nodes);
  const run = useEditor((s) => s.run);
  const traces = useEditor((s) => s.tracesByNode);
  const own = traces[nodeId]?.[0];
  const inputExpr = typeof node?.data.config.input === "string" ? node.data.config.input.trim() : "";
  const context = useMemo(() => (own ? contextForNode(run, traces, nodeId, sample, graph) : null), [own, run, traces, nodeId, sample, graph]);
  const computed = !!own && !!context && !!inputExpr && inputExpr !== "$";
  const q = useQuery({
    queryKey: ["studio", "mapper-input", nodeId, inputExpr, own?.seq ?? 0, run?.id ?? ""],
    queryFn: () => studioApi.evalExpr(inputExpr, context!),
    enabled: computed, retry: 0, staleTime: 60_000,
  });
  if (!node) return null;
  const lastInput = !own ? undefined : computed ? (q.data?.ok ? (q.data.result as Json | undefined) : undefined) : (own.input as Json | undefined);
  return (
    <MapperDialog title={`Mapping: ${txt(node.data.name)}`} spec={mappingOf(node.data.config[fieldKey])} onChange={(s) => store.setConfig(nodeId, fieldKey, s)} onClose={onClose}
      lastInput={lastInput} examples={examples} />
  );
}

function Editor({ flow }: { flow: Flow }) {
  const catalog = useCatalog();
  const latest = useRef(catalog.byType);
  latest.current = catalog.byType;
  // the store knows the step definitions before its first render, so no view starts from "unknown step"
  const store = useMemo(() => { const s = new EditorStore(flow); s.setCatalog(latest.current); return s; }, [flow]);
  const arranged = useRef<EditorStore | null>(null);
  useEffect(() => {
    store.setCatalog(catalog.byType);
    // a flow whose steps were never placed (an import, a copy of a migrated service) is laid out once on opening
    if (catalog.byType.size && arranged.current !== store) { arranged.current = store; store.arrangeIfNeeded(); }
  }, [store, catalog.byType]);
  return <EditorContext.Provider value={store}><EditorInner store={store} catalog={catalog} /></EditorContext.Provider>;
}

function EditorInner({ store, catalog }: { store: EditorStore; catalog: Catalog }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const bp = useBreakpoint();
  const [params, setParams] = useSearchParams();
  const base = useEditor((s) => s.base);
  const meta = useEditor((s) => s.meta);
  const dirty = useEditor((s) => s.dirty);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const selection = useEditor((s) => s.selection);
  const issues = useEditor((s) => s.issues);
  const version = useEditor((s) => s.version);
  const nodes = useEditor((s) => s.nodes);
  const flowId = base.id;
  const tabParam = params.get("tab") as TabId | null;
  const tab: TabId = tabParam && TAB_IDS.includes(tabParam) ? tabParam : "canvas";
  const openExecution = params.get("execution");
  const setTab = useCallback((t: TabId, extra?: Record<string, string | null>) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (t === "canvas") n.delete("tab"); else n.set("tab", t);
      if (t !== "executions") n.delete("execution");
      for (const [k, v] of Object.entries(extra ?? {})) { if (v === null) n.delete(k); else n.set(k, v); }
      return n;
    }, { replace: true });
  }, [setParams]);

  const canvasApi = useRef<CanvasApi>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteHidden, setPaletteHidden] = useState(false);
  const [openNode, setOpenNode] = useState<string | null>(null);      // small screens: explicit
  const [closedFor, setClosedFor] = useState<string | null>(null);    // desktop: panel dismissed for this node
  const [testOpen, setTestOpen] = useState(false);
  const [nodeTarget, setNodeTarget] = useState<string | null>(null);
  const [mapper, setMapper] = useState<{ nodeId: string; fieldKey: string } | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const [describeOpen, setDescribeOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const desktop = bp === "desktop";
  /** While testing, the list of steps makes room for the canvas and the results. */
  const paletteOff = paletteHidden || testOpen;
  const single = selection.length === 1 ? selection[0] : null;
  const panelNode = desktop ? (single && closedFor !== single ? single : null) : openNode && nodes.some((n) => n.id === openNode) ? openNode : null;
  useEffect(() => { if (closedFor && single !== closedFor) setClosedFor(null); }, [single, closedFor]);

  useUnsavedGuard(dirty);

  // ---- save
  const saving = useRef(false);
  const [busySave, setBusySave] = useState(false);
  const save = useCallback(async (): Promise<Flow | null> => {
    if (saving.current) return null;
    const doc = store.toFlow();
    if (!doc.name.trim()) { toast("Give the flow a name before saving.", "bad"); return null; }
    saving.current = true; setBusySave(true);
    try {
      const saved = await studioApi.saveFlow(doc);
      store.markSaved(saved);
      void qc.invalidateQueries({ queryKey: ["studio", "flows"] });
      toast("Saved.");
      return saved;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setConflict(true); return null; }
      if (e instanceof ApiError && e.issues?.length) store.setServerIssues(e.issues);
      toast(isUnavailable(e) ? `Not saved: the flow engine cannot be reached. Your changes are still here. ${errorText(e)}` : `Not saved: ${errorText(e)}`, "bad");
      return null;
    } finally { saving.current = false; setBusySave(false); }
  }, [store, qc]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (store.getState().dirty) void save(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [save, store]);
  const resolveConflict = useMutation({
    mutationFn: async (mode: "mine" | "theirs") => {
      const latest = await studioApi.flow(flowId);
      if (mode === "theirs") { store.load(latest, { asSaved: true }); return "theirs" as const; }
      store.setBase({ revision: latest.revision, deployment: latest.deployment });
      return "mine" as const;
    },
    onSuccess: async (mode) => { setConflict(false); if (mode === "mine") await save(); else toast("Loaded the latest saved version.", "info"); },
    onError: (e) => toast(errorText(e), "bad"),
  });

  // ---- server-side validation (the local checks already run inside the store)
  const debouncedVersion = useDebounced(version, 800);
  useEffect(() => {
    let cancelled = false;
    studioApi.validate(store.toFlow()).then((r) => { if (!cancelled) store.setServerIssues(r.issues ?? []); }).catch(() => { /* engine unreachable: local checks still apply */ });
    return () => { cancelled = true; };
  }, [debouncedVersion, store]);

  // ---- actions
  const showNode = useCallback((id: string) => {
    setTab("canvas");
    window.setTimeout(() => { canvasApi.current?.focusNode(id); if (!desktop) setOpenNode(id); }, 60);
  }, [setTab, desktop]);
  const addStep = useCallback((type: string) => {
    const id = store.addNode(type, undefined, { connect: true });
    setPaletteOpen(false);
    if (id) window.setTimeout(() => canvasApi.current?.reveal(id), 80);
  }, [store]);
  const openNodePanel = useCallback((id: string) => { store.select([id]); setClosedFor(null); setOpenNode(id); }, [store]);
  // the canvas changes size when the test area or the step settings open: keep what matters on screen
  const firstLayout = useRef(true);
  useEffect(() => {
    if (firstLayout.current) { firstLayout.current = false; return; }
    if (tab !== "canvas" || bp === "phone") return;
    const t = window.setTimeout(() => canvasApi.current?.open(), 140);
    return () => window.clearTimeout(t);
  }, [testOpen]);
  useEffect(() => {
    if (!desktop || !panelNode || tab !== "canvas") return;
    const t = window.setTimeout(() => canvasApi.current?.ensureVisible(panelNode), 140);
    return () => window.clearTimeout(t);
  }, [panelNode, desktop]);
  const testNode = useCallback((id: string) => { setNodeTarget(id); setTestOpen(true); if (!desktop) setOpenNode(null); }, [desktop]);
  const openMapper = useCallback((nodeId: string, fieldKey: string) => setMapper({ nodeId, fieldKey }), []);
  const showExecutionOnCanvas = useCallback((x: Execution) => { store.setRun(x); setTab("canvas"); setTestOpen(true); setNodeTarget(null); }, [store, setTab]);
  const duplicate = useMutation({
    mutationFn: () => studioApi.duplicateFlow(flowId, `${meta.name} copy`),
    onSuccess: (f) => { void qc.invalidateQueries({ queryKey: ["studio", "flows"] }); toast("Copy created."); navigate(`/studio/flows/${encodeURIComponent(f.id)}`); },
    onError: (e) => toast(errorText(e), "bad"),
  });
  const remove = useMutation({
    mutationFn: () => studioApi.deleteFlow(flowId),
    onSuccess: () => { store.markSaved(store.toFlow()); void qc.invalidateQueries({ queryKey: ["studio", "flows"] }); toast("Flow deleted.", "info"); window.setTimeout(() => navigate("/studio"), 0); },
    onError: (e) => toast(errorText(e), "bad"),
  });
  const askDelete = async () => {
    if (await confirmDialog({ title: `Delete "${meta.name}"?`, body: base.deployment?.status === "deployed" ? "It is live: it will be taken offline and removed, with its history. This cannot be undone." : "The flow and its history are removed. This cannot be undone.", confirmLabel: "Delete", danger: true })) remove.mutate();
  };
  const tidy = () => { setTab("canvas"); store.layout(); window.setTimeout(() => canvasApi.current?.fit(), 80); };

  const errors = issues.filter((i) => i.level === "error").length;
  const catalogRev = useEditor((x) => x.catalogRev);
  const mappingCount = useMemo(() => nodes.filter((n) => store.defFor(n.data.type).fields.some((f) => f.kind === "mapping")).length, [nodes, store, catalogRev]);
  const tabs: TabDef<TabId>[] = [
    { id: "canvas", label: "Canvas", icon: Workflow },
    { id: "mappings", label: "Mappings", icon: ArrowLeftRight, count: mappingCount },
    { id: "connections", label: "Connections", icon: Plug },
    { id: "executions", label: "Executions", icon: History },
    { id: "logs", label: "Logs", icon: ScrollText },
    { id: "versions", label: "Versions", icon: Copy },
    { id: "settings", label: "Settings", icon: Settings },
  ];
  const more: MenuItem[] = [
    ...(bp !== "desktop" ? [
      { id: "undo", label: "Undo", icon: Undo2, onSelect: store.undo, disabled: !canUndo },
      { id: "redo", label: "Redo", icon: Redo2, onSelect: store.redo, disabled: !canRedo },
      { id: "issues", label: issues.length ? `Problems (${issues.length})` : "No problems found", icon: AlertTriangle, onSelect: () => setIssuesOpen(true), disabled: !issues.length },
    ] : []),
    { id: "describe", label: "Add steps from a description", icon: PenLine, onSelect: () => setDescribeOpen(true), divider: bp !== "desktop" },
    ...(base.readOnly ? [] : [{ id: "change-words", label: "Change this flow in your own words", icon: PenLine, onSelect: () => setEditTarget({ kind: "flow" }) }]),
    { id: "tidy", label: "Tidy up the layout", icon: LayoutGrid, onSelect: tidy },
    { id: "dup", label: "Make a copy", icon: Copy, onSelect: () => duplicate.mutate() },
    { id: "export", label: "Export as a file", icon: Download, onSelect: () => downloadJson(`${base.slug || "flow"}.flow.json`, store.toFlow()) },
    { id: "delete", label: "Delete flow", icon: Trash2, danger: true, onSelect: () => void askDelete(), divider: true },
  ];
  const trigger = nodes.find((n) => n.data.type === "trigger.http");
  const sample = (trigger?.data.config.sampleRequest ?? null) as HttpRequestSample | null;
  const mapperNode = mapper ? nodes.find((n) => n.id === mapper.nodeId) : undefined;
  const live = base.deployment?.status === "deployed";

  const panel = panelNode && (
    <NodePanel nodeId={panelNode} catalog={catalog} defFor={store.defFor} sample={sample} onOpenMapper={openMapper} onTest={testNode} onChangeInWords={base.readOnly ? undefined : (id) => setEditTarget({ kind: "node", nodeId: id })}
      onClose={() => { if (desktop) setClosedFor(panelNode); else setOpenNode(null); }} />
  );
  const test = testOpen && (
    <TestPanel flowId={flowId} nodeTarget={nodeTarget && nodes.some((n) => n.id === nodeTarget) ? nodeTarget : null} onNodeTarget={setNodeTarget}
      onShowNode={(id) => { canvasApi.current?.focusNode(id); if (!desktop && bp !== "phone") setOpenNode(id); }} onClose={() => setTestOpen(false)} layout={bp === "phone" ? "sheet" : "dock"} />
  );

  return (
    <div className="ws-editor" data-testid="flow-editor" data-flow-id={flowId} data-dirty={dirty ? "true" : "false"} data-revision={base.revision}>
      <header className="ws-bar">
        <Link to="/studio" className="mf-iconbtn" aria-label="Back to flows" title="Back to flows"><ArrowLeft size={17} aria-hidden /></Link>
        <div className="ws-bar-title">
          <input className="ws-bar-name" aria-label="Flow name" value={meta.name} onChange={(e) => store.setMeta({ name: e.target.value }, "meta-name")} />
          <span className="ws-bar-state">
            {deploymentBadge(base.deployment, live && (dirty || base.deployment!.revision !== base.revision))}
            <span className={cx("ws-bar-dirty", dirty && "ws-bar-dirty-on")} data-testid="save-state">{dirty ? "Unsaved changes" : "All changes saved"}</span>
          </span>
        </div>
        <div className="ws-bar-actions">
          {desktop && <>
            <IconButton label="Undo" icon={Undo2} disabled={!canUndo} onClick={store.undo} />
            <IconButton label="Redo" icon={Redo2} disabled={!canRedo} onClick={store.redo} />
            <button type="button" className={cx("ws-issuebtn", errors > 0 ? "ws-issuebtn-bad" : issues.length > 0 ? "ws-issuebtn-warn" : "ws-issuebtn-ok")} onClick={() => setIssuesOpen(true)} disabled={!issues.length} data-testid="issues-button" data-issue-count={issues.length}>
              <AlertTriangle size={14} aria-hidden /><span>{issues.length ? `${issues.length} problem${issues.length === 1 ? "" : "s"}` : "No problems"}</span>
            </button>
          </>}
          <Button icon={FlaskConical} onClick={() => { setTab("canvas"); setNodeTarget(null); setTestOpen((o) => tab !== "canvas" ? true : !o); }} data-action="test" aria-pressed={testOpen} className={cx(bp === "phone" && "ws-iconly")} aria-label="Test">{bp === "phone" ? null : "Test"}</Button>
          <Button icon={Save} busy={busySave} disabled={!dirty} onClick={() => void save()} data-action="save" className={cx(bp === "phone" && "ws-iconly")} aria-label="Save">{bp === "phone" ? null : "Save"}</Button>
          <Button variant="primary" icon={Rocket} onClick={() => setDeployOpen(true)} data-action="open-deploy" className={cx(bp === "phone" && "ws-iconly")} aria-label={live ? "Deployment" : "Deploy"}>{bp === "phone" ? null : live ? "Deployment" : "Deploy"}</Button>
          <Menu label="More actions" items={more} trigger={(p) => <IconButton label="More actions" icon={MoreHorizontal} {...p} />} />
        </div>
      </header>
      <Tabs tabs={tabs} value={tab} onChange={(t) => setTab(t)} label="Flow sections" className="ws-editor-tabs" />

      {tab === "canvas" && (
        <div className={cx("ws-body", desktop && !paletteOff && "ws-body-palette", desktop && panelNode && "ws-body-panel")}>
          {desktop && !paletteOff && <aside className="ws-side ws-side-left" aria-label="Steps you can add"><Palette catalog={catalog} onAdd={addStep} /></aside>}
          <div className="ws-center">
            <div className="ws-canvaswrap">
              <FlowCanvas apiRef={canvasApi} defFor={store.defFor} onOpenNode={openNodePanel} onTestNode={testNode} onNodeMenu={base.readOnly ? undefined : (id) => setEditTarget({ kind: "node", nodeId: id })} compact={!desktop}
                onAddStep={desktop && !paletteOff ? undefined : () => { if (desktop) { setPaletteHidden(false); setTestOpen(false); } else setPaletteOpen(true); }}
                emptyHint={<Empty icon={Workflow} title="Start with a trigger" hint={desktop ? "Drag a step from the left onto the canvas, or click one to add it. A flow starts with a trigger, for example an HTTP Listener." : "Tap Add step and choose a trigger, for example an HTTP Listener."} />} />
              {desktop && !paletteOff && <button type="button" className="ws-side-toggle" onClick={() => setPaletteHidden(true)} aria-label="Hide the list of steps" title="Hide the list of steps">‹</button>}
            </div>
            {test && bp !== "phone" && <div className="ws-dock">{test}</div>}
          </div>
          {desktop && panelNode && <aside className="ws-side ws-side-right" aria-label="Step settings">{panel}</aside>}
        </div>
      )}
      {tab !== "canvas" && (
        <div className="ws-tabpage">
          <div className="ws-tabpage-in">
            {tab === "mappings" && <MappingsTab defFor={store.defFor} onOpenMapper={openMapper} onShowNode={showNode} />}
            {tab === "connections" && <ConnectionsTab defFor={store.defFor} onShowNode={showNode} />}
            {tab === "executions" && <ExecutionsList flowId={flowId} openId={openExecution} onOpen={(id) => setTab("executions", { execution: id })} onShowOnCanvas={showExecutionOnCanvas} />}
            {tab === "logs" && <LogsView flowId={flowId} onOpenExecution={(id) => setTab("executions", { execution: id })} />}
            {tab === "versions" && <VersionsTab flowId={flowId} onRestored={() => setTab("canvas")} />}
            {tab === "settings" && <SettingsTab onDelete={() => void askDelete()} />}
          </div>
        </div>
      )}

      {!desktop && paletteOpen && <Sheet title="Add a step" side={bp === "phone" ? "bottom" : "left"} width={340} onClose={() => setPaletteOpen(false)}><Palette catalog={catalog} onAdd={addStep} /></Sheet>}
      {!desktop && panelNode && tab === "canvas" && <Sheet title="Step settings" side={bp === "phone" ? "bottom" : "right"} width={440} onClose={() => setOpenNode(null)}>{panel}</Sheet>}
      {test && bp === "phone" && tab === "canvas" && <Sheet title="Test" side="bottom" onClose={() => setTestOpen(false)}>{test}</Sheet>}

      {mapper && mapperNode && <MapperHost nodeId={mapper.nodeId} fieldKey={mapper.fieldKey} sample={sample} examples={catalog.instructionExamples} onClose={() => setMapper(null)} />}
      {editTarget && <EditDialog flow={base} target={editTarget} dirty={dirty} onClose={() => setEditTarget(null)} onApplied={(r) => { if (r.flow) store.load(r.flow, { asSaved: true }); void qc.invalidateQueries({ queryKey: ["studio", "flows"] }); }} />}
      {describeOpen && <DescribeDialog mode="add" onClose={() => setDescribeOpen(false)} onAdd={(p) => { const n = store.addGraph(p.flow.nodes, p.flow.edges, p.entry); setTab("canvas"); window.setTimeout(() => canvasApi.current?.fit(), 80); toast(`${n} step${n === 1 ? "" : "s"} added. Save to keep them.`); }} />}
      {deployOpen && <DeployDialog onClose={() => setDeployOpen(false)} save={save} onShowNode={showNode} onOpenExecution={(id) => setTab("executions", { execution: id })} />}
      {issuesOpen && (
        <Modal title="Problems in this flow" subtitle="Things marked Must fix stop the flow from being deployed." onClose={() => setIssuesOpen(false)} width={620} footer={<Button variant="primary" onClick={() => setIssuesOpen(false)}>Close</Button>}>
          {issues.length ? <IssueList issues={issues} onShow={(id) => { setIssuesOpen(false); showNode(id); }} /> : <p className="mf-help">No problems found.</p>}
        </Modal>
      )}
      {conflict && (
        <Modal title="This flow was changed somewhere else" onClose={() => setConflict(false)} width={560}
          footer={<>
            <Button onClick={() => setConflict(false)}>Cancel</Button><span style={{ flex: 1 }} />
            <Button busy={resolveConflict.isPending && resolveConflict.variables === "theirs"} onClick={() => resolveConflict.mutate("theirs")} data-action="conflict-theirs">Load the other version</Button>
            <Button variant="primary" busy={resolveConflict.isPending && resolveConflict.variables === "mine"} onClick={() => resolveConflict.mutate("mine")} data-action="conflict-mine">Save mine over it</Button>
          </>}>
          <Callout tone="warn" title="Your changes were not saved">
            <span>Someone (or another browser tab) saved this flow after you opened it. Choose which version to keep. The other one stays available under Versions.</span>
          </Callout>
        </Modal>
      )}
    </div>
  );
}
