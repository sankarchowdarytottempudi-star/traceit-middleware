import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient, type ApiCompliance } from "../api.ts";
import { rankApis, severityTotals } from "../lib/format.ts";
import { Card, Ring, Drawer, Skeleton, ErrorState, SegTabs } from "../components/ui.tsx";
import { PageHeader } from "./PageHeader.tsx";

export function Compliance() {
  const [sort, setSort] = useState<"findings" | "name">("findings");
  const [sel, setSel] = useState<ApiCompliance | null>(null);
  const q = useQuery({ queryKey: ["compliance"], queryFn: apiClient.compliance });
  const detail = useQuery({ queryKey: ["compliance", sel?.apiId], queryFn: () => apiClient.complianceApi(sel!.apiId), enabled: !!sel });
  const c = q.data;
  const apis = c ? (sort === "findings" ? rankApis(c.apis) : [...c.apis].sort((a, b) => a.name.localeCompare(b.name))) : [];
  const tot = c ? severityTotals(c.apis) : { errors: 0, warnings: 0, info: 0 };
  const maxSev = Math.max(1, tot.errors, tot.warnings, tot.info);

  return (
    <>
      <PageHeader area="Compliance" title="Governance compliance" subtitle="APIs checked against the active governance policy." />
      {q.isLoading ? <Skeleton h={180} /> : q.isError ? <ErrorState message="Could not load compliance" onRetry={() => q.refetch()} /> : (
      <>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
          <Card style={{ flex: "1 1 220px", alignItems: "center", display: "flex", flexDirection: "column", gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16, alignSelf: "flex-start" }}>Policy adherence</h2>
            <Ring pct={c?.policyAdherencePct ?? 0} color={(c?.policyAdherencePct ?? 0) >= 100 ? "var(--ok)" : "var(--warn)"} label="rules" />
          </Card>
          <Card style={{ flex: "1 1 220px", alignItems: "center", display: "flex", flexDirection: "column", gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16, alignSelf: "flex-start" }}>API compliance</h2>
            <Ring pct={c?.apiCompliancePct ?? 0} color={(c?.apiCompliancePct ?? 0) >= 100 ? "var(--ok)" : "var(--bad)"} label="compliant" />
          </Card>
          <Card style={{ flex: "2 1 320px", display: "flex", flexDirection: "column", gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>Findings by severity</h2>
            {([["Errors", tot.errors, "var(--bad)"], ["Warnings", tot.warnings, "var(--warn)"], ["Info", tot.info, "var(--muted)"]] as const).map(([lbl, n, col]) => (
              <div key={lbl} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ width: 70, fontSize: 13, color: "var(--muted)" }}>{lbl}</span>
                <span style={{ flex: 1, height: 10, borderRadius: 999, background: "var(--surface3)", overflow: "hidden" }}><span className="mf-bar" style={{ display: "block", height: "100%", width: `${(n / maxSev) * 100}%`, background: col }} /></span>
                <span style={{ width: 36, textAlign: "right", fontWeight: 700 }}>{n}</span>
              </div>
            ))}
          </Card>
        </div>

        <Card style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>APIs</h2>
            <SegTabs tabs={[{ id: "findings", label: "Most findings" }, { id: "name", label: "Name" }]} value={sort} onChange={setSort} />
          </div>
          <div className="gw-tablewrap"><table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ textAlign: "left", color: "var(--faint)", fontSize: 12 }}><th style={{ padding: "8px 6px" }}>API</th><th>Errors</th><th>Warnings</th><th></th></tr></thead>
            <tbody>
              {apis.map((a) => (
                <tr key={a.apiId} className="mf-row" style={{ cursor: "pointer" }} onClick={() => setSel(a)}>
                  <td style={{ padding: "12px 6px", overflowWrap: "anywhere" }}><span className="mf-mono" style={{ fontSize: 13.5 }}>{a.name}</span> <span style={{ color: "var(--faint)", fontSize: 12 }}>{a.version}</span></td>
                  <td style={{ color: a.errors ? "var(--bad)" : "var(--faint)", fontWeight: 700 }}>{a.errors}</td>
                  <td style={{ color: "var(--warn)", fontWeight: 700 }}>{a.warnings}</td>
                  <td style={{ textAlign: "right", color: "var(--accentText)", fontSize: 13, whiteSpace: "nowrap" }}>View →</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      </>)}

      <Drawer open={!!sel} title={sel?.name ?? ""} onClose={() => setSel(null)}>
        {sel && <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 10 }}>
            <span style={{ padding: "4px 10px", borderRadius: 8, background: "var(--badSoft)", color: "var(--bad)", fontWeight: 700 }}>{sel.errors} errors</span>
            <span style={{ padding: "4px 10px", borderRadius: 8, background: "var(--warnSoft)", color: "var(--warn)", fontWeight: 700 }}>{sel.warnings} warnings</span>
          </div>
          <p style={{ color: "var(--muted)", fontSize: 13 }}>{sel.errors > 0 ? `Fix the ${sel.errors} errors first; they block compliance.` : "No blocking errors."} Policy: {sel.policy}.</p>
          <a className="mf-btn mf-gho" href={`/publisher/apis/${sel.apiId}/overview`} style={{ alignSelf: "flex-start", height: 36, display: "inline-flex", alignItems: "center", padding: "0 14px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface)", textDecoration: "none", color: "var(--text)", fontSize: 13 }}>Open in Publisher ↗</a>
          <h3 style={{ margin: "6px 0 0", fontSize: 14 }}>Rule violations</h3>
          {detail.isLoading ? <Skeleton h={80} /> : (detail.data?.violations ?? []).length === 0 ? <p style={{ color: "var(--faint)" }}>No violations reported.</p> :
            (detail.data?.violations ?? []).map((v, i) => (
              <div key={i} style={{ padding: 12, borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface2)" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}><strong style={{ fontSize: 13 }}>{v.ruleName}</strong><span style={{ fontSize: 11, fontWeight: 700, color: v.severity === "ERROR" ? "var(--bad)" : v.severity === "WARN" ? "var(--warn)" : "var(--muted)" }}>{v.severity}</span></div>
                <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--muted)" }}>{v.message}</p>
                {v.path && <code className="mf-mono" style={{ fontSize: 11, color: "var(--faint)" }}>{v.path}</code>}
              </div>
            ))}
        </div>}
      </Drawer>
    </>
  );
}
