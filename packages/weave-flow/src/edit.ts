// "Change in your own words": one selected item of an existing flow (a step, the flow itself, or a
// connection) is changed by lines written in plain words. FIXED rules only, like Describe: every line
// becomes a concrete change (a field before -> after, a mapping rule, a step added or removed, an error
// path, a connection setting) or is reported as not understood with the closest phrasings. Issue-style
// lines ("this returns {}") are matched against known diagnoses. Nothing is saved here.
import type { Flow, FlowEdge, FlowNode, MappingRule } from "./types.js";
import type { DescribeContext, DescribeLine, MissingConnection, PhraseHint } from "./describe.js";
import { zohoApiFor, zohoCentre, zohoMismatch, zohoTokenUrlFor } from "./zoho.js";
import { lessonMessage } from "./lessons.js";

// ---------------------------------------------------------------- what can be written
export type EditScope = "trigger" | "schedule" | "call" | "db" | "choice" | "map" | "respond" | "log" | "any" | "issue" | "flow" | "connection";
export interface EditPhrase { scope: EditScope; phrase: string; example: string; }
export const EDIT_PHRASES: EditPhrase[] = [
  { scope: "trigger", phrase: "Change the path to /PATH", example: "change the path to /newsletter/v2/subscribe" },
  { scope: "trigger", phrase: "Also accept METHOD | Only accept METHOD | Stop accepting METHOD", example: "also accept PUT" },
  { scope: "trigger", phrase: "Make HEADER optional | required", example: "make X-Channel optional" },
  { scope: "schedule", phrase: "Every N seconds | minutes | hours", example: "every 10 minutes" },
  { scope: "schedule", phrase: "Every day at HH:MM", example: "every day at 06:30" },
  { scope: "call", phrase: "Retry N times [waiting S seconds [then T seconds]]", example: "retry 3 times waiting 2 seconds" },
  { scope: "call", phrase: "Do not retry", example: "do not retry" },
  { scope: "call", phrase: "Timeout N seconds", example: "timeout 10 seconds" },
  { scope: "call", phrase: "Add header NAME from the request | Add header NAME \"VALUE\"", example: "add header Accept-Language from the request" },
  { scope: "call", phrase: "Remove header NAME", example: "remove header X-Debug" },
  { scope: "call", phrase: "Send the FIELD field too [as NAME]", example: "send the Company field too" },
  { scope: "call", phrase: "Use the NAME connection", example: "use the Zoho India connection" },
  { scope: "call", phrase: "Cache the answer for N seconds (GET)", example: "cache the answer for 60 seconds" },
  { scope: "call", phrase: "Share identical calls (GET)", example: "share identical calls" },
  { scope: "call", phrase: "Send it in the background", example: "send it in the background" },
  { scope: "call", phrase: "Reuse the session [for N minutes]", example: "reuse the session for 50 minutes" },
  { scope: "call", phrase: "Use METHOD | Call /PATH instead", example: "call /crm/v8/Leads/upsert instead" },
  { scope: "call", phrase: "Keep the answer as NAME", example: "keep the answer as lead" },
  { scope: "call", phrase: "Do not fail on 4xx", example: "do not fail on 4xx" },
  { scope: "db", phrase: "Timeout N seconds", example: "timeout 30 seconds" },
  { scope: "choice", phrase: "Also treat 'value' in lower case as VALUE | Ignore letter case", example: "also treat 'web' in lower case as WEB" },
  { scope: "map", phrase: "Map TARGET from FIELD | from A and B without a space | from WORDS", example: "map Mobile from country code and contact without a space" },
  { scope: "map", phrase: "Drop empty fields", example: "drop empty fields" },
  { scope: "map", phrase: "Remove TARGET | Rename TARGET to NEW", example: "remove Industry" },
  { scope: "respond", phrase: "Answer STATUS instead of STATUS | Status STATUS", example: "answer 201 instead of 200" },
  { scope: "respond", phrase: "Add the correlation id header | Add header NAME \"VALUE\"", example: "add the correlation id header" },
  { scope: "respond", phrase: "Answer with THING | Return the THING id", example: "answer with the lead id" },
  { scope: "log", phrase: "Log at LEVEL | Change the message to \"TEXT\"", example: "log at warning" },
  { scope: "any", phrase: "After this step log \"TEXT {field}\" | wait N seconds | answer STATUS", example: "after this step log \"subscribed {email}\"" },
  { scope: "any", phrase: "Before this step log \"TEXT\"", example: "before this step log \"calling Zoho\"" },
  { scope: "any", phrase: "If this call fails answer STATUS with code CODE", example: "if this call fails answer 502 with code CRM_ERROR" },
  { scope: "any", phrase: "Remove this step | Disable this step | Enable this step | Rename this step to NAME", example: "remove this step" },
  { scope: "any", phrase: "In STEP NAME: CHANGE (for a step that is not selected)", example: "in Upsert Zoho CRM Leads: timeout 10 seconds" },
  { scope: "issue", phrase: "This returns {} — it should return THING", example: "this returns {} — it should return the lead id" },
  { scope: "issue", phrase: "Zoho answers 401 / INVALID_TOKEN", example: "Zoho answers 401 INVALID_TOKEN" },
  { scope: "issue", phrase: "Zoho rejects the record / INVALID_DATA", example: "Zoho rejects the record with INVALID_DATA" },
  { scope: "issue", phrase: "Zoho answers invalid_client", example: "Zoho answers invalid_client" },
  { scope: "issue", phrase: "The same guest creates a second lead", example: "the same guest creates a second lead" },
  { scope: "flow", phrase: "Rename the flow to NAME | Base path /PATH/vN", example: "base path /newsletter/v2" },
  { scope: "flow", phrase: "Publish on the gateway | Do not publish | Timeout N seconds", example: "do not publish on the gateway" },
  { scope: "flow", phrase: "Keep step payloads in traces | Do not keep step payloads", example: "do not keep step payloads" },
  { scope: "connection", phrase: "Use the COUNTRY data centre", example: "use the Saudi data centre" },
  { scope: "connection", phrase: "Base URL ADDRESS | Token URL ADDRESS | Token prefix WORD | Scope SCOPES", example: "token prefix Zoho-oauthtoken" },
  { scope: "connection", phrase: "Send client credentials as form body | Basic header", example: "send client credentials as form body" },
  { scope: "connection", phrase: "Use the refresh token sign-in | Timeout N seconds | Verify TLS", example: "use the refresh token sign-in" },
];

// ---------------------------------------------------------------- result
export type EditTarget = { kind: "flow" } | { kind: "node"; nodeId: string } | { kind: "connection"; connectionId: string };
export interface EditChange {
  kind: "set" | "add-step" | "remove-step" | "add-rule" | "change-rule" | "remove-rule" | "add-path" | "connection";
  nodeId?: string; nodeName?: string; field: string; before: unknown; after: unknown; line: number;
}
export interface FullConnection { id: string; name: string; type: string; config: Record<string, unknown>; }
export interface EditContext extends DescribeContext { fullConnections?: FullConnection[]; }
export interface EditResult {
  target: EditTarget;
  flow: Flow;                                     // the flow with every change (a copy; the input is untouched)
  connection?: { id: string; name: string; before: Record<string, unknown>; after: Record<string, unknown> };
  lines: DescribeLine[];
  changes: EditChange[];
  missing: MissingConnection[];
  instructions: { nodeId: string; ruleId: string; line: number; instruction: string }[];
  diagnoses: { line: number; text: string; lesson?: string }[];
  lessonWarnings: { nodeId?: string; message: string; lesson: string; new?: boolean }[];
  ok: boolean;
}

// ---------------------------------------------------------------- helpers
const lc = (s: string) => s.toLowerCase();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const seg = (k: string) => (IDENT.test(k) ? k : "`" + k.replace(/`/g, "") + "`");
const jstr = (v: unknown) => JSON.stringify(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const camel = (s: string) => { const w = s.split(/[^A-Za-z0-9]+/).filter(Boolean); return w.map((x, i) => (i ? x.charAt(0).toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join(""); };
const unq = (s: string) => { const t = s.trim(); return /^"[^"]*"$/.test(t) || /^'[^']*'$/.test(t) ? t.slice(1, -1) : null; };
const stripArt = (s: string) => s.trim().replace(/^(?:the|a|an)\s+/i, "").trim();
const secondsOf = (n: string, unit: string) => Math.round(Number(n) * (/^ms|^milli/i.test(unit) ? 0.001 : /^min/i.test(unit) ? 60 : /^h/i.test(unit) ? 3600 : 1));
const NUMW: Record<string, number> = { once: 1, one: 1, twice: 2, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10 };
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUMW[lc(s)] ?? NaN);
function tokens(s: string): string[] { return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase()); }
function similarity(a: string, b: string): number {
  const ta = new Set(tokens(a).filter((w) => w.length > 1)), tb = new Set(tokens(b).filter((w) => w.length > 1));
  if (!ta.size || !tb.size) return 0;
  let both = 0; for (const w of ta) if (tb.has(w)) both++;
  return (2 * both) / (ta.size + tb.size) + (tokens(a)[0] && tokens(a)[0] === tokens(b)[0] ? 0.35 : 0);
}
export function scopeOf(node: FlowNode | undefined): EditScope {
  if (!node) return "flow";
  const t = node.type;
  if (t === "trigger.http") return "trigger";
  if (t === "trigger.schedule") return "schedule";
  if (t === "http.request" || t === "graphql.request" || t.startsWith("connector:")) return "call";
  if (/^(?:postgres|mysql|mssql)\.query$/.test(t)) return "db";
  if (t === "logic.choice") return "choice";
  if (t === "transform.map") return "map";
  if (t === "respond") return "respond";
  if (t === "log") return "log";
  return "any";
}
/** The 3 phrasings closest to a line, for the selected item's kind first. */
export function closestEditPhrases(text: string, scope: EditScope, n = 3): PhraseHint[] {
  const allowed = new Set<EditScope>([scope, "any", "issue", ...(scope === "flow" ? ["trigger", "call", "map", "respond"] as EditScope[] : [])]);
  return EDIT_PHRASES.filter((p) => allowed.has(p.scope))
    .map((p) => ({ p, s: Math.max(similarity(text, p.example), similarity(text, p.phrase)) + (p.scope === scope ? 0.15 : 0) }))
    .sort((x, y) => y.s - x.s).slice(0, n).map(({ p }) => ({ phrase: p.phrase, example: p.example }));
}
/** Top-level names an expression reads from the payload (as the runtime validator reads them). */
export function namesRead(expr: string): string[] {
  const noStrings = String(expr).replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, " ").replace(/\/(?:[^/\\\n]|\\.)+\/[a-z]*/g, " ");
  const out = new Set<string>();
  for (const m of noStrings.matchAll(/(?<![\w$.\]])([A-Za-z_][A-Za-z0-9_]*)(?!\s*\()(?![\w])/g)) {
    if (["and", "or", "in", "true", "false", "null", "function"].includes(m[1])) continue;
    const after = noStrings.slice((m.index ?? 0) + m[1].length).trimStart();
    if (after.startsWith(":") && !after.startsWith(":=")) continue;
    out.add(m[1]);
  }
  return [...out];
}

// ---------------------------------------------------------------- the editor
class Editor {
  flow: Flow;
  lines = new Map<number, DescribeLine>();
  changes: EditChange[] = [];
  missing: MissingConnection[] = [];
  instructions: EditResult["instructions"] = [];
  diagnoses: EditResult["diagnoses"] = [];
  connection?: EditResult["connection"];
  private seq = 0;
  constructor(flow: Flow, public target: EditTarget, public ctx: EditContext) { this.flow = clone(flow); }

  node(id: string) { return this.flow.nodes.find((n) => n.id === id); }
  sample(): Record<string, unknown> {
    const t = this.flow.nodes.find((n) => n.type === "trigger.http");
    const b = (t?.config.sampleRequest as { body?: unknown } | undefined)?.body;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  }
  ok(L: number, s: string) { const l = this.lines.get(L)!; if (l.status !== "not-understood") { if (l.status !== "warning") l.status = "ok"; l.role = "step"; l.understood = l.understood ? `${l.understood}; ${s}` : s; } }
  warn(L: number, s: string) { const l = this.lines.get(L)!; if (l.status !== "not-understood") { l.status = "warning"; l.message = l.message ? `${l.message} ${s}` : s; } }
  fail(L: number, scope: EditScope, s?: string) { const l = this.lines.get(L)!; l.status = "not-understood"; l.role = "step"; l.message = s ?? "This line does not match any change this reader knows for this item, so nothing was changed for it."; l.suggestions = closestEditPhrases(l.text, scope); }
  link(L: number, id: string) { const l = this.lines.get(L)!; if (!l.nodeIds.includes(id)) l.nodeIds.push(id); }
  set(L: number, node: FlowNode, field: string, after: unknown, kind: EditChange["kind"] = "set") {
    const before = field.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), node.config);
    if (jstr(before) === jstr(after)) return false;
    const parts = field.split("."); let o = node.config as Record<string, unknown>;
    for (const p of parts.slice(0, -1)) { if (!o[p] || typeof o[p] !== "object") o[p] = {}; o = o[p] as Record<string, unknown>; }
    o[parts[parts.length - 1]] = clone(after);
    if (field === "mapping" && before && typeof before === "object") {
      // one entry per rule that changed, so the preview shows field by field
      const ruleOf = (r: MappingRule | undefined) => (r ? (r.kind === "direct" ? r.source : r.kind === "const" ? jstr(r.value) : r.kind === "instruction" ? `"${r.instruction}"` : r.expr) ?? null : null);
      const was = (before as { rules?: MappingRule[] }).rules ?? [], now = (after as { rules?: MappingRule[] }).rules ?? [];
      for (const r of now) { const old = was.find((x) => x.id === r.id); if (!old || jstr(old) !== jstr(r)) this.changes.push({ kind: !old ? "add-rule" : "change-rule", nodeId: node.id, nodeName: node.name, field: `mapping.${r.target}${old && old.target !== r.target ? ` (was ${old.target})` : ""}`, before: ruleOf(old), after: ruleOf(r), line: L }); }
      for (const r of was) if (!now.some((x) => x.id === r.id)) this.changes.push({ kind: "remove-rule", nodeId: node.id, nodeName: node.name, field: `mapping.${r.target}`, before: ruleOf(r), after: null, line: L });
    } else this.changes.push({ kind, nodeId: node.id, nodeName: node.name, field, before: before === undefined ? null : clone(before), after: clone(after), line: L });
    this.link(L, node.id);
    return true;
  }
  setFlow(L: number, field: string, after: unknown) {
    const parts = field.split("."); let o = this.flow as unknown as Record<string, unknown>;
    for (const p of parts.slice(0, -1)) { if (!o[p] || typeof o[p] !== "object") o[p] = {}; o = o[p] as Record<string, unknown>; }
    const before = o[parts[parts.length - 1]];
    if (jstr(before) === jstr(after)) return false;
    o[parts[parts.length - 1]] = clone(after);
    this.changes.push({ kind: "set", field: `flow.${field}`, before: before === undefined ? null : clone(before), after: clone(after), line: L });
    return true;
  }
  newId(prefix = "n_e") { let id = ""; do id = `${prefix}${String(++this.seq).padStart(2, "0")}`; while (this.flow.nodes.some((n) => n.id === id) || this.flow.edges.some((e) => e.id === id)); return id; }
  uniqueName(base: string) { const taken = new Set(this.flow.nodes.map((n) => n.name)); let nm = base.slice(0, 60), i = 2; while (taken.has(nm)) nm = `${base.slice(0, 56)} ${i++}`; return nm; }
  addNode(L: number, type: string, name: string, config: Record<string, unknown>, near: FlowNode, dy = 0): FlowNode {
    const n: FlowNode = { id: this.newId(), type, name: this.uniqueName(name), position: { x: near.position.x + 300, y: near.position.y + dy }, config };
    this.flow.nodes.push(n);
    this.changes.push({ kind: "add-step", nodeId: n.id, nodeName: n.name, field: "step", before: null, after: { type, name: n.name }, line: L });
    this.link(L, n.id);
    return n;
  }
  edge(from: string, port: string, to: string) { this.flow.edges.push({ id: this.newId("e_e"), from, fromPort: port, to }); }
  varsMade(): Map<string, FlowNode> {
    const m = new Map<string, FlowNode>();
    for (const n of this.flow.nodes) {
      if (n.config.resultTarget === "variable" && typeof n.config.resultVar === "string") m.set(n.config.resultVar, n);
      if (n.type === "vars.set") for (const a of (n.config.assignments as { key: string }[] | undefined) ?? []) m.set(a.key, n);
    }
    return m;
  }
  /** A field named in words: a variable kept above, or a field of the sample request (with its wrapper). */
  fieldRef(phrase: string): { expr: string; label: string } | null {
    const p = stripArt(phrase).replace(/'s\b/g, "");
    if (!p) return null;
    const vars = this.varsMade();
    for (const cand of [camel(p) + "Clean", camel(p), p]) if (vars.has(cand)) return { expr: `$vars.${seg(cand)}`, label: `the variable ${cand}` };
    const sample = this.sample();
    const find = (obj: Record<string, unknown>, prefix: string): string | null => {
      for (const [k, v] of Object.entries(obj)) {
        if (norm(k) === norm(p)) return prefix ? `${prefix}.${seg(k)}` : seg(k);
        if (v && typeof v === "object" && !Array.isArray(v)) { const r = find(v as Record<string, unknown>, prefix ? `${prefix}.${seg(k)}` : seg(k)); if (r) return r; }
      }
      return null;
    };
    const path = find(sample, "");
    if (path) return { expr: path, label: `${path} of the request` };
    if (/^[A-Za-z_][\w.]*$/.test(p) && p.includes(".")) return { expr: p.split(".").map(seg).join("."), label: p };
    return null;
  }
  callResultPath(call: FlowNode, thing?: string): string {
    const v = `$vars.${seg(String(call.config.resultVar ?? "response"))}`;
    const zoho = /\/crm\/v\d+\//i.test(String(call.config.url ?? "")) || /zoho/i.test(call.name);
    if (thing && /\bid\b/i.test(thing)) return zoho ? `${v}.data[0].details.id` : `${v}.id`;
    return v;
  }
  calls(): FlowNode[] { return this.flow.nodes.filter((n) => scopeOf(n) === "call"); }
  upstream(node: FlowNode): FlowNode[] {
    const seen = new Set<string>(); const out: FlowNode[] = []; const stack = this.flow.edges.filter((e) => e.to === node.id).map((e) => e.from);
    while (stack.length) { const id = stack.pop()!; if (seen.has(id)) continue; seen.add(id); const n = this.node(id); if (n) { out.push(n); stack.push(...this.flow.edges.filter((e) => e.to === id).map((e) => e.from)); } }
    return out;
  }
  connectionOf(call: FlowNode | undefined): FullConnection | undefined {
    const id = call?.config.connection; return id ? (this.ctx.fullConnections ?? []).find((c) => c.id === id) : undefined;
  }

  // ------------------------------------------------ dispatch
  line(L: number, raw: string) {
    let text = raw.trim();
    let target = this.target;
    // "in STEP NAME: change" addresses another step
    const addr = /^(?:in|for|on)\s+(?:the\s+)?(?:step\s+)?"?([^":]{2,60}?)"?\s*:\s+(.+)$/i.exec(text);
    if (addr) {
      const n = this.flow.nodes.find((x) => norm(x.name) === norm(addr[1])) ?? this.flow.nodes.find((x) => norm(x.name).startsWith(norm(addr[1])) && norm(addr[1]).length >= 4);
      if (n) { target = { kind: "node", nodeId: n.id }; text = addr[2].trim(); this.link(L, n.id); }
    }
    if (target.kind === "connection") return this.connectionLine(L, text, target.connectionId);
    const node = target.kind === "node" ? this.node(target.nodeId) : undefined;
    if (target.kind === "node" && !node) return this.fail(L, "any", "The selected step is no longer in the flow.");
    const scope = scopeOf(node);
    if (this.issueLine(L, text, node)) return;
    if (node && this.structural(L, text, node)) return;
    if (node) {
      const done = scope === "trigger" ? this.triggerLine(L, text, node)
        : scope === "schedule" ? this.scheduleLine(L, text, node)
        : scope === "call" ? this.callLine(L, text, node)
        : scope === "db" ? this.dbLine(L, text, node)
        : scope === "choice" ? this.choiceLine(L, text, node)
        : scope === "map" ? this.mapLine(L, text, node)
        : scope === "respond" ? this.respondLine(L, text, node)
        : scope === "log" ? this.logLine(L, text, node) : false;
      if (done) return;
    } else if (this.flowLine(L, text)) return;
    this.fail(L, scope);
  }

  // ------------------------------------------------ flow level
  flowLine(L: number, t: string): boolean {
    let m: RegExpExecArray | null;
    if ((m = /^(?:rename|call)\s+(?:the\s+|this\s+)?flow\s+(?:to\s+)?"?(.+?)"?$/i.exec(t))) { this.setFlow(L, "name", m[1].trim()); this.ok(L, `the flow is called "${m[1].trim()}"`); return true; }
    if ((m = /^(?:change\s+the\s+)?base\s*path\s+(?:to\s+)?(\/[\w\-./]+)$/i.exec(t))) { this.basePath(L, m[1]); return true; }
    if (/^(?:publish|put)\s+(?:it\s+)?on\s+the\s+gateway$/i.test(t)) { this.setFlow(L, "settings.gateway.publish", true); this.ok(L, "published on the gateway when deployed"); return true; }
    if (/^(?:do not|don't|stop)\s+publish(?:ing)?(?:\s+(?:it\s+)?on\s+the\s+gateway)?$/i.test(t)) { this.setFlow(L, "settings.gateway.publish", false); this.ok(L, "not published on the gateway"); return true; }
    if (/^(?:keep|store)\s+(?:the\s+)?step\s+payloads(?:\s+in\s+(?:the\s+)?traces)?$/i.test(t)) { this.setFlow(L, "settings.logPayloads", true); this.ok(L, "step input and output are kept in traces"); this.warn(L, "Traces then hold personal data from requests."); return true; }
    if (/^(?:do not|don't|stop)\s+(?:keep(?:ing)?|stor(?:e|ing))\s+(?:the\s+)?step\s+payloads/i.test(t)) { this.setFlow(L, "settings.logPayloads", false); this.ok(L, "step input and output are not kept in traces"); return true; }
    if ((m = /^(?:flow\s+)?time\s*out\s+(?:after\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|minutes?)$/i.exec(t))) { const ms = Math.round(secondsOf(m[1], m[2]) * 1000); this.setFlow(L, "settings.timeoutMs", ms); this.ok(L, `the whole flow gives up after ${ms} ms`); return true; }
    return false;
  }
  basePath(L: number, p: string) {
    const clean = p.replace(/\/+$/, "");
    this.setFlow(L, "settings.basePath", clean);
    const m = /^\/([\w-]+)\/(v\d+)$/.exec(clean);
    if (m && this.flow.settings.gateway) { this.setFlow(L, "settings.gateway.context", `/${m[1]}`); this.setFlow(L, "settings.gateway.version", m[2]); }
    this.ok(L, `the base path is ${clean}${m ? ` (gateway /${m[1]} ${m[2]})` : ""}`);
  }

  // ------------------------------------------------ trigger
  triggerLine(L: number, t: string, n: FlowNode): boolean {
    let m: RegExpExecArray | null;
    const METHODS = "GET|POST|PUT|PATCH|DELETE";
    if ((m = /^(?:change|set|move)?\s*(?:the\s+)?(?:path|address|url)\s+(?:to\s+)?(\/\S+)$/i.exec(t)) || (m = /^(?:listen|answer)\s+on\s+(\/\S+)$/i.exec(t))) {
      const want = m[1].replace(/\{([^}]+)\}/g, ":$1").replace(/\/+$/, "") || "/";
      const base = this.flow.settings.basePath ?? "";
      const vm = /^(\/[\w-]+\/v\d+)(\/.*)$/.exec(want);
      if (base && want.startsWith(base + "/")) { this.set(L, n, "path", want.slice(base.length)); this.ok(L, `the listener answers ${want} (path ${want.slice(base.length)} under ${base})`); }
      else if (vm) { this.basePath(L, vm[1]); this.set(L, n, "path", vm[2]); this.ok(L, `the listener answers ${want}`); }
      else { this.set(L, n, "path", want); this.ok(L, `the listener path is ${want}`); }
      this.renameTrigger(n);
      return true;
    }
    const list = (s: string) => [...new Set((s.toUpperCase().match(new RegExp(METHODS, "g")) ?? []))];
    const cur = (n.config.methods as string[] | undefined) ?? ["GET"];
    if ((m = new RegExp(`^also\\s+(?:accept|allow|answer)\\s+((?:${METHODS})(?:[\\s,]+(?:and\\s+)?(?:${METHODS}))*)$`, "i").exec(t))) { const next = [...new Set([...cur, ...list(m[1])])]; this.set(L, n, "methods", next); this.ok(L, `accepts ${next.join(", ")}`); this.renameTrigger(n); return true; }
    if ((m = new RegExp(`^(?:only\\s+)?(?:accept|allow)\\s+(?:only\\s+)?((?:${METHODS})(?:[\\s,]+(?:and\\s+)?(?:${METHODS}))*)(?:\\s+only)?$`, "i").exec(t))) { const next = list(m[1]); this.set(L, n, "methods", next); this.ok(L, `accepts only ${next.join(", ")}`); this.renameTrigger(n); return true; }
    if ((m = new RegExp(`^(?:stop accepting|do not accept|don't accept|no longer accept)\\s+((?:${METHODS})(?:[\\s,]+(?:and\\s+)?(?:${METHODS}))*)$`, "i").exec(t))) {
      const next = cur.filter((x) => !list(m![1]).includes(x));
      if (!next.length) { this.fail(L, "trigger", "A listener needs at least one method."); return true; }
      this.set(L, n, "methods", next); this.ok(L, `accepts ${next.join(", ")}`); this.renameTrigger(n); return true;
    }
    if ((m = /^make\s+(?:the\s+)?(?:header\s+)?"?([\w-]+)"?(?:\s+header)?\s+(optional|required|mandatory)$/i.exec(t))) return this.headerRequired(L, m[1], !/optional/i.test(m[2]));
    return false;
  }
  renameTrigger(n: FlowNode) {
    const methods = (n.config.methods as string[] | undefined) ?? [];
    if (/^(?:GET|POST|PUT|PATCH|DELETE)(?:, [A-Z]+)* \//.test(n.name)) n.name = this.uniqueNameExcept(n, `${methods.join(", ")} ${this.flow.settings.basePath && !String(n.config.path).startsWith(this.flow.settings.basePath) ? this.flow.settings.basePath : ""}${n.config.path}`);
  }
  uniqueNameExcept(n: FlowNode, base: string) { const taken = new Set(this.flow.nodes.filter((x) => x !== n).map((x) => x.name)); let nm = base.slice(0, 60), i = 2; while (taken.has(nm)) nm = `${base.slice(0, 56)} ${i++}`; return nm; }
  headerRequired(L: number, header: string, required: boolean): boolean {
    const h = header.toLowerCase();
    const vars = this.flow.nodes.filter((n) => n.type === "vars.set").flatMap((n) => ((n.config.assignments as { key: string; value: string }[]) ?? []).map((a) => ({ n, a })));
    const hv = vars.find(({ a }) => a.value.toLowerCase().includes(`$request.headers.${jstr(h)}`));
    if (!hv) { this.fail(L, "trigger", `No step reads the ${header} header, so there is nothing to make ${required ? "required" : "optional"}. Add a check with a Choice step.`); return true; }
    const v = `$vars.${hv.a.key}`;
    let changed = false;
    for (const ch of this.flow.nodes.filter((n) => n.type === "logic.choice")) {
      const conds = clone((ch.config.conditions as { id: string; label: string; expr: string }[]) ?? []);
      for (const c of conds) {
        const empty = `${v} = ""`;
        if (!required && c.expr.includes(`${empty} or `)) { c.expr = c.expr.replace(`${empty} or `, `${v} != "" and `); c.label = c.label.replace(/missing or /i, ""); changed = true; }
        else if (!required && c.expr.trim() === empty) { c.expr = "false"; changed = true; }
        else if (required && c.expr.includes(`${v} != "" and `)) { c.expr = c.expr.replace(`${v} != "" and `, `${empty} or `); changed = true; }
      }
      if (changed) { this.set(L, ch, "conditions", conds); break; }
    }
    if (!changed) { this.ok(L, `${header} is already ${required ? "required" : "optional"}`); return true; }
    this.ok(L, required ? `a missing ${header} is answered with the error again` : `a missing ${header} is let through; a value that is sent must still be an allowed one`);
    return true;
  }

  // ------------------------------------------------ schedule
  scheduleLine(L: number, t: string, n: FlowNode): boolean {
    let m: RegExpExecArray | null;
    if ((m = /^every\s+(\d+)?\s*(seconds?|minutes?|hours?)$/i.exec(t))) { const s = secondsOf(m[1] ?? "1", m[2]); this.set(L, n, "mode", "interval"); this.set(L, n, "everySeconds", s); this.ok(L, `runs every ${s} seconds`); return true; }
    if ((m = /^every\s+day\s+at\s+(\d{1,2})(?::(\d{2}))?$/i.exec(t))) { this.set(L, n, "mode", "cron"); this.set(L, n, "cron", `${Number(m[2] ?? 0)} ${Number(m[1])} * * *`); this.ok(L, `runs every day at ${m[1]}:${m[2] ?? "00"}`); return true; }
    return false;
  }

  // ------------------------------------------------ calls
  callLine(L: number, t: string, n: FlowNode): boolean {
    let m: RegExpExecArray | null;
    const method = String(n.config.method ?? (n.type === "graphql.request" ? "POST" : "POST")).toUpperCase();
    const idempotent = ["GET", "HEAD", "OPTIONS"].includes(method) || /\/upsert(?:$|[/?])/i.test(String(n.config.url ?? "")) || ((n.config.headers as { key: string }[] | undefined) ?? []).some((h) => /^idempotency-key$/i.test(h.key));
    if ((m = /^(?:retry|try again)\s+(?:it\s+)?(?:up\s+to\s+)?(\d+|once|twice|one|two|three|four|five)(?:\s*times?)?(?:\s*,?\s*(?:waiting|wait|with)\s+(\d+(?:\.\d+)?)\s*(ms|s|secs?|seconds?)(?:\s*(?:then|and then|,)\s*(\d+(?:\.\d+)?)\s*(ms|s|secs?|seconds?))?(?:\s+between(?:\s+tries)?)?)?(?:\s*,?\s*(even though it may change data))?$/i.exec(t))) {
      const k = num(m[1]);
      this.set(L, n, "retries", k);
      if (m[2]) {
        const a = Math.round(secondsOf(m[2], m[3]) * 1000), b = m[4] ? Math.round(secondsOf(m[4], m[5]) * 1000) : null;
        this.set(L, n, "retryDelayMs", a);
        this.set(L, n, "retryDelaysMs", b !== null ? `${a}, ${b}` : `${a}`);
      }
      if (m[6]) this.set(L, n, "retryUnsafe", true);
      this.ok(L, `"${n.name}" is retried ${k} time${k === 1 ? "" : "s"}${m[2] ? `, waiting ${n.config.retryDelaysMs} ms` : ""}`);
      if (!idempotent && !m[6]) this.warn(L, `${lessonMessage("L4.retry-non-idempotent", n.name, `${method} can change data twice, so the runtime does not repeat it`)} Write "retry ${k} times, even though it may change data" only if the backend ignores repeats.`);
      return true;
    }
    if (/^(?:do not|don't|never|no)\s+retr(?:y|ies)(?:\s+it)?$/i.test(t)) { this.set(L, n, "retries", 0); this.ok(L, `"${n.name}" is not retried`); return true; }
    if ((m = /^(?:set\s+the\s+)?time\s*out\s+(?:to\s+|after\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)$/i.exec(t))) {
      const ms = Math.round(secondsOf(m[1], m[2]) * 1000);
      this.set(L, n, "timeoutMs", ms); this.ok(L, `"${n.name}" gives up after ${ms} ms`);
      if (ms >= 30000) this.warn(L, lessonMessage("L4.timeout-too-long", n.name, `${ms} ms is not below the gateway's 30 s`));
      return true;
    }
    if ((m = /^(?:add|forward|pass)\s+(?:the\s+)?(?:header\s+)?"?([\w-]+)"?(?:\s+header)?\s+from\s+the\s+(?:incoming\s+)?request$/i.exec(t))) {
      const list = [...((n.config.forwardHeaders as string[] | undefined) ?? [])];
      if (!list.some((x) => lc(x) === lc(m![1]))) list.push(m[1]);
      this.set(L, n, "forwardHeaders", list); this.ok(L, `the ${m[1]} header of the incoming request is sent on`); return true;
    }
    if ((m = /^add\s+(?:the\s+)?header\s+"?([\w-]+)"?\s*(?:[:=]|with(?:\s+the)?\s+value)?\s+(.+)$/i.exec(t))) {
      const value = this.template(unq(m[2]) ?? m[2]);
      const list = clone(((n.config.headers as { key: string; value: string }[] | undefined) ?? []).filter((h) => lc(h.key) !== lc(m![1])));
      list.push({ key: m[1], value }); this.set(L, n, "headers", list); this.ok(L, `header ${m[1]}: ${value}`); return true;
    }
    if ((m = /^remove\s+(?:the\s+)?header\s+"?([\w-]+)"?$/i.exec(t))) {
      const h = ((n.config.headers as { key: string }[] | undefined) ?? []), f = ((n.config.forwardHeaders as string[] | undefined) ?? []);
      if (!h.some((x) => lc(x.key) === lc(m![1])) && !f.some((x) => lc(x) === lc(m![1]))) { this.fail(L, "call", `"${n.name}" does not send a ${m[1]} header.`); return true; }
      this.set(L, n, "headers", h.filter((x) => lc(x.key) !== lc(m![1]))); this.set(L, n, "forwardHeaders", f.filter((x) => lc(x) !== lc(m![1]))); this.ok(L, `the ${m[1]} header is no longer sent`); return true;
    }
    if ((m = /^(?:also\s+)?send\s+(?:the\s+)?"?(.+?)"?(?:\s+field)?(?:\s+too|\s+as\s+well)?(?:\s+as\s+"?([\w-]+)"?)?$/i.exec(t)) && !/background/i.test(t)) return this.sendField(L, n, stripArt(m[1]).replace(/\s+field$/i, ""), m[2]);
    if ((m = /^use\s+(?:the\s+)?(?:connection\s+)?"?(.+?)"?(?:\s+connection)?$/i.exec(t)) && !/^(?:get|post|put|patch|delete)$/i.test(m[1]) && !/data cent(?:re|er)/i.test(t)) return this.useConnection(L, n, m[1]);
    if ((m = /^(?:cache|keep)\s+(?:the\s+)?(?:answer|response|result)\s+(?:for\s+)?(\d+)\s*(s|secs?|seconds?|minutes?)$/i.exec(t))) {
      if (method !== "GET") { this.warn(L, `Only GET calls keep answers (lesson L2); "${n.name}" is a ${method}, so nothing was changed.`); this.ok(L, "read, not applied"); return true; }
      const s = secondsOf(m[1], m[2]); this.set(L, n, "cacheSeconds", s); this.set(L, n, "shareIdentical", true);
      this.ok(L, `"${n.name}" keeps its answer for ${s} seconds and identical calls share one backend call (lesson L2)`); return true;
    }
    if (/^share\s+identical\s+calls$/i.test(t)) {
      if (method !== "GET") { this.warn(L, `Only GET calls are shared (lesson L2); "${n.name}" is a ${method}.`); this.ok(L, "read, not applied"); return true; }
      this.set(L, n, "shareIdentical", true); this.ok(L, "identical calls share one backend call (lesson L2)"); return true;
    }
    if (/^(?:send|run|do)\s+it\s+in\s+the\s+background$|^(?:do not|don't)\s+wait\s+for\s+it$/i.test(t)) { this.set(L, n, "background", true); this.ok(L, `"${n.name}" runs in the background; the flow does not wait for it (lesson L3)`); return true; }
    if ((m = /^reuse\s+the\s+session(?:\s+for\s+(\d+)\s*(minutes?|seconds?|hours?))?$/i.exec(t))) { this.set(L, n, "reuseSession", true); if (m[1]) this.set(L, n, "sessionSeconds", secondsOf(m[1], m[2])); this.ok(L, `the session is reused${m[1] ? ` for ${secondsOf(m[1], m[2])} seconds` : ""} (lesson L1)`); return true; }
    if ((m = /^use\s+(GET|POST|PUT|PATCH|DELETE)$/i.exec(t))) { this.set(L, n, "method", m[1].toUpperCase()); this.ok(L, `the call uses ${m[1].toUpperCase()}`); return true; }
    if ((m = /^(?:call|use)\s+(\/\S+)\s+instead$|^change\s+the\s+(?:address|url|path)\s+to\s+(\S+)$/i.exec(t))) { const u = m[1] ?? m[2]; this.set(L, n, "url", u); this.ok(L, `the call goes to ${u}`); return true; }
    if ((m = /^(?:keep|put|store)\s+(?:the\s+)?(?:answer|result|response)\s+(?:as|in)\s+(?:the\s+)?(?:variable\s+)?"?([A-Za-z_]\w*)"?$/i.exec(t))) return this.keepAs(L, n, m[1]);
    if (/^(?:do not|don't)\s+fail\s+on\s+4xx$|^treat\s+(?:4xx|errors?)\s+as\s+(?:an?\s+)?answers?$/i.test(t)) { this.set(L, n, "failOnStatus", false); this.ok(L, "4xx/5xx answers are passed on as data instead of taking the error path"); return true; }
    return false;
  }
  template(s: string): string { return s.replace(/\{\{[^}]*\}\}|\{([^{}]+)\}/g, (all, inner: string | undefined) => { if (!inner) return all; const r = this.fieldRef(inner); return r ? `{{ ${r.expr} }}` : all; }); }
  sendField(L: number, n: FlowNode, field: string, as?: string): boolean {
    const bodyVar = /\$vars\.(\w+)/.exec(jstr(n.config.body ?? ""))?.[1];
    const feeding = bodyVar ? this.flow.nodes.find((x) => x.type === "transform.map" && x.config.resultVar === bodyVar) : undefined;
    const already = feeding ? ((feeding.config.mapping as { rules?: MappingRule[] }).rules ?? []).find((r) => norm(r.target) === norm(as ?? field) && r.enabled !== false) : undefined;
    if (already) { this.ok(L, `"${n.name}" already sends ${already.target} (${already.kind === "expr" ? already.expr : already.kind === "direct" ? already.source : already.kind}), built in "${feeding!.name}"`); this.link(L, feeding!.id); return true; }
    const ref = this.fieldRef(field);
    if (!ref) { this.fail(L, "call", `"${field}" is not a field of the sample request or a variable kept above, so it is not known where its value comes from.`); return true; }
    const key = as ?? (/^[A-Za-z_][\w-]*$/.test(field) ? field : camel(field));
    const body = n.config.body;
    const recordVar = typeof body === "object" && body && Array.isArray((body as { data?: unknown }).data) ? /\$vars\.(\w+)/.exec(String((body as { data: unknown[] }).data[0]))?.[1] : typeof body === "string" ? /^\{\{\s*\$vars\.(\w+)\s*\}\}$/.exec(body)?.[1] : undefined;
    const map = recordVar ? this.flow.nodes.find((x) => x.type === "transform.map" && x.config.resultVar === recordVar) : undefined;
    if (map) {
      const spec = clone(map.config.mapping as { rules: MappingRule[] });
      const empty = (map.config.mapping as { rules: MappingRule[] }).rules.some((r) => /!= "" \?/.test(String(r.expr ?? "")));
      const expr = empty ? `${ref.expr} != "" ? ${ref.expr}` : ref.expr;
      const at = spec.rules.findIndex((r) => r.target === key);
      const rule: MappingRule = { id: at >= 0 ? spec.rules[at].id : `r${spec.rules.length + 1}_e`, target: key, kind: "expr", expr, comment: `Added in your own words: "${field}"` };
      if (at >= 0) spec.rules[at] = rule; else spec.rules.push(rule);
      this.set(L, map, "mapping", spec, at >= 0 ? "change-rule" : "add-rule");
      this.ok(L, `${key} = ${ref.label} is added to "${map.name}", which builds what "${n.name}" sends${empty ? " (left out when empty)" : ""}`);
      return true;
    }
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const next = { ...(body as Record<string, unknown>), [key]: `{{ ${ref.expr} }}` };
      this.set(L, n, "body", next); this.ok(L, `the body also carries ${key} = ${ref.label}`); return true;
    }
    this.fail(L, "call", `The body of "${n.name}" is not a list of fields, so a field cannot be added to it here. Change the step that builds it.`);
    return true;
  }
  useConnection(L: number, n: FlowNode, name: string): boolean {
    const list = (this.ctx.connections ?? []).filter((c) => c.type === "http");
    const words = tokens(name).filter((w) => !["the", "connection"].includes(w));
    const hit = list.find((c) => norm(c.name) === norm(name)) ?? list.find((c) => words.every((w) => norm(c.name).includes(w))) ?? null;
    if (hit) { this.set(L, n, "connection", hit.id); this.ok(L, `"${n.name}" uses the connection ${hit.name}`); return true; }
    const full = (this.ctx.fullConnections ?? []).find((c) => c.id === n.config.connection);
    const centre = words.map((w) => ({ india: "in", saudi: "sa", us: "com", europe: "eu", eu: "eu", australia: "com.au", japan: "jp", china: "com.cn", canada: "ca" } as Record<string, string>)[w]).find(Boolean);
    const base = centre ? (centre === "ca" ? "https://www.zohoapis.ca" : `https://www.zohoapis.${centre}`) : String(full?.config.baseUrl ?? "");
    this.missing.push({ key: `http:${norm(name)}`, name: name.replace(/\s+connection$/i, ""), type: "http", lines: [L], nodeIds: [n.id], why: `There is no connection called "${name}" yet.`,
      ...(base ? { suggested: { baseUrl: base, config: { baseUrl: base, ...(/zoho/i.test(name) || zohoCentre(base) ? { authType: "oauth2refresh", tokenUrl: zohoTokenUrlFor(base) ?? undefined, tokenPrefix: "Zoho-oauthtoken", clientAuth: "body" } : {}) } } } : {}) });
    this.ok(L, `"${n.name}" should use a connection called "${name}"`);
    this.warn(L, `There is no connection called "${name}" yet: create it with "New connection…", then read the change again.`);
    return true;
  }
  keepAs(L: number, n: FlowNode, name: string): boolean {
    const old = String(n.config.resultVar ?? "");
    this.set(L, n, "resultTarget", "variable"); this.set(L, n, "resultVar", name);
    if (old && old !== name) for (const o of this.flow.nodes) {
      if (o === n) continue;
      const before = jstr(o.config);
      const after = before.split(`$vars.${old}`).join(`$vars.${name}`);
      if (after !== before) { const cfg = JSON.parse(after) as Record<string, unknown>; for (const k of Object.keys(cfg)) if (jstr(cfg[k]) !== jstr(o.config[k])) this.set(L, o, k, cfg[k]); }
    }
    this.ok(L, `the answer of "${n.name}" is kept as ${name}${old && old !== name ? ` (was ${old}; steps that read it now read ${name})` : ""}`);
    return true;
  }
  dbLine(L: number, t: string, n: FlowNode): boolean {
    const m = /^(?:set\s+the\s+)?time\s*out\s+(?:to\s+|after\s+)?(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|minutes?)$/i.exec(t);
    if (!m) return false;
    const s = Math.max(1, Math.round(secondsOf(m[1], m[2]))); this.set(L, n, "timeoutSeconds", s); this.ok(L, `"${n.name}" stops after ${s} seconds`); return true;
  }

  // ------------------------------------------------ conditions
  choiceLine(L: number, t: string, n: FlowNode): boolean {
    let m: RegExpExecArray | null;
    if ((m = /^(?:also\s+)?(?:treat|accept)\s+'?"?([\w-]+)"?'?\s+in\s+(?:lower|upper|any)\s+case\s+as\s+'?"?([\w-]+)"?'?$/i.exec(t)) || /^(?:ignore|in any)\s+(?:the\s+)?(?:letter\s+)?case$|^compare\s+in\s+any\s+(?:letter\s+)?case$/i.test(t)) {
      const conds = clone((n.config.conditions as { id: string; label: string; expr: string }[]) ?? []);
      // the value may already be upper-cased where it is read (a header read "in any case")
      const vars = this.flow.nodes.filter((x) => x.type === "vars.set").flatMap((x) => (x.config.assignments as { key: string; value: string }[]) ?? []);
      let already = false, changed = false;
      for (const c of conds) {
        const next = c.expr
          .replace(/(?<!\$uppercase\()(\$vars\.\w+|[A-Za-z_][\w.`]*)\s*(=|!=)\s*"([A-Z0-9_]+)"/g, (all, ref: string, op: string, lit: string) => {
            const v = /^\$vars\.(\w+)$/.exec(ref)?.[1]; if (v && vars.some((a) => a.key === v && /^\$uppercase\(/.test(a.value))) { already = true; return all; }
            changed = true; return `$uppercase(${ref}) ${op} "${lit}"`; })
          .replace(/(?<!\$uppercase\()(\$vars\.\w+|[A-Za-z_][\w.`]*)\s+in\s+(\[[^\]]*\])/g, (all, ref: string, arr: string) => {
            const v = /^\$vars\.(\w+)$/.exec(ref)?.[1]; if (v && vars.some((a) => a.key === v && /^\$uppercase\(/.test(a.value))) { already = true; return all; }
            if (!/^\[\s*"[A-Z0-9_]+"(?:\s*,\s*"[A-Z0-9_]+")*\s*\]$/.test(arr)) return all; changed = true; return `$uppercase(${ref}) in ${arr}`; });
        c.expr = next;
      }
      if (changed) { this.set(L, n, "conditions", conds); this.ok(L, `"${n.name}" compares the codes in any letter case${m ? ` ('${m[1]}' counts as ${m[2]})` : ""}`); return true; }
      if (already) { this.ok(L, `"${n.name}" already compares in any letter case: the value is upper-cased where it is read${m ? ` ('${m[1]}' already counts as ${m[2]})` : ""}`); return true; }
      this.fail(L, "choice", `"${n.name}" has no condition that compares a code written in capitals.`); return true;
    }
    if ((m = /^remove\s+(?:the\s+)?(?:condition|case)\s+"?(.+?)"?$/i.exec(t))) {
      const conds = (n.config.conditions as { id: string; label: string; expr: string }[]) ?? [];
      const c = conds.find((x) => norm(x.label).includes(norm(m![1])));
      if (!c) { this.fail(L, "choice", `"${n.name}" has no condition called "${m[1]}".`); return true; }
      this.set(L, n, "conditions", conds.filter((x) => x !== c));
      this.flow.edges = this.flow.edges.filter((e) => !(e.from === n.id && e.fromPort === `case:${c.id}`));
      this.ok(L, `the condition "${c.label}" and its path are removed`); return true;
    }
    return false;
  }

  // ------------------------------------------------ mapping
  mapLine(L: number, t: string, n: FlowNode): boolean {
    let m: RegExpExecArray | null;
    const spec = () => clone(n.config.mapping as { rules: MappingRule[]; sampleSource?: unknown });
    if (/^(?:drop|leave out|omit|do not send|don't send)\s+(?:the\s+)?empty\s+(?:fields|values|strings)$/i.test(t)) {
      const s = spec(); let count = 0;
      for (const r of s.rules) {
        if (r.enabled === false) continue;
        const e = r.kind === "direct" ? (r.source ?? "") : r.kind === "expr" ? (r.expr ?? "") : r.kind === "instruction" ? (r.compiled?.expr ?? "") : "";
        if (!e || /^["\d[{]|^(?:true|false|null)$/.test(e.trim()) || /!= "" \?|\$x != ""/.test(e)) continue;
        r.kind = "expr"; r.expr = `($x := ${r.kind === "expr" ? e : e}; ($x != "" and $x != null) ? $x)`; delete r.source; count++;
      }
      if (!count) { this.ok(L, "every field is already left out when empty (or is a fixed value)"); return true; }
      this.set(L, n, "mapping", s, "change-rule"); this.ok(L, `${count} field${count === 1 ? " is" : "s are"} now left out when empty (lesson L7: Zoho rejects "" for number, picklist and currency fields)`); return true;
    }
    if ((m = /^(?:remove|drop|do not map|don't map|stop sending)\s+(?:the\s+)?"?([\w.\- ]+?)"?(?:\s+field)?$/i.exec(t))) {
      const s = spec(); const i = s.rules.findIndex((r) => norm(r.target) === norm(m![1]));
      if (i < 0) { this.fail(L, "map", `"${n.name}" has no field ${m[1]}.`); return true; }
      const [gone] = s.rules.splice(i, 1); this.set(L, n, "mapping", s, "remove-rule"); this.ok(L, `${gone.target} is no longer mapped`); return true;
    }
    if ((m = /^rename\s+(?:the\s+)?"?([\w.-]+)"?(?:\s+field)?\s+to\s+"?([\w.-]+)"?$/i.exec(t))) {
      const s = spec(); const r = s.rules.find((x) => norm(x.target) === norm(m![1]));
      if (!r) { this.fail(L, "map", `"${n.name}" has no field ${m[1]}.`); return true; }
      r.target = m[2]; this.set(L, n, "mapping", s, "change-rule"); this.ok(L, `${m[1]} is now written as ${m[2]}`); return true;
    }
    if ((m = /^map\s*:?\s+"?([\w.-]+)"?\s+(?:from|as|=)\s+(.+)$/i.exec(t))) {
      const target = m[1], words = m[2].trim();
      const s = spec(); const at = s.rules.findIndex((r) => r.target === target);
      const id = at >= 0 ? s.rules[at].id : `r${s.rules.length + 1}_e`;
      let rule: MappingRule;
      const join = /^(.+?)\s+and\s+(.+?)\s+(without\s+a\s+space|with\s+(?:a|one)\s+space|with\s+"([^"]*)")$/i.exec(words);
      const a = join ? this.fieldRef(join[1]) : null, b = join ? this.fieldRef(join[2]) : null;
      const direct = this.fieldRef(words);
      if (join && a && b) {
        const sep = /without/i.test(join[3]) ? "" : join[4] !== undefined ? join[4] : " ";
        rule = { id, target, kind: "expr", expr: `$string(${a.expr}) & ${jstr(sep)} & $string(${b.expr})`, comment: `In your own words: ${words}` };
        this.ok(L, `${target} = ${a.label} and ${b.label} joined ${sep ? `with "${sep}"` : "without a space"}`);
      } else if (direct) {
        rule = { id, target, kind: "expr", expr: direct.expr, comment: `In your own words: ${words}` };
        this.ok(L, `${target} = ${direct.label}`);
      } else {
        rule = { id, target, kind: "instruction", instruction: words, compiled: null };
        this.instructions.push({ nodeId: n.id, ruleId: id, line: L, instruction: words });
        this.ok(L, `${target} = "${words}" (read by the mapping phrases)`);
      }
      if (at >= 0) s.rules[at] = rule; else s.rules.push(rule);
      if (!s.sampleSource && Object.keys(this.sample()).length) s.sampleSource = this.sample() as never;
      this.set(L, n, "mapping", s, at >= 0 ? "change-rule" : "add-rule");
      return true;
    }
    return false;
  }

  // ------------------------------------------------ answers and logs
  respondLine(L: number, t: string, n: FlowNode): boolean {
    let m: RegExpExecArray | null;
    if ((m = /^(?:answer|respond|reply|return)\s+(\d{3})\s+instead\s+of\s+(\d{3})$/i.exec(t)) || (m = /^(?:set\s+the\s+)?status\s+(?:to\s+)?(\d{3})$/i.exec(t)) || (m = /^(?:answer|respond)\s+(?:with\s+)?(\d{3})$/i.exec(t))) {
      if (m[2] && String(n.config.status) !== m[2]) this.warn(L, `This answer was ${String(n.config.status)}, not ${m[2]}.`);
      this.set(L, n, "status", m[1]); this.ok(L, `"${n.name}" answers ${m[1]}`);
      if (/^Answer \d{3}/.test(n.name)) n.name = this.uniqueNameExcept(n, n.name.replace(/^Answer \d{3}/, `Answer ${m[1]}`));
      return true;
    }
    if (/^add\s+(?:the\s+)?correlation\s*(?:id|-id)?\s+header$/i.test(t)) {
      const has = this.varsMade().has("correlationId");
      const value = has ? "{{ $vars.correlationId }}" : "{{ $request.headers.\"x-correlation-id\" }}";
      const list = clone(((n.config.headers as { key: string; value: string }[] | undefined) ?? []).filter((h) => lc(h.key) !== "x-correlation-id"));
      list.push({ key: "X-Correlation-ID", value }); this.set(L, n, "headers", list);
      this.ok(L, `"${n.name}" returns X-Correlation-ID (${has ? "the id made at the start of the flow" : "the one the caller sent"})`);
      if (!has) this.warn(L, "No step makes a correlation id, so the header is empty when the caller sends none.");
      return true;
    }
    if ((m = /^add\s+(?:the\s+)?header\s+"?([\w-]+)"?\s*(?:[:=])?\s+(.+)$/i.exec(t))) {
      const list = clone(((n.config.headers as { key: string; value: string }[] | undefined) ?? []).filter((h) => lc(h.key) !== lc(m![1])));
      list.push({ key: m[1], value: this.template(unq(m[2]) ?? m[2]) }); this.set(L, n, "headers", list); this.ok(L, `"${n.name}" returns header ${m[1]}`); return true;
    }
    if ((m = /^(?:answer|respond|reply|return)\s+(?:with\s+)?(?:the\s+)?(.+)$/i.exec(t)) && !/^\d{3}\b/.test(m[1])) return this.answerWith(L, n, m[1]);
    return false;
  }
  /** "the lead id" / "the lead" / "the contact": the result of a call, by its variable or by the call's name. */
  thing(phrase: string): { expr: string; label: string; call?: FlowNode } | null {
    const words = stripArt(phrase).replace(/'s\b/g, "");
    const head = words.replace(/\s+id$/i, "");
    const vars = this.varsMade();
    for (const [name, made] of vars) if (norm(name) === norm(head) && scopeOf(made) === "call") return { expr: this.callResultPath(made, words), label: `${words} (from "${made.name}")`, call: made };
    if (vars.has(camel(words))) return { expr: `$vars.${seg(camel(words))}`, label: `the variable ${camel(words)}` };
    const byName = this.calls().find((c) => norm(c.name).includes(norm(head)));
    if (byName) return { expr: this.callResultPath(byName, words), label: `${words} (from "${byName.name}")`, call: byName };
    const f = this.fieldRef(words);
    return f ? { expr: f.expr, label: f.label } : null;
  }
  answerWith(L: number, n: FlowNode, phrase: string): boolean {
    const r = this.thing(phrase);
    if (!r) { this.fail(L, "respond", `Nothing in this flow produces "${stripArt(phrase)}". Name the call's result ("keep the answer as lead" on the call), then answer with it.`); return true; }
    const key = camel(stripArt(phrase));
    const body = /\bid\b/i.test(phrase) ? `{ ${jstr(key)}: ${r.expr} }` : r.expr;
    this.set(L, n, "body", body); this.ok(L, `"${n.name}" answers with ${r.label}`); return true;
  }
  logLine(L: number, t: string, n: FlowNode): boolean {
    let m: RegExpExecArray | null;
    if ((m = /^(?:log\s+at|level|set\s+the\s+level\s+to)\s+(debug|info|warning|warn|error)$/i.exec(t))) { const lv = /^warn/i.test(m[1]) ? "warn" : lc(m[1]); this.set(L, n, "level", lv); this.ok(L, `"${n.name}" logs at ${lv}`); return true; }
    if ((m = /^(?:change\s+the\s+message\s+to|message|log)\s+"([^"]+)"$/i.exec(t))) { const msg = this.template(m[1]); this.set(L, n, "message", msg); this.ok(L, `"${n.name}" writes "${msg}"`); return true; }
    return false;
  }

  // ------------------------------------------------ structural (any step)
  structural(L: number, t: string, n: FlowNode): boolean {
    let m: RegExpExecArray | null;
    if ((m = /^(after|before)\s+this(?:\s+(?:step|call|node))?\s*,?\s+(.+)$/i.exec(t))) return this.insert(L, n, lc(m[1]) as "after" | "before", m[2]);
    if ((m = /^(?:if|when)\s+this\s+(?:call|step)\s+fails\s*,?\s*(?:answer|respond|reply)\s+(\d{3})(?:\s+with\s+(?:the\s+)?code\s+"?([A-Z][A-Z0-9_]+)"?)?(?:\s+and\s+(?:the\s+)?message\s+"([^"]+)")?$/i.exec(t))) return this.errorPath(L, n, m[1], m[2], m[3]);
    if (/^(?:remove|delete)\s+this(?:\s+(?:step|call|node))?$/i.test(t)) return this.removeStep(L, n);
    if (/^disable\s+this(?:\s+(?:step|call|node))?$/i.test(t)) { if (n.type.startsWith("trigger.")) { this.fail(L, "any", "Switch a start off on the Flows page instead."); return true; } n.disabled = true; this.changes.push({ kind: "set", nodeId: n.id, nodeName: n.name, field: "disabled", before: false, after: true, line: L }); this.link(L, n.id); this.ok(L, `"${n.name}" is switched off (the data passes through it unchanged)`); return true; }
    if (/^enable\s+this(?:\s+(?:step|call|node))?$/i.test(t)) { if (!n.disabled) { this.ok(L, `"${n.name}" is already on`); return true; } delete n.disabled; this.changes.push({ kind: "set", nodeId: n.id, nodeName: n.name, field: "disabled", before: true, after: false, line: L }); this.link(L, n.id); this.ok(L, `"${n.name}" is switched on`); return true; }
    if ((m = /^rename\s+this(?:\s+(?:step|call|node))?\s+to\s+"?(.+?)"?$/i.exec(t))) { const before = n.name; n.name = this.uniqueNameExcept(n, m[1].trim()); this.changes.push({ kind: "set", nodeId: n.id, nodeName: n.name, field: "name", before, after: n.name, line: L }); this.link(L, n.id); this.ok(L, `the step is called "${n.name}"`); return true; }
    return false;
  }
  insert(L: number, n: FlowNode, where: "after" | "before", what: string): boolean {
    let m: RegExpExecArray | null;
    let made: { type: string; name: string; config: Record<string, unknown> } | null = null;
    if ((m = /^log\s+(?:(?:a|an)\s+)?(debug|info|warning|warn|error)?\s*"([^"]+)"$/i.exec(what))) { const msg = this.template(m[2]); const lv = /^warn/i.test(m[1] ?? "") ? "warn" : m[1] ? lc(m[1]) : "info"; made = { type: "log", name: `Log ${msg.replace(/\{\{.*?\}\}/g, "…").slice(0, 30)}`, config: { level: lv, message: msg, includePayload: false } }; }
    else if ((m = /^wait\s+(\d+(?:\.\d+)?)\s*(ms|s|secs?|seconds?)$/i.exec(what))) { const ms = Math.round(secondsOf(m[1], m[2]) * 1000); made = { type: "logic.delay", name: `Wait ${ms} ms`, config: { ms } }; }
    else if ((m = /^(?:answer|respond)\s+(\d{3})(?:\s+with\s+(?:the\s+)?(.+))?$/i.exec(what))) { const r = m[2] ? this.thing(m[2]) : null; if (m[2] && !r) { this.fail(L, "any", `Nothing in this flow produces "${m[2]}".`); return true; } made = { type: "respond", name: `Answer ${m[1]}`, config: { status: m[1], body: r ? r.expr : "$", headers: [] } }; }
    if (!made) { this.fail(L, "any", `"${what}" is not a step this reader can add here. It can add: log "…", wait N seconds, answer STATUS.`); return true; }
    if (where === "after") {
      if (n.type === "respond" && made.type === "respond") { this.fail(L, "any", "Only the first answer reaches the caller."); return true; }
      const outs = this.flow.edges.filter((e) => e.from === n.id && e.fromPort === "out");
      if (!outs.length && !["out"].some((p) => (n.type !== "logic.choice"))) { this.fail(L, "any", `"${n.name}" has no "next" output to put a step after.`); return true; }
      if (n.type === "logic.choice" || n.type === "logic.foreach") { this.fail(L, "any", `"${n.name}" has several outputs; select the step on the path where the new step should go.`); return true; }
      const add = this.addNode(L, made.type, made.name, made.config, n, 110);
      for (const e of outs) e.from = add.id;
      if (made.type !== "respond" || !outs.length) this.edge(n.id, "out", add.id);
      else { this.flow.edges = this.flow.edges.filter((e) => e.from !== add.id); this.edge(n.id, "out", add.id); this.warn(L, "Steps that came after it now follow nothing, because an answer ends the reply; check them."); }
      this.ok(L, `a new step "${add.name}" runs after "${n.name}"`);
    } else {
      if (n.type.startsWith("trigger.")) { this.fail(L, "any", "Nothing can run before the start."); return true; }
      const ins = this.flow.edges.filter((e) => e.to === n.id);
      const add = this.addNode(L, made.type, made.name, made.config, n, -110);
      add.position = { x: n.position.x - 150, y: n.position.y - 120 };
      for (const e of ins) e.to = add.id;
      this.edge(add.id, "out", n.id);
      this.ok(L, `a new step "${add.name}" runs before "${n.name}"`);
    }
    return true;
  }
  errorPath(L: number, n: FlowNode, status: string, code?: string, message?: string): boolean {
    if (scopeOf(n) !== "call" && !["transform.map", "transform.expr", "logic.validate", "flow.call", "postgres.query", "mysql.query", "mssql.query", "redis.command", "xml.convert"].includes(n.type)) { this.fail(L, "any", `"${n.name}" has no "on error" output.`); return true; }
    // keep the flow's own error body shape when it has one
    const shaped = this.flow.nodes.find((x) => x.type === "respond" && /"error"\s*:\s*\{/.test(String(x.config.body ?? "")));
    const corr = this.varsMade().has("correlationId");
    const msg = message ?? (code ? code.toLowerCase().replace(/_/g, " ") : "the call failed");
    const body = `{ "error": { "code": ${jstr(code ?? "ERROR")}, "message": ${jstr(msg)}${shaped && /correlationId/.test(String(shaped.config.body)) && corr ? ", \"correlationId\": $vars.correlationId" : ""} } }`;
    const old = this.flow.edges.filter((e) => e.from === n.id && e.fromPort === "error");
    const same = this.flow.nodes.find((x) => x.type === "respond" && String(x.config.status) === status && (!code || String(x.config.body ?? "").includes(jstr(code))));
    if (same && old.some((e) => e.to === same.id)) { this.ok(L, `when "${n.name}" fails, the caller already gets ${status}${code ? ` ${code}` : ""} ("${same.name}")`); return true; }
    const resp = same ?? this.addNode(L, "respond", `Answer ${status}${code ? ` ${code}` : ""}`, { status, body, headers: corr ? [{ key: "X-Correlation-ID", value: "{{ $vars.correlationId }}" }] : [], contentType: "application/json" }, n, 160);
    if (old.length) { const was = old.map((e) => this.node(e.to)?.name).filter(Boolean).join(", "); this.flow.edges = this.flow.edges.filter((e) => !old.includes(e)); this.warn(L, `"${n.name}" already went to ${was} on error; it now goes to the new answer.`); }
    this.edge(n.id, "error", resp.id);
    if (same) this.link(L, same.id);
    this.changes.push({ kind: "add-path", nodeId: n.id, nodeName: n.name, field: "on error", before: old.length ? old.map((e) => this.node(e.to)?.name) : null, after: resp.name, line: L });
    this.ok(L, `when "${n.name}" fails, the caller gets ${status}${code ? ` ${code}` : ""}${shaped ? " in the flow's error shape" : ""}`);
    return true;
  }
  removeStep(L: number, n: FlowNode): boolean {
    if (n.type.startsWith("trigger.")) { this.fail(L, "any", "The start cannot be removed here; delete the flow or switch it off instead."); return true; }
    const outs = this.flow.edges.filter((e) => e.from === n.id);
    const ports = new Set(outs.map((e) => e.fromPort));
    if ([...ports].some((p) => p !== "out" && p !== "error")) { this.fail(L, "any", `"${n.name}" has several paths after it; remove the steps on those paths first.`); return true; }
    const next = outs.filter((e) => e.fromPort === "out").map((e) => e.to);
    const ins = this.flow.edges.filter((e) => e.to === n.id);
    const errorTargets = outs.filter((e) => e.fromPort === "error").map((e) => this.node(e.to)?.name);
    this.flow.edges = this.flow.edges.filter((e) => e.from !== n.id && e.to !== n.id);
    for (const e of ins) for (const to of next) this.edge(e.from, e.fromPort, to);
    this.flow.nodes = this.flow.nodes.filter((x) => x !== n);
    this.changes.push({ kind: "remove-step", nodeId: n.id, nodeName: n.name, field: "step", before: { type: n.type, name: n.name }, after: null, line: L });
    this.ok(L, `"${n.name}" is removed; the steps before it now go straight to the step after it`);
    if (errorTargets.length) this.warn(L, `Its error path (${errorTargets.join(", ")}) is no longer reached.`);
    const v = n.config.resultTarget === "variable" ? String(n.config.resultVar ?? "") : "";
    if (v && this.flow.nodes.some((x) => jstr(x.config).includes(`$vars.${v}`))) this.warn(L, `Other steps still read $vars.${v}, which this step made.`);
    return true;
  }

  // ------------------------------------------------ issues
  issueLine(L: number, t: string, node?: FlowNode): boolean {
    let m: RegExpExecArray | null;
    // "this returns {} — it should return the lead id"
    if ((m = /\b(?:returns?|answers?|replies|gives?(?:\s+back)?)\s+(?:an?\s+)?(?:\{\s*\}|empty(?:\s+(?:body|object|answer|reply))?|nothing)(?:.*?\bshould\s+(?:return|answer(?:\s+with)?|give(?:\s+back)?)\s+(?:the\s+)?(.+))?$/i.exec(t)) || (m = /\b(?:the\s+)?(?:answer|reply|body|response)\s+is\s+empty(?:.*?\bshould\s+(?:return|answer(?:\s+with)?)\s+(?:the\s+)?(.+))?$/i.exec(t))) {
      const want = m[1] ? m[1].replace(/[.!]+$/, "") : "";
      const responds = node?.type === "respond" ? [node] : this.flow.nodes.filter((x) => x.type === "respond" && !/"error"/.test(String(x.config.body ?? "")));
      const made = this.varsMade();
      const sample = new Set(Object.keys(this.sample()));
      for (const r of responds) {
        const body = String(r.config.body ?? "");
        const unknown = namesRead(body).filter((x) => !sample.has(x));
        const varsUnknown = [...body.matchAll(/\$vars\.(\w+)/g)].map((x) => x[1]).filter((v) => !made.has(v));
        if (!unknown.length && !varsUnknown.length && !want) continue;
        const what = unknown[0] ?? varsUnknown[0];
        const call = this.upstream(r).find((x) => scopeOf(x) === "call");
        if (what) this.diagnoses.push({ line: L, text: `"${r.name}" reads ${unknown.length ? `"${what}"` : `$vars.${what}`}, which no step before it produces, so the answer is empty.${call ? ` The call before it, "${call.name}", keeps its answer as ${String(call.config.resultVar ?? "the data")}.` : ""}` });
        const target = want ? this.thing(want) : call ? { expr: this.callResultPath(call), label: `the answer of "${call.name}"` } : null;
        if (!target) { this.fail(L, "issue", `The reason was found (${what ? `"${what}" is never produced` : "no call result is answered"}), but not what the answer should contain. Add "it should return THING".`); return true; }
        const key = want && /\bid\b/i.test(want) ? camel(stripArt(want)) : "";
        this.set(L, r, "body", key ? `{ ${jstr(key)}: ${target.expr} }` : target.expr);
        this.ok(L, what ? `diagnosis: an undefined reference; "${r.name}" now answers with ${target.label}` : `no undefined name was found in "${r.name}"; it now answers with ${target.label}, as asked`);
        return true;
      }
      this.fail(L, "issue", "No answer of this flow reads a name that nothing produces, so the cause is not one this reader knows. Say what it should return: \"it should return the lead id\".");
      return true;
    }
    const call = node && scopeOf(node) === "call" ? node : this.calls().find((c) => /zoho/i.test(c.name) || /\/crm\/v\d+\//.test(String(c.config.url ?? ""))) ?? this.calls()[0];
    const conn = this.connectionOf(call);
    if (/\b401\b|invalid[_ ]token|unauthori[sz]ed/i.test(t) && /zoho|crm|token|401/i.test(t)) {
      if (!conn) { this.fail(L, "issue", "The call that answers 401 has no connection this reader can look at. Select the call or its connection."); return true; }
      const c = conn.config;
      const clash = zohoMismatch(String(c.tokenUrl ?? ""), String(c.baseUrl ?? ""));
      if (clash) {
        const api = zohoApiFor(String(c.tokenUrl));
        this.diagnoses.push({ line: L, text: clash, lesson: "L7.zoho-dc-mismatch" });
        this.patchConnection(L, conn, { baseUrl: api });
        this.ok(L, `diagnosis: the token and the API are in different Zoho data centres; the base URL of "${conn.name}" follows the token address (${api}). If the org is in the other centre, write "use the … data centre" on the connection instead.`);
        return true;
      }
      if (c.authType === "oauth2refresh" && !/zoho-oauthtoken/i.test(String(c.tokenPrefix ?? ""))) {
        this.diagnoses.push({ line: L, text: `"${conn.name}" sends "Authorization: ${String(c.tokenPrefix || "Bearer")} …"; Zoho expects "Zoho-oauthtoken".`, lesson: "L7.zoho-auth-prefix" });
        this.patchConnection(L, conn, { tokenPrefix: "Zoho-oauthtoken" });
        this.ok(L, `diagnosis: the wrong Authorization prefix; "${conn.name}" now sends Zoho-oauthtoken`); return true;
      }
      if (c.authType !== "oauth2refresh") {
        this.diagnoses.push({ line: L, text: `"${conn.name}" signs in with "${String(c.authType ?? "none")}"; a Zoho access token expires after an hour unless it is refreshed.`, lesson: "L7.zoho-auth-prefix" });
        const preset = zohoCentre(String(c.baseUrl ?? "")) ? { authType: "oauth2refresh", tokenUrl: zohoTokenUrlFor(String(c.baseUrl)), tokenPrefix: "Zoho-oauthtoken", clientAuth: "body" } : { authType: "oauth2refresh" };
        this.patchConnection(L, conn, preset);
        this.ok(L, `diagnosis: no token refresh; "${conn.name}" switches to the refresh-token sign-in`);
        this.warn(L, "Enter the client id, client secret and refresh token on the connection after applying (they are never filled in here).");
        return true;
      }
      this.diagnoses.push({ line: L, text: `The data centres match and "${conn.name}" uses the refresh-token sign-in with Zoho-oauthtoken. A 401 then usually means the refresh token was revoked or belongs to another org: run Test connection, which shows Zoho's error code.` });
      this.ok(L, "diagnosis only: nothing to change in the flow"); this.warn(L, "Run Test connection on the connection to see Zoho's error code.");
      return true;
    }
    if (/invalid[_ ]data|rejects?\s+(?:the\s+)?record|empty\s+strings?/i.test(t)) {
      const body = String(jstr(call?.config.body ?? ""));
      const rv = /\$vars\.(\w+)/.exec(body)?.[1];
      const map = rv ? this.flow.nodes.find((x) => x.type === "transform.map" && x.config.resultVar === rv) : node?.type === "transform.map" ? node : undefined;
      if (!map) { this.fail(L, "issue", "No mapping step builds what the call sends, so empty fields cannot be left out here."); return true; }
      this.diagnoses.push({ line: L, text: `"${map.name}" can send "" for fields that are empty; Zoho rejects "" for number, picklist and currency fields.`, lesson: "L7.zoho-empty-string" });
      const before = this.changes.length;
      this.mapLine(L, "drop empty fields", map);
      if (this.changes.length === before) this.ok(L, "every field is already left out when empty; an INVALID_DATA then points at a value Zoho does not allow (a picklist value or a currency code)");
      return true;
    }
    if (/invalid[_ ]client|client\s*id.*secret.*(?:swapped|mixed|wrong)|swapped/i.test(t)) {
      this.diagnoses.push({ line: L, text: `Zoho answers invalid_client when the client id and secret are swapped, mistyped, or from another data centre${conn ? ` (connection "${conn.name}")` : ""}. Secrets are never shown here: open the connection, paste the client id and the client secret again (only the values, without labels), then Test connection.` });
      this.ok(L, "diagnosis only: secrets are entered on the connection"); this.warn(L, "Nothing in the flow is changed for this line.");
      return true;
    }
    if (/second\s+(?:lead|record)|duplicat|twice/i.test(t) && call) {
      const url = String(call.config.url ?? "");
      const mm = /^(.*\/crm\/v\d+\/\w+)\/?$/.exec(url);
      if (!mm) { this.ok(L, `"${call.name}" already goes to ${url}`); this.warn(L, "Check that the record's Email (or another unique field) is in duplicate_check_fields."); return true; }
      this.diagnoses.push({ line: L, text: `"${call.name}" inserts (POST ${url}); a repeat creates a second record.`, lesson: "L7.zoho-insert-not-upsert" });
      this.set(L, call, "url", `${mm[1]}/upsert`);
      const b = call.config.body;
      if (b && typeof b === "object" && !Array.isArray(b) && !(b as Record<string, unknown>).duplicate_check_fields) this.set(L, call, "body", { ...(b as Record<string, unknown>), duplicate_check_fields: ["Email"] });
      this.ok(L, `diagnosis: insert instead of upsert; "${call.name}" now upserts with the Email duplicate check`);
      return true;
    }
    return false;
  }
  patchConnection(L: number, conn: FullConnection, patch: Record<string, unknown>) {
    const cur = this.connection ?? { id: conn.id, name: conn.name, before: clone(conn.config), after: clone(conn.config) };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && jstr(cur.after[k]) !== jstr(v)) {
      this.changes.push({ kind: "connection", field: `${conn.name}.${k}`, before: cur.after[k] ?? null, after: v, line: L });
      cur.after[k] = v;
    }
    this.connection = cur;
  }

  // ------------------------------------------------ a connection
  connectionLine(L: number, t: string, id: string) {
    const conn = (this.ctx.fullConnections ?? []).find((c) => c.id === id);
    if (!conn) return this.fail(L, "connection", "The selected connection no longer exists.");
    let m: RegExpExecArray | null;
    const centres: Record<string, string> = { india: "accounts.zoho.in", indian: "accounts.zoho.in", saudi: "accounts.zoho.sa", "saudi arabia": "accounts.zoho.sa", us: "accounts.zoho.com", "united states": "accounts.zoho.com", europe: "accounts.zoho.eu", eu: "accounts.zoho.eu", australia: "accounts.zoho.com.au", japan: "accounts.zoho.jp", china: "accounts.zoho.com.cn", canada: "accounts.zohocloud.ca" };
    if ((m = /^use\s+the\s+([a-z ]+?)\s+(?:zoho\s+)?data\s+cent(?:re|er)$/i.exec(t))) {
      const host = centres[lc(m[1]).trim()];
      if (!host) return this.fail(L, "connection", `"${m[1]}" is not a Zoho data centre this reader knows (India, Saudi, US, Europe, Australia, Japan, China, Canada).`);
      this.patchConnection(L, conn, { baseUrl: zohoApiFor(`https://${host}`), tokenUrl: `https://${host}/oauth/v2/token` });
      this.ok(L, `"${conn.name}" uses the ${zohoCentre(`https://${host}`)!.label} data centre for both the token and the API`);
      if (conn.config.authType === "oauth2refresh") this.warn(L, "A refresh token is issued per data centre: enter one from this centre on the connection.");
      return;
    }
    if ((m = /^base\s*url\s+(?:to\s+)?(https?:\/\/\S+)$/i.exec(t))) { this.patchConnection(L, conn, { baseUrl: m[1].replace(/\/+$/, "") }); this.ok(L, `base URL ${m[1]}`); this.mismatchWarn(L); return; }
    if ((m = /^token\s*url\s+(?:to\s+)?(https?:\/\/\S+)$/i.exec(t))) { this.patchConnection(L, conn, { tokenUrl: m[1] }); this.ok(L, `token address ${m[1]}`); this.mismatchWarn(L); return; }
    if ((m = /^(?:token\s+prefix|authorization\s+prefix)\s+(?:to\s+)?"?([\w-]+)"?$/i.exec(t))) { this.patchConnection(L, conn, { tokenPrefix: m[1] }); this.ok(L, `Authorization: ${m[1]} …`); return; }
    if ((m = /^scopes?\s+(?:to\s+)?(.+)$/i.exec(t))) { this.patchConnection(L, conn, { scope: m[1].trim() }); this.ok(L, `scope ${m[1].trim()}`); return; }
    if ((m = /^send\s+(?:the\s+)?client\s+credentials\s+(?:as|in)\s+(?:a\s+|the\s+)?(form\s+body|body|basic(?:\s+header)?)$/i.exec(t))) { const v = /basic/i.test(m[1]) ? "basic" : "body"; this.patchConnection(L, conn, { clientAuth: v }); this.ok(L, `client credentials go in the ${v === "basic" ? "Basic header" : "form body"}`); return; }
    if (/^use\s+(?:the\s+)?refresh[\s-]token\s+sign[\s-]?in$/i.test(t)) {
      const base = String(conn.config.baseUrl ?? "");
      this.patchConnection(L, conn, { authType: "oauth2refresh", ...(zohoCentre(base) ? { tokenUrl: zohoTokenUrlFor(base), tokenPrefix: "Zoho-oauthtoken", clientAuth: "body" } : {}) });
      this.ok(L, `"${conn.name}" signs in with a refresh token${zohoCentre(base) ? " (Zoho settings for its data centre)" : ""}`); this.warn(L, "Enter the client id, client secret and refresh token on the connection after applying."); return;
    }
    if ((m = /^time\s*out\s+(?:after\s+)?(\d+(?:\.\d+)?)\s*(ms|s|secs?|seconds?)$/i.exec(t))) { const ms = Math.round(secondsOf(m[1], m[2]) * 1000); this.patchConnection(L, conn, { timeoutMs: ms }); this.ok(L, `calls on "${conn.name}" give up after ${ms} ms unless a step says otherwise`); return; }
    if (/^(?:verify|check)\s+(?:the\s+)?tls(?:\s+certificate)?$/i.test(t)) { this.patchConnection(L, conn, { tlsVerify: true }); this.ok(L, "the TLS certificate is verified"); return; }
    if (/^(?:do not|don't)\s+(?:verify|check)\s+(?:the\s+)?tls/i.test(t)) { this.patchConnection(L, conn, { tlsVerify: false }); this.ok(L, "the TLS certificate is not verified"); this.warn(L, lessonMessage("L8.tls-disabled", conn.name)); return; }
    this.fail(L, "connection");
  }
  mismatchWarn(L: number) { const c = this.connection?.after; const x = c ? zohoMismatch(String(c.tokenUrl ?? ""), String(c.baseUrl ?? "")) : null; if (x) this.warn(L, x); }
}

/** Zoho checks of lesson L7 on the changed flow and its connections (the runtime validator covers L1-L4). */
export function zohoLessons(flow: Flow, connections: FullConnection[]): EditResult["lessonWarnings"] {
  const out: EditResult["lessonWarnings"] = [];
  for (const n of flow.nodes) {
    if (scopeOf(n) !== "call") continue;
    const conn = connections.find((c) => c.id === n.config.connection);
    const base = String(conn?.config.baseUrl ?? n.config.url ?? "");
    if (!zohoCentre(base) && !/zohoapis/i.test(base)) continue;
    const c = conn?.config ?? {};
    const clash = zohoMismatch(String(c.tokenUrl ?? ""), base);
    if (clash) out.push({ nodeId: n.id, lesson: "L7.zoho-dc-mismatch", message: lessonMessage("L7.zoho-dc-mismatch", n.name, clash) });
    if (c.authType === "oauth2refresh" && !/zoho-oauthtoken/i.test(String(c.tokenPrefix ?? ""))) out.push({ nodeId: n.id, lesson: "L7.zoho-auth-prefix", message: lessonMessage("L7.zoho-auth-prefix", n.name) });
    if (/\/crm\/v\d+\/\w+\/?$/.test(String(n.config.url ?? "")) && String(n.config.method ?? "").toUpperCase() === "POST") out.push({ nodeId: n.id, lesson: "L7.zoho-insert-not-upsert", message: lessonMessage("L7.zoho-insert-not-upsert", n.name) });
    const rv = /\$vars\.(\w+)/.exec(jstr(n.config.body ?? ""))?.[1];
    const map = rv ? flow.nodes.find((x) => x.type === "transform.map" && x.config.resultVar === rv) : undefined;
    const rules = ((map?.config.mapping as { rules?: MappingRule[] } | undefined)?.rules ?? []).filter((r) => r.enabled !== false);
    const unguarded = rules.filter((r) => (r.kind === "direct" || (r.kind === "expr" && !/^["\d[{]|^(?:true|false|null)$/.test((r.expr ?? "").trim()))) && !/!= "" \?|\$x != ""/.test(r.expr ?? "") && !/\$vars\.\w+ForTarget|\$lookup|\$uuid/.test(r.expr ?? ""));
    if (map && unguarded.length) out.push({ nodeId: map.id, lesson: "L7.zoho-empty-string", message: lessonMessage("L7.zoho-empty-string", map.name, `${unguarded.map((r) => r.target).slice(0, 6).join(", ")} may be sent as ""`) });
  }
  return out;
}

/** Reads the lines and returns the changed flow (a copy) with every change, line by line. */
export function editFlow(flow: Flow, target: EditTarget, text: string, ctx: EditContext = {}): EditResult {
  const ed = new Editor(flow, target, ctx);
  const raw = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  raw.forEach((r, i) => {
    const L = i + 1;
    const t = r.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, "").replace(/[.;]\s*$/, "").replace(/[“”]/g, "\"").replace(/[‘’]/g, "'").trim();
    ed.lines.set(L, { line: L, text: t, status: "ignored", nodeIds: [] });
    if (!t || /^(?:#|\/\/)/.test(t)) return;
    ed.line(L, t);
  });
  const lines = [...ed.lines.values()];
  const conns = (ctx.fullConnections ?? []).map((c) => (ed.connection && c.id === ed.connection.id ? { ...c, config: ed.connection.after } : c));
  return {
    target, flow: ed.flow, ...(ed.connection ? { connection: ed.connection } : {}), lines, changes: ed.changes, missing: ed.missing, instructions: ed.instructions,
    diagnoses: ed.diagnoses, lessonWarnings: (() => { const was = new Set(zohoLessons(flow, ctx.fullConnections ?? []).map((w) => `${w.lesson}|${w.nodeId}`)); return zohoLessons(ed.flow, conns).map((w) => ({ ...w, new: !was.has(`${w.lesson}|${w.nodeId}`) })); })(),
    ok: lines.every((l) => l.status !== "not-understood") && lines.some((l) => l.status === "ok" || l.status === "warning"),
  };
}
