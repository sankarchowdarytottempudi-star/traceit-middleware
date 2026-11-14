// The non-canvas tabs of the flow editor: Mappings, Connections used, Versions, Settings.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, CheckCircle2, Eye, History, Plug, RotateCcw, Trash2, Workflow, XCircle } from "lucide-react";
import type { Connection, Flow, FlowSettings, NodeTypeDef } from "@traceit/weave-flow";
import { errorText, studioApi, type ConnectionTestResult } from "../api.ts";
import { fieldVisible } from "../catalog.ts";
import { mappingOf } from "../graph.ts";
import { specStats } from "../mapping.ts";
import { useEditor, useEditorStore } from "../store.ts";
import { ago, Badge, Button, Callout, CodeBlock, confirmDialog, Empty, Field, fmtDuration, fmtTime, Modal, Section, Spinner, TableWrap, toast, Toggle } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { Unreachable } from "./Executions.tsx";
import { RulesTable } from "./Mapper.tsx";

type DefFor = (type: string) => NodeTypeDef;

// ---------------------------------------------------------------- mappings
export function MappingsTab({ defFor, onOpenMapper, onShowNode }: { defFor: DefFor; onOpenMapper: (nodeId: string, fieldKey: string) => void; onShowNode: (id: string) => void }) {
  const nodes = useEditor((s) => s.nodes);
  const readOnly = useEditor((s) => s.readOnly);
  const items = useMemo(() => nodes.flatMap((n) => defFor(n.data.type).fields.filter((f) => f.kind === "mapping" && fieldVisible(f, n.data.config)).map((f) => ({ node: n, field: f, spec: mappingOf(n.data.config[f.key]) }))), [nodes, defFor]);
  if (!items.length) return <Empty icon={ArrowLeftRight} title="No mappings in this flow" hint={readOnly ? "This flow passes data through without reshaping it." : "Add a Map step to the canvas to reshape data between systems. Rules can be written as field copies, expressions, or in your own words."} />;
  return (
    <div className="mf-stack" style={{ gap: 14 }} data-testid="mappings-tab">
      {items.map(({ node, field, spec }) => {
        const st = specStats(spec);
        return (
          <Section key={`${node.id}:${field.key}`} title={<span className="mf-hstack"><span>{txt(node.data.name)}</span><Badge tone="accent">{st.total} rule{st.total === 1 ? "" : "s"}</Badge>{st.unresolved > 0 && <Badge tone="bad">{st.unresolved} not understood</Badge>}{st.incomplete > 0 && <Badge tone="warn">{st.incomplete} incomplete</Badge>}</span>}
            aside={<span className="mf-hstack"><Button size="sm" variant="ghost" icon={Workflow} onClick={() => onShowNode(node.id)}>Show on canvas</Button><Button size="sm" icon={readOnly ? Eye : ArrowLeftRight} onClick={() => onOpenMapper(node.id, field.key)} data-action="open-mapper">{readOnly ? "View mapping" : "Edit mapping"}</Button></span>}>
            <RulesTable spec={spec} />
          </Section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- connections used
interface Usage { connectionId: string; steps: { id: string; name: string }[]; }
export function ConnectionsTab({ defFor, onShowNode }: { defFor: DefFor; onShowNode: (id: string) => void }) {
  const nodes = useEditor((s) => s.nodes);
  const q = useQuery({ queryKey: ["studio", "connections"], queryFn: studioApi.connections, retry: 0 });
  const [results, setResults] = useState<Record<string, ConnectionTestResult | { error: string }>>({});
  const test = useMutation({
    mutationFn: (id: string) => studioApi.testConnection(id),
    onSuccess: (r, id) => setResults((s) => ({ ...s, [id]: r })),
    onError: (e, id) => setResults((s) => ({ ...s, [id]: { error: errorText(e) } })),
  });
  const { used, direct } = useMemo(() => {
    const map = new Map<string, Usage>();
    const direct: { id: string; name: string; url: string }[] = [];
    for (const n of nodes) {
      const def = defFor(n.data.type);
      let has = false;
      for (const f of def.fields) {
        if (f.kind !== "connection") continue;
        const v = n.data.config[f.key];
        if (typeof v !== "string" || !v) continue;
        has = true;
        const u = map.get(v) ?? { connectionId: v, steps: [] };
        u.steps.push({ id: n.id, name: n.data.name });
        map.set(v, u);
      }
      const url = n.data.config.url;
      if (!has && typeof url === "string" && /^https?:\/\//i.test(url)) direct.push({ id: n.id, name: n.data.name, url });
    }
    return { used: Array.from(map.values()), direct };
  }, [nodes, defFor]);
  const byId = new Map((q.data?.connections ?? []).map((c: Connection) => [c.id, c]));
  if (!used.length && !direct.length) return <Empty icon={Plug} title="This flow does not call any system yet" hint="Connections hold the address and sign-in details of a system once, so every step can reuse them." action={<Link className="mf-button mf-button-default" to="/studio/connections">Manage connections</Link>} />;
  return (
    <div className="mf-stack" style={{ gap: 14 }} data-testid="connections-tab">
      {q.isError && <Unreachable error={q.error} what="Connections" onRetry={() => void q.refetch()} />}
      {used.length > 0 && (
        <TableWrap label="Connections used by this flow">
          <table className="mf-table">
            <thead><tr><th>Connection</th><th>Points to</th><th>Used by</th><th>Check</th></tr></thead>
            <tbody>
              {used.map((u) => {
                const c = byId.get(u.connectionId);
                const r = results[u.connectionId];
                const target = c ? txt(c.config?.baseUrl ?? c.config?.host ?? "") : "";
                return (
                  <tr key={u.connectionId}>
                    <td>{c ? <><div className="mf-cellmain">{txt(c.name)}</div><div className="mf-cellsub">{txt(c.type)}</div></> : q.isLoading ? <Spinner label="" /> : <><Badge tone="bad">Missing</Badge><div className="mf-cellsub">This connection no longer exists. Pick another one in the step.</div></>}</td>
                    <td><code className="mf-mono-sm">{target || "-"}</code></td>
                    <td><span className="mf-hstack">{u.steps.map((s) => <button key={s.id} type="button" className="mf-linkbtn" onClick={() => onShowNode(s.id)}>{txt(s.name)}</button>)}</span></td>
                    <td className="mf-nowrap">
                      {c && <Button size="sm" busy={test.isPending && test.variables === u.connectionId} onClick={() => test.mutate(u.connectionId)}>Test</Button>}
                      {r && ("error" in r ? <div className="mf-cellsub" style={{ color: "var(--err)" }}>{r.error}</div>
                        : <div className="mf-cellsub" style={{ display: "flex", alignItems: "center", gap: 4, color: r.ok ? "var(--ok)" : "var(--err)", whiteSpace: "normal" }}>{r.ok ? <CheckCircle2 size={13} aria-hidden /> : <XCircle size={13} aria-hidden />}{r.ok ? "Reachable" : "Failed"} ({fmtDuration(r.ms)}) {txt(r.detail)}</div>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
      {direct.length > 0 && (
        <Section title="Addresses written directly in a step">
          <ul className="ws-plainlist">{direct.map((d) => <li key={d.id}><button type="button" className="mf-linkbtn" onClick={() => onShowNode(d.id)}>{txt(d.name)}</button> <code className="mf-mono-sm">{txt(d.url)}</code></li>)}</ul>
          <p className="mf-help">Tip: put the address in a connection so it can be changed in one place and carries its sign-in details safely.</p>
        </Section>
      )}
      <div><Link className="mf-linkbtn" to="/studio/connections">Manage connections</Link></div>
    </div>
  );
}

// ---------------------------------------------------------------- versions
export function VersionsTab({ flowId, onRestored }: { flowId: string; onRestored: () => void }) {
  const store = useEditorStore();
  const base = useEditor((s) => s.base);
  const q = useQuery({ queryKey: ["studio", "versions", flowId, base.revision], queryFn: () => studioApi.versions(flowId), retry: 0 });
  const [view, setView] = useState<Flow | null>(null);
  const load = useMutation({ mutationFn: (rev: number) => studioApi.version(flowId, rev), onError: (e) => toast(errorText(e), "bad") });
  const restore = async (rev: number) => {
    if (!(await confirmDialog({ title: `Bring back version ${rev}?`, body: "The editor is replaced with that version. Nothing changes for callers until you save and deploy, and you can undo.", confirmLabel: "Bring it back" }))) return;
    const flow = await load.mutateAsync(rev).catch(() => null);
    if (!flow) return;
    store.load(flow);
    setView(null);
    toast(`Version ${rev} is in the editor. Save to keep it.`, "info");
    onRestored();
  };
  const versions = q.data?.versions ?? [];
  return (
    <div className="mf-stack" data-testid="versions-tab">
      {q.isLoading && <Spinner label="Loading versions…" />}
      {q.isError && <Unreachable error={q.error} what="Versions" onRetry={() => void q.refetch()} />}
      {q.data && versions.length === 0 && <Empty icon={History} title="No earlier versions" hint="Every save keeps a version you can look at or bring back." />}
      {versions.length > 0 && (
        <TableWrap label="Versions">
          <table className="mf-table">
            <thead><tr><th>Version</th><th>Saved</th><th>By</th><th>Note</th><th /></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.revision} data-version={v.revision}>
                  <td className="mf-nowrap"><span className="mf-cellmain">{txt(v.revision)}</span> {v.revision === base.revision && <Badge tone="accent">current</Badge>} {v.deployed && <Badge tone="ok">live</Badge>}</td>
                  <td className="mf-nowrap"><div className="mf-cellmain">{ago(v.savedAt)}</div><div className="mf-cellsub">{fmtTime(v.savedAt)}</div></td>
                  <td>{txt(v.savedBy) || "-"}</td>
                  <td>{txt(v.note) || <span className="mf-faint">-</span>}</td>
                  <td className="mf-nowrap" style={{ textAlign: "right" }}>
                    <Button size="sm" variant="ghost" icon={Eye} busy={load.isPending && load.variables === v.revision && !view} onClick={async () => { const f = await load.mutateAsync(v.revision).catch(() => null); if (f) setView(f); }}>View</Button>
                    {v.revision !== base.revision && <Button size="sm" icon={RotateCcw} onClick={() => void restore(v.revision)} data-action="restore">Bring back</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {view && (
        <Modal title={`Version ${view.revision}`} subtitle={`${view.nodes?.length ?? 0} steps, saved ${fmtTime(view.updatedAt)}`} onClose={() => setView(null)} width={720}
          footer={<><span style={{ flex: 1 }} /><Button onClick={() => setView(null)}>Close</Button>{view.revision !== base.revision && <Button variant="primary" icon={RotateCcw} onClick={() => void restore(view.revision)}>Bring back this version</Button>}</>}>
          <div className="mf-stack">
            <ul className="ws-plainlist">{(view.nodes ?? []).map((n) => <li key={n.id}><strong>{txt(n.name)}</strong> <span className="mf-faint">{txt(store.defFor(n.type).label)}</span></li>)}</ul>
            <details className="ws-details"><summary>Full definition</summary><CodeBlock value={view} maxHeight={360} /></details>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- settings
export function SettingsTab({ onDelete }: { onDelete?: () => void }) {
  const store = useEditorStore();
  const meta = useEditor((s) => s.meta);
  const base = useEditor((s) => s.base);
  const readOnly = useEditor((s) => s.readOnly);
  const s = meta.settings;
  const gw: FlowSettings["gateway"] = s.gateway ?? { publish: true, security: "oauth2" };
  const setGw = (patch: Partial<FlowSettings["gateway"]>) => store.setSettings({ gateway: { ...gw, ...patch } }, "settings-gw");
  const badPath = !!s.basePath && !/^\/[A-Za-z0-9\-._~/]*$/.test(s.basePath);
  return (
    <div className="ws-settings" data-testid="settings-tab">
      <Section title="About this flow">
        <div className="mf-formgrid">
          <Field label="Name" required htmlFor="ws-set-name"><input id="ws-set-name" className="mf-control" value={meta.name} readOnly={readOnly} onChange={(e) => store.setMeta({ name: e.target.value }, "meta-name")} /></Field>
          <Field label="Labels" help="Comma separated. Used for finding flows." htmlFor="ws-set-tags"><input id="ws-set-tags" className="mf-control" value={(meta.tags ?? []).join(", ")} readOnly={readOnly} onChange={(e) => store.setMeta({ tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) }, "meta-tags")} /></Field>
        </div>
        <Field label="Description" htmlFor="ws-set-desc"><textarea id="ws-set-desc" className="mf-control" rows={2} value={meta.description ?? ""} readOnly={readOnly} onChange={(e) => store.setMeta({ description: e.target.value || undefined }, "meta-desc")} /></Field>
      </Section>
      <Section title="How it is served">
        <div className="mf-formgrid">
          <Field label="Base path" required help="Every HTTP listener of this flow lives under this path." error={badPath ? "Start with / and use letters, digits, - . _ ~ only." : undefined} htmlFor="ws-set-base"><input id="ws-set-base" className="mf-control mf-control-mono" value={s.basePath ?? ""} readOnly={readOnly} placeholder="/orders/v1" onChange={(e) => store.setSettings({ basePath: e.target.value }, "settings-base")} /></Field>
          <Field label="Give up after (seconds)" help="A run that takes longer is stopped and answers with an error." htmlFor="ws-set-timeout"><input id="ws-set-timeout" className="mf-control" type="number" min={1} max={900} value={Math.round((s.timeoutMs ?? 60000) / 1000)} readOnly={readOnly} onChange={(e) => store.setSettings({ timeoutMs: Math.max(1, Number(e.target.value) || 60) * 1000 }, "settings-timeout")} /></Field>
        </div>
        <Toggle checked={s.logPayloads !== false} disabled={readOnly} onChange={(v) => store.setSettings({ logPayloads: v })} label={<span>Keep the data of each step in the execution history <span className="mf-faint">(turn off for sensitive data; secrets are always masked)</span></span>} />
      </Section>
      <Section title="API gateway">
        <Toggle checked={gw.publish !== false} disabled={readOnly} onChange={(v) => setGw({ publish: v })} label="Publish this flow on the API gateway when it is deployed" />
        <div className="mf-formgrid">
          <Field label="Who can call it" htmlFor="ws-set-sec">
            <select id="ws-set-sec" className="mf-control" value={gw.security ?? "oauth2"} disabled={readOnly} onChange={(e) => setGw({ security: e.target.value as "oauth2" | "none" })}>
              <option value="oauth2">Callers with an access token (recommended)</option>
              <option value="none">Anyone who can reach the gateway</option>
            </select>
          </Field>
          <Field label="Gateway path" help="Leave empty to use the base path." htmlFor="ws-set-ctx"><input id="ws-set-ctx" className="mf-control mf-control-mono" value={gw.context ?? ""} readOnly={readOnly} placeholder={s.basePath || "/orders/v1"} onChange={(e) => setGw({ context: e.target.value || undefined })} /></Field>
          <Field label="API version" htmlFor="ws-set-ver"><input id="ws-set-ver" className="mf-control" value={gw.version ?? ""} readOnly={readOnly} placeholder="1.0.0" onChange={(e) => setGw({ version: e.target.value || undefined })} /></Field>
          <Field label="Rate limit policy" help="Name of a gateway throttling policy. Leave empty for the default." htmlFor="ws-set-thr"><input id="ws-set-thr" className="mf-control" value={gw.throttlingPolicy ?? ""} readOnly={readOnly} placeholder="Unlimited" onChange={(e) => setGw({ throttlingPolicy: e.target.value || undefined })} /></Field>
        </div>
        {gw.security === "none" && <Callout tone="warn" title="Open to anyone who can reach the gateway">No token will be asked for. Use this only for data that is meant to be public.</Callout>}
      </Section>
      <Section title="Details">
        <dl className="mf-kv">
          <dt>Identifier</dt><dd><code className="mf-mono-sm">{txt(base.id)}</code></dd>
          <dt>Version</dt><dd>{txt(base.revision)}</dd>
          <dt>Created</dt><dd>{fmtTime(base.createdAt)}</dd>
          <dt>Last saved</dt><dd>{fmtTime(base.updatedAt)}</dd>
          {base.origin && <><dt>Started from</dt><dd>{txt((base.origin as { kind?: unknown }).kind)} {txt((base.origin as { ref?: unknown; api?: unknown }).ref ?? (base.origin as { api?: unknown }).api ?? "")}</dd></>}
        </dl>
      </Section>
      {onDelete && !readOnly && (
        <Section title="Remove">
          <p className="mf-help" style={{ margin: 0 }}>Deleting takes the flow offline and removes it together with its history. This cannot be undone.</p>
          <div><Button variant="danger" icon={Trash2} onClick={onDelete} data-action="delete-flow">Delete this flow</Button></div>
        </Section>
      )}
    </div>
  );
}
