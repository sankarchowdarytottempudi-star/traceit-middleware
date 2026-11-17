// The form that creates or edits a connection: used on the Connections page and straight from a step's
// Connection dropdown. Secrets are write-only: the server never sends them back, the form shows set / not set.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import { secretLooksLabelled, zohoMismatch, type Connection, type ConnectionTypeDef, type SaveConnectionRequest } from "@traceit/weave-flow";
import { errorText, isUnavailable, studioApi, type ConnectionTestResult } from "../api.ts";
import { fieldVisible } from "../catalog.ts";
import { Button, Callout, Collapsible, cx, Field, fmtDuration, Modal, toast } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { FieldRow, groupFields, type FieldEnv } from "./fields.tsx";

export type TestState = ConnectionTestResult | { error: string };
export function TestOutcome({ r }: { r: TestState | undefined }) {
  if (!r) return null;
  if ("error" in r) return <span className="ws-testline ws-testline-bad" data-test-result="error"><XCircle size={14} aria-hidden />{r.error}</span>;
  return <span className={cx("ws-testline", r.ok ? "ws-testline-ok" : "ws-testline-bad")} data-test-result={r.ok ? "ok" : "failed"}>{r.ok ? <CheckCircle2 size={14} aria-hidden /> : <XCircle size={14} aria-hidden />}<span>{r.ok ? "It works" : "It did not answer as expected"} ({fmtDuration(r.ms)}){r.detail ? `: ${txt(r.detail)}` : ""}</span></span>;
}

export function defaultsOf(def: ConnectionTypeDef | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def?.fields ?? []) if (!f.secret && f.default !== undefined) out[f.key] = f.default;
  return out;
}

/** Create or edit a connection. `fixedType` locks the kind (a step's own dropdown); `onSaved` gets the saved connection. */
export function ConnectionDialog({ existing, types, onClose, fixedType, onSaved, initialName, initialConfig }: { existing: Connection | null; types: ConnectionTypeDef[]; onClose: () => void; fixedType?: string; onSaved?: (c: Connection) => void; initialName?: string; initialConfig?: Record<string, unknown> }) {
  const qc = useQueryClient();
  const [type, setType] = useState(existing?.type ?? fixedType ?? types[0]?.type ?? "http");
  const def = types.find((t) => t.type === type);
  const [name, setName] = useState(existing?.name ?? initialName ?? "");
  const [config, setConfig] = useState<Record<string, unknown>>(() => existing ? { ...existing.config, ...(initialConfig ?? {}) } : { ...defaultsOf(types.find((t) => t.type === (fixedType ?? types[0]?.type))), ...(initialConfig ?? {}) });
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
  // pasted values that still carry their label ("Client Secret: 1000.…"): say which field, never the value
  const labelled = visible.filter((f) => (f.secret ? secretLooksLabelled(secrets[f.key]) : typeof config[f.key] === "string" && /client|token|key|secret/i.test(f.key) && secretLooksLabelled(String(config[f.key])))).map((f) => f.label);
  const centre = config.authType === "oauth2refresh" || config.authType === "oauth2cc" ? zohoMismatch(String(config.tokenUrl ?? ""), String(config.baseUrl ?? "")) : null;
  const missing = visible.filter((f) => f.required && !f.secret && (config[f.key] === undefined || config[f.key] === "")).map((f) => f.label);
  const save = useMutation({
    mutationFn: () => (existing ? studioApi.updateConnection(existing.id, request()) : studioApi.createConnection(request())),
    onMutate: () => setProblem(null),
    onSuccess: (c) => { void qc.invalidateQueries({ queryKey: ["studio", "connections"] }); toast(existing ? "Connection saved." : "Connection created."); onSaved?.(c); onClose(); },
    onError: (e) => setProblem(isUnavailable(e) ? "The flow engine cannot be reached right now, so nothing was saved." : errorText(e)),
  });
  const test = useMutation({
    // an existing connection is tested with its stored secrets unless new ones were typed
    mutationFn: () => (existing && !Object.values(secrets).some(Boolean) && JSON.stringify(request().config) === JSON.stringify(existing.config) ? studioApi.testConnection(existing.id) : studioApi.testConnectionDraft(request(), existing?.id)),
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
          <Field label="Name" required htmlFor="ws-conn-name"><input id="ws-conn-name" className="mf-control" autoFocus={!existing} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Local test database" maxLength={120} /></Field>
          <Field label="Kind" htmlFor="ws-conn-type">
            <select id="ws-conn-type" className="mf-control" value={type} disabled={!!existing || !!fixedType} onChange={(e) => { setType(e.target.value); setConfig(defaultsOf(types.find((t) => t.type === e.target.value))); setSecrets({}); setTested(undefined); }}>
              {types.map((t) => <option key={t.type} value={t.type}>{txt(t.label)}</option>)}
              {existing && !def && <option value={type}>{type}</option>}
            </select>
          </Field>
        </div>
        {!def && <Callout tone="warn">This kind of connection is not available on this server, so it cannot be edited here.</Callout>}
        {main.map(row)}
        {groups.map((g) => <Collapsible key={g.name} title={txt(g.name)} count={g.fields.length}>{g.fields.map(row)}</Collapsible>)}
        {visible.some((f) => f.secret) && <p className="mf-help" style={{ margin: 0 }}>Passwords, tokens and keys are stored on this server only. They are never shown again, never written to logs and never leave it{existing ? "; leave a field empty to keep what is stored" : ""}.</p>}
        {labelled.length > 0 && <Callout tone="warn" title="Paste only the value">{labelled.join(", ")} {labelled.length === 1 ? "starts" : "start"} with a label such as "Client Secret:" or "Refresh Token:". Remove the label and keep only the value.</Callout>}
        {centre && <Callout tone="warn" title="Two different Zoho data centres">{centre}</Callout>}
        {missing.length > 0 && <p className="mf-help" style={{ margin: 0 }}>Still needed: {missing.join(", ")}.</p>}
        <TestOutcome r={tested} />
        {problem && <Callout tone="bad" title="Not saved">{problem}</Callout>}
      </div>
    </Modal>
  );
}

