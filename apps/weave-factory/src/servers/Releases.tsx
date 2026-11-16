// Workspaces -> a workspace -> Releases: one API at a time. A release is one built image with a
// fixed checksum; the same release moves from one environment to the next. Each move is checked
// against the gates (trial passed, parity complete, answers equal to the old API) and, where
// asked for, a named person's approval.
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Package, RotateCcw, X } from "lucide-react";
import { api } from "../api.ts";
import { sapi, type Job, type Lane } from "./api.ts";
import { JobLine } from "./JobLine.tsx";
import { Btn, Confirm, Empty, Failed, Field, Head, LinkBtn, Loading, Notice, Panel, Pill, errText, useTitle } from "../migrate/ui.tsx";
import { ago } from "../lib/migrate.ts";

function Gate({ ok, label, note }: { ok: boolean | null | undefined; label: string; note?: string }) {
  return (
    <li className="mf-mg-small" style={{ display: "grid", gridTemplateColumns: "16px minmax(0, 1fr)", gap: 6, alignItems: "start" }} data-testid="gate" data-ok={String(ok)}>
      {ok ? <Check size={14} color="var(--ok)" aria-hidden="true" style={{ marginTop: 2 }} /> : <X size={14} color={ok === false ? "var(--bad)" : "var(--muted)"} aria-hidden="true" style={{ marginTop: 2 }} />}
      <span className="mf-mg-wrap"><strong>{label}</strong>{note ? <span className="mf-mg-muted"> · {note}</span> : null}</span>
    </li>
  );
}

export function ReleasesPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const w = useQuery({ queryKey: ["customer-ws", id], queryFn: () => sapi.workspace(id) });
  const all = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const mine = all.data?.workspaces.find((x) => x.config?.id === id || (w.data && x.name === w.data.name));
  const apis = (mine?.migrations ?? []).filter((m) => m.apiName);
  const [pick, setPick] = useState("");
  const apiName = pick || apis[0]?.apiName || "";
  const migId = apis.find((m) => m.apiName === apiName)?.id ?? "";
  const mig = useQuery({ queryKey: ["migration", migId], queryFn: () => api.migration(migId), enabled: !!migId });
  const lanes = useQuery({ queryKey: ["lanes", id, apiName], queryFn: () => sapi.lanes(id, apiName), enabled: !!apiName });
  const rels = useQuery({ queryKey: ["releases", apiName], queryFn: () => sapi.releases(apiName), enabled: !!apiName });
  const audit = useQuery({ queryKey: ["audit", apiName], queryFn: () => sapi.audit(apiName), enabled: !!apiName });
  const [job, setJob] = useState<{ job: Job; what: string } | null>(null);
  const [version, setVersion] = useState(""); const [rel, setRel] = useState("");
  const [approving, setApproving] = useState<{ env: string; release: string; version: string } | null>(null);
  const [approver, setApprover] = useState(""); const [note, setNote] = useState("");
  const [back, setBack] = useState<Lane | null>(null);
  useTitle(w.data ? `Releases · ${w.data.name}` : "Releases");
  const after = () => { for (const k of [["lanes", id, apiName], ["releases", apiName], ["audit", apiName]]) qc.invalidateQueries({ queryKey: k }); };
  const make = useMutation({ mutationFn: () => sapi.makeRelease(migId, version.trim() || undefined), onSuccess: (r) => { setJob({ job: r.job, what: "Making the release" }); setVersion(""); } });
  const dep = useMutation({ mutationFn: (v: { env: string; rid: string }) => sapi.deploy(id, v.env, v.rid), onSuccess: (r, v) => setJob({ job: r.job, what: `Deploying to ${v.env}` }) });
  const pro = useMutation({ mutationFn: (v: { from: string; to: string }) => sapi.promote(id, apiName, v.from, v.to), onSuccess: (r, v) => setJob({ job: r.job, what: `Promoting to ${v.to}` }) });
  const rb = useMutation({ mutationFn: (env: string) => sapi.rollback(id, apiName, env), onSuccess: (r, env) => { setBack(null); setJob({ job: r.job, what: `Rolling back ${env}` }); } });
  const appr = useMutation({ mutationFn: () => sapi.approve(approving!.release, approving!.env, approver.trim(), note.trim()), onSuccess: () => { setApproving(null); setApprover(""); setNote(""); after(); } });

  if (w.isLoading || all.isLoading) return <Loading rows={3} />;
  if (w.isError || !w.data) return <Failed what="This workspace could not be read." error={w.error} onRetry={() => w.refetch()} />;
  const m = mig.data;
  const g = { trial: !!(m?.trial?.ran && m.trial.passed), parity: m?.parity ? !!m.parity.complete : false, compare: (m as any)?.compare ? !!(m as any).compare.passed : null };
  const envs = lanes.data?.environments ?? [];
  const first = envs[0]?.env;
  const busy = make.isPending || dep.isPending || pro.isPending || rb.isPending || job?.job.state === "running";

  return (
    <>
      <Head area="Workspaces" areaTo="/workspaces" back={{ to: `/workspaces/${encodeURIComponent(id)}/servers`, label: "Servers" }} title={`Releases of ${w.data.name}`}
        subtitle="The same built release moves from one environment to the next, after its checks and, where needed, an approval."
        actions={<LinkBtn to={`/workspaces/${encodeURIComponent(id)}/servers`}>Servers</LinkBtn>} />
      {apis.length === 0 ? <Empty title="No migrated API in this workspace yet" hint="Releases are made from a migration's built service." /> : (
        <div className="mf-mg-stack" data-testid="releases">
          <Panel title="API">
            <Field label="Which API"><select className="mf-mg-input" value={apiName} onChange={(e) => { setPick(e.target.value); setJob(null); }} data-testid="release-api">{apis.map((a) => <option key={a.id} value={a.apiName!}>{a.apiName}</option>)}</select></Field>
          </Panel>

          <Panel title="Make a release">
            <div className="mf-mg-stack" style={{ gap: 10 }}>
              <span className="mf-mg-small mf-mg-muted">These are checked again every time the release is moved:</span>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
                <Gate ok={g.trial} label="Trial run passed" note={m?.trial?.summary?.slice(0, 120)} />
                <Gate ok={g.parity} label="Every old flow, call and field found" note={m?.parity?.summary?.slice(0, 120)} />
                <Gate ok={g.compare} label="Answers equal to the old API" note={g.compare === null ? "not compared yet (not required)" : undefined} />
              </ul>
              <div className="mf-mg-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                <Field label="Version (optional)"><input className="mf-mg-input mf-mono" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="made from the date and build" maxLength={60} /></Field>
                <Btn kind="primary" icon={<Package size={14} aria-hidden="true" />} disabled={busy || !migId} busy={make.isPending} onClick={() => make.mutate()}>Make release</Btn>
              </div>
              {make.isError && <Notice tone="bad">{errText(make.error)}</Notice>}
            </div>
          </Panel>

          {job && <JobLine key={job.job.id} job={job.job} what={job.what} onEnd={(j) => { setJob((x) => (x && x.job.id === j.id ? { ...x, job: j } : x)); after(); }} />}

          <Panel title="Environments">
            {lanes.isLoading ? <Loading rows={2} /> : lanes.isError ? <Failed what="The environments could not be read." error={lanes.error} onRetry={() => lanes.refetch()} /> : (
              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
                {envs.map((l, i) => {
                  const next = envs[i + 1];
                  return (
                    <div key={l.env} className="mf-mg-card" data-testid="lane" data-env={l.env} style={{ display: "grid", gap: 8 }}>
                      <div className="mf-mg-row" style={{ gap: 6, flexWrap: "wrap" }}>
                        <strong>{l.env}</strong>
                        {l.approval && <Pill tone="warn">needs approval</Pill>}
                        {l.lastResult && <Pill tone={l.lastResult === "ok" ? "ok" : "bad"}>{l.lastResult === "ok" ? "last move ok" : "last move failed"}</Pill>}
                      </div>
                      <span className="mf-mg-small">{l.release ? <>Runs <span className="mf-mono">{l.release.version}</span>{l.since ? <span className="mf-mg-muted"> · since {ago(l.since)}</span> : null}</> : <span className="mf-mg-muted">Nothing deployed yet.</span>}</span>
                      <div className="mf-mg-actions">
                        {next && l.release && (next.approval && !next.approvedFor ? (
                          <Btn small onClick={() => setApproving({ env: next.env, release: l.release!.id, version: l.release!.version })} disabled={busy}>Approve for {next.env}…</Btn>
                        ) : (
                          <Btn small kind="primary" icon={<ArrowRight size={14} aria-hidden="true" />} disabled={busy} busy={pro.isPending && pro.variables?.to === next.env} onClick={() => pro.mutate({ from: l.env, to: next.env })}>Promote to {next.env}</Btn>
                        ))}
                        {l.canRollback && <Btn small icon={<RotateCcw size={14} aria-hidden="true" />} disabled={busy} onClick={() => { rb.reset(); setBack(l); }}>Roll back</Btn>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {first && (rels.data?.releases ?? []).length > 0 && (
              <div className="mf-mg-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12 }}>
                <Field label={`Release to deploy to ${first}`}>
                  <select className="mf-mg-input" value={rel} onChange={(e) => setRel(e.target.value)} data-testid="release-pick">
                    <option value="">Choose a release…</option>
                    {[...(rels.data?.releases ?? [])].reverse().map((r) => <option key={r.id} value={r.id}>{r.version}{r.gates && (!r.gates.trialPassed || !r.gates.parityComplete) ? " (checks not passed)" : ""}</option>)}
                  </select>
                </Field>
                <Btn small kind="primary" disabled={!rel || busy} busy={dep.isPending} onClick={() => dep.mutate({ env: first, rid: rel })}>Deploy to {first}</Btn>
              </div>
            )}
            {(dep.isError || pro.isError) && <Notice tone="bad">{errText(dep.error ?? pro.error)}</Notice>}
          </Panel>

          <Panel title="What was done">
            {(audit.data?.audit ?? []).length === 0 ? <span className="mf-mg-small mf-mg-muted">Nothing yet.</span> : (
              <ul className="mf-mg-small mf-mg-wrap" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }} data-testid="audit">
                {[...(audit.data?.audit ?? [])].reverse().slice(0, 50).map((a, i) => (
                  <li key={i}>{ago(a.at)} · <strong>{a.who}</strong> · {a.action}{a.env ? ` ${a.env}` : ""}{a.version ? ` ${a.version}` : ""}{a.result ? ` · ${a.result}` : ""}{a.approvedBy ? ` · approved by ${a.approvedBy}` : ""}</li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
      {approving && (
        <Confirm title={`Approve release ${approving.version} for ${approving.env}?`} confirmLabel="Approve" busy={appr.isPending} error={appr.isError ? errText(appr.error) : undefined}
          onConfirm={() => { if (approver.trim().length >= 3) appr.mutate(); }} onClose={() => setApproving(null)}>
          <div className="mf-mg-stack" style={{ gap: 8 }}>
            <span>The approval is recorded with the name below and is valid for 24 hours.</span>
            <Field label="Approved by (first and last name)"><input className="mf-mg-input" value={approver} onChange={(e) => setApprover(e.target.value)} data-testid="approver" /></Field>
            <Field label="Note (optional)"><input className="mf-mg-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
          </div>
        </Confirm>
      )}
      {back && (
        <Confirm title={`Roll back ${apiName} in ${back.env}?`} confirmLabel="Roll back" danger busy={rb.isPending} error={rb.isError ? errText(rb.error) : undefined} onConfirm={() => rb.mutate(back.env)} onClose={() => setBack(null)}>
          <span>The release that ran before <span className="mf-mono">{back.release?.version}</span> is put back. Rolling back skips the checks.</span>
        </Confirm>
      )}
    </>
  );
}
