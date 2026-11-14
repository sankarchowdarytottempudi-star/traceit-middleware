import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient, type MigratedApi } from "../api.ts";
import { Drawer, Skeleton, ErrorState, EmptyState, StatusWord } from "../components/ui.tsx";
import { PageHeader } from "./PageHeader.tsx";

export function MigratedApis() {
  const [sel, setSel] = useState<MigratedApi | null>(null);
  const q = useQuery({ queryKey: ["apis"], queryFn: apiClient.apis });
  const apis = q.data?.list ?? [];
  return (
    <>
      <PageHeader area="Migrated APIs" title="Migrated APIs" subtitle="APIs migrated and published on this gateway. Open one to see its definition." />
      {q.isLoading ? <Skeleton h={160} /> : q.isError ? <ErrorState message="Could not load APIs" onRetry={() => q.refetch()} /> :
        apis.length === 0 ? <EmptyState title="No APIs published yet" /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
          {apis.map((a) => (
            <button key={a.id} className="mf-api mf-s mf-card" onClick={() => setSel(a)} style={{ padding: 18, borderRadius: 14, border: "1px solid var(--border)", background: "var(--surface)", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="mf-mono" style={{ fontSize: 14 }}>{a.name}</span>
                <StatusWord word={a.lifeCycleStatus} color={a.lifeCycleStatus === "PUBLISHED" ? "var(--ok)" : "var(--muted)"} />
              </div>
              <span style={{ fontSize: 12.5, color: "var(--faint)" }}>{a.context}/{a.version} · {a.operations.length} operations</span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {a.securityScheme.map((s) => <span key={s} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "var(--sysSoft)", color: "var(--sys)" }}>{s}</span>)}
                {a.throttlingPolicy && <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "var(--accentSoft)", color: "var(--accentText)" }}>{a.throttlingPolicy}</span>}
              </div>
            </button>
          ))}
        </div>
      )}

      <Drawer open={!!sel} title={sel?.name ?? ""} onClose={() => setSel(null)}>
        {sel && <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--faint)" }}>Gateway path</span>
            <code className="mf-mono" style={{ fontSize: 13 }}>{sel.context}/{sel.version}</code>
          </div>
          {sel.backend && <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><span style={{ fontSize: 12, color: "var(--faint)" }}>Backend</span><code className="mf-mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>{sel.backend}</code></div>}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {sel.securityScheme.map((s) => <span key={s} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "var(--sysSoft)", color: "var(--sys)" }}>{s}</span>)}
            {sel.throttlingPolicy && <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "var(--accentSoft)", color: "var(--accentText)" }}>rate: {sel.throttlingPolicy}</span>}
          </div>
          <h3 style={{ margin: "6px 0 0", fontSize: 14 }}>Operations</h3>
          <div style={{ borderRadius: 10, border: "1px solid var(--border)", overflow: "hidden" }}>
            {sel.operations.map((o, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 12px", borderTop: i ? "1px solid var(--border)" : "none", background: "var(--surface2)" }}>
                <span className="mf-mono" style={{ fontSize: 11, fontWeight: 700, width: 54, color: "var(--accentText)" }}>{o.verb}</span>
                <span className="mf-mono" style={{ fontSize: 12.5, flex: 1 }}>{o.target}</span>
                <span style={{ fontSize: 11, color: o.authType === "None" ? "var(--warn)" : "var(--faint)" }}>{o.authType}</span>
              </div>
            ))}
          </div>
        </div>}
      </Drawer>
    </>
  );
}
