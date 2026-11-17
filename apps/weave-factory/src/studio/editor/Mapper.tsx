// The mapper: input fields on the left, rules in the middle, output on the right. Rules can
// be a copy, an expression, a fixed value, or a sentence in the user's own words that the
// runtime's local interpreter turns into an expression (and shows how it understood it).
import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, BookOpen, Check, Lightbulb, MessageSquare, Plus, RefreshCw, Sparkles, Trash2, TriangleAlert, Wand2 } from "lucide-react";
import { JOIN_RULE, MAPPING_PHRASES, type CompileInstructionResponse, type Json, type MappingRule, type MappingSpec } from "@traceit/weave-flow";
import { errorText, isUnavailable, studioApi } from "../api.ts";
import { ruleProblem } from "../graph.ts";
import { arrayPaths, convertRule, describeRule, KIND_LABEL, leafPaths, looksLikeProse, newRule, readPath, SHAPE_HINT, SHAPE_LABEL, shapeNeedsTarget, showValue, specStats, targetFromSource, type RuleKind, type ShapeKind } from "../mapping.ts";
import { AutoTextArea, Badge, Button, Callout, cx, DataView, IconButton, JsonEditor, JsonTree, Modal, Spinner, Tabs, Toggle, toast, useBreakpoint, useDebounced, type JsonTextState } from "../ui.tsx";
import { txt } from "../../lib/text.ts";
import { ExprInput } from "./fields.tsx";

const DND_PATH = "application/x-weave-path";
const KINDS: RuleKind[] = ["direct", "expr", "const", "instruction"];
type RuleResult = { id: string; ok: boolean; value?: Json; error?: string; warning?: string; missing?: string[]; compiled?: { expr?: string } | null };
const SHAPES: ShapeKind[] = ["object", "each", "values", "value"];

function dropPath(e: React.DragEvent): string | null {
  const p = e.dataTransfer.getData(DND_PATH);
  if (!p) return null;
  e.preventDefault();
  e.stopPropagation();
  return p;
}
const allowDrop = (e: React.DragEvent) => { if (Array.from(e.dataTransfer.types).includes(DND_PATH)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } };
function parseConst(text: string): Json {
  const t = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^[[{]/.test(t)) { try { return JSON.parse(t) as Json; } catch { /* keep as text */ } }
  return text;
}
const constText = (v: Json | undefined) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
const constType = (v: Json | undefined) => (v === null ? "empty value" : Array.isArray(v) ? "list" : typeof v === "object" ? "object" : typeof v === "number" ? "number" : typeof v === "boolean" ? "true / false" : "text");

// ---------------------------------------------------------------- "in your words"
function InstructionEditor({ rule, onChange, sample, examples, readOnly, stale, missing, sampleInvalid }: { rule: MappingRule; onChange: (r: MappingRule) => void; sample: Json | undefined; examples: string[]; readOnly?: boolean; stale?: boolean; missing?: string[]; sampleInvalid?: boolean }) {
  const latest = useRef(rule);
  latest.current = rule;
  const [info, setInfo] = useState<{ forText: string; res?: CompileInstructionResponse; error?: string; offline?: boolean } | null>(null);
  const [showExpr, setShowExpr] = useState(false);
  const text = rule.instruction ?? "";
  const compile = useMutation({
    mutationFn: (t: string) => studioApi.compileInstruction({ instruction: t, target: latest.current.target || undefined, sampleSource: sample }),
    onSuccess: (res, t) => {
      setInfo({ forText: t, res });
      if ((latest.current.instruction ?? "") === t) onChange({ ...latest.current, compiled: res.compiled ?? null });
    },
    onError: (e, t) => setInfo({ forText: t, error: errorText(e), offline: isUnavailable(e) }),
  });
  const debounced = useDebounced(text, 900);
  useEffect(() => {
    const t = debounced.trim();
    if (readOnly || !t || latest.current.compiled?.expr || (latest.current.instruction ?? "") !== debounced) return;
    if (info?.forText === debounced || compile.isPending) return;
    compile.mutate(debounced);
  }, [debounced]);
  // The stored reading failed on the sample, or the server had to read the words again: fetch the current reading once.
  useEffect(() => {
    const t = (latest.current.instruction ?? "").trim();
    if (!stale || readOnly || !t || !latest.current.compiled?.expr || info?.forText === latest.current.instruction || compile.isPending) return;
    compile.mutate(latest.current.instruction ?? "");
  }, [stale]);
  const c = rule.compiled;
  const current = info && info.forText === text ? info : null;
  const notUnderstood = !c?.expr && !!current?.res && !current.res.compiled;
  return (
    <div className="mf-stack" style={{ gap: 8 }}>
      <AutoTextArea value={text} minRows={2} maxRows={6} readOnly={readOnly} aria-label="Rule in your words" placeholder={examples[0] ? `For example: ${examples[0]}` : "Describe what this field should contain"}
        onChange={(v) => onChange({ ...rule, instruction: v, compiled: null })}
        onBlur={() => { const t = text.trim(); if (!readOnly && t && !rule.compiled?.expr && info?.forText !== text && !compile.isPending) compile.mutate(text); }} />
      {compile.isPending && <Spinner label="Reading your rule…" />}
      {!compile.isPending && c?.expr && (
        <div className="ws-understood" data-understood="yes">
          <div className="ws-understood-head">
            <Check size={15} aria-hidden />
            <span><strong>Understood as:</strong> {txt(c.explanation) || "a rule"}</span>
          </div>
          <div className="mf-hstack">
            {missing?.length
              ? <Badge tone="warn" icon={TriangleAlert}>check: {missing.join(", ")} {missing.length === 1 ? "is" : "are"} not in the sample</Badge>
              : <Badge tone={c.confidence === "exact" ? "ok" : "warn"}>{c.confidence === "exact" ? "confident" : "best guess, please check"}</Badge>}
            <Badge>{c.engine === "in-estate-model" ? "your in-house model" : "built-in rules on this server"}</Badge>
            <button type="button" className="mf-linkbtn" onClick={() => setShowExpr((s) => !s)} aria-expanded={showExpr}>{showExpr ? "Hide expression" : "Show expression"}</button>
          </div>
          {!!missing?.length && (
            <span className="ws-understood-warn" data-rule-missing>{missing.join(", ")} {missing.length === 1 ? "is" : "are"} not in the {sampleInvalid ? "last valid " : ""}sample, so the result below was made without {missing.length === 1 ? "it" : "them"}. Add {missing.length === 1 ? "it" : "them"} to the sample, or check the field name.</span>
          )}
          {showExpr && (
            <div className="mf-stack" style={{ gap: 6 }}>
              <code className="ws-understood-expr" data-compiled-expr>{txt(c.expr)}</code>
              {!readOnly && <div><Button size="sm" variant="ghost" icon={Wand2} onClick={() => onChange(convertRule(rule, "expr"))}>Edit as an expression</Button></div>}
            </div>
          )}
        </div>
      )}
      {!compile.isPending && notUnderstood && (
        <Callout tone="warn" title="Not understood yet" actions={!readOnly ? <Button size="sm" onClick={() => onChange(convertRule({ ...rule, compiled: null }, "expr"))}>Write an expression instead</Button> : undefined}>
          <span data-understood="no">The built-in interpreter could not turn this sentence into a rule, so this field is not filled and the flow cannot be deployed until it is resolved. Nothing was sent outside this server.</span>
          {!!current?.res?.suggestions?.length && <span>Try one of these phrasings:</span>}
          {!!current?.res?.suggestions?.length && (
            <span className="ws-suggest">
              {current.res.suggestions.map((s) => <button key={s} type="button" className="ws-suggest-chip" disabled={readOnly} onClick={() => { onChange({ ...rule, instruction: s, compiled: null }); compile.mutate(s); }}>{txt(s)}</button>)}
            </span>
          )}
        </Callout>
      )}
      {!compile.isPending && current?.error && !c?.expr && (
        <Callout tone="bad" title={current.offline ? "The interpreter cannot be reached" : "This rule could not be read"} actions={<Button size="sm" icon={RefreshCw} onClick={() => compile.mutate(text)}>Try again</Button>}>
          <span>{current.error}</span>
          <span>The rule is kept as you wrote it and stays unresolved until it has been understood.</span>
        </Callout>
      )}
      {!compile.isPending && !c?.expr && !current && !!text.trim() && !readOnly && (
        <div><Button size="sm" icon={Sparkles} onClick={() => compile.mutate(text)} data-action="understand">Understand this rule</Button></div>
      )}
      {!text.trim() && !readOnly && examples.length > 0 && (
        <span className="ws-suggest" aria-label="Examples">
          {examples.slice(0, 4).map((s) => <button key={s} type="button" className="ws-suggest-chip" onClick={() => { onChange({ ...rule, instruction: s, compiled: null }); compile.mutate(s); }}>{txt(s)}</button>)}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- one rule
function RuleCard({ rule, index, result, sample, paths, examples, readOnly, onChange, onRemove, shapeKind, sampleInvalid }: {
  rule: MappingRule; index: number; result?: RuleResult; sample: Json | undefined; paths: string[]; examples: string[]; readOnly?: boolean;
  onChange: (r: MappingRule) => void; onRemove: () => void; shapeKind?: ShapeKind; sampleInvalid?: boolean;
}) {
  const [note, setNote] = useState(!!rule.comment);
  const [over, setOver] = useState(false);
  const problem = ruleProblem(rule, shapeKind);
  const off = rule.enabled === false;
  const unresolved = rule.kind === "instruction" && !rule.compiled?.expr && !off;
  const listId = `ws-paths-${rule.id}`;
  const onDrop = (e: React.DragEvent) => {
    setOver(false);
    if (readOnly) return;
    const p = dropPath(e);
    if (!p) return;
    if (rule.kind === "direct") onChange({ ...rule, source: p, target: rule.target || targetFromSource(p) });
    else if (rule.kind === "expr") onChange({ ...rule, expr: `${rule.expr ?? ""}${rule.expr ? " & " : ""}${p}` });
    else if (rule.kind === "instruction") onChange({ ...rule, instruction: `${rule.instruction ?? ""}${rule.instruction ? " " : ""}${p}`, compiled: null });
  };
  const localValue = rule.kind === "direct" && rule.source ? readPath(sample, rule.source) : rule.kind === "const" ? rule.value : undefined;
  const prose = rule.kind === "expr" && !!rule.expr && looksLikeProse(rule.expr) && (!result || !result.ok);
  return (
    <li className={cx("ws-rule", off && "ws-rule-off", unresolved && "ws-rule-unresolved", over && "ws-rule-over")} data-rule-index={index} data-rule-kind={rule.kind} data-rule-target={rule.target} data-rule-state={unresolved ? "unresolved" : problem ? "incomplete" : (result && !result.ok) || prose ? "error" : "ok"}
      onDragOver={(e) => { allowDrop(e); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div className="ws-rule-top">
        <input className="mf-control mf-control-sm mf-control-mono ws-rule-target" aria-label="Output field" placeholder={shapeNeedsTarget(shapeKind) ? (shapeKind === "each" ? "field of each item, e.g. name" : "output field, e.g. customer.fullName") : "label (optional)"} value={rule.target} readOnly={readOnly} onChange={(e) => onChange({ ...rule, target: e.target.value })} />
        <select className="mf-control mf-control-sm ws-rule-kind" aria-label="How this field is filled" value={rule.kind} disabled={readOnly} onChange={(e) => onChange(convertRule(rule, e.target.value as RuleKind))}>
          {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        {!readOnly && <IconButton label={note ? "Hide note" : "Add a note to this rule"} icon={MessageSquare} size={14} active={note} onClick={() => setNote((n) => !n)} />}
        {!readOnly && <IconButton label="Delete rule" icon={Trash2} size={14} tone="danger" onClick={onRemove} />}
      </div>
      <div className="ws-rule-body">
        {rule.kind === "direct" && <>
          <input className="mf-control mf-control-sm mf-control-mono" aria-label="Input field" list={listId} placeholder="input field, e.g. customer.name (or drop one here)" value={rule.source ?? ""} readOnly={readOnly} onChange={(e) => onChange({ ...rule, source: e.target.value })} />
          <datalist id={listId}>{paths.slice(0, 200).map((p) => <option key={p} value={p} />)}</datalist>
        </>}
        {rule.kind === "expr" && <ExprInput mode="expr" value={rule.expr ?? ""} onChange={(v) => onChange({ ...rule, expr: v })} placeholder={'customer.firstName & " " & customer.lastName'} ariaLabel="Expression" readOnly={readOnly} live={false} minRows={1} maxRows={8} />}
        {rule.kind === "const" && (
          <div className="mf-inputrow">
            <input className="mf-control mf-control-sm" aria-label="Fixed value" placeholder="value" value={constText(rule.value)} readOnly={readOnly} onChange={(e) => onChange({ ...rule, value: parseConst(e.target.value) })} />
            <Badge>{constType(rule.value ?? "")}</Badge>
          </div>
        )}
        {rule.kind === "instruction" && <InstructionEditor rule={rule} onChange={onChange} sample={sample} examples={examples} readOnly={readOnly} stale={!!result && (!result.ok || !!result.compiled?.expr) && !!rule.compiled?.expr} missing={result?.missing} sampleInvalid={sampleInvalid} />}
        {prose && !readOnly && (
          <Callout tone="info" title="This reads like a sentence, not an expression" actions={<Button size="sm" icon={Sparkles} onClick={() => onChange(convertRule(rule, "instruction"))} data-action="treat-as-words">Treat this as a rule in your words</Button>}>
            <span>Expressions use field names and functions. If you meant to describe the rule in plain words, switch it and it will be interpreted for you.</span>
          </Callout>
        )}
      </div>
      <div className="ws-rule-foot">
        {off ? <span className="mf-faint">Switched off: this field is not filled.</span>
          : unresolved ? <span className="ws-rule-err" data-rule-msg="unresolved">Unresolved: {problem}</span>
          : problem ? <span className="ws-rule-err" data-rule-msg="incomplete">{problem}</span>
          : result && !result.ok ? <span className="ws-rule-err" data-rule-msg="error">{txt(result.error) || "This rule fails on the sample."}</span>
          : result ? <span className="ws-rule-val" data-rule-value><ArrowRight size={12} aria-hidden /><code>{showValue(result.value)}</code>{result.warning && <span className="ws-rule-warn" data-rule-warning><TriangleAlert size={12} aria-hidden /> {txt(result.warning)}</span>}</span>
          : localValue !== undefined ? <span className="ws-rule-val"><ArrowRight size={12} aria-hidden /><code>{showValue(localValue)}</code></span>
          : <span className="mf-faint">No preview yet</span>}
        <span style={{ flex: 1 }} />
        {!readOnly && <Toggle checked={!off} onChange={(v) => onChange({ ...rule, enabled: v ? undefined : false })} label={<span className="mf-sr">Rule enabled</span>} />}
      </div>
      {(note || rule.comment) && (
        readOnly ? <p className="ws-rule-note">{txt(rule.comment)}</p>
          : <input className="mf-control mf-control-sm ws-rule-noteinput" aria-label="Note" placeholder="Note for whoever maintains this (never executed)" value={rule.comment ?? ""} onChange={(e) => onChange({ ...rule, comment: e.target.value || undefined })} />
      )}
    </li>
  );
}

// ---------------------------------------------------------------- mapper
export function Mapper({ spec, onChange, readOnly, lastInput, examples }: { spec: MappingSpec; onChange: (s: MappingSpec) => void; readOnly?: boolean; lastInput?: Json; examples: string[] }) {
  const bp = useBreakpoint();
  const [pane, setPane] = useState<"input" | "rules" | "output">("rules");
  const [editIn, setEditIn] = useState(false);
  const [editOut, setEditOut] = useState(false);
  const [suggested, setSuggested] = useState<MappingRule[] | null>(null);
  const [sampleText, setSampleText] = useState<JsonTextState | null>(null);
  const [help, setHelp] = useState(false);
  const [helpFilter, setHelpFilter] = useState("");
  const sampleInvalid = !!sampleText && !sampleText.valid;
  const shape = spec.shape ?? { kind: "object" as ShapeKind };
  const setShape = (next: Partial<NonNullable<MappingSpec["shape"]>>) => {
    const merged = { ...shape, ...next };
    const clean = { kind: merged.kind, ...(merged.each?.trim() && (merged.kind === "each" || merged.kind === "values") ? { each: merged.each.trim() } : {}), ...(merged.wrap?.trim() ? { wrap: merged.wrap.trim() } : {}) };
    onChange({ ...spec, shape: clean.kind === "object" && !clean.wrap ? undefined : clean, ...(clean.kind === "values" || clean.kind === "value" ? { passthrough: undefined } : {}) });
  };
  const sample = spec.sampleSource !== undefined ? spec.sampleSource : lastInput;
  const fromRun = spec.sampleSource === undefined && lastInput !== undefined;
  const paths = useMemo(() => leafPaths(sample), [sample]);
  const lists = useMemo(() => arrayPaths(sample), [sample]);
  const targets = useMemo(() => leafPaths(spec.sampleTarget), [spec.sampleTarget]);
  const stats = specStats(spec);
  const rules = spec.rules;
  const setRules = (next: MappingRule[]) => onChange({ ...spec, rules: next });
  const setRule = (id: string, r: MappingRule) => setRules(rules.map((x) => (x.id === id ? r : x)));
  const add = (r: MappingRule) => { setRules([...rules, r]); if (bp !== "desktop") setPane("rules"); };
  const addFromPath = (path: string, target?: string) => add(newRule("direct", { source: path, target: target ?? targetFromSource(path, rules.map((r) => r.target)) }));

  const debouncedSpec = useDebounced(spec, 350);
  const previewKey = useMemo(() => JSON.stringify([debouncedSpec.rules, debouncedSpec.passthrough ?? false, debouncedSpec.shape ?? null, debouncedSpec.sampleTarget ?? null, sample ?? null]), [debouncedSpec, sample]);
  const preview = useQuery({
    queryKey: ["studio", "mapping-preview", previewKey],
    queryFn: () => studioApi.mappingPreview({ ...debouncedSpec, sampleSource: undefined }, (sample ?? null) as Json),
    enabled: sample !== undefined && debouncedSpec.rules.length > 0, retry: 0, placeholderData: keepPreviousData,
  });
  const results = useMemo(() => new Map((preview.data?.rules ?? []).map((r) => [r.id, r as RuleResult])), [preview.data]);
  const infer = useMutation({
    mutationFn: () => studioApi.mappingInfer((sample ?? null) as Json, (spec.sampleTarget ?? null) as Json),
    onSuccess: (res) => { setSuggested(res.rules ?? []); if (!res.rules?.length) toast("No mapping could be suggested from these samples.", "info"); if (bp !== "desktop") setPane("rules"); },
    onError: (e) => toast(errorText(e), "bad"),
  });
  const accept = (r: MappingRule) => {
    const rule = { ...r, id: newRule(r.kind).id };
    const i = rules.findIndex((x) => x.target === r.target);
    setRules(i >= 0 ? rules.map((x, j) => (j === i ? rule : x)) : [...rules, rule]);
    setSuggested((s) => s?.filter((x) => x !== r) ?? null);
  };
  const mapped = new Set(rules.filter((r) => r.enabled !== false).map((r) => r.target));
  const show = (p: typeof pane) => bp === "desktop" || pane === p;

  const input = (
    <section className="ws-map-col ws-map-input" aria-label="Input" hidden={!show("input")}>
      <header className="ws-map-colhead">
        <strong>Input</strong>
        {fromRun && <Badge tone="info">from the last test run</Badge>}
        <span style={{ flex: 1 }} />
        {!readOnly && <button type="button" className="mf-linkbtn" onClick={() => setEditIn((v) => !v)}>{editIn ? "Done" : sample === undefined ? "Paste a sample" : "Edit sample"}</button>}
      </header>
      <div className="ws-map-colbody">
        {editIn && !readOnly && (
          <div className="mf-stack" style={{ gap: 6 }}>
            <JsonEditor value={sample} onChange={(v) => onChange({ ...spec, sampleSource: v as Json | undefined })} onTextState={setSampleText} offerFix minRows={6} maxRows={18} ariaLabel="Sample input" placeholder={'{ "customer": { "name": "John Smith" } }'} />
            <span className="mf-help">A sample of the data arriving at this step. It is stored with the flow on this server and used only for previews.</span>
            {lastInput !== undefined && <div><Button size="sm" variant="ghost" onClick={() => onChange({ ...spec, sampleSource: lastInput })}>Use the input from the last test run</Button></div>}
          </div>
        )}
        {sample === undefined && !editIn && <p className="mf-help">No sample yet. Paste one, or run a test of the flow and the real input of this step appears here.</p>}
        {sample !== undefined && !editIn && <>
          <p className="mf-help" style={{ margin: 0 }}>{readOnly ? "The fields arriving at this step." : bp === "desktop" ? "Drag a field onto a rule or an output field, or click it to add a rule." : "Tap a field to add a rule that copies it."}</p>
          <div className="ws-map-tree"><JsonTree value={sample} draggable={!readOnly} onPick={readOnly ? undefined : (p) => { if (p) addFromPath(p); }} pickLabel="Add a rule for" openDepth={2} /></div>
        </>}
      </div>
    </section>
  );
  const middle = (
    <section className="ws-map-col ws-map-rules" aria-label="Rules" hidden={!show("rules")}>
      <header className="ws-map-colhead">
        <strong>Rules</strong>
        <Badge tone={rules.length ? "accent" : "neutral"}>{rules.length}</Badge>
        {stats.unresolved > 0 && <Badge tone="bad">{stats.unresolved} not understood</Badge>}
        <span style={{ flex: 1 }} />
        <button type="button" className="mf-linkbtn" onClick={() => setHelp((h) => !h)} aria-expanded={help} data-action="phrase-help"><BookOpen size={13} aria-hidden /> What you can write</button>
      </header>
      <div className="ws-map-colbody">
        <div className="ws-shape" data-testid="mapping-shape">
          <label className="ws-shape-row">
            <span className="mf-label">The output is</span>
            <select className="mf-control mf-control-sm" aria-label="Shape of the output" value={shape.kind} disabled={readOnly} onChange={(e) => setShape({ kind: e.target.value as ShapeKind })} data-shape-kind>
              {SHAPES.map((k) => <option key={k} value={k}>{SHAPE_LABEL[k]}</option>)}
            </select>
          </label>
          {(shape.kind === "each" || shape.kind === "values") && (
            <label className="ws-shape-row">
              <span className="mf-label">for each item of</span>
              <input className="mf-control mf-control-sm mf-control-mono" aria-label="List in the input" list="ws-shape-lists" placeholder={lists[0] ? `e.g. ${lists[0]}` : "e.g. order.lines"} value={shape.each ?? ""} readOnly={readOnly} onChange={(e) => setShape({ each: e.target.value })} data-shape-each />
              <datalist id="ws-shape-lists">{lists.map((p) => <option key={p} value={p} />)}</datalist>
            </label>
          )}
          <label className="ws-shape-row">
            <span className="mf-label">Wrap in</span>
            <input className="mf-control mf-control-sm mf-control-mono" aria-label="Wrap the result under a key" placeholder="(optional) e.g. result" value={shape.wrap ?? ""} readOnly={readOnly} onChange={(e) => setShape({ wrap: e.target.value })} data-shape-wrap />
          </label>
          {!readOnly && (shape.kind === "object" || shape.kind === "each") && <Toggle checked={!!spec.passthrough} onChange={(v) => onChange({ ...spec, passthrough: v || undefined })} label={<span style={{ fontSize: 12.5 }}>Keep all input fields{shape.kind === "each" ? " of each item" : ""}</span>} />}
          <span className="mf-help" data-shape-hint>{SHAPE_HINT[shape.kind]}{shape.kind === "each" && !shape.each ? " Choose the list first." : ""}</span>
        </div>
        {help && (
          <div className="ws-phrases" data-testid="phrase-help">
            <div className="mf-hstack"><strong style={{ fontSize: 13 }}>What you can write in your words</strong><span style={{ flex: 1 }} />
              <input className="mf-control mf-control-sm" aria-label="Find a phrase" placeholder="Find, e.g. sort" value={helpFilter} onChange={(e) => setHelpFilter(e.target.value)} data-phrase-filter />
            </div>
            <p className="mf-help" style={{ margin: 0 }}>Replace FIELD with a field of your input (for example data.channel). Anything not on this list is answered with "not understood" and phrasings to try; nothing is guessed. {JOIN_RULE}</p>
            {[...new Set(MAPPING_PHRASES.map((p) => p.group))].map((g) => {
              const items = MAPPING_PHRASES.filter((p) => p.group === g && (!helpFilter.trim() || `${p.phrase} ${p.example} ${p.group}`.toLowerCase().includes(helpFilter.trim().toLowerCase())));
              if (!items.length) return null;
              return (
                <details key={g} open={!!helpFilter.trim() || g === "Text in front or behind"} className="ws-phrases-group" data-phrase-group={g}>
                  <summary>{g} <span className="mf-faint">({items.length})</span></summary>
                  <ul className="ws-phrases-list">
                    {items.map((p) => (
                      <li key={p.example} data-phrase={p.phrase}>
                        <span className="ws-phrases-phrase">{p.phrase}</span>
                        <span className="ws-phrases-ex"><span className="mf-faint">e.g.</span> <code>{p.example}</code></span>
                        <span className="ws-phrases-expr"><span className="mf-faint">becomes</span> <code>{p.expr}</code> <span className="mf-faint">=</span> <code>{showValue(p.value, 60)}</code></span>
                        {!readOnly && <Button size="sm" variant="ghost" onClick={() => add(newRule("instruction", { instruction: p.example }))} data-action="use-phrase">Use</Button>}
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        )}
        {suggested && suggested.length > 0 && (
          <div className="ws-suggestions" data-testid="suggestions">
            <div className="mf-hstack"><Lightbulb size={15} aria-hidden /><strong style={{ fontSize: 13 }}>Suggested mappings</strong><span style={{ flex: 1 }} />
              <Button size="sm" onClick={() => { let next = rules; for (const r of suggested) { const rule = { ...r, id: newRule(r.kind).id }; const i = next.findIndex((x) => x.target === r.target); next = i >= 0 ? next.map((x, j) => (j === i ? rule : x)) : [...next, rule]; } setRules(next); setSuggested(null); }}>Accept all</Button>
              <Button size="sm" variant="ghost" onClick={() => setSuggested(null)}>Dismiss</Button>
            </div>
            <ul className="ws-suggestions-list">
              {suggested.map((r, i) => (
                <li key={i} data-suggestion={r.target}>
                  <span className="ws-suggestions-text"><code>{txt(r.target)}</code><span className="mf-faint"> = {describeRule(r)}</span>{mapped.has(r.target) && <Badge tone="warn">replaces your rule</Badge>}</span>
                  <Button size="sm" icon={Check} onClick={() => accept(r)}>Accept</Button>
                  <Button size="sm" variant="ghost" onClick={() => setSuggested((s) => s?.filter((x) => x !== r) ?? null)}>Reject</Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {rules.length === 0 && <p className="mf-help">{readOnly ? "This mapping has no rules." : "No rules yet. Each rule fills one field of the output. Add one below, or pick a field from the input."}</p>}
        <ul className="ws-rules">
          {rules.map((r, i) => <RuleCard key={r.id} rule={r} index={i} result={results.get(r.id)} sample={sample} paths={paths} examples={examples} readOnly={readOnly} shapeKind={shape.kind} sampleInvalid={sampleInvalid} onChange={(n) => setRule(r.id, n)} onRemove={() => setRules(rules.filter((x) => x.id !== r.id))} />)}
        </ul>
        {!readOnly && (
          <div className="ws-addrule" onDragOver={allowDrop} onDrop={(e) => { const p = dropPath(e); if (p) addFromPath(p); }}>
            <span className="ws-addrule-label"><Plus size={14} aria-hidden /> Add a rule</span>
            <div className="mf-hstack">
              {KINDS.map((k) => <Button key={k} size="sm" variant={k === "instruction" ? "primary" : "default"} icon={k === "instruction" ? Sparkles : undefined} onClick={() => add(newRule(k))} data-add-rule={k}>{KIND_LABEL[k]}</Button>)}
            </div>
          </div>
        )}
      </div>
    </section>
  );
  const output = (
    <section className="ws-map-col ws-map-output" aria-label="Output" hidden={!show("output")}>
      <header className="ws-map-colhead">
        <strong>Output</strong>
        {preview.isFetching && <Spinner label="" />}
        <span style={{ flex: 1 }} />
        {!readOnly && <button type="button" className="mf-linkbtn" onClick={() => setEditOut((v) => !v)}>{editOut ? "Done" : spec.sampleTarget === undefined ? "Describe the expected output" : "Edit expected output"}</button>}
      </header>
      <div className="ws-map-colbody">
        {editOut && !readOnly && (
          <div className="mf-stack" style={{ gap: 6 }}>
            <JsonEditor value={spec.sampleTarget} onChange={(v) => onChange({ ...spec, sampleTarget: v as Json | undefined })} minRows={6} maxRows={18} ariaLabel="Expected output" placeholder={'{ "fullName": "John_Smith" }'} />
            <span className="mf-help">Optional. Paste what the output should look like for the sample input: the fields become targets, and "Suggest mappings" works out the rules.</span>
          </div>
        )}
        {!readOnly && spec.sampleTarget !== undefined && sample !== undefined && (
          <div><Button size="sm" icon={Lightbulb} busy={infer.isPending} onClick={() => infer.mutate()} data-action="suggest">Suggest mappings</Button></div>
        )}
        {targets.length > 0 && (
          <div className="mf-stack" style={{ gap: 6 }}>
            <span className="mf-label">Output fields</span>
            <ul className="ws-targets">
              {targets.map((t) => {
                const d = preview.data?.diff?.find((x) => x.path === t);
                return (
                  <li key={t} className={cx("ws-target", mapped.has(t) && "ws-target-on", d && "ws-target-diff")} data-target={t} onDragOver={allowDrop} onDrop={(e) => { const p = dropPath(e); if (p && !readOnly) addFromPath(p, t); }}>
                    <code>{t}</code>
                    {mapped.has(t) ? (d ? <Badge tone="warn">differs from expected</Badge> : <Badge tone="ok">mapped</Badge>)
                      : readOnly ? <Badge>not mapped</Badge> : <button type="button" className="mf-linkbtn" onClick={() => add(newRule("direct", { target: t }))}>Add rule</button>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {preview.isError && <Callout tone={isUnavailable(preview.error) ? "warn" : "bad"} title="No live preview">{errorText(preview.error)}</Callout>}
        {sample === undefined && <p className="mf-help">Add a sample input to see the output here as you build the rules.</p>}
        {sampleInvalid && sample !== undefined && (
          <Callout tone="warn" title="The sample you are typing is not valid JSON yet">
            <span data-testid="preview-on-last-sample">The result below uses the last valid sample{sampleText?.line ? `; fix line ${sampleText.line}` : ""} and it updates as soon as the sample is valid again.</span>
          </Callout>
        )}
        {preview.data && <div data-testid="mapping-output"><DataView label={sampleInvalid ? "Result on the last valid sample" : fromRun ? "Result on the input of the last test run" : "Result on the sample"} value={preview.data.output} maxHeight={420} /></div>}
        {!!preview.data?.diff?.length && (
          <Callout tone="warn" title="Differs from the expected output">
            <ul className="ws-difflist">{preview.data.diff.slice(0, 12).map((d) => <li key={d.path}><code>{txt(d.path)}</code>: got {showValue(d.got, 60)}, expected {showValue(d.want, 60)}</li>)}</ul>
          </Callout>
        )}
      </div>
    </section>
  );
  return (
    <div className="ws-mapper" data-testid="mapper">
      {bp !== "desktop" && <Tabs tabs={[{ id: "input", label: "Input" }, { id: "rules", label: "Rules", count: rules.length }, { id: "output", label: "Output" }]} value={pane} onChange={setPane} className="ws-map-tabs" />}
      <div className="ws-map-grid">{input}{middle}{output}</div>
    </div>
  );
}

export function MapperDialog({ title, spec, onChange, onClose, readOnly, lastInput, examples }: { title: string; spec: MappingSpec; onChange: (s: MappingSpec) => void; onClose: () => void; readOnly?: boolean; lastInput?: Json; examples: string[] }) {
  return (
    <Modal full title={title} subtitle={readOnly ? "How the output of this step is built." : "Each rule fills one field of the output. Changes are kept with the flow as you make them."} onClose={onClose} bodyClass="ws-mapper-body"
      footer={<Button variant="primary" onClick={onClose} data-action="close-mapper">Done</Button>}>
      <Mapper spec={spec} onChange={onChange} readOnly={readOnly} lastInput={lastInput} examples={examples} />
    </Modal>
  );
}

/** Read-only table of the rules of one mapping (Mappings tab, migrated services). */
export function RulesTable({ spec }: { spec: MappingSpec }) {
  if (!spec.rules.length) return <p className="mf-help">No rules yet.</p>;
  return (
    <ul className="ws-ruletable">
      {spec.rules.map((r) => {
        const p = ruleProblem(r);
        // a rule taken over from existing code that has no expression of its own yet: show the code it came from
        const original = r.kind === "expr" && !r.expr && /^Original:\s*\S/.test(r.comment ?? "") ? (r.comment ?? "").replace(/^Original:\s*/, "") : "";
        return (
          <li key={r.id} className={cx(r.enabled === false && !original && "ws-rule-off")}>
            <code className="ws-ruletable-target">{txt(r.target) || "(no field)"}</code>
            {original
              ? <span className="ws-ruletable-how"><Badge>Original code</Badge> <code className="mf-mono-sm">{txt(original)}</code></span>
              : <span className="ws-ruletable-how"><Badge tone={r.kind === "instruction" ? "info" : "neutral"}>{KIND_LABEL[r.kind] ?? txt(r.kind)}</Badge> <span>{r.kind === "instruction" && r.instruction ? `"${txt(r.instruction)}"` : describeRule(r)}</span>
                {r.kind === "instruction" && r.compiled?.explanation && <span className="mf-faint"> (understood as: {txt(r.compiled.explanation)})</span>}</span>}
            {p && <Badge tone="bad">{r.kind === "instruction" ? "not understood" : "incomplete"}</Badge>}
            {r.comment && !original && <span className="ws-ruletable-note">{txt(r.comment)}</span>}
          </li>
        );
      })}
    </ul>
  );
}
