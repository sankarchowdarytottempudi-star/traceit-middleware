// /studio: every flow on this server, plus the already-migrated services (read-only).
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, FileUp, LayoutGrid, List, MoreHorizontal, Plus, Search, Server, Trash2, Workflow } from "lucide-react";
import type { Flow, FlowSummary } from "@traceit/weave-flow";
import { errorText, isUnavailable, studioApi, type EstateApi } from "../api.ts";
import { useCatalog } from "../catalog.ts";
import { ago, Badge, Button, Callout, confirmDialog, CopyButton, cx, downloadJson, Empty, Field, fmtTime, IconButton, Menu, Modal, Spinner, StudioHeader, TableWrap, toast, useDocumentTitle, type MenuItem } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { deploymentBadge } from "../editor/DeployDialog.tsx";
import { Unreachable } from "../editor/Executions.tsx";
import { statusLabel, statusTone } from "../editor/RunViews.tsx";

const ORIGIN_LABEL: Record<string, string> = { template: "from a template", migrated: "migrated", clone: "copied from a migrated service" };
const gatewayUrlOf = (f: FlowSummary) => (f.deployment?.status === "deployed" && f.deployment.gateway?.status === "published" ? f.deployment.gateway.url ?? "" : "");
const liveUrlOf = (f: FlowSummary) => gatewayUrlOf(f) || (f.deployment?.status === "deployed" ? f.deployment.runtimeUrl ?? "" : "");

function NewFlowDialog({ onClose }: { onClose: () => void }) {
  const catalog = useCatalog();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [templateId, setTemplateId] = useState("");
  const create = useMutation({
    mutationFn: () => studioApi.createFlow({ name: name.trim(), description: description.trim() || undefined, templateId: templateId || undefined, ...(templateId ? {} : { flow: { nodes: [], edges: [] } }), origin: templateId ? { kind: "template", ref: templateId } : { kind: "blank" } }),
    onSuccess: (f) => { void qc.invalidateQueries({ queryKey: ["studio", "flows"] }); onClose(); navigate(`/studio/flows/${encodeURIComponent(f.id)}`); },
  });
  const options = [{ id: "", name: "Blank flow", description: "An empty canvas. Add a trigger and build from there." }, ...catalog.templates];
  return (
    <Modal title="New flow" onClose={onClose} width={620}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()} data-action="create-flow">Create flow</Button></>}>
      <form className="mf-stack" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); if (name.trim() && !create.isPending) create.mutate(); }}>
        <Field label="Name" required htmlFor="ws-new-name"><input id="ws-new-name" className="mf-control" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer lookup" maxLength={120} /></Field>
        <Field label="Description" htmlFor="ws-new-desc"><input id="ws-new-desc" className="mf-control" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this flow is for" maxLength={300} /></Field>
        <Field label="Start from">
          <div className="ws-choices" role="radiogroup" aria-label="Start from">
            {options.map((t) => (
              <button key={t.id || "blank"} type="button" role="radio" aria-checked={templateId === t.id} className={cx("ws-choice", templateId === t.id && "ws-choice-on")} onClick={() => setTemplateId(t.id)} data-template={t.id || "blank"}>
                <strong>{txt(t.name)}</strong><span>{txt(t.description)}</span>
              </button>
            ))}
          </div>
        </Field>
        {create.isError && <Callout tone={isUnavailable(create.error) ? "warn" : "bad"} title="The flow was not created">{isUnavailable(create.error) ? "The flow engine cannot be reached right now. Try again in a moment." : errorText(create.error)}</Callout>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: async () => {
      let doc: unknown;
      try { doc = JSON.parse(text); } catch { throw new Error("This is not valid JSON. Choose a file exported from a flow."); }
      if (!doc || typeof doc !== "object" || !Array.isArray((doc as Flow).nodes)) throw new Error("This file is not a flow: it has no steps.");
      return studioApi.importFlow(doc, name.trim() || undefined);
    },
    onMutate: () => setProblem(null),
    onSuccess: (f) => { void qc.invalidateQueries({ queryKey: ["studio", "flows"] }); onClose(); toast("Flow imported."); navigate(`/studio/flows/${encodeURIComponent(f.id)}`); },
    onError: (e) => setProblem(errorText(e)),
  });
  return (
    <Modal title="Import a flow" subtitle="Bring in a flow that was exported from this or another server." onClose={onClose} width={620}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={run.isPending} disabled={!text.trim()} onClick={() => run.mutate()} data-action="import-flow">Import</Button></>}>
      <div className="mf-stack" style={{ gap: 14 }}>
        <div className="mf-hstack">
          <Button icon={FileUp} onClick={() => file.current?.click()}>Choose a file</Button>
          <input ref={file} type="file" accept="application/json,.json" hidden data-testid="import-file" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setText(await f.text()); setProblem(null); e.target.value = ""; }} />
          <span className="mf-help">or paste its content below</span>
        </div>
        <Field label="Flow definition" htmlFor="ws-imp-text"><textarea id="ws-imp-text" className="mf-control mf-control-mono" rows={9} value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "name": "…", "nodes": [ … ], "edges": [ … ] }' spellCheck={false} /></Field>
        <Field label="Name" help="Leave empty to keep the name in the file." htmlFor="ws-imp-name"><input id="ws-imp-name" className="mf-control" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <p className="mf-help" style={{ margin: 0 }}>Connections are referenced by the flow but their passwords and keys are never part of an export. Check the Connections tab after importing.</p>
        {problem && <Callout tone="bad" title="Not imported">{problem}</Callout>}
      </div>
    </Modal>
  );
}

function useFlowActions() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["studio", "flows"] });
  const duplicate = useMutation({ mutationFn: (f: FlowSummary) => studioApi.duplicateFlow(f.id, `${f.name} copy`), onSuccess: (f) => { refresh(); toast("Copy created."); navigate(`/studio/flows/${encodeURIComponent(f.id)}`); }, onError: (e) => toast(errorText(e), "bad") });
  const remove = useMutation({ mutationFn: (f: FlowSummary) => studioApi.deleteFlow(f.id), onSuccess: () => { refresh(); toast("Flow deleted.", "info"); }, onError: (e) => toast(errorText(e), "bad") });
  const exportIt = useMutation({ mutationFn: (f: FlowSummary) => studioApi.exportFlow(f.id), onSuccess: (doc, f) => downloadJson(`${f.slug || "flow"}.flow.json`, doc), onError: (e) => toast(errorText(e), "bad") });
  const menu = (f: FlowSummary): MenuItem[] => [
    { id: "open", label: "Open", icon: Workflow, onSelect: () => navigate(`/studio/flows/${encodeURIComponent(f.id)}`) },
    { id: "dup", label: "Make a copy", icon: Copy, onSelect: () => duplicate.mutate(f) },
    { id: "export", label: "Export as a file", icon: Download, onSelect: () => exportIt.mutate(f) },
    { id: "delete", label: "Delete", icon: Trash2, danger: true, divider: true, onSelect: async () => { if (await confirmDialog({ title: `Delete "${f.name}"?`, body: f.deployment?.status === "deployed" ? "It is live: it will be taken offline and removed, with its history. This cannot be undone." : "The flow and its history are removed. This cannot be undone.", confirmLabel: "Delete", danger: true })) remove.mutate(f); } },
  ];
  return { menu };
}

function FlowCard({ f, menu }: { f: FlowSummary; menu: MenuItem[] }) {
  const url = liveUrlOf(f);
  return (
    <article className="mf-flowcard" data-flow-card={f.name} data-flow-id={f.id} data-flow-status={f.deployment?.status === "deployed" ? "deployed" : "draft"}>
      <header className="mf-flowcard-head">
        <span className="mf-iconchip" style={{ ["--chip" as string]: "var(--ws-trigger)" }}><Workflow size={17} aria-hidden /></span>
        <Link className="mf-flowcard-name" to={`/studio/flows/${encodeURIComponent(f.id)}`}>{txt(f.name) || "Untitled flow"}</Link>
        <Menu label={`Actions for ${f.name}`} items={menu} trigger={(p) => <IconButton label={`Actions for ${f.name}`} icon={MoreHorizontal} {...p} />} />
      </header>
      <p className="mf-flowcard-desc">{txt(f.description) || <span className="mf-faint">No description</span>}</p>
      <div className="mf-flowcard-meta">
        {deploymentBadge(f.deployment)}
        {f.origin?.kind && ORIGIN_LABEL[f.origin.kind] && <Badge>{ORIGIN_LABEL[f.origin.kind]}</Badge>}
        <span className="mf-faint">{txt(f.nodeCount)} step{f.nodeCount === 1 ? "" : "s"}</span>
        {(f.triggers ?? []).slice(0, 2).map((t) => <code key={t} className="mf-mono-sm mf-truncate" style={{ maxWidth: 190 }}>{txt(t)}</code>)}
        {(f.triggers?.length ?? 0) > 2 && <span className="mf-faint">+{f.triggers.length - 2} more</span>}
      </div>
      {url && <div className="mf-flowcard-url"><code className="mf-truncate" title={url}>{txt(url)}</code><CopyButton text={url} /></div>}
      <footer className="mf-flowcard-foot">
        <span>{f.lastExecution ? <><Badge tone={statusTone(f.lastExecution.status)}>{statusLabel(f.lastExecution.status)}</Badge> <span className="mf-faint">last run {ago(f.lastExecution.at)}</span></> : <span className="mf-faint">Never run</span>}</span>
        <span className="mf-faint" title={fmtTime(f.updatedAt)}>saved {ago(f.updatedAt)}</span>
      </footer>
    </article>
  );
}

function MigratedApis() {
  const q = useQuery({ queryKey: ["studio", "estate"], queryFn: studioApi.estate, retry: 0, staleTime: 60_000 });
  const apis: EstateApi[] = q.data?.apis ?? [];
  if (q.isLoading) return <section className="mf-stack"><h2 className="ws-h2">Migrated services</h2><Spinner label="Looking for migrated services…" /></section>;
  if (q.isError) return (
    <section className="mf-stack" data-testid="estate-section" data-estate="unavailable">
      <h2 className="ws-h2">Migrated services</h2>
      <p className="mf-help" style={{ margin: 0 }}>{isUnavailable(q.error) ? "Services that were already migrated will be listed here, ready to open as flows, once the estate view is available on this server." : errorText(q.error)}</p>
    </section>
  );
  if (!apis.length) return null;
  return (
    <section className="mf-stack" data-testid="estate-section" data-estate="ok">
      <div><h2 className="ws-h2">Migrated services</h2><p className="mf-help" style={{ margin: "2px 0 0" }}>Services that are already running. Open one to see how its data flows: connectors, mappings and logs. They are read-only; make an editable copy to change one.</p></div>
      <div className="mf-cardgrid">
        {apis.map((a) => (
          <article key={a.name} className="mf-flowcard" data-estate-card={a.name}>
            <header className="mf-flowcard-head">
              <span className="mf-iconchip" style={{ ["--chip" as string]: "var(--ws-http)" }}><Server size={17} aria-hidden /></span>
              <Link className="mf-flowcard-name" to={`/studio/estate/${encodeURIComponent(a.name)}`}>{txt(a.name)}</Link>
            </header>
            <div className="mf-flowcard-meta">
              {a.status && <Badge tone={/run|ready|ok|up/i.test(a.status) ? "ok" : "warn"}>{txt(a.status)}</Badge>}
              {a.layer && <Badge>{txt(a.layer)}</Badge>}
              {a.technology && <span className="mf-faint">{txt(a.technology)}</span>}
              {a.operations !== undefined && <span className="mf-faint">{txt(a.operations)} operation{a.operations === 1 ? "" : "s"}</span>}
              {a.connectors !== undefined && <span className="mf-faint">{txt(a.connectors)} connector{a.connectors === 1 ? "" : "s"}</span>}
            </div>
            <footer className="mf-flowcard-foot"><span className="mf-faint">{a.gateway?.published ? "On the gateway" : "Read-only"}</span><Link className="mf-button mf-button-default mf-button-sm" to={`/studio/estate/${encodeURIComponent(a.name)}`}>Open</Link></footer>
          </article>
        ))}
      </div>
    </section>
  );
}

export function FlowsListPage() {
  useDocumentTitle("Flows");
  const q = useQuery({ queryKey: ["studio", "flows"], queryFn: studioApi.flows, retry: 0, refetchInterval: 15000 });
  const { menu } = useFlowActions();
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<"all" | "live" | "draft">("all");
  const [view, setView] = useState<"cards" | "table">(() => { try { return localStorage.getItem("weave-flows-view") === "table" ? "table" : "cards"; } catch { return "cards"; } });
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const setViewKept = (v: "cards" | "table") => { setView(v); try { localStorage.setItem("weave-flows-view", v); } catch { /* not kept */ } };
  const all = q.data?.flows ?? [];
  const flows = useMemo(() => {
    const n = text.trim().toLowerCase();
    return all.filter((f) => (filter === "all" || (filter === "live") === (f.deployment?.status === "deployed")) && (!n || `${f.name} ${f.description ?? ""} ${(f.tags ?? []).join(" ")} ${(f.triggers ?? []).join(" ")}`.toLowerCase().includes(n)));
  }, [all, text, filter]);
  const liveCount = all.filter((f) => f.deployment?.status === "deployed").length;
  return (
    <div className="mf-stack ws-page" style={{ gap: 20 }}>
      <StudioHeader area="Build" title="Flows" subtitle="Design how data moves between your systems, test it step by step, and put it live on the gateway."
        actions={<><Button icon={FileUp} onClick={() => setImporting(true)} data-action="import">Import</Button><Button variant="primary" icon={Plus} onClick={() => setCreating(true)} data-action="new-flow">New flow</Button></>} />
      {q.isError && !q.data && <Unreachable error={q.error} what="Your flows" onRetry={() => void q.refetch()} />}
      {q.isLoading && <Spinner label="Loading flows…" />}
      {q.data && all.length === 0 && <Empty icon={Workflow} title="No flows yet" hint="A flow receives a request (or runs on a schedule), calls your systems, reshapes the data and answers. Create your first one, or open a migrated service below to see a real example." action={<Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New flow</Button>} />}
      {all.length > 0 && (
        <section className="mf-stack" data-testid="flows">
          <div className="mf-toolbarline">
            <label className="mf-search"><Search size={15} aria-hidden /><input className="mf-control" type="search" aria-label="Search flows" placeholder="Search flows" value={text} onChange={(e) => setText(e.target.value)} /></label>
            <div className="ws-seg" role="group" aria-label="Show">
              {([["all", `All (${all.length})`], ["live", `Live (${liveCount})`], ["draft", `Drafts (${all.length - liveCount})`]] as const).map(([v, l]) => <button key={v} type="button" className={filter === v ? "ws-seg-on" : ""} aria-pressed={filter === v} onClick={() => setFilter(v)}>{l}</button>)}
            </div>
            <span style={{ flex: 1 }} />
            <IconButton label="Show as cards" icon={LayoutGrid} active={view === "cards"} onClick={() => setViewKept("cards")} />
            <IconButton label="Show as a table" icon={List} active={view === "table"} onClick={() => setViewKept("table")} />
          </div>
          {flows.length === 0 && <Empty icon={Search} title="No flow matches" hint="Try another search or filter." />}
          {flows.length > 0 && view === "cards" && <div className="mf-cardgrid">{flows.map((f) => <FlowCard key={f.id} f={f} menu={menu(f)} />)}</div>}
          {flows.length > 0 && view === "table" && (
            <TableWrap label="Flows">
              <table className="mf-table">
                <thead><tr><th>Flow</th><th>Status</th><th>Last run</th><th>Address</th><th>Saved</th><th /></tr></thead>
                <tbody>
                  {flows.map((f) => {
                    const url = liveUrlOf(f);
                    return (
                      <tr key={f.id} data-flow-row={f.name}>
                        <td><Link className="mf-cellmain" to={`/studio/flows/${encodeURIComponent(f.id)}`}>{txt(f.name) || "Untitled flow"}</Link><div className="mf-cellsub mf-truncate" style={{ maxWidth: 320 }}>{txt(f.description) || `${f.nodeCount} steps`}</div></td>
                        <td>{deploymentBadge(f.deployment)}</td>
                        <td className="mf-nowrap">{f.lastExecution ? <><Badge tone={statusTone(f.lastExecution.status)}>{statusLabel(f.lastExecution.status)}</Badge> <span className="mf-cellsub">{ago(f.lastExecution.at)}</span></> : <span className="mf-faint">Never</span>}</td>
                        <td>{url ? <span className="ws-urlline"><code className="mf-mono-sm mf-truncate" style={{ maxWidth: 300 }} title={url}>{txt(url)}</code><CopyButton text={url} /></span> : <span className="mf-faint">Not live</span>}</td>
                        <td className="mf-nowrap" title={fmtTime(f.updatedAt)}>{ago(f.updatedAt)}</td>
                        <td style={{ textAlign: "right" }}><Menu label={`Actions for ${f.name}`} items={menu(f)} trigger={(p) => <IconButton label={`Actions for ${f.name}`} icon={MoreHorizontal} {...p} />} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
        </section>
      )}
      <MigratedApis />
      {creating && <NewFlowDialog onClose={() => setCreating(false)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}
