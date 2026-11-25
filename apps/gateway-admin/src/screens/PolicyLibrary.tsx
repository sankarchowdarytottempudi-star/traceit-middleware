// Policy library: named policy sets (e.g. "Partner API - standard") applied to many APIs at once,
// with a per-API preview of exactly what changes, confirmation, audit and a per-API result list.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient, rulesClient, type PolicySet, type Security } from "../api.ts";
import { Drawer, ErrorState } from "../components/ui.tsx";
import { Banner, Chip, Loading, Section } from "../components/gw.tsx";
import { ErrorLine } from "../components/rules.tsx";
import { PageHeader } from "./PageHeader.tsx";

function describe(s: PolicySet): string {
  const g = s.gateway ?? {};
  return [
    s.security && `sign-in ${s.security}`, s.tiers?.length && `plans ${s.tiers.join(", ")}`, s.apiPolicy && `whole-API limit ${s.apiPolicy}`,
    g.jsonThreat && `JSON threat protection (depth ≤ ${g.jsonThreat.maxJsonDepth})`, g.xmlThreat && "XML threat protection", g.schemaValidation && "schema validation",
    g.httpsOnly && "HTTPS only", g.maxTps?.production && `backend ≤ ${g.maxTps.production}/s`, g.endpoint?.timeoutMs && `timeout ${g.endpoint.timeoutMs / 1000} s`,
    g.caching?.enabled && `cache ${g.caching.seconds} s`,
  ].filter(Boolean).join(" · ") || "nothing";
}

export function PolicyLibrary() {
  const qc = useQueryClient();
  const lib = useQuery({ queryKey: ["library"], queryFn: rulesClient.library });
  const apis = useQuery({ queryKey: ["rules-apis"], queryFn: rulesClient.apis });
  const adv = useQuery({ queryKey: ["ratelimits", "advanced"], queryFn: () => apiClient.rateLimits("advanced") });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(""); const [desc, setDesc] = useState("");
  const [security, setSecurity] = useState<Security | "">("oauth2");
  const [apiPolicy, setApiPolicy] = useState("");
  const [json, setJson] = useState(true); const [https, setHttps] = useState(true); const [timeout, setTimeoutMs] = useState<number | "">(30000);
  const [applying, setApplying] = useState<PolicySet | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const create = useMutation({ mutationFn: () => rulesClient.createSet({ name: name.trim(), description: desc, security: security || null, apiPolicy: apiPolicy || null, tiers: null,
    gateway: { ...(json ? { jsonThreat: { maxJsonDepth: 10, maxPropertyCount: 100, maxStringLength: 500, maxArrayElementCount: 100, maxKeyLength: 100 } } : {}), ...(https ? { httpsOnly: true } : {}), ...(timeout ? { endpoint: { timeoutMs: Number(timeout), suspendMs: null } } : {}) } }),
    onSuccess: () => { setCreating(false); setName(""); qc.invalidateQueries({ queryKey: ["library"] }); } });
  const del = useMutation({ mutationFn: (n: string) => rulesClient.deleteSet(n), onSuccess: () => qc.invalidateQueries({ queryKey: ["library"] }) });
  const preview = useMutation({ mutationFn: () => rulesClient.applySet(applying!.name, picked, true) });
  const apply = useMutation({ mutationFn: () => rulesClient.applySet(applying!.name, picked, false), onSuccess: () => preview.reset() });
  const advanced = (adv.data?.list ?? []).map((p) => p.name);
  const close = () => { setApplying(null); setPicked([]); preview.reset(); apply.reset(); };

  return (
    <>
      <PageHeader area="Policy library" title="Policy library" subtitle="Named policy sets you apply to many APIs at once. Each API gets its own preview, revision and deployment, and every change is audited."
        actions={<button type="button" className="gw-btn gw-btn-pri" onClick={() => setCreating(true)}>New policy set</button>} />
      <Section title={`Policy sets (${lib.data?.list.length ?? 0})`}>
        {lib.isLoading ? <Loading tiles={0} blocks={1} /> : lib.isError ? <ErrorState message={(lib.error as Error).message} onRetry={() => lib.refetch()} /> :
          (lib.data?.list ?? []).length === 0 ? <p className="gw-note" style={{ margin: 0 }}>No sets yet. A set is, for example, "Partner API - standard": OAuth2, JSON threat protection, HTTPS only, 30 s backend timeout.</p> :
          (lib.data?.list ?? []).map((s) => (
            <div key={s.name} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 0", borderTop: "1px solid var(--border)" }} data-set={s.name}>
              <div style={{ flex: "1 1 280px", minWidth: 0 }}><strong>{s.name}</strong>{s.description && <span className="gw-muted"> · {s.description}</span>}<div className="gw-muted" style={{ fontSize: 12.5 }}>{describe(s)}</div></div>
              <button type="button" className="gw-btn gw-btn-sm gw-btn-pri" onClick={() => setApplying(s)}>Apply to APIs</button>
              <button type="button" className="gw-btn gw-btn-sm" onClick={() => del.mutate(s.name)}>Delete set</button>
            </div>))}
      </Section>

      <Drawer open={creating} title="New policy set" onClose={() => setCreating(false)}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label className="gw-field" style={{ display: "flex" }}>Name<input className="gw-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Partner API - standard" aria-label="Set name" /></label>
          <label className="gw-field" style={{ display: "flex" }}>What it is for<input className="gw-input" value={desc} onChange={(e) => setDesc(e.target.value)} aria-label="Set description" /></label>
          <label className="gw-field" style={{ display: "flex" }}>Sign-in<select className="gw-select" value={security} onChange={(e) => setSecurity(e.target.value as Security | "")} aria-label="Set sign-in">
            <option value="">Leave as it is</option><option value="oauth2">OAuth2 token</option><option value="apikey">API key</option><option value="both">OAuth2 or API key</option><option value="basic">Basic</option></select></label>
          <label className="gw-field" style={{ display: "flex" }}>Limit for the whole API<select className="gw-select" value={apiPolicy} onChange={(e) => setApiPolicy(e.target.value)} aria-label="Set limit">
            <option value="">Leave as it is</option>{advanced.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
          <label className="gw-check"><input type="checkbox" checked={json} onChange={(e) => setJson(e.target.checked)} /><span>JSON threat protection</span></label>
          <label className="gw-check"><input type="checkbox" checked={https} onChange={(e) => setHttps(e.target.checked)} /><span>HTTPS only</span></label>
          <label className="gw-field">Backend timeout (ms, empty = leave)<input className="gw-input" type="number" value={timeout} onChange={(e) => setTimeoutMs(e.target.value === "" ? "" : Number(e.target.value))} aria-label="Set timeout" /></label>
          <ErrorLine error={create.error} />
          <div><button type="button" className="gw-btn gw-btn-pri" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Save set</button></div>
        </div>
      </Drawer>

      <Drawer open={!!applying} title={`Apply "${applying?.name ?? ""}"`} onClose={close}>
        {applying && <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p className="gw-muted" style={{ margin: 0, fontSize: 13 }}>{describe(applying)}</p>
          {!preview.data && !apply.data && <>
            <input className="gw-input" type="search" placeholder="Filter APIs" aria-label="Filter APIs" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column" }} aria-label="APIs to apply to">
              {(apis.data?.list ?? []).filter((a) => a.name.toLowerCase().includes(filter.toLowerCase())).map((a) => (
                <label key={a.id} className="gw-check"><input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))} /><span className="gw-mono">{a.name}</span></label>))}
            </div>
            <ErrorLine error={preview.error} />
            <div><button type="button" className="gw-btn gw-btn-pri" disabled={!picked.length || preview.isPending} onClick={() => preview.mutate()}>{preview.isPending ? "Checking each API…" : `Preview for ${picked.length} API${picked.length === 1 ? "" : "s"}`}</button></div>
          </>}
          {preview.data && !apply.data && <div data-testid="set-preview" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Banner tone="warn">Each API below is updated, gets a new revision and is deployed to its gateways. This changes live gateways in production.</Banner>
            {preview.data.results.map((r) => (
              <div key={r.apiId} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, fontSize: 13 }}>
                <strong className="gw-mono">{r.apiName ?? r.apiId}</strong> {r.ok ? (r.noChange ? <Chip>no change</Chip> : <Chip tone="warn">{r.changes?.length} change{r.changes?.length === 1 ? "" : "s"}</Chip>) : <Chip tone="bad">cannot apply</Chip>}
                {r.ok ? <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{(r.changes ?? []).map((c) => <li key={c}>{c}</li>)}</ul> : <div style={{ color: "var(--bad)" }}>{r.error}</div>}
              </div>))}
            <ErrorLine error={apply.error} />
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="gw-btn" style={{ borderColor: "var(--bad)", color: "var(--bad)" }} disabled={apply.isPending || !preview.data.results.some((r) => r.ok && !r.noChange)} onClick={() => apply.mutate()}>{apply.isPending ? "Applying…" : "Apply to the live gateways"}</button>
              <button type="button" className="gw-btn" onClick={() => preview.reset()}>Back</button>
            </div>
          </div>}
          {apply.data && <div data-testid="set-results" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {apply.data.results.map((r) => <div key={r.apiId} style={{ fontSize: 13 }}><strong className="gw-mono">{r.apiName ?? r.apiId}</strong> · {r.ok ? (r.applied ? `done, ${r.revision?.displayName ?? "saved"}` : "no change") : <span style={{ color: "var(--bad)" }}>failed: {r.error}</span>}</div>)}
            <div><button type="button" className="gw-btn" onClick={close}>Close</button></div>
          </div>}
        </div>}
      </Drawer>
    </>
  );
}
