// Operator signals: what is live where, what is being throttled or refused right now, which APIs are
// open without sign-in, and what changed recently.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { rulesClient } from "../api.ts";
import { ErrorState } from "../components/ui.tsx";
import { Banner, Chip, Loading, Section, Tile } from "../components/gw.tsx";
import { PageHeader } from "./PageHeader.tsx";
import { ago, fmtInt, txt } from "../lib/text.ts";

export function Overview() {
  const q = useQuery({ queryKey: ["signals"], queryFn: rulesClient.overview, refetchInterval: 30000 });
  const d = q.data;
  const envs = d ? Object.entries(d.environments) : [];
  const liveTotal = envs.reduce((n, [, e]) => n + e.live, 0);
  const openLive = d ? d.open.filter((o) => o.live) : [];
  const t = d?.traffic;
  const title = !d ? "Gateway overview" : openLive.length ? `${openLive.length} live API${openLive.length === 1 ? " has" : "s have"} no sign-in`
    : t && t.throttled > 0 ? `${fmtInt(t.throttled)} requests throttled in the last 15 minutes` : `${liveTotal} API deployment${liveTotal === 1 ? "" : "s"} live`;
  return (
    <>
      <PageHeader area="Overview" title={title} subtitle={d ? <>What is live on the gateway right now ({d.stageWord}), what callers are being refused, and what changed recently.</> : undefined}
        actions={<Link to="/apis" className="gw-btn gw-btn-pri" style={{ height: 42, padding: "0 18px" }}>Manage APIs</Link>} />
      {q.isLoading ? <Loading tiles={4} blocks={2} /> : q.isError || !d ? <ErrorState message={(q.error as Error)?.message ?? "Could not load the overview"} onRetry={() => q.refetch()} /> : (
        <>
          {d.via === "service" && <Banner tone="info">Counted with the console's service account because your own sign-in sees no APIs.</Banner>}
          <div className="gw-tiles" aria-label="Signals">
            <Tile label="Live APIs" value={fmtInt(liveTotal)} hint={envs.length ? envs.map(([n, e]) => `${e.live} on ${n}`).join(" · ") : "Nothing deployed"} />
            <Tile label="Throttled now" value={t ? fmtInt(t.throttled) : "—"} hint={t ? "HTTP 429 in the last 15 minutes" : "Not measured (gateway analytics inactive)"} />
            <Tile label="Refused now" value={t ? fmtInt(t.refused) : "—"} hint={t ? "HTTP 401/403 in the last 15 minutes" : "Not measured"} />
            <Tile label="Without sign-in" value={fmtInt(d.open.length)} hint={d.open.length ? `${openLive.length} of them live` : "Every API requires sign-in"} />
            <Tile label="Blocking rules" value={d.blocking ? fmtInt(d.blocking.active) : "—"} hint={d.blocking ? `enforced, of ${d.blocking.total}` : "Could not be read"} />
          </div>
          {openLive.length > 0 && <Banner tone={d.stage === "production" ? "bad" : "warn"}>Open without sign-in: {openLive.map((o, i) => <span key={o.id}>{i ? ", " : ""}<Link className="gw-link" to={`/apis/${o.id}?tab=access`}>{o.name}</Link></span>)}. Anyone who can reach the gateway can call {openLive.length === 1 ? "it" : "them"}.</Banner>}
          <div className="gw-grid2">
            <Section title="Live per environment" note={`${d.published} of ${d.total} APIs are published in API Manager.`}>
              {envs.length ? envs.map(([n, e]) => (
                <div key={n} style={{ marginBottom: 10 }}>
                  <strong style={{ fontSize: 13.5 }}>{n}</strong> <span className="gw-muted">· {e.live} API{e.live === 1 ? "" : "s"}</span>
                  <div className="gw-muted" style={{ fontSize: 12.5, lineHeight: 1.6, overflowWrap: "anywhere" }}>{e.apis.join(", ")}</div>
                </div>)) : <p className="gw-note" style={{ margin: 0 }}>No API is deployed to a gateway.</p>}
              {d.notDeployed.length > 0 && <p className="gw-note" style={{ margin: "6px 0 0" }}>Published but not deployed (callers get 404): {d.notDeployed.map((a, i) => <span key={a.id}>{i ? ", " : ""}<Link className="gw-link" to={`/apis/${a.id}?tab=history`}>{a.name}</Link></span>)}</p>}
            </Section>
            <Section title="Throttled most (15 min)" note={t ? `${fmtInt(t.requests)} requests, ${fmtInt(t.errors)} server errors or faults.` : "Gateway analytics is not active, so traffic is unknown."}>
              {t && t.topThrottled.length ? t.topThrottled.map((x) => <div key={x.name} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "4px 0" }}><span className="gw-mono">{x.name}</span><strong>{fmtInt(x.throttled)}</strong></div>)
                : <p className="gw-note" style={{ margin: 0 }}>{t ? "No API is throttling callers right now." : "—"}</p>}
            </Section>
          </div>
          <Section title="Recent changes" note="Changes made from this console, newest first. Changes made directly in API Manager show without a name.">
            {d.recent.length ? (
              <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column" }} aria-label="Recent changes">
                {d.recent.map((r, i) => (
                  <li key={i} style={{ padding: "10px 0", borderTop: i ? "1px solid var(--border)" : "none", fontSize: 13, lineHeight: 1.5 }}>
                    <strong>{r.by ?? "API Manager"}</strong> · {r.action}{r.apiName ? <> · {r.apiId ? <Link className="gw-link" to={`/apis/${r.apiId}?tab=history`}>{r.apiName}</Link> : r.apiName}</> : null} · <span className="gw-faint">{Number.isFinite(Date.parse(r.at)) ? ago(Date.parse(r.at)) : txt(r.at)}</span> {r.outcome === "failed" && <Chip tone="bad">failed</Chip>}
                    {r.what && <div className="gw-muted" style={{ overflowWrap: "anywhere" }}>{r.what}</div>}
                  </li>
                ))}
              </ul>
            ) : <p className="gw-note" style={{ margin: 0 }}>No changes recorded yet.</p>}
          </Section>
        </>
      )}
    </>
  );
}
