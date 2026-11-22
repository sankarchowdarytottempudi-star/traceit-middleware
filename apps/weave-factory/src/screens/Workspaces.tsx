// Workspaces group migrations. Each one can carry the environments its APIs are checked against
// and the servers its APIs will be installed on. Passwords and tokens can be set, never read back.
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api, type Environment, type Workspace } from "../api.ts";
import { num, txt } from "../lib/text.ts";
import { outcomeTone } from "../lib/migrate.ts";
import { Bar, Btn, Confirm, Dialog, Empty, Failed, Field, Head, LinkBtn, Loading, Notice, Pill, Stat, errText, useTitle } from "../migrate/ui.tsx";
import { TargetPlatforms } from "./TargetPlatforms.tsx";

const TIERS: [string, string][] = [["dev", "Development"], ["qa", "Test (QA)"], ["uat", "Acceptance (UAT)"], ["prod", "Production"]];
const isShared = (w: Workspace) => w.name === "Unassigned";
const addressOk = (v: string) => /^https?:\/\/\S+$/i.test(v.trim());

function EnvironmentForm({ workspace, onDone, onCancel }: { workspace?: string; onDone: () => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(""); const [baseUrl, setBaseUrl] = useState(""); const [token, setToken] = useState(""); const [tried, setTried] = useState(false);
  const add = useMutation({
    mutationFn: () => api.addEnvironment({ name: name.trim(), baseUrl: baseUrl.trim(), workspace, token: token.trim() || undefined }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["workspaces"] }); await qc.invalidateQueries({ queryKey: ["environments"] }); onDone(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setTried(true); if (name.trim() && addressOk(baseUrl)) add.mutate(); };
  return (
    <form className="mf-mg-stack" style={{ gap: 12 }} onSubmit={submit} noValidate>
      <div className="mf-mg-grid">
        <Field label="Name" error={tried && !name.trim() ? "Give the environment a name" : undefined} hint="For example: Test, UAT, Old platform">
          <input className="mf-mg-input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={tried && !name.trim()} maxLength={80} />
        </Field>
        <Field label="Address" error={tried && !addressOk(baseUrl) ? "Start the address with http:// or https://" : undefined} hint="The base address requests are sent to">
          <input className="mf-mg-input mf-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://" aria-invalid={tried && !addressOk(baseUrl)} inputMode="url" autoCapitalize="none" spellCheck={false} />
        </Field>
        <Field label="Access token (optional)" hint="Stored on this server and sent with test requests. It is never shown again.">
          <input className="mf-mg-input" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" />
        </Field>
      </div>
      {add.isError && <Notice tone="bad">{errText(add.error)}</Notice>}
      <div className="mf-mg-row"><Btn kind="primary" type="submit" busy={add.isPending}>Add environment</Btn><Btn onClick={onCancel}>Cancel</Btn></div>
    </form>
  );
}

type ServerDraft = { host: string; port: string; username: string; hostname: string };
const emptyServer = (): ServerDraft => ({ host: "", port: "22", username: "root", hostname: "" });
function ServersDialog({ workspace, onClose }: { workspace: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [servers, setServers] = useState<Record<string, ServerDraft>>(() => Object.fromEntries(TIERS.map(([k]) => [k, emptyServer()])));
  const [tried, setTried] = useState(false);
  const filled = TIERS.filter(([k]) => servers[k].host.trim());
  const hasNonProd = filled.some(([k]) => k !== "prod");
  const badPort = filled.some(([k]) => { const p = Number(servers[k].port); return !Number.isInteger(p) || p < 1 || p > 65535; });
  const save = useMutation({
    mutationFn: () => api.addWorkspaceConfig({ name: workspace, servers: Object.fromEntries(filled.map(([k]) => [k, { host: servers[k].host.trim(), port: Number(servers[k].port) || 22, username: servers[k].username.trim() || "root", ...(servers[k].hostname.trim() ? { hostname: servers[k].hostname.trim() } : {}) }])) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["workspaces"] }); onClose(); },
  });
  const upd = (tier: string, key: keyof ServerDraft, v: string) => setServers((s) => ({ ...s, [tier]: { ...s[tier], [key]: v } }));
  const submit = () => { setTried(true); if (hasNonProd && !badPort) save.mutate(); };
  return (
    <Dialog wide title={`Target servers for ${workspace}`} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" busy={save.isPending} onClick={submit}>Save the servers</Btn></>}>
      <p className="mf-mg-muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>The servers this workspace's APIs will be installed on. Fill in at least one of development, test or acceptance; production can be added later. Saving only records the details: nothing is installed or changed on the servers.</p>
      {TIERS.map(([k, label]) => (
        <fieldset key={k} style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 12, margin: 0, minWidth: 0 }}>
          <legend style={{ fontSize: 13, fontWeight: 700, padding: "0 6px" }}>{label}</legend>
          <div className="mf-mg-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))" }}>
            <Field label="Host"><input className="mf-mg-input mf-mono" value={servers[k].host} onChange={(e) => upd(k, "host", e.target.value)} autoCapitalize="none" spellCheck={false} placeholder="Leave empty to skip" /></Field>
            <Field label="Port"><input className="mf-mg-input mf-mono" value={servers[k].port} onChange={(e) => upd(k, "port", e.target.value)} inputMode="numeric" /></Field>
            <Field label="User name"><input className="mf-mg-input mf-mono" value={servers[k].username} onChange={(e) => upd(k, "username", e.target.value)} autoCapitalize="none" spellCheck={false} /></Field>
            <Field label="Gateway host name (optional)"><input className="mf-mg-input mf-mono" value={servers[k].hostname} onChange={(e) => upd(k, "hostname", e.target.value)} autoCapitalize="none" spellCheck={false} placeholder="api.customer.com" /></Field>
          </div>
        </fieldset>
      ))}
      <Notice>No password is kept. After saving, open the workspace's Servers page: the Factory reaches each server with its own SSH key (copy it onto the server, or give the user's password once to put it there), then installs Kubernetes and WSO2.</Notice>
      {tried && !hasNonProd && <Notice tone="bad">Fill in the host of at least one development, test or acceptance server.</Notice>}
      {tried && badPort && <Notice tone="bad">A port must be a number between 1 and 65535.</Notice>}
      {save.isError && <Notice tone="bad">{errText(save.error)}</Notice>}
    </Dialog>
  );
}

function NewWorkspaceDialog({ existing, onClose }: { existing: string[]; onClose: () => void }) {
  const [name, setName] = useState(""); const [step, setStep] = useState<"name" | "env">("name"); const [tried, setTried] = useState(false);
  const clean = name.trim();
  const taken = existing.some((n) => n.toLowerCase() === clean.toLowerCase());
  const problem = !clean ? "Give the workspace a name" : taken ? "A workspace with this name already exists" : clean.length > 80 ? "Keep the name under 80 characters" : /[^\x20-\x7E]/.test(clean) ? "Use plain letters, digits and punctuation" : "";
  return (
    <Dialog wide title="New workspace" onClose={onClose} footer={step === "name" ? <><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={() => { setTried(true); if (!problem) setStep("env"); }}>Continue</Btn></> : undefined}>
      {step === "name" ? (
        <>
          <p className="mf-mg-muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>A workspace keeps the migrations, environments and servers of one programme or customer together. It appears in the list as soon as it has a first environment or a first migration.</p>
          <Field label="Workspace name" error={tried && problem ? problem : undefined}><input className="mf-mg-input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={tried && !!problem} autoFocus /></Field>
        </>
      ) : (
        <>
          <p className="mf-mg-muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>Add the first environment of <strong style={{ color: "var(--text)" }}>{clean}</strong>: an address its migrated APIs are checked against. You can also skip this and start a migration in the new workspace instead.</p>
          <EnvironmentForm workspace={clean} onDone={onClose} onCancel={() => setStep("name")} />
          <div><LinkBtn small to={`/migrations/new?workspace=${encodeURIComponent(clean)}`}>Start a migration in this workspace instead</LinkBtn></div>
        </>
      )}
    </Dialog>
  );
}

function WorkspaceCard({ w }: { w: Workspace }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false); const [servers, setServers] = useState(false);
  const [dropEnv, setDropEnv] = useState<Environment | null>(null); const [dropServers, setDropServers] = useState(false); const [showAll, setShowAll] = useState(false);
  const delEnv = useMutation({ mutationFn: (id: string) => api.deleteEnvironment(id), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["workspaces"] }); await qc.invalidateQueries({ queryKey: ["environments"] }); setDropEnv(null); } });
  const delServers = useMutation({ mutationFn: (id: string) => api.deleteWorkspaceConfig(id), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["workspaces"] }); setDropServers(false); } });
  const shared = isShared(w);
  const migrations = showAll ? w.migrations : w.migrations.slice(0, 6);
  const tiers = TIERS.filter(([k]) => w.config?.servers?.[k]);
  return (
    <section className="mf-mg-panel mf-in" aria-label={shared ? "Shared environments" : `Workspace ${w.name}`}>
      <div className="mf-mg-panel-head">
        <h2 className="mf-mg-h2 mf-mg-wrap">{shared ? "Shared, not in a workspace" : txt(w.name)}</h2>
        {!shared && <div className="mf-mg-actions"><LinkBtn small to={`/migrations/new?workspace=${encodeURIComponent(w.name)}`} icon={<Plus size={14} aria-hidden="true" />}>New migration</LinkBtn></div>}
      </div>
      {w.total > 0 && (
        <div className="mf-mg-row" style={{ flexWrap: "wrap" }}>
          <Bar pct={w.total ? (num(w.deployed) / w.total) * 100 : 0} tone="ok" label={`Deployed migrations in ${w.name}`} />
          <span className="mf-mg-small mf-mg-muted" style={{ flex: "1 1 100%" }} data-workspace-counts>{num(w.deployed)} of {num(w.total)} deployed and finished{num(w.unfinished) ? ` · ${num(w.unfinished)} installed, not finished` : ""}{num(w.failed) ? ` · ${num(w.failed)} failed` : ""}{num(w.inProgress) ? ` · ${num(w.inProgress)} in progress` : ""}</span>
        </div>
      )}
      <div className="mf-mg-grid-2">
        <div className="mf-mg-sec">
          <h3>Migrations</h3>
          {w.migrations.length === 0 ? <p className="mf-mg-small mf-mg-muted" style={{ margin: 0 }}>{shared ? "Every migration belongs to a workspace." : "No migrations yet."}</p> : (
            <div className="mf-mg-list">
              {migrations.map((m) => (
                <Link key={m.id} to={`/migrations/${encodeURIComponent(m.id)}`} className="mf-mg-item mf-mg-item-head" style={{ textDecoration: "none", color: "inherit" }}>
                  <span className="mf-mg-item-title"><span style={{ fontWeight: 600 }}>{txt(m.name) || txt(m.apiName) || m.id}</span>{txt(m.apiName) && txt(m.apiName) !== txt(m.name) ? <span className="mf-mono mf-mg-small mf-mg-muted"> {txt(m.apiName)}</span> : null}</span>
                  <Pill tone={outcomeTone(m.outcome)}>{txt(m.outcome) || "Not started"}</Pill>
                </Link>
              ))}
              {w.migrations.length > 6 && <button type="button" className="mf-mg-item mf-mg-item-head mf-mg-muted" style={{ background: "transparent", justifyContent: "center" }} onClick={() => setShowAll((v) => !v)}>{showAll ? "Show fewer" : `Show all ${w.migrations.length}`}</button>}
            </div>
          )}
        </div>
        <div className="mf-mg-stack" style={{ gap: 16 }}>
          <div className="mf-mg-sec">
            <h3>Environments</h3>
            {w.environments.length === 0 && !adding && <p className="mf-mg-small mf-mg-muted" style={{ margin: 0 }}>None yet. An environment is an address a migrated API is checked against, such as the test gateway or the old platform.</p>}
            {w.environments.length > 0 && (
              <div className="mf-mg-list">
                {w.environments.map((e) => (
                  <div key={e.id} className="mf-mg-item" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
                    <div className="mf-mg-grow">
                      <div style={{ fontSize: 13.5, fontWeight: 600 }} className="mf-mg-wrap">{txt(e.name)}</div>
                      <div className="mf-mono mf-mg-small mf-mg-muted mf-mg-wrap">{txt(e.baseUrl)}</div>
                    </div>
                    <Pill tone={e.hasToken || e.tokenSet ? "ok" : undefined} title={e.hasToken || e.tokenSet ? "An access token is stored. It cannot be read back." : "Requests are sent without a stored token"}>{e.hasToken || e.tokenSet ? "Token set" : "No token"}</Pill>
                    <button type="button" className="mf-btn mf-mg-btn mf-mg-iconbtn" aria-label={`Remove environment ${txt(e.name)}`} onClick={() => { delEnv.reset(); setDropEnv(e); }}><Trash2 size={15} aria-hidden="true" /></button>
                  </div>
                ))}
              </div>
            )}
            {adding ? <EnvironmentForm workspace={shared ? undefined : w.name} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} /> : <div><Btn small icon={<Plus size={14} aria-hidden="true" />} onClick={() => setAdding(true)}>Add environment</Btn></div>}
          </div>
          {!shared && (
            <div className="mf-mg-sec">
              <h3>Target servers</h3>
              {tiers.length === 0 ? (
                <>
                  <p className="mf-mg-small mf-mg-muted" style={{ margin: 0 }}>None recorded. Today every migration is installed on this server's own cluster; record the customer's servers here when they are known.</p>
                  <div><Btn small icon={<Plus size={14} aria-hidden="true" />} onClick={() => setServers(true)}>Add target servers</Btn></div>
                </>
              ) : (
                <>
                  <div className="mf-mg-list">
                    {tiers.map(([k, label]) => {
                      const s = w.config?.servers?.[k];
                      return (
                        <div key={k} className="mf-mg-item" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", flexWrap: "wrap" }}>
                          <div className="mf-mg-grow">
                            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</div>
                            <div className="mf-mono mf-mg-small mf-mg-muted mf-mg-wrap">{txt(s?.username)}@{txt(s?.host)}:{txt(s?.port)}</div>
                          </div>
                          <Pill tone={s?.provisioned ? "ok" : undefined}>{s?.provisioned ? "Platform installed" : "Not installed yet"}</Pill>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mf-mg-actions">
                    <LinkBtn small kind="primary" to={`/workspaces/${encodeURIComponent(w.config!.id)}/servers`}>Servers and installation</LinkBtn>
                    <LinkBtn small to={`/workspaces/${encodeURIComponent(w.config!.id)}/releases`}>Releases</LinkBtn>
                    <Btn small kind="danger" onClick={() => { delServers.reset(); setDropServers(true); }}>Remove the servers</Btn>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {servers && <ServersDialog workspace={w.name} onClose={() => setServers(false)} />}
      {dropEnv && (
        <Confirm title="Remove this environment?" confirmLabel="Remove" danger busy={delEnv.isPending} error={delEnv.isError ? errText(delEnv.error) : undefined} onConfirm={() => delEnv.mutate(dropEnv.id)} onClose={() => setDropEnv(null)}>
          <span><strong>{txt(dropEnv.name)}</strong> and its stored token will be removed. Migrations that were verified against it keep their result.</span>
        </Confirm>
      )}
      {dropServers && w.config && (
        <Confirm title="Remove the target servers?" confirmLabel="Remove" danger busy={delServers.isPending} error={delServers.isError ? errText(delServers.error) : undefined} onConfirm={() => delServers.mutate(w.config!.id)} onClose={() => setDropServers(false)}>
          <span>The recorded servers for <strong>{txt(w.name)}</strong> will be removed from this server. Nothing changes on the servers themselves.</span>
        </Confirm>
      )}
    </section>
  );
}

export function Workspaces() {
  useTitle("Workspaces");
  const ws = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces, refetchInterval: 20000 });
  const [creating, setCreating] = useState(false);
  const all = ws.data?.workspaces ?? [];
  const real = all.filter((w) => !isShared(w));
  const shared = all.find(isShared);
  const newBtn = <Btn kind="primary" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setCreating(true)}>New workspace</Btn>;
  return (
    <>
      <Head area="Workspaces" title="Workspaces"
        subtitle="A workspace keeps one programme's migrations together with the environments its APIs are checked against and the servers they will run on."
        actions={newBtn} />
      {ws.isLoading ? <Loading rows={2} h={180} /> : ws.isError ? <Failed what="The workspaces are not available right now." error={ws.error} onRetry={() => ws.refetch()} /> : all.length === 0 ? (
        <Empty title="No workspaces yet" hint="Create one, or start a migration and name its workspace there." action={newBtn} />
      ) : (
        <>
          <div className="mf-mg-stats">
            <Stat label="Workspaces" value={real.length} />
            <Stat label="Migrations" value={real.reduce((s, w) => s + num(w.total), 0)} note={`${real.reduce((s, w) => s + num(w.deployed), 0)} deployed`} />
            <Stat label="Environments" value={all.reduce((s, w) => s + w.environments.length, 0)} note={shared?.environments.length ? `${shared.environments.length} shared by all workspaces` : undefined} />
          </div>
          {real.map((w) => <WorkspaceCard key={w.name} w={w} />)}
          {shared && (shared.environments.length > 0 || shared.migrations.length > 0) && <WorkspaceCard w={shared} />}
        </>
      )}
      {!ws.isLoading && <TargetPlatforms />}
      {creating && <NewWorkspaceDialog existing={all.map((w) => w.name)} onClose={() => setCreating(false)} />}
    </>
  );
}
