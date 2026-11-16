// Versions of a migrated API, kept in the workspace's private git repository: the last versions
// with who/when/what and the results of their build, the code changes between two versions, going
// back to an older version (as a new version), and changes proposed as pull requests.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { GitBranch, GitPullRequest, History, RotateCcw } from "lucide-react";
import { vapi, type VersionRow } from "./api.ts";
import type { Job } from "../servers/api.ts";
import { JobLine } from "../servers/JobLine.tsx";
import { txt } from "../lib/text.ts";
import { ago, dateTime } from "../lib/migrate.ts";
import { Btn, Dialog, Empty, Failed, Field, Loading, Notice, Panel, Pill, errText } from "../migrate/ui.tsx";

function Results({ r }: { r?: VersionRow["results"] }) {
  if (!r) return null;
  const tone = (s?: string) => (s === "done" ? "ok" : s === "failed" ? "bad" : s === "action_required" ? "warn" : "muted") as "ok" | "bad" | "warn" | "muted";
  const word: Record<string, string> = { e2e: "trial", parity: "old code", coverage: "coverage", unit_run: "tests" };
  return <span className="mf-mg-row" style={{ gap: 4 }}>{Object.entries(r).map(([k, v]) => <Pill key={k} tone={tone(v?.status)} title={txt(v?.detail)}>{word[k] ?? k}</Pill>)}</span>;
}

function DiffView({ api, from, to, onClose }: { api: string; from: number; to: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ["vdiff", api, from, to], queryFn: () => vapi.diff(api, from, to) });
  return (
    <Dialog title={`Changes from v${from} to v${to}`} onClose={onClose} footer={<Btn onClick={onClose}>Close</Btn>}>
      {q.isLoading ? <Loading rows={3} /> : q.isError ? <Failed what="The changes could not be read." error={q.error} /> : (
        <div className="mf-mg-stack" style={{ gap: 8 }} data-testid="version-diff">
          {((q.data?.settingsAdded ?? []).length > 0 || (q.data?.settingsRemoved ?? []).length > 0) && (
            <Notice>Settings names changed: {(q.data?.settingsAdded ?? []).map((k) => `+ ${k}`).concat((q.data?.settingsRemoved ?? []).map((k) => `− ${k}`)).join(", ")}. Values are never in the history.</Notice>
          )}
          <pre className="mf-mono mf-mg-small" style={{ margin: 0, maxHeight: 420, overflow: "auto", whiteSpace: "pre", background: "var(--surface-2, rgba(0,0,0,.04))", padding: 10, borderRadius: 8 }}>{txt(q.data?.patch) || "No code changes."}</pre>
          {q.data?.truncated && <span className="mf-mg-hint">The change is long; the rest is in the repository.</span>}
        </div>
      )}
    </Dialog>
  );
}

export function VersionsPanel({ api }: { api: string }) {
  const qc = useQueryClient();
  const [limit, setLimit] = useState(10);
  const [diff, setDiff] = useState<{ from: number; to: number } | null>(null);
  const [asking, setAsking] = useState<VersionRow | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [title, setTitle] = useState("");
  const list = useQuery({ queryKey: ["versions", api, limit], queryFn: () => vapi.list(api, limit) });
  const changes = useQuery({ queryKey: ["changes", api], queryFn: () => vapi.changes(api) });
  const revert = useMutation({ mutationFn: (n: number) => vapi.revert(api, n), onSuccess: (j) => { setJob(j); setAsking(null); } });
  const propose = useMutation({ mutationFn: () => vapi.propose(api, title.trim()), onSuccess: () => { setTitle(""); qc.invalidateQueries({ queryKey: ["changes", api] }); } });
  const approve = useMutation({ mutationFn: (n: number) => vapi.approve(api, n), onSuccess: (j) => setJob(j) });
  const close = useMutation({ mutationFn: (n: number) => vapi.close(api, n), onSuccess: () => qc.invalidateQueries({ queryKey: ["changes", api] }) });
  const rows = list.data?.versions ?? [];
  const latest = rows[0]?.version;
  const busy = !!job && job.state === "running";
  return (
    <div className="mf-mg-stack" data-testid="versions">
      <Panel title="Versions" actions={list.data ? <Pill tone={(list.data.pending ?? 0) > 0 ? "warn" : "ok"}>{(list.data.pending ?? 0) > 0 ? `${list.data.pending} not pushed yet` : "In the git repository"}</Pill> : undefined}>
        <p className="mf-mg-sub mf-mg-wrap" style={{ margin: "0 0 10px", fontSize: 13.5 }}>
          Every deployment of this API is a version in the workspace's private git repository: its code, tests and Helm values, and the names of its settings (values stay on the server).
          Going back to an older version builds, checks and deploys it again, and records that as a new version, so nothing is ever lost.
        </p>
        {job && <JobLine job={job} what={job.kind === "version-revert" ? "Going back to an older version" : "Deploying the change"} onEnd={() => { qc.invalidateQueries({ queryKey: ["versions", api] }); qc.invalidateQueries({ queryKey: ["changes", api] }); }} />}
        {list.isLoading ? <Loading rows={3} /> : list.isError ? <Failed what="The versions could not be read." error={list.error} onRetry={() => list.refetch()} /> : rows.length === 0 ? (
          <Empty title="No version yet" hint="The first version is recorded at the next deployment of this API." />
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
            {rows.map((v) => (
              <li key={v.version} className="mf-mg-card" data-testid="version-row" data-version={v.version}>
                <div className="mf-mg-row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <History size={15} aria-hidden="true" /><strong className="mf-mono">v{v.version}</strong>
                  {v.version === latest && <Pill tone="ok">running</Pill>}
                  {v.revertOf ? <Pill tone="accent">back to v{v.revertOf}</Pill> : null}
                  <span className="mf-mg-wrap" style={{ flexBasis: 200, flexGrow: 1 }}>{txt(v.what)}</span>
                  <span className="mf-mg-small mf-mg-muted">{txt(v.by)} · {v.at ? `${dateTime(v.at)} (${ago(v.at)})` : ""}</span>
                </div>
                <div className="mf-mg-row" style={{ gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                  <Results r={v.results} />
                  <span className="mf-mg-small mf-mg-muted">{v.summary?.files ?? 0} file{(v.summary?.files ?? 0) === 1 ? "" : "s"} changed{v.commit ? ` · ${v.commit}` : ""}</span>
                  <span className="mf-mg-actions" style={{ marginLeft: "auto" }}>
                    {v.version > 1 && <Btn small onClick={() => setDiff({ from: v.version - 1, to: v.version })}>View changes</Btn>}
                    {v.version !== latest && <Btn small icon={<RotateCcw size={14} aria-hidden="true" />} disabled={busy} onClick={() => setAsking(v)}>Revert to this version</Btn>}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
        {list.data && list.data.total > rows.length && <span className="mf-mg-actions" style={{ marginTop: 8 }}><Btn small onClick={() => setLimit(limit + 20)}>Show older versions ({list.data.total - rows.length} more)</Btn></span>}
      </Panel>

      <Panel title="Changes waiting for approval" actions={<Pill>{(changes.data?.pulls ?? []).length} open</Pill>}>
        <p className="mf-mg-sub mf-mg-wrap" style={{ margin: "0 0 10px", fontSize: 13.5 }}>
          An edit of this API becomes a branch and a pull request in the repository, with the results of its build and trial. Approving it merges it and deploys it through the normal checks; closing it discards it and the service goes back to what is deployed.
        </p>
        <div className="mf-mg-row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Field label="Propose the current code of this API as a change"><input className="mf-mg-input" data-testid="propose-title" value={title} maxLength={120} placeholder="What changed, in a few words" onChange={(e) => setTitle(e.target.value)} /></Field>
          <Btn icon={<GitBranch size={14} aria-hidden="true" />} disabled={!title.trim() || propose.isPending} busy={propose.isPending} onClick={() => propose.mutate()}>Propose change</Btn>
        </div>
        {propose.data && <Notice tone={propose.data.pr ? "ok" : "warn"}>{propose.data.pr ? <>Pull request <a href={propose.data.pr.url} target="_blank" rel="noreferrer">#{propose.data.pr.number}</a> opened on branch <span className="mf-mono">{txt(propose.data.branch)}</span>.</> : txt(propose.data.note)}</Notice>}
        {propose.isError && <Notice tone="bad">{errText(propose.error)}{((propose.error as any)?.body?.refused ?? []).length ? ": " + (propose.error as any).body.refused.join("; ") : ""}</Notice>}
        <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 6 }}>
          {(changes.data?.pulls ?? []).map((c) => (
            <li key={c.number} className="mf-mg-row mf-mg-small" style={{ gap: 8, flexWrap: "wrap" }} data-testid="change-row">
              <GitPullRequest size={14} aria-hidden="true" /><a href={c.url} target="_blank" rel="noreferrer">#{c.number}</a><span className="mf-mg-wrap">{txt(c.title)}</span>
              <span className="mf-mg-muted">{txt(c.by)}</span>
              <span className="mf-mg-actions" style={{ marginLeft: "auto" }}>
                <Btn small kind="primary" disabled={busy} onClick={() => approve.mutate(c.number)}>Approve and deploy</Btn>
                <Btn small onClick={() => close.mutate(c.number)}>Close without deploying</Btn>
              </span>
            </li>
          ))}
          {(changes.data?.localBranches ?? []).map((b) => <li key={b} className="mf-mg-small mf-mg-muted">Branch <span className="mf-mono">{b}</span> is kept on the server; its pull request opens once the repository token is entered.</li>)}
        </ul>
      </Panel>

      {diff && <DiffView api={api} from={diff.from} to={diff.to} onClose={() => setDiff(null)} />}
      {asking && (
        <Dialog title={`Go back to v${asking.version}?`} onClose={() => setAsking(null)}
          footer={<><Btn onClick={() => setAsking(null)}>Cancel</Btn><Btn kind="primary" busy={revert.isPending} onClick={() => revert.mutate(asking.version)}>Revert to v{asking.version}</Btn></>}>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }} data-testid="revert-confirm">
            The code of v{asking.version} ({txt(asking.what)}) is put back, built, checked in the closed-room trial and deployed. The settings keep their current values.
            It is recorded as a new version; the current code is kept on the server and in the history.
          </p>
          {revert.isError && <Notice tone="bad">{errText(revert.error)}</Notice>}
        </Dialog>
      )}
    </div>
  );
}

/** Clone: a copy of the API under a new name (own service, base path and history), or a flow copy. */
export function CloneApiDialog({ name, onClose, onFlowCopy }: { name: string; onClose: () => void; onFlowCopy: () => void }) {
  const nav = useNavigate();
  const [newName, setNewName] = useState(`${name}-copy`.slice(0, 62));
  const [job, setJob] = useState<Job | null>(null);
  const clone = useMutation({ mutationFn: () => vapi.clone(name, newName.trim().toLowerCase()), onSuccess: (j) => setJob(j) });
  const valid = /^[a-z0-9][a-z0-9-]{1,61}$/.test(newName.trim().toLowerCase()) && newName.trim().toLowerCase() !== name;
  return (
    <Dialog title="Clone this API" onClose={onClose}
      footer={<><Btn onClick={onClose}>Close</Btn>{!job && <Btn kind="primary" busy={clone.isPending} disabled={!valid} onClick={() => clone.mutate()}>Create the copy</Btn>}</>}>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>
        A copy of <span className="mf-mono">{name}</span> under a new name: its own service, base path (<span className="mf-mono">/{newName.trim().toLowerCase() || "…"}/v1</span>), settings and version history starting at v1.
        It is built and checked, not deployed. The original is not changed.
      </p>
      {!job && <Field label="Name of the copy" hint="Lower-case letters, digits and dashes."><input className="mf-mg-input mf-mono" data-testid="clone-name" value={newName} maxLength={62} onChange={(e) => setNewName(e.target.value)} autoFocus /></Field>}
      {clone.isError && <Notice tone="bad">{errText(clone.error)}</Notice>}
      {job && <JobLine job={job} what="Cloning" onEnd={(j) => { const id = (j.result as any)?.result?.migrationId; if (j.state === "done" && id) setTimeout(() => nav(`/migrations/${encodeURIComponent(id)}`), 800); }} />}
      <span className="mf-mg-hint">Want to change it on the canvas instead? <button type="button" className="mf-mg-link" onClick={onFlowCopy}>Make a flow copy in the Studio</button>.</span>
    </Dialog>
  );
}
