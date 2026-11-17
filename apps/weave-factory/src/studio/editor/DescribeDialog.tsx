// "Describe the flow": write the steps in your own words, one per line; this server reads them with
// fixed rules (no model, nothing leaves the server) and shows a preview first: every line next to the
// steps it made, lines that were not understood with the closest phrasings that are, connections that
// are still missing, and what the flow engine's check says. Nothing is saved until the user accepts:
// then a DRAFT flow is created (never deployed), or the steps are added to the open canvas.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, BookOpen, CheckCircle2, CircleHelp, Cpu, Plus, XCircle } from "lucide-react";
import { STEP_PHRASES, type ConnectionTypeDef, type DescribeLine, type DocumentInfo, type DocRef, type FlowNode, type MissingConnection, type StepPhrase } from "@traceit/weave-flow";
import { errorText, isUnavailable, studioApi, type DescribePreview } from "../api.ts";
import { accentOf, useCatalog } from "../catalog.ts";
import { Badge, Button, Callout, Collapsible, cx, Field, Modal, toast } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { ConnectionDialog } from "./ConnectionDialog.tsx";

const EXAMPLE = [
  "Guest check:",
  "When POST /guests/check arrives",
  "Look up the contact in Zoho by email",
  "If not found, create the contact in Zoho with first name, last name, email",
  "Log \"guest checked\"",
  "Answer 201 with the contact id",
].join("\n");

const STATUS: Record<DescribeLine["status"], { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  ok: { label: "Understood", tone: "ok" }, warning: { label: "Check", tone: "warn" }, "not-understood": { label: "Not understood", tone: "bad" }, ignored: { label: "", tone: "neutral" },
};
const PORT_WORD = (port: string, node: FlowNode | undefined): string => {
  if (port === "out") return "";
  if (port.startsWith("case:")) { const c = ((node?.config.conditions as { id: string; label: string }[] | undefined) ?? []).find((x) => `case:${x.id}` === port); return c ? "yes" : "yes"; }
  return port === "otherwise" ? "otherwise" : port === "error" ? "on error" : port === "each" ? "each" : port === "done" ? "done" : port;
};

/** "What you can write": every step phrasing with an example; Insert puts the example in the text. */
export function StepPhrasesHelp({ onInsert }: { onInsert?: (example: string) => void }) {
  const groups = useMemo(() => {
    const m = new Map<string, StepPhrase[]>();
    for (const p of STEP_PHRASES) m.set(p.group, [...(m.get(p.group) ?? []), p]);
    return [...m.entries()];
  }, []);
  return (
    <div className="ws-dsc-help" data-testid="describe-help">
      <p className="mf-help" style={{ margin: 0 }}>One step per line. Numbered or bulleted lists are fine. CAPITAL words are yours to fill in. Indent the steps that belong to an <b>If</b>, <b>Otherwise</b> or <b>For each</b>. Fields are written as you say them (first name becomes firstName); results of calls are kept under their name (the contact, the guest) so later lines can use them.</p>
      {groups.map(([g, list]) => (
        <section key={g} className="ws-dsc-help-group">
          <h4>{g}</h4>
          <ul>
            {list.map((p) => (
              <li key={p.phrase} data-phrase={p.phrase}>
                <div className="ws-dsc-help-phrase">{p.phrase}</div>
                {p.example && <pre className="ws-dsc-help-ex">{p.example}</pre>}
                {p.makes && <div className="mf-help" style={{ margin: 0 }}>{p.makes}</div>}
                {onInsert && p.example && !p.phrase.startsWith("Conditions:") && <Button size="sm" onClick={() => onInsert(p.example)} data-action="insert-example">Insert</Button>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The draft drawn small: boxes where the canvas will put them, with the connections between them. */
function MiniCanvas({ preview, focus, onFocus, labelOf }: { preview: DescribePreview; focus: Set<string>; onFocus: (id: string | null) => void; labelOf: (type: string) => { label: string; accent: string } }) {
  const nodes = preview.flow.nodes;
  const SX = 0.72, SY = 0.6, W = 196, H = 62, PAD = 12;
  const pos = (n: FlowNode) => ({ x: PAD + (n.position.x - 60) * SX, y: PAD + (n.position.y - 60) * SY });
  const width = Math.max(...nodes.map((n) => pos(n).x + W), 0) + PAD;
  const height = Math.max(...nodes.map((n) => pos(n).y + H), 0) + PAD;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <div className="ws-dsc-canvas" data-testid="describe-canvas" role="group" aria-label="Preview of the steps">
      <div style={{ position: "relative", width, height }}>
        <svg width={width} height={height} className="ws-dsc-edges" aria-hidden="true">
          {preview.flow.edges.map((e) => {
            const a = byId.get(e.from), b = byId.get(e.to);
            if (!a || !b) return null;
            const p = pos(a), q = pos(b);
            const x1 = p.x + W, y1 = p.y + H / 2, x2 = q.x, y2 = q.y + H / 2;
            const dx = Math.max(30, (x2 - x1) / 2);
            const word = PORT_WORD(e.fromPort, a);
            return (
              <g key={e.id} className={cx(e.fromPort === "error" && "ws-dsc-edge-err")}>
                <path d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`} />
                {word && <text x={x1 + 6} y={y1 + (y2 >= y1 ? 14 : -6)}>{word}</text>}
              </g>
            );
          })}
        </svg>
        {nodes.map((n) => {
          const p = pos(n);
          const l = labelOf(n.type);
          const lines = preview.lines.filter((x) => x.nodeIds.includes(n.id)).map((x) => x.line);
          return (
            <button key={n.id} type="button" className={cx("ws-dsc-node", focus.has(n.id) && "ws-dsc-node-on")} style={{ left: p.x, top: p.y, width: W, height: H, ["--chip" as string]: l.accent }}
              data-node-id={n.id} data-node-type={n.type} data-lines={lines.join(",")} onMouseEnter={() => onFocus(n.id)} onMouseLeave={() => onFocus(null)} onFocus={() => onFocus(n.id)} onBlur={() => onFocus(null)}
              title={`${n.name}${lines.length ? ` (line ${lines.join(", ")})` : ""}`}>
              <span className="ws-dsc-node-type">{txt(l.label)}</span>
              <span className="ws-dsc-node-name">{txt(n.name)}</span>
              {lines.length > 0 && <span className="ws-dsc-node-lines">line {lines.join(", ")}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const refText = (r: DocRef) => `${r.section || "Document"} · line ${r.line}`;
const KIND: Record<string, string> = { endpoint: "Endpoint", security: "Security", "request-sample": "Request", "response-sample": "Response", "response-rule": "Response", rule: "Rule", header: "Header", error: "Error", mapping: "Mapping", target: "Target", "target-sample": "Target", nonfunctional: "Non-functional", tests: "Tests" };

/** Document mode: what was taken from the document (each with its section, line and steps), the decisions
 *  still to take, conflicts with the choice made, rules that need a hand-written step, scenarios, and the
 *  prose that is not used for steps. Nothing here blocks Create except doc.blocking. */
function DocumentSections({ doc, nodes, onFocus, focus }: { doc: DocumentInfo; nodes: FlowNode[]; onFocus: (ids: string[]) => void; focus: Set<string> }) {
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name ?? id;
  const chips = (ids: string[]) => ids.length > 0 && (
    <div className="ws-dsc-chips">{ids.map((id) => <button key={id} type="button" className={cx("ws-dsc-chip", focus.has(id) && "ws-dsc-chip-on")} data-chip-node={id} onMouseEnter={() => onFocus([id])} onMouseLeave={() => onFocus([])} onFocus={() => onFocus([id])} onBlur={() => onFocus([])}>{txt(nameOf(id))}</button>)}</div>
  );
  return (
    <div className="ws-dsc-doc" data-testid="describe-document">
      <Collapsible title="Taken from the document" count={doc.items.length} defaultOpen>
        <ul className="ws-dsc-list" data-testid="doc-items">
          {doc.items.map((it, k) => (
            <li key={k} data-doc-item={it.kind} data-nodes={it.nodeIds.join(",")} onMouseEnter={() => onFocus(it.nodeIds)} onMouseLeave={() => onFocus([])}>
              <div className="ws-dsc-said"><Badge>{KIND[it.kind] ?? it.kind}</Badge><b>{txt(it.title)}</b></div>
              <div className="ws-dsc-understood">{txt(it.detail)}</div>
              <div className="ws-dsc-ref">{refText(it.ref)}</div>
              {chips(it.nodeIds)}
            </li>
          ))}
        </ul>
      </Collapsible>
      <Collapsible title="Decisions needed" count={doc.decisions.length} defaultOpen>
        <p className="mf-help" style={{ margin: 0 }}>Open points from the document. They do not block the draft; where one changes what was built, the choice made is shown.</p>
        <ul className="ws-dsc-list" data-testid="doc-decisions">
          {doc.decisions.map((d) => (
            <li key={d.id} data-decision={d.id} onMouseEnter={() => onFocus(d.affects ? [d.affects] : [])} onMouseLeave={() => onFocus([])}>
              <div className="ws-dsc-said"><Badge tone="warn">{txt(d.id)}</Badge><span>{txt(d.text)}</span></div>
              <div className="ws-dsc-understood">{txt(d.status)}{d.owner ? ` · ${txt(d.owner)}` : ""}</div>
              <div className="ws-dsc-choice">{d.choice ? <>Built as: {txt(d.choice)}</> : "Nothing built depends on it yet."}</div>
              <div className="ws-dsc-ref">{refText(d.ref)}</div>
            </li>
          ))}
        </ul>
      </Collapsible>
      {doc.conflicts.length > 0 && (
        <Collapsible title="Conflicts in the document" count={doc.conflicts.length} defaultOpen>
          <ul className="ws-dsc-list" data-testid="doc-conflicts">
            {doc.conflicts.map((c, k) => (
              <li key={k} data-conflict={k}>
                <div className="ws-dsc-msg ws-dsc-warn"><AlertTriangle size={13} aria-hidden /><span>{txt(c.text)}</span></div>
                <div className="ws-dsc-choice">Choice made: {txt(c.choice)}</div>
                <div className="ws-dsc-ref">{c.refs.map(refText).join(" · ")}</div>
              </li>
            ))}
          </ul>
        </Collapsible>
      )}
      {doc.handWritten.length > 0 && (
        <Collapsible title="Needs a hand-written step" count={doc.handWritten.length} defaultOpen>
          <ul className="ws-dsc-list" data-testid="doc-handwritten">
            {doc.handWritten.map((h, k) => <li key={k}><div><b>{txt(h.text)}</b></div><div className="ws-dsc-understood">{txt(h.why)}</div><div className="ws-dsc-ref">{refText(h.ref)}</div></li>)}
          </ul>
        </Collapsible>
      )}
      {doc.scenarios.length > 0 && (
        <Collapsible title="Test scenarios from the document" count={doc.scenarios.length}>
          <p className="mf-help" style={{ margin: 0 }}>Kept with the flow's listener (testScenarios), with made-up e-mail and numbers. Expected answer in brackets.</p>
          <ul className="ws-dsc-list" data-testid="doc-scenarios">
            {doc.scenarios.map((sc) => <li key={sc.id} data-scenario={sc.id} data-derived={sc.derived ? "yes" : "no"}><b>{txt(sc.id)}</b> {txt(sc.title)} <span className="ws-dsc-understood">({sc.expect.status || "?"}{sc.expect.code ? ` ${sc.expect.code}` : ""})</span>{!sc.derived && <Badge tone="warn">inputs not derived</Badge>}</li>)}
          </ul>
        </Collapsible>
      )}
      <Collapsible title="Not used for steps" count={doc.notUsed.length}>
        <ul className="ws-dsc-list" data-testid="doc-notused">
          {doc.notUsed.map((n, k) => <li key={k}><b>{txt(n.section)}</b> <span className="ws-dsc-understood">{txt(n.reason)}</span></li>)}
        </ul>
      </Collapsible>
    </div>
  );
}

export function DescribeDialog({ mode, onClose, onAdd }: { mode: "new" | "add"; onClose: () => void; onAdd?: (p: DescribePreview) => void }) {
  const catalog = useCatalog();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["studio", "describe-info"], queryFn: studioApi.describeInfo, retry: 0, staleTime: 60_000 });
  const conns = useQuery({ queryKey: ["studio", "connections"], queryFn: studioApi.connections, retry: 0, staleTime: 15_000 });
  const [text, setText] = useState("");
  const [ownText, setOwnText] = useState<string | null>(null);
  const [preview, setPreview] = useState<DescribePreview | null>(null);
  const [stage, setStage] = useState<"write" | "preview">("write");
  const [help, setHelp] = useState(false);
  const [name, setName] = useState("");
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const [focusNode, setFocusNode] = useState<string | null>(null);
  const [focusIds, setFocusIds] = useState<string[]>([]);
  const [newConn, setNewConn] = useState<MissingConnection | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const shown = (p: DescribePreview) => { setPreview(p); setStage("preview"); setName((n) => (n && stage === "preview" ? n : p.flow.name)); setProblem(null); };
  const read = useMutation({
    mutationFn: (t?: string) => studioApi.describePreview(t ?? text, mode),
    onSuccess: shown,
    onError: (e) => setProblem(isUnavailable(e) ? "The flow engine cannot be reached right now, so the steps were not read. Try again in a moment." : errorText(e)),
  });
  const model = useMutation({
    mutationFn: () => studioApi.describeModel(text, mode),
    onSuccess: (p) => { if (p.modelText) { setOwnText(text); setText(p.modelText); } shown(p); },
    onError: (e) => setProblem(errorText(e)),
  });
  const create = useMutation({
    mutationFn: () => studioApi.createFlow({ name: name.trim() || preview!.flow.name, description: preview!.flow.description, flow: { nodes: preview!.flow.nodes, edges: preview!.flow.edges, ...(preview!.flow.settings ? { settings: preview!.flow.settings as never } : {}), ...(preview!.flow.description ? { description: preview!.flow.description } : {}) }, origin: { kind: "blank", ref: preview!.mode === "document" ? "document" : "described" } }),
    onSuccess: (f) => { void qc.invalidateQueries({ queryKey: ["studio", "flows"] }); toast("Draft flow created. It is not live until you deploy it."); onClose(); navigate(`/studio/flows/${encodeURIComponent(f.id)}`); },
    onError: (e) => setProblem(errorText(e)),
  });

  const labelOf = (type: string) => { const d = catalog.byType.get(type); return { label: d?.label ?? (type.startsWith("connector:") ? "Connector step" : type), accent: accentOf(d) }; };
  const lines = preview?.lines.filter((l) => l.text) ?? [];
  const bad = lines.filter((l) => l.status === "not-understood").length;
  const warns = lines.filter((l) => l.status === "warning").length;
  const errors = (preview?.issues ?? []).filter((i) => i.level === "error");
  const warnings = (preview?.issues ?? []).filter((i) => i.level === "warning");
  const focus = useMemo(() => {
    const s = new Set<string>();
    if (focusLine !== null) for (const id of preview?.lines.find((l) => l.line === focusLine)?.nodeIds ?? []) s.add(id);
    if (focusNode) s.add(focusNode);
    for (const id of focusIds) s.add(id);
    return s;
  }, [focusLine, focusNode, focusIds, preview]);
  const linesOfFocusNode = useMemo(() => new Set(focusNode ? (preview?.lines ?? []).filter((l) => l.nodeIds.includes(focusNode)).map((l) => l.line) : []), [focusNode, preview]);
  const busy = read.isPending || model.isPending;
  const isDoc = preview?.mode === "document";
  const canAccept = !!preview && preview.flow.nodes.length > 0 && (isDoc ? preview.ok && !(preview.doc?.blocking.length) : bad === 0);
  const useSuggestion = (line: number, example: string) => {
    const all = text.split("\n");
    const lead = /^\s*/.exec(all[line - 1] ?? "")?.[0] ?? "";
    const parts = example.split("\n");
    all.splice(line - 1, 1, ...parts.map((p, i) => (i === 0 ? lead + p : lead + p)));
    const next = all.join("\n");
    setText(next);
    read.mutate(next);
  };
  const removeLine = (line: number) => { const all = text.split("\n"); all.splice(line - 1, 1); const next = all.join("\n"); setText(next); read.mutate(next); };
  const types: ConnectionTypeDef[] = catalog.connectionTypes;
  const modelOn = !!info.data?.model.enabled;

  const footer = stage === "write" ? (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <span style={{ flex: 1 }} />
      {modelOn && <Button icon={Cpu} busy={model.isPending} disabled={!text.trim() || busy} onClick={() => model.mutate()} data-action="describe-model" title="Asks the model that runs on this server to rewrite your text as step lines. Its answer is read by the same rules and shown first.">Draft with the local model</Button>}
      <Button variant="primary" busy={read.isPending} disabled={!text.trim() || busy} onClick={() => read.mutate(undefined)} data-action="describe-read">Read the steps</Button>
    </>
  ) : (
    <>
      <Button icon={ArrowLeft} onClick={() => setStage("write")} data-action="describe-back">Change the text</Button>
      <span style={{ flex: 1 }} />
      <Button onClick={onClose}>Cancel</Button>
      {mode === "new"
        ? <Button variant="primary" busy={create.isPending} disabled={!canAccept || !name.trim()} onClick={() => create.mutate()} data-action="describe-accept">Create the draft flow</Button>
        : <Button variant="primary" disabled={!canAccept} onClick={() => { onAdd?.(preview!); onClose(); }} data-action="describe-accept">Add to the canvas</Button>}
    </>
  );

  return (
    <Modal title={mode === "new" ? "Describe the flow" : "Add steps from a description"} onClose={onClose} width={1180} footer={footer}
      subtitle="Write what should happen, one step per line, or paste a whole requirement document. It is read on this server by fixed rules; nothing is sent anywhere and nothing is saved until you accept.">
      <div className="ws-dsc" data-testid="describe-dialog" data-stage={stage}>
        {stage === "write" && (
          <div className="ws-dsc-write">
            <Field label="The steps" htmlFor="ws-describe-text" aside={<Button size="sm" variant="ghost" icon={BookOpen} onClick={() => setHelp((h) => !h)} aria-expanded={help} data-action="describe-help">What you can write</Button>}>
              <textarea id="ws-describe-text" className="mf-control mf-control-mono ws-dsc-text" rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} spellCheck={false} autoFocus aria-label="Describe the flow" />
            </Field>
            {!text.trim() && <div><Button size="sm" onClick={() => setText(EXAMPLE)} data-action="describe-example">Start from the example</Button></div>}
            {help && <StepPhrasesHelp onInsert={(ex) => setText((t) => (t.trim() ? `${t.replace(/\s+$/, "")}\n${ex}` : ex))} />}
            {modelOn && <p className="mf-help" style={{ margin: 0 }}><Cpu size={13} aria-hidden /> <b>Draft with the local model</b> asks the model that runs on this server (never an outside service) to turn free text into step lines; the result is read by the same rules and shown first, never saved on its own.{info.data?.model.configured ? "" : " It is switched on but has no address yet, so it will say so."}</p>}
            {problem && <Callout tone="bad" title="Not read">{problem}</Callout>}
          </div>
        )}
        {stage === "preview" && preview && (
          <div className="ws-dsc-preview">
            {isDoc && preview.doc && (
              <div className="ws-dsc-summary" data-testid="describe-doc-summary" data-steps={preview.flow.nodes.length} data-decisions={preview.doc.decisions.length} data-conflicts={preview.doc.conflicts.length} data-handwritten={preview.doc.handWritten.length} data-blocking={preview.doc.blocking.length}>
                {preview.doc.blocking.length ? <XCircle size={16} className="ws-dsc-bad" aria-hidden /> : <CheckCircle2 size={16} className="ws-dsc-ok" aria-hidden />}
                <span>Read as a <b>requirement document</b>: <b>{preview.flow.nodes.length} steps</b> · {preview.doc.items.length} items taken · {preview.doc.decisions.length} decisions needed · {preview.doc.conflicts.length} conflict{preview.doc.conflicts.length === 1 ? "" : "s"} · {preview.doc.handWritten.length} need a hand-written step · {preview.doc.scenarios.length} test scenarios</span>
              </div>
            )}
            {isDoc && preview.doc && preview.doc.blocking.length > 0 && <Callout tone="bad" title="This stops the draft">{preview.doc.blocking.map((b) => <div key={b}>{txt(b)}</div>)}</Callout>}
            {!isDoc && <div className="ws-dsc-summary" data-testid="describe-summary" data-bad={bad} data-warnings={warns} data-steps={preview.flow.nodes.length}>
              {bad > 0 ? <XCircle size={16} className="ws-dsc-bad" aria-hidden /> : <CheckCircle2 size={16} className="ws-dsc-ok" aria-hidden />}
              <span><b>{preview.flow.nodes.length} step{preview.flow.nodes.length === 1 ? "" : "s"}</b> from {lines.filter((l) => l.role !== "comment").length} line{lines.length === 1 ? "" : "s"}
                {bad > 0 && <> · <b className="ws-dsc-bad">{bad} not understood</b></>}{warns > 0 && <> · {warns} to check</>}
                {preview.engine === "local-model" && <> · drafted by the local model</>}</span>
            </div>}
            {mode === "new" && <Field label="Flow name" htmlFor="ws-describe-name"><input id="ws-describe-name" className="mf-control" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>}
            {preview.engine === "local-model" && ownText !== null && <Callout tone="info" title="The local model rewrote your text as these lines">They were read by the same rules as typed lines. <Button size="sm" onClick={() => { setText(ownText); setOwnText(null); setStage("write"); }}>Back to my own words</Button></Callout>}
            {preview.missing.length > 0 && (
              <Callout tone="warn" title={preview.missing.every((m) => m.existingId) ? `Connection${preview.missing.length === 1 ? "" : "s"} to adjust` : `Connection${preview.missing.length === 1 ? "" : "s"} still missing`}>
                <ul className="ws-dsc-missing" data-testid="describe-missing">
                  {preview.missing.map((m) => (
                    <li key={m.key} data-missing={m.name} data-missing-type={m.type} data-missing-existing={m.existingId ? "yes" : "no"}>
                      <span><b>{txt(m.name)}</b> ({types.find((t) => t.type === m.type)?.label ?? m.type}, line {m.lines.join(", ")}): {txt(m.why)}{m.suggested?.config && <> Pre-filled: {Object.entries(m.suggested.config).filter(([k]) => k !== "timeoutMs").map(([k, v]) => `${k} ${String(v)}`).join(" · ")}.</>}</span>
                      {m.existingId
                        ? <Button size="sm" onClick={() => setNewConn(m)} data-action="describe-edit-connection" disabled={!conns.data?.connections.some((c) => c.id === m.existingId)}>Edit connection…</Button>
                        : <Button size="sm" icon={Plus} onClick={() => setNewConn(m)} data-action="describe-new-connection">New connection…</Button>}
                    </li>
                  ))}
                </ul>
                <span className="mf-help" style={{ margin: 0 }}>The draft can be created without them; the steps that need one show a problem until it is chosen.</span>
              </Callout>
            )}
            <div className="ws-dsc-cols">
              {isDoc && preview.doc && <DocumentSections doc={preview.doc} nodes={preview.flow.nodes} onFocus={setFocusIds} focus={focus} />}
              {!isDoc && <ol className="ws-dsc-lines" data-testid="describe-lines" aria-label="Your lines and what was understood">
                {lines.map((l) => {
                  const st = STATUS[l.status];
                  return (
                    <li key={l.line} className={cx("ws-dsc-line", `ws-dsc-line-${l.status}`, (focusLine === l.line || linesOfFocusNode.has(l.line)) && "ws-dsc-line-on")}
                      data-line={l.line} data-line-status={l.status} data-line-nodes={l.nodeIds.join(",")}
                      onMouseEnter={() => setFocusLine(l.line)} onMouseLeave={() => setFocusLine(null)}>
                      <span className="ws-dsc-num">{l.line}</span>
                      <div className="ws-dsc-body">
                        <div className="ws-dsc-said"><code>{txt(l.text)}</code>{st.label && <Badge tone={st.tone}>{st.label}</Badge>}{l.role === "header" && <Badge>Name</Badge>}{l.role === "comment" && <Badge>Comment</Badge>}</div>
                        {l.understood && <div className="ws-dsc-understood">{txt(l.understood)}</div>}
                        {l.message && <div className={cx("ws-dsc-msg", l.status === "not-understood" ? "ws-dsc-bad" : "ws-dsc-warn")}>{l.status === "not-understood" ? <CircleHelp size={13} aria-hidden /> : <AlertTriangle size={13} aria-hidden />}<span>{txt(l.message)}</span></div>}
                        {l.suggestions && l.suggestions.length > 0 && (
                          <div className="ws-dsc-sugg" data-testid="describe-suggestions">
                            <span className="mf-help" style={{ margin: 0 }}>Closest phrasings:</span>
                            <ul>
                              {l.suggestions.map((s) => (
                                <li key={s.phrase}><span><b>{txt(s.phrase)}</b><br /><code>{txt(s.example.split("\n")[0])}</code></span><Button size="sm" onClick={() => useSuggestion(l.line, s.example)} data-action="use-suggestion">Use</Button></li>
                              ))}
                            </ul>
                            <Button size="sm" variant="ghost" onClick={() => removeLine(l.line)} data-action="remove-line">Remove this line</Button>
                          </div>
                        )}
                        {l.nodeIds.length > 0 && (
                          <div className="ws-dsc-chips">
                            {l.nodeIds.map((id) => { const n = preview.flow.nodes.find((x) => x.id === id); return n ? <button key={id} type="button" className={cx("ws-dsc-chip", focus.has(id) && "ws-dsc-chip-on")} onFocus={() => setFocusNode(id)} onBlur={() => setFocusNode(null)} onMouseEnter={() => setFocusNode(id)} onMouseLeave={() => setFocusNode(null)} data-chip-node={id}>{txt(n.name)}</button> : null; })}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>}
              <div className="ws-dsc-right">
                {preview.flow.nodes.length > 0 ? <MiniCanvas preview={preview} focus={focus} onFocus={setFocusNode} labelOf={labelOf} /> : <Callout tone="warn">No step could be made from this text yet.</Callout>}
                {preview.issues === null
                  ? <Callout tone="warn" title="Not checked yet">{txt(preview.validationError ?? "The flow engine did not answer.")}</Callout>
                  : (
                    <div data-testid="describe-issues" data-errors={errors.length} data-warnings={warnings.length}>
                      <Collapsible title={errors.length || warnings.length ? `The flow engine's check: ${errors.length} must fix before deploying, ${warnings.length} to look at` : "The flow engine's check: no problems"} count={errors.length + warnings.length}>
                        <ul className="ws-dsc-issues">
                          {[...errors, ...warnings].map((i, k) => <li key={k} className={i.level === "error" ? "ws-dsc-bad" : "ws-dsc-warn"}>{i.level === "error" ? "Must fix: " : "Look at: "}{txt(i.message)}</li>)}
                        </ul>
                      </Collapsible>
                    </div>
                  )}
                {preview.notes.map((n) => <p key={n} className="mf-help" style={{ margin: 0 }}>{txt(n)}</p>)}
              </div>
            </div>
            {bad > 0 && <p className="mf-help ws-dsc-bad" style={{ margin: 0 }} data-testid="describe-blocked">Change or remove the lines marked Not understood first: nothing is guessed for them.</p>}
            {mode === "new" && canAccept && <p className="mf-help" style={{ margin: 0 }}>The flow is created as a draft and opened on the canvas. It is not live until you deploy it.</p>}
            {problem && <Callout tone="bad" title="Not done">{problem}</Callout>}
          </div>
        )}
      </div>
      {newConn && (
        <ConnectionDialog existing={newConn.existingId ? conns.data?.connections.find((c) => c.id === newConn.existingId) ?? null : null} types={types} fixedType={types.some((t) => t.type === newConn.type) ? newConn.type : undefined}
          initialName={newConn.name} initialConfig={newConn.suggested?.config ?? (newConn.suggested?.baseUrl ? { baseUrl: newConn.suggested.baseUrl } : undefined)}
          onClose={() => setNewConn(null)} onSaved={() => { setNewConn(null); read.mutate(undefined); }} />
      )}
    </Modal>
  );
}
