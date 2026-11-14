import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiClient } from "../api.ts";
import { rankApis } from "../lib/format.ts";
import { Card, StatCard, Ring, useCountUp, Skeleton } from "../components/ui.tsx";
import { PageHeader } from "./PageHeader.tsx";

export function Overview() {
  const comp = useQuery({ queryKey: ["compliance"], queryFn: apiClient.compliance });
  const wf = useQuery({ queryKey: ["workflows"], queryFn: apiClient.workflows });
  const c = comp.data;
  const governed = useCountUp(c?.governed ?? 0);
  const errors = useCountUp(c?.errors ?? 0);
  const warnings = useCountUp(c?.warnings ?? 0);
  const pending = (wf.data?.types ?? []).reduce((n, t) => n + t.pending, 0);
  const atRisk = c ? c.total - c.compliant : 0;
  const ranked = c ? rankApis(c.apis).slice(0, 6) : [];

  return (
    <>
      <PageHeader area="Overview"
        title={!c ? "Loading overview" : atRisk > 0 ? `${atRisk} APIs need governance attention` : "Every API is compliant"}
        subtitle={c && (atRisk > 0
          ? <>APIs are checked against the <strong style={{ color: "var(--text)" }}>WSO2 API Management Best Practices</strong> policy.</>
          : "All published APIs pass the governance policy.")}
        actions={<Link to="/compliance" className="mf-btn mf-pri" style={{ display: "inline-flex", alignItems: "center", height: 42, padding: "0 18px", borderRadius: 10, background: "var(--accent)", color: "var(--onAccent)", fontWeight: 600, textDecoration: "none" }}>Review compliance</Link>} />

      {comp.isLoading ? <Skeleton h={110} /> : (
        <section aria-label="Summary" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14 }}>
          <StatCard label="APIs governed" value={governed} suffix="published" />
          <StatCard label="Compliant" value={c?.compliant ?? 0} suffix={`of ${c?.total ?? 0} APIs`} status={atRisk > 0 ? { word: "AT RISK", color: "var(--bad)" } : { word: "HEALTHY", color: "var(--ok)" }} />
          <StatCard label="Rule findings" value={errors} suffix={`errors · ${warnings} warnings`} />
          <StatCard label="Pending approvals" value={pending} suffix="tasks" status={pending === 0 ? { word: "ALL CLEAR", color: "var(--ok)" } : { word: "WAITING", color: "var(--warn)" }} />
        </section>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "stretch" }}>
        <Card delay={300} style={{ flex: "2 1 520px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Needs attention</h2>
            <Link to="/compliance" style={{ fontSize: 13, fontWeight: 600, color: "var(--accentText)", textDecoration: "none" }}>Open compliance →</Link>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {ranked.length === 0 && <p style={{ color: "var(--faint)" }}>Nothing needs attention.</p>}
            {ranked.map((a) => (
              <Link key={a.apiId} to="/compliance" className="mf-row" style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 10px", borderRadius: 10, borderTop: "1px solid var(--border)", textDecoration: "none", color: "var(--text)" }}>
                <span style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 }}>
                  <span className="mf-mono" style={{ fontSize: 13.5 }}>{a.name}</span>
                  <span style={{ fontSize: 12, color: "var(--faint)" }}>{a.version} · {a.policy}</span>
                </span>
                <span style={{ padding: "3px 9px", borderRadius: 999, fontSize: 12, fontWeight: 700, color: a.errors > 0 ? "var(--bad)" : "var(--muted)", background: a.errors > 0 ? "var(--badSoft)" : "var(--surface3)" }}>{a.errors} errors</span>
                <span style={{ padding: "3px 9px", borderRadius: 999, fontSize: 12, fontWeight: 700, color: "var(--warn)", background: "var(--warnSoft)" }}>{a.warnings} warnings</span>
              </Link>
            ))}
          </div>
        </Card>
        <Card delay={360} style={{ flex: "1 1 280px", display: "flex", flexDirection: "column", gap: 18, alignItems: "center", justifyContent: "center", textAlign: "center" }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, alignSelf: "flex-start" }}>Compliance score</h2>
          <Ring pct={c?.apiCompliancePct ?? 0} color={(c?.apiCompliancePct ?? 0) >= 100 ? "var(--ok)" : "var(--bad)"} label="compliant" />
        </Card>
      </div>
    </>
  );
}
