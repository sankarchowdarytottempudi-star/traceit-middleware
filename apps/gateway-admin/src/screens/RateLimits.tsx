import { useState } from "react";
import { useForm } from "react-hook-form";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient, type SubPolicy, type AdvPolicy } from "../api.ts";
import { formatQuota, logBarWidth, plainWords, UNLIMITED } from "../lib/format.ts";
import { Card, SegTabs, Drawer, Skeleton, ErrorState, EmptyState } from "../components/ui.tsx";
import { PageHeader } from "./PageHeader.tsx";

type Tab = "advanced" | "application" | "subscription" | "custom" | "deny";
const TABS: { id: Tab; label: string }[] = [
  { id: "advanced", label: "Advanced" }, { id: "application", label: "Application" },
  { id: "subscription", label: "Subscription" }, { id: "custom", label: "Custom" }, { id: "deny", label: "Deny" },
];
interface FormVals { policyName: string; requestCount: number; timeUnit: string; }

export function RateLimits() {
  const [tab, setTab] = useState<Tab>("subscription");
  const [drawer, setDrawer] = useState(false);
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["ratelimits", tab], queryFn: () => apiClient.rateLimits(tab) });
  const { register, handleSubmit, watch, reset } = useForm<FormVals>({ defaultValues: { policyName: "", requestCount: 6000, timeUnit: "min" } });

  const create = useMutation({
    mutationFn: (v: FormVals) => apiClient.createPolicy(tab, {
      policyName: v.policyName, displayName: v.policyName, description: "",
      defaultLimit: { type: "REQUESTCOUNTLIMIT", requestCount: { timeUnit: v.timeUnit, unitTime: 1, requestCount: Number(v.requestCount) } },
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ratelimits", tab] }); setDrawer(false); reset(); },
  });
  const del = useMutation({
    mutationFn: (id: string) => apiClient.deletePolicy(tab, id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ratelimits", tab] }); setConfirm(null); setConfirmText(""); },
  });

  const list = q.data?.list ?? [];
  return (
    <>
      <PageHeader area="Rate limiting" title="Traffic controls"
        subtitle="Throttling policies enforced at the gateway. Requests over a quota get HTTP 429."
        actions={tab !== "deny" && <button className="mf-btn mf-pri" onClick={() => setDrawer(true)} style={{ height: 42, padding: "0 18px", borderRadius: 10, background: "var(--accent)", color: "var(--onAccent)", fontWeight: 600, border: 0, cursor: "pointer" }}>New policy</button>} />
      <SegTabs tabs={TABS.map((t) => ({ ...t, count: tab === t.id ? list.length : undefined }))} value={tab} onChange={setTab} />

      <Card>
        {q.isLoading ? <Skeleton h={200} /> : q.isError ? <ErrorState message="Could not load policies" onRetry={() => q.refetch()} /> :
          list.length === 0 ? <EmptyState title="No policies here yet" hint="Create one to start limiting traffic." /> : (
          <div className="gw-tablewrap"><table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ textAlign: "left", color: "var(--faint)", fontSize: 12 }}>
              <th style={{ padding: "8px 6px" }}>Policy</th><th>Quota</th><th className="gw-hide-sm" style={{ width: "32%" }}>Limit</th><th></th>
            </tr></thead>
            <tbody>
              {list.map((p) => {
                const sub = p as SubPolicy; const adv = p as AdvPolicy;
                const limit = (sub.limit ?? adv.limit ?? 0);
                const tu = (sub.timeUnit ?? adv.timeUnit ?? "min");
                return (
                  <tr key={p.policyId} className="mf-row">
                    <td className="gw-namecell" style={{ padding: "12px 6px", overflowWrap: "anywhere" }}><span className="mf-mono" style={{ fontSize: 13.5 }}>{p.name}</span>
                      {"quotaType" in p && <span style={{ marginLeft: 8, display: "inline-block", whiteSpace: "nowrap", fontSize: 11, padding: "1px 7px", borderRadius: 999, background: "var(--surface3)", color: "var(--muted)" }}>{sub.quotaType}</span>}</td>
                    <td className="gw-nowrap-lg" style={{ fontWeight: 700, padding: "0 8px 0 0" }}>{formatQuota(limit)}<span style={{ color: "var(--faint)", fontWeight: 400 }}> / {tu}</span></td>
                    <td className="gw-hide-sm"><span style={{ display: "block", height: 6, borderRadius: 999, background: "var(--surface3)", overflow: "hidden" }}><span className="mf-bar" style={{ display: "block", height: "100%", width: `${logBarWidth(limit)}%`, background: limit >= UNLIMITED ? "var(--ok)" : "var(--accent)" }} /></span></td>
                    <td style={{ textAlign: "right" }}><button className="mf-btn mf-dan" onClick={() => setConfirm({ id: p.policyId, name: p.name })} style={{ fontSize: 12, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer" }}>Delete</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </Card>

      <Drawer open={drawer} title="New policy" onClose={() => setDrawer(false)}>
        <form onSubmit={handleSubmit((v) => create.mutate(v))} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label style={{ fontSize: 13, fontWeight: 600 }}>Name<input className="mf-input" {...register("policyName", { required: true })} style={{ marginTop: 6, width: "100%", height: 40, borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface2)", padding: "0 12px" }} /></label>
          <label style={{ fontSize: 13, fontWeight: 600 }}>Requests<input type="number" className="mf-input" {...register("requestCount", { valueAsNumber: true })} style={{ marginTop: 6, width: "100%", height: 40, borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface2)", padding: "0 12px" }} /></label>
          <label style={{ fontSize: 13, fontWeight: 600 }}>Per<select className="mf-input" {...register("timeUnit")} style={{ marginTop: 6, width: "100%", height: 40, borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface2)", padding: "0 12px" }}><option value="sec">second</option><option value="min">minute</option><option value="hour">hour</option></select></label>
          <p style={{ fontSize: 13, color: "var(--muted)", background: "var(--surface2)", padding: 12, borderRadius: 10 }}>In plain words: {plainWords(Number(watch("requestCount")) || 0, watch("timeUnit"))}</p>
          <button type="submit" disabled={create.isPending} className="mf-btn mf-pri" style={{ height: 42, borderRadius: 10, background: "var(--accent)", color: "var(--onAccent)", fontWeight: 600, border: 0, cursor: "pointer" }}>{create.isPending ? "Creating…" : "Create policy"}</button>
        </form>
      </Drawer>

      <Drawer open={!!confirm} title="Delete policy" onClose={() => { setConfirm(null); setConfirmText(""); }}>
        {confirm && <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <p style={{ color: "var(--muted)" }}>Type <strong className="mf-mono">{confirm.name}</strong> to confirm deletion.</p>
          <input className="mf-input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} style={{ height: 40, borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface2)", padding: "0 12px" }} />
          <button disabled={confirmText !== confirm.name || del.isPending} className="mf-btn mf-dan" onClick={() => del.mutate(confirm.id)} style={{ height: 42, borderRadius: 10, border: "1px solid var(--bad)", background: "var(--badSoft)", color: "var(--bad)", fontWeight: 600, cursor: "pointer", opacity: confirmText !== confirm.name ? 0.5 : 1 }}>Delete permanently</button>
        </div>}
      </Drawer>
    </>
  );
}
