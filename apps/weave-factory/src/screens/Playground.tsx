// Send one real request to a running API or to a registered environment and read the real answer.
// The request is made by this server, so nothing leaves the customer's network.
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { api, type ProxyResult } from "../api.ts";
import { txt } from "../lib/text.ts";
import { ms } from "../lib/migrate.ts";
import { Btn, Empty, Failed, Field, Head, Loading, Notice, Panel, Pill, errText, useTitle } from "../migrate/ui.tsx";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
function pretty(body: string): string {
  const t = body.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return body;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return body; }
}
function statusTone(status: number): "ok" | "warn" | "bad" {
  return status >= 200 && status < 300 ? "ok" : status >= 300 && status < 500 && status !== 0 ? "warn" : "bad";
}

export function Playground() {
  useTitle("Playground");
  const [sp] = useSearchParams();
  const estate = useQuery({ queryKey: ["estate"], queryFn: () => api.estate() });
  const envs = useQuery({ queryKey: ["environments"], queryFn: api.environments });
  const apis = useMemo(() => (estate.data?.apis ?? []).map((a) => a.name).sort((a, b) => a.localeCompare(b)), [estate.data]);
  const environments = envs.data?.environments ?? [];

  const [kind, setKind] = useState<"api" | "env">(sp.get("env") ? "env" : "api");
  const [apiPick, setApiPick] = useState(sp.get("api") ?? "");
  const [envPick, setEnvPick] = useState(sp.get("env") ?? "");
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/");
  const [headers, setHeaders] = useState("");
  const [body, setBody] = useState("");
  const [problem, setProblem] = useState("");
  const service = apis.includes(apiPick) ? apiPick : apis[0] ?? "";
  const envId = environments.some((e) => e.id === envPick) ? envPick : environments[0]?.id ?? "";

  const detail = useQuery({ queryKey: ["estate", service], queryFn: () => api.estateApi(service), enabled: kind === "api" && !!service, staleTime: 60000 });
  const operations = detail.data?.operations ?? [];
  const hasBody = method !== "GET" && method !== "DELETE";

  const send = useMutation({
    mutationFn: async (): Promise<ProxyResult> => {
      let h: Record<string, string> = {};
      if (headers.trim()) {
        let parsed: unknown;
        try { parsed = JSON.parse(headers); } catch { throw new Error("The headers must be written as JSON, for example {\"Accept\": \"application/json\"}"); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The headers must be a JSON object of names and values");
        h = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, txt(v)]));
      }
      if (hasBody && body.trim() && !Object.keys(h).some((k) => k.toLowerCase() === "content-type")) h["Content-Type"] = "application/json";
      const target = kind === "api" ? { service } : { envId };
      return api.proxy({ ...target, method, path: path.trim() || "/", headers: h, body: hasBody && body.trim() ? body : undefined });
    },
    onMutate: () => setProblem(""),
    onError: (e) => setProblem(errText(e)),
  });
  const canSend = kind === "api" ? !!service : !!envId;
  const res = send.data;

  return (
    <>
      <Head area="Playground" title="Playground"
        subtitle="Send one request to a running API or to one of your environments and read the real answer. The request is made from this server, inside your network." />
      {estate.isLoading || envs.isLoading ? <Loading rows={2} h={160} /> : estate.isError && envs.isError ? <Failed what="The playground is not available right now." error={estate.error} onRetry={() => { estate.refetch(); envs.refetch(); }} /> : apis.length === 0 && environments.length === 0 ? (
        <Empty title="Nothing to send a request to yet" hint="Running APIs and the environments of your workspaces appear here." />
      ) : (
        <div className="mf-mg-grid-2">
          <Panel title="Request">
            <div className="mf-mg-row" role="radiogroup" aria-label="Where to send the request">
              <button type="button" role="radio" aria-checked={kind === "api"} className={`mf-seg${kind === "api" ? " mf-seg-on" : ""} mf-mg-btn mf-mg-btn-sm`} onClick={() => setKind("api")}>A running API</button>
              <button type="button" role="radio" aria-checked={kind === "env"} className={`mf-seg${kind === "env" ? " mf-seg-on" : ""} mf-mg-btn mf-mg-btn-sm`} onClick={() => setKind("env")}>An environment</button>
            </div>
            {kind === "api" ? (
              apis.length === 0 ? <Notice tone="warn">{estate.isError ? "The running APIs are not available right now." : "No API is running yet."}</Notice> : (
                <>
                  <Field label="API" hint="The request goes straight to the service on the cluster, not through the gateway.">
                    <select className="mf-mg-input mf-mono" value={service} onChange={(e) => setApiPick(e.target.value)}>{apis.map((a) => <option key={a} value={a}>{a}</option>)}</select>
                  </Field>
                  {operations.length > 0 && (
                    <Field label="Pick one of its operations" hint="Fills in the method and the path. Replace anything in {braces} with a real value.">
                      <select className="mf-mg-input mf-mono" value="" onChange={(e) => { const op = operations.find((o) => o.id === e.target.value); if (op) { setMethod(METHODS.includes(txt(op.method).toUpperCase()) ? txt(op.method).toUpperCase() : "GET"); setPath(txt(op.path) || "/"); } }}>
                        <option value="">{operations.length === 1 ? "1 operation…" : `${operations.length} operations…`}</option>
                        {operations.map((o) => <option key={o.id} value={o.id}>{txt(o.method).toUpperCase()} {txt(o.path)}</option>)}
                      </select>
                    </Field>
                  )}
                </>
              )
            ) : environments.length === 0 ? <Notice tone="warn">No environment is registered yet. Add one on the Workspaces screen.</Notice> : (
              <Field label="Environment" hint="The environment's stored access token is added unless you set an Authorization header yourself.">
                <select className="mf-mg-input" value={envId} onChange={(e) => setEnvPick(e.target.value)}>{environments.map((e) => <option key={e.id} value={e.id}>{txt(e.name)}{txt(e.workspace) ? ` (${txt(e.workspace)})` : ""}</option>)}</select>
              </Field>
            )}
            <div className="mf-mg-row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
              <div style={{ flex: "0 0 108px" }}><Field label="Method"><select className="mf-mg-input mf-mono" value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select></Field></div>
              <div className="mf-mg-grow"><Field label="Path"><input className="mf-mg-input mf-mono" value={path} onChange={(e) => setPath(e.target.value)} autoCapitalize="none" spellCheck={false} /></Field></div>
            </div>
            <Field label="Headers (optional)" hint="Written as JSON.">
              <textarea className="mf-mg-input mf-mono" rows={3} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder={'{ "Accept": "application/json" }'} spellCheck={false} />
            </Field>
            {hasBody && (
              <Field label="Body">
                <textarea className="mf-mg-input mf-mono" rows={7} value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} />
              </Field>
            )}
            {method !== "GET" && <Notice tone="warn">This is a real request. A {method} can create, change or remove real data in the systems behind the API. Send it only to a test system.</Notice>}
            {problem && <Notice tone="bad">{problem}</Notice>}
            <div><Btn kind="primary" icon={<Send size={15} aria-hidden="true" />} busy={send.isPending} disabled={!canSend} onClick={() => send.mutate()}>Send request</Btn></div>
          </Panel>
          <Panel title="Response">
            {send.isPending ? <Loading rows={1} h={120} /> : !res ? <Empty title="No response yet" hint="Send a request to see the status, the time it took and the body." /> : (
              <>
                <div className="mf-mg-row" aria-live="polite">
                  <Pill tone={statusTone(res.status)}>{res.status === 0 ? "No answer" : `Status ${res.status}`}</Pill>
                  <Pill>{ms(res.ms)}</Pill>
                  {txt(res.slo) && <Pill tone={res.slo === "fast" ? "ok" : res.slo === "slow" ? "bad" : "warn"} title="Compared with the response time target">{txt(res.slo)}</Pill>}
                </div>
                {txt(res.body).trim() ? <pre className="mf-mono mf-mg-pre" tabIndex={0}>{pretty(txt(res.body))}</pre> : <p className="mf-mg-small mf-mg-muted" style={{ margin: 0 }}>The response has no body.</p>}
              </>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}
