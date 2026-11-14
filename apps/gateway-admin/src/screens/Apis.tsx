import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ChartColumn, ScrollText, ExternalLink, PanelRight } from "lucide-react";
import { apiClient, type InventoryItem, type GatewayApi, type SourceState } from "../api.ts";
import { WEAVE_FACTORY_URL } from "../brand.tsx";
import { Drawer, ErrorState, SegTabs } from "../components/ui.tsx";
import { Tile, Section, Chip, Banner, HealthWord, Loading, DataTable, type Tone, type Col } from "../components/gw.tsx";
import { PageHeader } from "./PageHeader.tsx";
import { txt, num, list, fmtInt, fmtMs, fmtPct, plural, ago, fmtDateTime } from "../lib/text.ts";

type Filter = "all" | "published" | "internal" | "flows";
const ROLE: Record<string, { word: string; tone: Tone }> = {
  system: { word: "System", tone: "sys" }, process: { word: "Process", tone: "proc" }, experience: { word: "Experience", tone: "exp" },
  flow: { word: "Flow", tone: "accent" }, worker: { word: "Worker", tone: "plain" }, infrastructure: { word: "Infrastructure", tone: "plain" },
};
const TRAFFIC_SOURCE: Record<string, string> = { gateway: "Measured at the gateway", service: "Reported by the service", runtime: "Reported by the flow runtime" };

export function factoryLink(item: Pick<InventoryItem, "factoryPath">): string {
  if (!WEAVE_FACTORY_URL || !item.factoryPath) return "";
  return `${WEAVE_FACTORY_URL.replace(/\/+$/, "")}${item.factoryPath}`;
}
export function analyticsLink(item: InventoryItem): string {
  if (item.kind === "gateway-api" || (item.kind === "service" && !item.metricsExported && item.exposure !== "internal" && item.gateway[0]))
    return `/gateway-analytics?api=${encodeURIComponent(txt(item.gateway[0]?.name ?? item.name))}`;
  return `/analytics/api/${encodeURIComponent(item.name)}`;
}
const gwPath = (g: GatewayApi) => `${txt(g.context)}/${txt(g.version)}`.replace(/\/+/g, "/");

function Exposure({ item, gatewayKnown }: { item: InventoryItem; gatewayKnown: boolean }) {
  const g = list<GatewayApi>(item.gateway);
  const addr = item.cluster ? `${txt(item.cluster.address)}${item.cluster.port ? `:${item.cluster.port}` : ""}` : "";
  if (g.length && item.exposure !== "internal") {
    const first = g[0];
    const subs = first.subscriptions;
    return (
      <>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {item.exposure === "published" ? <Chip tone="ok">Published</Chip> : <Chip tone="warn">On the gateway, not published</Chip>}
          <span className="gw-mono">{gwPath(first)}</span>
          {g.length > 1 && <span className="gw-faint">and {g.length - 1} more</span>}
        </div>
        <div className="gw-muted" style={{ lineHeight: 1.5 }}>
          {[list<string>(first.security).map(txt).join(", ") || "No sign-in set", first.throttling ? `rate limit ${txt(first.throttling)}` : "", subs != null ? plural(num(subs), "subscribed application") : ""].filter(Boolean).join(" · ")}
        </div>
      </>
    );
  }
  if (!gatewayKnown && item.kind !== "flow") return (<><div><Chip tone="warn">Unknown</Chip></div>{addr && <span className="gw-mono">{addr}</span>}<span className="gw-muted">The gateway could not be read</span></>);
  if (item.kind === "flow") return (<><div><Chip>Not published</Chip></div><span className="gw-muted">Runs on the flow runtime only</span></>);
  return (<><div><Chip>Internal only</Chip></div>{addr && <span className="gw-mono">{addr}</span>}<span className="gw-muted">Reachable inside the cluster, not on the gateway</span></>);
}

function TrafficCell({ item }: { item: InventoryItem }) {
  const t = item.traffic;
  if (!t) return <span className="gw-muted" style={{ lineHeight: 1.5 }}>{item.kind === "service" && item.metricsExported === false ? "No measurements: not on the gateway and the service does not report metrics" : "No measurements"}</span>;
  const req = num(t.requests), err = num(t.errors);
  return (
    <>
      <span><strong>{fmtInt(req)}</strong> {req === 1 ? "request" : "requests"}{req > 0 && <> · <span style={{ color: err > 0 ? "var(--bad)" : "var(--muted)", fontWeight: err > 0 ? 600 : 400 }}>{err > 0 ? `${plural(err, "error")} (${fmtPct(t.errorRate)})` : "no errors"}</span></>}</span>
      {req > 0 && <span className="gw-muted">{t.avgMs != null ? `${fmtMs(t.avgMs)} average` : ""}{t.avgMs != null && t.p95Ms != null ? " · " : ""}{t.p95Ms != null ? `${fmtMs(t.p95Ms)} slowest 5%` : ""}</span>}
      <span className="gw-faint" style={{ fontSize: 12 }}>{TRAFFIC_SOURCE[t.source] ?? ""}</span>
    </>
  );
}

function ApiRowView({ item, gatewayKnown, onDetails }: { item: InventoryItem; gatewayKnown: boolean; onDetails: (i: InventoryItem) => void }) {
  const role = ROLE[item.role] ?? { word: txt(item.role), tone: "plain" as Tone };
  const h = item.health;
  const fl = factoryLink(item);
  return (
    <div className="gw-apirow" data-api={item.name}>
      <div className="gw-apicell gw-apiname">
        <span className="gw-mono" style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{txt(item.name)}</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{role.word && <Chip tone={role.tone}>{role.word}</Chip>}{item.kind === "gateway-api" && <Chip>Gateway only</Chip>}</div>
        {item.description && <span className="gw-muted" style={{ lineHeight: 1.45 }}>{txt(item.description)}</span>}
      </div>
      <div className="gw-apicell"><span className="gw-apicell-label">Exposure</span><Exposure item={item} gatewayKnown={gatewayKnown} /></div>
      <div className="gw-apicell"><span className="gw-apicell-label">Health</span>
        {h ? (<><HealthWord state={h.state} />{item.kind !== "flow" && num(h.desired) > 0 && <span className="gw-muted">{num(h.ready)} of {num(h.desired)} ready</span>}{num(h.restarts) > 0 && <span className="gw-muted">{plural(num(h.restarts), "restart")}</span>}</>) : <span className="gw-muted">Not running in this cluster</span>}
      </div>
      <div className="gw-apicell"><span className="gw-apicell-label">Last hour</span><TrafficCell item={item} /></div>
      <div className="gw-apiactions">
        <button type="button" className="gw-btn gw-btn-sm" onClick={() => onDetails(item)} aria-label={`Details of ${txt(item.name)}`}><PanelRight size={14} aria-hidden="true" />Details</button>
        <Link className="gw-btn gw-btn-sm" to={analyticsLink(item)} aria-label={`Analytics for ${txt(item.name)}`}><ChartColumn size={14} aria-hidden="true" />Analytics</Link>
        {item.logSource && <Link className="gw-btn gw-btn-sm" to={`/logs?api=${encodeURIComponent(item.logSource)}`} aria-label={`Logs of ${txt(item.name)}`}><ScrollText size={14} aria-hidden="true" />Logs</Link>}
        {fl && <a className="gw-btn gw-btn-sm" href={fl} target="_blank" rel="noreferrer" aria-label={`Open ${txt(item.name)} in Factory`}><ExternalLink size={14} aria-hidden="true" />Factory</a>}
      </div>
    </div>
  );
}

function Details({ item, gatewayKnown }: { item: InventoryItem; gatewayKnown: boolean }) {
  const fl = factoryLink(item);
  const h = item.health;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {item.description && <p className="gw-muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>{txt(item.description)}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Link className="gw-btn gw-btn-sm" to={analyticsLink(item)}><ChartColumn size={14} aria-hidden="true" />Analytics</Link>
        {item.logSource && <Link className="gw-btn gw-btn-sm" to={`/logs?api=${encodeURIComponent(item.logSource)}`}><ScrollText size={14} aria-hidden="true" />Logs</Link>}
        {fl && <a className="gw-btn gw-btn-sm" href={fl} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />Open in Factory</a>}
      </div>

      {list<GatewayApi>(item.gateway).map((g) => (
        <div key={g.id} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h3 className="gw-h2" style={{ fontSize: 14 }}>On the gateway{item.gateway.length > 1 ? `: ${txt(g.name)}` : ""}</h3>
          <dl className="gw-kv">
            <dt>Path</dt><dd className="gw-mono">{gwPath(g)}</dd>
            <dt>State</dt><dd>{txt(g.lifeCycleStatus) === "PUBLISHED" ? "Published" : txt(g.lifeCycleStatus).toLowerCase() || "unknown"}</dd>
            <dt>Sign-in</dt><dd>{list<string>(g.security).map(txt).join(", ") || "None set"}</dd>
            <dt>Rate limit</dt><dd>{g.throttling ? txt(g.throttling) : "None at API level"}</dd>
            <dt>Plans</dt><dd>{list<string>(g.tiers).map(txt).join(", ") || "None"}</dd>
            <dt>Subscribers</dt><dd>{g.subscriptions == null ? "Unknown" : num(g.subscriptions) === 0 ? "No applications yet" : `${plural(num(g.subscriptions), "application")}${list<string>(g.applications).length ? `: ${list<string>(g.applications).map(txt).join(", ")}` : ""}`}</dd>
            <dt>Response cache</dt><dd>{g.cachingSeconds ? `On, ${fmtInt(g.cachingSeconds)} seconds` : "Off"}</dd>
            {g.backend && <><dt>Sends to</dt><dd className="gw-mono">{txt(g.backend)}</dd></>}
          </dl>
          {list(g.operations).length > 0 && (
            <div style={{ borderRadius: 10, border: "1px solid var(--border)", overflow: "hidden" }}>
              {g.operations.map((o, i) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "8px 12px", borderTop: i ? "1px solid var(--border)" : "none", background: "var(--surface2)" }}>
                  <span className="mf-mono" style={{ fontSize: 11, fontWeight: 700, width: 54, flex: "0 0 auto", color: "var(--accentText)" }}>{txt(o.verb)}</span>
                  <span className="gw-mono" style={{ flex: 1 }}>{txt(o.target)}</span>
                  <span style={{ fontSize: 11, color: /^none$/i.test(txt(o.authType)) ? "var(--warn)" : "var(--faint)", textAlign: "right" }}>{/^none$/i.test(txt(o.authType)) ? "Open" : "Sign-in required"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {!item.gateway.length && item.kind === "service" && (
        <Banner tone={gatewayKnown ? "info" : "warn"}>{gatewayKnown ? "This API is not published on the gateway. Other services reach it inside the cluster; outside callers cannot." : "The gateway could not be read, so it is not known whether this API is published."}</Banner>
      )}

      {item.cluster && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h3 className="gw-h2" style={{ fontSize: 14 }}>Inside the cluster</h3>
          <dl className="gw-kv">
            <dt>Address</dt><dd className="gw-mono">{txt(item.cluster.address)}{item.cluster.port ? `:${item.cluster.port}` : ""}</dd>
            {item.cluster.nodePort ? <><dt>Node port</dt><dd className="gw-mono">{item.cluster.nodePort}</dd></> : null}
            <dt>Namespace</dt><dd className="gw-mono">{txt(item.cluster.namespace)}</dd>
            <dt>Own metrics</dt><dd>{item.metricsExported ? "Reported by the service" : item.metricsExported === false ? "Not reported" : "Not applicable"}</dd>
          </dl>
        </div>
      )}

      {h && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h3 className="gw-h2" style={{ fontSize: 14 }}>Health</h3>
          <dl className="gw-kv">
            <dt>State</dt><dd><HealthWord state={h.state} /></dd>
            {num(h.desired) > 0 && <><dt>Replicas</dt><dd>{num(h.ready)} of {num(h.desired)} ready</dd></>}
            {h.image && <><dt>Image</dt><dd className="gw-mono">{txt(h.image)}</dd></>}
          </dl>
          {list(h.pods).length > 0 && (
            <div style={{ borderRadius: 10, border: "1px solid var(--border)", overflow: "hidden" }}>
              {h.pods.map((p, i) => {
                const started = Date.parse(txt(p.startedAt));
                return (
                  <div key={p.name} style={{ display: "flex", flexDirection: "column", gap: 3, padding: "8px 12px", borderTop: i ? "1px solid var(--border)" : "none", background: "var(--surface2)" }}>
                    <span className="gw-mono">{txt(p.name)}</span>
                    <span className="gw-muted" style={{ fontSize: 12.5 }}>
                      {p.ready ? "Ready" : `Not ready${p.reason ? ` (${txt(p.reason)})` : ""}`} · {txt(p.phase)} · {plural(num(p.restarts), "restart")}{Number.isFinite(started) ? ` · started ${fmtDateTime(started)}` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function sourceProblem(name: string, s: SourceState | undefined, effect: string): string | null {
  if (!s || s.ok) return null;
  if (!s.configured) return `${name} is not connected to this console. ${effect}`;
  return `${name} could not be read${s.detail ? ` (${txt(s.detail)})` : ""}. ${effect}`;
}

export function Apis() {
  const [sel, setSel] = useState<InventoryItem | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const q = useQuery({ queryKey: ["inventory"], queryFn: apiClient.inventory, refetchInterval: 30000, placeholderData: keepPreviousData });
  const d = q.data;
  const items = useMemo(() => list<InventoryItem>(d?.items), [d]);
  const components = list<InventoryItem>(d?.components);
  const gatewayKnown = d?.sources?.gateway?.ok !== false;

  const counts = useMemo(() => ({
    all: items.length,
    published: items.filter((i) => i.exposure === "published").length,
    internal: items.filter((i) => i.kind === "service" && i.exposure === "internal").length,
    flows: items.filter((i) => i.kind === "flow").length,
  }), [items]);
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return items.filter((i) => {
      if (filter === "published" && i.exposure !== "published") return false;
      if (filter === "internal" && !(i.kind === "service" && i.exposure === "internal")) return false;
      if (filter === "flows" && i.kind !== "flow") return false;
      if (!s) return true;
      return [i.name, i.role, i.cluster?.address, ...list<GatewayApi>(i.gateway).map((g) => `${g.name} ${g.context}`)].some((v) => txt(v).toLowerCase().includes(s));
    });
  }, [items, filter, search]);
  const groups = [
    { key: "service", title: "Migrated services", note: "Every service that was migrated, whether or not it is published on the gateway." },
    { key: "flow", title: "Flows", note: "Integrations built in the Studio and running on the flow runtime." },
    { key: "gateway-api", title: "Other APIs on the gateway", note: "Defined on the gateway without a migrated service or flow behind them in this cluster." },
  ].map((g) => ({ ...g, rows: shown.filter((i) => i.kind === g.key) })).filter((g) => g.rows.length);

  const problems = d ? [
    sourceProblem("The cluster", d.sources?.kubernetes, "Health, replicas and internal-only services are missing below."),
    sourceProblem("The gateway", d.sources?.gateway, "Which APIs are published is unknown until this is fixed."),
    sourceProblem("The metrics store", d.sources?.metrics, "Request counts reported by services are missing."),
    sourceProblem("The flow runtime", d.sources?.runtime, "Flows are missing below."),
  ].filter((x): x is string => !!x) : [];

  const compCols: Col<InventoryItem>[] = [
    { key: "name", label: "Component", lead: true, render: (c) => <span className="gw-mono" style={{ fontWeight: 600 }}>{txt(c.name)}</span> },
    { key: "role", label: "Role", render: (c) => (ROLE[c.role]?.word ?? txt(c.role)) },
    { key: "health", label: "Health", render: (c) => (c.health ? <HealthWord state={c.health.state} /> : "Unknown") },
    { key: "replicas", label: "Replicas", num: true, render: (c) => (c.health ? `${num(c.health.ready)} of ${num(c.health.desired)}` : "—") },
    { key: "logs", label: "Logs", num: true, render: (c) => (c.logSource ? <Link className="gw-link" to={`/logs?api=${encodeURIComponent(c.logSource)}`} aria-label={`Logs of ${txt(c.name)}`}>View logs</Link> : "") },
  ];

  return (
    <>
      <PageHeader area="APIs" title="APIs" subtitle="Everything that was migrated or built here, in one list: what is published on the gateway, what is only reachable inside the cluster, whether it is healthy and how much traffic it took in the last hour." />
      {q.isLoading ? <Loading tiles={5} blocks={2} /> : q.isError || !d || !d.summary ? <ErrorState message="Could not load the API list" onRetry={() => q.refetch()} /> : (
        <>
          {problems.map((p) => <Banner key={p} tone="warn">{p}</Banner>)}
          <div className="gw-tiles">
            <Tile label="Migrated services" value={fmtInt(d.summary.services)} hint="Running in the cluster" />
            <Tile label="Published" value={gatewayKnown ? fmtInt(d.summary.published) : "—"} hint="Open to callers through the gateway" />
            <Tile label="Internal only" value={gatewayKnown ? fmtInt(d.summary.internal) : "—"} hint="Reachable inside the cluster" />
            <Tile label="Flows" value={fmtInt(d.summary.flows)} hint="Built in the Studio" />
            <Tile label="Need attention" value={fmtInt(d.summary.unhealthy)} hint={num(d.summary.unhealthy) === 0 ? "Everything is healthy" : "Degraded or down"} />
          </div>

          <div className="gw-toolbar">
            <SegTabs<Filter> label="Show" value={filter} onChange={setFilter} tabs={[
              { id: "all", label: "All", count: counts.all }, { id: "published", label: "Published", count: counts.published },
              { id: "internal", label: "Internal", count: counts.internal }, { id: "flows", label: "Flows", count: counts.flows }]} />
            <span className="gw-spacer" />
            <input className="gw-input" type="search" aria-label="Search APIs" placeholder="Search by name or path" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} />
            <span className="gw-faint" style={{ fontSize: 12.5 }}>Checked {ago(Date.parse(txt(d.generatedAt)))}</span>
          </div>

          {groups.length === 0 && <Section title="Nothing matches"><p className="gw-note" style={{ margin: 0 }}>No API matches this filter. Clear the search or choose "All".</p></Section>}
          {groups.map((g) => (
            <Section key={g.key} title={`${g.title} (${g.rows.length})`} note={g.note}>
              <div className="gw-apilist">
                <div className="gw-apihead" aria-hidden="true"><span>API</span><span>Exposure</span><span>Health</span><span>Last hour</span><span /></div>
                {g.rows.map((i) => <ApiRowView key={i.id} item={i} gatewayKnown={gatewayKnown} onDetails={setSel} />)}
              </div>
            </Section>
          ))}

          {components.length > 0 && filter === "all" && !search.trim() && (
            <Section title={`Supporting components (${components.length})`} note="Databases, caches and background workers the services depend on. They are not APIs and are never published.">
              <DataTable cols={compCols} rows={components} rowKey={(c) => c.id} empty="None" label="Supporting components" />
            </Section>
          )}
        </>
      )}

      <Drawer open={!!sel} title={sel ? txt(sel.name) : ""} onClose={() => setSel(null)}>
        {sel && <Details item={sel} gatewayKnown={gatewayKnown} />}
      </Drawer>
    </>
  );
}
