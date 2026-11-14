// /studio/connectors: build your own connector (a named set of operations on one system),
// by hand or from an OpenAPI / Swagger description. Each operation becomes a step in the palette.
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, Pencil, Plus, Puzzle, Trash2, Upload } from "lucide-react";
import type { ConnectorDef, ConnectorOperation, FieldDef } from "@traceit/weave-flow";
import { errorText, isUnavailable, studioApi, type ConnectorDraft } from "../api.ts";
import { newId } from "../graph.ts";
import { ago, AutoTextArea, Badge, Button, Callout, Collapsible, confirmDialog, cx, Empty, Field, fmtTime, IconButton, Modal, Spinner, StudioHeader, Tabs, toast, Toggle, useDocumentTitle } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { Unreachable } from "../editor/Executions.tsx";
import { KeyValueEditor } from "../editor/fields.tsx";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
export const methodTone = (m: string) => (m === "GET" || m === "HEAD" ? "info" : m === "DELETE" ? "bad" : "warn") as "info" | "bad" | "warn";

/** Keeps one input per {placeholder} in the path, preserving what the user already described. */
export function bracePlaceholders(path: string): string[] {
  return [...new Set(Array.from(String(path ?? "").matchAll(/(?<!\{)\{([A-Za-z_]\w*)\}(?!\})/g), (m) => m[1]))];
}
export function syncParams(prevPath: string, nextPath: string, params: FieldDef[]): FieldDef[] {
  const prev = bracePlaceholders(prevPath), next = bracePlaceholders(nextPath);
  const kept = params.filter((p) => !(prev.includes(p.key) && !next.includes(p.key)));
  const have = new Set(kept.map((p) => p.key));
  const added = next.filter((n) => !have.has(n)).map<FieldDef>((n) => ({ key: n, label: n, kind: "template", required: true }));
  return [...kept, ...added];
}
/** Field keys every connector step already has (connection, error handling, result placement). */
export const RESERVED_INPUTS = new Set(["connection", "failOnStatus", "output", "timeoutMs", "retries", "retryDelayMs", "resultTarget", "resultVar"]);
export function blankOperation(taken: string[]): ConnectorOperation {
  let n = taken.length + 1;
  while (taken.includes(`operation-${n}`)) n++;
  return { id: `operation-${n}`, name: `Operation ${n}`, method: "GET", path: "/", params: [] };
}
export function operationProblem(op: ConnectorOperation): string | null {
  if (!op.name.trim()) return "Give the operation a name.";
  if (!op.path.trim().startsWith("/") && !/^https?:\/\//.test(op.path.trim()) && !op.path.includes("{{")) return "The path should start with /.";
  const dup = op.params.map((p) => p.key).find((k, i, a) => !k.trim() || a.indexOf(k) !== i);
  if (dup !== undefined) return dup.trim() ? `Two inputs are both called "${dup}".` : "Every input needs a name.";
  const reserved = op.params.map((p) => p.key).find((k) => RESERVED_INPUTS.has(k));
  if (reserved) return `"${reserved}" is a name every step already uses. Call this input something else.`;
  const odd = op.params.map((p) => p.key).find((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
  if (odd) return `The input name "${odd}" may only contain letters, digits and underscores.`;
  return null;
}

function OperationEditor({ op, onChange }: { op: ConnectorOperation; onChange: (op: ConnectorOperation) => void }) {
  const set = (patch: Partial<ConnectorOperation>) => onChange({ ...op, ...patch });
  const setParam = (i: number, patch: Partial<FieldDef>) => set({ params: op.params.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const hasBody = !["GET", "HEAD"].includes(op.method);
  const problem = operationProblem(op);
  const inPath = bracePlaceholders(op.path);
  return (
    <div className="mf-stack" style={{ gap: 14 }} data-testid="operation-editor">
      <div className="mf-formgrid">
        <Field label="Name" required htmlFor="ws-op-name" help="What people see in the list of steps."><input id="ws-op-name" className="mf-control" value={op.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} /></Field>
        <Field label="What it does" htmlFor="ws-op-desc"><input id="ws-op-desc" className="mf-control" value={op.description ?? ""} onChange={(e) => set({ description: e.target.value || undefined })} /></Field>
      </div>
      <div className="ws-test-url">
        <select className="mf-control" aria-label="Method" value={op.method} onChange={(e) => set({ method: e.target.value })} style={{ width: 108, flex: "none" }}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select>
        <input className="mf-control mf-mono" aria-label="Path" value={op.path} placeholder="/customers/{id}" spellCheck={false}
          onChange={(e) => set({ path: e.target.value, params: syncParams(op.path, e.target.value, op.params) })} />
      </div>
      <p className="mf-help" style={{ margin: 0 }}>The path is added to the connection's address. Write a changing part in braces, such as <code>/customers/{"{id}"}</code>; it becomes an input of the step.</p>
      <Collapsible title="Inputs the step asks for" count={op.params.length} defaultOpen>
        {op.params.length === 0 && <p className="mf-help" style={{ margin: 0 }}>None. Add one for every value the person building a flow should fill in.</p>}
        <div className="mf-rows">
          {op.params.map((p, i) => (
            <div className="mf-rowline ws-paramline" key={i}>
              <input className="mf-control mf-control-sm mf-mono" style={{ flex: "0 1 26%" }} aria-label={`Input ${i + 1} name`} placeholder="name" value={p.key} readOnly={inPath.includes(p.key)} title={inPath.includes(p.key) ? "Comes from the path" : undefined}
                onChange={(e) => setParam(i, { key: e.target.value.replace(/[^\w-]/g, ""), label: p.label === p.key ? e.target.value : p.label })} />
              <input className="mf-control mf-control-sm" style={{ flex: "1 1 0" }} aria-label={`Input ${i + 1} label`} placeholder="Label shown in the step" value={p.label} onChange={(e) => setParam(i, { label: e.target.value })} />
              <Toggle checked={!!p.required} onChange={(v) => setParam(i, { required: v })} label="Needed" />
              {inPath.includes(p.key) ? <span style={{ width: 28 }} /> : <IconButton size={14} label={`Remove input ${i + 1}`} icon={Trash2} onClick={() => set({ params: op.params.filter((_, j) => j !== i) })} />}
            </div>
          ))}
        </div>
        <div><Button size="sm" icon={Plus} onClick={() => set({ params: [...op.params, { key: `input${op.params.length + 1}`, label: `Input ${op.params.length + 1}`, kind: "template" }] })}>Add input</Button></div>
        <p className="mf-help" style={{ margin: 0 }}>Use an input anywhere below by writing its name in double braces, such as <code>{"{{ $params.name }}"}</code>.</p>
      </Collapsible>
      <Collapsible title="Query" count={op.query?.length ?? 0} defaultOpen={!!op.query?.length}><KeyValueEditor value={op.query ?? []} onChange={(v) => set({ query: v.length ? v : undefined })} addLabel="Add query value" /></Collapsible>
      <Collapsible title="Headers" count={op.headers?.length ?? 0} defaultOpen={!!op.headers?.length}><KeyValueEditor value={op.headers ?? []} onChange={(v) => set({ headers: v.length ? v : undefined })} addLabel="Add header" /></Collapsible>
      {hasBody && (
        <Field label="Body" help="Leave empty to send what the previous step produced. Otherwise write the body; values in double braces are filled in at run time.">
          <AutoTextArea mono minRows={4} maxRows={16} value={op.bodyTemplate ?? ""} onChange={(v) => set({ bodyTemplate: v || undefined })} placeholder={'{\n  "name": "{{ $payload.name }}"\n}'} aria-label="Body" spellCheck={false} />
        </Field>
      )}
      {problem && <Callout tone="warn">{problem}</Callout>}
    </div>
  );
}

function ConnectorDialog({ initial, isNew, imported, onClose }: { initial: ConnectorDraft; isNew: boolean; imported?: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ConnectorDraft>(initial);
  const [current, setCurrent] = useState<string | null>(initial.operations[0]?.id ?? null);
  const [filter, setFilter] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const conns = useQuery({ queryKey: ["studio", "connections"], queryFn: studioApi.connections, retry: 0 });
  const usable = (conns.data?.connections ?? []).filter((c) => c.type === draft.connectionType || (draft.connectionType === "graphql" && c.type === "http"));
  const op = draft.operations.find((o) => o.id === current) ?? null;
  const firstProblem = draft.operations.map((o) => ({ o, p: operationProblem(o) })).find((x) => x.p);
  const setOp = (next: ConnectorOperation) => setDraft((d) => ({ ...d, operations: d.operations.map((o) => (o.id === next.id ? next : o)) }));
  const add = () => { const o = blankOperation(draft.operations.map((x) => x.id)); setDraft((d) => ({ ...d, operations: [...d.operations, o] })); setCurrent(o.id); };
  const removeOp = (id: string) => { setDraft((d) => ({ ...d, operations: d.operations.filter((o) => o.id !== id) })); if (current === id) setCurrent(draft.operations.find((o) => o.id !== id)?.id ?? null); };
  const save = useMutation({
    mutationFn: () => {
      const body: ConnectorDraft = { ...draft, name: draft.name.trim(), operations: draft.operations.map((o) => ({ ...o, name: o.name.trim(), path: o.path.trim() })) };
      return isNew ? studioApi.createConnector(body) : studioApi.updateConnector(String(draft.id), body);
    },
    onMutate: () => setProblem(null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["studio", "connectors"] });
      void qc.invalidateQueries({ queryKey: ["studio", "catalog"] });
      toast(isNew ? "Connector saved. Its operations are now in the list of steps." : "Connector saved.");
      onClose();
    },
    onError: (e) => setProblem(isUnavailable(e) ? "The flow engine cannot be reached right now, so nothing was saved." : errorText(e)),
  });
  const shown = draft.operations.filter((o) => !filter.trim() || `${o.name} ${o.method} ${o.path}`.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <Modal title={isNew ? (imported ? "Check what was found" : "New connector") : "Edit connector"} subtitle={imported ? "These operations were read from the description. Remove what you do not need, then save." : "A connector is a named set of operations on one system."} onClose={onClose} full bodyClass="ws-connector-body"
      footer={<>
        {(problem || firstProblem) && <span className="ws-footmsg" role="alert">{problem ?? `${firstProblem!.o.name || "An operation"}: ${firstProblem!.p}`}</span>}
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={save.isPending} disabled={!draft.name.trim() || draft.operations.length === 0 || !!firstProblem} onClick={() => save.mutate()} data-action="save-connector">{isNew ? "Save connector" : "Save"}</Button>
      </>}>
      <div className="ws-connector" data-testid="connector-form">
        <div className="ws-connector-top">
          <Field label="Name" required htmlFor="ws-cx-name"><input id="ws-cx-name" className="mf-control" autoFocus={isNew && !imported} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Loyalty service" maxLength={120} /></Field>
          <Field label="Description" htmlFor="ws-cx-desc"><input id="ws-cx-desc" className="mf-control" value={draft.description ?? ""} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value || undefined }))} /></Field>
          <Field label="Connection it uses" htmlFor="ws-cx-conn" help="Where the system lives and how to sign in. A step can still pick another one.">
            <select id="ws-cx-conn" className="mf-control" value={draft.defaultConnectionId ?? ""} onChange={(e) => setDraft((d) => ({ ...d, defaultConnectionId: e.target.value || undefined }))}>
              <option value="">Choose in each step</option>
              {usable.map((c) => <option key={c.id} value={c.id}>{txt(c.name)}</option>)}
            </select>
          </Field>
        </div>
        <div className="ws-connector-split">
          <div className="ws-connector-ops">
            <div className="ws-connector-opshead">
              <strong>Operations <span className="mf-faint">{draft.operations.length}</span></strong>
              <Button size="sm" icon={Plus} onClick={add} data-action="add-operation">Add</Button>
            </div>
            {draft.operations.length > 8 && <input className="mf-control mf-control-sm" type="search" placeholder="Find an operation" aria-label="Find an operation" value={filter} onChange={(e) => setFilter(e.target.value)} />}
            <ul className="ws-oplist">
              {shown.map((o) => (
                <li key={o.id} className={cx("ws-opitem", o.id === current && "ws-opitem-on")} data-operation={o.id}>
                  <button type="button" className="ws-opitem-main" onClick={() => setCurrent(o.id)} aria-current={o.id === current}>
                    <Badge tone={methodTone(o.method)}>{txt(o.method)}</Badge>
                    <span className="ws-opitem-text"><span className="ws-opitem-name">{txt(o.name) || "Unnamed"}</span><code className="ws-opitem-path">{txt(o.path)}</code></span>
                  </button>
                  <IconButton size={14} label={`Remove ${o.name}`} icon={Trash2} onClick={() => removeOp(o.id)} />
                </li>
              ))}
              {draft.operations.length === 0 && <li className="mf-help" style={{ padding: 8 }}>No operations yet. Add the first one.</li>}
            </ul>
          </div>
          <div className="ws-connector-op">
            {op ? <OperationEditor key={op.id} op={op} onChange={setOp} /> : <Empty icon={Puzzle} title="Pick an operation" hint="Choose one on the left to describe it, or add a new one." />}
          </div>
        </div>
      </div>
    </Modal>
  );
}

type ImportTab = "paste" | "file" | "url";
function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (c: ConnectorDraft) => void }) {
  const [tab, setTab] = useState<ImportTab>("paste");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [url, setUrl] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const run = useMutation({
    mutationFn: () => {
      if (tab === "url") return studioApi.importOpenApi({ name: name.trim() || undefined, url: url.trim() });
      let spec: unknown = text;
      try { spec = JSON.parse(text); } catch { /* YAML or broken JSON: the server reads it and explains what is wrong */ }
      return studioApi.importOpenApi({ name: name.trim() || undefined, spec: spec as never });
    },
    onSuccess: (c) => {
      if (!c || !Array.isArray(c.operations) || c.operations.length === 0) throw new Error("No operations were found in that description.");
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = c;
      onImported({ ...rest, source: "openapi" });
    },
  });
  const failure = run.error ? (isUnavailable(run.error) ? "The flow engine cannot be reached right now. Try again in a moment." : errorText(run.error)) : null;
  const ready = tab === "url" ? /^https?:\/\/\S+$/.test(url.trim()) : text.trim().length > 0;
  const readFile = async (f: File | undefined) => { if (!f) return; setFileName(f.name); setText(await f.text()); if (!name.trim()) setName(f.name.replace(/\.(json|ya?ml)$/i, "").replace(/[-_.]+/g, " ")); };
  return (
    <Modal title="Import from OpenAPI or Swagger" subtitle="Give the description of an API and every operation in it becomes a ready-made step." onClose={onClose} width={680}
      footer={<><span style={{ flex: 1 }} /><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Upload} busy={run.isPending} disabled={!ready} onClick={() => run.mutate()} data-action="import-connector">Read operations</Button></>}>
      <div className="mf-stack" style={{ gap: 14 }} data-testid="connector-import">
        <Field label="Name" htmlFor="ws-imp-name" help="Leave empty to use the title from the description."><input id="ws-imp-name" className="mf-control" value={name} onChange={(e) => setName(e.target.value)} placeholder="Loyalty service" maxLength={120} /></Field>
        <Tabs<ImportTab> label="Where the description comes from" value={tab} onChange={(t) => { setTab(t); run.reset(); }} tabs={[{ id: "paste", label: "Paste" }, { id: "file", label: "Upload a file" }, { id: "url", label: "From an address" }]} />
        {tab === "paste" && <Field label="Description (JSON or YAML)" htmlFor="ws-imp-spec"><AutoTextArea id="ws-imp-spec" mono minRows={10} maxRows={18} value={text} onChange={setText} placeholder={'{\n  "openapi": "3.0.0",\n  "paths": { ... }\n}'} spellCheck={false} /></Field>}
        {tab === "file" && (
          <div className="ws-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void readFile(e.dataTransfer.files?.[0]); }}>
            <FileUp size={22} aria-hidden />
            <div>{fileName ? <><strong>{fileName}</strong> is ready ({text.length.toLocaleString()} characters).</> : "Drop a .json or .yaml file here, or choose one."}</div>
            <Button size="sm" onClick={() => fileRef.current?.click()}>Choose a file</Button>
            <input ref={fileRef} type="file" accept=".json,.yaml,.yml,application/json,text/yaml" hidden data-testid="connector-file" onChange={(e) => void readFile(e.target.files?.[0])} />
          </div>
        )}
        {tab === "url" && <Field label="Address of the description" htmlFor="ws-imp-url" help="It is fetched by this server, not by your browser, so an address that only this server can reach works too."><input id="ws-imp-url" className="mf-control mf-mono" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://service.internal/openapi.json" spellCheck={false} /></Field>}
        {failure && <Callout tone="bad" title="Could not read it">{failure}</Callout>}
      </div>
    </Modal>
  );
}

function ConnectorCard({ c, connectionName, onEdit, onDelete }: { c: ConnectorDef; connectionName?: string; onEdit: () => void; onDelete: () => void }) {
  const ops = c.operations ?? [];
  return (
    <article className="ws-cxcard" data-connector={c.name} data-connector-id={c.id}>
      <header className="ws-cxcard-head">
        <span className="mf-iconchip" style={{ ["--chip" as string]: "var(--ws-custom)" }}><Puzzle size={16} aria-hidden /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 className="ws-cxcard-name">{txt(c.name)}</h3>
          {c.description && <p className="mf-cellsub" style={{ margin: 0 }}>{txt(c.description)}</p>}
        </div>
        <IconButton label={`Edit ${c.name}`} icon={Pencil} onClick={onEdit} />
        <IconButton label={`Delete ${c.name}`} icon={Trash2} tone="danger" onClick={onDelete} />
      </header>
      <div className="mf-hstack" style={{ gap: 6 }}>
        <Badge tone={c.source === "openapi" ? "info" : "neutral"}>{c.source === "openapi" ? "From OpenAPI" : "Built by hand"}</Badge>
        <Badge>{ops.length} {ops.length === 1 ? "operation" : "operations"}</Badge>
        {connectionName && <Badge>Uses {txt(connectionName)}</Badge>}
        <span className="mf-faint" style={{ fontSize: 12 }} title={fmtTime(c.updatedAt)}>changed {ago(c.updatedAt)}</span>
      </div>
      <ul className="ws-cxops">
        {ops.slice(0, 6).map((o) => <li key={o.id}><Badge tone={methodTone(o.method)}>{txt(o.method)}</Badge><span className="ws-cxops-name">{txt(o.name)}</span><code className="ws-cxops-path">{txt(o.path)}</code></li>)}
        {ops.length > 6 && <li className="mf-faint">and {ops.length - 6} more</li>}
      </ul>
    </article>
  );
}

export function ConnectorsPage() {
  useDocumentTitle("Connectors");
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["studio", "connectors"], queryFn: studioApi.connectors, retry: 0 });
  const conns = useQuery({ queryKey: ["studio", "connections"], queryFn: studioApi.connections, retry: 0 });
  const [editing, setEditing] = useState<{ draft: ConnectorDraft; isNew: boolean; imported?: boolean; key: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const connName = useMemo(() => new Map((conns.data?.connections ?? []).map((c) => [c.id, c.name])), [conns.data]);
  const remove = useMutation({
    mutationFn: (c: ConnectorDef) => studioApi.deleteConnector(c.id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["studio", "connectors"] }); void qc.invalidateQueries({ queryKey: ["studio", "catalog"] }); toast("Connector deleted.", "info"); },
    onError: (e) => toast(errorText(e), "bad"),
  });
  const startNew = () => setEditing({ key: newId("cx"), isNew: true, draft: { name: "", connectionType: "http", source: "manual", operations: [{ id: "operation-1", name: "Operation 1", method: "GET", path: "/", params: [] }] } });
  const list = q.data?.connectors ?? [];
  const actions = <>
    <Button icon={Upload} onClick={() => setImporting(true)} data-action="import-openapi">Import from OpenAPI</Button>
    <Button variant="primary" icon={Plus} onClick={startNew} data-action="new-connector">New connector</Button>
  </>;
  return (
    <div className="mf-stack ws-page" style={{ gap: 20 }}>
      <StudioHeader area="Build" title="Connectors" subtitle="Your own ready-made steps for the systems you work with. Describe the operations once, by hand or from an OpenAPI description, and use them in any flow." actions={actions} />
      {q.isLoading && <Spinner label="Loading connectors…" />}
      {q.isError && !q.data && <Unreachable error={q.error} what="Connectors" onRetry={() => void q.refetch()} />}
      {q.data && list.length === 0 && <Empty icon={Puzzle} title="No connectors of your own yet" hint="The built-in steps already call any web address, cache or database. Build a connector when you want named, ready-made operations for one system." action={actions} />}
      {list.length > 0 && <div className="ws-cxgrid" data-testid="connectors">{list.map((c) => (
        <ConnectorCard key={c.id} c={c} connectionName={c.defaultConnectionId ? connName.get(c.defaultConnectionId) : undefined}
          onEdit={() => setEditing({ key: c.id, isNew: false, draft: { ...c, operations: c.operations ?? [] } })}
          onDelete={async () => { if (await confirmDialog({ title: `Delete "${c.name}"?`, body: "Flows that use its operations will stop working until those steps are replaced.", confirmLabel: "Delete", danger: true })) remove.mutate(c); }} />
      ))}</div>}
      {importing && <ImportDialog onClose={() => setImporting(false)} onImported={(draft) => { setImporting(false); setEditing({ key: newId("cx"), isNew: true, imported: true, draft: { ...draft, name: draft.name || "Imported connector" } }); }} />}
      {editing && <ConnectorDialog key={editing.key} initial={editing.draft} isNew={editing.isNew} imported={editing.imported} onClose={() => setEditing(null)} />}
    </div>
  );
}
