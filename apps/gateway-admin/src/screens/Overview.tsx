import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiClient, rulesClient, type GatewayApi, type InventoryItem } from "../api.ts";
import { Banner, Chip, Section, Tile } from "../components/gw.tsx";
import { ago, fmtInt, txt } from "../lib/text.ts";
import { Card, StatCard, Ring, Skeleton } from "../components/ui.tsx";
import { PageHeader } from "./PageHeader.tsx";

// The operator's view of the live gateway: what is published, its traffic, and what needs action.
// (It used to be built only from the governance check, which covers 0 APIs until a governance
// policy is attached — so it said "Every API is compliant · 0 published" while 11 APIs were live.)

const open = (g: GatewayApi) => g.security.length === 0 || g.operations.some((o) => /^none$/i.test(o.authType));
const unlimited = (g: GatewayApi) => !g.throttling && (g.tiers.length === 0 || g.tiers.every((t) => /^unlimited$/i.test(t)));
const n = (x: number | undefined | null) => (x ?? 0).toLocaleString();

type Attention = { key: string; name: string; what: string; tone: "bad" | "warn"; to: string };

export function Overview() {
  const inv = useQuery({ queryKey: ["inventory"], queryFn: apiClient.inventory, refetchInterval: 60_000 });
  const gw = useQuery({ queryKey: ["gw-summary", "24h"], queryFn: () => apiClient.gwSummary("24h"), refetchInterval: 60_000 });
  const comp = useQuery({ queryKey: ["compliance"], queryFn: apiClient.compliance });
  const wf = useQuery({ queryKey: ["workflows"], queryFn: apiClient.workflows });

  const items: InventoryItem[] = inv.data?.items ?? [];
  const gatewayApis = items.flatMap((i) => i.gateway.map((g) => ({ item: i, g })));
  const seen = new Set<string>();
  const live = gatewayApis.filter(({ g }) => (seen.has(g.id) ? false : (seen.add(g.id), true)));
  const published = live.filter(({ g }) => /published/i.test(g.lifeCycleStatus));
  const openApis = published.filter(({ g }) => open(g));
  const noLimit = published.filter(({ g }) => unlimited(g));
  const unhealthy = items.filter((i) => i.health && (i.health.state === "down" || i.health.state === "degraded"));
  const t = gw.data?.summary?.totals;
  const errors = (t?.clientErrors ?? 0) + (t?.serverErrors ?? 0) + (t?.faults ?? 0);
  const pending = (wf.data?.types ?? []).reduce((s, x) => s + x.pending, 0);
  const c = comp.data;

  const attention: Attention[] = [
    ...unhealthy.map((i) => ({ key: `h:${i.id}`, name: i.name, what: `service ${i.health?.state} (${i.health?.ready ?? 0}/${i.health?.desired ?? 0} ready)`, tone: "bad" as const, to: "/apis" })),
    ...openApis.map(({ g }) => ({ key: `o:${g.id}`, name: `${g.name} ${g.version}`, what: "open: no sign-in or key required", tone: "bad" as const, to: `/apis/${g.id}?tab=access` })),
    ...noLimit.map(({ g }) => ({ key: `l:${g.id}`, name: `${g.name} ${g.version}`, what: "no rate limit", tone: "warn" as const, to: `/apis/${g.id}?tab=traffic` })),
  ];

  const title = inv.isLoading ? "Loading overview"
    : `${published.length} API${published.length === 1 ? "" : "s"} live on the gateway`;
  const subtitle = inv.data && <>
    {n(inv.data.summary.services)} services running{unhealthy.length ? <>, <strong style={{ color: "var(--bad)" }}>{unhealthy.length} unhealthy</strong></> : ""}
    {t ? <> · {n(t.requests)} requests in the last 24 hours</> : null}
  </>;

  return (
    <>
      <PageHeader area="Overview" title={title} subtitle={subtitle}
        actions={<Link to="/apis" className="mf-btn mf-pri" style={{ display: "inline-flex", alignItems: "center", height: 42, padding: "0 18px", borderRadius: 10, background: "var(--accent)", color: "var(--onAccent)", fontWeight: 600, textDecoration: "none" }}>Open APIs</Link>} />

      {inv.isLoading ? <Skeleton h={110} /> : (
        <section aria-label="Summary" data-testid="overview-cards" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14 }}>
          <StatCard label="APIs on the gateway" value={published.length} suffix={`published${live.length > published.length ? ` · ${live.length - published.length} not published` : ""}`} />
          <StatCard label="Requests, 24 h" value={n(t?.requests)} suffix={`${n(t?.throttled)} throttled`}
            status={!t ? undefined : (t.throttled ?? 0) > 0 ? { word: "LIMITS ACTIVE", color: "var(--warn)" } : { word: "NO THROTTLING", color: "var(--muted)" }} />
          <StatCard label="Errors, 24 h" value={n(errors)} suffix={t && t.requests ? `${((errors / t.requests) * 100).toFixed(1)}% of requests` : "requests"}
            status={!t ? undefined : errors > 0 ? { word: "CHECK", color: "var(--warn)" } : { word: "CLEAN", color: "var(--ok)" }} />
          <StatCard label="Open APIs" value={openApis.length} suffix="without sign-in or key"
            status={openApis.length ? { word: "SECURE THEM", color: "var(--bad)" } : { word: "ALL SECURED", color: "var(--ok)" }} />
          <StatCard label="Pending approvals" value={pending} suffix="tasks" status={pending === 0 ? { word: "ALL CLEAR", color: "var(--ok)" } : { word: "WAITING", color: "var(--warn)" }} />
        </section>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "stretch" }}>
        <Card delay={300} style={{ flex: "2 1 520px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Needs attention</h2>
            <Link to="/apis" style={{ fontSize: 13, fontWeight: 600, color: "var(--accentText)", textDecoration: "none" }}>Open APIs →</Link>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }} data-testid="overview-attention">
            {inv.isError && <p style={{ color: "var(--bad)" }}>The API list could not be read from the gateway right now.</p>}
            {!inv.isLoading && !inv.isError && attention.length === 0 && <p style={{ color: "var(--faint)" }}>Nothing needs attention: every published API is secured and limited, and every service is healthy.</p>}
            {attention.slice(0, 12).map((a) => (
              <Link key={a.key} to={a.to} className="mf-row" style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 10px", borderRadius: 10, borderTop: "1px solid var(--border)", textDecoration: "none", color: "var(--text)" }}>
                <span className="mf-mono" style={{ fontSize: 13.5, flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{a.name}</span>
                <span style={{ padding: "3px 9px", borderRadius: 999, fontSize: 12, fontWeight: 700, color: a.tone === "bad" ? "var(--bad)" : "var(--warn)", background: a.tone === "bad" ? "var(--badSoft)" : "var(--warnSoft)" }}>{a.what}</span>
              </Link>
            ))}
            {attention.length > 12 && <p style={{ color: "var(--faint)", margin: "8px 10px 0" }}>and {attention.length - 12} more on the APIs page.</p>}
          </div>
        </Card>
        <Card delay={360} style={{ flex: "1 1 280px", display: "flex", flexDirection: "column", gap: 14, alignItems: "center", justifyContent: "center", textAlign: "center" }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, alignSelf: "flex-start" }}>Governance</h2>
          {comp.isLoading ? <Skeleton h={120} /> : !c || c.governed === 0 ? (
            <p data-testid="overview-governance" style={{ margin: 0, color: "var(--muted)", lineHeight: 1.5 }}>
              Not checked yet: no governance policy is attached to any API, so nothing has been checked.
              <br /><Link to="/compliance" style={{ color: "var(--accentText)", fontWeight: 600 }}>Attach a policy</Link>
            </p>
          ) : (<>
            <Ring pct={c.apiCompliancePct ?? 0} color={(c.apiCompliancePct ?? 0) >= 100 ? "var(--ok)" : "var(--bad)"} label="compliant" />
            <span style={{ fontSize: 13, color: "var(--muted)" }}>{c.compliant} of {c.total} checked APIs pass · {c.errors} errors · {c.warnings} warnings</span>
          </>)}
        </Card>
      </div>
      <OperatorSignals />
    </>
  );
}

/** Right-now signals from the rules endpoints: live per environment, throttled/refused in the last 15 minutes, blocking rules, recent changes. */
function OperatorSignals() {
  const q = useQuery({ queryKey: ["signals"], queryFn: rulesClient.overview, refetchInterval: 30000 });
  const d = q.data;
  if (q.isLoading) return <Skeleton h={120} />;
  if (q.isError || !d) return <Banner tone="warn">The live gateway signals could not be read: {(q.error as Error)?.message ?? "unknown error"}</Banner>;
  const envs = Object.entries(d.environments);
  const liveTotal = envs.reduce((s, [, e]) => s + e.live, 0);
  const t = d.traffic;
  return (
    <>
      <div className="gw-tiles" aria-label="Right now">
        <Tile label="Live deployments" value={fmtInt(liveTotal)} hint={envs.length ? envs.map(([name, e]) => `${e.live} on ${name}`).join(" · ") : "Nothing deployed"} />
        <Tile label="Throttled now" value={t ? fmtInt(t.throttled) : "—"} hint={t ? "HTTP 429 in the last 15 minutes" : "Not measured (gateway analytics inactive)"} />
        <Tile label="Refused now" value={t ? fmtInt(t.refused) : "—"} hint={t ? "HTTP 401/403 in the last 15 minutes" : "Not measured"} />
        <Tile label="Blocking rules" value={d.blocking ? fmtInt(d.blocking.active) : "—"} hint={d.blocking ? `enforced, of ${d.blocking.total}` : "Could not be read"} />
      </div>
      <div className="gw-grid2">
        <Section title="Live per environment" note={`${d.published} of ${d.total} APIs are published in API Manager (migrated services, Studio flows and APIs made directly in API Manager).`}>
          {envs.length ? envs.map(([name, e]) => (
            <div key={name} style={{ marginBottom: 10 }}>
              <strong style={{ fontSize: 13.5 }}>{name}</strong> <span className="gw-muted">· {e.live} API{e.live === 1 ? "" : "s"}</span>
              <div className="gw-muted" style={{ fontSize: 12.5, lineHeight: 1.6, overflowWrap: "anywhere" }}>{e.apis.join(", ")}</div>
            </div>)) : <p className="gw-note" style={{ margin: 0 }}>No API is deployed to a gateway.</p>}
          {d.notDeployed.length > 0 && <p className="gw-note" style={{ margin: "6px 0 0" }}>Published but not deployed (callers get 404): {d.notDeployed.map((a, i) => <span key={a.id}>{i ? ", " : ""}<Link className="gw-link" to={`/apis/${a.id}?tab=history`}>{a.name}</Link></span>)}</p>}
          {t && t.topThrottled.length > 0 && <p className="gw-note" style={{ margin: "6px 0 0" }}>Throttling most (15 min): {t.topThrottled.map((x) => `${x.name} ${fmtInt(x.throttled)}`).join(", ")}</p>}
        </Section>
        <Section title="Recent changes" note="Changes made from this console, newest first. Changes made directly in API Manager show without a name.">
          {d.recent.length ? (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column" }} aria-label="Recent changes list">
              {d.recent.map((r, i) => (
                <li key={i} style={{ padding: "8px 0", borderTop: i ? "1px solid var(--border)" : "none", fontSize: 13, lineHeight: 1.5 }}>
                  <strong>{r.by ?? "API Manager"}</strong> · {r.action}{r.apiName ? <> · {r.apiId ? <Link className="gw-link" to={`/apis/${r.apiId}?tab=history`}>{r.apiName}</Link> : r.apiName}</> : null} · <span className="gw-faint">{Number.isFinite(Date.parse(r.at)) ? ago(Date.parse(r.at)) : txt(r.at)}</span> {r.outcome === "failed" && <Chip tone="bad">failed</Chip>}
                  {r.what && <div className="gw-muted" style={{ overflowWrap: "anywhere" }}>{r.what}</div>}
                </li>
              ))}
            </ul>
          ) : <p className="gw-note" style={{ margin: 0 }}>No changes recorded yet.</p>}
        </Section>
      </div>
    </>
  );
}
