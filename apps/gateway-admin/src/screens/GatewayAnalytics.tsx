import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ScrollText, Copy } from "lucide-react";
import { apiClient, type GwBreakdownRow, type GwEvent, type GwRange, type GwStatus, type GwStatusFilter, type GwSummary } from "../api.ts";
import { Drawer, ErrorState, SegTabs } from "../components/ui.tsx";
import { Tile, Section, Chip, Loading, DataTable, RangeTabs, LiveBar, useParam, useAutoRefresh, useDebounced, copyText, RANGE_WORDS, type Col, type Tone } from "../components/gw.tsx";
import { ChartCard, BarList } from "../charts/Chart.tsx";
import { PageHeader } from "./PageHeader.tsx";
import { txt, num, list, fmtInt, fmtMs, fmtPct, share, ago, fmtDateTimeSec, statusName, statusClass, plural } from "../lib/text.ts";

const RANGES = ["15m", "1h", "6h", "24h", "7d", "30d"] as const;
const TABS = ["traffic", "applications", "requests"] as const;
type Tab = (typeof TABS)[number];

const appName = (a: unknown) => (!txt(a) || txt(a) === "UNKNOWN" ? "Unknown (not signed in)" : txt(a));
const REASONS: Record<string, string> = {
  AUTH: "Sign-in or key rejected", THROTTLED: "Over the rate limit", TARGET_CONNECTIVITY: "Backend could not be reached", OTHER: "Other (unknown path or method)",
};
const reason = (t: unknown) => REASONS[txt(t)] ?? (txt(t) ? txt(t).toLowerCase().replace(/_/g, " ") : "Other");
const classColor = (code: number) => (statusClass(code) === "bad" ? "var(--cBad)" : statusClass(code) === "warn" ? "var(--cWarn)" : "var(--c1)");
const classTone = (code: number): Tone => (statusClass(code) === "bad" ? "bad" : statusClass(code) === "warn" ? "warn" : "ok");

function NotEnabled({ status }: { status: GwStatus | undefined }) {
  const state = status?.state ?? "not-configured";
  return (
    <Section title="Native gateway analytics are not enabled on this gateway yet">
      <p className="gw-note" style={{ margin: 0, fontSize: 13.5 }}>
        {state === "waiting-for-file" ? "This console is watching the gateway's analytics folder, but the gateway has not written its analytics file there yet. As soon as analytics logging is switched on at the gateway and the first request passes through, this page fills in by itself."
          : state === "error" ? `The gateway's analytics file was found but could not be read${status?.detail ? ` (${txt(status.detail)})` : ""}.`
          : "The gateway can write one analytics record for every request it handles. This console has not been pointed at that file yet. An administrator needs to switch on the gateway's analytics log and share its folder with this console."}
      </p>
      {status?.file && <p className="gw-note">Expected file: <span className="gw-mono">{txt(status.file)}</span></p>}
      <p className="gw-note" style={{ marginTop: 12 }}>In the meantime, <Link className="gw-link" to="/analytics">Service analytics</Link> shows what the services report themselves, and <Link className="gw-link" to="/logs">Logs</Link> shows every request line.</p>
    </Section>
  );
}

function Traffic({ s, range, linkFor }: { s: GwSummary; range: GwRange; linkFor: (key: string, value: string) => string }) {
  const words = RANGE_WORDS[range];
  const series = list<GwSummary["series"][number]>(s.series);
  const times = series.map((p) => num(p.t));
  const t = s.totals;
  const answered = (p: GwSummary["series"][number]) => num(p.requests) - num(p.faults) > 0;
  const hist = list<GwSummary["latencyHistogram"][number]>(s.latencyHistogram);
  const opCols: Col<GwBreakdownRow>[] = [
    { key: "op", label: "Operation", lead: true, render: (o) => (
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span className="gw-mono">{txt(o.label) || "Rejected before reaching an operation"}</span>
        <span className="gw-faint" style={{ fontSize: 12 }}>{txt(o.extra?.api)}</span>
      </span>) },
    { key: "req", label: "Requests", num: true, render: (o) => fmtInt(o.requests) },
    { key: "err", label: "Errors", num: true, render: (o) => fmtInt(o.errors) },
    { key: "avg", label: "Average", num: true, render: (o) => (num(o.requests) - num(o.faults) > 0 ? fmtMs(o.avgResponseMs) : "—") },
    { key: "be", label: "Backend", num: true, render: (o) => (num(o.requests) - num(o.faults) > 0 ? fmtMs(o.avgBackendMs) : "—") },
    { key: "p95", label: "p95", num: true, render: (o) => (num(o.requests) - num(o.faults) > 0 ? fmtMs(o.p95Ms) : "—") },
    { key: "last", label: "Last seen", num: true, render: (o) => ago(o.lastAt) },
  ];
  return (
    <>
      <div className="gw-tiles">
        <Tile label="Requests" value={fmtInt(t.requests)} hint={`In the ${words}`} />
        <Tile label="Successful" value={fmtInt(t.success)} hint={`${fmtPct(share(num(t.success), num(t.requests)))} of requests`} />
        <Tile label="Client errors" value={fmtInt(t.clientErrors)} hint="Answered with a 4xx code" />
        <Tile label="Server errors" value={fmtInt(t.serverErrors)} hint="Answered with a 5xx code" />
        <Tile label="Rejected" value={fmtInt(t.faults)} hint="Stopped by the gateway itself" />
        <Tile label="Throttled" value={fmtInt(t.throttled)} hint="Over a rate limit" />
        <Tile label="Cache hits" value={fmtInt(t.cacheHits)} hint="Answered without the backend" />
        <Tile label="Average response" value={num(t.requests) - num(t.faults) > 0 ? fmtMs(t.avgResponseMs) : "—"} hint={`Backend part: ${num(t.requests) - num(t.faults) > 0 ? fmtMs(t.avgBackendMs) : "—"}`} />
        <Tile label="p95 response" value={num(t.requests) - num(t.faults) > 0 ? fmtMs(t.p95Ms) : "—"} hint="95 in 100 requests were faster" />
      </div>
      <div className="gw-grid2">
        <ChartCard title="Requests by result" note={`Every request the gateway handled, ${words}.`}
          chart={{ kind: "stack", unit: "count", ariaLabel: `Gateway requests by result over the ${words}`, times, stepSeconds: s.stepSeconds, range, series: [
            { key: "ok", label: "Successful", color: "var(--c1)", values: series.map((p) => num(p.s2xx) + num(p.s3xx)) },
            { key: "4xx", label: "Client errors (4xx)", color: "var(--cWarn)", values: series.map((p) => num(p.s4xx)) },
            { key: "5xx", label: "Server errors (5xx)", color: "var(--cBad)", values: series.map((p) => num(p.s5xx)) }] }} />
        <ChartCard title="Response time: gateway and backend" note="The gap between the two lines is the time spent inside the gateway. Rejected requests are left out."
          chart={{ kind: "line", unit: "ms", ariaLabel: `Gateway and backend response time over the ${words}`, times, stepSeconds: s.stepSeconds, range, emptyText: "No answered requests in this period", series: [
            { key: "gw", label: "Whole request at the gateway", color: "var(--c1)", values: series.map((p) => (answered(p) ? num(p.avgResponseMs) : null)) },
            { key: "be", label: "Backend only", color: "var(--c2)", values: series.map((p) => (answered(p) ? num(p.avgBackendMs) : null)) }] }} />
      </div>
      <div className="gw-grid2">
        <Section title="Traffic by API" note="Choose an API to narrow the whole page to it.">
          <BarList empty="No requests in this period." items={list<GwBreakdownRow>(s.byApi).map((a) => ({
            key: a.key, value: num(a.requests),
            label: <><Link className="gw-link gw-mono" to={linkFor("api", a.label)}>{txt(a.label)}</Link>{a.extra?.version ? <span className="gw-faint"> {txt(a.extra.version)}</span> : null}</>,
            display: <><strong>{fmtInt(a.requests)}</strong> · {num(a.errors) > 0 ? `${fmtPct(share(num(a.errors), num(a.requests)))} errors` : "no errors"}</>,
          }))} />
        </Section>
        <Section title="Response codes" note="What callers received.">
          <BarList empty="No requests in this period." items={list<GwSummary["byStatus"][number]>(s.byStatus).map((c) => ({
            key: String(c.status), value: num(c.requests), color: classColor(num(c.status)),
            label: <><strong>{num(c.status)}</strong> {statusName(num(c.status))}</>,
            display: <><strong>{fmtInt(c.requests)}</strong> · {fmtPct(share(num(c.requests), num(t.requests)))}</>,
          }))} />
        </Section>
      </div>
      <div className="gw-grid2">
        <Section title="Rejected and throttled" note="Requests the gateway stopped before any backend was called.">
          <BarList empty="The gateway did not reject any request in this period." items={list<GwSummary["byErrorType"][number]>(s.byErrorType).map((e) => ({
            key: txt(e.errorType), value: num(e.requests), color: "var(--cWarn)", label: reason(e.errorType),
            display: <><strong>{fmtInt(e.requests)}</strong> · {fmtPct(share(num(e.requests), num(t.requests)))} of all requests</>,
          }))} />
          <p className="gw-note" style={{ marginTop: 14 }}>{num(t.throttled) > 0 ? `${plural(num(t.throttled), "request")} went over a rate limit.` : "No request went over a rate limit."} {num(t.cacheHits) > 0 ? `${plural(num(t.cacheHits), "answer")} came from the response cache.` : "No answer came from the response cache."}</p>
        </Section>
        <ChartCard title="How long requests took" note="Number of answered requests in each response-time band."
          chart={{ kind: "group", unit: "count", ariaLabel: "Number of requests by response time", categories: hist.map((h) => txt(h.label)), emptyText: "No answered requests in this period", series: [
            { key: "gw", label: "Whole request at the gateway", color: "var(--c1)", values: hist.map((h) => num(h.response)) },
            { key: "be", label: "Backend only", color: "var(--c2)", values: hist.map((h) => num(h.backend)) }] }} />
      </div>
      <Section title="By operation" note="Busiest first. Average, backend and p95 cover answered requests only.">
        <DataTable cols={opCols} rows={list<GwBreakdownRow>(s.byOperation)} rowKey={(o) => o.key} label="Gateway traffic by operation" empty="No requests in this period." />
      </Section>
    </>
  );
}

function Applications({ s, all, app, linkFor }: { s: GwSummary; all: GwSummary | undefined; app: string; linkFor: (key: string, value: string) => string }) {
  const apps = list<GwBreakdownRow>((all ?? s).byApp);
  const total = num((all ?? s).totals?.requests);
  const cols: Col<GwBreakdownRow>[] = [
    { key: "app", label: "Application", lead: true, render: (a) => <Link className="gw-link" to={linkFor("app", a.key)}>{appName(a.label)}</Link> },
    { key: "owner", label: "Owner", render: (a) => (txt(a.extra?.owner) && txt(a.extra?.owner) !== "UNKNOWN" ? txt(a.extra?.owner) : "—") },
    { key: "req", label: "Requests", num: true, render: (a) => fmtInt(a.requests) },
    { key: "err", label: "Errors", num: true, render: (a) => fmtInt(a.errors) },
    { key: "rej", label: "Rejected", num: true, render: (a) => fmtInt(a.faults) },
    { key: "thr", label: "Throttled", num: true, render: (a) => fmtInt(a.throttled) },
    { key: "avg", label: "Average", num: true, render: (a) => (num(a.requests) - num(a.faults) > 0 ? fmtMs(a.avgResponseMs) : "—") },
    { key: "p95", label: "p95", num: true, render: (a) => (num(a.requests) - num(a.faults) > 0 ? fmtMs(a.p95Ms) : "—") },
    { key: "last", label: "Last seen", num: true, render: (a) => ago(a.lastAt) },
  ];
  return (
    <>
      <div className="gw-grid2">
        <Section title="Top consumers" note="Applications by number of requests. Callers without a valid key are grouped as unknown.">
          <BarList empty="No requests in this period." items={apps.map((a) => ({
            key: a.key, value: num(a.requests),
            label: <Link className="gw-link" to={linkFor("app", a.key)}>{appName(a.label)}</Link>,
            display: <><strong>{fmtInt(a.requests)}</strong> · {fmtPct(share(num(a.requests), total))}</>,
          }))} />
        </Section>
        <Section title={app ? `What ${appName(app)} calls` : "APIs called"} note={app ? "Requests from this application, by API." : "Choose an application to see only its calls."}>
          <BarList empty="No requests in this period." items={list<GwBreakdownRow>(s.byApi).map((a) => ({
            key: a.key, value: num(a.requests), label: <span className="gw-mono">{txt(a.label)}</span>,
            display: <><strong>{fmtInt(a.requests)}</strong> · {num(a.errors) > 0 ? `${fmtPct(share(num(a.errors), num(a.requests)))} errors` : "no errors"}</>,
          }))} />
        </Section>
      </div>
      <Section title="Usage by application" note="One row per application that called the gateway in this period.">
        <DataTable cols={cols} rows={apps} rowKey={(a) => a.key} label="Usage by application" empty="No application called the gateway in this period." />
      </Section>
    </>
  );
}

function Requests({ api, app, auto }: { api: string; app: string; auto: boolean }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<GwStatusFilter>("all");
  const [sel, setSel] = useState<GwEvent | null>(null);
  const [copied, setCopied] = useState(false);
  const term = useDebounced(search.trim(), 300);
  const q = useQuery({ queryKey: ["gw-requests", term, api, app, status], queryFn: () => apiClient.gwRequests({ search: term, api, app, status, limit: 200 }), refetchInterval: auto ? 10000 : false, placeholderData: keepPreviousData });
  const rows = list<GwEvent>(q.data?.rows);
  const answered = (e: GwEvent) => e.type !== "fault";
  const cols: Col<GwEvent>[] = [
    { key: "time", label: "Time", lead: true, render: (e) => <button type="button" className="gw-link" style={{ border: 0, padding: 0, cursor: "pointer", font: "inherit", fontWeight: 600, textAlign: "left" }} onClick={(ev) => { ev.stopPropagation(); setSel(e); }}>{fmtDateTimeSec(num(e.ts))}</button> },
    { key: "api", label: "API", render: (e) => <span className="gw-mono">{txt(e.api)}</span> },
    { key: "op", label: "Operation", render: (e) => (txt(e.method) || txt(e.resource) ? <span className="gw-mono">{txt(e.method)} {txt(e.resource)}</span> : <span className="gw-muted">Rejected before routing</span>) },
    { key: "status", label: "Result", render: (e) => <Chip tone={classTone(num(e.status))}>{num(e.status)} {e.throttled ? "Over the rate limit" : statusName(num(e.status))}</Chip> },
    { key: "app", label: "Application", render: (e) => appName(e.app) },
    { key: "ms", label: "Took", num: true, render: (e) => (answered(e) ? fmtMs(e.responseLatency) : "—") },
    { key: "cid", label: "Correlation id", render: (e) => <span className="gw-mono gw-faint" title={txt(e.correlationId)}>{txt(e.correlationId).slice(0, 8) || "—"}</span> },
  ];
  return (
    <>
      <Section title="Recent requests"
        note={q.data ? `Newest first. Showing ${fmtInt(rows.length)} of ${fmtInt(q.data.total)} matching requests; this table keeps the most recent ${fmtInt(q.data.kept)}, while the charts cover the full history.` : "Newest first."}>
        <div className="gw-toolbar" style={{ marginBottom: 14 }}>
          <input className="gw-input" type="search" aria-label="Search requests" placeholder="Search API, path, application, user, address or correlation id" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: "1 1 260px" }} />
          <SegTabs<GwStatusFilter> label="Result" value={status} onChange={setStatus} tabs={[
            { id: "all", label: "All" }, { id: "2xx", label: "Successful" }, { id: "4xx", label: "Client errors" }, { id: "5xx", label: "Server errors" }, { id: "fault", label: "Rejected" }, { id: "throttled", label: "Throttled" }]} />
        </div>
        {q.isLoading ? <div className="mf-shim" style={{ height: 200, borderRadius: 12, background: "var(--surface2)" }} aria-busy="true" />
          : q.isError ? <ErrorState message="Could not load recent requests" onRetry={() => q.refetch()} />
          : <DataTable cols={cols} rows={rows} rowKey={(e, i) => `${e.correlationId}-${e.ts}-${i}`} onRow={setSel} label="Recent requests" empty={term || status !== "all" || api || app ? "No recent request matches these filters." : "No requests have passed through the gateway yet."} />}
      </Section>
      <Drawer open={!!sel} title="Request details" onClose={() => { setSel(null); setCopied(false); }}>
        {sel && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Chip tone={classTone(num(sel.status))}>{num(sel.status)} {statusName(num(sel.status))}</Chip>
              {sel.type === "fault" && <Chip tone="warn">Rejected by the gateway</Chip>}
              {sel.throttled && <Chip tone="warn">Throttled</Chip>}
              {sel.cacheHit && <Chip>From cache</Chip>}
            </div>
            <dl className="gw-kv">
              <dt>Time</dt><dd>{fmtDateTimeSec(num(sel.ts))}</dd>
              <dt>API</dt><dd className="gw-mono">{txt(sel.api)} {txt(sel.version)}</dd>
              <dt>Path</dt><dd className="gw-mono">{txt(sel.context)}</dd>
              <dt>Operation</dt><dd className="gw-mono">{txt(sel.method) || txt(sel.resource) ? `${txt(sel.method)} ${txt(sel.resource)}` : "Not reached"}</dd>
              <dt>Application</dt><dd>{appName(sel.app)}{txt(sel.appOwner) && txt(sel.appOwner) !== "UNKNOWN" ? ` (owner ${txt(sel.appOwner)})` : ""}</dd>
              {txt(sel.user) && <><dt>User</dt><dd>{txt(sel.user)}</dd></>}
              {txt(sel.keyType) && txt(sel.keyType) !== "UNKNOWN" && <><dt>Key type</dt><dd>{txt(sel.keyType).toLowerCase()}</dd></>}
              <dt>Backend answered</dt><dd>{sel.targetStatus != null ? `${num(sel.targetStatus)} ${statusName(num(sel.targetStatus))}` : "Backend was not called"}</dd>
              {sel.type !== "fault" && <><dt>Total time</dt><dd>{fmtMs(sel.responseLatency)}</dd>
                <dt>Backend time</dt><dd>{fmtMs(sel.backendLatency)}</dd>
                <dt>Gateway time</dt><dd>{fmtMs(num(sel.requestMediationLatency) + num(sel.responseMediationLatency))}</dd></>}
              {txt(sel.errorType) && <><dt>Reason</dt><dd>{reason(sel.errorType)}{txt(sel.errorMessage) ? `: ${txt(sel.errorMessage).toLowerCase().replace(/_/g, " ")}` : ""}{sel.errorCode ? ` (code ${txt(sel.errorCode)})` : ""}</dd></>}
              {txt(sel.userIp) && <><dt>Caller address</dt><dd className="gw-mono">{txt(sel.userIp)}</dd></>}
              {txt(sel.userAgent) && <><dt>Caller software</dt><dd>{txt(sel.userAgent)}</dd></>}
              {txt(sel.destination) && <><dt>Sent to</dt><dd className="gw-mono">{txt(sel.destination)}</dd></>}
              <dt>Correlation id</dt><dd className="gw-mono">{txt(sel.correlationId) || "None"}</dd>
            </dl>
            {txt(sel.correlationId) && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Link className="gw-btn gw-btn-pri" to={`/logs?cid=${encodeURIComponent(txt(sel.correlationId))}&api=${encodeURIComponent(`gw,svc:${txt(sel.api)}`)}`}><ScrollText size={15} aria-hidden="true" />Find in logs</Link>
                <button type="button" className="gw-btn" onClick={async () => setCopied(await copyText(txt(sel.correlationId)))}><Copy size={15} aria-hidden="true" />{copied ? "Copied" : "Copy id"}</button>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}

export function GatewayAnalytics() {
  const [sp, setSp] = useSearchParams();
  const [range, setRange] = useParam<GwRange>("range", "24h", RANGES);
  const [tab, setTab] = useParam<Tab>("tab", "traffic", TABS);
  const api = sp.get("api") ?? ""; const app = sp.get("app") ?? "";
  const [auto, setAuto] = useAutoRefresh();
  const every = range === "15m" || range === "1h" ? 15 : 60;
  const q = useQuery({ queryKey: ["gw-summary", range, api, app], queryFn: () => apiClient.gwSummary(range, api, app), refetchInterval: auto ? every * 1000 : false, placeholderData: keepPreviousData });
  // Top consumers always compare every application, even while one is selected.
  const allApps = useQuery({ queryKey: ["gw-summary", range, api, ""], queryFn: () => apiClient.gwSummary(range, api, ""), enabled: tab === "applications" && !!app, refetchInterval: auto ? every * 1000 : false, placeholderData: keepPreviousData });
  const status = q.data?.status; const s = q.data?.summary;
  const setFilter = (key: string, value: string) => setSp((prev) => { const n = new URLSearchParams(prev); if (value) n.set(key, value); else n.delete(key); return n; }, { replace: true });
  const linkFor = (key: string, value: string) => { const n = new URLSearchParams(sp); n.set(key, value); return `/gateway-analytics?${n.toString()}`; };
  const apis = [...new Set([...list<string>(s?.apis).map(txt), api].filter(Boolean))].sort();
  const apps = [...new Set([...list<string>(s?.apps).map(txt), app].filter(Boolean))].sort();
  const active = status?.state === "active";

  return (
    <>
      <PageHeader area="Gateway analytics" title="Gateway analytics"
        subtitle="Every request that passed through the gateway, recorded by the gateway itself: who called which API, what they received, how long it took, and what was rejected or throttled." />
      {q.isLoading ? <Loading tiles={6} blocks={2} /> : q.isError ? <ErrorState message="Could not load gateway analytics" onRetry={() => q.refetch()} />
        : !active || !s || !s.totals ? <NotEnabled status={status} /> : (
        <>
          <div className="gw-toolbar">
            <RangeTabs value={range} onChange={setRange} options={RANGES} />
            <select className="gw-select" aria-label="API" value={api} onChange={(e) => setFilter("api", e.target.value)} style={{ maxWidth: 240 }}>
              <option value="">All APIs</option>{apis.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <select className="gw-select" aria-label="Application" value={app} onChange={(e) => setFilter("app", e.target.value)} style={{ maxWidth: 240 }}>
              <option value="">All applications</option>{apps.map((a) => <option key={a} value={a}>{appName(a)}</option>)}
            </select>
            <span className="gw-spacer" />
            <LiveBar auto={auto} setAuto={setAuto} updatedAt={q.dataUpdatedAt} fetching={q.isFetching} onRefresh={() => q.refetch()} everySeconds={every} />
          </div>
          <div className="gw-toolbar">
            <SegTabs<Tab> label="Gateway analytics views" value={tab} onChange={setTab} tabs={[{ id: "traffic", label: "Traffic" }, { id: "applications", label: "Applications" }, { id: "requests", label: "Requests" }]} />
            <span className="gw-spacer" />
            <span className="gw-faint" style={{ fontSize: 12.5 }}>
              {status?.lastEventAt ? `Last request recorded ${ago(Date.parse(status.lastEventAt))}` : "No request recorded yet"} · {fmtInt(status?.eventsIndexed)} recorded in all
            </span>
          </div>
          {tab === "traffic" && <Traffic s={s} range={range} linkFor={linkFor} />}
          {tab === "applications" && <Applications s={s} all={app ? allApps.data?.summary : s} app={app} linkFor={linkFor} />}
          {tab === "requests" && <Requests api={api} app={app} auto={auto} />}
        </>
      )}
    </>
  );
}
