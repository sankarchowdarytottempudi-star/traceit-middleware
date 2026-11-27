// "Test data": a person gives examples for each operation of the migrated API (the request and the
// answer they expect) and, if they like, for one TODO step (what goes in and what should come out).
// The migration tool keeps them, works out the fields from them, turns each example into a test and
// suggests answers for TODO steps. A suggestion is used only when a person clicks Accept: it is then
// saved like any answer to an open decision. Nothing here deploys or switches anything on.
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, Plus, Trash2, Upload } from "lucide-react";
import {
  api, examplesWorkbook, uploadExamplesWorkbook,
  type ApiError, type ExampleInput, type ExampleOperation, type ExampleRequest, type ExampleRowError, type ExampleShape, type ExamplesResult,
  type ExamplesView, type Migration, type OperationFields, type Suggestion, type TestExample, type TodoStep,
} from "../api.ts";
import { txt } from "../lib/text.ts";
import { dateTime } from "../lib/migrate.ts";
import { canCheck } from "./CheckCorrect.tsx";
import { LANGUAGES } from "./Decisions.tsx";
import { Bar, Btn, Field, Loading, Notice, Panel, Pill, errText } from "./ui.tsx";

/** Largest list of examples sent at once (bytes), as the server allows. */
export const EXAMPLES_FILE_MAX = 2 * 1024 * 1024;

// ---- plain words

const TYPE_WORDS: Record<string, string> = {
  string: "text", integer: "whole number", number: "number", boolean: "yes/no", date: "date", datetime: "date and time",
  array: "list", object: "group", null: "empty", any: "anything",
};

/** A field's type in plain words: "whole number", "list of text", "group", with ", can be empty" when it may be missing a value. */
export function typeWords(s: ExampleShape | null | undefined): string {
  if (!s) return "anything";
  let w = TYPE_WORDS[s.t] ?? txt(s.t);
  if (s.t === "array" && s.items && s.items.t !== "any") w = `list of ${s.items.t === "object" ? "groups" : typeWords({ ...s.items, nullable: false })}`;
  return s.nullable && s.t !== "null" ? `${w}, can be empty` : w;
}

export interface FieldRow { name: string; type: string; always: boolean }

/** Every field of a value, nested ones as "customer.name" and list items as "lines[].sku". */
export function fieldRows(s: ExampleShape | null | undefined, prefix = "", depth = 0): FieldRow[] {
  if (!s || depth > 8) return [];
  const rows: FieldRow[] = [];
  if (s.t === "object" && s.props) {
    const always = new Set(s.always ?? []);
    for (const [k, v] of Object.entries(s.props)) {
      const name = prefix ? `${prefix}.${k}` : k;
      rows.push({ name, type: typeWords(v), always: always.has(k) });
      rows.push(...fieldRows(v, name, depth + 1));
    }
  } else if (s.t === "array" && s.items && (s.items.t === "object" || s.items.t === "array")) {
    rows.push(...fieldRows(s.items, `${prefix}[]`, depth + 1));
  }
  return rows;
}

/** Fields named one by one (path values, query, headers): each is always given when it appears in every example. */
const namedRows = (m: Record<string, ExampleShape> | undefined): FieldRow[] =>
  Object.entries(m ?? {}).map(([name, v]) => ({ name, type: typeWords(v), always: true }));

/** "request header Authorization removed (secret)" -> "We removed the Authorization header; secrets are never kept." */
export function removedWords(note: string): string {
  const t = txt(note).trim();
  const h = /header\s+["']?([^\s"']+)["']?\s+removed/i.exec(t);
  if (h) return `We removed the ${h[1]} header; secrets are never kept.`;
  const f = /^(?:request|response)?\s*(?:body\s+)?(?:field\s+)?["']?([^\s"']+)["']?\s+removed/i.exec(t);
  if (f) return `We removed ${f[1]}; secrets are never kept.`;
  return `${t.replace(/\s*\(secret\)\s*$/i, "").replace(/\.$/, "")}. Secrets are never kept.`;
}

const RULE_WORDS: Record<string, string> = {
  copy: "copied from", rename: "taken from", constant: "always the same value", concat: "joined from", upper: "in capitals, from",
  lower: "in small letters, from", trim: "without spaces at the ends, from", number: "as a number, from", text: "as text, from", date: "as a date, from",
};
const ruleWords = (r: { field: string; rule: string; from?: string[]; plain?: string }) =>
  txt(r.plain) || `${r.field}: ${RULE_WORDS[r.rule] ?? r.rule}${r.from?.length ? ` ${r.from.join(", ")}` : ""}`;

// ---- what a person types

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

/** The request a person starts from for one operation. */
export function requestTemplate(op: ExampleOperation | undefined): string {
  const method = (txt(op?.method) || txt(op?.operation).split(" ")[0] || "GET").toUpperCase();
  const pathValues = Object.fromEntries((op?.pathParams ?? []).map((p) => [p, ""]));
  const req = { method, path: txt(op?.path) || txt(op?.operation).split(" ").slice(1).join(" ") || "/", pathValues, query: {}, headers: {}, body: METHODS_WITH_BODY.has(method) ? {} : null };
  return JSON.stringify(req, null, 2);
}
export const RESPONSE_TEMPLATE = JSON.stringify({ status: 200, body: {} }, null, 2);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parse(text: string, what: string): { value: unknown } | { problem: string } {
  if (!text.trim()) return { problem: `Write the ${what}.` };
  try { return { value: JSON.parse(text) }; } catch (e) {
    const where = /position (\d+)/.exec(String((e as Error)?.message))?.[1];
    return { problem: `The ${what} is not written correctly${where ? ` (look near character ${where})` : ""}. Check the quotes, commas and brackets.` };
  }
}

const strMap = (v: unknown): Record<string, string> | null => {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) return null;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" ? x : JSON.stringify(x)]));
};

/** The request and the expected answer a person typed, checked, as the tool takes them. */
export function operationExample(op: ExampleOperation | undefined, requestText: string, responseText: string, name: string, note: string):
  { example: ExampleInput } | { problem: string; on: "operation" | "request" | "response" } {
  if (!op) return { problem: "Choose the operation this example is for.", on: "operation" };
  const rq = parse(requestText, "request");
  if ("problem" in rq) return { problem: rq.problem, on: "request" };
  if (!isObj(rq.value)) return { problem: "The request must be a group of fields in { }, with method, path and the rest.", on: "request" };
  const r = rq.value;
  const method = (typeof r.method === "string" ? r.method : txt(op.method)).trim().toUpperCase();
  if (!/^[A-Z]{3,10}$/.test(method)) return { problem: "Say the request method, for example GET or POST.", on: "request" };
  const path = typeof r.path === "string" ? r.path.trim() : "";
  if (!path.startsWith("/")) return { problem: "Say the path of the request; it starts with /, for example /orders/7.", on: "request" };
  const pathParams = strMap(r.pathValues ?? r.pathParams), query = strMap(r.query), headers = strMap(r.headers);
  if (!pathParams || !query || !headers) return { problem: "Path values, query and headers must each be a group of names and values in { }.", on: "request" };
  const missing = (op.pathParams ?? []).filter((p) => !txt(pathParams[p]).trim());
  if (missing.length) return { problem: `Give a value for ${missing.join(", ")} in pathValues.`, on: "request" };
  const rs = parse(responseText, "answer you expect");
  if ("problem" in rs) return { problem: rs.problem, on: "response" };
  if (!isObj(rs.value)) return { problem: "The answer must be a group of fields in { }, with status and body.", on: "response" };
  const status = rs.value.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) return { problem: "Say the status of the answer as a number between 100 and 599, for example 200.", on: "response" };
  const request: ExampleRequest = { method, path, pathParams, query, headers, body: r.body ?? null };
  return { example: { kind: "operation", operation: op.operation, request, response: { status, body: rs.value.body ?? null },
    ...(name.trim() ? { name: name.trim().slice(0, 200) } : {}), ...(note.trim() ? { note: note.trim().slice(0, 2000) } : {}) } };
}

/** A step example: what goes into the step and what should come out. */
export function stepExample(step: TodoStep | undefined, inputText: string, outputText: string, name: string, note: string):
  { example: ExampleInput } | { problem: string; on: "step" | "input" | "output" } {
  if (!step) return { problem: "Choose the TODO step this example is for.", on: "step" };
  const i = parse(inputText, "input");
  if ("problem" in i) return { problem: i.problem, on: "input" };
  const o = parse(outputText, "output");
  if ("problem" in o) return { problem: o.problem, on: "output" };
  return { example: { kind: "step", step: step.id, input: i.value, output: o.value,
    ...(name.trim() ? { name: name.trim().slice(0, 200) } : {}), ...(note.trim() ? { note: note.trim().slice(0, 2000) } : {}) } };
}

/** A file of examples: a list, or { "examples": [ ... ] }. */
export function examplesFromFile(text: string): { examples: ExampleInput[] } | { problem: string } {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { problem: "The file is not written correctly. It must hold a list of examples in [ ], or { \"examples\": [ ... ] }." }; }
  const list = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.examples) ? v.examples : null;
  if (!list) return { problem: "The file must hold a list of examples in [ ], or { \"examples\": [ ... ] }." };
  if (!list.length) return { problem: "The file has no examples." };
  if (list.length > 500) return { problem: "Send at most 500 examples at a time." };
  const out: ExampleInput[] = [];
  for (const [n, e] of list.entries()) {
    if (!isObj(e)) return { problem: `Example ${n + 1} is not a group of fields in { }.` };
    const kind = e.kind === "step" || (e.kind === undefined && e.step !== undefined) ? "step" : "operation";
    if (kind === "operation" && (typeof e.operation !== "string" || !isObj(e.request) || !isObj(e.response))) return { problem: `Example ${n + 1} needs operation, request and response.` };
    if (kind === "step" && (typeof e.step !== "string" || e.input === undefined || e.output === undefined)) return { problem: `Example ${n + 1} needs step, input and output.` };
    const request = isObj(e.request) && e.request.pathValues !== undefined && e.request.pathParams === undefined
      ? (({ pathValues, ...rest }) => ({ ...rest, pathParams: pathValues }))(e.request as Record<string, unknown>) : e.request;
    out.push({ ...(e as unknown as ExampleInput), kind, ...(request !== undefined ? { request: request as ExampleRequest } : {}) });
  }
  return { examples: out };
}

// ---- pieces

function RowErrors({ list }: { list: ExampleRowError[] }) {
  return (
    <ul className="mf-mg-small mf-mg-wrap" data-testid="td-row-errors" style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.5 }}>
      {list.map((e, i) => (
        <li key={i}>{txt(e.sheet) ? <>Sheet <strong>{txt(e.sheet)}</strong>{e.row !== undefined && e.row !== null && e.row !== "" ? <>, row <strong>{String(e.row)}</strong></> : null}</> : txt(e.id) ? <>Example <span className="mf-mono">{txt(e.id)}</span></> : "An example"}: {txt(e.problem)}</li>
      ))}
    </ul>
  );
}

function Result({ r }: { r: ExamplesResult }) {
  return (
    <Notice tone="ok">
      <span className="mf-mg-stack" style={{ gap: 6 }} data-testid="td-done">
        <span>{txt(r.message) || (r.rerun ? "Your test data is kept." : "Nothing changed.")}</span>
        {r.rerun && <span data-testid="td-rerun">The documents and the project are being generated again with your test data. Nothing is deployed or switched on.</span>}
        {(r.changes ?? []).length > 0 && (
          <ul className="mf-mg-small mf-mg-wrap" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>
            {(r.changes ?? []).map((c, i) => <li key={i}><strong>{txt(c.action) || "changed"}</strong>{txt(c.summary) ? `: ${txt(c.summary)}` : ""}</li>)}
          </ul>
        )}
        {(r.removed ?? []).map((n, i) => <span key={i} className="mf-mg-small" data-testid="td-removed-secret">{removedWords(n)}</span>)}
      </span>
    </Notice>
  );
}

function FieldTable({ title, rows }: { title: string; rows: FieldRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="mf-mg-stack" style={{ gap: 4 }}>
      <span className="mf-mg-small" style={{ fontWeight: 600 }}>{title}</span>
      <ul className="mf-mg-small mf-mg-wrap" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
        {rows.map((r) => <li key={r.name}><span className="mf-mono">{r.name}</span>: {r.type}{r.always ? "" : " (not in every example)"}</li>)}
      </ul>
    </div>
  );
}

function Fields({ op, f }: { op: string; f: OperationFields }) {
  const rq = f.request ?? {};
  const responses = Object.entries(f.responses ?? {});
  const parts: [string, FieldRow[]][] = [
    ["Path values", namedRows(rq.pathParams)], ["Query", namedRows(rq.query)], ["Headers", namedRows(rq.headers)],
    ["Request body", rq.body ? (rq.body.t === "object" || rq.body.t === "array" ? fieldRows(rq.body) : [{ name: "(the whole body)", type: typeWords(rq.body), always: true }]) : []],
    ...responses.map(([status, s]): [string, FieldRow[]] => [`Answer with status ${status}`, s.t === "object" || s.t === "array" ? (fieldRows(s).length ? fieldRows(s) : [{ name: "(the whole body)", type: typeWords(s), always: true }]) : [{ name: "(the whole body)", type: typeWords(s), always: true }]]),
  ];
  const any = parts.some(([, r]) => r.length);
  return (
    <div className="mf-mg-card" data-testid="td-fields" data-operation={op}>
      <div className="mf-mg-row" style={{ gap: 8 }}>
        <span className="mf-mono mf-mg-grow mf-mg-wrap" style={{ fontWeight: 700 }}>{op}</span>
        <Pill>{Number(f.examples ?? 0)} example{Number(f.examples ?? 0) === 1 ? "" : "s"}</Pill>
      </div>
      {any ? parts.map(([t, r]) => <FieldTable key={t} title={t} rows={r} />) : <span className="mf-mg-small mf-mg-muted">No fields yet.</span>}
    </div>
  );
}

function SuggestionCard({ s, busy, accepting, accepted, problem, onAccept }: { s: Suggestion; busy: boolean; accepting: boolean; accepted: boolean; problem?: string; onAccept: () => void }) {
  const nothing = s.status !== "suggested" || !s.answer;
  const lang = s.answer ? (LANGUAGES.find(([k]) => k === s.answer!.language)?.[1] || txt(s.answer.language)) : "";
  return (
    <div className="mf-mg-card" data-testid="td-suggestion" data-step={s.id} data-status={nothing ? "nothing" : "suggested"}>
      <div className="mf-mg-row" style={{ gap: 8, alignItems: "flex-start" }}>
        <span className="mf-mg-grow mf-mg-wrap" style={{ fontWeight: 700, fontSize: 14, flexBasis: 200 }}>{txt(s.where) || txt(s.construct) || s.id}</span>
        {nothing ? <Pill tone="muted">No suggestion</Pill> : <Pill tone="accent">Suggested from your test data</Pill>}
        {accepted && <Pill tone="ok">Accepted</Pill>}
      </div>
      {txt(s.summary) && <span className="mf-mg-small mf-mg-wrap"><strong>What it does:</strong> {txt(s.summary)}</span>}
      {nothing ? (
        <span className="mf-mg-small mf-mg-wrap" data-testid="td-suggestion-why">
          We could not work out this step from your test data.{txt(s.why) ? ` ${txt(s.why)}` : ""}
        </span>
      ) : (
        <>
          {(s.rules ?? []).length > 0 && (
            <ul className="mf-mg-small mf-mg-wrap" data-testid="td-suggestion-rules" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
              {(s.rules ?? []).map((r, i) => <li key={i}>{ruleWords(r)}</li>)}
            </ul>
          )}
          {(s.unresolved ?? []).length > 0 && (
            <span className="mf-mg-small mf-mg-wrap" data-testid="td-suggestion-unresolved">
              <strong>Still to do by hand:</strong> {(s.unresolved ?? []).map((u) => `${u.field}${txt(u.why) ? ` (${txt(u.why)})` : ""}`).join("; ")}
            </span>
          )}
          <details>
            <summary className="mf-mg-small" style={{ cursor: "pointer" }}>The code it would use ({lang})</summary>
            <pre className="mf-mg-pre mf-mono" data-testid="td-suggestion-code" style={{ marginTop: 6 }}>{s.answer!.text}</pre>
          </details>
          <span className="mf-mg-hint mf-mg-wrap">{txt(s.note) || "Suggested from your test data."} Nothing is used until you accept it.</span>
          <div className="mf-mg-actions">
            <Btn small kind="primary" icon={<Check size={14} aria-hidden="true" />} disabled={busy || accepted} busy={accepting} onClick={onAccept} data-testid="td-accept">Accept this suggestion</Btn>
          </div>
        </>
      )}
      {problem && <span className="mf-mg-err mf-mg-wrap" role="alert" data-testid="td-suggestion-error">{problem}</span>}
    </div>
  );
}

function ExampleLine({ e, busy, removing, onRemove }: { e: TestExample; busy: boolean; removing: boolean; onRemove: () => void }) {
  const status = e.kind === "operation" ? e.response?.status : undefined;
  return (
    <div className="mf-mg-item" data-testid="td-example" data-example={e.id}>
      <div className="mf-mg-item-head" style={{ cursor: "default", flexWrap: "wrap", gap: 8 }}>
        <span className="mf-mg-item-title mf-mg-small mf-mg-wrap">
          <strong>{txt(e.name) || e.id}</strong>
          {status !== undefined ? <span className="mf-mg-muted"> · answer {status}</span> : null}
          {e.kind === "operation" && e.request?.path ? <span className="mf-mono mf-mg-muted"> · {txt(e.request.method)} {txt(e.request.path)}</span> : null}
          {txt(e.by) || e.at ? <span className="mf-mg-muted"> · {[txt(e.by), e.at ? dateTime(e.at) : ""].filter(Boolean).join(", ")}</span> : null}
        </span>
        <Btn small kind="danger" icon={<Trash2 size={13} aria-hidden="true" />} disabled={busy} busy={removing} onClick={onRemove} data-testid="td-remove" aria-label={`Remove the example ${txt(e.name) || e.id}`}>Remove</Btn>
      </div>
      {txt(e.note) && <span className="mf-mg-small mf-mg-muted mf-mg-wrap" style={{ padding: "0 12px 8px" }}>{txt(e.note)}</span>}
      {(e.removed ?? []).map((n, i) => <span key={i} className="mf-mg-small mf-mg-wrap" style={{ padding: "0 12px 8px" }} data-testid="td-example-removed">{removedWords(n)}</span>)}
    </div>
  );
}

// ---- the panel

type Mode = "operation" | "step";

export function TestData({ m }: { m: Migration }) {
  const qc = useQueryClient();
  const show = canCheck(m);
  const q = useQuery({ queryKey: ["migration-examples", m.id], queryFn: () => api.examples(m.id), retry: false, enabled: show });
  const sq = useQuery({ queryKey: ["migration-example-suggestions", m.id], queryFn: () => api.exampleSuggestions(m.id), retry: false, enabled: show && q.isSuccess });
  const [mode, setMode] = useState<Mode>("operation");
  const [opKey, setOpKey] = useState("");
  const [stepId, setStepId] = useState("");
  const [request, setRequest] = useState("");
  const [response, setResponse] = useState(RESPONSE_TEMPLATE);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<{ text: string; on: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState<{ text: string; rows: ExampleRowError[] } | null>(null);
  const [done, setDone] = useState<ExamplesResult | null>(null);
  const [getting, setGetting] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [book, setBook] = useState<File | null>(null);
  const bookInput = useRef<HTMLInputElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [acceptErr, setAcceptErr] = useState<Record<string, string>>({});
  const [acceptDone, setAcceptDone] = useState("");

  if (!show) return null;
  if (q.isError && (q.error as ApiError).status === 404 && !txt((q.error as ApiError).body?.error)) return null;

  const view: ExamplesView | undefined = q.data;
  const ops = view?.operations ?? [];
  const steps = view?.todoSteps ?? [];
  const examples = view?.examples ?? [];
  const busy = !!m.busy || !!m.queued || saving !== null || pct !== null;
  const op = ops.find((o) => o.operation === opKey);
  const step = steps.find((s) => s.id === stepId);

  const refresh = () => {
    for (const k of ["migration-examples", "migration-example-suggestions", "migration", "migration-docs", "migration-decisions"]) qc.invalidateQueries({ queryKey: [k, m.id] });
    qc.invalidateQueries({ queryKey: ["migrations"] });
  };
  const fail = (e: ApiError) => {
    const rows = Array.isArray(e.body?.errors) ? (e.body!.errors as ExampleRowError[]) : [];
    const text = e.status === 422 && rows.length
      ? `${rows.length === 1 ? "One example was" : `${rows.length} examples were`} not accepted. Nothing was saved: correct ${rows.length === 1 ? "it" : "them"} and send again.`
      : e.status === 409 ? txt(e.body?.error) || "A step of this migration is running. Send the test data when it has finished." : errText(e);
    setErr({ text, rows });
  };
  const send = (list: ExampleInput[], what: string, after?: () => void) => {
    setErr(null); setDone(null); setSaving(what);
    return api.saveExamples(m.id, list)
      .then((r) => { setDone(r); after?.(); refresh(); })
      .catch(fail)
      .finally(() => setSaving(null));
  };

  const chooseOp = (k: string) => { setOpKey(k); setRequest(requestTemplate(ops.find((o) => o.operation === k))); setProblem(null); };
  const add = () => {
    setProblem(null);
    const r = mode === "operation" ? operationExample(op, request, response, name, note) : stepExample(step, input, output, name, note);
    if ("problem" in r) { setProblem({ text: r.problem, on: r.on }); return; }
    send([r.example], "add", () => { setName(""); setNote(""); if (mode === "operation") { setRequest(requestTemplate(op)); setResponse(RESPONSE_TEMPLATE); } else { setInput(""); setOutput(""); } });
  };
  const fromFile = (f: File | undefined) => {
    if (!f) return;
    setErr(null); setDone(null);
    if (f.size > EXAMPLES_FILE_MAX) { setErr({ text: "The file is larger than 2 MB. Send fewer examples at a time, or use the workbook.", rows: [] }); return; }
    f.text().then((t) => {
      const r = examplesFromFile(t);
      if ("problem" in r) { setErr({ text: r.problem, rows: [] }); return; }
      return send(r.examples, "file");
    }).finally(() => { if (jsonInput.current) jsonInput.current.value = ""; });
  };
  const download = () => {
    setErr(null); setGetting(true);
    examplesWorkbook(m.id)
      .then(({ blob, filename }) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      })
      .catch((e: ApiError) => setErr({ text: errText(e), rows: [] }))
      .finally(() => setGetting(false));
  };
  const uploadBook = () => {
    if (!book) return;
    setErr(null); setDone(null); setPct(0);
    uploadExamplesWorkbook(m.id, book, (f) => setPct(f)).promise
      .then((r) => { setBook(null); if (bookInput.current) bookInput.current.value = ""; setDone(r); refresh(); })
      .catch(fail)
      .finally(() => setPct(null));
  };
  const accept = (s: Suggestion) => {
    if (!s.answer) return;
    setAccepting(s.id); setAcceptDone("");
    setAcceptErr((p) => { const n = { ...p }; delete n[s.id]; return n; });
    api.answerDecisions(m.id, [{ id: s.id, answer: s.answer, scope: "api", note: (txt(s.note) || "Suggested from your test data").slice(0, 2000) }])
      .then(() => { setAccepted((a) => new Set(a).add(s.id)); setAcceptDone("Suggestion accepted. The migration is being rebuilt with it."); refresh(); })
      .catch((e: ApiError) => {
        const row = Array.isArray(e.body?.errors) ? (e.body!.errors as { id?: string; problem?: string }[]).find((x) => !x.id || x.id === s.id) : undefined;
        setAcceptErr((p) => ({ ...p, [s.id]: txt(row?.problem) || (e.status === 409 ? txt(e.body?.error) || "A step of this migration is running. Accept it when it has finished." : errText(e)) }));
      })
      .finally(() => setAccepting(null));
  };

  const fieldOps = Object.entries(view?.contract ?? {});
  const suggestions = sq.data?.suggestions ?? [];
  const nExamples = Number(view?.counts?.examples ?? examples.length);
  const opExamples = (k: string) => examples.filter((e) => e.kind === "operation" && e.operation === k);
  const stepExamples = examples.filter((e) => e.kind === "step");

  return (
    <Panel title="Test data" actions={q.isSuccess ? <Pill tone={nExamples ? "accent" : undefined}>{nExamples} example{nExamples === 1 ? "" : "s"}</Pill> : undefined}>
      <div className="mf-mg-stack" style={{ gap: 14 }} data-testid="test-data">
        <p className="mf-mg-sub mf-mg-wrap" style={{ fontSize: 13.5, margin: 0 }}>
          Give us examples of this service: the request someone sends and the answer they should get. We learn the fields from them, turn each example into a test,
          and suggest answers for the steps still on the TODO list. Suggestions are only used when you accept them. Secrets such as passwords and tokens are never kept.
        </p>
        {q.isLoading ? <Loading rows={2} h={80} /> : q.isError ? (
          <Notice tone={(q.error as ApiError).status === 409 ? "warn" : "bad"}>
            <span className="mf-mg-row" style={{ gap: 8 }}><span data-testid="td-load-error" className="mf-mg-grow mf-mg-wrap">{errText(q.error)}</span><Btn small onClick={() => q.refetch()}>Try again</Btn></span>
          </Notice>
        ) : (
          <>
            {m.busy || m.queued ? <span className="mf-mg-hint mf-mg-wrap" data-testid="td-busy">A step of this migration is running. Test data can be sent when it has finished.</span> : null}

            <div className="mf-mg-sec" data-testid="td-operations">
              <h3>Your examples</h3>
              {ops.length === 0 ? <span className="mf-mg-small mf-mg-muted">This API has no operations yet.</span> : (
                <div className="mf-mg-stack" style={{ gap: 10 }}>
                  {ops.map((o) => {
                    const list = opExamples(o.operation);
                    return (
                      <div key={o.operation} className="mf-mg-card" data-testid="td-operation" data-operation={o.operation}>
                        <div className="mf-mg-row" style={{ gap: 8 }}>
                          <span className="mf-mono mf-mg-grow mf-mg-wrap" style={{ fontWeight: 700 }}>{o.operation}</span>
                          <Pill tone={list.length ? "ok" : "muted"}>{list.length ? `${list.length} example${list.length === 1 ? "" : "s"}` : "No examples yet"}</Pill>
                          <Btn small icon={<Plus size={13} aria-hidden="true" />} disabled={busy} onClick={() => { setMode("operation"); chooseOp(o.operation); }} data-testid="td-add-for">Add an example</Btn>
                        </div>
                        {list.length > 0 && <div className="mf-mg-list">{list.map((e) => <ExampleLine key={e.id} e={e} busy={busy} removing={saving === `remove:${e.id}`} onRemove={() => send([{ kind: "operation", id: e.id, delete: true }], `remove:${e.id}`)} />)}</div>}
                      </div>
                    );
                  })}
                  {stepExamples.length > 0 && (
                    <div className="mf-mg-card" data-testid="td-step-examples">
                      <span style={{ fontWeight: 700 }}>Examples for TODO steps</span>
                      <div className="mf-mg-list">{stepExamples.map((e) => <ExampleLine key={e.id} e={{ ...e, name: txt(e.name) || `${txt(steps.find((s) => s.id === e.step)?.where) || txt(e.step)}` }} busy={busy} removing={saving === `remove:${e.id}`} onRemove={() => send([{ kind: "step", id: e.id, delete: true }], `remove:${e.id}`)} />)}</div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="mf-mg-sec" data-testid="td-add">
              <h3>Add an example</h3>
              <div className="mf-mg-choices" role="radiogroup" aria-label="What is the example for?">
                <button type="button" role="radio" aria-checked={mode === "operation"} className="mf-btn mf-mg-choice" onClick={() => { setMode("operation"); setProblem(null); }}>For an operation (request and answer)</button>
                {steps.length > 0 && <button type="button" role="radio" aria-checked={mode === "step"} className="mf-btn mf-mg-choice" onClick={() => { setMode("step"); setProblem(null); }} data-testid="td-mode-step">Example for one TODO step (optional)</button>}
              </div>
              {mode === "operation" ? (
                <>
                  <Field label="Operation" error={problem?.on === "operation" ? problem.text : undefined}>
                    <select className="mf-mg-input" value={opKey} onChange={(e) => chooseOp(e.target.value)} data-testid="td-operation-pick">
                      <option value="">Choose an operation</option>
                      {ops.map((o) => <option key={o.operation} value={o.operation}>{o.operation}</option>)}
                    </select>
                  </Field>
                  <Field label="The request" hint="method, path, pathValues (the values in the path), query, headers and body, written as JSON." error={problem?.on === "request" ? problem.text : undefined}>
                    <textarea className="mf-mg-input mf-mono" rows={10} value={request} onChange={(e) => { setRequest(e.target.value); setProblem(null); }} spellCheck={false} data-testid="td-request" aria-label="The request" />
                  </Field>
                  <Field label="The answer you expect" hint="status (for example 200) and body, written as JSON." error={problem?.on === "response" ? problem.text : undefined}>
                    <textarea className="mf-mg-input mf-mono" rows={7} value={response} onChange={(e) => { setResponse(e.target.value); setProblem(null); }} spellCheck={false} data-testid="td-response" aria-label="The answer you expect" />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="TODO step" error={problem?.on === "step" ? problem.text : undefined}>
                    <select className="mf-mg-input" value={stepId} onChange={(e) => { setStepId(e.target.value); setProblem(null); }} data-testid="td-step-pick">
                      <option value="">Choose a TODO step</option>
                      {steps.map((s) => <option key={s.id} value={s.id}>{[txt(s.where), txt(s.summary)].filter(Boolean).join(" · ") || s.id}</option>)}
                    </select>
                  </Field>
                  <Field label="What goes into the step" hint="The document the step receives, written as JSON." error={problem?.on === "input" ? problem.text : undefined}>
                    <textarea className="mf-mg-input mf-mono" rows={7} value={input} onChange={(e) => { setInput(e.target.value); setProblem(null); }} spellCheck={false} data-testid="td-input" aria-label="What goes into the step" />
                  </Field>
                  <Field label="What should come out" hint="The document the step should produce, written as JSON." error={problem?.on === "output" ? problem.text : undefined}>
                    <textarea className="mf-mg-input mf-mono" rows={7} value={output} onChange={(e) => { setOutput(e.target.value); setProblem(null); }} spellCheck={false} data-testid="td-output" aria-label="What should come out" />
                  </Field>
                </>
              )}
              <div className="mf-mg-grid-2">
                <Field label="Name (optional)"><input className="mf-mg-input" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} data-testid="td-name" /></Field>
                <Field label="Note (optional)"><input className="mf-mg-input" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} data-testid="td-note" /></Field>
              </div>
              {problem && <span className="mf-mg-err mf-mg-wrap" role="alert" data-testid="td-problem">{problem.text}</span>}
              <div className="mf-mg-actions">
                <Btn kind="primary" icon={<Plus size={15} aria-hidden="true" />} disabled={busy} busy={saving === "add"} onClick={add} data-testid="td-save">Save the example</Btn>
                <input ref={jsonInput} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={(e) => fromFile(e.target.files?.[0])} data-testid="td-json-file" aria-label="File of examples (.json)" />
                <Btn icon={<Upload size={15} aria-hidden="true" />} disabled={busy} busy={saving === "file"} onClick={() => jsonInput.current?.click()} data-testid="td-json-upload">Upload a file of examples (.json)</Btn>
              </div>
            </div>

            <div className="mf-mg-sec" data-testid="td-workbook">
              <h3>Or use the workbook</h3>
              <span className="mf-mg-small mf-mg-wrap">Download the workbook, fill one row per example (the request and the answer you expect), and upload it again.</span>
              <div className="mf-mg-actions">
                <Btn icon={<Download size={15} aria-hidden="true" />} disabled={!!m.busy} busy={getting} onClick={download} data-testid="td-download">Download the workbook (.xlsx)</Btn>
              </div>
              <div className="mf-mg-row" style={{ gap: 8 }}>
                <input ref={bookInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-testid="td-book-file" aria-label="Filled workbook (.xlsx)"
                  onChange={(e) => { setBook(e.target.files?.[0] ?? null); setErr(null); setDone(null); }} style={{ maxWidth: "100%", minWidth: 0 }} />
                <Btn small kind="primary" icon={<Upload size={14} aria-hidden="true" />} disabled={!book || busy} busy={pct !== null} onClick={uploadBook} data-testid="td-book-upload">Upload the filled workbook</Btn>
              </div>
              {pct !== null && <Bar pct={Math.round(pct * 100)} label="Upload progress" />}
            </div>

            {err && (
              <Notice tone={err.rows.length ? "warn" : "bad"}>
                <span data-testid="td-error">{err.text}</span>
                {err.rows.length > 0 && <RowErrors list={err.rows} />}
              </Notice>
            )}
            {done && <Result r={done} />}

            <div className="mf-mg-sec" data-testid="td-learned">
              <h3>What we learned about the fields</h3>
              {fieldOps.length === 0 ? <span className="mf-mg-small mf-mg-muted">Add an example and the fields of the request and the answer appear here.</span> : (
                <div className="mf-mg-stack" style={{ gap: 10 }}>{fieldOps.map(([k, f]) => <Fields key={k} op={k} f={f} />)}</div>
              )}
            </div>

            <div className="mf-mg-sec" data-testid="td-suggestions">
              <h3>Suggestions for your TODO list</h3>
              {sq.isLoading ? <Loading rows={1} h={70} /> : sq.isError ? (
                <Notice tone="bad"><span data-testid="td-suggestions-error">{errText(sq.error)}</span></Notice>
              ) : suggestions.length === 0 ? (
                <span className="mf-mg-small mf-mg-muted" data-testid="td-suggestions-none">{steps.length ? "No suggestions yet. Add examples, or an example for one TODO step." : "There are no TODO steps."}</span>
              ) : (
                <div className="mf-mg-stack" style={{ gap: 10 }}>
                  {suggestions.map((s) => <SuggestionCard key={s.id} s={s} busy={!!m.busy || !!m.queued || accepting !== null} accepting={accepting === s.id} accepted={accepted.has(s.id)} problem={acceptErr[s.id]} onAccept={() => accept(s)} />)}
                </div>
              )}
              {acceptDone && <Notice tone="ok"><span data-testid="td-accept-done">{acceptDone}</span></Notice>}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
