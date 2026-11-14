import { Link, useParams } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ArrowLeft, ScrollText, ExternalLink, Activity } from "lucide-react";
import { apiClient, type ApiDetail, type InventoryItem, type Range } from "../api.ts";
import { ErrorState } from "../components/ui.tsx";
import { Tile, Section, Banner, Loading, DataTable, RangeTabs, LiveBar, useParam, useAutoRefresh, RANGE_WORDS, type Col } from "../components/gw.tsx";
import { ChartCard, BarList, SegBar } from "../charts/Chart.tsx";
import { PageHeader } from "./PageHeader.tsx";
import { RANGES, refreshEvery } from "./Analytics.tsx";
import { factoryLink } from "./Apis.tsx";
import { txt, num, list, fmtInt, fmtMs, fmtPct } from "../lib/text.ts";

type Op = ApiDetail["operations"][number];
type Peer = ApiDetail["downstream"][number];

export function ApiAnalytics() {
  const name = useParams().name ?? "";
  const [range, setRange] = useParam<Range>("range", "1h", RANGES);
  const [auto, setAuto] = useAutoRefresh();
  const every = refreshEvery(range);
  const q = useQuery({ queryKey: ["analytics-api", name, range], queryFn: () => apiClient.analyticsApi(name, range), refetchInterval: auto ? every * 1000 : false, placeholderData: keepPreviousData });
  const inv = useQuery({ queryKey: ["inventory"], queryFn: apiClient.inventory, staleTime: 30000 });
  const d = q.data;
  const item = list<InventoryItem>(inv.data?.items).find((i) => i.name === name || (d?.id && i.id === `flow:${d.id}`));
  const published = item?.exposure === "published" ? item.gateway[0] : undefined;
  const logSource = item?.logSource ?? (d?.kind === "flow" && d.id ? `flow:${d.id}` : `svc:${name}`);
  const fl = item ? factoryLink(item) : "";
  const series = list<ApiDetail["series"][number]>(d?.series);
  const times = series.map((p) => num(p.t));
  const words = RANGE_WORDS[range];
  const isFlow = d?.kind === "flow";
  const byGroup = (g: string) => num(list<ApiDetail["byStatus"][number]>(d?.byStatus).find((s) => s.group === g)?.requests);

  const opCols: Col<Op>[] = [
    { key: "op", label: "Operation", lead: true, render: (o) => <span><span className="mf-mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--accentText)", marginRight: 8 }}>{txt(o.method)}</span><span className="gw-mono">{txt(o.path)}</span></span> },
    { key: "req", label: "Requests", num: true, render: (o) => fmtInt(o.requests) },
    { key: "err", label: "Errors", num: true, render: (o) => fmtInt(o.errors) },
    { key: "rate", label: "Error rate", num: true, render: (o) => fmtPct(o.errorRate) },
    { key: "avg", label: "Average", num: true, render: (o) => fmtMs(o.avgMs) },
    { key: "p95", label: "p95", num: true, render: (o) => fmtMs(o.p95Ms) },
  ];
  const peerCols: Col<Peer>[] = [
    { key: "peer", label: "Calls to", lead: true, render: (p) => <span className="gw-mono">{txt(p.peer)}</span> },
    { key: "req", label: "Calls", num: true, render: (p) => fmtInt(p.requests) },
    { key: "err", label: "Failed", num: true, render: (p) => fmtInt(p.errors) },
    { key: "avg", label: "Average", num: true, render: (p) => fmtMs(p.avgMs) },
  ];

  return (
    <>
      <Link className="gw-link" to={`/analytics?range=${range}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13.5, alignSelf: "flex-start" }}><ArrowLeft size={15} aria-hidden="true" />Service analytics</Link>
      <PageHeader area="Service analytics" title={name}
        subtitle={isFlow ? "A flow built in the Studio, measured by the flow runtime." : "What this service reports about its own requests."}
        actions={<>
          <Link className="gw-btn" to={`/logs?api=${encodeURIComponent(logSource)}`}><ScrollText size={15} aria-hidden="true" />Logs</Link>
          {published && <Link className="gw-btn" to={`/gateway-analytics?api=${encodeURIComponent(txt(published.name))}`}><Activity size={15} aria-hidden="true" />At the gateway</Link>}
          {fl && <a className="gw-btn" href={fl} target="_blank" rel="noreferrer"><ExternalLink size={15} aria-hidden="true" />Open in Factory</a>}
        </>} />
      <div className="gw-toolbar">
        <RangeTabs value={range} onChange={setRange} options={RANGES} />
        <span className="gw-spacer" />
        <LiveBar auto={auto} setAuto={setAuto} updatedAt={q.dataUpdatedAt} fetching={q.isFetching} onRefresh={() => q.refetch()} everySeconds={every} />
      </div>
      {q.isLoading ? <Loading tiles={4} blocks={2} /> : q.isError || !d || !d.totals ? <ErrorState message="Could not load analytics for this API" onRetry={() => q.refetch()} /> : (
        <>
          {d.source && !d.source.ok && <Banner tone="warn">{isFlow ? "The flow runtime" : "The metrics store"} could not be read{d.source.detail ? ` (${txt(d.source.detail)})` : ""}. The numbers below may be missing.</Banner>}
          {!d.exportsMetrics ? (
            <Section title="This service does not publish its own metrics">
              <p className="gw-note" style={{ margin: 0, fontSize: 13.5 }}>
                {txt(name)} is running, but it does not report request counts or response times, so there is nothing to chart from the inside.
                {published ? " It is published on the gateway, where every call is measured." : " It is not published on the gateway either, so its logs are the place to look."}
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
                {published && <Link className="gw-btn gw-btn-pri" to={`/gateway-analytics?api=${encodeURIComponent(txt(published.name))}`}><Activity size={15} aria-hidden="true" />See its traffic at the gateway</Link>}
                <Link className="gw-btn" to={`/logs?api=${encodeURIComponent(logSource)}`}><ScrollText size={15} aria-hidden="true" />Open its logs</Link>
              </div>
            </Section>
          ) : (
            <>
              {d.windowNote && <Banner>{txt(d.windowNote)}</Banner>}
              <div className="gw-tiles">
                <Tile label="Requests" value={fmtInt(d.totals.requests)} hint={isFlow ? "Runs counted by the runtime" : `In the ${words}`} />
                <Tile label="Errors" value={fmtInt(d.totals.errors)} hint={num(d.totals.requests) > 0 ? `${fmtPct(d.totals.errorRate)} of requests` : "No requests yet"} />
                <Tile label={isFlow && d.totals.avgMs == null ? "Typical response" : "Average response"} value={fmtMs(d.totals.avgMs ?? d.totals.p50Ms)} hint={isFlow && d.totals.avgMs == null ? "Half of the runs were faster" : undefined} />
                <Tile label="p95 response" value={fmtMs(d.totals.p95Ms)} hint="95 in 100 requests were faster" />
                {!isFlow && <Tile label="Replicas" value={fmtInt(d.replicas)} hint="Reporting metrics" />}
              </div>
              {isFlow ? (
                <Banner>Flows report totals for the last hour, not a timeline. Open the logs to see each run step by step.</Banner>
              ) : (
                <>
                  <div className="gw-grid2">
                    <ChartCard title="Requests by result" note={`How requests ended, ${words}.`}
                      chart={{ kind: "stack", unit: "count", ariaLabel: `Requests by result over the ${words}`, times, stepSeconds: d.stepSeconds, range, series: [
                        { key: "ok", label: "Successful", color: "var(--c1)", values: series.map((p) => num(p.s2xx) + num(p.s3xx)) },
                        { key: "4xx", label: "Client errors (4xx)", color: "var(--cWarn)", values: series.map((p) => num(p.s4xx)) },
                        { key: "5xx", label: "Server errors (5xx)", color: "var(--cBad)", values: series.map((p) => num(p.s5xx)) }] }} />
                    <ChartCard title="Response time" note="Shown only for the moments that had requests."
                      chart={{ kind: "line", unit: "ms", ariaLabel: `Response time over the ${words}`, times, stepSeconds: d.stepSeconds, range, series: [
                        { key: "avg", label: "Average", color: "var(--c1)", values: series.map((p) => p.avgMs ?? null) },
                        { key: "p95", label: "p95", color: "var(--c2)", values: series.map((p) => p.p95Ms ?? null) },
                        { key: "p99", label: "p99", color: "var(--c3)", values: series.map((p) => p.p99Ms ?? null) }] }} />
                  </div>
                  <div className="gw-grid2">
                    <Section title="How requests ended" note={`All requests in the ${words}.`}>
                      {num(d.totals.requests) === 0 ? <p className="gw-note" style={{ margin: 0 }}>No requests in this period.</p> : (
                        <SegBar parts={[
                          { key: "ok", label: "Successful", value: byGroup("2xx") + byGroup("3xx"), color: "var(--c1)" },
                          { key: "4xx", label: "Client errors (4xx)", value: byGroup("4xx"), color: "var(--cWarn)" },
                          { key: "5xx", label: "Server errors (5xx)", value: byGroup("5xx"), color: "var(--cBad)" }]} />
                      )}
                    </Section>
                    <Section title="Response time spread" note="p50 means half of the requests were at least this fast; p95 means 95 in 100 were. Estimated by the service.">
                      <BarList empty="No requests in this period." items={list<ApiDetail["latency"][number]>(d.latency).filter((l) => ["0.5", "0.75", "0.95", "0.99"].includes(txt(l.quantile))).map((l) => ({ key: txt(l.quantile), label: txt(l.label), value: num(l.ms), display: <strong>{fmtMs(l.ms)}</strong> }))} />
                    </Section>
                  </div>
                  <Section title="Operations" note="Each operation this service answered, busiest first.">
                    <DataTable cols={opCols} rows={list<Op>(d.operations)} rowKey={(o) => `${o.method} ${o.path}`} label="Operations" empty="No requests in this period." />
                  </Section>
                  <Section title="Calls to other services" note="What this service called while answering, and how those calls went.">
                    <DataTable cols={peerCols} rows={list<Peer>(d.downstream)} rowKey={(p) => p.peer} label="Calls to other services" empty="This service made no outgoing calls in this period." />
                  </Section>
                </>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
