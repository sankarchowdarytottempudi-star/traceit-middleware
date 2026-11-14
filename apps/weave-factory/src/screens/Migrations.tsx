import { useQuery } from "@tanstack/react-query";
import { api, type Migration } from "../api.ts";
import { Card, Skeleton, ErrorState, EmptyState, StatusWord } from "../components/ui.tsx";
import { PageHeader } from "./PageHeader.tsx";
import { txt, num } from "../lib/text.ts";

function outcomeColor(o: string): string {
  if (o === "Failed") return "var(--bad)";
  if (o === "Verified" || o === "Deployed") return "var(--ok)";
  return "var(--warn)";
}
function Bar({ pct, color = "var(--accent)" }: { pct: number; color?: string }) {
  return <span style={{ display: "block", height: 6, borderRadius: 999, background: "var(--surface3)", overflow: "hidden" }}>
    <span className="mf-bar" style={{ display: "block", height: "100%", width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} /></span>;
}

function MigrationCard({ m }: { m: Migration }) {
  const p = m.progress ?? ({} as Migration["progress"]);
  const outcome = txt(p.outcome);
  const pct = Math.round(num(p.overallPercent) * 10) / 10;
  const now = txt(p.currentStep), next = txt(p.nextStep);
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span className="mf-mono" style={{ fontSize: 14 }}>{txt(m.apiName) || txt(m.id)}</span>
          <span style={{ fontSize: 12, color: "var(--faint)" }}>{txt(m.workspace) || "—"}{m.technology ? ` · ${txt(m.technology)}` : ""}</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {m.busy && <StatusWord word="RUNNING" color="var(--warn)" />}
          <StatusWord word={(outcome || "In progress").toUpperCase()} color={outcomeColor(outcome)} />
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Bar pct={pct} color={outcome === "Failed" ? "var(--bad)" : "var(--accent)"} />
        <span style={{ fontWeight: 700, fontSize: 13, width: 48, textAlign: "right" }}>{pct}%</span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
        <strong style={{ color: "var(--text)" }}>{txt(p.majorPhase)}</strong>
        {now && <> · now: {now}</>}{next && <> → next: {next}</>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 8 }}>
        {(m.phases ?? []).map((ph) => (
          <div key={ph.key} title={`${txt(ph.title)}: ${txt(ph.status)}`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10.5, color: "var(--faint)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{txt(ph.title)}</span>
            <Bar pct={num(ph.percent)} color={ph.status === "failed" ? "var(--bad)" : ph.status === "done" ? "var(--ok)" : "var(--accent)"} />
          </div>
        ))}
      </div>
    </Card>
  );
}

export function Migrations() {
  const q = useQuery({ queryKey: ["migrations"], queryFn: api.migrations, refetchInterval: 3000 });
  const migs = q.data?.migrations ?? [];
  return (
    <>
      <PageHeader area="Migrations" title="Migrations" subtitle="Live progress of every API migrating through the factory: current step, next step, and percent complete per phase." />
      {q.isLoading ? <Skeleton h={160} /> : q.isError ? <ErrorState message="Could not reach the migration backend" onRetry={() => q.refetch()} /> :
        migs.length === 0 ? <EmptyState title="No migrations yet" hint="Start one from a workspace." /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 16 }}>
          {migs.map((m) => <MigrationCard key={m.id} m={m} />)}
        </div>
      )}
    </>
  );
}
