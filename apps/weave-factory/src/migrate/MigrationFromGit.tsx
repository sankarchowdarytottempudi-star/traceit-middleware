// Start migrations from a git repository: connect it once, choose its projects, and let the tool
// work through them one after the other. Nothing is uploaded; the repository is read on this
// server's build host, and the addresses of the APIs each project calls come from its own settings files.
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, KeyRound, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, type Repo, type RepoImportResult } from "../api.ts";
import { MULE_TO_WSO2_ONLY } from "../lib/edition.ts";
import { num, txt } from "../lib/text.ts";
import { importPlan, notMigratedYet, projectState, repoFormProblems, repoState } from "../lib/migrate.ts";
import { Btn, Confirm, Empty, Failed, Field, Head, LinkBtn, Loading, Notice, Panel, Pill, SourceWays, errText, useTitle } from "./ui.tsx";

const NEW = "__new__";
function StepTitle({ n, children }: { n: number; children: string }) {
  return <span className="mf-mg-row" style={{ gap: 10 }}><span className="mf-mg-stepno">{n}</span>{children}</span>;
}
const blank = { name: "", url: "", branch: "", username: "", token: "" };

export function MigrationFromGit() {
  useTitle("Migrate from a git repository");
  const qc = useQueryClient();
  const repos = useQuery({
    queryKey: ["repos"], queryFn: api.repos,
    refetchInterval: (query) => {
      const all = query.state.data?.repos ?? [];
      return all.some((r) => r.state === "reading") ? 2500 : all.some((r) => (r.projects ?? []).some((p) => (p.migrations ?? []).some((m) => m.queued))) ? 5000 : false;
    },
  });
  const wss = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const all = useMemo(() => repos.data?.repos ?? [], [repos.data]);
  const existing = useMemo(() => (wss.data?.workspaces ?? []).map((w) => txt(w.name)).filter((n) => n && n !== "Unassigned"), [wss.data]);

  // 1. repositories
  const [sel, setSel] = useState("");
  const [formOpen, setFormOpen] = useState<boolean | null>(null);
  const [form, setForm] = useState(blank);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState("");
  const [formError, setFormError] = useState("");
  const [cardError, setCardError] = useState<{ id: string; text: string } | null>(null);
  const [tokenFor, setTokenFor] = useState("");
  const [newToken, setNewToken] = useState("");
  const [removing, setRemoving] = useState<Repo | null>(null);
  const [removeError, setRemoveError] = useState("");

  const chosen = all.find((r) => r.id === sel) ?? all.find((r) => r.state === "ready") ?? all[0];
  const showForm = formOpen ?? (repos.isSuccess && all.length === 0);
  const problems = repoFormProblems(form);
  const show = (k: keyof typeof problems) => (tried ? problems[k] : undefined);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => { setForm((f) => ({ ...f, [k]: e.target.value })); setFormError(""); };
  const reload = () => qc.invalidateQueries({ queryKey: ["repos"] });

  const connect = async () => {
    setTried(true); setFormError("");
    if (Object.keys(problems).length) return;
    setBusy("connect");
    try {
      const r = await api.connectRepo({ name: form.name.trim(), url: form.url.trim(), branch: form.branch.trim(), username: form.username.trim(), token: form.token.trim() });
      setForm(blank); setTried(false); setFormOpen(false); setSel(r.id);
      await reload();
    } catch (e) { setFormError(errText(e)); } finally { setBusy(""); }
  };
  const readAgain = async (r: Repo, token?: string) => {
    setBusy(`read:${r.id}`); setCardError(null);
    try { await api.readRepo(r.id, token ? { token } : {}); setTokenFor(""); setNewToken(""); await reload(); }
    catch (e) { setCardError({ id: r.id, text: errText(e) }); } finally { setBusy(""); }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy("remove"); setRemoveError("");
    try { await api.removeRepo(removing.id); setRemoving(null); if (sel === removing.id) setSel(""); await reload(); }
    catch (e) { setRemoveError(errText(e)); } finally { setBusy(""); }
  };

  // 2. projects of the chosen repository
  const projects = useMemo(() => (chosen?.state === "ready" ? chosen.projects ?? [] : []), [chosen]);
  const [picked, setPicked] = useState<string[] | null>(null);
  useEffect(() => { setPicked(null); setEnvironment(null); setResult(null); setStartError(""); }, [chosen?.id]);
  const ticks = picked ?? notMigratedYet(projects);
  const toggle = (path: string) => setPicked(ticks.includes(path) ? ticks.filter((p) => p !== path) : [...ticks, path]);

  // 3. how they are migrated
  const [sp] = useSearchParams();
  const asked = (sp.get("workspace") ?? "").trim();
  const [wsChoice, setWsChoice] = useState("");
  const [wsNew, setWsNew] = useState(asked);
  const askedNew = !!asked && !existing.includes(asked);
  const choice = wsChoice || (asked ? (askedNew ? NEW : asked) : existing.length ? existing[0] : NEW);
  const workspace = choice === NEW ? wsNew.trim() : choice;
  const envs = chosen?.environments ?? [];
  const [environment, setEnvironment] = useState<string | null>(null);
  const [build, setBuild] = useState(true);
  const [startTried, setStartTried] = useState(false);
  const [startError, setStartError] = useState("");
  const [result, setResult] = useState<RepoImportResult | null>(null);
  const needEnv = envs.length > 0 && environment === null;
  const wsProblem = !workspace ? "Choose a workspace or type a new one" : /[^\x20-\x7E]/.test(workspace) ? "Use plain letters, digits and punctuation in the workspace name" : "";

  const start = async () => {
    setStartTried(true); setStartError("");
    if (!chosen || !ticks.length || wsProblem || needEnv) return;
    setBusy("start");
    try {
      const r = await api.importRepo(chosen.id, { paths: ticks, workspace, environment: environment || undefined, build });
      setResult(r); setPicked([]); setStartTried(false);
      qc.invalidateQueries({ queryKey: ["migrations"] });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      await reload();
    } catch (e) { setStartError(errText(e)); } finally { setBusy(""); }
  };

  return (
    <>
      <Head area="Migrations" areaTo="/migrations" back={{ to: "/migrations", label: "All migrations" }} title="Migrate from a git repository"
        subtitle="Connect a repository once. Its projects are read on this server and migrated one after the other, and the addresses of the APIs they call are taken from the settings files in the repository." />
      <SourceWays way="git" />
      {repos.isLoading ? <Loading rows={2} h={110} /> : repos.isError ? <Failed what="The repositories are not available right now." error={repos.error} onRetry={() => repos.refetch()} /> : (
        <div className="mf-mg-wizard">
          <Panel title={<StepTitle n={1}>Connect the repository</StepTitle>}
            actions={all.length > 0 && !showForm ? <Btn small icon={<Plus size={15} aria-hidden="true" />} onClick={() => setFormOpen(true)}>Connect another</Btn> : undefined}>
            {all.length > 0 && (
              <div className="mf-mg-repos" role="radiogroup" aria-label="Connected repositories">
                {all.map((r) => {
                  const st = repoState(r);
                  const reading = r.state === "reading";
                  return (
                    <div key={r.id} className="mf-mg-repo" data-testid="repo-card" data-state={r.state} data-chosen={chosen?.id === r.id}>
                      <label className="mf-mg-repo-pick">
                        <input type="radio" name="repo" checked={chosen?.id === r.id} onChange={() => setSel(r.id)} />
                        <strong className="mf-mg-wrap">{txt(r.name)}</strong>
                        <Pill tone={st.tone}>{st.label}</Pill>
                        {!r.hasToken && <Pill title="This repository is read without signing in">No token</Pill>}
                      </label>
                      <span className="mf-mono mf-mg-small mf-mg-muted mf-mg-wrap">{txt(r.url)}{txt(r.branch) ? ` · branch ${txt(r.branch)}` : ""}</span>
                      <span className="mf-mg-small mf-mg-wrap" style={r.state === "failed" ? { color: "var(--bad)", fontWeight: 500 } : undefined} role={r.state === "failed" ? "alert" : undefined}>{st.detail}</span>
                      {tokenFor === r.id && (
                        <div className="mf-mg-row" style={{ alignItems: "flex-end" }}>
                          <span className="mf-mg-grow" style={{ maxWidth: 360 }}>
                            <Field label="New access token" hint="It replaces the stored one. It is kept on this server and is not shown again.">
                              <input className="mf-mg-input" type="password" autoComplete="off" value={newToken} onChange={(e) => setNewToken(e.target.value)} />
                            </Field>
                          </span>
                          <Btn small kind="primary" busy={busy === `read:${r.id}`} disabled={!newToken.trim()} onClick={() => void readAgain(r, newToken.trim())}>Save and read again</Btn>
                          <Btn small onClick={() => { setTokenFor(""); setNewToken(""); }}>Cancel</Btn>
                        </div>
                      )}
                      {cardError?.id === r.id && <Notice tone="bad">{cardError.text}</Notice>}
                      <div className="mf-mg-actions">
                        <Btn small icon={<RefreshCw size={14} aria-hidden="true" />} busy={busy === `read:${r.id}` && tokenFor !== r.id} disabled={reading} onClick={() => void readAgain(r)}>Read again</Btn>
                        {tokenFor !== r.id && <Btn small icon={<KeyRound size={14} aria-hidden="true" />} disabled={reading} onClick={() => { setTokenFor(r.id); setNewToken(""); setCardError(null); }}>Change the token</Btn>}
                        <Btn small icon={<Trash2 size={14} aria-hidden="true" />} disabled={reading} onClick={() => { setRemoving(r); setRemoveError(""); }}>Remove</Btn>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {showForm && (
              <form data-testid="repo-form" className="mf-mg-stack" style={{ gap: 14, marginTop: all.length ? 14 : 0 }} onSubmit={(e) => { e.preventDefault(); void connect(); }} noValidate>
                <div className="mf-mg-grid-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))" }}>
                  <Field label="Name" error={show("name")} hint="A name people will recognise, for example the team or the programme.">
                    <input className="mf-mg-input" value={form.name} maxLength={80} aria-invalid={!!show("name")} onChange={set("name")} placeholder="Integration APIs" />
                  </Field>
                  <Field label="Address of the repository" error={show("url")} hint="The address that starts with https://, as the git server shows it for cloning.">
                    <input className="mf-mg-input mf-mono" value={form.url} maxLength={500} aria-invalid={!!show("url")} onChange={set("url")} placeholder="https://git.example.com/team/apis.git" autoComplete="off" spellCheck={false} />
                  </Field>
                  <Field label="Branch" error={show("branch")} hint="Leave empty for the repository's main branch.">
                    <input className="mf-mg-input" value={form.branch} maxLength={120} aria-invalid={!!show("branch")} onChange={set("branch")} autoComplete="off" spellCheck={false} />
                  </Field>
                  <Field label="User name" hint="Only when the git server asks for one together with the token.">
                    <input className="mf-mg-input" value={form.username} maxLength={120} onChange={set("username")} autoComplete="off" spellCheck={false} />
                  </Field>
                  <Field label="Access token" error={show("token")} hint="A token that may only read the repository is enough. It is kept on this server, is not shown again and is not sent anywhere but to the git server. Leave empty for a repository anyone may read.">
                    <input className="mf-mg-input" type="password" value={form.token} aria-invalid={!!show("token")} onChange={set("token")} autoComplete="off" />
                  </Field>
                </div>
                {formError && <Notice tone="bad"><strong>The repository was not connected.</strong> {formError}</Notice>}
                <div className="mf-mg-actions">
                  <Btn kind="primary" type="submit" busy={busy === "connect"} icon={<GitBranch size={16} aria-hidden="true" />}>Connect and read it</Btn>
                  {all.length > 0 && <Btn onClick={() => { setFormOpen(false); setTried(false); setFormError(""); }}>Cancel</Btn>}
                </div>
              </form>
            )}
          </Panel>

          {chosen && (
            <Panel id="projects" title={<StepTitle n={2}>Choose the projects</StepTitle>}
              actions={projects.length > 1 ? <><Btn small onClick={() => setPicked(projects.map((p) => p.path))}>Tick all</Btn><Btn small onClick={() => setPicked([])}>Untick all</Btn></> : undefined}>
              {chosen.state === "reading" ? <Notice>The repository <strong>{txt(chosen.name)}</strong> is being read. Its projects appear here when that has finished.</Notice>
                : chosen.state === "failed" ? <Notice tone="warn">The repository <strong>{txt(chosen.name)}</strong> could not be read, so there is nothing to choose from yet. The reason is shown on its card above.</Notice>
                : projects.length === 0 ? <Empty title="No project was found in this repository" hint={"A project is recognised by its mule-artifact.json, or by a pom.xml next to src/main/mule. " + (MULE_TO_WSO2_ONLY ? "Only Mule 4 projects are migrated by this edition." : "Projects written in something else can be uploaded as a file.")} action={<LinkBtn to="/migrations/new">Upload a file instead</LinkBtn>} />
                : (
                  <>
                    <div className="mf-mg-tablewrap" data-testid="project-list">
                      <table className="mf-mg-table">
                        <thead><tr><th>Project</th><th className="mf-mg-num">Flows</th><th>Settings files</th><th>State</th></tr></thead>
                        <tbody>
                          {projects.map((p) => {
                            const st = projectState(p);
                            const m = p.migrations?.[0];
                            return (
                              <tr key={p.path} data-testid="project-row">
                                <td className="mf-mg-td-main">
                                  <label className="mf-mg-proj">
                                    <input type="checkbox" className="mf-mg-tick" style={{ marginTop: 2 }} checked={ticks.includes(p.path)} onChange={() => toggle(p.path)} aria-label={`Migrate ${txt(p.name)}`} />
                                    <span><strong className="mf-mg-wrap">{txt(p.name)}</strong><span className="mf-mono mf-mg-small mf-mg-muted mf-mg-wrap">{p.path ? p.path : "the top folder of the repository"}</span></span>
                                  </label>
                                </td>
                                <td className="mf-mg-num" data-label="Flows">{num(p.flows)}</td>
                                <td data-label="Settings files"><span className="mf-mg-row" style={{ gap: 6 }}>
                                  <span title={(p.settings ?? []).join(", ")}>{(p.settings ?? []).length || "None"}</span>
                                  {p.encrypted && <Pill tone="warn" title="Some values in the settings files are encrypted. The key is not in the repository, so these values stay unset until the owner of the API enters them.">Encrypted values</Pill>}
                                </span></td>
                                <td data-label="State">{m ? <Link to={`/migrations/${encodeURIComponent(m.id)}`} title="Open the migration"><Pill tone={st.tone}>{st.text}</Pill></Link> : <Pill tone={st.tone}>{st.text}</Pill>}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <span className="mf-mg-hint">A project that has a migration already is not ticked. Tick it to migrate it again from this repository; the earlier migration stays as it is.</span>
                    {startTried && !ticks.length && <span className="mf-mg-err" role="alert">Tick at least one project</span>}
                  </>
                )}
            </Panel>
          )}

          {chosen?.state === "ready" && projects.length > 0 && (
            <Panel title={<StepTitle n={3}>How they are migrated</StepTitle>}>
              <div className="mf-mg-grid-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))" }}>
                <Field label="Workspace" error={choice === NEW ? undefined : startTried ? wsProblem || undefined : undefined} hint="A workspace groups the migrations of one programme or team.">
                  <select className="mf-mg-input" value={choice} onChange={(e) => setWsChoice(e.target.value)}>
                    {existing.map((w) => <option key={w} value={w}>{w}</option>)}
                    <option value={NEW}>New workspace…</option>
                  </select>
                </Field>
                {choice === NEW && (
                  <Field label="Name of the new workspace" error={startTried ? wsProblem || undefined : undefined} hint="It is created with the first migration.">
                    <input className="mf-mg-input" value={wsNew} maxLength={80} aria-invalid={startTried && !!wsProblem} onChange={(e) => setWsNew(e.target.value)} />
                  </Field>
                )}
                <Field label="Take the addresses from the settings of" error={startTried && needEnv ? "Choose the settings file, or choose to set the addresses yourself" : undefined}
                  hint={envs.length ? "Each project's own settings file of this name gives the addresses of the APIs it calls, so nobody has to type them." : "No settings file was found beside the common ones, so addresses are set afterwards under \"Finish this migration\"."}>
                  <select className="mf-mg-input" value={environment ?? "__ask__"} aria-invalid={startTried && needEnv} onChange={(e) => setEnvironment(e.target.value === "__ask__" ? null : e.target.value)} disabled={!envs.length}>
                    {envs.length > 0 && <option value="__ask__" disabled>Choose…</option>}
                    {envs.map((e) => <option key={e.name} value={e.name}>{e.name} ({e.projects === projects.length ? "every project" : `${e.projects} of ${projects.length} projects`})</option>)}
                    <option value="">I set the addresses myself afterwards</option>
                  </select>
                </Field>
              </div>
              <label className="mf-mg-check" style={{ whiteSpace: "normal" }}><input type="checkbox" checked={build} onChange={(e) => setBuild(e.target.checked)} />Build each service and run its tests as soon as it is generated</label>
              <Notice>
                <strong data-testid="plan">{importPlan(ticks.length, environment ?? "", build)}</strong>
                <ul className="mf-mg-plain-list mf-mg-small">
                  <li>The repository is read on this server. Its content is not sent anywhere else.</li>
                  <li>A value that is encrypted in a settings file needs the project's own key, which is not in the repository. Such a value stays unset until the owner of the API enters it.</li>
                  <li>An operation whose old logic does more than call another API is listed under "Finish this migration", where one decision per operation completes it.</li>
                </ul>
              </Notice>
              {startError && <Notice tone="bad"><strong>Nothing was started.</strong> {startError}</Notice>}
              <div className="mf-mg-actions">
                <Btn kind="primary" busy={busy === "start"} icon={<Play size={16} aria-hidden="true" />} onClick={() => void start()}>{ticks.length === 0 ? "Migrate the ticked projects" : ticks.length === 1 ? "Migrate 1 project" : `Migrate ${ticks.length} projects`}</Btn>
                <LinkBtn to="/migrations">Cancel</LinkBtn>
              </div>
            </Panel>
          )}

          {result && (
            <Panel title="Started">
              <Notice tone={result.created.length ? "ok" : "warn"}>
                <strong>{result.created.length === 1 ? "1 migration was created" : `${result.created.length} migrations were created`} in the workspace {txt(result.workspace)}.</strong>{" "}
                {result.created.length > 1 ? "They are worked through one after the other; the list of migrations shows which one is running and which ones wait their turn." : result.created.length === 1 ? "Its steps have started." : ""}
                {result.created.length > 0 && <ul className="mf-mg-plain-list mf-mg-small">{result.created.map((c) => <li key={c.id}><Link to={`/migrations/${encodeURIComponent(c.id)}`}>{txt(c.name)}</Link></li>)}</ul>}
              </Notice>
              {result.refused.length > 0 && (
                <Notice tone="warn">
                  <strong>{result.refused.length === 1 ? "1 project was not taken." : `${result.refused.length} projects were not taken.`}</strong>
                  <ul className="mf-mg-plain-list mf-mg-small">{result.refused.map((r) => <li key={r.path}><span className="mf-mono">{r.path || "top folder"}</span>: {txt(r.error)}</li>)}</ul>
                </Notice>
              )}
              <div className="mf-mg-actions"><LinkBtn kind="primary" to={`/migrations?workspace=${encodeURIComponent(result.workspace)}`}>See the migrations</LinkBtn></div>
            </Panel>
          )}
        </div>
      )}
      {removing && (
        <Confirm title="Remove this repository?" confirmLabel="Remove" danger busy={busy === "remove"} error={removeError} onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
          <span><strong>{txt(removing.name)}</strong> is disconnected: the copy on the build server and the stored access token are deleted.</span>
          <span>Migrations that were created from it stay as they are.</span>
        </Confirm>
      )}
    </>
  );
}
