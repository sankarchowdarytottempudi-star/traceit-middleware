// /studio/estate/:api: a service that was already migrated, shown as a flow. Read-only:
// the picture is built from the service's code by the Factory, one trigger chain per operation.
// "Clone to edit" makes an editable flow out of it.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, CopyPlus, ExternalLink, Lock, Plug, RefreshCw, ScrollText, Search, Workflow } from "lucide-react";
import type { Flow, Json } from "@traceit/weave-flow";
import { ApiError, errorText, isUnavailable, studioApi, type EstateApiDetail, type EstateLogLine } from "../api.ts";
import { useCatalog, type Catalog } from "../catalog.ts";
import { defResolver, mappingOf, operationNodes } from "../graph.ts";
import { EditorContext, EditorStore, useEditor } from "../store.ts";
import { Badge, Button, Callout, CodeBlock, cx, Empty, Field, fmtTime, IconButton, Modal, Section, Sheet, Spinner, TableWrap, Tabs, toast, Toggle, useBreakpoint, useDebounced, useDocumentTitle, type TabDef } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { FlowCanvas, type CanvasApi } from "../editor/FlowCanvas.tsx";
import { MapperDialog } from "../editor/Mapper.tsx";
import { NodePanel } from "../editor/NodePanel.tsx";
import { MappingsTab } from "../editor/tabs.tsx";
import { methodTone } from "./Connectors.tsx";

export interface EstateOperation { id: string; name: string; method: string; path: string; steps: number; }

/** One entry per trigger: the operations a migrated service offers. */
export function operationsOf(flow: Pick<Flow, "nodes" | "edges">): EstateOperation[] {
  return (flow.nodes ?? []).filter((n) => String(n.type).startsWith("trigger.")).map((n) => {
    const c = n.config ?? {};
    const methods = Array.isArray(c.methods) ? (c.methods as unknown[]).map(String) : c.method ? [String(c.method)] : [];
    return { id: n.id, name: n.name, method: methods.join(", ") || (n.type === "trigger.schedule" ? "TIMER" : "RUN"), path: typeof c.path === "string" ? c.path : "", steps: operationNodes(n.id, flow.edges ?? []).size - 1 };
  });
}
/** The part of the flow that belongs to one operation (its trigger and everything reachable from it). */
export function sliceOperation(flow: Flow, triggerId: string | null): Flow {
  if (!triggerId || !flow.nodes.some((n) => n.id === triggerId)) return flow;
  const keep = operationNodes(triggerId, flow.edges);
  return { ...flow, nodes: flow.nodes.filter((n) => keep.has(n.id)), edges: flow.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) };
}

type TabId = "flow" | "connectors" | "mappings" | "logs";

export function EstateFlowPage() {
  const { api = "" } = useParams();
  useDocumentTitle(api);
  const flowQ = useQuery({ queryKey: ["studio", "estate-flow", api], queryFn: () => studioApi.estateFlow(api), retry: 0, staleTime: 60_000 });
  const detailQ = useQuery({ queryKey: ["studio", "estate-api", api], queryFn: () => studioApi.estateApi(api), retry: 0, staleTime: 60_000 });
  const back = <Link to="/studio" className="mf-btn"><ArrowLeft size={15} aria-hidden />Back to flows</Link>;
  if (flowQ.isLoading) return <div className="ws-editor-msg"><Spinner label="Reading the service…" /></div>;
  if (flowQ.isError || !flowQ.data) {
    const missing = flowQ.error instanceof ApiError && flowQ.error.status === 404;
    return (
      <div className="ws-editor-msg" data-testid="estate-unavailable">
        <Empty icon={Workflow} title={missing ? "This service cannot be shown as a flow here" : "The service could not be read"}
          hint={missing ? `Nothing was found for "${api}". It may have been removed, or this server does not offer the read-only view yet.` : isUnavailable(flowQ.error) ? "The server did not answer. Try again in a moment." : errorText(flowQ.error)}
          action={<span className="mf-hstack">{back}<Button icon={RefreshCw} onClick={() => void flowQ.refetch()}>Try again</Button></span>} />
      </div>
    );
  }
  return <EstateView api={api} flow={flowQ.data} detail={detailQ.data} />;
}

function EstateView({ api, flow, detail }: { api: string; flow: Flow; detail?: EstateApiDetail }) {
  const catalog = useCatalog();
  const [params, setParams] = useSearchParams();
  const ops = useMemo(() => operationsOf(flow), [flow]);
  const wanted = params.get("operation");
  const current = ops.find((o) => o.id === wanted)?.id ?? ops[0]?.id ?? null;
  const slice = useMemo(() => sliceOperation(flow, current), [flow, current]);
  const store = useMemo(() => {
    const s = new EditorStore({ ...slice, readOnly: true }, { readOnly: true });
    s.setCatalog(catalog.byType);
    // the positions that come with a migrated service are a plain line; lay the branches out properly
    s.arrangeIfNeeded(true);
    return s;
  }, [slice, catalog.byType]);
  const setParam = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v === null) n.delete(k); else n.set(k, v); return n; }, { replace: true });
  return (
    <EditorContext.Provider value={store}>
      <EstateInner api={api} flow={flow} detail={detail} catalog={catalog} store={store} ops={ops} current={current}
        tab={(["flow", "connectors", "mappings", "logs"] as TabId[]).includes(params.get("tab") as TabId) ? (params.get("tab") as TabId) : "flow"}
        onTab={(t) => setParam("tab", t === "flow" ? null : t)} onOperation={(id) => setParam("operation", id)} />
    </EditorContext.Provider>
  );
}

function OperationList({ ops, current, onPick }: { ops: EstateOperation[]; current: string | null; onPick: (id: string) => void }) {
  const [text, setText] = useState("");
  const needle = text.trim().toLowerCase();
  const shown = needle ? ops.filter((o) => `${o.name} ${o.method} ${o.path}`.toLowerCase().includes(needle)) : ops;
  return (
    <div className="ws-oppick" data-testid="estate-operations">
      <div className="ws-oppick-head"><strong>Operations</strong><span className="mf-faint">{ops.length}</span></div>
      {ops.length > 6 && <label className="mf-search"><Search size={15} aria-hidden /><input className="mf-control" type="search" aria-label="Find an operation" placeholder="Find an operation" value={text} onChange={(e) => setText(e.target.value)} /></label>}
      <ul className="ws-oplist">
        {shown.map((o) => (
          <li key={o.id} className={cx("ws-opitem", o.id === current && "ws-opitem-on")} data-operation={o.id}>
            <button type="button" className="ws-opitem-main" onClick={() => onPick(o.id)} aria-current={o.id === current}>
              <Badge tone={methodTone(o.method)}>{txt(o.method)}</Badge>
              <span className="ws-opitem-text"><span className="ws-opitem-name">{txt(o.path) || txt(o.name)}</span><span className="ws-opitem-path">{o.path ? txt(o.name) : ""}{o.path ? " · " : ""}{o.steps} step{o.steps === 1 ? "" : "s"}</span></span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="mf-help" style={{ padding: 8 }}>No operation matches.</li>}
      </ul>
    </div>
  );
}

function EstateInner({ api, flow, detail, catalog, store, ops, current, tab, onTab, onOperation }: {
  api: string; flow: Flow; detail?: EstateApiDetail; catalog: Catalog; store: EditorStore; ops: EstateOperation[]; current: string | null;
  tab: TabId; onTab: (t: TabId) => void; onOperation: (id: string) => void;
}) {
  const bp = useBreakpoint();
  const desktop = bp === "desktop";
  const navigate = useNavigate();
  const nodes = useEditor((s) => s.nodes);
  const selection = useEditor((s) => s.selection);
  const canvasApi = useRef<CanvasApi>(null);
  const [openNode, setOpenNode] = useState<string | null>(null);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const [mapper, setMapper] = useState<{ nodeId: string; fieldKey: string } | null>(null);
  const [cloning, setCloning] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);
  const defFor = useMemo(() => defResolver(catalog.byType, flow.edges, flow.nodes), [catalog.byType, flow]);
  const selected = selection.length === 1 ? selection[0] : null;
  const panelNode = desktop ? (selected && selected !== closedFor ? selected : null) : openNode && nodes.some((n) => n.id === openNode) ? openNode : null;
  useEffect(() => { if (selected !== closedFor) setClosedFor(null); }, [selected, closedFor]);
  useEffect(() => { setOpenNode(null); }, [current]);
  const showNode = (id: string) => { onTab("flow"); store.select([id]); setTimeout(() => canvasApi.current?.focusNode(id), 80); if (!desktop) setOpenNode(id); };
  const mapperNode = mapper ? nodes.find((n) => n.id === mapper.nodeId) : undefined;
  const cur = ops.find((o) => o.id === current);
  const mappings = detail?.mappings ?? [];
  const tabs: TabDef<TabId>[] = [
    { id: "flow", label: "Flow" },
    { id: "connectors", label: "Connectors", count: detail?.connectors?.length || undefined },
    { id: "mappings", label: "Mappings", count: mappings.length || undefined },
    { id: "logs", label: "Logs" },
  ];
  const panel = panelNode && (
    <NodePanel nodeId={panelNode} catalog={catalog} defFor={defFor} onOpenMapper={(nodeId, fieldKey) => setMapper({ nodeId, fieldKey })}
      onClose={() => { if (desktop) setClosedFor(panelNode); else setOpenNode(null); }} />
  );
  return (
    <div className="ws-editor ws-editor-ro" data-testid="estate-flow" data-estate-api={api} data-operation={current ?? ""}>
      <header className="ws-bar">
        <Link to="/studio" className="mf-iconbtn" aria-label="Back to flows" title="Back to flows"><ArrowLeft size={17} aria-hidden /></Link>
        <div className="ws-bar-title">
          <h1 className="ws-bar-name ws-bar-name-ro">{txt(flow.name) || api}</h1>
          <span className="ws-bar-state">
            <Badge tone="info" icon={Lock}>{bp === "phone" ? "Read-only" : "Migrated service, read-only"}</Badge>
            {detail?.status && <Badge tone={/run|ready|up/i.test(String(detail.status)) ? "ok" : "warn"}>{txt(detail.status)}</Badge>}
            {detail?.technology && <span className="ws-bar-dirty">{txt(detail.technology)}</span>}
          </span>
        </div>
        <div className="ws-bar-actions">
          <Link to={`/estate/${encodeURIComponent(api)}`} className={cx("mf-btn", bp === "phone" && "ws-iconly")} aria-label="Service details" title="Service details"><ExternalLink size={15} aria-hidden />{bp === "phone" ? null : "Service details"}</Link>
          <Button variant="primary" icon={CopyPlus} onClick={() => setCloning(true)} data-action="clone" className={cx(bp === "phone" && "ws-iconly")} aria-label="Clone to edit">{bp === "phone" ? null : "Clone to edit"}</Button>
        </div>
      </header>
      <Tabs tabs={tabs} value={tab} onChange={onTab} label="Service sections" className="ws-editor-tabs" />

      {tab === "flow" && (
        <div className={cx("ws-body", desktop && ops.length > 1 && "ws-body-palette", desktop && panelNode && "ws-body-panel")}>
          {desktop && ops.length > 1 && <aside className="ws-side ws-side-left" aria-label="Operations of this service"><OperationList ops={ops} current={current} onPick={onOperation} /></aside>}
          <div className="ws-center">
            {!desktop && ops.length > 1 && (
              <button type="button" className="ws-opbar" onClick={() => setOpsOpen(true)} data-action="pick-operation">
                {cur && <Badge tone={methodTone(cur.method)}>{txt(cur.method)}</Badge>}
                <span className="ws-opbar-text">{cur ? txt(cur.path) || txt(cur.name) : "Choose an operation"}</span>
                <span className="mf-faint">{ops.length} operations</span>
              </button>
            )}
            <div className="ws-canvaswrap">
              <FlowCanvas key={current ?? "all"} apiRef={canvasApi} defFor={defFor} compact={!desktop} onOpenNode={(id) => { if (desktop) setClosedFor(null); else setOpenNode(id); }}
                emptyHint={<Empty icon={Workflow} title="Nothing to show for this service" hint="No operations were found in its code. Open the service details to see what was deployed." />} />
            </div>
          </div>
          {desktop && panelNode && <aside className="ws-side ws-side-right" aria-label="Step details">{panel}</aside>}
        </div>
      )}
      {tab !== "flow" && (
        <div className="ws-tabpage"><div className="ws-tabpage-in">
          {tab === "connectors" && <EstateConnectors detail={detail} onShowNode={showNode} />}
          {tab === "mappings" && <EstateMappings detail={detail} defFor={defFor} onShowNode={showNode} onOpenMapper={(nodeId, fieldKey) => setMapper({ nodeId, fieldKey })} />}
          {tab === "logs" && <EstateLogs api={api} />}
        </div></div>
      )}

      {!desktop && opsOpen && <Sheet title="Operations" side={bp === "phone" ? "bottom" : "left"} width={360} onClose={() => setOpsOpen(false)}><OperationList ops={ops} current={current} onPick={(id) => { setOpsOpen(false); onOperation(id); }} /></Sheet>}
      {!desktop && panelNode && tab === "flow" && <Sheet title="Step details" side={bp === "phone" ? "bottom" : "right"} width={440} onClose={() => setOpenNode(null)}>{panel}</Sheet>}
      {mapper && mapperNode && <MapperDialog title={`Mapping: ${txt(mapperNode.data.name)}`} readOnly spec={mappingOf(mapperNode.data.config[mapper.fieldKey])} onChange={() => undefined} onClose={() => setMapper(null)} examples={catalog.instructionExamples} lastInput={undefined as Json | undefined} />}
      {cloning && <CloneDialog api={api} defaultName={`${txt(flow.name) || api} (editable copy)`} onClose={() => setCloning(false)} onDone={(id) => navigate(`/studio/flows/${encodeURIComponent(id)}`)} />}
    </div>
  );
}

function CloneDialog({ api, defaultName, onClose, onDone }: { api: string; defaultName: string; onClose: () => void; onDone: (flowId: string) => void }) {
  const [name, setName] = useState(defaultName);
  const clone = useMutation({
    mutationFn: () => studioApi.estateClone(api, name.trim()),
    onSuccess: (r) => { if (!r?.flowId) throw new Error("The copy was made but could not be opened. Look for it in the list of flows."); toast("Editable copy created."); onDone(r.flowId); },
  });
  return (
    <Modal title="Clone to edit" subtitle="Makes a flow you can change, test and deploy. The running service is not touched." onClose={onClose} width={520}
      footer={<><span style={{ flex: 1 }} /><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={CopyPlus} busy={clone.isPending} disabled={!name.trim()} onClick={() => clone.mutate()} data-action="confirm-clone">Create the copy</Button></>}>
      <div className="mf-stack" style={{ gap: 14 }}>
        <Field label="Name of the new flow" required htmlFor="ws-clone-name"><input id="ws-clone-name" className="mf-control" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        {clone.isError && <Callout tone="bad" title="The copy was not made">{isUnavailable(clone.error) ? "This server cannot make editable copies of migrated services yet, or it did not answer." : errorText(clone.error)}</Callout>}
      </div>
    </Modal>
  );
}

type DefFor = ReturnType<typeof defResolver>;
function EstateConnectors({ detail, onShowNode }: { detail?: EstateApiDetail; onShowNode: (id: string) => void }) {
  const list = detail?.connectors ?? [];
  const nodes = useEditor((s) => s.nodes);
  // the steps of the operation on the canvas that call another system, with what they ask for
  const calls = useMemo(() => nodes.flatMap((n) => {
    const c = n.data.config as Record<string, unknown>;
    const system = typeof c.__connector === "string" ? c.__connector : "";
    const target = typeof c.__target === "string" ? c.__target : "";
    if (!system && !target) return [];
    const req = c.request && typeof c.request === "object" ? (c.request as Record<string, unknown>) : c;
    const method = typeof req.method === "string" ? req.method : "";
    const path = typeof req.path === "string" ? req.path : typeof req.url === "string" ? req.url : "";
    return [{ id: n.id, name: n.data.name, system, target, method, path }];
  }), [nodes]);
  if (!list.length && !calls.length) return <div data-testid="estate-connectors"><Empty icon={Plug} title="This service does not call another system" hint="Nothing in its code reaches out to a backend, a cache or another service." /></div>;
  return (
    <div className="mf-stack" style={{ gap: 18 }} data-testid="estate-connectors">
      {list.length > 0 && (
        <Section title="Systems this service talks to">
          <TableWrap label="Connectors of this service">
            <table className="mf-table">
              <thead><tr><th>Name</th><th>Kind</th><th>Points to</th><th>Used by</th></tr></thead>
              <tbody>{list.map((c, i) => (
                <tr key={`${c.name}-${i}`}>
                  <td><span className="mf-cellmain">{txt(c.name)}</span>{c.auth && <div className="mf-cellsub">Sign-in: {txt(c.auth)}</div>}</td>
                  <td><Badge>{txt(c.kind)}</Badge></td>
                  <td><code className="mf-mono-sm mf-wrapcode">{txt(c.target) || "-"}</code></td>
                  <td>{(c.usedBy ?? []).map((u) => txt(u)).join(", ") || "-"}</td>
                </tr>
              ))}</tbody>
            </table>
          </TableWrap>
        </Section>
      )}
      <Section title="Calls made by the operation shown on the canvas">
        {calls.length === 0 ? <p className="mf-help">This operation does not call another system.</p> : (
          <TableWrap label="Calls made by this operation">
            <table className="mf-table" data-testid="estate-calls">
              <thead><tr><th>Step</th><th>System</th><th>Request</th><th><span className="mf-sr">Actions</span></th></tr></thead>
              <tbody>{calls.map((c) => (
                <tr key={c.id}>
                  <td><span className="mf-cellmain">{txt(c.name)}</span></td>
                  <td>{txt(c.system) || "-"}{c.target && <div className="mf-cellsub" style={{ overflowWrap: "anywhere" }}>{txt(c.target)}</div>}</td>
                  <td>{c.method && <Badge tone={methodTone(c.method)}>{txt(c.method)}</Badge>} <code className="mf-mono-sm mf-wrapcode">{txt(c.path) || "-"}</code></td>
                  <td className="mf-nowrap" style={{ textAlign: "right" }}><Button size="sm" variant="ghost" icon={Workflow} onClick={() => onShowNode(c.id)}>Show on canvas</Button></td>
                </tr>
              ))}</tbody>
            </table>
          </TableWrap>
        )}
      </Section>
    </div>
  );
}

function EstateMappings({ detail, defFor, onShowNode, onOpenMapper }: { detail?: EstateApiDetail; defFor: DefFor; onShowNode: (id: string) => void; onOpenMapper: (nodeId: string, fieldKey: string) => void }) {
  const list = detail?.mappings ?? [];
  return (
    <div className="mf-stack" style={{ gap: 18 }} data-testid="estate-mappings">
      <Section title="In the operation shown on the canvas"><MappingsTab defFor={defFor} onShowNode={onShowNode} onOpenMapper={onOpenMapper} /></Section>
      {list.length > 0 && (
        <Section title="Every mapping in the service's code">
          <div className="mf-stack" style={{ gap: 12 }}>
            {list.map((m) => (
              <details key={m.id} className="ws-details">
                <summary><span className="mf-hstack"><strong>{txt(m.name)}</strong><Badge>{txt(m.kind)}</Badge>{m.operation && <span className="mf-faint">{txt(m.operation)}</span>}{m.file && <code className="mf-mono-sm">{txt(m.file)}{m.line ? `:${m.line}` : ""}</code>}</span></summary>
                {m.fields && m.fields.length > 0 && (
                  <TableWrap label={`Fields of ${m.name}`}>
                    <table className="mf-table"><thead><tr><th>Output field</th><th>Filled from</th></tr></thead>
                      <tbody>{m.fields.map((f, i) => <tr key={i}><td><code className="mf-mono-sm">{txt(f.target)}</code></td><td><code className="mf-mono-sm mf-wrapcode">{txt(f.source)}</code></td></tr>)}</tbody></table>
                  </TableWrap>
                )}
                {m.code && <CodeBlock value={m.code} label="Code" maxHeight={320} />}
              </details>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

const lineTone = (l: EstateLogLine) => (/err|fatal|sever/i.test(String(l.level ?? "")) ? "bad" : /warn/i.test(String(l.level ?? "")) ? "warn" : /debug|trace/i.test(String(l.level ?? "")) ? "neutral" : "info");
function EstateLogs({ api }: { api: string }) {
  const [text, setText] = useState("");
  const [auto, setAuto] = useState(false);
  const q2 = useDebounced(text, 350).trim();
  const q = useQuery({ queryKey: ["studio", "estate-logs", api, q2], queryFn: () => studioApi.estateLogs(api, { tail: 400, q: q2 || undefined }), retry: 0, refetchInterval: auto ? 5000 : false, placeholderData: keepPreviousData });
  const lines = q.data?.lines ?? [];
  return (
    <div className="mf-stack" data-testid="estate-logs">
      <div className="mf-toolbarline">
        <label className="mf-search"><Search size={15} aria-hidden /><input className="mf-control" type="search" aria-label="Search the log" placeholder="Search the log" value={text} onChange={(e) => setText(e.target.value)} /></label>
        <span style={{ flex: 1 }} />
        <Toggle checked={auto} onChange={setAuto} label={<span style={{ fontSize: 12.5 }}>Refresh automatically</span>} />
        <IconButton label="Refresh now" icon={RefreshCw} busy={q.isFetching} onClick={() => void q.refetch()} />
      </div>
      {q.isLoading && <Spinner label="Loading the log…" />}
      {q.isError && !q.data && <Callout tone="warn" title="The log cannot be shown">{isUnavailable(q.error) ? "This server does not offer the log of migrated services yet, or it did not answer." : errorText(q.error)}</Callout>}
      {q.data && lines.length === 0 && <Empty icon={ScrollText} title={q2 ? "No matching lines" : "Nothing logged recently"} hint={q2 ? "Try another search." : "Lines appear here when the service handles a call."} />}
      {lines.length > 0 && (
        <ol className="ws-log" aria-label="Log lines" data-log-count={lines.length}>
          {lines.map((l, i) => (
            <li key={i} className={cx("ws-logrow", `ws-logrow-${lineTone(l) === "bad" ? "error" : lineTone(l) === "warn" ? "warn" : "info"}`)}>
              <time className="ws-logrow-at" title={txt(l.at)}>{l.at ? fmtTime(l.at) : ""}</time>
              {l.level ? <Badge tone={lineTone(l)}>{txt(l.level).toLowerCase()}</Badge> : <span />}
              <span className="ws-logrow-msg">{txt(l.text)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
