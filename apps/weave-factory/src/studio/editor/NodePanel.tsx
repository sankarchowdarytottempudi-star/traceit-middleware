// Configuration panel of the selected step, generated from the catalog definition.
import { useMemo, useState } from "react";
import { Play, Power, Trash2, X, PenLine } from "lucide-react";
import type { FieldDef, HttpRequestSample, NodeTypeDef } from "@traceit/weave-flow";
import { accentOf, fieldVisible, type Catalog } from "../catalog.ts";
import { iconFor } from "../icons.ts";
import { contextForNode } from "../runctx.ts";
import { useEditor, useEditorStore } from "../store.ts";
import { AutoTextArea, Badge, Button, Callout, CodeBlock, Collapsible, DataView, Field, IconButton, Tabs } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { ExprEnvContext, FieldRow, groupFields, useStableEnv, type FieldEnv } from "./fields.tsx";
import { StepDetail } from "./RunViews.tsx";

interface SourceRef { file?: string; line?: number; endLine?: number; code?: string }

export function NodePanel({ nodeId, catalog, defFor, onClose, onOpenMapper, onTest, sample, onChangeInWords }: {
  nodeId: string; catalog: Catalog; defFor: (type: string) => NodeTypeDef; onClose: () => void;
  onOpenMapper: (nodeId: string, fieldKey: string) => void; onTest?: (nodeId: string) => void; sample?: HttpRequestSample | null;
  onChangeInWords?: (nodeId: string) => void;
}) {
  const store = useEditorStore();
  const node = useEditor((s) => s.nodes.find((n) => n.id === nodeId));
  const issues = useEditor((s) => s.issuesByNode[nodeId]);
  const traces = useEditor((s) => s.tracesByNode[nodeId]);
  const allTraces = useEditor((s) => s.tracesByNode);
  const run = useEditor((s) => s.run);
  const readOnly = useEditor((s) => s.readOnly);
  const [tab, setTab] = useState<"settings" | "run">("settings");
  const graph = useEditor((s) => s.nodes);
  const context = useMemo(() => contextForNode(run, allTraces, nodeId, sample, graph), [run, allTraces, nodeId, sample, graph]);
  const exprEnv = useStableEnv(context, catalog.functions);
  if (!node) return null;
  const d = node.data;
  const def = defFor(d.type);
  const Icon = iconFor(def.icon);
  const known = catalog.byType.has(d.type);
  const { main, groups } = groupFields(def.fields.filter((f) => fieldVisible(f, d.config)));
  const env: FieldEnv = { readOnly, onOpenMapper: (key) => onOpenMapper(nodeId, key) };
  const errFor = (key: string) => issues?.find((i) => i.field === key && i.level === "error")?.message;
  const general = issues?.filter((i) => !i.field || !def.fields.some((f) => f.key === i.field) && i.field !== "name") ?? [];
  const source = d.config.__source as SourceRef | undefined;
  const extra = Object.entries(d.config).filter(([k]) => k !== "__source" && !def.fields.some((f) => f.key === k));
  const row = (f: FieldDef) => <FieldRow key={f.key} field={f} value={d.config[f.key]} onChange={(v) => store.setConfig(nodeId, f.key, v)} env={env} error={errFor(f.key)} />;
  const isNote = node.type === "note";
  const curTab = tab === "run" && !traces?.length ? "settings" : tab;

  return (
    <ExprEnvContext.Provider value={exprEnv}>
      <div className="ws-panel" data-panel-node={d.name} data-readonly={readOnly ? "true" : "false"}>
        <header className="ws-panel-head">
          <span className="mf-iconchip" style={{ ["--chip" as string]: accentOf(def) }}><Icon size={17} aria-hidden /></span>
          <div className="ws-panel-title">
            <span className="ws-panel-type">{txt(def.label)}{d.disabled ? " · disabled" : ""}</span>
            {readOnly || isNote
              ? <strong className="ws-panel-name">{txt(d.name)}</strong>
              : <input className="ws-panel-nameinput" aria-label="Step name" value={d.name} onChange={(e) => store.updateNode(nodeId, { name: e.target.value }, `name:${nodeId}`)} />}
          </div>
          <IconButton label="Close panel" icon={X} onClick={onClose} />
        </header>
        {!!traces?.length && <Tabs tabs={[{ id: "settings", label: readOnly ? "Details" : "Settings" }, { id: "run", label: "Last run", tone: traces.some((t) => t.status === "error") ? "bad" : "ok" }]} value={curTab} onChange={setTab} className="ws-panel-tabs" />}
        <div className="ws-panel-body">
          {curTab === "settings" && (
            <>
              {errFor("name") && <Callout tone="bad">{errFor("name")}</Callout>}
              {general.map((i, k) => <Callout key={k} tone={i.level === "error" ? "bad" : "warn"}>{txt(i.message)}</Callout>)}
              {!known && !readOnly && <Callout tone="warn">This step type is not available on this server, so its settings cannot be edited here.</Callout>}
              {def.description && <p className="mf-help" style={{ margin: 0 }}>{txt(def.description)}</p>}
              {source && (source.file || source.code) && (
                <div className="mf-stack" style={{ gap: 8 }} data-source-file={txt(source.file)}>
                  <div className="mf-hstack"><Badge tone="info">Source</Badge><code className="mf-mono-sm" style={{ overflowWrap: "anywhere" }}>{txt(source.file)}{source.line ? `:${source.line}` : ""}{source.endLine && source.endLine !== source.line ? `-${source.endLine}` : ""}</code></div>
                  {source.code && <CodeBlock value={source.code} label="Code of this step" maxHeight={260} />}
                </div>
              )}
              {main.map(row)}
              {groups.map((g) => <Collapsible key={g.name} title={txt(g.name)} count={g.fields.length}>{g.fields.map(row)}</Collapsible>)}
              {extra.length > 0 && (known ? <Collapsible title="Other values" count={extra.length}><DataView value={Object.fromEntries(extra)} /></Collapsible> : <DataView label="Details" value={Object.fromEntries(extra)} maxHeight={420} />)}
              {def.docs && <Collapsible title="How this step works"><p className="mf-help" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{txt(def.docs)}</p></Collapsible>}
              {!isNote && (readOnly
                ? d.notes ? <Field label="Notes"><p className="mf-help" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{txt(d.notes)}</p></Field> : null
                : <Field label="Notes" help="Shown to anyone who opens this step. Never executed."><AutoTextArea value={d.notes ?? ""} minRows={2} aria-label="Notes" placeholder="Why this step exists, who asked for it…" onChange={(v) => store.updateNode(nodeId, { notes: v || undefined }, `notes:${nodeId}`)} /></Field>)}
            </>
          )}
          {curTab === "run" && traces?.map((t, i) => <StepDetail key={i} step={t} />)}
        </div>
        {!readOnly && !isNote && (
          <footer className="ws-panel-foot">
            {onTest && def.category !== "trigger" && <Button size="sm" icon={Play} onClick={() => onTest(nodeId)} data-action="test-step">Test this step</Button>}
            {onChangeInWords && <Button size="sm" icon={PenLine} onClick={() => onChangeInWords(nodeId)} data-action="change-in-words">Change in your own words</Button>}
            <span style={{ flex: 1 }} />
            <IconButton label={d.disabled ? "Enable step" : "Disable step"} icon={Power} active={!!d.disabled} onClick={() => store.toggleDisabled([nodeId])} />
            <IconButton label="Delete step" icon={Trash2} tone="danger" onClick={() => { store.remove([nodeId]); onClose(); }} />
          </footer>
        )}
      </div>
    </ExprEnvContext.Provider>
  );
}
