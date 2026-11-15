// Calls and jobs of the migrated services: rebuilt from the services' own log lines (one trace id
// across the layers) and the gateway's request records. Nothing here passes through the flow engine.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, History, RefreshCw, Search } from "lucide-react";
import { api, type ApiError, type MigratedExecution, type MigratedExecutionStep, type MigratedExecutionSummary } from "../../api.ts";
import { ago, Badge, Button, Callout, Collapsible, CopyButton, cx, Empty, fmtDuration, fmtTime, IconButton, Sheet, Spinner, TableWrap, Toggle, useDebounced } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { httpTone, statusTone } from "./RunViews.tsx";
import { calledBy, chainText, MIGRATED_KIND, MIGRATED_STATUS, MIGRATED_VIA, migratedStatusLabel, offsetLabel, stepHints, stepTone } from "../migrated.ts";

const failText = (e: unknown) => {
  const s = (e as ApiError | undefined)?.status;
  if (s === 502 || s === 503 || s === 504) return "The cluster is not answering right now. This usually clears up by itself within a minute.";
  return e instanceof Error ? (e.message === "Failed to fetch" ? "Could not reach the server. Check your connection and try again." : e.message) : String(e);
};

function LoadFailed({ error, what, onRetry }: { error: unknown; what: string; onRetry: () => void }) {
  return <Callout tone="warn" title={`${what} could not be loaded`} actions={<Button size="sm" icon={RefreshCw} onClick={onRetry}>Try again</Button>}><span>{failText(error)}</span></Callout>;
}

function Steps({ steps, hidden }: { steps: MigratedExecutionStep[]; hidden: number }) {
  const problems = useMemo(() => steps.filter((s) => stepTone(s.level) !== "info").length, [steps]);
  const [only, setOnly] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const shown = only ? steps.map((s, i) => ({ s, i })).filter(({ s }) => stepTone(s.level) !== "info") : steps.map((s, i) => ({ s, i }));
  if (!steps.length) return <p className="mf-help">The services wrote no line for this call. Only the gateway's record of it is known.</p>;
  return (
    <div className="mf-stack" style={{ gap: 8 }}>
      {problems > 0 && steps.length > 12 && <Toggle checked={only} onChange={setOnly} label={<span style={{ fontSize: 12.5 }}>Only warnings and errors ({problems})</span>} />}
      <ol className="ws-trace" aria-label="What each service logged" data-migrated-steps={steps.length}>
        {shown.map(({ s, i }) => {
          const isOpen = open === i, tone = stepTone(s.level), hints = stepHints(s);
          const keys = Object.keys(s.fields ?? {});
          const sameService = i > 0 && steps[i - 1].api === s.api && steps[i - 1].component === s.component;
          return (
            <li key={i} className={cx("ws-tracerow", `ws-tracerow-${tone}`)} data-migrated-step={s.api} data-step-level={tone}>
              <button type="button" className="ws-trace-toggle" aria-expanded={isOpen} disabled={!keys.length} onClick={() => setOpen(isOpen ? null : i)}>
                <span className="ws-trace-at" title={fmtTime(s.at)}>{offsetLabel(s.offsetMs)}</span>
                <span className={cx("ws-trace-api", sameService && "ws-trace-api-same")} title={s.component ? `${s.api} (${s.component})` : s.api}>{txt(s.component || s.api)}</span>
                <span className="ws-trace-msg">
                  {tone !== "info" && <Badge tone={tone === "error" ? "bad" : "warn"}>{tone === "error" ? "Error" : "Warning"}</Badge>}{" "}
                  {txt(s.message) || "(no message)"}
                  {hints.length > 0 && <small>{hints.map((h) => ` · ${h.key} ${h.value}`).join("")}</small>}
                </span>
                {keys.length > 0 ? (isOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />) : <span />}
              </button>
              {isOpen && (
                <dl className="mf-kv ws-trace-body">
                  <dt>Logged at</dt><dd>{fmtTime(s.at)}</dd>
                  <dt>Service</dt><dd>{txt(s.api)}{s.component ? ` (${txt(s.component)})` : ""}</dd>
                  {keys.map((k) => <FieldRow key={k} name={k} value={s.fields[k]} />)}
                </dl>
              )}
            </li>
          );
        })}
      </ol>
      {hidden > 0 && <p className="mf-help">{hidden.toLocaleString()} more line{hidden === 1 ? "" : "s"} in the middle of this run are not shown. The start, the end and every warning or error are kept.</p>}
    </div>
  );
}

function FieldRow({ name, value }: { name: string; value: unknown }) {
  return <><dt>{name}</dt><dd className="mf-mono-sm">{txt(value)}</dd></>;
}

function Detail({ x }: { x: MigratedExecution }) {
  const who = calledBy(x), g = x.gateway, chain = chainText(x);
  return (
    <div className="mf-stack" data-migrated-execution={x.id} data-execution-status={x.status}>
      <div className="mf-hstack">
        <Badge tone={statusTone(x.status)}>{migratedStatusLabel(x.status)}</Badge>
        {x.httpStatus !== undefined && <Badge tone={httpTone(x.httpStatus)}>HTTP {txt(x.httpStatus)}</Badge>}
        <Badge>{x.kind === "job" ? "Job" : "Call"}</Badge>
        {x.kind !== "job" && x.via && x.via !== "unknown" && <Badge tone={x.via === "gateway" ? "accent" : "neutral"}>{who.sub}</Badge>}
        {x.errors > 0 && <Badge tone="bad">{x.errors} error line{x.errors === 1 ? "" : "s"}</Badge>}
        {x.warnings > 0 && <Badge tone="warn">{x.warnings} warning{x.warnings === 1 ? "" : "s"}</Badge>}
      </div>
      <dl className="mf-kv">
        <dt>Service</dt><dd><Link to={`/estate/${encodeURIComponent(x.api)}`}>{txt(x.api)}</Link>{x.component ? ` (${txt(x.component)})` : ""}</dd>
        {x.operation && <><dt>Operation</dt><dd>{txt(x.operation)}</dd></>}
        {x.route && <><dt>Route</dt><dd className="mf-mono-sm">{txt(x.route)}</dd></>}
        {chain && <><dt>Went through</dt><dd>{chain}</dd></>}
        <dt>Started</dt><dd>{fmtTime(x.startedAt)} ({ago(x.startedAt)})</dd>
        <dt>Took</dt><dd>{x.durationMs !== undefined ? fmtDuration(x.durationMs) : "Not known"}{x.serviceMs !== undefined && g && x.serviceMs !== x.durationMs ? `, of which ${fmtDuration(x.serviceMs)} inside the service` : ""}</dd>
        {x.kind === "job" ? <><dt>Started by</dt><dd>{who.main}</dd></> : <><dt>Called by</dt><dd>{who.main}{g?.keyType ? ` (${txt(g.keyType).toLowerCase()} key)` : ""}</dd></>}
        {x.outcome && <><dt>Outcome</dt><dd>{txt(x.outcome)}</dd></>}
        {x.correlationId && <><dt>Trace id</dt><dd className="mf-hstack" style={{ gap: 6 }}><code className="mf-mono-sm">{txt(x.correlationId)}</code><CopyButton text={x.correlationId} /></dd></>}
      </dl>

      <div className="mf-stack" style={{ gap: 8 }}>
        <strong style={{ fontSize: 13 }}>What each service logged</strong>
        <Steps steps={x.steps ?? []} hidden={x.hiddenSteps ?? 0} />
      </div>

      {g && (
        <Collapsible title="The gateway's record of this call" defaultOpen={!x.steps?.length}>
          <dl className="mf-kv" data-migrated-gateway={g.matchedBy}>
            <dt>Request</dt><dd className="mf-mono-sm">{[g.method, g.context, g.resource].filter(Boolean).join(" ")}</dd>
            <dt>Answered</dt><dd>HTTP {txt(g.status)}{g.targetStatus !== undefined && g.targetStatus !== g.status ? ` (the service answered ${g.targetStatus})` : ""}</dd>
            {g.responseLatency !== undefined && <><dt>Total time</dt><dd>{fmtDuration(g.responseLatency)}</dd></>}
            {g.backendLatency !== undefined && <><dt>Waiting for the service</dt><dd>{fmtDuration(g.backendLatency)}</dd></>}
            {(g.requestMediationLatency !== undefined || g.responseMediationLatency !== undefined) && <><dt>Inside the gateway</dt><dd>{fmtDuration((g.requestMediationLatency ?? 0) + (g.responseMediationLatency ?? 0))}</dd></>}
            {g.application && <><dt>Application</dt><dd>{txt(g.application)}</dd></>}
            {g.keyType && <><dt>Key</dt><dd>{txt(g.keyType)}</dd></>}
            {g.userAgent && <><dt>Client</dt><dd>{txt(g.userAgent)}{g.platform && g.platform !== "Other" ? ` on ${txt(g.platform)}` : ""}</dd></>}
            {g.userIp && <><dt>Client address</dt><dd className="mf-mono-sm">{txt(g.userIp)}</dd></>}
            {g.responseSize !== undefined && <><dt>Response size</dt><dd>{Number(g.responseSize).toLocaleString()} bytes</dd></>}
            {g.cacheHit !== undefined && <><dt>From the gateway cache</dt><dd>{g.cacheHit ? "Yes" : "No"}</dd></>}
            {g.errorMessage && <><dt>Gateway error</dt><dd>{txt(g.errorMessage)}</dd></>}
          </dl>
          {g.matchedBy === "time" && <p className="mf-help">The gateway and the services use different ids for the same call, so this record was matched to the service's lines by time and duration.</p>}
        </Collapsible>
      )}
      <p className="mf-help">Request and response bodies are not kept for migrated services. What is shown is what the services chose to log.</p>
    </div>
  );
}

export function MigratedExecutionDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["estate-execution", id], queryFn: () => api.estateExecution(id), retry: 0 });
  const gone = q.isError && (q.error as ApiError).status === 404;
  return (
    <Sheet title={q.data?.kind === "job" ? "Job run" : "Call"} onClose={onClose} width={680}
      footer={<>
        {q.data && <Link className="mf-button mf-button-default" to={`/estate/${encodeURIComponent(q.data.api)}?tab=logs`}>Open the service's log</Link>}
        <span style={{ flex: 1 }} />
        <Button variant="primary" onClick={onClose}>Close</Button>
      </>}>
      {q.isLoading && <Spinner label="Loading the call…" />}
      {gone && <Callout tone="info" title="This call is no longer recorded"><span>Only what the services' logs and the gateway's records still hold can be shown.</span></Callout>}
      {q.isError && !gone && <LoadFailed error={q.error} what="This call" onRetry={() => void q.refetch()} />}
      {q.data && <Detail x={q.data} />}
    </Sheet>
  );
}

export function MigratedExecutionsList({ api: fixedApi, pickedApi, onPickApi, openId, onOpen }: {
  /** Only the calls that touched this service; hides the service filter. */
  api?: string;
  pickedApi?: string; onPickApi?: (api: string) => void;
  openId: string | null; onOpen: (id: string | null) => void;
}) {
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [via, setVia] = useState("");
  const [text, setText] = useState("");
  const [ownApi, setOwnApi] = useState("");
  const [auto, setAuto] = useState(true);
  const needle = useDebounced(text, 300).trim();
  const chosen = fixedApi ?? pickedApi ?? ownApi;
  const pick = (v: string) => (onPickApi ? onPickApi(v) : setOwnApi(v));
  const q = useQuery({
    queryKey: ["estate-executions", chosen, status, kind, via, needle],
    queryFn: () => api.estateExecutions({ api: chosen || undefined, status: status || undefined, kind: kind || undefined, via: via || undefined, q: needle || undefined, limit: 200 }),
    refetchInterval: auto ? 10_000 : false, retry: 0, placeholderData: keepPreviousData,
  });
  const d = q.data;
  const rows: MigratedExecutionSummary[] = d?.executions ?? [];
  const filtered = !!(status || kind || via || needle || (!fixedApi && chosen));
  const services = (d?.apis ?? []).filter((a) => a.total > 0 || a.api === chosen);
  return (
    <div className="mf-stack" data-testid="migrated-executions" data-migrated-recorded={d?.recorded ?? ""} data-migrated-gateway={d ? (d.sources.gateway.available ? "connected" : "off") : ""}>
      <div className="mf-toolbarline">
        <label className="mf-search"><Search size={15} aria-hidden /><input className="mf-control" type="search" aria-label="Search calls" placeholder="Search by operation, application or trace id" value={text} onChange={(e) => setText(e.target.value)} /></label>
        {!fixedApi && (
          <select className="mf-control mf-control-sm" aria-label="Service" value={chosen} onChange={(e) => pick(e.target.value)} style={{ width: "auto" }}>
            <option value="">All migrated services</option>
            {services.map((a) => <option key={a.api} value={a.api}>{a.api} ({a.total.toLocaleString()})</option>)}
          </select>
        )}
        <select className="mf-control mf-control-sm" aria-label="Result" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>{MIGRATED_STATUS.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}</select>
        <select className="mf-control mf-control-sm" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: "auto" }}>{MIGRATED_KIND.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}</select>
        <select className="mf-control mf-control-sm" aria-label="Caller" value={via} onChange={(e) => setVia(e.target.value)} style={{ width: "auto" }}>{MIGRATED_VIA.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}</select>
        <span style={{ flex: 1 }} />
        <Toggle checked={auto} onChange={setAuto} label={<span style={{ fontSize: 12.5 }}>Refresh automatically</span>} />
        <IconButton label="Refresh now" icon={RefreshCw} busy={q.isFetching} onClick={() => void q.refetch()} />
      </div>
      {d?.notes?.map((n, i) => <Callout key={i} tone="warn"><span>{txt(n)}</span></Callout>)}
      {q.isLoading && <Spinner label="Reading the services' logs…" />}
      {q.isError && !d && <LoadFailed error={q.error} what="The calls of the migrated services" onRetry={() => void q.refetch()} />}
      {d && rows.length === 0 && (
        <Empty icon={History} title={filtered ? "No matching calls" : "No calls recorded yet"}
          hint={filtered ? "Nothing matches these filters." : "Calls appear here as soon as a migrated service is called, through the gateway or from another service."} />
      )}
      {rows.length > 0 && (
        <TableWrap label="Calls of the migrated services">
          <table className="mf-table">
            <thead><tr><th>When</th><th>Result</th><th>Service</th><th>Operation</th><th>Called by</th><th className="mf-num">Took</th><th className="mf-num">Lines</th></tr></thead>
            <tbody>
              {rows.map((x) => {
                const who = calledBy(x), chain = chainText(x);
                return (
                  <tr key={x.id} className={cx("mf-clickrow", openId === x.id && "mf-clickrow-on")} tabIndex={0} data-migrated-row={x.id} data-migrated-api={x.api} data-migrated-status={x.status} data-migrated-kind={x.kind} data-migrated-via={x.via ?? ""}
                    onClick={() => onOpen(x.id)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(x.id); }}>
                    <td className="mf-nowrap"><div className="mf-cellmain">{ago(x.startedAt)}</div><div className="mf-cellsub">{fmtTime(x.startedAt)}</div></td>
                    <td className="mf-nowrap"><span className="mf-hstack" style={{ gap: 6, flexWrap: "nowrap" }}><Badge tone={statusTone(x.status)}>{migratedStatusLabel(x.status)}</Badge>{x.httpStatus !== undefined && <Badge tone={httpTone(x.httpStatus)}>{txt(x.httpStatus)}</Badge>}</span></td>
                    <td><div className="mf-cellmain"><strong>{txt(x.component || x.api)}</strong></div>{chain && <div className="mf-cellsub">{chain}</div>}</td>
                    <td><div className="mf-cellmain">{txt(x.operation) || txt(x.route) || <span className="mf-faint">-</span>}</div>{x.operation && x.route && <div className="mf-cellsub">{txt(x.route)}</div>}</td>
                    <td><div className="mf-cellmain">{who.main}</div><div className="mf-cellsub">{who.sub}</div></td>
                    <td className="mf-num mf-nowrap">{x.durationMs !== undefined ? fmtDuration(x.durationMs) : "-"}</td>
                    <td className="mf-num">{txt(x.stepCount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
      {d && d.recorded > 0 && (
        <p className="mf-help" data-migrated-footer>
          {rows.length < d.total ? `Showing the newest ${rows.length.toLocaleString()} of ${d.total.toLocaleString()}. ` : ""}
          {d.recorded.toLocaleString()} call{d.recorded === 1 ? "" : "s"} and jobs recorded{d.window.from ? ` since ${fmtTime(d.window.from)}` : ""}{d.failed ? `, ${d.failed.toLocaleString()} failed` : ""}.
          {" "}Read from the services' own logs{d.sources.gateway.available ? ` and ${d.sources.gateway.records.toLocaleString()} gateway records` : ""}; older calls drop off when those logs roll over.
        </p>
      )}
      {openId && <MigratedExecutionDrawer id={openId} onClose={() => onOpen(null)} />}
    </div>
  );
}
