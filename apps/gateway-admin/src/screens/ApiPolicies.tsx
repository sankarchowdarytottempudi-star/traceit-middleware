// "Policies" tab of an API: the whole middleware policy landscape grouped by family, each with where it
// is handled, plus the editor for the gateway policies this console applies directly.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { rulesClient, type ApiRules, type ChangePlan, type GatewayPolicies } from "../api.ts";
import { Chip, Section, type Tone } from "../components/gw.tsx";
import { ConfirmChange, ErrorLine } from "../components/rules.tsx";
import { CATALOG, FAMILIES, STATE_WORDS, type PolicyState } from "../lib/policyCatalog.ts";

const TONE: Record<PolicyState, Tone> = { here: "ok", apim: "accent", service: "proc", outside: "plain", unsupported: "warn" };
const TAB_WORD: Record<string, string> = { traffic: "Traffic limits", access: "Access", consumers: "Consumers", policies: "Gateway policies below", history: "Change history", live: "Live status" };

function Num({ label, value, onChange, min = 1, max, suffix }: { label: string; value: number | null; onChange: (v: number | null) => void; min?: number; max: number; suffix?: string }) {
  return (
    <label className="gw-field">{label}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <input className="gw-input" type="number" min={min} max={max} value={value ?? ""} placeholder="not set" aria-label={label} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} style={{ width: 120 }} />
        {suffix && <span className="gw-faint" style={{ fontWeight: 400 }}>{suffix}</span>}
      </span>
    </label>
  );
}

export function PoliciesTab({ data, done }: { data: ApiRules; done: (p: ChangePlan) => void }) {
  const g0 = data.gatewayPolicies;
  const [g, setG] = useState<GatewayPolicies>(g0);
  const [plan, setPlan] = useState<ChangePlan | null>(null);
  const [lc, setLc] = useState<{ action: string; plan: ChangePlan } | null>(null);
  const set = <K extends keyof GatewayPolicies>(k: K, v: GatewayPolicies[K]) => setG((x) => ({ ...x, [k]: v }));
  const preview = useMutation({ mutationFn: () => rulesClient.policies(data.api.id, g, true), onSuccess: setPlan });
  const apply = useMutation({ mutationFn: () => rulesClient.policies(data.api.id, g, false), onSuccess: (p) => { setPlan(null); done(p); } });
  const lcPreview = useMutation({ mutationFn: (action: string) => rulesClient.lifecycle(data.api.id, action, true), onSuccess: (p, action) => setLc({ action, plan: p }) });
  const lcApply = useMutation({ mutationFn: (confirm?: string) => rulesClient.lifecycle(data.api.id, lc!.action, false, confirm), onSuccess: (p) => { setLc(null); done(p); } });
  const jt = g.jsonThreat;
  const state = data.lifecycle.state;
  const actions = state === "PUBLISHED" ? ["Deprecate", "Block"] : state === "DEPRECATED" ? ["Block", "Retire"] : ["CREATED", "PROTOTYPED", "BLOCKED"].includes(state) ? ["Publish"] : [];
  const stops = lc && (lc.action === "Block" || lc.action === "Retire");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Section title="Gateway policies" note="Applied by API Manager on every operation of this API. Saving creates a revision and deploys it, like every other change.">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <h3 className="gw-h2" style={{ fontSize: 14, margin: "0 0 6px" }}>Threat protection</h3>
            <label className="gw-check"><input type="checkbox" checked={!!jt} onChange={(e) => set("jsonThreat", e.target.checked ? { maxJsonDepth: 10, maxPropertyCount: 100, maxStringLength: 500, maxArrayElementCount: 100, maxKeyLength: 100 } : null)} /><span>JSON threat protection: refuse JSON bodies that are too deep or too large (HTTP 400)</span></label>
            {jt && <div style={{ display: "flex", gap: 12, flexWrap: "wrap", padding: "6px 0 0 28px" }}>
              <Num label="Max depth" value={jt.maxJsonDepth} max={999} onChange={(v) => set("jsonThreat", { ...jt, maxJsonDepth: v ?? 1 })} />
              <Num label="Max properties" value={jt.maxPropertyCount} max={999} onChange={(v) => set("jsonThreat", { ...jt, maxPropertyCount: v ?? 1 })} />
              <Num label="Max string length" value={jt.maxStringLength} max={999} onChange={(v) => set("jsonThreat", { ...jt, maxStringLength: v ?? 1 })} />
              <Num label="Max array elements" value={jt.maxArrayElementCount} max={999} onChange={(v) => set("jsonThreat", { ...jt, maxArrayElementCount: v ?? 1 })} />
              <Num label="Max key length" value={jt.maxKeyLength} max={999} onChange={(v) => set("jsonThreat", { ...jt, maxKeyLength: v ?? 1 })} />
            </div>}
            <label className="gw-check"><input type="checkbox" checked={g.xmlThreat} onChange={(e) => set("xmlThreat", e.target.checked)} /><span>XML threat protection (server-defined limits)</span></label>
            <label className="gw-check"><input type="checkbox" checked={g.schemaValidation} onChange={(e) => set("schemaValidation", e.target.checked)} /><span>OpenAPI schema validation: refuse requests and responses that do not match the API definition</span></label>
            <label className="gw-check"><input type="checkbox" checked={g.httpsOnly} onChange={(e) => set("httpsOnly", e.target.checked)} /><span>HTTPS only: refuse plain HTTP calls</span></label>
          </div>
          <div>
            <h3 className="gw-h2" style={{ fontSize: 14, margin: "0 0 6px" }}>Backend protection and reliability</h3>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Num label="Max requests per second to the backend (production)" value={g.maxTps.production} max={100000} onChange={(v) => set("maxTps", { ...g.maxTps, production: v })} suffix="per second" />
              <Num label="Sandbox" value={g.maxTps.sandbox} max={100000} onChange={(v) => set("maxTps", { ...g.maxTps, sandbox: v })} suffix="per second" />
              <Num label="Backend timeout" value={g.endpoint.timeoutMs} min={1000} max={300000} onChange={(v) => set("endpoint", { ...g.endpoint, timeoutMs: v })} suffix="ms" />
              <Num label="Pause the backend after failures" value={g.endpoint.suspendMs} min={1000} max={300000} onChange={(v) => set("endpoint", { ...g.endpoint, suspendMs: v })} suffix="ms" />
            </div>
            <label className="gw-check" style={{ marginTop: 6 }}><input type="checkbox" checked={g.caching.enabled} onChange={(e) => set("caching", { ...g.caching, enabled: e.target.checked })} /><span>Response caching: serve the same answer to the same request for</span>
              <input className="gw-input" type="number" min={1} max={86400} value={g.caching.seconds} onChange={(e) => set("caching", { ...g.caching, seconds: Number(e.target.value) })} aria-label="Cache seconds" style={{ width: 90, height: 30 }} /><span>seconds</span></label>
          </div>
          <div>
            <h3 className="gw-h2" style={{ fontSize: 14, margin: "0 0 6px" }}>Headers sent to the backend</h3>
            {g.addHeaders.map((h, i) => (
              <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                <input className="gw-input" value={h.name} placeholder="Header name" aria-label={`Added header ${i + 1} name`} onChange={(e) => set("addHeaders", g.addHeaders.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <input className="gw-input" value={h.value} placeholder="Value" aria-label={`Added header ${i + 1} value`} onChange={(e) => set("addHeaders", g.addHeaders.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                <button type="button" className="gw-btn gw-btn-sm" onClick={() => set("addHeaders", g.addHeaders.filter((_, j) => j !== i))}>Remove</button>
              </div>))}
            <button type="button" className="gw-btn gw-btn-sm" onClick={() => set("addHeaders", [...g.addHeaders, { name: "", value: "" }])}>Add a header</button>
            <label className="gw-field" style={{ display: "flex", marginTop: 10 }}>Remove these headers before the backend (comma separated)
              <input className="gw-input" value={g.removeHeaders.join(", ")} aria-label="Headers to remove" onChange={(e) => set("removeHeaders", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} /></label>
          </div>
          <div>
            <h3 className="gw-h2" style={{ fontSize: 14, margin: "0 0 6px" }}>API key header</h3>
            <label className="gw-field">Header callers send the API key in<input className="gw-input" value={g.apiKeyHeader} aria-label="API key header" onChange={(e) => set("apiKeyHeader", e.target.value)} /></label>
          </div>
          <ErrorLine error={preview.error} />
          <div><button type="button" className="gw-btn gw-btn-pri" disabled={preview.isPending} onClick={() => preview.mutate()}>{preview.isPending ? "Checking…" : "Review change"}</button></div>
        </div>
      </Section>

      <Section title="Lifecycle" note={`Now: ${state.toLowerCase()}. Versions are created in API Manager Publisher.`}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {actions.map((a) => <button key={a} type="button" className="gw-btn gw-btn-sm" disabled={lcPreview.isPending} onClick={() => lcPreview.mutate(a)}>{a}</button>)}
          {!actions.length && <span className="gw-note">No lifecycle step is available from this state.</span>}
        </div>
        <ErrorLine error={lcPreview.error} />
      </Section>

      <Section title="Every policy family" note="Where each kind of policy is handled for this API. Configure here = applied by this console through API Manager and tested.">
        {FAMILIES.map((f, i) => (
          <div key={f} style={{ marginBottom: 14 }} data-family={f}>
            <h3 className="gw-h2" style={{ fontSize: 14, margin: "0 0 6px" }}>{i + 1}. {f}</h3>
            {CATALOG.filter((c) => c.family === i + 1).map((c) => (
              <div key={c.id} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", padding: "5px 0", borderTop: "1px solid var(--border)", fontSize: 13 }} data-policy={c.id}>
                <span style={{ flex: "1 1 240px", minWidth: 0 }}>{c.name} <span className="gw-faint" style={{ fontSize: 11.5 }}>· Mule: {c.mule}</span></span>
                <Chip tone={TONE[c.state]}>{STATE_WORDS[c.state]}</Chip>
                <span className="gw-muted" style={{ flex: "1 1 220px", minWidth: 0, fontSize: 12.5 }}>
                  {TAB_WORD[c.where] ? (c.where === "policies" ? TAB_WORD[c.where] : <Link className="gw-link" to={`?tab=${c.where}`}>{TAB_WORD[c.where]}</Link>)
                    : c.where.startsWith("/") ? <Link className="gw-link" to={c.where.split(" ")[0]}>{c.where}</Link> : c.where}
                </span>
              </div>
            ))}
          </div>
        ))}
      </Section>

      <ConfirmChange open={!!plan} plan={plan} busy={apply.isPending} error={apply.error} onConfirm={() => apply.mutate()} onClose={() => { setPlan(null); apply.reset(); }} />
      <ConfirmChange open={!!lc} plan={lc?.plan ?? null} title={`Confirm: ${lc?.action ?? ""}`} busy={lcApply.isPending} error={lcApply.error} deploysRevision={false}
        typeToConfirm={stops ? data.api.name : undefined} danger={!!stops} confirmLabel={lc?.action ?? "Apply"}
        onConfirm={() => lcApply.mutate(stops ? data.api.name : undefined)} onClose={() => { setLc(null); lcApply.reset(); }} />
    </div>
  );
}
