// Gateway-wide settings, read-only: TLS versions the gateway really accepts (probed), certificates
// with days left, and the server-file changes for settings no REST API can change.
import { useQuery } from "@tanstack/react-query";
import { rulesClient, type TlsProbe } from "../api.ts";
import { ErrorState } from "../components/ui.tsx";
import { Banner, Chip, Loading, Section } from "../components/gw.tsx";
import { PageHeader } from "./PageHeader.tsx";

function Probe({ title, p }: { title: string; p: TlsProbe | null }) {
  if (!p) return <Section title={title}><p className="gw-note" style={{ margin: 0 }}>Could not be reached from the console.</p></Section>;
  const old = p.versions.filter((v) => v.accepted && (v.version === "TLSv1" || v.version === "TLSv1.1"));
  return (
    <Section title={title} note={`Probed just now with real handshakes on ${p.host}.`}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} aria-label={`${title} TLS versions`}>
        {p.versions.map((v) => <Chip key={v.version} tone={v.accepted ? ((v.version === "TLSv1" || v.version === "TLSv1.1") ? "bad" : "ok") : "plain"}>{v.version.replace("TLSv", "TLS ")}: {v.accepted ? `accepted${v.cipher ? ` (${v.cipher})` : ""}` : "refused"}</Chip>)}
      </div>
      {old.length > 0 && <div style={{ marginTop: 8 }}><Banner tone="bad">Outdated TLS versions are accepted. Turn them off with the server change below.</Banner></div>}
      {!p.versions.find((v) => v.version === "TLSv1.3")?.accepted && <p className="gw-note" style={{ margin: "8px 0 0" }}>TLS 1.3 is not offered. It can be added with the server change below.</p>}
      {p.certificate && <dl className="gw-kv" style={{ marginTop: 10 }}><dt>Certificate</dt><dd>{p.certificate.subject} (issued by {p.certificate.issuer})</dd><dt>Expires</dt>
        <dd style={{ color: p.certificate.daysLeft < 30 ? "var(--bad)" : p.certificate.daysLeft < 90 ? "var(--warn)" : undefined }}>{new Date(p.certificate.validTo).toLocaleDateString()} · {p.certificate.daysLeft} days left{p.certificate.subject === p.certificate.issuer ? " · self-signed" : ""}</dd></dl>}
    </Section>
  );
}

export function GatewaySettings() {
  const q = useQuery({ queryKey: ["gw-settings"], queryFn: rulesClient.settings });
  const d = q.data;
  return (
    <>
      <PageHeader area="Gateway settings" title="Gateway settings" subtitle="Settings that apply to every API. What the console can read is shown live; what lives in API Manager's server files is shown with the exact change to make. Nothing here restarts API Manager." />
      {q.isLoading ? <Loading tiles={0} blocks={2} /> : q.isError || !d ? <ErrorState message={(q.error as Error)?.message ?? "Could not load the settings"} onRetry={() => q.refetch()} /> : (
        <>
          <div className="gw-grid2"><Probe title="Gateway (API traffic)" p={d.gateway} /><Probe title="API Manager (portals and REST)" p={d.manager} /></div>
          <Section title="Backend certificates" note="Certificates API Manager trusts for calls to backends (Publisher → Endpoints → certificates).">
            {d.backend === null ? <p className="gw-note" style={{ margin: 0 }}>Could not be read.</p> : d.backend.length === 0 ? <p className="gw-note" style={{ margin: 0 }}>None uploaded: backends are called with the default trust store.</p> :
              d.backend.map((c) => <div key={c.alias} style={{ fontSize: 13, padding: "4px 0" }}><strong>{c.alias}</strong> · {c.endpoint} · {c.daysLeft == null ? "expiry unknown" : <span style={{ color: c.daysLeft < 30 ? "var(--bad)" : undefined }}>{c.daysLeft} days left</span>}</div>)}
          </Section>
          <Section title="Needs a server change" note="These cannot be changed through API Manager's REST APIs. An administrator edits the file shown and restarts API Manager in a maintenance window.">
            {d.serverChanges.map((c) => (
              <div key={c.id} style={{ padding: "10px 0", borderTop: "1px solid var(--border)" }} data-setting={c.id}>
                <strong style={{ fontSize: 13.5 }}>{c.title}</strong> <Chip tone="warn">needs a server change</Chip>
                <div className="gw-faint" style={{ fontSize: 12 }}>{c.file}{c.restart ? " · restart required" : ""}</div>
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, background: "var(--surface2)", padding: 10, borderRadius: 8, margin: "6px 0 0", overflowWrap: "anywhere" }}>{c.change}</pre>
              </div>))}
          </Section>
        </>
      )}
    </>
  );
}
