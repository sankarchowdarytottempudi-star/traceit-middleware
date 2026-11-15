// The estate: every API that is running, how they depend on each other, and how they are doing.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { api, type EstateApi, type EstateLink } from "../api.ts";
import { num, txt } from "../lib/text.ts";
import { LAND_MIN_WIDTH, ago, compact, dateTime, healthLabel, healthTone, layerKey, layoutLandscape } from "../lib/migrate.ts";
import { Btn, Dot, Empty, Failed, Head, HealthPill, LayerPill, Loading, Notice, Pill, SearchBox, Stat, useTitle } from "./ui.tsx";

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function Landscape({ apis, links, focus }: { apis: EstateApi[]; links: EstateLink[]; focus?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const land = useMemo(() => layoutLandscape(apis, links, Math.max(0, width - 32)), [apis, links, width]);
  const byName = useMemo(() => new Map(apis.map((a) => [a.name, a])), [apis]);
  const active = hover ?? focus ?? null;
  const near = useMemo(() => {
    if (!active) return null;
    const s = new Set<string>([active]);
    for (const e of land.edges) { if (e.from === active) s.add(e.to); if (e.to === active) s.add(e.from); }
    return s;
  }, [active, land.edges]);
  return (
    <div className="mf-mg-land mf-in">
      <div className="mf-mg-land-scroll" ref={ref} tabIndex={0} role="group" aria-label="How the running APIs depend on each other">
        <div className="mf-mg-land-canvas" style={{ width: land.width, height: land.height }}>
          <svg width={land.width} height={land.height} aria-hidden="true">
            <defs>
              <marker id="mf-mg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0.5 L7 4 L0 7.5 z" style={{ fill: "var(--border2)" }} /></marker>
              <marker id="mf-mg-arrow-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0.5 L7 4 L0 7.5 z" style={{ fill: "var(--accent)" }} /></marker>
            </defs>
            {land.edges.map((e) => {
              const on = !!active && (e.from === active || e.to === active);
              const cls = `mf-mg-edge${on ? " mf-mg-edge-on" : active ? " mf-mg-edge-dim" : ""}${e.via !== "http" ? " mf-mg-edge-data" : ""}`;
              return <path key={e.key} d={e.d} className={cls} markerEnd={`url(#${on ? "mf-mg-arrow-on" : "mf-mg-arrow"})`} />;
            })}
          </svg>
          {land.columns.map((c) => <div key={c.title} className="mf-mg-land-col" style={{ left: c.x, width: land.nodeW }}>{c.title}<span className="mf-mg-faint">{c.count}</span></div>)}
          {land.nodes.map((n) => {
            const dim = near && !near.has(n.id);
            const style = { left: n.x, top: n.y, width: n.w, height: n.h };
            const handlers = { onMouseEnter: () => setHover(n.id), onMouseLeave: () => setHover(null), onFocus: () => setHover(n.id), onBlur: () => setHover(null) };
            if (n.kind === "backend") {
              return <div key={n.id} className={`mf-mg-node mf-mg-node-backend${dim ? " mf-mg-node-dim" : ""}`} style={style} title={n.id} {...handlers}><span className="mf-mono mf-mg-node-name">{n.id}</span></div>;
            }
            const a = byName.get(n.id);
            const tone = healthTone(a?.health);
            return (
              <Link key={n.id} to={`/estate/${encodeURIComponent(n.id)}`} className={`mf-mg-node mf-mg-node-${n.layer}${n.id === focus ? " mf-mg-node-on" : ""}${dim ? " mf-mg-node-dim" : ""}`} style={style} title={`${n.id}: ${healthLabel(a?.health)}`} {...handlers}>
                <span className="mf-mono mf-mg-node-name">{n.id}</span>
                <span className="mf-mg-node-meta"><Dot tone={tone} />{healthLabel(a?.health)} · {a?.gateway?.published ? "published" : "internal"}</span>
              </Link>
            );
          })}
        </div>
      </div>
      <div className="mf-mg-legend">
        <span><span className="mf-mg-swatch" style={{ background: "var(--exp)" }} />Experience</span>
        <span><span className="mf-mg-swatch" style={{ background: "var(--proc)" }} />Process</span>
        <span><span className="mf-mg-swatch" style={{ background: "var(--sys)" }} />System</span>
        <span><span className="mf-mg-swatch" style={{ border: "1px dashed var(--border2)", background: "transparent" }} />Backend outside the estate</span>
        <span><svg width="26" height="6" aria-hidden="true"><path d="M0 3 H26" className="mf-mg-edge" /></svg>calls over HTTP</span>
        <span><svg width="26" height="6" aria-hidden="true"><path d="M0 3 H26" className="mf-mg-edge mf-mg-edge-data" /></svg>data store or other protocol</span>
        {land.width <= LAND_MIN_WIDTH && width > 0 && width - 32 < LAND_MIN_WIDTH && <span className="mf-mg-faint">Swipe sideways to see the whole picture</span>}
      </div>
    </div>
  );
}

type Exposure = "" | "published" | "internal";
export function EstateList() {
  useTitle("Estate");
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const q = sp.get("q") ?? "", layer = sp.get("layer") ?? "", exposure = (sp.get("exposure") ?? "") as Exposure, health = sp.get("health") ?? "";
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const [refreshing, setRefreshing] = useState(false);
  const est = useQuery({ queryKey: ["estate"], queryFn: () => api.estate(), refetchInterval: 30000 });
  const apis = est.data?.apis ?? [];
  const links = est.data?.links ?? [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return apis.filter((a) => {
      if (layer && layerKey(a.layer) !== layer) return false;
      if (exposure === "published" && !a.gateway?.published) return false;
      if (exposure === "internal" && a.gateway?.published) return false;
      if (health && txt(a.health) !== health) return false;
      if (!needle) return true;
      return [a.name, a.basePath, a.gateway?.context, a.technology].some((v) => txt(v).toLowerCase().includes(needle));
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [apis, q, layer, exposure, health]);
  const measured = apis.filter((a) => a.metricsAvailable);
  const refresh = async () => {
    setRefreshing(true);
    try { await api.estate(true); await est.refetch(); } catch { /* the list shows the error */ } finally { setRefreshing(false); }
  };
  return (
    <>
      <Head area="Estate" title="Running APIs"
        subtitle="Every API that is live on the cluster: how they depend on each other, whether they are healthy, and what is inside each one."
        actions={<Btn icon={<RefreshCw size={15} aria-hidden="true" />} busy={refreshing} onClick={refresh}>Refresh</Btn>} />
      {est.isLoading ? <Loading rows={3} h={110} /> : est.isError ? <Failed what="The running APIs are not available right now." error={est.error} onRetry={() => est.refetch()} /> : apis.length === 0 ? (
        <Empty title="No running APIs were found" hint="APIs appear here once they are deployed on the cluster." />
      ) : (
        <>
          <div className="mf-mg-stats">
            <Stat label="Running APIs" value={apis.length} note={`${apis.filter((a) => layerKey(a.layer) === "exp").length} experience · ${apis.filter((a) => layerKey(a.layer) === "proc").length} process · ${apis.filter((a) => layerKey(a.layer) === "sys").length} system`} />
            <Stat label="Healthy" value={`${apis.filter((a) => a.health === "healthy").length} of ${apis.length}`} note={apis.some((a) => a.health === "down" || a.health === "degraded") ? "Some need attention" : "All replicas ready"} />
            <Stat label="On the gateway" value={apis.filter((a) => a.gateway?.published).length} note={`${apis.filter((a) => !a.gateway?.published).length} internal only`} />
            <Stat label="Requests, last hour" value={measured.length ? compact(measured.reduce((s, a) => s + num(a.requestsLastHour), 0)) : "Not measured"} note={`Measured for ${measured.length} of ${apis.length} APIs`} />
          </div>
          {(est.data?.notes ?? []).map((n, i) => <Notice key={i} tone="warn">{txt(n)}</Notice>)}
          <section className="mf-mg-stack" style={{ gap: 10 }}>
            <div className="mf-mg-panel-head"><h2 className="mf-mg-h2">How they connect</h2><span className="mf-mg-small mf-mg-muted">Calls flow from left to right. Point at an API to see what it talks to; select it to open it.</span></div>
            <Landscape apis={apis} links={links} />
          </section>
          <section className="mf-mg-stack" style={{ gap: 10 }}>
            <div className="mf-mg-panel-head"><h2 className="mf-mg-h2">All APIs</h2><span className="mf-mg-small mf-mg-muted">{shown.length === apis.length ? `${apis.length} APIs` : `${shown.length} of ${apis.length} APIs`}{est.data?.generatedAt ? ` · read ${ago(est.data.generatedAt)}` : ""}</span></div>
            <div className="mf-mg-toolbar">
              <SearchBox value={q} onChange={(v) => set("q", v)} placeholder="Search by name or address" />
              <select className="mf-mg-input" aria-label="Layer" value={layer} onChange={(e) => set("layer", e.target.value)}>
                <option value="">All layers</option><option value="exp">Experience</option><option value="proc">Process</option><option value="sys">System</option>
              </select>
              <select className="mf-mg-input" aria-label="Exposure" value={exposure} onChange={(e) => set("exposure", e.target.value)}>
                <option value="">Published and internal</option><option value="published">Published on the gateway</option><option value="internal">Internal only</option>
              </select>
              <select className="mf-mg-input" aria-label="Health" value={health} onChange={(e) => set("health", e.target.value)}>
                <option value="">Any health</option><option value="healthy">Healthy</option><option value="degraded">Degraded</option><option value="down">Down</option><option value="unknown">Unknown</option>
              </select>
            </div>
            {shown.length === 0 ? <div className="mf-mg-tablewrap"><Empty title="No API matches these filters" action={<Btn small onClick={() => setSp(new URLSearchParams(), { replace: true })}>Clear filters</Btn>} /></div> : (
              <div className="mf-mg-tablewrap">
                <table className="mf-mg-table">
                  <thead><tr><th>API</th><th>Health</th><th>Replicas</th><th>Reachable</th><th className="mf-mg-num">Requests, 1 h</th><th className="mf-mg-num">Errors, 1 h</th><th>Last deployed</th></tr></thead>
                  <tbody>
                    {shown.map((a) => (
                      <tr key={a.name} className="mf-mg-click" onClick={() => nav(`/estate/${encodeURIComponent(a.name)}`)}>
                        <td className="mf-mg-td-main">
                          <div className="mf-mg-row" style={{ gap: 8 }}>
                            <Link className="mf-mono mf-mg-name" to={`/estate/${encodeURIComponent(a.name)}`} onClick={(e) => e.stopPropagation()}>{a.name}</Link>
                            <LayerPill layer={a.layer} />
                          </div>
                        </td>
                        <td data-label="Health"><span className="mf-mg-row" style={{ gap: 6 }}><HealthPill health={a.health} />{num(a.notMigrated) > 0 && <Pill tone="warn" title="Callers of these operations get the answer: not migrated yet">{num(a.notMigrated)} not migrated</Pill>}</span></td>
                        <td data-label="Replicas"><span className="mf-mono">{num(a.readyReplicas)} / {num(a.replicas)}</span></td>
                        <td data-label="Reachable">{a.gateway?.published ? <Pill tone="accent" title={txt(a.gateway.url)}>Gateway {txt(a.gateway.context)}</Pill> : <Pill title="Only other services on the cluster can call it">Internal</Pill>}</td>
                        <td data-label="Requests, 1 h" className="mf-mg-num">{a.metricsAvailable ? compact(a.requestsLastHour) : <span className="mf-mg-faint" title="This API does not report traffic figures">Not measured</span>}</td>
                        <td data-label="Errors, 1 h" className="mf-mg-num">{a.metricsAvailable ? <span style={num(a.errorsLastHour) > 0 ? { color: "var(--bad)", fontWeight: 700 } : undefined}>{compact(a.errorsLastHour)}</span> : <span className="mf-mg-faint">Not measured</span>}</td>
                        <td data-label="Last deployed"><span title={dateTime(a.lastDeployedAt)}>{ago(a.lastDeployedAt) || "Unknown"}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
