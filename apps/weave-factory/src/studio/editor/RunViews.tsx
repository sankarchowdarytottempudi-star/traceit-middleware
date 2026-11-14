// Read-only views of what happened in a run: one step trace, a whole execution.
import { useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import type { Execution, StepTrace } from "@traceit/weave-flow";
import { Badge, Callout, cx, DataView, fmtDuration, fmtTime, type Tone } from "../ui.tsx";
import { portLabel } from "../catalog.ts";
import { txt } from "../../lib/text.ts";

export const statusTone = (s: unknown): Tone => (s === "success" ? "ok" : s === "error" ? "bad" : s === "running" ? "info" : "neutral");
export const statusLabel = (s: unknown): string => (s === "success" ? "Succeeded" : s === "error" ? "Failed" : s === "running" ? "Running" : s === "skipped" ? "Skipped" : txt(s) || "Unknown");
export const httpTone = (status: unknown): Tone => { const n = Number(status); return !n ? "neutral" : n < 300 ? "ok" : n < 400 ? "info" : n < 500 ? "warn" : "bad"; };
export const modeLabel = (m: unknown): string => (m === "test" ? "Test" : m === "live" ? "Live" : m === "node-test" ? "Step test" : txt(m));

export function StepDetail({ step, onPick }: { step: StepTrace; onPick?: (path: string) => void }) {
  const http = step.meta?.http;
  return (
    <div className="mf-stack ws-stepdetail" data-step={step.nodeName}>
      <div className="mf-hstack">
        <Badge tone={statusTone(step.status)}>{statusLabel(step.status)}</Badge>
        <span className="mf-faint mf-mono-sm">{fmtDuration(step.durationMs)}</span>
        {step.port && <span className="mf-faint" style={{ fontSize: 12 }}>left by "{portLabel(step.port)}"</span>}
        {step.iteration !== undefined && <Badge>item {Number(step.iteration) + 1}</Badge>}
        {step.branch && <Badge>branch {txt(step.branch)}</Badge>}
        {step.meta?.cache && <Badge tone="info">{step.meta.cache.hit ? "cache hit" : "cache miss"}</Badge>}
      </div>
      {http && <div className="ws-httpline"><Badge tone={httpTone(http.status)}>{http.status ?? "no response"}</Badge><code>{txt(http.method)} {txt(http.url)}</code></div>}
      {step.error && (
        <Callout tone="bad" title={txt(step.error.message) || "This step failed"}>
          {step.error.status ? <span>Status {step.error.status}</span> : null}
          {step.error.detail !== undefined && <DataView value={step.error.detail} label="Error detail" maxHeight={180} />}
        </Callout>
      )}
      <DataView label="Input" value={step.input} onPick={onPick ? (p) => onPick(p) : undefined} maxHeight={240} />
      <DataView label="Output" value={step.output} maxHeight={280} />
      {step.truncated && <p className="mf-help">Large values were shortened in this trace.</p>}
    </div>
  );
}

/** Step-by-step list of a run. Clicking a step expands its input, output and error. */
export function StepList({ steps, onShow, activeNodeId }: { steps: StepTrace[]; onShow?: (nodeId: string) => void; activeNodeId?: string | null }) {
  const [open, setOpen] = useState<number | null>(() => steps.find((s) => s.status === "error")?.seq ?? null);
  if (!steps.length) return <p className="mf-help">No step ran.</p>;
  return (
    <ol className="ws-steps">
      {steps.map((s) => {
        const isOpen = open === s.seq;
        return (
          <li key={s.seq} className={cx("ws-step", `ws-step-${s.status}`, activeNodeId === s.nodeId && "ws-step-active")} data-step-name={s.nodeName} data-step-status={s.status}>
            <div className="ws-step-row">
              <button type="button" className="ws-step-toggle" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : s.seq)}>
                {isOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                <span className={cx("mf-dot", `mf-dot-${statusTone(s.status)}`)} aria-hidden />
                <span className="ws-step-name">{txt(s.nodeName)}</span>
                {s.iteration !== undefined && <span className="mf-faint" style={{ fontSize: 11.5 }}>#{Number(s.iteration) + 1}</span>}
                <span className="mf-sr">{statusLabel(s.status)}</span>
                <span className="ws-step-ms">{fmtDuration(s.durationMs)}</span>
              </button>
              {onShow && <button type="button" className="ws-step-go" aria-label={`Show ${s.nodeName} on the canvas`} title="Show on the canvas" onClick={() => onShow(s.nodeId)}><ArrowRight size={14} /></button>}
            </div>
            {isOpen && <div className="ws-step-body"><StepDetail step={s} /></div>}
          </li>
        );
      })}
    </ol>
  );
}

export function ExecutionView({ execution: x, onShow }: { execution: Execution; onShow?: (nodeId: string) => void }) {
  return (
    <div className="mf-stack" data-execution={x.id} data-execution-status={x.status}>
      <div className="mf-hstack">
        <Badge tone={statusTone(x.status)}>{statusLabel(x.status)}</Badge>
        <Badge>{modeLabel(x.mode)}</Badge>
        {x.via && <Badge tone="info">{x.via === "gateway" ? "through the gateway" : "direct"}</Badge>}
        <span className="mf-faint" style={{ fontSize: 12.5 }}>{fmtTime(x.startedAt)} · {fmtDuration(x.durationMs)} · revision {txt(x.revision)}</span>
      </div>
      {x.error && <Callout tone="bad" title={txt(x.error.message) || "The run failed"}>{x.error.nodeName ? <span>At step "{txt(x.error.nodeName)}"{x.error.status ? ` (status ${x.error.status})` : ""}</span> : null}</Callout>}
      {x.response && (
        <div className="mf-stack" style={{ gap: 8 }}>
          <div className="mf-hstack"><strong style={{ fontSize: 13 }}>Response</strong><Badge tone={httpTone(x.response.status)}>{txt(x.response.status)}</Badge></div>
          <DataView label="Response body" value={x.response.body ?? null} maxHeight={260} />
        </div>
      )}
      {x.request && <DataView label="Request" value={x.request} maxHeight={200} />}
      <div className="mf-stack" style={{ gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Steps ({x.steps?.length ?? 0})</strong>
        <StepList steps={x.steps ?? []} onShow={onShow} />
      </div>
      {!!x.logs?.length && (
        <div className="mf-stack" style={{ gap: 8 }}>
          <strong style={{ fontSize: 13 }}>Log lines</strong>
          <ul className="ws-loglines">
            {x.logs.map((l, i) => <li key={i} className={`ws-logline ws-logline-${txt(l.level)}`}><time>{fmtTime(l.at)}</time><span className="ws-logline-level">{txt(l.level)}</span><span className="ws-logline-msg">{l.nodeName ? `[${txt(l.nodeName)}] ` : ""}{txt(l.message)}</span></li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
