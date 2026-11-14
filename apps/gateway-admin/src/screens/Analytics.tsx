import { Link, useNavigate } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { apiClient, type ApiRow, type Range } from "../api.ts";
import { ErrorState } from "../components/ui.tsx";
import { Tile, Section, Chip, Banner, Loading, DataTable, RangeTabs, LiveBar, useParam, useAutoRefresh, RANGE_WORDS, type Col } from "../components/gw.tsx";
import { ChartCard, Spark } from "../charts/Chart.tsx";
import { PageHeader } from "./PageHeader.tsx";
import { txt, num, list, fmtInt, fmtMs, fmtPct, plural } from "../lib/text.ts";

export const RANGES = ["15m", "1h", "6h", "24h", "7d"] as const;
export const refreshEvery = (range: string) => (range === "15m" || range === "1h" ? 15 : 60);

export function Analytics() {
  const nav = useNavigate();
  const [range, setRange] = useParam<Range>("range", "1h", RANGES);
  const [auto, setAuto] = useAutoRefresh();
  const every = refreshEvery(range);
  const q = useQuery({ queryKey: ["analytics", range], queryFn: () => apiClient.analyticsOverview(range), refetchInterval: auto ? every * 1000 : false, placeholderData: keepPreviousData });
  const d = q.data;
  const series = list<NonNullable<typeof d>["series"][number]>(d?.series);
  const apis = list<ApiRow>(d?.apis);
  const quiet = list<string>(d?.notExporting);
  const times = series.map((p) => num(p.t));
  const words = RANGE_WORDS[range];
  const reporting = apis.filter((a) => a.kind === "service").length;

  const cols: Col<ApiRow>[] = [
    { key: "name", label: "API", lead: true, render: (a) => <Link className="gw-link gw-mono" style={{ fontSize: 13.5 }} to={`/analytics/api/${encodeURIComponent(a.name)}?range=${range}`} onClick={(e) => e.stopPropagation()}>{txt(a.name)}</Link> },
    { key: "kind", label: "Type", render: (a) => <Chip tone={a.kind === "flow" ? "accent" : "plain"}>{a.kind === "flow" ? "Flow" : "Service"}</Chip> },
    { key: "req", label: "Requests", num: true, render: (a) => fmtInt(a.requests) },
    { key: "err", label: "Errors", num: true, render: (a) => fmtInt(a.errors) },
    { key: "rate", label: "Error rate", num: true, render: (a) => fmtPct(a.errorRate) },
    { key: "avg", label: "Average", num: true, render: (a) => fmtMs(a.avgMs) },
    { key: "p95", label: "p95", num: true, render: (a) => fmtMs(a.p95Ms) },
    { key: "trend", label: "Trend", num: true, render: (a) => (a.kind === "flow" ? <span className="gw-faint" style={{ fontSize: 12 }}>last hour only</span> : <span style={{ display: "inline-block" }}><Spark values={list<number>(a.spark).map((v) => num(v))} /></span>) },
  ];

  return (
    <>
      <PageHeader area="Service analytics" title="Service analytics"
        subtitle="Requests, errors and response times as the services and flows themselves report them. This is what happens inside the platform, including calls that never pass through the gateway." />
      <div className="gw-toolbar">
        <RangeTabs value={range} onChange={setRange} options={RANGES} />
        <span className="gw-spacer" />
        <LiveBar auto={auto} setAuto={setAuto} updatedAt={q.dataUpdatedAt} fetching={q.isFetching} onRefresh={() => q.refetch()} everySeconds={every} />
      </div>
      {q.isLoading ? <Loading tiles={4} blocks={2} /> : q.isError || !d || !d.totals ? <ErrorState message="Could not load analytics" onRetry={() => q.refetch()} /> : (
        <>
          {d.sources?.prometheus && !d.sources.prometheus.ok && (
            <Banner tone="warn">{d.sources.prometheus.configured ? `The metrics store could not be read${d.sources.prometheus.detail ? ` (${txt(d.sources.prometheus.detail)})` : ""}. Service numbers are missing until it answers again.` : "No metrics store is connected to this console, so services cannot be measured here."}</Banner>
          )}
          {d.sources?.runtime && d.sources.runtime.configured && !d.sources.runtime.ok && <Banner tone="warn">The flow runtime could not be read, so flows are missing from these numbers.</Banner>}
          <div className="gw-tiles">
            <Tile label="Requests" value={fmtInt(d.totals.requests)} hint={`In the ${words}`} />
            <Tile label="Errors" value={fmtInt(d.totals.errors)} hint={num(d.totals.requests) > 0 ? `${fmtPct(d.totals.errorRate)} of requests` : "No requests yet"} />
            <Tile label="Average response" value={fmtMs(d.totals.avgMs)} hint="Across every reporting API" />
            <Tile label="p95 response" value={fmtMs(d.totals.p95Ms)} hint="95 in 100 requests were faster" />
            <Tile label="Reporting" value={`${reporting} of ${reporting + quiet.length}`} hint="Services that publish their own metrics" />
          </div>
          <div className="gw-grid2">
            <ChartCard title="Requests" note={`Successful and failed requests, ${words}.`}
              chart={{ kind: "stack", unit: "count", ariaLabel: `Requests over the ${words}`, times, stepSeconds: d.stepSeconds, range, series: [
                { key: "ok", label: "Successful", color: "var(--c1)", values: series.map((p) => Math.max(0, num(p.requests) - num(p.errors))) },
                { key: "err", label: "Errors", color: "var(--cBad)", values: series.map((p) => num(p.errors)) }] }} />
            <ChartCard title="Response time" note="Shown only for the moments that had requests."
              chart={{ kind: "line", unit: "ms", ariaLabel: `Response time over the ${words}`, times, stepSeconds: d.stepSeconds, range, emptyText: "No requests in this period", series: [
                { key: "avg", label: "Average", color: "var(--c1)", values: series.map((p) => p.avgMs ?? null) },
                { key: "p95", label: "p95 (slowest 5% start here)", color: "var(--c2)", values: series.map((p) => p.p95Ms ?? null) }] }} />
          </div>
          <Section title="By API" note="Choose an API to see its operations, response codes and the calls it makes to other services.">
            <DataTable cols={cols} rows={apis} rowKey={(a) => `${a.kind}:${a.name}`} label="Analytics by API"
              onRow={(a) => nav(`/analytics/api/${encodeURIComponent(a.name)}?range=${range}`)}
              empty="No service or flow has reported any numbers yet." />
          </Section>
          {quiet.length > 0 && (
            <Section title={`Not reporting their own metrics (${quiet.length})`}
              note={<>These services run normally but do not publish request metrics, so they cannot be charted here. When one of them is published, its traffic is still measured at the gateway: see <Link className="gw-link" to="/gateway-analytics">Gateway analytics</Link>. Their logs are always available.</>}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {quiet.map((n) => <Link key={n} className="gw-btn gw-btn-sm gw-mono" to={`/logs?api=${encodeURIComponent(`svc:${n}`)}`} aria-label={`Logs of ${n}`}>{txt(n)}</Link>)}
              </div>
              <p className="gw-note" style={{ marginTop: 12 }}>{plural(quiet.length, "service")} listed. Selecting one opens its logs.</p>
            </Section>
          )}
        </>
      )}
    </>
  );
}
