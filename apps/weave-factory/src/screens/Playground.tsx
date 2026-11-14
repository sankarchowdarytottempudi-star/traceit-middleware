import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api, type ProxyResult } from "../api.ts";
import { Card, Skeleton, ErrorState, EmptyState } from "../components/ui.tsx";
import { PageHeader } from "./PageHeader.tsx";

export function Playground() {
  const q = useQuery({ queryKey: ["migrations"], queryFn: api.migrations });
  const apis = (q.data?.migrations ?? []).filter((m) => m.apiName).map((m) => m.apiName as string);
  const [apiName, setApiName] = useState("");
  const [method, setMethod] = useState("POST");
  const [path, setPath] = useState("/");
  const [headers, setHeaders] = useState('{\n  "Content-Type": "application/json"\n}');
  const [body, setBody] = useState("{}");
  const [err, setErr] = useState("");

  const send = useMutation({
    mutationFn: async (): Promise<ProxyResult> => {
      setErr("");
      let h: unknown = {}; let b: unknown = undefined;
      try { h = headers.trim() ? JSON.parse(headers) : {}; } catch { throw new Error("Headers must be valid JSON"); }
      try { b = body.trim() ? JSON.parse(body) : undefined; } catch { throw new Error("Body must be valid JSON"); }
      return api.proxy({ api: apiName || apis[0], method, path, headers: h, body: b });
    },
    onError: (e: Error) => setErr(e.message),
  });

  const field = { width: "100%", borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface2)", padding: "8px 12px", fontSize: 13 } as const;
  return (
    <>
      <PageHeader area="Playground" title="Playground" subtitle="Send a real request to a migrated API and see the REAL response from the backend, not a mock." />
      {q.isLoading ? <Skeleton h={120} /> : q.isError ? <ErrorState message="Could not load APIs" onRetry={() => q.refetch()} /> :
        apis.length === 0 ? <EmptyState title="No migrated APIs yet" /> : (
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
          <Card style={{ flex: "1 1 420px", display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>API
              <select className="mf-input" value={apiName || apis[0]} onChange={(e) => setApiName(e.target.value)} style={{ ...field, marginTop: 6 }}>
                {apis.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <div style={{ display: "flex", gap: 10 }}>
              <label style={{ fontSize: 13, fontWeight: 600, width: 120 }}>Method
                <select className="mf-input" value={method} onChange={(e) => setMethod(e.target.value)} style={{ ...field, marginTop: 6 }}>
                  {["GET", "POST", "PUT", "DELETE"].map((m) => <option key={m}>{m}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>Path
                <input className="mf-input" value={path} onChange={(e) => setPath(e.target.value)} style={{ ...field, marginTop: 6 }} />
              </label>
            </div>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Headers
              <textarea className="mf-input mf-mono" value={headers} onChange={(e) => setHeaders(e.target.value)} rows={4} style={{ ...field, marginTop: 6, resize: "vertical" }} />
            </label>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Body
              <textarea className="mf-input mf-mono" value={body} onChange={(e) => setBody(e.target.value)} rows={6} style={{ ...field, marginTop: 6, resize: "vertical" }} />
            </label>
            {err && <p role="alert" style={{ margin: 0, color: "var(--bad)", fontSize: 13 }}>{err}</p>}
            <button className="mf-btn mf-pri" disabled={send.isPending} onClick={() => send.mutate()} style={{ height: 42, borderRadius: 10, background: "var(--accent)", color: "var(--onAccent)", fontWeight: 600, border: 0, cursor: "pointer" }}>{send.isPending ? "Sending…" : "Send request"}</button>
          </Card>
          <Card style={{ flex: "1 1 420px", display: "flex", flexDirection: "column", gap: 10, minHeight: 240 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>Response</h2>
            {!send.data ? <p style={{ color: "var(--faint)" }}>Send a request to see the real response.</p> : (
              <>
                <div style={{ display: "flex", gap: 12, fontSize: 13 }}>
                  <span style={{ fontWeight: 700, color: send.data.status < 400 ? "var(--ok)" : "var(--bad)" }}>HTTP {send.data.status}</span>
                  <span style={{ color: "var(--faint)" }}>{send.data.ms} ms · {send.data.slo}</span>
                </div>
                <pre className="mf-mono" style={{ margin: 0, padding: 12, borderRadius: 10, background: "var(--surface2)", border: "1px solid var(--border)", fontSize: 12, overflow: "auto", maxHeight: 420, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{send.data.body}</pre>
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
