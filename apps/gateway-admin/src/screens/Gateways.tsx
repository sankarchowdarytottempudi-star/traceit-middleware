import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api.ts";
import { isLocalhost } from "../lib/format.ts";
import { Card, Skeleton, ErrorState, EmptyState, StatusWord } from "../components/ui.tsx";
import { PageHeader } from "./PageHeader.tsx";

export function Gateways() {
  const envs = useQuery({ queryKey: ["environments"], queryFn: apiClient.environments });
  const kms = useQuery({ queryKey: ["key-managers"], queryFn: apiClient.keyManagers });
  return (
    <>
      <PageHeader area="Gateways" title="Gateways & key managers" subtitle="Gateway environments and the identity providers that issue tokens." />
      <h2 style={{ margin: 0, fontSize: 16 }}>Gateway environments</h2>
      {envs.isLoading ? <Skeleton h={120} /> : envs.isError ? <ErrorState message="Could not load environments" onRetry={() => envs.refetch()} /> :
        (envs.data?.list ?? []).length === 0 ? <EmptyState title="No gateway environments" /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
          {envs.data!.list.map((e) => {
            const bad = e.vhosts.some((v) => isLocalhost(v.host));
            return (
              <Card key={e.id} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: 15 }}>{e.name}</strong>
                  <StatusWord word={bad ? "WATCH" : "REACHABLE"} color={bad ? "var(--warn)" : "var(--ok)"} />
                </div>
                <span style={{ fontSize: 12.5, color: "var(--faint)" }}>{e.gatewayType} · {e.type} · {e.visibility}</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {e.vhosts.map((v, i) => <span key={i} className="mf-mono" style={{ fontSize: 12, color: isLocalhost(v.host) ? "var(--warn)" : "var(--muted)" }}>{v.host}</span>)}
                </div>
                {bad && <p role="note" style={{ margin: 0, fontSize: 12.5, padding: 10, borderRadius: 9, background: "var(--warnSoft)", color: "var(--warn)" }}>A virtual host points at localhost, so consumers cannot reach it. Fix the virtual host before publishing.</p>}
              </Card>
            );
          })}
        </div>
      )}
      <h2 style={{ margin: "8px 0 0", fontSize: 16 }}>Key managers</h2>
      {kms.isLoading ? <Skeleton h={90} /> : (kms.data?.list ?? []).length === 0 ? <EmptyState title="No key managers" /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
          {kms.data!.list.map((k) => (
            <Card key={k.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ display: "flex", flexDirection: "column" }}><strong style={{ fontSize: 14 }}>{k.name}</strong><span style={{ fontSize: 12, color: "var(--faint)" }}>{k.type}</span></span>
              <StatusWord word={k.enabled ? "ACTIVE" : "DISABLED"} color={k.enabled ? "var(--ok)" : "var(--faint)"} />
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
