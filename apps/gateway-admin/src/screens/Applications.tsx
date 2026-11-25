// Consumer applications: create them, issue/regenerate/remove their production and sandbox keys
// (the secret is shown once), and subscribe them to APIs with a plan.
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus } from "lucide-react";
import { rulesClient, type AppDetail, type AppRow } from "../api.ts";
import { Drawer, ErrorState } from "../components/ui.tsx";
import { Banner, Chip, DataTable, Loading, Section, copyText, type Col } from "../components/gw.tsx";
import { ErrorLine, policyLabel } from "../components/rules.tsx";
import { PageHeader } from "./PageHeader.tsx";
import { txt } from "../lib/text.ts";

function Secret({ title, consumerKey, consumerSecret, onClose }: { title: string; consumerKey: string | null; consumerSecret: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState("");
  return (
    <div className="gw-card" style={{ padding: 14, borderColor: "var(--warn)", background: "var(--warnSoft)", display: "flex", flexDirection: "column", gap: 10 }} data-testid="secret-once" role="alert">
      <strong>{title}</strong>
      <span style={{ fontSize: 13 }}>Copy the secret now and store it safely. It is not shown again; if it is lost, regenerate it.</span>
      {[["Consumer key", consumerKey], ["Consumer secret", consumerSecret]].map(([k, v]) => v ? (
        <div key={k} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="gw-faint" style={{ width: 120, fontSize: 12 }}>{k}</span>
          <code className="gw-mono" style={{ flex: "1 1 200px", overflowWrap: "anywhere", fontSize: 12.5, background: "var(--surface)", padding: "6px 8px", borderRadius: 6 }} data-field={k}>{v}</code>
          <button type="button" className="gw-btn gw-btn-sm" onClick={async () => setCopied((await copyText(v)) ? k! : "")}><Copy size={13} aria-hidden="true" />{copied === k ? "Copied" : "Copy"}</button>
        </div>) : null)}
      <div><button type="button" className="gw-btn gw-btn-sm" onClick={onClose}>I have stored it</button></div>
    </div>
  );
}

function AppPanel({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["app", id], queryFn: () => rulesClient.application(id) });
  const apis = useQuery({ queryKey: ["rules-apis"], queryFn: rulesClient.apis });
  const [secret, setSecret] = useState<{ title: string; consumerKey: string | null; consumerSecret: string | null } | null>(null);
  const [apiId, setApiId] = useState("");
  const [plan, setPlan] = useState("");
  const [confirm, setConfirm] = useState<{ kind: "revoke"; km: string; keyType: string } | { kind: "delete" } | null>(null);
  const [typed, setTyped] = useState("");
  const apiRules = useQuery({ queryKey: ["rules", apiId], queryFn: () => rulesClient.api(apiId), enabled: !!apiId });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["app", id] }); qc.invalidateQueries({ queryKey: ["apps"] }); };
  const gen = useMutation({ mutationFn: (kt: "PRODUCTION" | "SANDBOX") => rulesClient.generateKeys(id, kt),
    onSuccess: (k) => { setSecret({ title: `New ${k.keyType.toLowerCase()} keys`, consumerKey: k.consumerKey, consumerSecret: k.consumerSecret }); refresh(); } });
  const regen = useMutation({ mutationFn: (km: string) => rulesClient.regenerateSecret(id, km),
    onSuccess: (k) => { setSecret({ title: "New consumer secret (the old one no longer works)", consumerKey: k.consumerKey, consumerSecret: k.consumerSecret }); refresh(); } });
  const revoke = useMutation({ mutationFn: (km: string) => rulesClient.revokeKeys(id, km, typed), onSuccess: () => { setConfirm(null); setTyped(""); refresh(); } });
  const del = useMutation({ mutationFn: () => rulesClient.deleteApplication(id, typed), onSuccess: () => { setConfirm(null); setTyped(""); onDeleted(); } });
  const sub = useMutation({ mutationFn: () => rulesClient.subscribe(id, apiId, plan), onSuccess: () => { setApiId(""); setPlan(""); refresh(); } });
  const unsub = useMutation({ mutationFn: (s: string) => rulesClient.unsubscribe(id, s), onSuccess: refresh });
  if (q.isLoading) return <Loading tiles={0} blocks={1} />;
  if (q.isError || !q.data) return <ErrorState message={(q.error as Error)?.message ?? "Could not load the application"} onRetry={() => q.refetch()} />;
  const a: AppDetail = q.data;
  const subscribed = new Set(a.subscriptions.map((s) => s.apiId));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <dl className="gw-kv"><dt>Owner</dt><dd>{a.owner}</dd><dt>Application limit</dt><dd>{a.plan}</dd>{a.description && <><dt>About</dt><dd>{a.description}</dd></>}</dl>
      {secret && <Secret {...secret} onClose={() => setSecret(null)} />}
      <section aria-label="Keys" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h3 className="gw-h2" style={{ fontSize: 14, margin: 0 }}>Keys</h3>
        {(["PRODUCTION", "SANDBOX"] as const).map((kt) => {
          const k = a.keys.find((x) => x.keyType === kt);
          return (
            <div key={kt} className="gw-card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }} data-keytype={kt}>
              <strong style={{ fontSize: 13.5 }}>{kt === "PRODUCTION" ? "Production" : "Sandbox"} keys {k ? <Chip tone="ok">Issued</Chip> : <Chip>None</Chip>}</strong>
              {k ? (<>
                <span className="gw-muted" style={{ fontSize: 12.5 }}>Consumer key <code className="gw-mono" style={{ overflowWrap: "anywhere" }}>{k.consumerKey}</code> · {k.keyManager}</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button type="button" className="gw-btn gw-btn-sm" disabled={regen.isPending} onClick={() => regen.mutate(k.keyMappingId)}>Regenerate secret</button>
                  <button type="button" className="gw-btn gw-btn-sm" onClick={() => { setTyped(""); setConfirm({ kind: "revoke", km: k.keyMappingId, keyType: kt }); }}>Remove keys</button>
                </div>
              </>) : <div><button type="button" className="gw-btn gw-btn-sm gw-btn-pri" disabled={gen.isPending} onClick={() => gen.mutate(kt)}>Generate {kt === "PRODUCTION" ? "production" : "sandbox"} keys</button></div>}
            </div>
          );
        })}
        <ErrorLine error={gen.error || regen.error} />
      </section>
      <section aria-label="Subscriptions" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h3 className="gw-h2" style={{ fontSize: 14, margin: 0 }}>Subscribed APIs ({a.subscriptions.length})</h3>
        {a.subscriptions.map((s) => (
          <div key={s.subscriptionId} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
            <span className="gw-mono" style={{ flex: "1 1 180px", overflowWrap: "anywhere" }}>{s.apiName} {s.apiVersion}</span><span className="gw-muted">plan {s.plan}</span><Chip tone={s.status === "UNBLOCKED" ? "ok" : "warn"}>{s.status === "UNBLOCKED" ? "Active" : txt(s.status).toLowerCase()}</Chip>
            <button type="button" className="gw-btn gw-btn-sm" disabled={unsub.isPending} onClick={() => unsub.mutate(s.subscriptionId)}>Unsubscribe</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="gw-field" style={{ flex: "1 1 200px" }}>API<select className="gw-select" value={apiId} onChange={(e) => { setApiId(e.target.value); setPlan(""); }} aria-label="API to subscribe to">
            <option value="">Choose an API…</option>
            {(apis.data?.list ?? []).filter((x) => !subscribed.has(x.id)).map((x) => <option key={x.id} value={x.id}>{x.name} {x.version}</option>)}
          </select></label>
          <label className="gw-field" style={{ flex: "1 1 200px" }}>Plan<select className="gw-select" value={plan} onChange={(e) => setPlan(e.target.value)} disabled={!apiRules.data} aria-label="Plan">
            <option value="">{apiId && !apiRules.data ? "Loading plans…" : "Choose a plan…"}</option>
            {(apiRules.data?.traffic.tiers ?? []).map((t) => <option key={t} value={t}>{policyLabel(apiRules.data?.policies.subscription.find((p) => p.name === t), t, "plan")}</option>)}
          </select></label>
          <button type="button" className="gw-btn gw-btn-pri" disabled={!apiId || !plan || sub.isPending} onClick={() => sub.mutate()}><Plus size={14} aria-hidden="true" />Subscribe</button>
        </div>
        <ErrorLine error={sub.error || unsub.error} />
      </section>
      <div><button type="button" className="gw-btn gw-btn-sm" style={{ color: "var(--bad)" }} onClick={() => { setTyped(""); setConfirm({ kind: "delete" }); }}>Delete application</button></div>
      {confirm && (
        <div className="gw-card" style={{ padding: 14, borderColor: "var(--bad)", display: "flex", flexDirection: "column", gap: 10 }} role="alert">
          <strong>{confirm.kind === "delete" ? `Delete ${a.name}?` : `Remove the ${confirm.keyType.toLowerCase()} keys of ${a.name}?`}</strong>
          <span style={{ fontSize: 13 }}>{confirm.kind === "delete" ? "Every caller using its keys is cut off at once and its subscriptions are removed." : "Every caller using these keys is cut off. New keys can be generated afterwards."}</span>
          <label className="gw-field" style={{ display: "flex" }}><span>Type <strong className="gw-mono" style={{ color: "var(--text)" }}>{a.name}</strong> to confirm</span><input className="gw-input" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type the application name" /></label>
          <ErrorLine error={revoke.error || del.error} />
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="gw-btn" style={{ borderColor: "var(--bad)", color: "var(--bad)" }} disabled={typed !== a.name || revoke.isPending || del.isPending}
              onClick={() => (confirm.kind === "delete" ? del.mutate() : revoke.mutate(confirm.km))}>{confirm.kind === "delete" ? "Delete application" : "Remove keys"}</button>
            <button type="button" className="gw-btn" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Applications() {
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const sel = sp.get("app");
  const q = useQuery({ queryKey: ["apps"], queryFn: rulesClient.applications });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(""); const [plan, setPlan] = useState(""); const [desc, setDesc] = useState("");
  const create = useMutation({ mutationFn: () => rulesClient.createApplication({ name: name.trim(), plan, description: desc.trim() }),
    onSuccess: (r) => { setCreating(false); setName(""); setDesc(""); qc.invalidateQueries({ queryKey: ["apps"] }); open(r.id); } });
  const open = (id: string | null) => setSp((p) => { const n = new URLSearchParams(p); if (id) n.set("app", id); else n.delete("app"); return n; });
  const plans = q.data?.plans ?? [];
  const cols: Col<AppRow>[] = [
    { key: "name", label: "Application", lead: true, render: (r) => <span className="gw-mono" style={{ fontWeight: 600 }}>{r.name}</span> },
    { key: "plan", label: "Application limit", render: (r) => r.plan },
    { key: "subs", label: "APIs", num: true, render: (r) => r.subscriptions },
    { key: "owner", label: "Owner", render: (r) => r.owner },
    { key: "open", label: "", render: (r) => <button type="button" className="gw-btn gw-btn-sm" onClick={(e) => { e.stopPropagation(); open(r.id); }} aria-label={`Open ${r.name}`}>Keys & subscriptions</button> },
  ];
  const selName = q.data?.list.find((a) => a.id === sel)?.name ?? "Application";
  return (
    <>
      <PageHeader area="Applications & keys" title="Applications & keys" subtitle="A consumer application holds the keys a caller uses and the APIs it is subscribed to. Create one per consumer system so you can limit, block or cut it off on its own."
        actions={<button type="button" className="gw-btn gw-btn-pri" onClick={() => { setPlan(plans[0]?.name ?? ""); setCreating(true); }}><Plus size={14} aria-hidden="true" />New application</button>} />
      {q.data && <Banner tone="info">Applications listed here belong to {q.data.owner}. Applications other people created in the developer portal are not shown and are not changed.</Banner>}
      <Section title={`Applications (${q.data?.list.length ?? 0})`}>
        {q.isLoading ? <Loading tiles={0} blocks={1} /> : q.isError ? <ErrorState message={(q.error as Error).message} onRetry={() => q.refetch()} /> :
          <DataTable cols={cols} rows={q.data?.list ?? []} rowKey={(r) => r.id} onRow={(r) => open(r.id)} empty="No applications yet." label="Applications" />}
      </Section>
      <Drawer open={creating} title="New application" onClose={() => setCreating(false)}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label className="gw-field" style={{ display: "flex" }}>Name<input className="gw-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. mobile-app-prod" aria-label="Application name" /></label>
          <label className="gw-field" style={{ display: "flex" }}>Application limit<select className="gw-select" value={plan} onChange={(e) => setPlan(e.target.value)} aria-label="Application limit">
            {plans.map((p) => <option key={p.name} value={p.name}>{policyLabel(p, p.name, "application")}</option>)}</select>
            <span style={{ fontWeight: 400, letterSpacing: 0, fontSize: 12 }}>Counts every call the application makes, across all its APIs.</span></label>
          <label className="gw-field" style={{ display: "flex" }}>What it is for<input className="gw-input" value={desc} onChange={(e) => setDesc(e.target.value)} aria-label="Description" /></label>
          <ErrorLine error={create.error} />
          <div><button type="button" className="gw-btn gw-btn-pri" disabled={!name.trim() || !plan || create.isPending} onClick={() => create.mutate()}>{create.isPending ? "Creating…" : "Create application"}</button></div>
        </div>
      </Drawer>
      <Drawer open={!!sel} title={selName} onClose={() => open(null)}>
        {sel && <AppPanel key={sel} id={sel} onDeleted={() => { open(null); qc.invalidateQueries({ queryKey: ["apps"] }); }} />}
      </Drawer>
    </>
  );
}
