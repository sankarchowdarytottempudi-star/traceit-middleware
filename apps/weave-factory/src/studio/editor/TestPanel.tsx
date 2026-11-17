// Test & debug: build a sample request, run the flow as it is on the canvas (saved or not),
// see what every step received and produced. A single step can be run with pinned input.
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Bookmark, Play, RotateCcw, Save, Trash2, X } from "lucide-react";
import type { Execution, HttpRequestSample, Json, StepTrace } from "@traceit/weave-flow";
import { errorText, isUnavailable, studioApi, type ExprContext } from "../api.ts";
import { contextForNode, fillPath, kvToRecord, pathParams, recordToKv } from "../runctx.ts";
import { useEditor, useEditorStore } from "../store.ts";
import { Badge, Button, Callout, cx, DataView, Empty, Field, fmtDuration, IconButton, JsonEditor, Menu, Spinner, Tabs, toast, type MenuItem } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { KeyValueEditor } from "./fields.tsx";
import { httpTone, runLabel, runTone, statusLabel, statusTone, StepDetail, StepList } from "./RunViews.tsx";

type KV = { key: string; value: string };
interface Draft { method: string; params: Record<string, string>; query: KV[]; headers: KV[]; body: Json | undefined; payload: Json | undefined; }
interface Saved { name: string; draft: Draft; }
const BODYLESS = new Set(["GET", "HEAD", "DELETE", "OPTIONS"]);

function readSaved(key: string): Saved[] {
  try { const v = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(v) ? (v as Saved[]).filter((s) => s && typeof s.name === "string" && s.draft) : []; } catch { return []; }
}
function writeSaved(key: string, list: Saved[]) { try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* private window: samples just are not kept */ } }

/** Turns the trigger's stored sample back into the form (path parameters are recovered from the listener path). */
function draftFromSample(sample: unknown, methods: string[], listenerPath: string): Draft {
  const s = (sample && typeof sample === "object" ? sample : {}) as Partial<HttpRequestSample>;
  const names = pathParams(listenerPath);
  const params: Record<string, string> = {};
  if (typeof s.path === "string" && names.length) {
    const want = listenerPath.split("/"); const got = s.path.split("?")[0].split("/");
    want.forEach((seg, i) => { const m = /^[:{]([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(seg); if (m && got[i] !== undefined && !got[i].startsWith(":")) params[m[1]] = decodeURIComponent(got[i]); });
  }
  const method = typeof s.method === "string" && methods.includes(s.method.toUpperCase()) ? s.method.toUpperCase() : methods[0] ?? "GET";
  return { method, params, query: recordToKv(s.query as Record<string, unknown> | undefined), headers: recordToKv(s.headers as Record<string, unknown> | undefined), body: s.body as Json | undefined, payload: undefined };
}
export function sampleFromDraft(d: Draft, listenerPath: string): HttpRequestSample {
  const req: HttpRequestSample = { method: d.method, path: fillPath(listenerPath || "/", d.params) };
  const q = kvToRecord(d.query); const h = kvToRecord(d.headers);
  if (Object.keys(q).length) req.query = q;
  if (Object.keys(h).length) req.headers = h;
  if (d.body !== undefined && !BODYLESS.has(d.method)) req.body = d.body;
  return req;
}

export function TestPanel({ flowId, nodeTarget, onNodeTarget, onShowNode, onClose, layout }: {
  flowId: string; nodeTarget: string | null; onNodeTarget: (id: string | null) => void; onShowNode: (id: string) => void; onClose: () => void; layout: "dock" | "sheet";
}) {
  const store = useEditorStore();
  const nodes = useEditor((s) => s.nodes);
  const run = useEditor((s) => s.run);
  const traces = useEditor((s) => s.tracesByNode);
  const readOnly = useEditor((s) => s.readOnly);
  const triggers = useMemo(() => nodes.filter((n) => n.data.type.startsWith("trigger.")), [nodes]);
  const [triggerId, setTriggerId] = useState<string>(() => triggers[0]?.id ?? "");
  const trigger = triggers.find((t) => t.id === triggerId) ?? triggers[0];
  useEffect(() => { if (trigger && trigger.id !== triggerId) setTriggerId(trigger.id); }, [trigger, triggerId]);
  const isHttp = trigger?.data.type === "trigger.http";
  const cfg = (trigger?.data.config ?? {}) as Record<string, unknown>;
  const methods = useMemo(() => (Array.isArray(cfg.methods) && cfg.methods.length ? (cfg.methods as unknown[]).map((m) => String(m).toUpperCase()) : ["GET"]), [cfg.methods]);
  const listenerPath = typeof cfg.path === "string" && cfg.path ? cfg.path : "/";
  const names = useMemo(() => pathParams(listenerPath), [listenerPath]);
  const [draft, setDraft] = useState<Draft>(() => ({ ...draftFromSample(cfg.sampleRequest, methods, listenerPath), payload: (cfg.samplePayload ?? cfg.payload) as Json | undefined }));
  // a different trigger: start from its stored sample
  useEffect(() => {
    setDraft({ ...draftFromSample(cfg.sampleRequest, methods, listenerPath), payload: (cfg.samplePayload ?? cfg.payload) as Json | undefined });
  }, [trigger?.id]);
  useEffect(() => { if (!methods.includes(draft.method)) setDraft((d) => ({ ...d, method: methods[0] })); }, [methods]);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const key = `weave-samples:${flowId}:${trigger?.id ?? ""}`;
  const [saved, setSaved] = useState<Saved[]>(() => readSaved(key));
  useEffect(() => { setSaved(readSaved(key)); }, [key]);
  const saveAs = () => {
    const name = window.prompt("Name this sample", `Sample ${saved.length + 1}`)?.trim();
    if (!name) return;
    const next = [...saved.filter((s) => s.name !== name), { name, draft }];
    setSaved(next); writeSaved(key, next); toast(`Saved "${name}" in this browser.`);
  };
  const keepDefault = () => {
    if (!trigger) return;
    if (isHttp) store.setConfig(trigger.id, "sampleRequest", sampleFromDraft(draft, listenerPath));
    else store.setConfig(trigger.id, trigger.data.type === "trigger.manual" ? "samplePayload" : "payload", draft.payload ?? {});
    toast("Kept with the flow as its default sample. Save the flow to keep it.");
  };
  const sampleItems: MenuItem[] = [
    ...saved.map((s) => ({ id: `use:${s.name}`, label: s.name, icon: Bookmark, onSelect: () => setDraft(s.draft) })),
    ...(!readOnly ? [{ id: "save", label: "Save this sample…", icon: Save, onSelect: saveAs, divider: saved.length > 0 }, { id: "default", label: "Keep as the flow's default sample", icon: Bookmark, onSelect: keepDefault }] : []),
    ...saved.map((s) => ({ id: `del:${s.name}`, label: `Forget "${s.name}"`, icon: Trash2, danger: true, onSelect: () => { const next = saved.filter((x) => x.name !== s.name); setSaved(next); writeSaved(key, next); } })),
  ];

  // ---- full run
  const [failure, setFailure] = useState<{ text: string; offline: boolean } | null>(null);
  const test = useMutation({
    mutationFn: () => studioApi.testFlow(flowId, { draft: store.toFlow(), triggerNodeId: trigger?.id, ...(isHttp ? { request: sampleFromDraft(draft, listenerPath) } : { payload: (draft.payload ?? {}) as Json }) }),
    onMutate: () => setFailure(null),
    onSuccess: (x: Execution) => { store.setRun(x); setTab("result"); },
    onError: (e) => setFailure({ text: errorText(e), offline: isUnavailable(e) }),
  });

  // ---- single step with pinned input
  const target = nodeTarget ? nodes.find((n) => n.id === nodeTarget) : undefined;
  const sample = isHttp ? sampleFromDraft(draft, listenerPath) : null;
  const [pinned, setPinned] = useState<ExprContext>({});
  const [stepResult, setStepResult] = useState<StepTrace | null>(null);
  useEffect(() => {
    if (!nodeTarget) return;
    const c = contextForNode(run, traces, nodeTarget, sample, nodes);
    setPinned({ payload: c?.payload ?? (isHttp ? ((draft.body ?? null) as Json) : ((draft.payload ?? null) as Json)), vars: c?.vars ?? {}, request: c?.request ?? sample ?? undefined, ...(c?.item !== undefined ? { item: c.item, index: c.index } : {}) });
    setStepResult(null);
  }, [nodeTarget]);
  const testNode = useMutation({
    mutationFn: () => studioApi.testNode(flowId, nodeTarget!, { draft: store.toFlow(), context: { payload: pinned.payload, vars: pinned.vars, request: pinned.request, item: pinned.item, index: pinned.index } }),
    onMutate: () => setFailure(null),
    onSuccess: (res) => { setStepResult(res.step); store.setNodeRun(res.step); },
    onError: (e) => setFailure({ text: errorText(e), offline: isUnavailable(e) }),
  });

  const [tab, setTab] = useState<"request" | "result">("request");
  const [active, setActive] = useState<string | null>(null);
  const split = layout === "dock";

  const failureBox = failure && (
    <Callout tone={failure.offline ? "warn" : "bad"} title={failure.offline ? "The flow engine cannot be reached" : "The test could not be run"}>
      <span>{failure.text}</span>
      {failure.offline && <span>Your flow is safe in this editor. Try again in a moment.</span>}
    </Callout>
  );

  if (target) {
    return (
      <div className={cx("ws-test", split && "ws-test-split")} data-testid="test-panel" data-test-mode="step">
        <div className="ws-test-col">
          <div className="ws-test-head">
            <strong className="mf-truncate">Test one step: {txt(target.data.name)}</strong>
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="ghost" onClick={() => onNodeTarget(null)}>Back to the whole flow</Button>
            <Button size="sm" variant="primary" icon={Play} busy={testNode.isPending} onClick={() => testNode.mutate()} data-action="run-step">Run this step</Button>
            {layout === "dock" && <IconButton label="Close test panel" icon={X} onClick={onClose} />}
          </div>
          <div className="ws-test-scroll">
            <p className="mf-help" style={{ margin: 0 }}>Only this step runs, with the input below. {run ? "The input was taken from the last test run; change it to try other cases." : "Run the whole flow once to fill this in with real data."}</p>
            <Field label="Input data (payload)"><JsonEditor value={pinned.payload} onChange={(v) => setPinned((p) => ({ ...p, payload: v as Json }))} minRows={4} maxRows={14} ariaLabel="Pinned input" /></Field>
            <Field label="Variables" help="What $vars holds when this step runs."><JsonEditor value={pinned.vars ?? {}} onChange={(v) => setPinned((p) => ({ ...p, vars: (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, Json> }))} minRows={2} maxRows={8} ariaLabel="Pinned variables" /></Field>
          </div>
        </div>
        <div className="ws-test-col">
          <div className="ws-test-scroll">
            {failureBox}
            {testNode.isPending && <Spinner label="Running the step…" />}
            {!testNode.isPending && !stepResult && !failure && <Empty icon={Play} title="Not run yet" hint="Run this step to see what it produces." />}
            {stepResult && !testNode.isPending && (
              <div className="mf-stack" data-step-result={stepResult.status}>
                <div className="mf-hstack"><Badge tone={statusTone(stepResult.status)}>{statusLabel(stepResult.status)}</Badge><span className="mf-faint">{fmtDuration(stepResult.durationMs)}</span>{stepResult.port && <Badge>continues on "{txt(stepResult.port)}"</Badge>}</div>
                <StepDetail step={stepResult} />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const request = (
    <div className="ws-test-col" hidden={!split && tab !== "request"}>
      <div className="ws-test-head">
        {triggers.length > 1 ? (
          <select className="mf-control mf-control-sm" aria-label="Start from" value={trigger?.id ?? ""} onChange={(e) => setTriggerId(e.target.value)} style={{ maxWidth: 220 }}>
            {triggers.map((t) => <option key={t.id} value={t.id}>{txt(t.data.name)}</option>)}
          </select>
        ) : <strong className="mf-truncate">{trigger ? txt(trigger.data.name) : "Test"}</strong>}
        <span style={{ flex: 1 }} />
        <Menu label="Samples" items={sampleItems.length ? sampleItems : [{ id: "none", label: "No saved samples", onSelect: () => {}, disabled: true }]} trigger={(p) => <Button size="sm" variant="ghost" icon={Bookmark} {...p}>Samples</Button>} />
        <Button size="sm" variant="primary" icon={run ? RotateCcw : Play} busy={test.isPending} disabled={!trigger} onClick={() => test.mutate()} data-action="run-test">{run ? "Run again" : "Run test"}</Button>
        {layout === "dock" && !split && <IconButton label="Close test panel" icon={X} onClick={onClose} />}
      </div>
      <div className="ws-test-scroll">
        {!trigger && <Callout tone="warn" title="Nothing to start from">Add a trigger (for example an HTTP Listener) so the flow has a starting point.</Callout>}
        {trigger && isHttp && <>
          <div className="ws-test-url">
            <select className="mf-control mf-control-sm" aria-label="Method" value={draft.method} onChange={(e) => set({ method: e.target.value })} style={{ width: 96, flex: "none" }}>
              {methods.map((m) => <option key={m}>{m}</option>)}
            </select>
            <code className="ws-test-path" data-testid="test-path">{fillPath(listenerPath, draft.params)}</code>
          </div>
          {names.length > 0 && (
            <Field label="Path values">
              <div className="mf-rows">
                {names.map((n) => (
                  <div className="mf-rowline" key={n}>
                    <code className="ws-test-param">{n}</code>
                    <input className="mf-control mf-control-sm" aria-label={`Value for ${n}`} placeholder="value" value={draft.params[n] ?? ""} onChange={(e) => set({ params: { ...draft.params, [n]: e.target.value } })} />
                  </div>
                ))}
              </div>
            </Field>
          )}
          <Field label="Query"><KeyValueEditor value={draft.query} onChange={(v) => set({ query: v })} addLabel="Add query value" expr={false} /></Field>
          <Field label="Headers"><KeyValueEditor value={draft.headers} onChange={(v) => set({ headers: v })} addLabel="Add header" expr={false} /></Field>
          {!BODYLESS.has(draft.method) && <Field label="Body"><JsonEditor value={draft.body} onChange={(v) => set({ body: v as Json | undefined })} minRows={4} maxRows={14} ariaLabel="Request body" placeholder={'{ "name": "value" }'} /></Field>}
        </>}
        {trigger && !isHttp && <Field label="Starting data (payload)" help="What the flow receives when it starts."><JsonEditor value={draft.payload} onChange={(v) => set({ payload: v as Json | undefined })} minRows={5} maxRows={16} ariaLabel="Starting payload" placeholder="{ }" /></Field>}
      </div>
    </div>
  );
  const result = (
    <div className="ws-test-col" hidden={!split && tab !== "result"}>
      {split && (
        <div className="ws-test-head">
          <span className="ws-test-headmain">
            <strong>Result</strong>
            {run && <Badge tone={runTone(run.status, run.response?.status)}>{runLabel(run.status, run.response?.status)}</Badge>}
            {run?.response?.status !== undefined && <Badge tone={httpTone(run.response.status)}>HTTP {txt(run.response.status)}</Badge>}
            {run && <span className="mf-faint">{fmtDuration(run.durationMs)}</span>}
          </span>
          {run && <Button size="sm" variant="ghost" onClick={() => { store.setRun(null); setActive(null); }}>Clear</Button>}
          <IconButton label="Close test panel" icon={X} onClick={onClose} />
        </div>
      )}
      <div className="ws-test-scroll">
        {failureBox}
        {test.isPending && <Spinner label="Running the flow…" />}
        {!test.isPending && !run && !failure && <Empty icon={Play} title="No test run yet" hint="Run a test to see the response and what every step did. Nothing is deployed and no live traffic is affected." />}
        {run && !test.isPending && (
          <div className="mf-stack" data-testid="test-result" data-run-status={run.status} data-response-status={run.response?.status ?? ""}>
            {!split && <div className="mf-hstack"><Badge tone={runTone(run.status, run.response?.status)}>{runLabel(run.status, run.response?.status)}</Badge>{run.response?.status !== undefined && <Badge tone={httpTone(run.response.status)}>HTTP {txt(run.response.status)}</Badge>}<span className="mf-faint">{fmtDuration(run.durationMs)}</span></div>}
            {run.error && <Callout tone="bad" title="The flow failed">{txt(run.error.message)}</Callout>}
            {run.response && <div data-testid="test-response"><DataView label="Response" value={run.response.body ?? null} maxHeight={260} /></div>}
            <div className="mf-stack" style={{ gap: 6 }}>
              <span className="mf-label">Steps ({run.steps?.length ?? 0})</span>
              <StepList steps={run.steps ?? []} activeNodeId={active} onShow={(id) => { setActive(id); onShowNode(id); }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
  return (
    <div className={cx("ws-test", split && "ws-test-split")} data-testid="test-panel" data-test-mode="flow">
      {!split && <Tabs className="ws-test-tabs" tabs={[{ id: "request", label: "Request" }, { id: "result", label: "Result", count: run?.steps?.length }]} value={tab} onChange={setTab} />}
      {request}{result}
    </div>
  );
}
