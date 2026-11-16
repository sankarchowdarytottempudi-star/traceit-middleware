// "Request a change": a person describes a new requirement for a migrated API; a code model that
// runs on this server writes the change; it is built, unit-tested, tried in the closed room and
// checked against the old code, then waits here for review. Approving merges its pull request and
// deploys through the normal checks. Nothing is deployed without approval; nothing leaves the server.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleDashed, GitPullRequest, Loader2, Plus, Trash2, X } from "lucide-react";
import { changesApi, type Change, type ChangeExample } from "./api.ts";
import { Btn, Field, Notice, Panel, Pill, errText } from "../migrate/ui.tsx";

const TONE: Record<string, "ok" | "warn" | "bad" | "accent" | "muted"> = { queued: "muted", running: "accent", ready: "warn", failed: "bad", applied: "warn", proposed: "accent", approved: "ok", rejected: "muted" };
const WORDS: Record<string, string> = { queued: "Waiting", running: "Being written and tested", ready: "Ready for review", failed: "Not achieved", applied: "Written into the service", proposed: "Pull request open", approved: "Approved and deploying", rejected: "Rejected" };
const when = (t?: number) => (t ? new Date(t * 1000).toLocaleString() : "");

interface Row { op: string; pathValues: string; body: string; backend: string; backendStatus: string; backendBody: string; expectStatus: string; expectHas: string }
const emptyRow = (): Row => ({ op: "", pathValues: "", body: "", backend: "", backendStatus: "", backendBody: "", expectStatus: "", expectHas: "" });
function parseJson(s: string): { ok: boolean; v?: unknown } { if (!s.trim()) return { ok: true, v: undefined }; try { return { ok: true, v: JSON.parse(s) }; } catch { return { ok: false }; } }

export function examplesOf(rows: Row[]): { examples: ChangeExample[]; problem: string } {
  const examples: ChangeExample[] = [];
  for (const [i, r] of rows.entries()) {
    if (!r.op.trim()) continue;
    if (!/^(GET|POST|PUT|PATCH|DELETE) \/\S*$/.test(r.op.trim())) return { examples, problem: `Example ${i + 1}: the operation looks like "GET /items/{itemId}".` };
    const pv = parseJson(r.pathValues), body = parseJson(r.body), bb = parseJson(r.backendBody);
    if (!pv.ok || !body.ok || !bb.ok) return { examples, problem: `Example ${i + 1}: a JSON field is not valid JSON.` };
    const ex: ChangeExample = { op: r.op.trim() };
    if (pv.v && typeof pv.v === "object") ex.pathValues = pv.v as Record<string, string>;
    if (body.v !== undefined) ex.body = body.v;
    if (r.backend.trim() && r.backendStatus.trim()) ex.backendReplies = [{ backend: r.backend.trim(), status: Number(r.backendStatus), ...(bb.v !== undefined ? { body: bb.v } : {}) }];
    if (r.expectStatus.trim()) ex.expectStatus = Number(r.expectStatus);
    if (r.expectHas.trim()) ex.expectBodyHas = [r.expectHas.trim()];
    examples.push(ex);
  }
  return { examples, problem: "" };
}

function NewChange({ api, start, onStarted }: { api: string; start?: string; onStarted: (id: string) => void }) {
  const [text, setText] = useState(start ?? "");
  const [flow, setFlow] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => { if (start !== undefined) setText(start); }, [start]);
  const ex = examplesOf(rows);
  const go = useMutation({ mutationFn: () => changesApi.start(api, { requirement: text.trim(), flow: flow.trim(), examples: ex.examples }), onSuccess: (r) => { setText(""); setRows([]); onStarted(r.id); } });
  const set = (i: number, k: keyof Row, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="mf-mg-stack" style={{ gap: 10 }} data-testid="change-new">
      <Field label="What should change?" hint="Say what the API must do differently, as you would to a developer. Code, settings values and addresses never leave this server.">
        <textarea className="mf-mg-input" data-testid="change-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder='For example: when the catalogue answers 404 for GET /items/{itemId}, answer 404 with {"code":"ITEM_NOT_FOUND"} instead of passing the backend answer on.' />
      </Field>
      <Field label="Which operation or flow (optional)"><input className="mf-mg-input mf-mono" data-testid="change-flow" value={flow} onChange={(e) => setFlow(e.target.value)} placeholder="GET /items/{itemId}" /></Field>
      <div className="mf-mg-sec"><h3>Examples that must work (recommended)</h3>
        <span className="mf-mg-hint">Each example becomes a check in the closed-room trial: the request, what the backend answers (made-up data), and what the API must answer.</span>
        {rows.map((r, i) => (
          <div key={i} className="mf-mg-card" data-testid="change-example" style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))" }}>
            <Field label="Operation"><input className="mf-mg-input mf-mono" value={r.op} onChange={(e) => set(i, "op", e.target.value)} placeholder="GET /items/{itemId}" /></Field>
            <Field label="Path values (JSON)"><input className="mf-mg-input mf-mono" value={r.pathValues} onChange={(e) => set(i, "pathValues", e.target.value)} placeholder='{"itemId":"42"}' /></Field>
            <Field label="Request body (JSON)"><input className="mf-mg-input mf-mono" value={r.body} onChange={(e) => set(i, "body", e.target.value)} /></Field>
            <Field label="Backend (settings name)"><input className="mf-mg-input mf-mono" value={r.backend} onChange={(e) => set(i, "backend", e.target.value)} placeholder="catalogueRequestConfig" /></Field>
            <Field label="Backend answers status"><input className="mf-mg-input mf-mono" value={r.backendStatus} onChange={(e) => set(i, "backendStatus", e.target.value)} placeholder="404" /></Field>
            <Field label="Backend answers body (JSON)"><input className="mf-mg-input mf-mono" value={r.backendBody} onChange={(e) => set(i, "backendBody", e.target.value)} /></Field>
            <Field label="API must answer status"><input className="mf-mg-input mf-mono" value={r.expectStatus} onChange={(e) => set(i, "expectStatus", e.target.value)} placeholder="404" /></Field>
            <Field label="Answer must contain"><input className="mf-mg-input mf-mono" value={r.expectHas} onChange={(e) => set(i, "expectHas", e.target.value)} placeholder="ITEM_NOT_FOUND" /></Field>
            <span className="mf-mg-actions"><Btn small icon={<Trash2 size={14} aria-hidden="true" />} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Btn></span>
          </div>
        ))}
        <span className="mf-mg-actions"><Btn small icon={<Plus size={14} aria-hidden="true" />} onClick={() => setRows([...rows, emptyRow()])}>Add an example</Btn></span>
      </div>
      {ex.problem && <Notice tone="warn">{ex.problem}</Notice>}
      <span className="mf-mg-actions"><Btn kind="primary" data-testid="change-start" disabled={text.trim().length < 10 || !!ex.problem} busy={go.isPending} onClick={() => go.mutate()}>Request this change</Btn></span>
      {go.isError && <Notice tone="bad">{errText(go.error)}</Notice>}
      <span className="mf-mg-hint">A code model on this server writes the change, then it is built, unit-tested, tried in the closed room and checked against the old code. On this server's processors that takes minutes. Nothing is deployed until you approve it.</span>
    </div>
  );
}

function ChangeView({ id, onOnTop }: { id: string; onOnTop: (c: Change) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["change", id], queryFn: () => changesApi.get(id), refetchInterval: (s) => (["queued", "running"].includes((s.state.data as Change | undefined)?.status ?? "") ? 5000 : false) });
  const act = useMutation({ mutationFn: (a: "propose" | "approve" | "reject") => changesApi.act(id, a), onSuccess: () => { qc.invalidateQueries({ queryKey: ["change", id] }); qc.invalidateQueries({ queryKey: ["changes"] }); } });
  const c = q.data;
  if (!c) return q.isError ? <Notice tone="bad">{errText(q.error)}</Notice> : <span className="mf-mg-small mf-mg-muted">Loading…</span>;
  return (
    <div className="mf-mg-stack" style={{ gap: 10 }} data-testid="change-view">
      <div className="mf-mg-row" style={{ gap: 8 }}><Pill tone={TONE[c.status] ?? "muted"}>{WORDS[c.status] ?? c.status}</Pill>{c.round ? <span className="mf-mg-small mf-mg-muted">round {c.round}</span> : null}{c.pr ? <a className="mf-mg-small" href={c.prUrl || "#"} target="_blank" rel="noreferrer">pull request #{c.pr}</a> : null}</div>
      <p className="mf-mg-wrap" style={{ margin: 0 }}>{c.request?.requirement}</p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }} data-testid="change-steps">
        {(c.steps ?? []).map((s, i) => (
          <li key={i} className="mf-mg-row mf-mg-small" style={{ gap: 6, alignItems: "flex-start" }}>
            {s.state === "running" ? <Loader2 size={14} className="mf-spin" aria-hidden="true" /> : s.state === "done" ? <Check size={14} aria-hidden="true" /> : s.state === "failed" || s.state === "refused" ? <X size={14} aria-hidden="true" /> : <CircleDashed size={14} aria-hidden="true" />}
            <span><strong>{s.name}</strong>{s.round ? ` (round ${s.round})` : ""}{s.detail ? <span className="mf-mg-muted mf-mg-wrap"> · {s.detail}</span> : null}</span>
          </li>
        ))}
      </ul>
      {c.status === "failed" && <Notice tone="bad">{c.why || "The change could not be made."}</Notice>}
      {c.explanation && <Notice>{c.explanation}</Notice>}
      {c.results && (
        <div className="mf-mg-small mf-mg-wrap" data-testid="change-results">
          <div>Unit tests: {c.results.tests ?? "?"} pass · coverage {c.results.coverage ?? "?"}%{c.baseline?.coverage != null ? ` (before ${c.baseline.coverage}%)` : ""}</div>
          <div>Closed-room trial: {c.results.trial}</div>
          <div>Old code, item by item: {c.results.parity}</div>
        </div>
      )}
      {c.diff && <details open><summary className="mf-mg-small" style={{ cursor: "pointer", fontWeight: 600 }}>The change (code only)</summary><pre className="mf-mono mf-mg-small" data-testid="change-diff" style={{ overflowX: "auto", maxHeight: 420, whiteSpace: "pre" }}>{c.diff}</pre></details>}
      <span className="mf-mg-actions">
        {c.status === "ready" && <Btn kind="primary" icon={<GitPullRequest size={14} aria-hidden="true" />} busy={act.isPending && act.variables === "propose"} onClick={() => act.mutate("propose")}>Open the pull request</Btn>}
        {c.status === "proposed" && <Btn kind="primary" busy={act.isPending && act.variables === "approve"} onClick={() => act.mutate("approve")}>Approve and deploy</Btn>}
        {["ready", "proposed", "applied"].includes(c.status) && <Btn kind="danger" busy={act.isPending && act.variables === "reject"} onClick={() => act.mutate("reject")}>Reject</Btn>}
        {["proposed", "approved"].includes(c.status) && <Btn onClick={() => onOnTop(c)}>Ask for another change on top</Btn>}
      </span>
      {act.isError && <Notice tone="bad">{errText(act.error)}</Notice>}
      {act.data?.note && <Notice tone="warn">{act.data.note}</Notice>}
    </div>
  );
}

function OpenItemFixes({ api, migrationId, onStarted }: { api: string; migrationId?: string; onStarted: (id: string) => void }) {
  const q = useQuery({ queryKey: ["open-items-fix", migrationId], queryFn: () => changesApi.openItems(migrationId as string), enabled: !!migrationId, staleTime: 15000 });
  const fix = useMutation({ mutationFn: (itemId: string) => changesApi.fixItem(api, itemId), onSuccess: (r) => onStarted(r.id) });
  const items = q.data?.items ?? [];
  if (!migrationId || !items.length) return null;
  return (
    <div className="mf-mg-sec" data-testid="change-open-items"><h3>Open items the automatic migration could not finish</h3>
      <span className="mf-mg-hint">The local agent reads the old code of that item (values masked) and the new service, and proposes a fix. It is accepted only when the item is closed and the build, tests, trial and check against the old code all pass.</span>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
        {items.slice(0, 30).map((it) => (
          <li key={it.id} className="mf-mg-row mf-mg-small" style={{ gap: 8 }}>
            <Pill tone="warn">{it.kind}</Pill><span className="mf-mono mf-mg-wrap mf-mg-grow">{it.title}</span>
            <Btn small busy={fix.isPending && fix.variables === it.id} onClick={() => fix.mutate(it.id)}>Let the local agent propose a fix</Btn>
          </li>
        ))}
      </ul>
      {fix.isError && <Notice tone="bad">{errText(fix.error)}</Notice>}
    </div>
  );
}

export function ChangeRequests({ api, migrationId }: { api: string; migrationId?: string }) {
  const q = useQuery({ queryKey: ["changes", api], queryFn: () => changesApi.list(api), refetchInterval: 15000 });
  const [open, setOpen] = useState<string | null>(null);
  const [start, setStart] = useState<string | undefined>(undefined);
  const list = q.data?.changes ?? [];
  return (
    <Panel title="Request a change" actions={<Pill tone="muted">Model runs on this server</Pill>}>
      <div className="mf-mg-stack" style={{ gap: 14 }} data-testid="changes">
        <NewChange api={api} start={start} onStarted={(id) => { setOpen(id); setStart(undefined); }} />
        <OpenItemFixes api={api} migrationId={migrationId} onStarted={(id) => setOpen(id)} />
        {list.length > 0 && (
          <div className="mf-mg-sec"><h3>Change requests</h3>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
              {list.map((c) => (
                <li key={c.id} className="mf-mg-card" data-testid="change-row">
                  <button type="button" className="mf-mg-row" style={{ gap: 8, background: "none", border: 0, padding: 0, cursor: "pointer", width: "100%", textAlign: "left", color: "inherit" }} onClick={() => setOpen(open === c.id ? null : c.id)}>
                    <Pill tone={TONE[c.status] ?? "muted"}>{WORDS[c.status] ?? c.status}</Pill>
                    <span className="mf-mg-wrap mf-mg-grow">{c.requirement}</span>
                    <span className="mf-mg-small mf-mg-muted">{when(c.createdAt)}{c.by ? ` · ${c.by}` : ""}</span>
                  </button>
                  {open === c.id && <div style={{ marginTop: 10 }}><ChangeView id={c.id} onOnTop={(x) => setStart(`On top of the change "${(x.request?.requirement ?? "").slice(0, 80)}": `)} /></div>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}
