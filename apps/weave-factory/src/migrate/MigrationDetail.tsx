// One migration: where it is, what can be done next, its documents, checks, feedback and activity.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleDashed, Download, Eye, Loader2, Play, RotateCw, Trash2, TriangleAlert, X } from "lucide-react";
import { api, type ApiError, type Environment, type Migration, type OptimizeResult, type ParityResult, type Phase, type VerifyResult } from "../api.ts";
import { num, txt } from "../lib/text.ts";
import { ago, baseName, clock, dateTime, failureView, isSpec, ms, nextActions, outcomeTone, statusLabel, statusTone, type FailureView, type NextAction } from "../lib/migrate.ts";
import { Bar, Btn, Confirm, Dialog, Empty, Failed, Field, Head, KV, LinkBtn, Loading, Notice, Panel, Pill, TabBar, errText, useTitle, type TabDef } from "./ui.tsx";
import { Markdown } from "./markdown.tsx";

type Tab = "progress" | "documents" | "checks" | "feedback";
const TABS: Tab[] = ["progress", "documents", "checks", "feedback"];
const pretty = (s: unknown): string => { const t = txt(s); try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; } };
const sloLabel = (s: unknown) => (txt(s) === "fast" ? "fast" : txt(s) === "ok" ? "acceptable" : txt(s) === "slow" ? "slow" : txt(s));

function StepIcon({ status }: { status: string }) {
  if (status === "done") return <Check size={14} color="var(--ok)" aria-hidden="true" />;
  if (status === "failed") return <X size={14} color="var(--bad)" aria-hidden="true" />;
  if (status === "running") return <Loader2 size={14} className="mf-spin" color="var(--accentText)" aria-hidden="true" />;
  if (status === "action_required") return <TriangleAlert size={14} color="var(--warn)" aria-hidden="true" />;
  return <CircleDashed size={14} color="var(--faint)" aria-hidden="true" />;
}

function Timeline({ m, onAdvance, advancing }: { m: Migration; onAdvance: (phase: string, step: string) => void; advancing: string }) {
  return (
    <div>
      {(m.phases ?? []).map((ph: Phase, i) => {
        const st = txt(ph.status) || "pending";
        return (
          <div key={ph.key} className={`mf-mg-phase mf-mg-st-${st}`}>
            <div className="mf-mg-phase-rail"><span className="mf-mg-phase-mark">{st === "done" ? <Check size={14} aria-hidden="true" /> : st === "failed" ? <X size={14} aria-hidden="true" /> : st === "running" ? <Loader2 size={14} className="mf-spin" aria-hidden="true" /> : i + 1}</span><span className="mf-mg-phase-line" /></div>
            <div className="mf-mg-phase-body">
              <div className="mf-mg-phase-top">
                <span className="mf-mg-phase-title">{txt(ph.title)}</span>
                <Pill tone={statusTone(st)}>{statusLabel(st)}</Pill>
                {ph.mode === "manual" && <Pill title="A person confirms the steps of this phase">Needs a person</Pill>}
                <span className="mf-mg-small mf-mg-muted">{Math.round(num(ph.percent))}%{ph.finishedAt ? ` · finished ${ago(ph.finishedAt)}` : ph.startedAt ? ` · started ${ago(ph.startedAt)}` : ""}</span>
              </div>
              {ph.detail ? <div className="mf-mg-step-detail">{txt(ph.detail)}</div> : null}
              <ul className="mf-mg-steps">
                {(ph.steps ?? []).map((s) => (
                  <li key={s.key} className="mf-mg-step">
                    <StepIcon status={txt(s.status)} />
                    <span className="mf-mg-grow"><span>{txt(s.title)}</span>{s.detail ? <span className="mf-mg-step-detail"> · {txt(s.detail)}</span> : null}</span>
                    {s.status === "action_required" && ph.mode === "manual" && <Btn small busy={advancing === `${ph.key}/${s.key}`} disabled={!!m.busy} onClick={() => onAdvance(ph.key, s.key)}>Mark as done</Btn>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// A failed or blocked step: what happened, why, what to do, the step again, and the tool's own output.
function WhatNow({ v, disabled, busy, onRetry }: { v: FailureView; disabled: boolean; busy: boolean; onRetry: (id: NextAction["id"]) => void }) {
  return (
    <Panel title={v.title}>
      <div className="mf-mg-stack" style={{ gap: 12 }} data-testid="what-now">
        <Notice tone={v.blocked ? "warn" : "bad"}><strong>{v.what}</strong>{v.why ? <span style={{ display: "block", marginTop: 2 }}>{v.why}</span> : null}</Notice>
        <div className="mf-mg-sec" style={{ marginTop: 0 }}>
          <h3>What you can do</h3>
          <ol style={{ margin: "6px 0 0", paddingLeft: 20, display: "grid", gap: 6, fontSize: 13.5, lineHeight: 1.5 }}>{v.todo.map((t, i) => <li key={i} className="mf-mg-wrap">{t}</li>)}</ol>
        </div>
        {v.retry && <div className="mf-mg-actions"><Btn kind="primary" icon={<RotateCw size={14} aria-hidden="true" />} disabled={disabled} busy={busy} onClick={() => onRetry(v.retry!.id)}>{v.retry.label}</Btn></div>}
        {v.output && (
          <details>
            <summary className="mf-mg-small" style={{ cursor: "pointer", fontWeight: 600 }}>Tool output</summary>
            <pre className="mf-mono mf-mg-pre" style={{ maxHeight: 280, marginTop: 8 }} tabIndex={0}>{v.output}</pre>
          </details>
        )}
      </div>
    </Panel>
  );
}

function Activity({ m }: { m: Migration }) {
  const box = useRef<HTMLDivElement>(null);
  const log = (m.log ?? []).slice(-300);
  const key = `${log.length}/${txt(log[log.length - 1]?.t)}`;
  useEffect(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; }, [key]);
  return (
    <div ref={box} className="mf-mono mf-mg-log" style={{ maxHeight: 420 }} tabIndex={0} role="log" aria-label="Activity of this migration">
      {log.length === 0 ? <div className="mf-mg-logempty">Nothing has happened yet. Run the first step to begin.</div> : log.map((l, i) => {
        const lv = ["error", "warn", "info", "debug"].includes(txt(l.level)) ? txt(l.level) : "none";
        return <div key={i} className="mf-mg-logline"><span className="mf-mg-logtime" title={txt(l.t)}>{clock(l.t, true)}</span><span className={`mf-mg-loglevel mf-mg-lv-${lv}`}>{lv === "none" ? "" : lv}</span><span className="mf-mg-logtext">{txt(l.line)}</span></div>;
      })}
    </div>
  );
}

// ---- documents
function Documents({ id }: { id: string }) {
  const docs = useQuery({ queryKey: ["migration-docs", id], queryFn: () => api.docs(id) });
  const [view, setView] = useState<string | null>(null);
  const body = useQuery({ queryKey: ["migration-doc", id, view], queryFn: () => api.doc(id, view!), enabled: !!view });
  const list = docs.data?.docs ?? [];
  return (
    <>
      {docs.isLoading ? <Loading rows={2} /> : docs.isError ? <Failed what="The documents are not available right now." error={docs.error} onRetry={() => docs.refetch()} /> : list.length === 0 ? (
        <div className="mf-mg-tablewrap"><Empty title="No documents yet" hint="They are written when the source has been read. Run the first step on the Progress tab." /></div>
      ) : (
        <div className="mf-mg-list">
          {list.map((d) => (
            <div key={d.name} className="mf-mg-item"><div className="mf-mg-item-head" style={{ cursor: "default" }}>
              <span className="mf-mono mf-mg-item-title">{txt(d.name)}</span>
              <Btn small icon={<Eye size={14} aria-hidden="true" />} onClick={() => setView(d.name)}>View</Btn>
              <a className="mf-btn mf-mg-btn mf-mg-btn-sm" href={api.docUrl(id, d.name)} download={d.name}><Download size={14} aria-hidden="true" />Download</a>
            </div></div>
          ))}
        </div>
      )}
      {view && (
        <Dialog wide title={view} onClose={() => setView(null)} footer={<><a className="mf-btn mf-mg-btn" href={api.docUrl(id, view)} download={view}><Download size={15} aria-hidden="true" />Download</a><Btn kind="primary" onClick={() => setView(null)}>Close</Btn></>}>
          {body.isLoading ? <Loading rows={3} h={40} /> : body.isError ? <Failed what="This document cannot be shown." error={body.error} onRetry={() => body.refetch()} /> :
            /\.(md|markdown)$/i.test(view) ? <Markdown source={body.data ?? ""} /> : <pre className="mf-mono mf-mg-pre">{/\.json$/i.test(view) ? pretty(body.data) : body.data}</pre>}
        </Dialog>
      )}
    </>
  );
}

// ---- checks: verify against an environment, compare with the old API, performance
function Checks({ m, onChanged }: { m: Migration; onChanged: () => void }) {
  const qc = useQueryClient();
  const envs = useQuery({ queryKey: ["environments"], queryFn: api.environments });
  const list: Environment[] = envs.data?.environments ?? [];
  const [envId, setEnvId] = useState("");
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState(txt(m.testBasePath) ? `${txt(m.testBasePath)}/` : "/");
  const [body, setBody] = useState("");
  const [askOptimize, setAskOptimize] = useState(false);
  const [replace, setReplace] = useState("");
  const chosen = envId || list[0]?.id || "";
  const req = { envId: chosen, method, path, headers: {} as Record<string, string>, body: method === "GET" ? undefined : body };
  const verify = useMutation<VerifyResult, ApiError>({ mutationFn: () => api.verify(m.id, req), onSuccess: onChanged });
  const parity = useMutation<ParityResult, ApiError>({ mutationFn: () => api.parity(m.id, req) });
  const optimize = useMutation<OptimizeResult, ApiError, boolean>({
    mutationFn: (confirm) => api.optimize(m.id, confirm),
    onSuccess: () => { setAskOptimize(false); setReplace(""); onChanged(); },
    onError: (e) => { if (e.body?.needsConfirm) { setAskOptimize(false); setReplace(txt(e.message)); } },
  });
  const addEnv = useMutation<Environment, ApiError, { name: string; baseUrl: string }>({
    mutationFn: (v) => api.addEnvironment({ ...v, workspace: txt(m.workspace) || undefined }),
    onSuccess: (e) => { qc.invalidateQueries({ queryKey: ["environments"] }); qc.invalidateQueries({ queryKey: ["workspaces"] }); setEnvId(e.id); },
  });
  const discovered = (m.discoveredEnvs ?? []).flatMap((e) => (e.candidates ?? []).map((c) => ({ name: txt(e.name), host: txt(c) })));
  const known = new Set(list.map((e) => txt(e.baseUrl).replace(/^https?:\/\//, "").replace(/\/$/, "")));
  const noEnv = !chosen;
  return (
    <div className="mf-mg-stack">
      <Panel title="Check against an environment">
        {m.verifiedEnv ? <Notice tone="ok">Verified against <strong>{txt(m.verifiedEnv)}</strong>{m.verifiedAt ? ` on ${dateTime(m.verifiedAt)}` : ""}{m.verifyMs ? ` (${ms(m.verifyMs)})` : ""}.</Notice>
          : <p className="mf-mg-sub" style={{ fontSize: 13.5 }}>Choose an environment and a request. The request is sent to that environment from this server; a successful answer marks the migration as verified.</p>}
        {envs.isError ? <Failed what="The environments are not available right now." error={envs.error} onRetry={() => envs.refetch()} /> : (
          <>
            <div className="mf-mg-grid-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))" }}>
              <Field label="Environment" hint={list.length === 0 ? "No environment is registered yet. Add one on the Workspaces screen, or pick one found in the source below." : undefined}>
                <select className="mf-mg-input" value={chosen} onChange={(e) => setEnvId(e.target.value)} disabled={list.length === 0}>
                  {list.length === 0 && <option value="">None registered</option>}
                  {list.map((e) => <option key={e.id} value={e.id}>{txt(e.name)} · {txt(e.baseUrl)}</option>)}
                </select>
              </Field>
              <Field label="Method"><select className="mf-mg-input" value={method} onChange={(e) => setMethod(e.target.value)}>{["GET", "POST", "PUT", "PATCH", "DELETE"].map((x) => <option key={x}>{x}</option>)}</select></Field>
              <Field label="Path" hint="Starts with a slash; added to the environment's address."><input className="mf-mg-input mf-mono" value={path} onChange={(e) => setPath(e.target.value)} /></Field>
            </div>
            {method !== "GET" && (
              <>
                <Notice tone="warn">This request can change data in the chosen environment. Use a test environment for anything other than reading.</Notice>
                <Field label="Request body"><textarea className="mf-mg-input mf-mono" rows={5} value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} /></Field>
              </>
            )}
            <div className="mf-mg-actions">
              <Btn kind="primary" busy={verify.isPending} disabled={noEnv || !path.startsWith("/")} onClick={() => verify.mutate()}>Send and verify</Btn>
              <Btn busy={parity.isPending} disabled={noEnv || !path.startsWith("/")} onClick={() => parity.mutate()} title="Sends the same request to the old API and to the migrated one and compares the answers">Compare with the old API</Btn>
            </div>
          </>
        )}
        {verify.isError && <Notice tone="bad">{errText(verify.error)}</Notice>}
        {verify.data && (
          <div className="mf-mg-stack" style={{ gap: 8 }}>
            <Notice tone={verify.data.ok ? "ok" : "bad"}><strong>{verify.data.ok ? "Verified." : "Not verified."}</strong> The environment answered {num(verify.data.status) || "nothing"} in {ms(verify.data.ms)} ({sloLabel(verify.data.slo)}).{verify.data.finding ? ` ${txt(verify.data.finding.root_cause)} ${txt(verify.data.finding.fix)}` : ""}</Notice>
            <pre className="mf-mono mf-mg-pre" style={{ maxHeight: 300 }}>{pretty(verify.data.body) || "The answer was empty."}</pre>
          </div>
        )}
        {parity.isError && <Notice tone="bad">{errText(parity.error)}</Notice>}
        {parity.data && (
          <div className="mf-mg-stack" style={{ gap: 8 }}>
            <Notice tone={parity.data.match ? "ok" : "warn"}><strong>{parity.data.match ? "The answers match." : `The answers differ in ${(parity.data.diff ?? []).length} place${(parity.data.diff ?? []).length === 1 ? "" : "s"}.`}</strong> Old API: {num(parity.data.legacy?.status)} in {ms(parity.data.legacy?.ms)}. Migrated API: {num(parity.data.migrated?.status)} in {ms(parity.data.migrated?.ms)}.</Notice>
            {(parity.data.diff ?? []).length > 0 && <pre className="mf-mono mf-mg-pre" style={{ maxHeight: 260 }}>{(parity.data.diff ?? []).map((d) => { const o = d as Record<string, unknown>; return typeof d === "object" && d ? `${txt(o.path)}: old = ${txt(o.legacy)} | migrated = ${txt(o.migrated)}` : txt(d); }).join("\n")}</pre>}
          </div>
        )}
        {discovered.length > 0 && (
          <div className="mf-mg-sec">
            <h3>Environments found in the uploaded source</h3>
            <span className="mf-mg-hint">Select one to register it for this workspace, so it can be chosen above.</span>
            <div className="mf-mg-chips">
              {discovered.map((d, i) => known.has(d.host.replace(/^https?:\/\//, "").replace(/\/$/, "")) ? <Pill key={i} tone="ok">{d.name}: {d.host} (registered)</Pill> : (
                <button key={i} type="button" className="mf-btn mf-mg-btn mf-mg-btn-sm mf-mono" disabled={addEnv.isPending} onClick={() => addEnv.mutate({ name: d.name, baseUrl: /^https?:\/\//.test(d.host) ? d.host : `https://${d.host}` })}>{d.name}: {d.host}</button>
              ))}
            </div>
            {addEnv.isError && <Notice tone="bad">{errText(addEnv.error)}</Notice>}
          </div>
        )}
      </Panel>
      <Panel title="Performance">
        <p className="mf-mg-sub" style={{ fontSize: 13.5 }}>Targets: an answer within 250 ms is ideal, within 1 second is the limit. Optimising measures the deployed service, adds a second replica on the cluster and measures again.</p>
        {m.optimization && <Notice tone={m.optimization.meetsTarget ? "ok" : "warn"}>Last run{m.optimization.at ? ` ${ago(m.optimization.at)}` : ""}: {ms(m.optimization.beforeMs)} before, {ms(m.optimization.afterMs)} after ({(m.optimization.actions ?? []).map((a) => txt(a)).join(", ") || "no change"}). Target {m.optimization.meetsTarget ? "met" : "missed"}.</Notice>}
        <div className="mf-mg-actions"><Btn disabled={!!m.busy} onClick={() => setAskOptimize(true)}>Optimise performance…</Btn></div>
        {optimize.data && <Notice tone={optimize.data.meetsTarget ? "ok" : "warn"}>Before {ms(optimize.data.beforeMs)}, after {ms(optimize.data.afterMs)}. {(optimize.data.actions ?? []).map((a) => txt(a)).join(", ")}. Target {optimize.data.meetsTarget ? "met" : "still missed"}.</Notice>}
        {optimize.isError && !optimize.error.body?.needsConfirm && <Notice tone="bad">{errText(optimize.error)}</Notice>}
      </Panel>
      {askOptimize && (
        <Confirm title="Optimise performance?" confirmLabel="Measure and add a replica" busy={optimize.isPending} onClose={() => setAskOptimize(false)} onConfirm={() => optimize.mutate(false)}>
          <span>This changes the running service <span className="mf-mono">{txt(m.apiName)}</span>: it is measured, scaled to two replicas on the cluster, and measured again.</span>
          <span className="mf-mg-muted">It only works for a migration that is deployed.</span>
        </Confirm>
      )}
      {replace && (
        <Confirm danger title="This API belongs to another migration" confirmLabel="Change it anyway" busy={optimize.isPending} onClose={() => setReplace("")} onConfirm={() => optimize.mutate(true)}>
          <span>{replace}</span>
        </Confirm>
      )}
    </div>
  );
}

// ---- feedback
function Feedback({ m }: { m: Migration }) {
  const qc = useQueryClient();
  const fb = useQuery({ queryKey: ["migration-feedback", m.id], queryFn: () => api.feedback(m.id) });
  const [scope, setScope] = useState("api");
  const [summary, setSummary] = useState("");
  const [mistakes, setMistakes] = useState("");
  const add = useMutation({
    mutationFn: () => api.addFeedback(m.id, { scope, summary: summary.trim(), phase: txt(m.progress?.majorPhaseKey) || "document", mistakes: mistakes.split(/\n|,/).map((s) => s.trim()).filter(Boolean), technology: txt(m.technology) || undefined }),
    onSuccess: () => { setSummary(""); setMistakes(""); qc.invalidateQueries({ queryKey: ["migration-feedback", m.id] }); qc.invalidateQueries({ queryKey: ["knowledge"] }); },
  });
  const list = fb.data?.feedback ?? [];
  const scopeWord = (s: string) => (s === "functional" ? "Shared with every workspace" : s === "workspace" ? "This workspace only" : "This API only");
  return (
    <div className="mf-mg-grid-2">
      <Panel title="Tell the tool what it got wrong">
        <p className="mf-mg-sub" style={{ fontSize: 13.5 }}>Feedback becomes a lesson that is applied the next time a migration is generated. It is stored on this server.</p>
        <Field label="Who should learn from this?">
          <select className="mf-mg-input" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="api">Only this API</option>
            <option value="workspace">Only this workspace{m.workspace ? ` (${txt(m.workspace)})` : ""}</option>
            <option value="functional">Every workspace that migrates the same technology</option>
          </select>
        </Field>
        <Field label="What went wrong?"><textarea className="mf-mg-input" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="For example: the mapping for the booking date used the wrong source field" /></Field>
        <Field label="Specific mistakes (optional)" hint="One per line."><textarea className="mf-mg-input" rows={3} value={mistakes} onChange={(e) => setMistakes(e.target.value)} /></Field>
        {scope === "functional" && <Notice tone="warn">A shared lesson is visible in every workspace. Do not put names, addresses or identifiers in it.</Notice>}
        {add.isError && <Notice tone="bad">{errText(add.error)}</Notice>}
        {add.isSuccess && <Notice tone="ok">Thank you. The lesson was recorded.</Notice>}
        <div className="mf-mg-actions"><Btn kind="primary" busy={add.isPending} disabled={!summary.trim()} onClick={() => add.mutate()}>Send feedback</Btn></div>
      </Panel>
      <Panel title="Feedback on this migration">
        {fb.isLoading ? <Loading rows={2} /> : fb.isError ? <Failed what="The feedback is not available right now." error={fb.error} onRetry={() => fb.refetch()} /> : list.length === 0 ? <Empty title="No feedback yet" hint="Feedback given here appears in the knowledge base." /> : (
          <div className="mf-mg-stack" style={{ gap: 10 }}>
            {list.map((f) => (
              <div key={f.id} className="mf-mg-card">
                <div className="mf-mg-row" style={{ gap: 8 }}><Pill tone={f.scope === "functional" ? "ok" : f.scope === "workspace" ? "sys" : undefined}>{scopeWord(txt(f.scope))}</Pill>{f.status && <Pill tone={f.status === "applied" ? "ok" : undefined}>{f.status === "applied" ? "Applied" : "Waiting to be applied"}</Pill>}<span className="mf-mg-small mf-mg-faint">{ago(f.createdAt)}</span></div>
                <p className="mf-mg-wrap" style={{ margin: 0, fontSize: 13.5, fontWeight: 600, lineHeight: 1.5 }}>{txt(f.summary)}</p>
                {(f.mistakes ?? []).length > 0 && <ul className="mf-mg-small mf-mg-muted mf-mg-wrap" style={{ margin: 0, paddingLeft: 18 }}>{f.mistakes!.map((x, i) => <li key={i}>{txt(x)}</li>)}</ul>}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

// ---- the screen
const CONFIRM_TEXT: Record<string, { title: string; label: string; body: string }> = {
  spec: { title: "Generate from the specification?", label: "Generate", body: "The documents and the service code of this migration are written again from the uploaded specification. Nothing is deployed." },
  scaffold: { title: "Generate the service?", label: "Generate the service", body: "The service code of this migration is written from the documents and the mapping. If it was generated before, it is replaced. Nothing is deployed." },
  autorun: { title: "Read the source and generate the service?", label: "Run both steps", body: "The source is read, the documents are written, and the service code is generated. Nothing is deployed." },
  test: { title: "Build and run the tests?", label: "Run the tests", body: "The generated service is built and its tests are run on this server. This takes a few minutes and uses the build machine; nothing is deployed." },
  deploy: { title: "Deploy to the cluster?", label: "Deploy", body: "The image is built and the service is installed on the cluster. If a service with this name is already running, it is replaced by this version." },
};

export function MigrationDetail() {
  const { id: raw } = useParams();
  const id = raw ?? "";
  const nav = useNavigate();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.includes(sp.get("tab") as Tab) ? sp.get("tab") : "progress") as Tab;
  const setTab = (t: Tab) => { const n = new URLSearchParams(); if (t !== "progress") n.set("tab", t); setSp(n, { replace: true }); };
  const mq = useQuery({ queryKey: ["migration", id], queryFn: () => api.migration(id), enabled: !!id, refetchInterval: (q) => (q.state.data?.busy ? 2500 : 15000) });
  const m = mq.data;
  useTitle(txt(m?.name) || "Migration");
  const estate = useQuery({ queryKey: ["estate"], queryFn: () => api.estate(), staleTime: 30000 });
  const live = !!m?.apiName && (estate.data?.apis ?? []).some((a) => a.name === m.apiName && a.migrationId === m.id);

  const [ask, setAsk] = useState<NextAction["id"] | "autorun" | null>(null);
  const [replace, setReplace] = useState<{ phase: string; text: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["migration", id] }); qc.invalidateQueries({ queryKey: ["migrations"] }); qc.invalidateQueries({ queryKey: ["migration-docs", id] }); };
  const run = useMutation<Awaited<ReturnType<typeof api.run>>, ApiError, { phase: string; confirm?: boolean }>({
    mutationFn: (v) => api.run(id, v.phase, !!v.confirm),
    onSuccess: (r, v) => { setAsk(null); setReplace(null); setNote(r.ran && r.ran !== v.phase ? "The name of the API is not known yet, so only the documents are being written. Generate the service once they are ready." : ""); refresh(); },
    onError: (e, v) => { if (e.body?.needsConfirm) { setAsk(null); setReplace({ phase: v.phase, text: txt(e.message) }); } },
  });
  const advance = useMutation<Migration, ApiError, { phase: string; step: string }>({ mutationFn: (v) => api.advance(id, v), onSuccess: refresh });
  const del = useMutation<{ ok: boolean }, ApiError>({ mutationFn: () => api.deleteMigration(id), onSuccess: () => { qc.invalidateQueries({ queryKey: ["migrations"] }); qc.invalidateQueries({ queryKey: ["workspaces"] }); nav("/migrations"); } });

  // documents appear while a step runs: refresh the list when the migration stops being busy
  const wasBusy = useRef(false);
  useEffect(() => { if (wasBusy.current && m && !m.busy) qc.invalidateQueries({ queryKey: ["migration-docs", id] }); wasBusy.current = !!m?.busy; }, [m, id, qc]);

  const actions = useMemo(() => (m ? nextActions(m) : []), [m]);
  const failure = useMemo(() => (m ? failureView(m) : null), [m]);
  const notFound = mq.isError && (mq.error as ApiError).status === 404;
  if (mq.isLoading) return <><Head area="Migrations" areaTo="/migrations" back={{ to: "/migrations", label: "All migrations" }} title="Migration" /><Loading rows={3} h={110} /></>;
  if (notFound) return <><Head area="Migrations" areaTo="/migrations" back={{ to: "/migrations", label: "All migrations" }} title="Migration" /><div className="mf-mg-tablewrap"><Empty title="This migration does not exist" hint="It may have been deleted." action={<LinkBtn small to="/migrations">See all migrations</LinkBtn>} /></div></>;
  if (mq.isError || !m) return <><Head area="Migrations" areaTo="/migrations" back={{ to: "/migrations", label: "All migrations" }} title="Migration" /><Failed what="This migration is not available right now." error={mq.error} onRetry={() => mq.refetch()} /></>;

  const p = m.progress ?? ({} as Migration["progress"]);
  const pct = Math.round(num(p.overallPercent) * 10) / 10;
  const outcome = txt(p.outcome) || "In progress";
  const now = txt(p.currentStep), next = txt(p.nextStep);
  const canAuto = !isSpec(m) && txt((m.phases ?? []).find((x) => x.key === "document")?.status) !== "done";
  const start = (a: NextAction["id"] | "autorun") => { setNote(""); run.reset(); if (a === "document") run.mutate({ phase: "document" }); else setAsk(a); };
  const tabs: TabDef<Tab>[] = [{ id: "progress", label: "Progress" }, { id: "documents", label: "Documents" }, { id: "checks", label: "Verify and compare" }, { id: "feedback", label: "Feedback" }];
  const host = typeof location !== "undefined" ? location.hostname : "";

  return (
    <>
      <Head area="Migrations" areaTo="/migrations" back={{ to: "/migrations", label: "All migrations" }} title={txt(m.name) || txt(m.apiName) || m.id}
        subtitle={<span className="mf-mg-row" style={{ gap: 8 }}>
          <Pill tone={outcomeTone(outcome)}>{outcome}</Pill>{m.busy && <Pill tone="accent"><Loader2 size={12} className="mf-spin" aria-hidden="true" />A step is running</Pill>}
          {m.apiName ? <span className="mf-mono mf-mg-small">{txt(m.apiName)}</span> : null}{m.workspace ? <span className="mf-mg-small">{txt(m.workspace)}</span> : null}
        </span>}
        actions={<>
          {live && <LinkBtn to={`/estate/${encodeURIComponent(txt(m.apiName))}`}>Open the running API</LinkBtn>}
          <Btn kind="danger" icon={<Trash2 size={15} aria-hidden="true" />} onClick={() => { del.reset(); setAsking(true); }}>Delete</Btn>
        </>} />

      <Panel>
        <div className="mf-mg-row" style={{ gap: 14 }}>
          <span className="mf-disp" style={{ fontSize: 30, fontWeight: 800 }}>{pct}%</span>
          <span className="mf-mg-grow" style={{ display: "flex", flexDirection: "column", gap: 8, flexBasis: 220 }}>
            <span className="mf-mg-row"><Bar pct={pct} large tone={outcome === "Failed" ? "bad" : p.done ? "ok" : "accent"} label="Overall progress" /></span>
            <span className="mf-mg-small mf-mg-muted mf-mg-wrap"><strong style={{ color: "var(--text)" }}>{txt(p.majorPhase) || "Not started"}</strong>{now ? <> · now: {now}</> : null}{next ? <> · next: {next}</> : null}</span>
          </span>
        </div>
        <KV rows={[
          ["Source", `${txt(m.technology) && txt(m.technology) !== "unknown" ? txt(m.technology) : txt(m.sourceType) === "spec" ? "written specification" : "not recognised yet"}${m.sourceFile ? ` · ${baseName(m.sourceFile)}` : ""}`],
          ["Target", txt(m.targetTech) || "wso2"],
          ["Estimate", m.estimateDays ? `${num(m.estimateDays)} days by hand` : ""],
          ["Lessons applied", m.lessonsApplied ? String(num(m.lessonsApplied)) : ""],
          ["Created", m.createdAt ? `${dateTime(m.createdAt)} (${ago(m.createdAt)})` : ""],
          ["Last change", m.updatedAt ? ago(m.updatedAt) : ""],
          ["Test address", m.testNodePort ? <span className="mf-mono mf-mg-small mf-mg-wrap">http://{host}:{txt(m.testNodePort)}{txt(m.testBasePath)}</span> : ""],
          ["Running API", live ? <Link className="mf-mono mf-mg-name" to={`/estate/${encodeURIComponent(txt(m.apiName))}`}>{txt(m.apiName)}</Link> : ""],
        ]} />
      </Panel>

      <TabBar tabs={tabs} value={tab} onChange={setTab} label="Sections of this migration" />
      {tab === "progress" && (
        <div className="mf-mg-stack">
          {failure && !m.busy && <WhatNow v={failure} disabled={!!m.busy} busy={run.isPending && run.variables?.phase === failure.retry?.id} onRetry={(a) => start(a)} />}
          <Panel title="What you can do next">
            {m.busy ? <Notice><span className="mf-mg-row" style={{ gap: 8 }}><Loader2 size={14} className="mf-spin" aria-hidden="true" />A step is running. This screen updates by itself; the activity below shows what is happening.</span></Notice> : null}
            <div className="mf-mg-stack" style={{ gap: 10 }}>
              {actions.map((a) => (
                <div key={a.id} className="mf-mg-row" style={{ alignItems: "flex-start" }}>
                  <Btn kind={a.primary ? "primary" : "default"} icon={<Play size={14} aria-hidden="true" />} disabled={!!m.busy} busy={run.isPending && run.variables?.phase === a.id} onClick={() => start(a.id)} style={{ minWidth: 0, whiteSpace: "normal", height: "auto", minHeight: 38, padding: "8px 14px", textAlign: "left" }}>{a.label}</Btn>
                  <span className="mf-mg-hint mf-mg-grow" style={{ flexBasis: 220, paddingTop: 9 }}>{a.hint}</span>
                </div>
              ))}
              {canAuto && <div className="mf-mg-row"><button type="button" className="mf-mg-back" disabled={!!m.busy} onClick={() => start("autorun")}>Or run reading and generating in one go</button></div>}
            </div>
            {note && <Notice>{note}</Notice>}
            {run.isError && !run.error.body?.needsConfirm && <Notice tone="bad">{run.error.status === 409 ? "Another step is still running. Wait for it to finish, then try again." : errText(run.error)}</Notice>}
            {advance.isError && <Notice tone={advance.error.status === 409 ? "warn" : "bad"}>{errText(advance.error)}</Notice>}
          </Panel>
          <div className="mf-mg-grid-2">
            <Panel title="Phases and steps"><Timeline m={m} advancing={advance.isPending ? `${advance.variables?.phase}/${advance.variables?.step}` : ""} onAdvance={(phase, step) => advance.mutate({ phase, step })} /></Panel>
            <Panel title="Activity" actions={m.busy ? <Pill tone="accent">Live</Pill> : undefined}><Activity m={m} /></Panel>
          </div>
        </div>
      )}
      {tab === "documents" && <Documents id={id} />}
      {tab === "checks" && <Checks m={m} onChanged={refresh} />}
      {tab === "feedback" && <Feedback m={m} />}

      {ask && CONFIRM_TEXT[ask] && (
        <Confirm title={CONFIRM_TEXT[ask].title} confirmLabel={CONFIRM_TEXT[ask].label} danger={ask === "deploy"} busy={run.isPending} onClose={() => setAsk(null)} onConfirm={() => run.mutate({ phase: ask })}
          error={run.isError && !run.error.body?.needsConfirm ? errText(run.error) : undefined}>
          <span>{CONFIRM_TEXT[ask].body}</span>
          {m.apiName ? <span className="mf-mg-muted">API name: <span className="mf-mono">{txt(m.apiName)}</span></span> : null}
        </Confirm>
      )}
      {replace && (
        <Confirm danger title="This API name is already in use" confirmLabel="Replace it" busy={run.isPending} onClose={() => setReplace(null)} onConfirm={() => run.mutate({ phase: replace.phase, confirm: true })}>
          <span>{replace.text}</span>
          <span className="mf-mg-muted">Continuing overwrites what the other migration produced under that name.</span>
        </Confirm>
      )}
      {asking && (
        <Confirm danger title="Delete this migration?" confirmLabel="Delete" busy={del.isPending} onClose={() => setAsking(false)} onConfirm={() => del.mutate()}
          error={del.isError ? (del.error.status === 409 ? errText(del.error) : `It could not be deleted. ${errText(del.error)}`) : undefined}>
          <span>The migration <strong>{txt(m.name) || m.id}</strong>, its uploaded source and its documents are removed from this list. This cannot be undone.</span>
          <span className="mf-mg-muted">A migration that is deployed or has a step running cannot be deleted.</span>
        </Confirm>
      )}
    </>
  );
}
