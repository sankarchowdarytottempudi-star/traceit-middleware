import { useQuery } from "@tanstack/react-query";
import { api, type Lesson } from "../api.ts";
import { Card, Skeleton, ErrorState, EmptyState } from "../components/ui.tsx";
import { PageHeader } from "./PageHeader.tsx";

function scopeColor(s: string): { bg: string; fg: string } {
  if (s === "functional") return { bg: "var(--okSoft)", fg: "var(--ok)" };
  if (s === "workspace") return { bg: "var(--sysSoft)", fg: "var(--sys)" };
  return { bg: "var(--surface3)", fg: "var(--muted)" };
}

export function Knowledge() {
  const q = useQuery({ queryKey: ["knowledge"], queryFn: api.knowledge });
  const lessons: Lesson[] = q.data?.feedback ?? [];
  return (
    <>
      <PageHeader area="Knowledge base" title="Knowledge base" subtitle="Lessons the agent learned from reviewer feedback. Functional lessons apply to every workspace; workspace and API lessons stay private." />
      {q.isLoading ? <Skeleton h={120} /> : q.isError ? <ErrorState message="Could not load the knowledge base" onRetry={() => q.refetch()} /> :
        lessons.length === 0 ? <EmptyState title="No lessons yet" hint="Reviewer feedback becomes lessons here." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {lessons.map((l) => {
            const c = scopeColor(l.scope);
            return (
              <Card key={l.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: c.bg, color: c.fg, textTransform: "uppercase", letterSpacing: "0.05em" }}>{l.scope}</span>
                  {l.technology && <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "var(--surface3)", color: "var(--muted)" }}>{l.technology}</span>}
                  {l.apiName && <span className="mf-mono" style={{ fontSize: 11.5, color: "var(--faint)" }}>{l.apiName}</span>}
                </div>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{l.summary}</p>
                {(l.mistakes ?? []).length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 18, color: "var(--muted)", fontSize: 12.5, display: "flex", flexDirection: "column", gap: 3 }}>
                    {l.mistakes!.map((m, i) => <li key={i}>{m}</li>)}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
