import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Webhook, Shuffle, Send, CornerDownLeft } from "lucide-react";
import { api, type MappingRule } from "../api.ts";
import { applyMapping, diffMapping, ruleLabel, compileToArtifact } from "../lib/mapping.ts";
import { Card } from "../components/ui.tsx";
import { PageHeader } from "./PageHeader.tsx";

// Core node set (first pass). Generating the full palette from the WSO2 connector/mediator catalog
// is the later phase; this strip is the seam where that palette will plug in.
const NODES = [
  { key: "trigger", label: "HTTP trigger", icon: Webhook },
  { key: "transform", label: "Transform", icon: Shuffle },
  { key: "call", label: "Call API", icon: Send },
  { key: "respond", label: "Respond", icon: CornerDownLeft },
];

const field = { width: "100%", borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface2)", padding: "8px 12px", fontSize: 12.5 } as const;

export function Canvas() {
  const [node, setNode] = useState("transform");
  const [sampleStr, setSampleStr] = useState('{\n  "customer": { "ref": "C1", "name": "Jane Doe", "email": "jane@x.com" }\n}');
  const [desiredStr, setDesiredStr] = useState('{\n  "ref": "C1",\n  "email": "jane@x.com",\n  "first": "Jane"\n}');
  const [rules, setRules] = useState<MappingRule[]>([]);
  const [note, setNote] = useState("");

  const parsed = useMemo(() => {
    let source: unknown = {}; let desired: unknown = {}; let err = "";
    try { source = JSON.parse(sampleStr || "{}"); } catch { err = "Sample source is not valid JSON"; }
    try { desired = JSON.parse(desiredStr || "{}"); } catch { err = err || "Desired output is not valid JSON"; }
    return { source, desired, err };
  }, [sampleStr, desiredStr]);

  const produced = useMemo(() => applyMapping(rules, parsed.source), [rules, parsed.source]);
  const mismatches = useMemo(() => diffMapping(produced, parsed.desired), [produced, parsed.desired]);
  const artifact = useMemo(() => compileToArtifact(rules, { name: "transform" }), [rules]);

  const infer = useMutation({
    mutationFn: () => api.inferMapping(parsed.source, parsed.desired),
    onSuccess: (r) => { setRules(r.rules); setNote(r.needsModel ? `Engine: ${r.engine}. Some fields were guessed - confirm with the preview, or connect the in-estate model for better inference.` : `Engine: ${r.engine}. All fields mapped from the example.`); },
  });

  function updateRule(i: number, patch: Partial<MappingRule>) { setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))); }
  function addRule() { setRules((rs) => [...rs, { target: "", kind: "direct", source: "" }]); }

  return (
    <>
      <PageHeader area="Flow canvas" title="Flow canvas" subtitle="Build an integration visually. The Transform node maps source to target - by direct mapping, a small expression, or by example (paste a sample and the desired output; the agent infers the mapping)." />

      <Card style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {NODES.map((n, i) => (
          <span key={n.key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button className={`mf-btn ${node === n.key ? "mf-api-on" : ""}`} onClick={() => setNode(n.key)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface2)", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
              <n.icon size={16} aria-hidden="true" />{n.label}
            </button>
            {i < NODES.length - 1 && <span style={{ color: "var(--faint)" }}>→</span>}
          </span>
        ))}
      </Card>

      {node === "transform" ? (
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
          <Card style={{ flex: "1 1 360px", display: "flex", flexDirection: "column", gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>Source (sample)</h2>
            <textarea aria-label="Source sample JSON" className="mf-input mf-mono" value={sampleStr} onChange={(e) => setSampleStr(e.target.value)} rows={8} style={{ ...field, resize: "vertical" }} />
            <h2 style={{ margin: 0, fontSize: 16 }}>Target (desired output)</h2>
            <textarea aria-label="Desired output JSON" className="mf-input mf-mono" value={desiredStr} onChange={(e) => setDesiredStr(e.target.value)} rows={8} style={{ ...field, resize: "vertical" }} />
            {parsed.err && <p role="alert" style={{ margin: 0, color: "var(--bad)", fontSize: 13 }}>{parsed.err}</p>}
            <button className="mf-btn mf-pri" disabled={infer.isPending || !!parsed.err} onClick={() => infer.mutate()} style={{ height: 40, borderRadius: 10, background: "var(--accent)", color: "var(--onAccent)", fontWeight: 600, border: 0, cursor: "pointer" }}>{infer.isPending ? "Inferring…" : "Infer mapping by example"}</button>
            {note && <p style={{ margin: 0, fontSize: 12.5, color: "var(--muted)" }}>{note}</p>}
          </Card>

          <Card style={{ flex: "1 1 420px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0, fontSize: 16 }}>Mapping rules</h2>
              <button className="mf-btn mf-gho" onClick={addRule} style={{ height: 30, padding: "0 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer", fontSize: 12.5 }}>Add rule</button>
            </div>
            {rules.length === 0 ? <p style={{ color: "var(--faint)", fontSize: 13 }}>Infer by example, or add rules manually (direct / expression / constant).</p> :
              rules.map((r, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface2)" }}>
                  <code className="mf-mono" style={{ fontSize: 12 }}>{ruleLabel(r)}</code>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <input aria-label="target" className="mf-input mf-mono" value={r.target} onChange={(e) => updateRule(i, { target: e.target.value })} placeholder="target" style={{ ...field, width: 120, padding: "4px 8px" }} />
                    <select aria-label="kind" className="mf-input" value={r.kind} onChange={(e) => updateRule(i, { kind: e.target.value as MappingRule["kind"] })} style={{ ...field, width: 110, padding: "4px 8px" }}>
                      <option value="direct">direct</option><option value="expr">expression</option><option value="const">constant</option>
                    </select>
                    <input aria-label="value" className="mf-input mf-mono" value={r.kind === "direct" ? (r.source ?? "") : (r.expr ?? "")} onChange={(e) => updateRule(i, r.kind === "direct" ? { source: e.target.value } : { expr: e.target.value })} placeholder={r.kind === "direct" ? "source.path" : r.kind === "expr" ? "firstWord(a.b)" : '"value"'} style={{ ...field, flex: 1, minWidth: 120, padding: "4px 8px" }} />
                  </div>
                  {r.note && <span style={{ fontSize: 11.5, color: "var(--warn)" }}>{r.note}</span>}
                </div>
              ))}
            <h2 style={{ margin: "6px 0 0", fontSize: 16 }}>Live preview {mismatches.length === 0 ? <span style={{ fontSize: 12, color: "var(--ok)" }}>✓ matches the example</span> : <span style={{ fontSize: 12, color: "var(--bad)" }}>{mismatches.length} field(s) differ</span>}</h2>
            <pre className="mf-mono" data-testid="preview" style={{ margin: 0, padding: 12, borderRadius: 10, background: "var(--surface2)", border: "1px solid var(--border)", fontSize: 12, overflow: "auto", maxHeight: 220 }}>{JSON.stringify(produced, null, 2)}</pre>
            {mismatches.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {mismatches.map((m) => <span key={m.path} style={{ fontSize: 12, color: "var(--bad)" }} className="mf-mono">{m.path}: got {JSON.stringify(m.produced)} ≠ want {JSON.stringify(m.desired)}</span>)}
              </div>
            )}
            <h2 style={{ margin: "6px 0 0", fontSize: 16 }}>WSO2 artifact</h2>
            <pre className="mf-mono" style={{ margin: 0, padding: 12, borderRadius: 10, background: "var(--surface2)", border: "1px solid var(--border)", fontSize: 11.5, overflow: "auto", maxHeight: 200 }}>{artifact}</pre>
          </Card>
        </div>
      ) : (
        <Card><p style={{ color: "var(--muted)" }}>The <strong>{NODES.find((n) => n.key === node)?.label}</strong> node is part of the core set. The full node palette is generated from the WSO2 connector and mediator catalog in the next phase.</p></Card>
      )}
    </>
  );
}
