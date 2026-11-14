// Deploy: check the flow, publish it on the runtime (and the gateway), show where it lives and
// let the user call it for real from here, through the gateway or straight at the listener.
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CloudOff, ExternalLink, Play, RefreshCw, Rocket } from "lucide-react";
import type { Flow, FlowDeployment, HttpRequestSample, InvokeResponse, Json, ValidationIssue } from "@traceit/weave-flow";
import { ApiError, errorText, isUnavailable, studioApi } from "../api.ts";
import { fillPath, joinUrl, pathParams } from "../runctx.ts";
import { useEditor, useEditorStore } from "../store.ts";
import { Badge, Button, Callout, CodeBlock, confirmDialog, CopyButton, DataView, Field, fmtDuration, fmtTime, JsonEditor, Modal, Toggle, toast } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { WEAVE_GATEWAY_URL } from "../../brand.tsx";
import { httpTone } from "./RunViews.tsx";

const BODYLESS = new Set(["GET", "HEAD", "DELETE", "OPTIONS"]);

export function deploymentBadge(d: FlowDeployment | null | undefined, dirtySinceDeploy = false) {
  if (!d || d.status === "stopped") return <Badge>Draft</Badge>;
  if (d.status === "failed") return <Badge tone="bad">Deploy failed</Badge>;
  return <Badge tone={dirtySinceDeploy ? "warn" : "ok"}>{dirtySinceDeploy ? "Live (older version)" : "Live"}</Badge>;
}

function IssueList({ issues, onShow }: { issues: ValidationIssue[]; onShow?: (nodeId: string) => void }) {
  return (
    <ul className="ws-issues">
      {issues.map((i, k) => (
        <li key={k} className={`ws-issue ws-issue-${i.level}`}>
          <Badge tone={i.level === "error" ? "bad" : "warn"}>{i.level === "error" ? "Must fix" : "Check"}</Badge>
          <span style={{ flex: 1, minWidth: 0 }}>{txt(i.message)}</span>
          {i.nodeId && onShow && <button type="button" className="mf-linkbtn" onClick={() => onShow(i.nodeId!)}>Show</button>}
        </li>
      ))}
    </ul>
  );
}
export { IssueList };

export function DeployDialog({ onClose, save, onShowNode, onOpenExecution }: {
  onClose: () => void;
  /** saves pending changes; resolves to the stored flow or null when saving failed */
  save: () => Promise<Flow | null>;
  onShowNode: (nodeId: string) => void;
  onOpenExecution: (id: string) => void;
}) {
  const store = useEditorStore();
  const qc = useQueryClient();
  const base = useEditor((s) => s.base);
  const dirty = useEditor((s) => s.dirty);
  const issues = useEditor((s) => s.issues);
  const nodes = useEditor((s) => s.nodes);
  const settings = useEditor((s) => s.meta.settings);
  const dep = base.deployment;
  const live = dep?.status === "deployed";
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level !== "error");
  const [publish, setPublish] = useState<boolean>(settings.gateway?.publish !== false);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const deploy = useMutation({
    mutationFn: async () => {
      let flow: Flow | null = base;
      if (dirty) flow = await save();
      if (!flow) throw new Error("The flow could not be saved, so it was not deployed.");
      return studioApi.deploy(flow.id, publish);
    },
    onMutate: () => { setFailure(null); setServerIssues(null); },
    onSuccess: (res) => {
      store.setBase({ ...res.flow, deployment: res.deployment ?? res.flow.deployment });
      setServerIssues(res.issues ?? []);
      void qc.invalidateQueries({ queryKey: ["studio", "flows"] });
      if (res.deployment?.status === "deployed") toast("The flow is live.");
    },
    onError: (e) => {
      if (e instanceof ApiError && e.issues?.length) { setServerIssues(e.issues); store.setServerIssues(e.issues); }
      setFailure(isUnavailable(e) ? `The flow engine cannot be reached, so nothing was deployed. ${errorText(e)}` : errorText(e));
    },
  });
  const undeploy = useMutation({
    mutationFn: () => studioApi.undeploy(base.id),
    onSuccess: (res) => { store.setBase(res.flow); void qc.invalidateQueries({ queryKey: ["studio", "flows"] }); toast("The flow was taken offline.", "info"); },
    onError: (e) => toast(errorText(e), "bad"),
  });
  const resync = useMutation({
    mutationFn: () => studioApi.resync(),
    onSuccess: (res) => { const bad = (res.results ?? []).filter((r) => r.status !== "published" && r.status !== "ok" && r.status !== "skipped"); toast(bad.length ? `${bad.length} flow(s) could not be re-published.` : "Deployed flows were re-published on the gateway.", bad.length ? "bad" : "ok"); },
    onError: (e) => toast(errorText(e), "bad"),
  });

  // ---- try it
  const listeners = useMemo(() => nodes.filter((n) => n.data.type === "trigger.http"), [nodes]);
  const [listenerId, setListenerId] = useState(listeners[0]?.id ?? "");
  const listener = listeners.find((l) => l.id === listenerId) ?? listeners[0];
  const cfg = (listener?.data.config ?? {}) as Record<string, unknown>;
  const methods = Array.isArray(cfg.methods) && cfg.methods.length ? (cfg.methods as unknown[]).map((m) => String(m).toUpperCase()) : ["GET"];
  const lpath = typeof cfg.path === "string" && cfg.path ? cfg.path : "/";
  const sample = (cfg.sampleRequest && typeof cfg.sampleRequest === "object" ? cfg.sampleRequest : {}) as Partial<HttpRequestSample>;
  const [method, setMethod] = useState<string>(typeof sample.method === "string" ? sample.method.toUpperCase() : methods[0]);
  const [path, setPath] = useState<string>(typeof sample.path === "string" && !/[:{]/.test(sample.path) ? sample.path : pathParams(lpath).length ? "" : lpath);
  const [body, setBody] = useState<Json | undefined>(sample.body as Json | undefined);
  const [via, setVia] = useState<"gateway" | "direct">(dep?.gateway?.status === "published" ? "gateway" : "direct");
  const [result, setResult] = useState<InvokeResponse | null>(null);
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const effMethod = methods.includes(method) ? method : methods[0];
  const effPath = path || fillPath(lpath, {});
  const invoke = useMutation({
    mutationFn: () => {
      const request: HttpRequestSample = { method: effMethod, path: effPath.split("?")[0] };
      const q = effPath.split("?")[1];
      if (q) request.query = Object.fromEntries(new URLSearchParams(q));
      else if (sample.query && typeof sample.query === "object") request.query = sample.query as Record<string, string>;
      if (!BODYLESS.has(effMethod) && body !== undefined) request.body = body;
      return studioApi.invoke(base.id, { via, request });
    },
    onMutate: () => { setInvokeError(null); setResult(null); },
    onSuccess: (r) => { setResult(r); void qc.invalidateQueries({ queryKey: ["studio", "executions"] }); },
    onError: (e) => setInvokeError(errorText(e)),
  });

  const gw = dep?.gateway;
  const gatewayUrl = gw?.status === "published" && gw.url ? joinUrl(gw.url, effPath) : "";
  const secured = settings.gateway?.security !== "none";
  const curl = gatewayUrl
    ? `curl -X ${effMethod} "${gatewayUrl}"${secured ? ' \\\n  -H "Authorization: Bearer $TOKEN"' : ""}${!BODYLESS.has(effMethod) ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body ?? {})}'` : ""}`
    : "";

  return (
    <Modal title={live ? "Deployment" : "Deploy this flow"} subtitle={txt(base.name)} onClose={onClose} width={720}
      footer={<>
        {live && <Button variant="danger" icon={CloudOff} busy={undeploy.isPending} data-action="undeploy" onClick={async () => { if (await confirmDialog({ title: "Take this flow offline?", body: "Callers will get an error until it is deployed again. The flow itself is kept.", confirmLabel: "Take offline", danger: true })) undeploy.mutate(); }}>Take offline</Button>}
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" icon={Rocket} busy={deploy.isPending} disabled={errors.length > 0} data-action="deploy" onClick={() => deploy.mutate()}>{live ? (dirty || dep!.revision !== base.revision ? "Deploy this version" : "Deploy again") : "Deploy"}</Button>
      </>}>
      <div className="mf-stack" style={{ gap: 16 }} data-testid="deploy-dialog" data-deploy-status={dep?.status ?? "draft"} data-gateway-status={gw?.status ?? ""}>
        {errors.length > 0 && (
          <Callout tone="bad" title={`${errors.length} thing${errors.length === 1 ? "" : "s"} to fix before this flow can be deployed`}>
            <IssueList issues={errors} onShow={(id) => { onClose(); onShowNode(id); }} />
          </Callout>
        )}
        {errors.length === 0 && warnings.length > 0 && <Callout tone="warn" title="Worth a look before deploying"><IssueList issues={warnings} onShow={(id) => { onClose(); onShowNode(id); }} /></Callout>}
        {failure && (
          <Callout tone="bad" title="Not deployed">
            <span>{failure}</span>
            {!!serverIssues?.length && <IssueList issues={serverIssues} onShow={(id) => { onClose(); onShowNode(id); }} />}
          </Callout>
        )}

        <section className="mf-stack" style={{ gap: 8 }}>
          <div className="mf-hstack">
            <strong>Status</strong>
            {deploymentBadge(dep, live && (dirty || dep!.revision !== base.revision))}
            {live && <span className="mf-faint" style={{ fontSize: 12.5 }}>version {dep!.revision}, since {fmtTime(dep!.deployedAt)}{dep!.deployedBy ? ` by ${txt(dep!.deployedBy)}` : ""}</span>}
          </div>
          {!dep && <p className="mf-help" style={{ margin: 0 }}>Deploying makes this flow answer real requests{dirty ? ". Your unsaved changes are saved first" : ""}.</p>}
          {live && (dirty || dep!.revision !== base.revision) && <p className="mf-help" style={{ margin: 0 }}>The live version is older than what you see in the editor. Deploy to put your changes live.</p>}
          {dep?.status === "failed" && <Callout tone="bad" title="The last deployment failed">{txt(dep.error) || "No reason was given."}</Callout>}
          <Toggle checked={publish} onChange={setPublish} label={<span>Publish on the API gateway <span className="mf-faint">({secured ? "callers need an access token" : "open, no token needed"}; change this in Settings)</span></span>} />
        </section>

        {live && (
          <section className="mf-stack" style={{ gap: 8 }}>
            <strong>Where it lives</strong>
            <dl className="mf-kv">
              <dt>Gateway</dt>
              <dd data-testid="gateway-url">
                {gw?.status === "published" && gw.url ? <span className="ws-urlline"><code>{txt(gw.url)}</code><CopyButton text={gw.url} /></span>
                  : gw?.status === "failed" ? <span><Badge tone="bad">Not published</Badge> {txt(gw.error)}</span>
                  : <span className="mf-faint">Not published on the gateway</span>}
              </dd>
              <dt>Direct (inside the network)</dt>
              <dd>{dep!.runtimeUrl ? <span className="ws-urlline"><code>{txt(dep!.runtimeUrl)}</code><CopyButton text={dep!.runtimeUrl} /></span> : <span className="mf-faint">Unknown</span>}</dd>
            </dl>
            {gw?.status === "failed" && <div><Button size="sm" icon={RefreshCw} busy={resync.isPending} onClick={() => resync.mutate()}>Publish on the gateway again</Button></div>}
          </section>
        )}

        {live && listener && (
          <section className="mf-stack" style={{ gap: 10 }} data-testid="try-it">
            <strong>Try it</strong>
            <div className="ws-test-url">
              {listeners.length > 1 && (
                <select className="mf-control mf-control-sm" aria-label="Operation" value={listener.id} onChange={(e) => { setListenerId(e.target.value); setPath(""); }} style={{ maxWidth: 180 }}>
                  {listeners.map((l) => <option key={l.id} value={l.id}>{txt(l.data.name)}</option>)}
                </select>
              )}
              <select className="mf-control mf-control-sm" aria-label="Method" value={effMethod} onChange={(e) => setMethod(e.target.value)} style={{ width: 96, flex: "none" }}>
                {methods.map((m) => <option key={m}>{m}</option>)}
              </select>
              <input className="mf-control mf-control-sm mf-control-mono" aria-label="Path" value={path} placeholder={lpath} onChange={(e) => setPath(e.target.value)} />
            </div>
            {pathParams(lpath).length > 0 && <span className="mf-help">Replace {pathParams(lpath).map((p) => `:${p}`).join(", ")} with real values, for example {lpath.replace(/[:{]([A-Za-z_][A-Za-z0-9_]*)\}?/g, "123")}.</span>}
            {!BODYLESS.has(effMethod) && <Field label="Body"><JsonEditor value={body} onChange={(v) => setBody(v as Json | undefined)} minRows={3} maxRows={10} ariaLabel="Request body" /></Field>}
            <div className="mf-hstack">
              <div className="ws-seg" role="group" aria-label="How to call it">
                <button type="button" className={via === "gateway" ? "ws-seg-on" : ""} aria-pressed={via === "gateway"} disabled={gw?.status !== "published"} onClick={() => setVia("gateway")} data-via="gateway">Through the gateway</button>
                <button type="button" className={via === "direct" ? "ws-seg-on" : ""} aria-pressed={via === "direct"} onClick={() => setVia("direct")} data-via="direct">Directly</button>
              </div>
              <Button variant="primary" size="sm" icon={Play} busy={invoke.isPending} onClick={() => invoke.mutate()} data-action="invoke">Send request</Button>
            </div>
            <span className="mf-help">{via === "gateway" ? "Sent to the public gateway address with a token of the built-in test application, exactly as an outside caller would." : "Sent straight to the flow, skipping the gateway."} This is a real call and shows up under Executions.</span>
            {invokeError && <Callout tone="bad" title="The request could not be sent">{invokeError}</Callout>}
            {result && (
              <div className="mf-stack" style={{ gap: 8 }} data-testid="invoke-result" data-invoke-status={result.status}>
                <div className="mf-hstack">
                  <Badge tone={httpTone(result.status)}>HTTP {txt(result.status)}</Badge>
                  <span className="mf-faint">{fmtDuration(result.ms)}</span>
                  <code className="mf-truncate mf-mono-sm" style={{ flex: 1, minWidth: 0 }}>{txt(result.url)}</code>
                  {result.executionId && <button type="button" className="mf-linkbtn" data-action="open-execution" onClick={() => { onClose(); onOpenExecution(result.executionId!); }}>See what happened</button>}
                </div>
                <DataView label="Response body" value={result.body} maxHeight={240} />
                <details className="ws-details"><summary>Response headers</summary><CodeBlock value={result.headers} maxHeight={180} /></details>
              </div>
            )}
          </section>
        )}

        {live && curl && (
          <section className="mf-stack" style={{ gap: 8 }}>
            <strong>Call it from outside</strong>
            <CodeBlock value={result?.curl && via === "gateway" ? result.curl : curl} wrap label="Command" />
            {secured && (
              <p className="mf-help" style={{ margin: 0 }}>
                $TOKEN is an access token from the gateway: create or pick an application, subscribe it to this API and generate a token.
                {WEAVE_GATEWAY_URL && <> <a href={WEAVE_GATEWAY_URL} target="_blank" rel="noreferrer">Open the gateway console <ExternalLink size={12} aria-hidden /></a></>}
              </p>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
