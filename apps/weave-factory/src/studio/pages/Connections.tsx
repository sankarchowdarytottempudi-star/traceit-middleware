// /studio/connections: where the address and sign-in details of each system are kept.
// Secrets are write-only: the server never sends them back, the form only shows set / not set.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Pencil, Plug, Plus, Trash2, XCircle } from "lucide-react";
import type { Connection, ConnectionTypeDef, SaveConnectionRequest } from "@traceit/weave-flow";
import { ApiError, errorText, isUnavailable, studioApi, type ConnectionTestResult } from "../api.ts";
import { fieldVisible, useCatalog } from "../catalog.ts";
import { iconFor } from "../icons.ts";
import { ago, Badge, Button, Callout, Collapsible, confirmDialog, cx, Empty, Field, fmtDuration, fmtTime, IconButton, Modal, Spinner, StudioHeader, TableWrap, toast, useDocumentTitle } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { Unreachable } from "../editor/Executions.tsx";
import { FieldRow, groupFields, type FieldEnv } from "../editor/fields.tsx";

type TestState = ConnectionTestResult | { error: string };
function TestOutcome({ r }: { r: TestState | undefined }) {
  if (!r) return null;
  if ("error" in r) return <span className="ws-testline ws-testline-bad" data-test-result="error"><XCircle size={14} aria-hidden />{r.error}</span>;
  return <span className={cx("ws-testline", r.ok ? "ws-testline-ok" : "ws-testline-bad")} data-test-result={r.ok ? "ok" : "failed"}>{r.ok ? <CheckCircle2 size={14} aria-hidden /> : <XCircle size={14} aria-hidden />}<span>{r.ok ? "It works" : "It did not answer as expected"} ({fmtDuration(r.ms)}){r.detail ? `: ${txt(r.detail)}` : ""}</span></span>;
}
const targetOf = (c: Connection) => txt(c.config?.baseUrl ?? (c.config?.host ? `${txt(c.config.host)}${c.config.port ? `:${txt(c.config.port)}` : ""}` : ""));

function defaultsOf(def: ConnectionTypeDef | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def?.fields ?? []) if (!f.secret && f.default !== undefined) out[f.key] = f.default;
  return out;
}

function ConnectionDialog({ existing, types, onClose }: { existing: Connection | null; types: ConnectionTypeDef[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [type, setType] = useState(existing?.type ?? types[0]?.type ?? "http");
  const def = types.find((t) => t.type === type);
  const [name, setName] = useState(existing?.name ?? "");
  const [config, setConfig] = useState<Record<string, unknown>>(() => existing?.config ?? defaultsOf(types.find((t) => t.type === (existing?.type ?? types[0]?.type))));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [tested, setTested] = useState<TestState | undefined>();
  const [problem, setProblem] = useState<string | null>(null);
  const visible = (def?.fields ?? []).filter((f) => fieldVisible(f, config));
  const { main, groups } = groupFields(visible);
  const env: FieldEnv = { secretsSet: existing?.secretsSet ?? [] };
  const request = (): SaveConnectionRequest => {
    const cfg: Record<string, unknown> = {};
    for (const f of visible) if (!f.secret && config[f.key] !== undefined && config[f.key] !== "") cfg[f.key] = config[f.key];
    const sec: Record<string, string> = {};
    for (const f of visible) if (f.secret && secrets[f.key]) sec[f.key] = secrets[f.key];
    return { name: name.trim(), type, config: cfg, ...(Object.keys(sec).length ? { secrets: sec } : {}) };
  };
  const missing = visible.filter((f) => f.required && !f.secret && (config[f.key] === undefined || config[f.key] === "")).map((f) => f.label);
  const save = useMutation({
    mutationFn: () => (existing ? studioApi.updateConnection(existing.id, request()) : studioApi.createConnection(request())),
    onMutate: () => setProblem(null),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["studio", "connections"] }); toast(existing ? "Connection saved." : "Connection created."); onClose(); },
    onError: (e) => setProblem(isUnavailable(e) ? "The flow engine cannot be reached right now, so nothing was saved." : errorText(e)),
  });
  const test = useMutation({
    // an existing connection is tested with its stored secrets unless new ones were typed
    mutationFn: () => (existing && !Object.values(secrets).some(Boolean) && JSON.stringify(request().config) === JSON.stringify(existing.config) ? studioApi.testConnection(existing.id) : studioApi.testConnectionDraft(request())),
    onMutate: () => setTested(undefined),
    onSuccess: (r) => setTested(r),
    onError: (e) => setTested({ error: errorText(e) }),
  });
  const row = (f: (typeof visible)[number]) => (
    <FieldRow key={f.key} field={f} env={env} value={f.secret ? secrets[f.key] ?? "" : config[f.key]}
      onChange={(v) => { setTested(undefined); if (f.secret) setSecrets((s) => ({ ...s, [f.key]: String(v ?? "") })); else setConfig((c) => ({ ...c, [f.key]: v })); }} />
  );
  return (
    <Modal title={existing ? "Edit connection" : "New connection"} subtitle={def ? txt(def.description) : undefined} onClose={onClose} width={620}
      footer={<>
        <Button busy={test.isPending} disabled={!def || missing.length > 0} onClick={() => test.mutate()} data-action="test-connection">Test connection</Button>
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={save.isPending} disabled={!name.trim() || !def || missing.length > 0} onClick={() => save.mutate()} data-action="save-connection">{existing ? "Save" : "Create connection"}</Button>
      </>}>
      <div className="mf-stack" style={{ gap: 14 }} data-testid="connection-form">
        <div className="mf-formgrid">
          <Field label="Name" required htmlFor="ws-conn-name"><input id="ws-conn-name" className="mf-control" autoFocus={!existing} value={name} onChange={(e) => setName(e.target.value)} placeholder="Reservations system" maxLength={120} /></Field>
          <Field label="Kind" htmlFor="ws-conn-type">
            <select id="ws-conn-type" className="mf-control" value={type} disabled={!!existing} onChange={(e) => { setType(e.target.value); setConfig(defaultsOf(types.find((t) => t.type === e.target.value))); setSecrets({}); setTested(undefined); }}>
              {types.map((t) => <option key={t.type} value={t.type}>{txt(t.label)}</option>)}
              {existing && !def && <option value={type}>{type}</option>}
            </select>
          </Field>
        </div>
        {!def && <Callout tone="warn">This kind of connection is not available on this server, so it cannot be edited here.</Callout>}
        {main.map(row)}
        {groups.map((g) => <Collapsible key={g.name} title={txt(g.name)} count={g.fields.length}>{g.fields.map(row)}</Collapsible>)}
        {visible.some((f) => f.secret) && <p className="mf-help" style={{ margin: 0 }}>Passwords, tokens and keys are stored on this server only. They are never shown again, never written to logs and never leave it{existing ? "; leave a field empty to keep what is stored" : ""}.</p>}
        {missing.length > 0 && <p className="mf-help" style={{ margin: 0 }}>Still needed: {missing.join(", ")}.</p>}
        <TestOutcome r={tested} />
        {problem && <Callout tone="bad" title="Not saved">{problem}</Callout>}
      </div>
    </Modal>
  );
}

export function ConnectionsPage() {
  useDocumentTitle("Connections");
  const catalog = useCatalog();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["studio", "connections"], queryFn: studioApi.connections, retry: 0 });
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [results, setResults] = useState<Record<string, TestState>>({});
  const test = useMutation({
    mutationFn: (id: string) => studioApi.testConnection(id),
    onSuccess: (r, id) => setResults((s) => ({ ...s, [id]: r })),
    onError: (e, id) => setResults((s) => ({ ...s, [id]: { error: errorText(e) } })),
  });
  const remove = useMutation({
    mutationFn: (c: Connection) => studioApi.deleteConnection(c.id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["studio", "connections"] }); toast("Connection deleted.", "info"); },
    onError: (e) => {
      const used = e instanceof ApiError && e.status === 409;
      toast(used ? `This connection is still used by a flow, so it was not deleted. ${e.detail ?? ""}` : errorText(e), "bad");
    },
  });
  const types = catalog.connectionTypes;
  const typeOf = useMemo(() => new Map(types.map((t) => [t.type, t])), [types]);
  const list = q.data?.connections ?? [];
  return (
    <div className="mf-stack ws-page" style={{ gap: 20 }}>
      <StudioHeader area="Build" title="Connections" subtitle="The address and sign-in details of each system, kept in one place and reused by every flow."
        actions={<Button variant="primary" icon={Plus} onClick={() => setEditing("new")} data-action="new-connection">New connection</Button>} />
      {q.isLoading && <Spinner label="Loading connections…" />}
      {q.isError && !q.data && <Unreachable error={q.error} what="Connections" onRetry={() => void q.refetch()} />}
      {q.data && list.length === 0 && <Empty icon={Plug} title="No connections yet" hint="Create one for each system your flows talk to: an API, a cache, a database." action={<Button variant="primary" icon={Plus} onClick={() => setEditing("new")}>New connection</Button>} />}
      {list.length > 0 && (
        <TableWrap label="Connections">
          <table className="mf-table" data-testid="connections">
            <thead><tr><th>Connection</th><th>Points to</th><th>Secrets</th><th>Changed</th><th>Check</th><th /></tr></thead>
            <tbody>
              {list.map((c) => {
                const def = typeOf.get(c.type);
                const Icon = iconFor(def?.icon ?? "Plug");
                const secretFields = (def?.fields ?? []).filter((f) => f.secret && fieldVisible(f, c.config ?? {}));
                return (
                  <tr key={c.id} data-connection={c.name}>
                    <td><span className="mf-hstack" style={{ flexWrap: "nowrap" }}><span className="mf-iconchip" style={{ ["--chip" as string]: "var(--ws-http)" }}><Icon size={16} aria-hidden /></span><span style={{ minWidth: 0 }}><button type="button" className="mf-linkbtn mf-cellmain" onClick={() => setEditing(c)}>{txt(c.name)}</button><div className="mf-cellsub">{txt(def?.label ?? c.type)}</div></span></span></td>
                    <td><code className="mf-mono-sm" style={{ overflowWrap: "anywhere" }}>{targetOf(c) || "-"}</code></td>
                    <td>{secretFields.length === 0 ? <span className="mf-faint">None needed</span> : <span className="mf-hstack">{secretFields.map((f) => { const set = c.secretsSet?.includes(f.key); return <Badge key={f.key} tone={set ? "ok" : "warn"}>{txt(f.label)}: {set ? "set" : "not set"}</Badge>; })}</span>}</td>
                    <td className="mf-nowrap" title={fmtTime(c.updatedAt)}>{ago(c.updatedAt)}</td>
                    <td><Button size="sm" busy={test.isPending && test.variables === c.id} onClick={() => test.mutate(c.id)} data-action="test">Test</Button><div style={{ marginTop: 4 }}><TestOutcome r={results[c.id]} /></div></td>
                    <td className="mf-nowrap" style={{ textAlign: "right" }}>
                      <IconButton label={`Edit ${c.name}`} icon={Pencil} onClick={() => setEditing(c)} />
                      <IconButton label={`Delete ${c.name}`} icon={Trash2} tone="danger" onClick={async () => { if (await confirmDialog({ title: `Delete "${c.name}"?`, body: "Flows that use it will stop working until they are pointed at another connection.", confirmLabel: "Delete", danger: true })) remove.mutate(c); }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
      {editing && <ConnectionDialog existing={editing === "new" ? null : editing} types={types} onClose={() => setEditing(null)} />}
    </div>
  );
}
