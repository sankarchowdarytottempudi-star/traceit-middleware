// Form controls generated from catalog FieldDefs. Every node type, connection type and custom
// connector operation is rendered by these, so new types need no UI work.
import { createContext, useContext, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Braces, Plus, Shuffle, Trash2 } from "lucide-react";
import type { Connection, FieldDef, FunctionDoc, Json, MappingSpec } from "@traceit/weave-flow";
import { studioApi, type ExprContext } from "../api.ts";
import { mappingOf, newId } from "../graph.ts";
import { specStats } from "../mapping.ts";
import { useCatalog } from "../catalog.ts";
import { ConnectionDialog } from "./ConnectionDialog.tsx";
import { nodeRef, VARIABLES } from "../runctx.ts";
import { AutoTextArea, Badge, Button, cx, DataView, Field, IconButton, JsonEditor, Modal, Tabs, Toggle, useDebounced } from "../ui.tsx";
import { txt } from "../../lib/text.ts";

// ---------------------------------------------------------------- expression context
export interface ExprEnv {
  /** data from the last test run for the step being edited; null when nothing has run yet */
  context: ExprContext | null;
  functions: FunctionDoc[];
  /** changes when the context data changes (cheap cache key) */
  ctxKey: string;
}
export const ExprEnvContext = createContext<ExprEnv>({ context: null, functions: [], ctxKey: "" });

function insertAtCursor(el: HTMLTextAreaElement | HTMLInputElement | null, current: string, text: string): string {
  if (!el) return current + text;
  const a = el.selectionStart ?? current.length, b = el.selectionEnd ?? current.length;
  const next = current.slice(0, a) + text + current.slice(b);
  window.setTimeout(() => { try { el.focus(); el.setSelectionRange(a + text.length, a + text.length); } catch { /* not focusable */ } }, 0);
  return next;
}

/** Picker for data paths (from the last run) and functions. */
export function ExprHelper({ onInsert, onClose }: { onInsert: (text: string) => void; onClose: () => void }) {
  const env = useContext(ExprEnvContext);
  const [tab, setTab] = useState<"data" | "functions">("data");
  const [q, setQ] = useState("");
  const ctx = env.context;
  const fns = env.functions.filter((f) => !q.trim() || `${f.name} ${f.description}`.toLowerCase().includes(q.trim().toLowerCase()));
  const nodes = Object.entries(ctx?.nodes ?? {});
  return (
    <Modal title="Insert data or a function" subtitle="Click a field to insert it where your cursor is." onClose={onClose} width={640}>
      <Tabs tabs={[{ id: "data", label: "Data" }, { id: "functions", label: "Functions", count: env.functions.length }]} value={tab} onChange={setTab} />
      {tab === "data" && (
        <div className="mf-stack" data-testid="expr-data">
          {!ctx && <p className="mf-help">Run a test of the flow to pick fields from real data. Until then these names are always available:</p>}
          {ctx && <>
            <DataView label="Payload at this step ($)" value={ctx.payload ?? null} onPick={(p) => onInsert(p || "$")} maxHeight={220} />
            {ctx.request && <DataView label="Request ($request)" value={ctx.request} rootPath="$request" onPick={(p) => onInsert(p)} maxHeight={180} />}
            {nodes.map(([name, out]) => <DataView key={name} label={`Output of "${name}"`} value={out} rootPath={nodeRef(name)} onPick={(p) => onInsert(p)} maxHeight={160} />)}
          </>}
          <ul className="ws-varlist">
            {VARIABLES.map((v) => (
              <li key={v.name}><button type="button" className="ws-var" onClick={() => onInsert(v.name)}><code>{v.name}</code></button><span>{v.description}</span></li>
            ))}
          </ul>
        </div>
      )}
      {tab === "functions" && (
        <div className="mf-stack">
          <input className="mf-control mf-control-sm" type="search" placeholder="Search functions" aria-label="Search functions" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="ws-fnlist">
            {fns.map((f) => (
              <li key={f.name}>
                <button type="button" className="ws-fn" onClick={() => onInsert(f.signature)}>
                  <code>{txt(f.signature)}</code>
                  <span>{txt(f.description)}</span>
                  {f.example && <span className="ws-fn-ex">{txt(f.example)}</span>}
                </button>
              </li>
            ))}
            {fns.length === 0 && <li className="mf-help">No function matches.</li>}
          </ul>
        </div>
      )}
    </Modal>
  );
}

function shortJson(v: unknown, max = 160): string {
  const s = v === undefined ? "(nothing)" : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
/** Live result of an expression against the last run's data. Silent when the runtime is unreachable. */
export function ExprResult({ expr, template }: { expr: string; template?: boolean }) {
  const env = useContext(ExprEnvContext);
  const debounced = useDebounced(expr, 450);
  const active = !!env.context && !!debounced.trim() && (!template || debounced.includes("{{"));
  const q = useQuery({
    queryKey: ["studio", "expr", debounced, template ? 1 : 0, env.ctxKey],
    queryFn: () => studioApi.evalExpr(debounced, env.context!, template),
    enabled: active, retry: 0, staleTime: 60_000,
  });
  if (!active || q.isError || !q.data) return null;
  return q.data.ok
    ? <div className="ws-exprout" data-expr-result="ok"><span className="ws-exprout-eq">=</span><code>{shortJson(q.data.result)}</code></div>
    : <div className="ws-exprout ws-exprout-bad" data-expr-result="error">{txt(q.data.error) || "This expression cannot be evaluated."}</div>;
}

/** Editor for expressions and templates: monospace box, insert helper, live result. */
export function ExprInput({ value, onChange, mode, placeholder, readOnly, ariaLabel, id, minRows = 1, maxRows = 10, live = true }: {
  value: string; onChange: (v: string) => void; mode: "expr" | "template" | "code"; placeholder?: string; readOnly?: boolean; ariaLabel?: string; id?: string; minRows?: number; maxRows?: number; live?: boolean;
}) {
  const [helper, setHelper] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const insert = (text: string) => {
    const el = box.current?.querySelector("textarea") ?? null;
    const t = mode === "template" ? `{{ ${text} }}` : text;
    onChange(insertAtCursor(el, value ?? "", t));
    setHelper(false);
  };
  return (
    <div className="ws-expr" ref={box}>
      <div className="ws-expr-box">
        <AutoTextArea id={id} mono value={value ?? ""} onChange={onChange} placeholder={placeholder} readOnly={readOnly} aria-label={ariaLabel} minRows={mode === "code" ? Math.max(3, minRows) : minRows} maxRows={mode === "code" ? 18 : maxRows} />
        {!readOnly && <IconButton className="ws-expr-btn" label="Insert data or a function" icon={Braces} size={14} onClick={() => setHelper(true)} />}
      </div>
      {live && <ExprResult expr={value ?? ""} template={mode === "template"} />}
      {helper && <ExprHelper onInsert={insert} onClose={() => setHelper(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- list editors
type KV = { key: string; value: string };
export function KeyValueEditor({ value, onChange, readOnly, keyLabel = "Name", valueLabel = "Value", addLabel = "Add row", expr = true }: {
  value: unknown; onChange: (v: KV[]) => void; readOnly?: boolean; keyLabel?: string; valueLabel?: string; addLabel?: string; expr?: boolean;
}) {
  const rows: KV[] = Array.isArray(value) ? (value as KV[]).map((r) => ({ key: String(r?.key ?? ""), value: String(r?.value ?? "") })) : [];
  const set = (i: number, patch: Partial<KV>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="mf-rows">
      {rows.map((r, i) => (
        <div className="mf-rowline" key={i}>
          <input className="mf-control mf-control-sm" style={{ flex: "0 1 38%" }} aria-label={`${keyLabel} ${i + 1}`} placeholder={keyLabel} value={r.key} readOnly={readOnly} onChange={(e) => set(i, { key: e.target.value })} />
          {expr
            ? <div style={{ flex: "1 1 0", minWidth: 0 }}><ExprInput mode="template" value={r.value} onChange={(v) => set(i, { value: v })} placeholder={valueLabel} ariaLabel={`${valueLabel} ${i + 1}`} readOnly={readOnly} live={false} maxRows={4} /></div>
            : <input className="mf-control mf-control-sm" aria-label={`${valueLabel} ${i + 1}`} placeholder={valueLabel} value={r.value} readOnly={readOnly} onChange={(e) => set(i, { value: e.target.value })} />}
          {!readOnly && <IconButton label={`Remove row ${i + 1}`} icon={Trash2} tone="danger" size={14} onClick={() => onChange(rows.filter((_, j) => j !== i))} />}
        </div>
      ))}
      {rows.length === 0 && readOnly && <span className="mf-help">None</span>}
      {!readOnly && <div><Button size="sm" variant="ghost" icon={Plus} onClick={() => onChange([...rows, { key: "", value: "" }])}>{addLabel}</Button></div>}
    </div>
  );
}
type Cond = { id: string; label: string; expr?: string };
function ConditionsEditor({ value, onChange, readOnly, withExpr }: { value: unknown; onChange: (v: Cond[]) => void; readOnly?: boolean; withExpr: boolean }) {
  const rows: Cond[] = Array.isArray(value) ? (value as Cond[]).filter((r) => r && typeof r === "object") : [];
  const set = (i: number, patch: Partial<Cond>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => {
    const ids = new Set(rows.map((r) => r.id));
    let id = withExpr ? `c${rows.length + 1}` : String.fromCharCode(97 + (rows.length % 26));
    while (ids.has(id)) id = newId(withExpr ? "c" : "b");
    onChange([...rows, withExpr ? { id, label: `Case ${rows.length + 1}`, expr: "" } : { id, label: id.toUpperCase() }]);
  };
  return (
    <div className="mf-rows">
      {rows.map((r, i) => (
        <div className="ws-cond" key={r.id || i}>
          <div className="mf-rowline">
            <input className="mf-control mf-control-sm" aria-label={`Label ${i + 1}`} placeholder="Label" value={r.label ?? ""} readOnly={readOnly} onChange={(e) => set(i, { label: e.target.value })} />
            {!readOnly && <IconButton label={`Remove ${r.label || `row ${i + 1}`}`} icon={Trash2} tone="danger" size={14} onClick={() => onChange(rows.filter((_, j) => j !== i))} />}
          </div>
          {withExpr && !(readOnly && !r.expr) && <ExprInput mode="expr" value={r.expr ?? ""} onChange={(v) => set(i, { expr: v })} placeholder={'status = "CONFIRMED"'} ariaLabel={`Condition ${i + 1}`} readOnly={readOnly} />}
        </div>
      ))}
      {!readOnly && <div><Button size="sm" variant="ghost" icon={Plus} onClick={add}>{withExpr ? "Add condition" : "Add branch"}</Button></div>}
    </div>
  );
}
function StringListEditor({ value, onChange, readOnly, placeholder }: { value: unknown; onChange: (v: string[]) => void; readOnly?: boolean; placeholder?: string }) {
  const rows: string[] = Array.isArray(value) ? (value as unknown[]).map((v) => String(v ?? "")) : [];
  return (
    <div className="mf-rows">
      {rows.map((r, i) => (
        <div className="mf-rowline" key={i}>
          <input className="mf-control mf-control-sm mf-control-mono" aria-label={`Item ${i + 1}`} placeholder={placeholder} value={r} readOnly={readOnly} onChange={(e) => onChange(rows.map((x, j) => (j === i ? e.target.value : x)))} />
          {!readOnly && <IconButton label={`Remove item ${i + 1}`} icon={Trash2} tone="danger" size={14} onClick={() => onChange(rows.filter((_, j) => j !== i))} />}
        </div>
      ))}
      {!readOnly && <div><Button size="sm" variant="ghost" icon={Plus} onClick={() => onChange([...rows, ""])}>Add item</Button></div>}
    </div>
  );
}

// ---------------------------------------------------------------- pickers
const NEW_CONNECTION = "__new_connection__";
/** A step's Connection dropdown: pick one, create one right here ("+ New … connection…"), or edit the chosen one. */
function ConnectionPicker({ value, onChange, type, readOnly, id }: { value: unknown; onChange: (v: string | undefined) => void; type?: string; readOnly?: boolean; id?: string }) {
  const q = useQuery({ queryKey: ["studio", "connections"], queryFn: studioApi.connections, retry: 0, staleTime: 15_000 });
  const catalog = useCatalog();
  const [dialog, setDialog] = useState<null | "new" | Connection>(null);
  const all = q.data?.connections ?? [];
  const list = type ? all.filter((c) => c.type === type) : all;
  const cur = typeof value === "string" ? value : "";
  const current = all.find((c) => c.id === cur);
  const missing = !!cur && !q.isLoading && !current;
  const def = type ? catalog.connectionTypes.find((t) => t.type === type) : undefined;
  const canCreate = !readOnly && !!def;
  return (
    <div className="mf-stack" style={{ gap: 6 }}>
      <select id={id} className="mf-control" value={cur} disabled={readOnly} data-field-kind="connection"
        onChange={(e) => { if (e.target.value === NEW_CONNECTION) { setDialog("new"); return; } onChange(e.target.value || undefined); }}>
        <option value="">{q.isLoading ? "Loading connections…" : "No connection"}</option>
        {list.map((c) => <option key={c.id} value={c.id}>{txt(c.name)}</option>)}
        {missing && <option value={cur}>Unavailable connection ({cur})</option>}
        {canCreate && <option value={NEW_CONNECTION}>+ New {txt(def!.label)} connection…</option>}
      </select>
      {missing && !q.isError && <span className="mf-field-error">This connection no longer exists. Pick another one or create a new one.</span>}
      {q.isError && <span className="mf-help">Connections cannot be listed right now.</span>}
      {!readOnly && (
        <span className="mf-help" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          {list.length === 0 && !q.isLoading && !q.isError && <span>No {def ? txt(def.label) : "such"} connection yet.</span>}
          {canCreate && <Button size="sm" variant="ghost" icon={Plus} onClick={() => setDialog("new")} data-action="new-connection-here">New connection</Button>}
          {current && def && <Button size="sm" variant="ghost" onClick={() => setDialog(current)} data-action="edit-connection-here">Edit connection</Button>}
          <Link to="/studio/connections" target="_blank" rel="noreferrer">Manage connections</Link>
        </span>
      )}
      {dialog && (
        <ConnectionDialog existing={dialog === "new" ? null : dialog} types={catalog.connectionTypes} fixedType={type}
          onSaved={(c) => { if (dialog === "new") onChange(c.id); }} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
function FlowPicker({ value, onChange, readOnly, id }: { value: unknown; onChange: (v: string | undefined) => void; readOnly?: boolean; id?: string }) {
  const q = useQuery({ queryKey: ["studio", "flows"], queryFn: studioApi.flows, retry: 0, staleTime: 15_000 });
  const cur = typeof value === "string" ? value : "";
  const list = q.data?.flows ?? [];
  return (
    <select id={id} className="mf-control" value={cur} disabled={readOnly} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{q.isLoading ? "Loading flows…" : "Choose a flow"}</option>
      {list.map((f) => <option key={f.id} value={f.id}>{txt(f.name)}</option>)}
      {cur && !list.some((f) => f.id === cur) && <option value={cur}>{cur}</option>}
    </select>
  );
}
export function MappingSummary({ spec, onOpen, readOnly }: { spec: MappingSpec; onOpen?: () => void; readOnly?: boolean }) {
  const s = specStats(spec);
  return (
    <div className="ws-mapsum">
      <div className="mf-hstack">
        <Badge tone={s.total ? "accent" : "neutral"}>{s.total === 1 ? "1 rule" : `${s.total} rules`}</Badge>
        {s.byKind.instruction > 0 && <Badge tone="info">{s.byKind.instruction} in your words</Badge>}
        {s.unresolved > 0 && <Badge tone="bad">{s.unresolved} not understood</Badge>}
        {s.incomplete > 0 && <Badge tone="warn">{s.incomplete} incomplete</Badge>}
      </div>
      {onOpen && <Button icon={Shuffle} onClick={onOpen} data-action="open-mapper">{readOnly ? "View mapping" : s.total ? "Edit mapping" : "Build mapping"}</Button>}
    </div>
  );
}

// ---------------------------------------------------------------- field
export interface FieldEnv {
  readOnly?: boolean;
  /** opens the full-screen mapper for a field of kind "mapping" */
  onOpenMapper?: (fieldKey: string) => void;
  /** connections: which secret fields already hold a stored value */
  secretsSet?: string[];
}
export function FieldControl({ field: f, value, onChange, env, id }: { field: FieldDef; value: unknown; onChange: (v: unknown) => void; env: FieldEnv; id: string }) {
  const ro = env.readOnly;
  const str = typeof value === "string" ? value : value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (f.secret) {
    const isSet = !!env.secretsSet?.includes(f.key);
    return (
      <div className="mf-inputrow">
        <input id={id} className="mf-control" type="password" autoComplete="new-password" value={str} readOnly={ro} placeholder={isSet ? "Stored. Type a new value to replace it" : "Not set"} onChange={(e) => onChange(e.target.value)} data-secret={isSet ? "set" : "not-set"} />
        <Badge tone={isSet ? "ok" : "neutral"}>{isSet ? "set" : "not set"}</Badge>
      </div>
    );
  }
  switch (f.kind) {
    case "text":
      return <input id={id} className="mf-control" value={str} placeholder={f.placeholder} readOnly={ro} onChange={(e) => onChange(e.target.value)} />;
    case "textarea":
      return <AutoTextArea id={id} value={str} placeholder={f.placeholder} readOnly={ro} minRows={3} onChange={onChange} />;
    case "number":
      return <input id={id} className="mf-control" type="number" inputMode="decimal" value={value === undefined || value === null ? "" : str} placeholder={f.placeholder} readOnly={ro} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />;
    case "boolean":
      return <Toggle id={id} checked={value === true} disabled={ro} onChange={onChange} label={value === true ? "On" : "Off"} />;
    case "select":
      return (
        <select id={id} className="mf-control" value={str} disabled={ro} onChange={(e) => onChange(e.target.value)}>
          {!f.options?.some((o) => o.value === str) && <option value={str}>{str || "Choose…"}</option>}
          {f.options?.map((o) => <option key={o.value} value={o.value}>{txt(o.label)}</option>)}
        </select>
      );
    case "multiselect": {
      const cur = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="mf-checks" role="group">
          {f.options?.map((o) => {
            const on = cur.includes(o.value);
            return (
              <label key={o.value} className={cx("mf-check", on && "mf-check-on")}>
                <input type="checkbox" checked={on} disabled={ro} onChange={() => onChange(on ? cur.filter((v) => v !== o.value) : [...cur, o.value])} />
                {txt(o.label)}
              </label>
            );
          })}
        </div>
      );
    }
    case "json":
      return <JsonEditor id={id} value={value} onChange={onChange} placeholder={f.placeholder} disabled={ro} />;
    case "keyvalue":
      return <KeyValueEditor value={value} onChange={onChange} readOnly={ro} />;
    case "template":
      return <ExprInput id={id} mode="template" value={str} onChange={onChange} placeholder={f.placeholder} readOnly={ro} />;
    case "expr":
      return <ExprInput id={id} mode="expr" value={str} onChange={onChange} placeholder={f.placeholder} readOnly={ro} />;
    case "code":
      return <ExprInput id={id} mode="code" value={str} onChange={onChange} placeholder={f.placeholder} readOnly={ro} />;
    case "graphql":
    case "sql":
      return <AutoTextArea id={id} mono value={str} placeholder={f.placeholder} readOnly={ro} minRows={4} maxRows={18} onChange={onChange} />;
    case "connection":
      return <ConnectionPicker id={id} value={value} onChange={onChange} type={f.connectionType} readOnly={ro} />;
    case "flow":
      return <FlowPicker id={id} value={value} onChange={onChange} readOnly={ro} />;
    case "mapping":
      return <MappingSummary spec={mappingOf(value)} readOnly={ro} onOpen={env.onOpenMapper ? () => env.onOpenMapper!(f.key) : undefined} />;
    case "conditions":
      return <ConditionsEditor value={value} onChange={onChange} readOnly={ro} withExpr />;
    case "branches":
      return <ConditionsEditor value={value} onChange={onChange} readOnly={ro} withExpr={false} />;
    case "stringlist":
      return <StringListEditor value={value} onChange={onChange} readOnly={ro} placeholder={f.placeholder} />;
    default:
      return <JsonEditor id={id} value={value as Json} onChange={onChange} disabled={ro} />;
  }
}
export function FieldRow({ field, value, onChange, env, error }: { field: FieldDef; value: unknown; onChange: (v: unknown) => void; env: FieldEnv; error?: ReactNode }) {
  const id = useId();
  const hint = field.kind === "template" ? "Text. Use {{ }} to insert data." : field.kind === "expr" || field.kind === "code" ? "Expression" : undefined;
  return (
    <Field label={txt(field.label)} htmlFor={id} required={field.required} help={field.help ? txt(field.help) : undefined} error={error} aside={hint} className={`ws-field ws-field-${field.kind}`}>
      <div data-field={field.key}><FieldControl field={field} value={value} onChange={onChange} env={env} id={id} /></div>
    </Field>
  );
}
/** Splits fields into the always-visible ones and named groups ("Advanced", "Headers"...). */
export function groupFields(fields: FieldDef[]): { main: FieldDef[]; groups: { name: string; fields: FieldDef[] }[] } {
  const main: FieldDef[] = [];
  const groups: { name: string; fields: FieldDef[] }[] = [];
  for (const f of fields) {
    if (!f.group) { main.push(f); continue; }
    const g = groups.find((x) => x.name === f.group);
    if (g) g.fields.push(f); else groups.push({ name: f.group, fields: [f] });
  }
  return { main, groups };
}
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}
/** An ExprEnv whose identity only changes when the data or the function list changes. */
export function useStableEnv(context: ExprContext | null, functions: FunctionDoc[]): ExprEnv {
  const ctxKey = useMemo(() => hash(JSON.stringify(context ?? null)), [context]);
  const ref = useRef<ExprEnv>({ context: null, functions, ctxKey: "" });
  if (ref.current.ctxKey !== ctxKey || ref.current.functions !== functions) ref.current = { context, functions, ctxKey };
  return ref.current;
}
