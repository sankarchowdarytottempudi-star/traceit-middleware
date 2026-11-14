// Executions list (one flow or all flows) with a detail drawer, and the log viewer.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, RefreshCw, ScrollText, Search, Trash2, Workflow } from "lucide-react";
import type { Execution, ExecutionSummary, LogLine } from "@traceit/weave-flow";
import { errorText, isUnavailable, studioApi } from "../api.ts";
import { ago, Badge, Button, Callout, confirmDialog, cx, Empty, fmtDuration, fmtTime, IconButton, Sheet, Spinner, TableWrap, toast, Toggle, useDebounced } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { ExecutionView, httpTone, modeLabel, statusLabel, statusTone, triggerLabel } from "./RunViews.tsx";

export function Unreachable({ error, what, onRetry }: { error: unknown; what: string; onRetry?: () => void }) {
  const offline = isUnavailable(error);
  return (
    <Callout tone={offline ? "warn" : "bad"} title={offline ? `${what} cannot be loaded right now` : `${what} could not be loaded`} actions={onRetry ? <Button size="sm" icon={RefreshCw} onClick={onRetry}>Try again</Button> : undefined}>
      <span>{offline ? "The flow engine is not answering. This usually clears up by itself within a minute." : errorText(error)}</span>
      {offline && <span className="mf-faint">{errorText(error)}</span>}
    </Callout>
  );
}

export function ExecutionDrawer({ id, onClose, onShowOnCanvas }: { id: string; onClose: () => void; onShowOnCanvas?: (x: Execution) => void }) {
  const q = useQuery({ queryKey: ["studio", "execution", id], queryFn: () => studioApi.execution(id), retry: 0 });
  return (
    <Sheet title="Execution" onClose={onClose} width={640}
      footer={q.data && <>
        {onShowOnCanvas && <Button icon={Workflow} onClick={() => onShowOnCanvas(q.data!)} data-action="show-on-canvas">Show on the canvas</Button>}
        {!onShowOnCanvas && q.data.flowId && <Link className="mf-button mf-button-default" to={`/studio/flows/${encodeURIComponent(q.data.flowId)}`}>Open the flow</Link>}
        <span style={{ flex: 1 }} />
        <Button variant="primary" onClick={onClose}>Close</Button>
      </>}>
      {q.isLoading && <Spinner label="Loading the execution…" />}
      {q.isError && <Unreachable error={q.error} what="This execution" onRetry={() => void q.refetch()} />}
      {q.data && <ExecutionView execution={q.data} />}
    </Sheet>
  );
}

const STATUS_FILTERS = [{ v: "", l: "Any result" }, { v: "success", l: "Succeeded" }, { v: "error", l: "Failed" }];
const MODE_FILTERS = [{ v: "", l: "Live and test" }, { v: "live", l: "Live only" }, { v: "test", l: "Tests only" }];

export function ExecutionsList({ flowId, showFlow, openId, onOpen, onShowOnCanvas }: {
  flowId?: string; showFlow?: boolean; openId: string | null; onOpen: (id: string | null) => void; onShowOnCanvas?: (x: Execution) => void;
}) {
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState("");
  const [auto, setAuto] = useState(true);
  const q = useQuery({
    queryKey: ["studio", "executions", flowId ?? "*", status, mode],
    queryFn: () => studioApi.executions({ flowId, status: status || undefined, mode: mode || undefined, limit: 100 }),
    refetchInterval: auto ? 5000 : false, retry: 0, placeholderData: keepPreviousData,
  });
  const clear = useMutation({
    mutationFn: () => studioApi.clearExecutions(flowId!),
    onSuccess: () => { toast("History cleared.", "info"); void qc.invalidateQueries({ queryKey: ["studio", "executions"] }); },
    onError: (e) => toast(errorText(e), "bad"),
  });
  const rows: ExecutionSummary[] = q.data?.executions ?? [];
  return (
    <div className="mf-stack" data-testid="executions">
      <div className="mf-toolbarline">
        <select className="mf-control mf-control-sm" aria-label="Result" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>{STATUS_FILTERS.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}</select>
        <select className="mf-control mf-control-sm" aria-label="Kind" value={mode} onChange={(e) => setMode(e.target.value)} style={{ width: "auto" }}>{MODE_FILTERS.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}</select>
        <span style={{ flex: 1 }} />
        <Toggle checked={auto} onChange={setAuto} label={<span style={{ fontSize: 12.5 }}>Refresh automatically</span>} />
        <IconButton label="Refresh now" icon={RefreshCw} busy={q.isFetching} onClick={() => void q.refetch()} />
        {flowId && rows.length > 0 && <IconButton label="Clear this flow's history" icon={Trash2} tone="danger" onClick={async () => { if (await confirmDialog({ title: "Clear the execution history of this flow?", body: "The flow itself is not changed.", confirmLabel: "Clear history", danger: true })) clear.mutate(); }} />}
      </div>
      {q.isLoading && <Spinner label="Loading executions…" />}
      {q.isError && !q.data && <Unreachable error={q.error} what="Executions" onRetry={() => void q.refetch()} />}
      {q.data && rows.length === 0 && <Empty icon={History} title="No executions yet" hint={status || mode ? "Nothing matches these filters." : "Every test run and every live call appears here, with what each step did."} />}
      {rows.length > 0 && (
        <TableWrap label="Executions">
          <table className="mf-table">
            <thead><tr><th>When</th>{showFlow && <th>Flow</th>}<th>Result</th><th>Started by</th><th>Response</th><th className="mf-num">Took</th><th className="mf-num">Steps</th></tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.id} className={cx("mf-clickrow", openId === x.id && "mf-clickrow-on")} tabIndex={0} data-execution-row={x.id} data-execution-status={x.status} data-execution-mode={x.mode}
                  onClick={() => onOpen(x.id)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(x.id); }}>
                  <td className="mf-nowrap"><div className="mf-cellmain">{ago(x.startedAt)}</div><div className="mf-cellsub">{fmtTime(x.startedAt)}</div></td>
                  {showFlow && <td><span className="mf-cellmain">{txt(x.flowName) || txt(x.flowId)}</span></td>}
                  <td><Badge tone={statusTone(x.status)}>{statusLabel(x.status)}</Badge></td>
                  <td><div className="mf-cellmain">{triggerLabel(x.trigger) || "-"}</div><div className="mf-cellsub">{modeLabel(x.mode)}{x.via ? `, ${x.via === "gateway" ? "through the gateway" : txt(x.via)}` : ""}</div></td>
                  <td>{x.responseStatus !== undefined ? <Badge tone={httpTone(x.responseStatus)}>HTTP {txt(x.responseStatus)}</Badge> : <span className="mf-faint">-</span>}</td>
                  <td className="mf-num mf-nowrap">{fmtDuration(x.durationMs)}</td>
                  <td className="mf-num">{txt(x.stepCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {openId && <ExecutionDrawer id={openId} onClose={() => onOpen(null)} onShowOnCanvas={onShowOnCanvas} />}
    </div>
  );
}

const LEVELS = [{ v: "", l: "All levels" }, { v: "error", l: "Errors" }, { v: "warn", l: "Warnings and errors" }, { v: "info", l: "Info and above" }, { v: "debug", l: "Everything (debug)" }];
const levelTone = (l: unknown) => (l === "error" ? "bad" : l === "warn" ? "warn" : l === "debug" ? "neutral" : "info");

export function LogsView({ flowId, onOpenExecution }: { flowId: string; onOpenExecution?: (id: string) => void }) {
  const [level, setLevel] = useState("");
  const [text, setText] = useState("");
  const [auto, setAuto] = useState(true);
  const needle = useDebounced(text, 200).trim().toLowerCase();
  const q = useQuery({
    queryKey: ["studio", "logs", flowId, level],
    queryFn: () => studioApi.logs(flowId, { limit: 500, level: level || undefined }),
    refetchInterval: auto ? 4000 : false, retry: 0, placeholderData: keepPreviousData,
  });
  const lines: LogLine[] = useMemo(() => {
    const all = q.data?.lines ?? [];
    return needle ? all.filter((l) => `${l.message} ${l.nodeName ?? ""} ${l.level}`.toLowerCase().includes(needle)) : all;
  }, [q.data, needle]);
  return (
    <div className="mf-stack" data-testid="logs">
      <div className="mf-toolbarline">
        <label className="mf-search"><Search size={15} aria-hidden /><input className="mf-control" type="search" aria-label="Search the log" placeholder="Search the log" value={text} onChange={(e) => setText(e.target.value)} /></label>
        <select className="mf-control mf-control-sm" aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value)} style={{ width: "auto" }}>{LEVELS.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}</select>
        <span style={{ flex: 1 }} />
        <Toggle checked={auto} onChange={setAuto} label={<span style={{ fontSize: 12.5 }}>Refresh automatically</span>} />
        <IconButton label="Refresh now" icon={RefreshCw} busy={q.isFetching} onClick={() => void q.refetch()} />
      </div>
      {q.isLoading && <Spinner label="Loading the log…" />}
      {q.isError && !q.data && <Unreachable error={q.error} what="The log" onRetry={() => void q.refetch()} />}
      {q.data && lines.length === 0 && <Empty icon={ScrollText} title={needle || level ? "No matching lines" : "Nothing logged yet"} hint={needle || level ? "Try another search or level." : "Lines appear here when the flow runs. Add a Log step to write your own."} />}
      {lines.length > 0 && (
        <ol className="ws-log" aria-label="Log lines" data-log-count={lines.length}>
          {lines.map((l, i) => (
            <li key={`${l.at}-${i}`} className={cx("ws-logrow", `ws-logrow-${txt(l.level)}`)}>
              <time className="ws-logrow-at" title={txt(l.at)}>{fmtTime(l.at)}</time>
              <Badge tone={levelTone(l.level)}>{txt(l.level) || "info"}</Badge>
              <span className="ws-logrow-msg">{l.nodeName && <strong>{txt(l.nodeName)}: </strong>}{txt(l.message)}</span>
              {l.executionId && onOpenExecution && <button type="button" className="mf-linkbtn ws-logrow-go" onClick={() => onOpenExecution(l.executionId!)}>Execution</button>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
