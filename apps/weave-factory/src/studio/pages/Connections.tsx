// /studio/connections: where the address and sign-in details of each system are kept.
// Secrets are write-only: the server never sends them back, the form only shows set / not set.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plug, Plus, Trash2, PenLine } from "lucide-react";
import type { Connection } from "@traceit/weave-flow";
import { ApiError, errorText, studioApi } from "../api.ts";
import { fieldVisible, useCatalog } from "../catalog.ts";
import { iconFor } from "../icons.ts";
import { ago, Badge, Button, confirmDialog, Empty, fmtTime, IconButton, Spinner, StudioHeader, TableWrap, toast, useDocumentTitle } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { Unreachable } from "../editor/Executions.tsx";
import { ConnectionDialog, TestOutcome, type TestState } from "../editor/ConnectionDialog.tsx";
import { EditDialog } from "../editor/EditDialog.tsx";

const targetOf = (c: Connection) => txt(c.config?.baseUrl ?? (c.config?.host ? `${txt(c.config.host)}${c.config.port ? `:${txt(c.config.port)}` : ""}` : ""));

export function ConnectionsPage() {
  useDocumentTitle("Connections");
  const catalog = useCatalog();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["studio", "connections"], queryFn: studioApi.connections, retry: 0 });
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [inWords, setInWords] = useState<Connection | null>(null);
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
                      <IconButton label={`Change ${c.name} in your own words`} icon={PenLine} onClick={() => setInWords(c)} data-action="connection-change-in-words" />
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
      {inWords && <EditDialog target={{ kind: "connection", connectionId: inWords.id }} onClose={() => setInWords(null)} />}
      {editing && <ConnectionDialog existing={editing === "new" ? null : editing} types={types} onClose={() => setEditing(null)} />}
    </div>
  );
}
