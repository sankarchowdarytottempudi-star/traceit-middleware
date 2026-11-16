// Workspaces -> a workspace -> Servers: connect the customer's servers, install Kubernetes and WSO2
// on them, and set the environments (order, approval, settings per API). Nothing typed into a
// write-only field (one-time password, settings) is kept here or shown again.
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Copy, KeyRound, Play, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../api.ts";
import { sapi, TIER_WORDS, type CustomerEnv, type CustomerServer, type CustomerWorkspace, type Job } from "./api.ts";
import { JobLine } from "./JobLine.tsx";
import { StepList } from "./StepList.tsx";
import { Btn, Confirm, Failed, Field, Head, LinkBtn, Loading, Notice, Panel, Pill, errText, useTitle } from "../migrate/ui.tsx";

const running = (w?: CustomerWorkspace) => Object.values(w?.servers ?? {}).some((s) => s.install?.state === "running");

function ServerCard({ ws, tier, s }: { ws: string; tier: string; s: CustomerServer }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["customer-ws", ws] });
  const [pub, setPub] = useState(""); const [copied, setCopied] = useState(false);
  const [fps, setFps] = useState<string[]>([]); const [match, setMatch] = useState("");
  const [pw, setPw] = useState(""); const [job, setJob] = useState<{ job: Job; what: string } | null>(null);
  const [asking, setAsking] = useState(false); const [purge, setPurge] = useState(false);
  const [statusView, setStatusView] = useState<Record<string, unknown> | null>(null);
  const key = useMutation({ mutationFn: () => sapi.publicKey(ws, tier), onSuccess: (r) => setPub(r.publicKey) });
  const scan = useMutation({ mutationFn: () => sapi.scanHostKey(ws, tier), onSuccess: (r) => { setFps(r.fingerprints ?? []); setMatch(""); } });
  const trust = useMutation({ mutationFn: (fp: string) => sapi.trustHostKey(ws, tier, fp), onSuccess: () => { setFps([]); refresh(); } });
  const putKey = useMutation({ mutationFn: () => sapi.installKey(ws, tier, pw), onSettled: () => setPw(""), onSuccess: refresh });
  const pre = useMutation({ mutationFn: () => sapi.preflight(ws, tier) });
  const inst = useMutation({ mutationFn: (dry: boolean) => sapi.install(ws, tier, dry), onSuccess: (r, dry) => { setJob({ job: r.job, what: dry ? "The dry run" : "The installation" }); refresh(); } });
  const unin = useMutation({ mutationFn: () => sapi.uninstall(ws, tier, purge), onSuccess: (r) => { setAsking(false); setJob({ job: r.job, what: "Removing WSO2" }); } });
  const stat = useMutation({ mutationFn: () => sapi.status(ws, tier), onSuccess: (r) => setStatusView(r.status ?? null) });
  const steps = s.install?.steps ?? [];
  const label = TIER_WORDS[tier] ?? tier;
  const copy = async () => { try { await navigator.clipboard.writeText(pub); setCopied(true); } catch { setCopied(false); } };

  return (
    <Panel title={label} actions={<>
      <Pill tone={s.hostKey ? "ok" : "warn"}>{s.hostKey ? "Server confirmed" : "Server not confirmed"}</Pill>
      {s.keyInstalled && <Pill tone="ok">Key on the server</Pill>}
      <Pill tone={s.provisioned ? "ok" : undefined}>{s.provisioned ? "WSO2 installed" : s.install?.state === "running" ? "Installing" : "Not installed"}</Pill>
    </>}>
      <div className="mf-mg-stack" style={{ gap: 14 }} data-testid="server-card" data-tier={tier}>
        <span className="mf-mono mf-mg-small mf-mg-wrap">{s.username}@{s.host}:{s.port}{s.hostname ? ` · gateway https://${s.hostname}` : ""}</span>

        <div className="mf-mg-sec">
          <h3>1. Give the Factory access</h3>
          <p className="mf-mg-small mf-mg-muted" style={{ margin: 0 }}>Add this public key to <span className="mf-mono">~/.ssh/authorized_keys</span> of <span className="mf-mono">{s.username}</span> on the server. The private key never leaves the build server. The user needs sudo without a password, or is root.</p>
          {pub ? (
            <div className="mf-mg-stack" style={{ gap: 6 }}>
              <textarea className="mf-mg-input mf-mono" readOnly rows={3} value={pub} data-testid="public-key" aria-label="Public key" style={{ fontSize: 12 }} />
              <span><Btn small icon={<Copy size={14} aria-hidden="true" />} onClick={copy}>{copied ? "Copied" : "Copy the key"}</Btn></span>
            </div>
          ) : <span><Btn small icon={<KeyRound size={14} aria-hidden="true" />} busy={key.isPending} onClick={() => key.mutate()}>Show the public key</Btn></span>}
          {key.isError && <Notice tone="bad">{errText(key.error)}</Notice>}
        </div>

        <div className="mf-mg-sec">
          <h3>2. Confirm it is your server</h3>
          {s.hostKey ? <span className="mf-mg-small">Confirmed: <span className="mf-mono mf-mg-wrap">{s.hostKey}</span>. A different key will stop every connection.</span> : (
            <>
              <p className="mf-mg-small mf-mg-muted" style={{ margin: 0 }}>Read the fingerprint the server shows on the network and compare it with the one on the server itself: <span className="mf-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span></p>
              <span><Btn small icon={<ShieldCheck size={14} aria-hidden="true" />} busy={scan.isPending} onClick={() => scan.mutate()}>Read the server's fingerprint</Btn></span>
              {fps.length > 0 && (
                <div className="mf-mg-stack" style={{ gap: 6 }} data-testid="fingerprints">
                  {fps.map((f) => (
                    <label key={f} className="mf-mg-row" style={{ gap: 8, cursor: "pointer", alignItems: "flex-start" }}>
                      <input type="radio" name={`fp-${tier}`} checked={match === f} onChange={() => setMatch(f)} style={{ marginTop: 3 }} />
                      <span className="mf-mono mf-mg-small mf-mg-wrap">{f}</span>
                    </label>
                  ))}
                  <span><Btn small kind="primary" disabled={!match} busy={trust.isPending} onClick={() => trust.mutate(match)}>This matches what my server shows</Btn></span>
                </div>
              )}
              {scan.data && !scan.data.ok && <Notice tone="bad">{scan.data.error}</Notice>}
              {(scan.isError || trust.isError) && <Notice tone="bad">{errText(scan.error ?? trust.error)}</Notice>}
            </>
          )}
          {s.hostKey && !s.keyInstalled && (
            <details>
              <summary className="mf-mg-small" style={{ cursor: "pointer", fontWeight: 600 }}>Or put the key on the server with the user's password, once</summary>
              <div className="mf-mg-stack" style={{ gap: 6, marginTop: 6 }}>
                <Field label="Password of the SSH user" hint="Used once to add the key, then forgotten. It is not stored or shown again.">
                  <input className="mf-mg-input" type="password" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} data-testid="one-time-password" />
                </Field>
                <span><Btn small disabled={!pw} busy={putKey.isPending} onClick={() => putKey.mutate()}>Add the key with this password</Btn></span>
                {putKey.isError && <Notice tone="bad">{errText(putKey.error)}</Notice>}
              </div>
            </details>
          )}
          {putKey.data?.ok && <Notice tone="ok"><span data-testid="key-added">{putKey.data.message}</span></Notice>}
        </div>

        <div className="mf-mg-sec">
          <h3>3. Check, then install</h3>
          <p className="mf-mg-small mf-mg-muted" style={{ margin: 0 }}>Installs Kubernetes (k3s), Helm and WSO2 API Manager with its data on a persistent volume. The WSO2 admin password is made on the server. Nothing is wiped, and running it again only adds what is missing.</p>
          <div className="mf-mg-actions">
            <Btn small disabled={!s.hostKey} busy={pre.isPending} onClick={() => pre.mutate()}>Check the server</Btn>
            <Btn small disabled={!s.hostKey || s.install?.state === "running"} busy={inst.isPending && inst.variables === true} onClick={() => inst.mutate(true)}>Dry run</Btn>
            <Btn small kind="primary" icon={<Play size={14} aria-hidden="true" />} disabled={!s.hostKey || s.install?.state === "running"} busy={inst.isPending && inst.variables === false} onClick={() => inst.mutate(false)}>{s.provisioned ? "Install again (adds what is missing)" : "Install"}</Btn>
            <Btn small disabled={!s.hostKey} busy={stat.isPending} onClick={() => stat.mutate()}>Status</Btn>
          </div>
          {pre.data && <Notice tone={pre.data.ok ? "ok" : "bad"}><span data-testid="preflight">{pre.data.message}</span></Notice>}
          {(pre.isError || inst.isError || stat.isError) && <Notice tone="bad">{errText(pre.error ?? inst.error ?? stat.error)}</Notice>}
          {job && <JobLine key={job.job.id} job={job.job} what={job.what} onEnd={(j) => { setJob((x) => (x && x.job.id === j.id ? { ...x, job: j } : x)); refresh(); }} />}
          {steps.length > 0 && (
            <div className="mf-mg-stack" style={{ gap: 6 }}>
              <span className="mf-mg-small" style={{ fontWeight: 600 }}>Steps reported by the server{s.install?.state ? ` (${s.install.state})` : ""}</span>
              <StepList steps={steps} />
            </div>
          )}
          {statusView && (
            <ul className="mf-mg-small mf-mg-wrap" style={{ margin: 0, paddingLeft: 18 }} data-testid="status">
              {Object.entries(statusView).map(([k, v]) => <li key={k}><strong>{k}</strong>: {typeof v === "object" ? JSON.stringify(v) : String(v)}</li>)}
            </ul>
          )}
        </div>

        {s.provisioned && (
          <div><Btn small kind="danger" icon={<Trash2 size={14} aria-hidden="true" />} onClick={() => { unin.reset(); setPurge(false); setAsking(true); }}>Remove WSO2 from this server</Btn></div>
        )}
        {asking && (
          <Confirm title={`Remove WSO2 from the ${label} server?`} confirmLabel="Remove" danger busy={unin.isPending} error={unin.isError ? errText(unin.error) : undefined} onConfirm={() => unin.mutate()} onClose={() => setAsking(false)}>
            <span>WSO2 and the APIs installed by the Factory are removed from <span className="mf-mono">{s.host}</span>. Kubernetes stays.</span>
            <label className="mf-mg-row" style={{ gap: 8, marginTop: 8, cursor: "pointer" }}><input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} data-testid="purge" /><span>Also delete WSO2's data (cannot be undone)</span></label>
          </Confirm>
        )}
      </div>
    </Panel>
  );
}

function Environments({ w, apis }: { w: CustomerWorkspace; apis: string[] }) {
  const qc = useQueryClient();
  const [envs, setEnvs] = useState<CustomerEnv[]>(() => [...w.environments].sort((a, b) => a.order - b.order));
  const [env, setEnv] = useState(w.environments[0]?.name ?? ""); const [apiName, setApiName] = useState(apis[0] ?? ""); const [text, setText] = useState("");
  const tiers = Object.keys(w.servers);
  const save = useMutation({ mutationFn: () => sapi.saveEnvironments(w.id, envs.map((e) => ({ name: e.name, server: e.server, approval: e.approval }))), onSuccess: () => qc.invalidateQueries({ queryKey: ["customer-ws", w.id] }) });
  const push = useMutation({ mutationFn: () => sapi.pushSettings(w.id, env, apiName, text), onSettled: () => setText("") });
  const move = (i: number, d: number) => setEnvs((l) => { const c = [...l]; const [x] = c.splice(i, 1); c.splice(i + d, 0, x); return c.map((e, k) => ({ ...e, order: k })); });
  const upd = (i: number, patch: Partial<CustomerEnv>) => setEnvs((l) => l.map((e, k) => (k === i ? { ...e, ...patch } : e)));
  return (
    <Panel title="Environments">
      <div className="mf-mg-stack" style={{ gap: 14 }} data-testid="environments">
        <p className="mf-mg-small mf-mg-muted" style={{ margin: 0 }}>Releases move through the environments in this order, one at a time. An environment that needs approval only takes a release a named person approved.</p>
        <div className="mf-mg-list">
          {envs.map((e, i) => (
            <div key={e.name} className="mf-mg-item" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "8px 10px" }} data-testid="env-row">
              <strong style={{ minWidth: 60 }}>{i + 1}. {e.name}</strong>
              <select className="mf-mg-input" style={{ width: "auto", minWidth: 140, flex: "1 1 140px" }} value={e.server} onChange={(x) => upd(i, { server: x.target.value })} aria-label={`Server of ${e.name}`}>
                {tiers.map((t) => <option key={t} value={t}>{TIER_WORDS[t] ?? t} server</option>)}
              </select>
              <label className="mf-mg-row mf-mg-small" style={{ gap: 6, cursor: "pointer" }}><input type="checkbox" checked={e.approval} onChange={(x) => upd(i, { approval: x.target.checked })} />needs approval</label>
              <span className="mf-mg-actions" style={{ marginLeft: "auto" }}>
                <button type="button" className="mf-btn mf-mg-btn mf-mg-iconbtn" aria-label={`Move ${e.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} aria-hidden="true" /></button>
                <button type="button" className="mf-btn mf-mg-btn mf-mg-iconbtn" aria-label={`Move ${e.name} down`} disabled={i === envs.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} aria-hidden="true" /></button>
              </span>
            </div>
          ))}
        </div>
        <span><Btn small kind="primary" busy={save.isPending} onClick={() => save.mutate()}>Save the order</Btn></span>
        {save.isSuccess && <Notice tone="ok">Saved.</Notice>}
        {save.isError && <Notice tone="bad">{errText(save.error)}</Notice>}

        <div className="mf-mg-sec">
          <h3>Settings of an API in an environment</h3>
          <p className="mf-mg-small mf-mg-muted" style={{ margin: 0 }}>Paste the API's settings for that environment (addresses, accounts, keys). They go straight to that environment's server and are kept there as a Kubernetes secret. Nothing is kept here, and the text is not shown again.</p>
          <div className="mf-mg-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))" }}>
            <Field label="Environment"><select className="mf-mg-input" value={env} onChange={(x) => setEnv(x.target.value)}>{w.environments.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}</select></Field>
            <Field label="API">{apis.length ? <select className="mf-mg-input" value={apiName} onChange={(x) => setApiName(x.target.value)}>{apis.map((a) => <option key={a} value={a}>{a}</option>)}</select> : <span className="mf-mg-small mf-mg-muted">No migrated API in this workspace yet.</span>}</Field>
          </div>
          <Field label="Settings (pasted, write-only)">
            <textarea className="mf-mg-input mf-mono" rows={6} value={text} onChange={(x) => setText(x.target.value)} spellCheck={false} autoComplete="off" data-testid="settings-text" placeholder={'[org.api.backend]\nurl = "https://…"'} />
          </Field>
          <span><Btn small kind="primary" disabled={!text.trim() || !apiName || !env} busy={push.isPending} onClick={() => push.mutate()}>Store on the {env} server</Btn></span>
          {push.data && <Notice tone={push.data.ok ? "ok" : "bad"}><span data-testid="settings-result">{push.data.ok ? `${push.data.keys} settings stored on the ${env} server for ${apiName}.` : push.data.help || push.data.message}</span></Notice>}
          {push.isError && <Notice tone="bad">{errText(push.error)}</Notice>}
        </div>
      </div>
    </Panel>
  );
}

export function ServersPage() {
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: ["customer-ws", id], queryFn: () => sapi.workspace(id), refetchInterval: (s) => (running(s.state.data) ? 3000 : 20000) });
  const all = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  useTitle(q.data ? `Servers · ${q.data.name}` : "Servers");
  if (q.isLoading) return <Loading rows={3} />;
  if (q.isError || !q.data) return <Failed what="The servers of this workspace could not be read." error={q.error} onRetry={() => q.refetch()} />;
  const w = q.data;
  const apis = [...new Set((all.data?.workspaces.find((x) => x.config?.id === w.id || x.name === w.name)?.migrations ?? []).map((m) => m.apiName).filter((a): a is string => !!a))];
  return (
    <>
      <Head area="Workspaces" areaTo="/workspaces" back={{ to: "/workspaces", label: "All workspaces" }} title={`Servers of ${w.name}`}
        subtitle="Connect the customer's servers, install Kubernetes and WSO2 on them, and set the environments releases move through."
        actions={<LinkBtn to={`/workspaces/${encodeURIComponent(w.id)}/releases`}>Releases</LinkBtn>} />
      <div className="mf-mg-stack">
        {Object.keys(w.servers).length === 0 && <Notice>No servers are recorded for this workspace. Add them on the Workspaces page.</Notice>}
        {Object.entries(w.servers).map(([tier, s]) => <ServerCard key={tier} ws={w.id} tier={tier} s={s} />)}
        {w.environments.length > 0 && <Environments key={w.environments.map((e) => e.name + e.order + e.server + e.approval).join()} w={w} apis={apis} />}
      </div>
    </>
  );
}
