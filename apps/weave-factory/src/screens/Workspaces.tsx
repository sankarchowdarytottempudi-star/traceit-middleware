import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import { Card, Skeleton, ErrorState, EmptyState } from "../components/ui.tsx";
import { PageHeader } from "./PageHeader.tsx";

const TIERS = ["dev", "qa", "uat", "prod"] as const;

export function Workspaces() {
  const q = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const ws = q.data?.workspaces ?? [];
  return (
    <>
      <PageHeader area="Workspaces" title="Workspaces" subtitle="Each workspace targets its own Dev, QA, UAT and Prod servers. Migrations deploy to these, never to the POC." />
      {q.isLoading ? <Skeleton h={120} /> : q.isError ? <ErrorState message="Could not load workspaces" onRetry={() => q.refetch()} /> :
        ws.length === 0 ? <EmptyState title="No workspaces configured" /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
          {ws.map((w, i) => (
            <Card key={w.id ?? w.name ?? i} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <strong style={{ fontSize: 15 }}>{w.name}</strong>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {TIERS.map((t) => {
                  const s = w.servers?.[t];
                  return (
                    <div key={t} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                      <span style={{ textTransform: "uppercase", color: "var(--faint)", letterSpacing: "0.06em" }}>{t}</span>
                      <span className="mf-mono" style={{ color: s?.host ? "var(--text)" : "var(--faint)" }}>{s?.host ? `${s.host}${s.port ? ":" + s.port : ""}` : "—"}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
