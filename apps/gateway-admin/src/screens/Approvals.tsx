import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api.ts";
import { Card, Skeleton, ErrorState, EmptyState } from "../components/ui.tsx";
import { PageHeader } from "./PageHeader.tsx";

export function Approvals() {
  const [selType, setSelType] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["workflows"], queryFn: apiClient.workflows });
  const decide = useMutation({
    mutationFn: (p: { ref: string; status: "APPROVED" | "REJECTED" }) => apiClient.decideWorkflow(p.ref, p.status, comment),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["workflows"] }); setComment(""); },
  });
  const types = q.data?.types ?? [];
  const active = types.find((t) => t.type === selType) ?? types.find((t) => t.pending > 0) ?? types[0];

  return (
    <>
      <PageHeader area="Approvals" title="Workflow approvals" subtitle="One inbox for every pending gateway workflow." />
      {q.isLoading ? <Skeleton h={200} /> : q.isError ? <ErrorState message="Could not load approvals" onRetry={() => q.refetch()} /> : (
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
          <Card style={{ flex: "1 1 260px", display: "flex", flexDirection: "column", gap: 4, padding: 12 }}>
            {types.map((t) => (
              <button key={t.type} className={`mf-nav ${active?.type === t.type ? "mf-nav-on" : ""}`} onClick={() => setSelType(t.type)} style={{ border: 0, cursor: "pointer", textTransform: "capitalize" }}>
                <span style={{ flex: 1, textAlign: "left" }}>{t.label}</span>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 7px", borderRadius: 999, background: t.pending ? "var(--accentSoft)" : "var(--surface3)", color: t.pending ? "var(--accentText)" : "var(--faint)" }}>{t.pending}</span>
              </button>
            ))}
          </Card>
          <Card style={{ flex: "2 1 460px", display: "flex", flexDirection: "column", gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: 18, textTransform: "capitalize" }}>{active?.label ?? "Requests"}</h2>
            {!active || active.requests.length === 0 ? <EmptyState title="Nothing waiting" hint="Approved and rejected requests leave this list." /> : (
              <>
                {active.requests.map((r) => (
                  <div key={r.referenceId} style={{ padding: 14, borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface2)", display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}><strong style={{ fontSize: 14 }}>{r.description}</strong><span style={{ fontSize: 12, color: "var(--faint)" }}>{r.createdTime}</span></div>
                    <span style={{ fontSize: 12.5, color: "var(--muted)" }}>Requested by {r.requester}</span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="mf-btn mf-pri" disabled={decide.isPending} onClick={() => decide.mutate({ ref: r.referenceId, status: "APPROVED" })} style={{ height: 36, padding: "0 16px", borderRadius: 9, background: "var(--accent)", color: "var(--onAccent)", fontWeight: 600, border: 0, cursor: "pointer" }}>Approve</button>
                      <button className="mf-btn mf-dan" disabled={decide.isPending} onClick={() => decide.mutate({ ref: r.referenceId, status: "REJECTED" })} style={{ height: 36, padding: "0 16px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer" }}>Reject</button>
                    </div>
                  </div>
                ))}
                <input className="mf-input" placeholder="Optional comment on your decision" value={comment} onChange={(e) => setComment(e.target.value)} style={{ height: 40, borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface2)", padding: "0 12px" }} />
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
