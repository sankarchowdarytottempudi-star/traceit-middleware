// "Change in your own words" for one selected item: a step, the whole flow, or a connection. The words are
// read on the server by fixed rules; the preview shows every change (before -> after), new and removed steps
// on the small canvas, what the flow engine's check and the lessons say, and any connection still missing.
// Nothing changes until Apply, which saves a new version with the words as its note; Undo restores the
// version before it. A deployed flow keeps running its deployed version until it is deployed again.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, BookOpen, CheckCircle2, CircleHelp, Cpu, Plus, RotateCcw, XCircle } from "lucide-react";
import { EDIT_PHRASES, scopeOf, type EditTarget, type Flow, type MissingConnection } from "@traceit/weave-flow";
import { errorText, studioApi, type EditApplied, type EditPreview } from "../api.ts";
import { accentOf, useCatalog } from "../catalog.ts";
import { Badge, Button, Callout, Collapsible, cx, Field, Modal, toast } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { ConnectionDialog } from "./ConnectionDialog.tsx";
import { MiniCanvas } from "./DescribeDialog.tsx";

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 220 ? `${s.slice(0, 219)}…` : s;
};
const KIND: Record<string, string> = { set: "Changed", "add-step": "New step", "remove-step": "Removed step", "add-rule": "New field", "change-rule": "Changed field", "remove-rule": "Removed field", "add-path": "New error path", connection: "Connection" };

export function EditDialog({ flow, target, onClose, onApplied, dirty }: {
  flow?: Flow; target: EditTarget; onClose: () => void; dirty?: boolean;
  onApplied?: (r: EditApplied, undo: () => Promise<void>) => void;
}) {
  const catalog = useCatalog();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["studio", "edit-phrases"], queryFn: studioApi.editPhrases, retry: 0, staleTime: 60_000 });
  const node = target.kind === "node" ? flow?.nodes.find((n) => n.id === target.nodeId) : undefined;
  const scope = target.kind === "connection" ? "connection" : target.kind === "flow" ? "flow" : scopeOf(node);
  const [text, setText] = useState("");
  const [help, setHelp] = useState(false);
  const [preview, setPreview] = useState<EditPreview | null>(null);
  const [applied, setApplied] = useState<EditApplied | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [newConn, setNewConn] = useState<MissingConnection | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const body = (t: string) => ({ text: t, target, flowId: flow?.id, baseRevision: flow?.revision });
  const read = useMutation({ mutationFn: (t?: string) => studioApi.editPreview(body(t ?? text)), onSuccess: (p) => { setPreview(p); setProblem(null); }, onError: (e) => setProblem(errorText(e)) });
  const model = useMutation({ mutationFn: () => studioApi.editModel(body(text)), onSuccess: (p) => { if (p.modelText) setText(p.modelText); setPreview(p); setProblem(null); }, onError: (e) => setProblem(errorText(e)) });
  const undoNow = async (r: EditApplied) => {
    await studioApi.editUndo({ flowId: r.flow ? flow?.id : undefined, revision: r.previousRevision, connection: r.connection?.before ? r.connection : undefined });
    void qc.invalidateQueries({ queryKey: ["studio"] });
  };
  const apply = useMutation({
    mutationFn: () => studioApi.editApply(body(text)),
    onSuccess: (r) => { setApplied(r); void qc.invalidateQueries({ queryKey: ["studio", "connections"] }); onApplied?.(r, () => undoNow(r)); },
    onError: (e) => setProblem(errorText(e)),
  });
  const undo = useMutation({ mutationFn: () => undoNow(applied!), onSuccess: () => { toast("Undone: the version before the change is back."); onClose(); }, onError: (e) => setProblem(errorText(e)) });

  const phrases = useMemo(() => EDIT_PHRASES.filter((p) => p.scope === scope || p.scope === "any" || p.scope === "issue" || (scope === "flow" && p.scope === "flow")).filter((p) => scope !== "connection" || p.scope === "connection"), [scope]);
  const lines = preview?.lines.filter((l) => l.text) ?? [];
  const bad = lines.filter((l) => l.status === "not-understood").length;
  const newIssues = (preview?.issues ?? []).filter((i) => i.new);
  const lessons = preview?.lessonWarnings ?? [];
  const changedIds = new Set((preview?.changes ?? []).map((c) => c.nodeId).filter(Boolean) as string[]);
  const removed = (preview?.changes ?? []).filter((c) => c.kind === "remove-step");
  const canApply = !!preview && preview.ok && bad === 0 && !dirty;
  const labelOf = (type: string) => { const d = catalog.byType.get(type); return { label: d?.label ?? type, accent: accentOf(d) }; };
  const title = target.kind === "connection" ? "Change this connection in your own words" : target.kind === "flow" ? "Change this flow in your own words" : `Change "${node?.name ?? "this step"}" in your own words`;
  const deployedNote = preview?.deployedRevision ? `This flow is live on revision ${preview.deployedRevision}. The change is saved as a new version; the live API keeps running revision ${preview.deployedRevision} until you deploy again.` : "";

  const footer = applied ? (
    <>
      <Button icon={RotateCcw} busy={undo.isPending} onClick={() => undo.mutate()} data-action="edit-undo">Undo</Button>
      <span style={{ flex: 1 }} />
      <Button variant="primary" onClick={onClose} data-action="edit-done">Done</Button>
    </>
  ) : (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <span style={{ flex: 1 }} />
      {info.data?.model.enabled && <Button icon={Cpu} busy={model.isPending} disabled={!text.trim() || read.isPending} onClick={() => model.mutate()} data-action="edit-model">Draft with the local model</Button>}
      <Button busy={read.isPending} disabled={!text.trim() || model.isPending} onClick={() => read.mutate(undefined)} data-action="edit-read">{preview ? "Read again" : "Read the change"}</Button>
      <Button variant="primary" busy={apply.isPending} disabled={!canApply} onClick={() => apply.mutate()} data-action="edit-apply">Apply</Button>
    </>
  );

  return (
    <Modal title={title} onClose={onClose} width={1100} footer={footer}
      subtitle="Describe the new requirement or the issue you saw, one change per line. It is read on this server by fixed rules; nothing changes until you apply.">
      <div className="ws-dsc" data-testid="edit-dialog" data-state={applied ? "applied" : preview ? "preview" : "write"}>
        {dirty && <Callout tone="warn" title="Save first">The flow has unsaved changes. Save them, then change it in your own words (the change is applied to the saved version).</Callout>}
        {applied ? (
          <Callout tone="ok" title="Applied" >
            <span data-testid="edit-applied">{applied.flow ? `Saved as revision ${applied.flow.revision}, with your words as the note in the version history.` : "The connection was changed."} {applied.connection ? `Connection "${applied.connection.name}" was changed (secrets untouched).` : ""} {applied.deployedRevision ? `The live API still runs revision ${applied.deployedRevision} until you deploy again.` : ""} Undo brings back the version before this change.</span>
          </Callout>
        ) : (
          <>
            <Field label="The change" htmlFor="ws-edit-text" aside={<Button size="sm" variant="ghost" icon={BookOpen} onClick={() => setHelp((h) => !h)} aria-expanded={help} data-action="edit-help">What you can write</Button>}>
              <textarea id="ws-edit-text" className="mf-control mf-control-mono ws-dsc-text" rows={5} style={{ minHeight: 120 }} value={text} onChange={(e) => { setText(e.target.value); }} placeholder={phrases.slice(0, 4).map((p) => p.example).join("\n")} spellCheck={false} autoFocus aria-label="The change in your own words" />
            </Field>
            {help && (
              <div className="ws-dsc-help" data-testid="edit-help">
                <section className="ws-dsc-help-group" style={{ gridColumn: "1 / -1" }}>
                  <ul>
                    {phrases.map((p) => <li key={p.phrase}><div className="ws-dsc-help-phrase">{p.phrase}</div><pre className="ws-dsc-help-ex">{p.example}</pre><Button size="sm" onClick={() => setText((t) => (t.trim() ? `${t.replace(/\s+$/, "")}\n${p.example}` : p.example))}>Insert</Button></li>)}
                  </ul>
                </section>
              </div>
            )}
          </>
        )}
        {preview && !applied && (
          <div className="ws-dsc-preview">
            <div className="ws-dsc-summary" data-testid="edit-summary" data-changes={preview.changes.length} data-bad={bad}>
              {bad || !preview.ok ? <XCircle size={16} className="ws-dsc-bad" aria-hidden /> : <CheckCircle2 size={16} className="ws-dsc-ok" aria-hidden />}
              <span><b>{preview.changes.length} change{preview.changes.length === 1 ? "" : "s"}</b> to {txt(preview.targetLabel)}{bad ? <> · <b className="ws-dsc-bad">{bad} not understood</b></> : null}{newIssues.length ? <> · {newIssues.length} new problem{newIssues.length === 1 ? "" : "s"}</> : null}{preview.engine === "local-model" ? " · drafted by the local model" : ""}</span>
            </div>
            {deployedNote && <Callout tone="info">{deployedNote}</Callout>}
            {preview.missing.length > 0 && (
              <Callout tone="warn" title="Connection still missing">
                <ul className="ws-dsc-missing" data-testid="edit-missing">
                  {preview.missing.map((m) => <li key={m.key} data-missing={m.name}><span><b>{txt(m.name)}</b>: {txt(m.why)}</span><Button size="sm" icon={Plus} onClick={() => setNewConn(m)} data-action="edit-new-connection">New connection…</Button></li>)}
                </ul>
              </Callout>
            )}
            <div className="ws-dsc-cols">
              <div className="ws-dsc-doc">
                <ol className="ws-dsc-lines" data-testid="edit-lines" aria-label="Your lines and what was understood">
                  {lines.map((l) => (
                    <li key={l.line} className={cx("ws-dsc-line", `ws-dsc-line-${l.status}`)} data-line={l.line} data-line-status={l.status}>
                      <span className="ws-dsc-num">{l.line}</span>
                      <div className="ws-dsc-body">
                        <div className="ws-dsc-said"><code>{txt(l.text)}</code>{l.status === "ok" ? <Badge tone="ok">Understood</Badge> : l.status === "warning" ? <Badge tone="warn">Check</Badge> : l.status === "not-understood" ? <Badge tone="bad">Not understood</Badge> : null}</div>
                        {l.understood && <div className="ws-dsc-understood">{txt(l.understood)}</div>}
                        {l.message && <div className={cx("ws-dsc-msg", l.status === "not-understood" ? "ws-dsc-bad" : "ws-dsc-warn")}>{l.status === "not-understood" ? <CircleHelp size={13} aria-hidden /> : <AlertTriangle size={13} aria-hidden />}<span>{txt(l.message)}</span></div>}
                        {l.suggestions && l.suggestions.length > 0 && (
                          <div className="ws-dsc-sugg" data-testid="edit-suggestions"><span className="mf-help" style={{ margin: 0 }}>Closest phrasings:</span>
                            <ul>{l.suggestions.map((s) => <li key={s.phrase}><span><b>{txt(s.phrase)}</b><br /><code>{txt(s.example)}</code></span><Button size="sm" onClick={() => { const all = text.split("\n"); all[l.line - 1] = s.example; const next = all.join("\n"); setText(next); read.mutate(next); }} data-action="use-suggestion">Use</Button></li>)}</ul>
                            <Button size="sm" variant="ghost" onClick={() => { const all = text.split("\n"); all.splice(l.line - 1, 1); const next = all.join("\n"); setText(next); if (next.trim()) read.mutate(next); else setPreview(null); }} data-action="remove-line">Remove this line</Button>
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
                {preview.diagnoses.length > 0 && (
                  <Collapsible title="What was found" count={preview.diagnoses.length} defaultOpen>
                    <ul className="ws-dsc-list" data-testid="edit-diagnoses">{preview.diagnoses.map((d, k) => <li key={k}>{d.lesson && <Badge tone="warn">{d.lesson}</Badge>}<span>{txt(d.text)}</span></li>)}</ul>
                  </Collapsible>
                )}
                <Collapsible title="Before → after" count={preview.changes.length} defaultOpen>
                  <ul className="ws-dsc-list" data-testid="edit-changes">
                    {preview.changes.map((c, k) => (
                      <li key={k} data-change={c.kind} data-change-field={c.field} onMouseEnter={() => setFocus(c.nodeId ?? null)} onMouseLeave={() => setFocus(null)}>
                        <div className="ws-dsc-said"><Badge tone={c.kind === "remove-step" || c.kind === "remove-rule" ? "bad" : c.kind.startsWith("add") ? "ok" : "neutral"}>{KIND[c.kind] ?? c.kind}</Badge><b>{txt(c.nodeName ?? (c.kind === "connection" ? "" : "Flow"))}</b><span className="ws-dsc-understood">{txt(c.field)}</span></div>
                        <div className="ws-edit-diff"><code className="ws-edit-before">{txt(show(c.before))}</code><ArrowRight size={13} aria-hidden /><code className="ws-edit-after">{txt(show(c.after))}</code></div>
                        <div className="ws-dsc-ref">line {c.line}</div>
                      </li>
                    ))}
                  </ul>
                </Collapsible>
              </div>
              <div className="ws-dsc-right">
                {preview.flow && preview.flow.nodes.length > 0 && <MiniCanvas preview={{ flow: preview.flow, lines: preview.lines }} focus={new Set([...changedIds].filter((id) => !focus || id === focus))} onFocus={setFocus} labelOf={labelOf} />}
                {removed.length > 0 && <p className="mf-help" style={{ margin: 0 }} data-testid="edit-removed">Removed: {removed.map((r) => r.nodeName).join(", ")}</p>}
                {preview.issues === null
                  ? <Callout tone="warn" title="Not checked yet">{txt(preview.validationError ?? "The flow engine did not answer.")}</Callout>
                  : (
                    <div data-testid="edit-issues" data-new={newIssues.length}>
                      <Collapsible title={newIssues.length ? `The flow engine's check: ${newIssues.length} new` : "The flow engine's check: nothing new"} count={(preview.issues ?? []).length}>
                        <ul className="ws-dsc-issues">{(preview.issues ?? []).map((i, k) => <li key={k} className={i.level === "error" ? "ws-dsc-bad" : "ws-dsc-warn"}>{i.new ? <b>New: </b> : "Already there: "}{txt(i.message)}</li>)}</ul>
                      </Collapsible>
                    </div>
                  )}
                {lessons.length > 0 && (
                  <Collapsible title="Lessons" count={lessons.length} defaultOpen={lessons.some((l) => l.new)}>
                    <ul className="ws-dsc-issues" data-testid="edit-lessons">{lessons.map((l, k) => <li key={k} className="ws-dsc-warn">{l.new ? <b>New: </b> : "Already there: "}{txt(l.message)}</li>)}</ul>
                  </Collapsible>
                )}
              </div>
            </div>
            {bad > 0 && <p className="mf-help ws-dsc-bad" style={{ margin: 0 }} data-testid="edit-blocked">Change or remove the lines marked Not understood first: nothing is guessed for them.</p>}
            {!bad && !preview.ok && preview.changes.length === 0 && <p className="mf-help" style={{ margin: 0 }}>Nothing would change.</p>}
            {!bad && !preview.ok && preview.changes.length > 0 && <p className="mf-help ws-dsc-bad" style={{ margin: 0 }}>The changed flow has new problems that must be fixed first (see the check).</p>}
          </div>
        )}
        {problem && <Callout tone="bad" title="Not done">{problem}</Callout>}
      </div>
      {newConn && (
        <ConnectionDialog existing={null} types={catalog.connectionTypes} fixedType="http" initialName={newConn.name} initialConfig={newConn.suggested?.config ?? (newConn.suggested?.baseUrl ? { baseUrl: newConn.suggested.baseUrl } : undefined)}
          onClose={() => setNewConn(null)} onSaved={() => { setNewConn(null); read.mutate(undefined); }} />
      )}
    </Modal>
  );
}
