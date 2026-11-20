// "Describe the flow": a requirement written in your own words, one step per line, turned into a draft
// flow by FIXED rules on this server. Nothing here calls a model or any other service. Every line is
// either understood (and linked to the steps it made) or reported as not understood with the closest
// phrasings that are; nothing is guessed silently. STEP_PHRASES is the "What you can write" list: the
// tests read every example, so the list can never promise more than the reader does.
import type { ConnectorDef, ConnectorOperation, FlowEdge, FlowNode, MappingRule } from "./types.js";
import { LESSON_DEFAULTS } from "./lessons.js";

export interface StepPhrase { group: string; phrase: string; example: string; makes: string; }

export const STEP_PHRASES: StepPhrase[] = [
  { group: "Start", phrase: "When METHOD /path arrives", example: "When POST /guests/check arrives", makes: "HTTP Listener" },
  { group: "Start", phrase: "When GET /path/:id is called", example: "When GET /bookings/:id is called", makes: "HTTP Listener with a path parameter" },
  { group: "Start", phrase: "Every N seconds | minutes | hours | days", example: "Every 15 minutes", makes: "Schedule" },
  { group: "Start", phrase: "Every day at HH:MM | Every monday at HH:MM", example: "Every day at 06:30", makes: "Schedule (cron)" },
  { group: "Start", phrase: "On schedule \"CRON\"", example: "On schedule \"*/5 * * * *\"", makes: "Schedule (cron)" },
  { group: "Start", phrase: "When a message arrives on queue | topic NAME", example: "When a message arrives on queue guest-updates", makes: "Manual start (this server has no queue listener yet; the line says so)" },
  { group: "Start", phrase: "When started manually | When called by another flow", example: "When called by another flow", makes: "Manual / Sub-flow start" },

  { group: "Call a system", phrase: "Look up | Find | Get the THING in SYSTEM by FIELD", example: "Look up the contact in Zoho by email", makes: "Connector step or HTTP Request (GET); the answer is kept as the THING" },
  { group: "Call a system", phrase: "Create | Add the THING in SYSTEM with FIELD, FIELD", example: "Create the contact in Zoho with first name, last name, email", makes: "Connector step or HTTP Request (POST)" },
  { group: "Call a system", phrase: "Update the THING in SYSTEM with FIELD", example: "Update the contact in Zoho with phone", makes: "Connector step or HTTP Request (PUT)" },
  { group: "Call a system", phrase: "Delete the THING in SYSTEM by FIELD", example: "Delete the contact in Zoho by contact id", makes: "Connector step or HTTP Request (DELETE)" },
  { group: "Call a system", phrase: "Call SYSTEM OPERATION [with FIELD, FIELD]", example: "Call Zoho searchContacts with email", makes: "The operation of a connector or of a migrated API" },
  { group: "Call a system", phrase: "Call METHOD /path on CONNECTION [with FIELD]", example: "Call GET /reference/ships on sample-system-api", makes: "HTTP Request on that connection" },
  { group: "Call a system", phrase: "Call METHOD https://address", example: "Call GET https://status.example.invalid/health", makes: "HTTP Request to a full address" },
  { group: "Call a system", phrase: "Run flow NAME", example: "Run flow Leads", makes: "Call Flow" },

  { group: "Database", phrase: "Insert into table T in database D with FIELD, FIELD", example: "Insert into table guests in database crm with first name, last name, email", makes: "Database step: INSERT with parameters" },
  { group: "Database", phrase: "Find the THING in table T in database D by FIELD", example: "Find the guest in table guests in database crm by email", makes: "Database step: SELECT, first row" },
  { group: "Database", phrase: "Read all rows from table T in database D [where FIELD is VALUE]", example: "Read all rows from table bookings in database crm where status is \"open\"", makes: "Database step: SELECT, all rows" },
  { group: "Database", phrase: "Update table T in database D set FIELD, FIELD by FIELD", example: "Update table guests in database crm set phone by email", makes: "Database step: UPDATE" },
  { group: "Database", phrase: "Delete from table T in database D by FIELD", example: "Delete from table sessions in database crm by session id", makes: "Database step: DELETE" },
  { group: "Database", phrase: "Run procedure P in database D with FIELD, FIELD", example: "Run procedure merge_guest in database crm with email, last name", makes: "Database step: stored procedure (MySQL, SQL Server) or CALL (Postgres)" },
  { group: "Database", phrase: "Run SQL \"STATEMENT\" on database D", example: "Run SQL \"select count(*) as n from guests\" on database crm", makes: "Database step with your SQL" },

  { group: "Conditions", phrase: "If CONDITION, STEP", example: "If not found, create the contact in Zoho with first name, last name, email", makes: "Choice: the step runs only when the condition holds; the flow then carries on" },
  { group: "Conditions", phrase: "If CONDITION then STEP otherwise STEP", example: "If the status is \"VIP\" then log \"vip guest\" otherwise log \"regular guest\"", makes: "Choice with both paths" },
  { group: "Conditions", phrase: "If CONDITION: … Otherwise: … (indented steps, nesting allowed)", example: "If the age is at least 18:\n  Answer 200 with the contact\nOtherwise:\n  Answer 403 with message \"too young\"", makes: "Choice whose paths hold several steps" },
  { group: "Conditions", phrase: "Otherwise if CONDITION, STEP", example: "If the country is \"US\", log \"us guest\"\nOtherwise if the country is \"CA\", log \"ca guest\"", makes: "One more path on the same Choice" },
  { group: "Conditions", phrase: "Conditions: not found · found · FIELD is \"X\" · is not · is empty · is not empty · contains · starts with · ends with · is greater than N · is less than N · is at least N · is at most N · is between N and M · is one of \"A\", \"B\" · is true · and · or", example: "If the email ends with \".invalid\" and the age is greater than 17, log \"test adult\"", makes: "A JSONata condition shown under \"Understood as\"" },

  { group: "Loops", phrase: "For each ITEM in LIST: (indented steps)", example: "For each line in the order lines:\n  Log \"line {line sku}\"", makes: "For Each; inside it ITEM means the current entry" },
  { group: "Loops", phrase: "For each ITEM in LIST, STEP", example: "For each guest in the guests, log \"guest {guest email}\"", makes: "For Each with one step" },

  { group: "Data", phrase: "Map: TARGET from WORDS (one line per field; every mapper phrase works)", example: "Map: fullName from join first name and last name with a space", makes: "Transform (Map); consecutive Map lines make one step" },
  { group: "Data", phrase: "Map: TARGET from FIELD", example: "Map: contactId from the contact id", makes: "A mapping rule that copies the field" },
  { group: "Data", phrase: "Set VARIABLE to VALUE", example: "Set source to \"web\"", makes: "Set Variables" },
  { group: "Data", phrase: "Remember FIELD as VARIABLE", example: "Remember the email as guestEmail", makes: "Set Variables" },
  { group: "Data", phrase: "Convert the XML to JSON | Convert to XML", example: "Convert the XML to JSON", makes: "XML <-> JSON" },

  { group: "Log", phrase: "Log \"TEXT\"", example: "Log \"guest checked\"", makes: "Logger" },
  { group: "Log", phrase: "Log \"TEXT {FIELD}\"", example: "Log \"guest {email} checked\"", makes: "Logger with {{ }} values" },
  { group: "Log", phrase: "Log FIELD | Log a warning \"TEXT\"", example: "Log a warning \"contact missing\"", makes: "Logger at that level" },

  { group: "Errors and retries", phrase: "If the call fails, STEP", example: "If the call fails, answer 502 with the error", makes: "The step is wired to the On error output of the call above" },
  { group: "Errors and retries", phrase: "Retry N times [waiting S seconds]", example: "Retry 3 times waiting 2 seconds", makes: "Retries on the call above" },
  { group: "Errors and retries", phrase: "Time out after N seconds", example: "Time out after 10 seconds", makes: "Timeout on the call above" },
  { group: "Speed and side effects", phrase: "Send it in the background | Don't wait for it", example: "Send the e-mail in the background", makes: "The call above runs after the flow goes on (Send in background); retried on connection failures, a failure is logged as an error" },
  { group: "Speed and side effects", phrase: "Cache the answer for N seconds | minutes", example: "Cache the answer for 60 seconds", makes: "The read above keeps its answer that long and shares identical calls (GET only)" },
  { group: "Speed and side effects", phrase: "Share identical calls", example: "Share identical calls", makes: "Identical reads that run at the same time share one backend call (GET only)" },
  { group: "Speed and side effects", phrase: "Reuse the session [for N minutes] | Log in once", example: "Reuse the session for 4 minutes", makes: "The login/token call above is made once and its answer reused until it expires or the backend answers 401/403" },
  { group: "Errors and retries", phrase: "Require FIELD[, FIELD]", example: "Require email and last name", makes: "Validate: answers 400 when one is missing" },
  { group: "Errors and retries", phrase: "Reject with STATUS if CONDITION", example: "Reject with 422 if the age is less than 18", makes: "Validate" },
  { group: "Errors and retries", phrase: "Fail with STATUS \"MESSAGE\" | Stop", example: "Fail with 409 \"already checked in\"", makes: "Stop / Raise Error" },

  { group: "Answer", phrase: "Answer STATUS with FIELD", example: "Answer 201 with the contact id", makes: "Respond with { \"contactId\": … }" },
  { group: "Answer", phrase: "Answer STATUS with THING", example: "Answer 200 with the contact", makes: "Respond with the whole THING" },
  { group: "Answer", phrase: "Answer STATUS with message \"TEXT\"", example: "Answer 404 with message \"guest not found\"", makes: "Respond with { \"message\": … }" },
  { group: "Answer", phrase: "Answer STATUS with {JSON}", example: "Answer 200 with {\"ok\": true}", makes: "Respond with that JSON" },

  { group: "Other", phrase: "Wait N seconds", example: "Wait 2 seconds", makes: "Delay" },
  { group: "Other", phrase: "A first line ending in \":\" names the flow", example: "Guest check-in:", makes: "The flow name" },
  { group: "Other", phrase: "Lines may be numbered or bulleted; # or // lines are comments", example: "1. When POST /guests/check arrives\n2. Log \"guest checked\"", makes: "" },
];

// ---------------------------------------------------------------- context and result
/** authType and baseUrl are non-secret settings, used to tell whether a connection fits. */
export interface DescribeConnection { id: string; name: string; type: string; authType?: string; baseUrl?: string; }
export interface DescribeApiOperation { id: string; method: string; path: string; summary?: string; }
/** A migrated API from the estate catalogue. */
export interface DescribeApi { name: string; basePath?: string; baseUrl?: string; operations?: DescribeApiOperation[]; }
export interface DescribeFlowRef { id: string; name: string; slug?: string; }
export interface DescribeContext {
  connections?: DescribeConnection[];
  connectors?: ConnectorDef[];
  apis?: DescribeApi[];
  flows?: DescribeFlowRef[];
}
export interface DescribeOptions {
  /** A condition the built-in rules do not read, tried with the mapping phrase engine. Must be local and synchronous. */
  compileCondition?: (words: string) => { expr: string; explanation: string } | null;
  /** A value the built-in rules do not read ("Set x to …"), tried with the mapping phrase engine. */
  compileValue?: (words: string) => { expr: string; explanation: string } | null;
  /** Steps to add to an existing canvas: no start is invented; `entry` lists the first steps. */
  attach?: boolean;
}
export interface PhraseHint { phrase: string; example: string; }
export interface DescribeLine {
  line: number;                    // 1-based, in the text as written
  text: string;                    // the line without its numbering or bullet
  status: "ok" | "warning" | "not-understood" | "ignored";
  role?: "header" | "comment" | "step" | "block";
  nodeIds: string[];               // the steps this line made or changed
  understood?: string;             // plain words: what was understood
  message?: string;                // why it is a warning / not understood
  suggestions?: PhraseHint[];      // not understood: the 3 closest supported phrasings
}
export interface MissingConnection {
  key: string; name: string;
  type: string;                    // connection type to create: "http" | "mysql" | "mssql" | "postgres"
  lines: number[]; nodeIds: string[];
  why: string;
  suggested?: { baseUrl?: string; config?: Record<string, unknown> };
  existingId?: string;             // the connection exists but does not fit: offer to edit it
}
export interface DescribedFlow { name: string; description?: string; nodes: FlowNode[]; edges: FlowEdge[]; settings?: Record<string, unknown>; }
export interface DescribeResult {
  flow: DescribedFlow;
  lines: DescribeLine[];
  missing: MissingConnection[];
  /** Instruction rules inside Map steps, so a caller can check them with the full interpreter. */
  instructions: { nodeId: string; ruleId: string; line: number; instruction: string }[];
  notes: string[];
  ok: boolean;                     // every line understood (warnings allowed)
  entry: string[];                 // attach: the steps that come first (to connect after a step on the canvas)
}

// ---------------------------------------------------------------- small text helpers
const lc = (s: string) => s.toLowerCase();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMWORDS: Record<string, number> = { a: 1, an: 1, one: 1, once: 1, two: 2, twice: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, sixty: 60 };
const numOf = (s: string | undefined): number | null => {
  if (s === undefined || s === "") return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const n = NUMWORDS[lc(s)];
  return n === undefined ? null : n;
};
function maskQuotes(s: string): string {
  let out = "", q = false;
  for (let i = 0; i < s.length; i++) { const ch = s[i]; if (ch === "\"") { q = !q; out += ch; } else out += q ? "\u0001" : ch; }
  return out;
}
/** Splits at every match of `re` that is not inside double quotes. */
function splitOutside(s: string, re: RegExp): string[] {
  const m = maskQuotes(s);
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const parts: string[] = [];
  let last = 0;
  for (const x of m.matchAll(g)) { if (x[0].length === 0) continue; parts.push(s.slice(last, x.index)); last = (x.index ?? 0) + x[0].length; }
  parts.push(s.slice(last));
  return parts;
}
/** First match of `re` outside quotes: [before, after] or null. */
function cutOutside(s: string, re: RegExp): [string, string, RegExpExecArray] | null {
  const m = maskQuotes(s);
  const x = new RegExp(re.source, re.flags.replace("g", "")).exec(m);
  if (!x) return null;
  return [s.slice(0, x.index), s.slice(x.index + x[0].length), x];
}
const ARTICLES = /^(?:the|a|an|its|their|this|that|these|those|all|every)\s+/i;
function stripArticles(s: string): string { let t = s.trim(); while (ARTICLES.test(t)) t = t.replace(ARTICLES, ""); return t.trim(); }
function singular(w: string): string {
  if (/ies$/i.test(w) && w.length > 4) return w.slice(0, -3) + "y";
  if (/(ss|us|is)$/i.test(w)) return w;
  if (/(ches|shes|xes)$/i.test(w)) return w.slice(0, -2);
  if (/s$/i.test(w) && w.length > 3) return w.slice(0, -1);
  return w;
}
function camel(words: string[]): string {
  return words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join("");
}
const snake = (words: string[]) => words.map((w) => w.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()).join("_");
/** "firstName" / "first_name" / "first name" -> ["first", "name"] */
function tokens(s: string): string[] {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => singular(w.toLowerCase()));
}
const seg = (k: string) => (IDENT.test(k) ? k : "`" + k.replace(/`/g, "") + "`");
const jstr = (s: string) => JSON.stringify(s);
const unquote = (s: string) => { const t = s.trim(); return /^"[^"]*"$/.test(t) ? t.slice(1, -1) : null; };
const short = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Words of the mapping phrases themselves: what is left of an instruction are the field names it reads,
// used only to build a made-up sample so the mapping phrase engine can tell which field is meant.
const MAP_WORDS = new Set(("join and with a an the space spaces upper lower case capitals capital uppercase lowercase in of to from if then otherwise else is are not empty contains "
  + "starts start ends end greater less than at least most between one add before after prefix suffix without round rounded decimals decimal places number numbers text date "
  + "format as letters letter digits digit characters character trim remove replace by default or count sum total each item items list only where today now years year days day "
  + "yes no true false title words word put copy use take make value it for every all unique sorted sort keep convert into plus minus times divided give gives "
  + "separator comma dash underscore dot slash part split first_ last_ upto up").split(" "));
function candidateFields(words: string): string[] {
  const out: string[] = [];
  const clean = words.replace(/"[^"]*"/g, " ").replace(/\([^)]*\)/g, (m) => " " + m.slice(1, -1) + " ");
  for (const dotted of clean.match(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b/g) ?? []) out.push(dotted);
  const run: string[] = [];
  const flush = () => { if (run.length && run.length <= 3) out.push(run.length === 1 ? run[0] : camel(run.map(lc))); run.length = 0; };
  for (const w of clean.replace(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b/g, " ").split(/[^A-Za-z0-9_]+/)) {
    if (!w || /^\d+$/.test(w) || MAP_WORDS.has(lc(w))) { flush(); continue; }
    run.push(w);
  }
  flush();
  return [...new Set(out)];
}
function sampleValue(f: string): unknown {
  const k = lc(f.split(".").pop() ?? f);
  return /email/.test(k) ? "jane.doe@example.invalid" : /first/.test(k) ? "Jane" : /last|surname/.test(k) ? "Doe" : /phone/.test(k) ? "+10000000000" : /(age|qty|quantity|count|amount|total|number|price)$/.test(k) ? 30 : /id$/.test(k) ? "1" : /date/.test(k) ? "2026-01-31" : "sample";
}
function setPath(o: Record<string, unknown>, path: string, v: unknown) {
  const parts = path.split(".");
  let cur = o;
  for (const p of parts.slice(0, -1)) { if (!cur[p] || typeof cur[p] !== "object") cur[p] = {}; cur = cur[p] as Record<string, unknown>; }
  const last = parts[parts.length - 1];
  if (cur[last] === undefined) cur[last] = v;
}

// ---------------------------------------------------------------- suggestions
function similarity(a: string, b: string): number {
  const ta = new Set(tokens(a).filter((w) => w.length > 1)), tb = new Set(tokens(b).filter((w) => w.length > 1));
  if (!ta.size || !tb.size) return 0;
  let both = 0; for (const w of ta) if (tb.has(w)) both++;
  let score = (2 * both) / (ta.size + tb.size);
  const fa = tokens(a)[0], fb = tokens(b)[0];
  if (fa && fb && fa === fb) score += 0.35;
  return score;
}
/** The 3 supported phrasings closest to a line. */
export function closestPhrases(text: string, n = 3): PhraseHint[] {
  const scored = STEP_PHRASES.filter((p) => p.group !== "Other")
    .map((p) => ({ p, s: Math.max(similarity(text, p.example.split("\n")[0]), similarity(text, p.phrase)) }))
    .sort((x, y) => y.s - x.s);
  return scored.slice(0, n).map(({ p }) => ({ phrase: p.phrase, example: p.example }));
}

// ---------------------------------------------------------------- lines
interface Item { line: number; indent: number; text: string; }
const BULLET = /^(?:[-*•▪◦·‣]\s+|\(?\d+(?:\.\d+)*[.)]\s+|\d+(?:\.\d+)+\s+|[a-z][.)]\s+(?=[A-Z])|step\s+\d+\s*[:.)-]\s*)/i;
function cleanLine(raw: string): { indent: number; text: string } {
  const expanded = raw.replace(/\t/g, "    ");
  const indent = expanded.length - expanded.trimStart().length;
  let t = expanded.trim().replace(/[“”„]/g, "\"").replace(/[‘’]/g, "'");
  let guard = 0;
  while (BULLET.test(t) && guard++ < 3) t = t.replace(BULLET, "");
  t = t.trim();
  if (!/\.\.\.$/.test(t) && !/\d\.$/.test(t.slice(-3)) && !/"\s*\.$/.test(t)) t = t.replace(/[.;]\s*$/, "");
  else if (/"\s*\.$/.test(t)) t = t.replace(/\.\s*$/, "");
  return { indent, text: t.trim() };
}

// ---------------------------------------------------------------- the reader
interface Tail { id: string; port: string; }
interface Ref { expr: string; key: string; label: string; payloadPath?: string; whole?: boolean; words?: string[]; }
interface Outcome { tails: Tail[]; next: number; terminal?: boolean; }
const DB_TYPES = ["mysql", "mssql", "postgres"];
const DB_NODE: Record<string, string> = { mysql: "mysql.query", mssql: "mssql.query", postgres: "postgres.query" };
const DB_LABEL: Record<string, string> = { mysql: "MySQL", mssql: "SQL Server", postgres: "Postgres" };
const READ_WORDS = ["get", "find", "search", "lookup", "look", "list", "fetch", "read", "load", "retrieve", "query", "check"];
const CREATE_WORDS = ["create", "add", "post", "insert", "new", "register", "save", "submit", "send"];
const UPDATE_WORDS = ["update", "put", "patch", "change", "edit", "modify", "upsert"];
const DELETE_WORDS = ["delete", "remove", "cancel"];
type VerbKind = "read" | "create" | "update" | "delete" | "call";
const VERB_METHOD: Record<VerbKind, string> = { read: "GET", create: "POST", update: "PUT", delete: "DELETE", call: "POST" };
const VERB_WORDS: Record<VerbKind, string[]> = { read: READ_WORDS, create: CREATE_WORDS, update: UPDATE_WORDS, delete: DELETE_WORDS, call: [] };
const STATUS_WORDS: [RegExp, number][] = [[/^ok$/i, 200], [/^created$/i, 201], [/^accepted$/i, 202], [/^no content$/i, 204], [/^bad request$/i, 400], [/^unauthori[sz]ed$/i, 401], [/^forbidden$/i, 403], [/^not found$/i, 404], [/^conflict$/i, 409], [/^unprocessable$/i, 422], [/^(?:server )?error$/i, 500], [/^bad gateway$/i, 502], [/^unavailable$/i, 503]];

class NotUnderstood extends Error {}

class Reader {
  nodes: FlowNode[] = [];
  edges: FlowEdge[] = [];
  lines = new Map<number, DescribeLine>();
  missing = new Map<string, MissingConnection>();
  instructions: DescribeResult["instructions"] = [];
  notes: string[] = [];
  vars = new Map<string, string>();      // entity word (lower, singular) -> variable name
  aliases: { name: string; expr: string; fields: Set<string>; list?: string }[] = [];
  listSamples = new Map<string, Set<string>>();   // loop item names, innermost last
  lastCall: FlowNode | null = null;
  genericCall: FlowNode | null = null;   // the last call whose result has a generic name (response, zohoResult)
  lastVar: string | null = null;
  inError = 0;
  triggers = 0;
  name = "";
  payloadFields = new Set<string>();
  mapFields = new Set<string>();
  private seq = 0; private eseq = 0;
  constructor(public ctx: DescribeContext, public opts: DescribeOptions) {}

  // -------------------------------------------------- graph building
  add(type: string, name: string, config: Record<string, unknown>, line: number, notes?: string): FlowNode {
    const taken = new Set(this.nodes.map((n) => n.name));
    let nm = short(name, 60) || type, i = 2;
    while (taken.has(nm)) nm = `${short(name, 56)} ${i++}`;
    const node: FlowNode = { id: `n_d${String(++this.seq).padStart(2, "0")}`, type, name: nm, position: { x: 0, y: 0 }, config, ...(notes ? { notes } : {}) };
    this.nodes.push(node);
    this.link(line, node.id);
    return node;
  }
  wire(tails: Tail[], to: FlowNode) { for (const t of tails) this.edges.push({ id: `e_d${String(++this.eseq).padStart(2, "0")}`, from: t.id, fromPort: t.port, to: to.id }); }
  /** Adds a step after the open ends; returns the new open end. */
  step(tails: Tail[], type: string, name: string, config: Record<string, unknown>, line: number, notes?: string): { node: FlowNode; tails: Tail[] } {
    const node = this.add(type, name, config, line, notes);
    this.wire(tails, node);
    return { node, tails: [{ id: node.id, port: "out" }] };
  }
  line(n: number): DescribeLine { const l = this.lines.get(n); if (!l) throw new Error(`no line ${n}`); return l; }
  link(line: number, nodeId: string) { const l = this.lines.get(line); if (l && !l.nodeIds.includes(nodeId)) l.nodeIds.push(nodeId); }
  ok(line: number, understood: string) { const l = this.line(line); if (l.status !== "not-understood") { if (l.status !== "warning") l.status = "ok"; l.role = l.role ?? "step"; l.understood = l.understood ? `${l.understood}; ${understood}` : understood; } }
  warn(line: number, message: string) { const l = this.line(line); if (l.status !== "not-understood") { l.status = "warning"; l.message = l.message ? `${l.message} ${message}` : message; } }
  fail(line: number, message?: string) {
    const l = this.line(line);
    l.status = "not-understood"; l.role = "step";
    l.message = message ?? "This line does not match any phrasing this reader knows, so no step was made for it.";
    l.suggestions = closestPhrases(l.text);
  }
  need(name: string, type: string, line: number, nodeId: string, why: string, suggested?: MissingConnection["suggested"]) {
    const key = `${type}:${norm(name)}`;
    const m = this.missing.get(key) ?? { key, name, type, lines: [], nodeIds: [], why, ...(suggested ? { suggested } : {}) };
    if (!m.lines.includes(line)) m.lines.push(line);
    if (!m.nodeIds.includes(nodeId)) m.nodeIds.push(nodeId);
    this.missing.set(key, m);
  }

  // -------------------------------------------------- references
  varFor(entity: string): string {
    const words = entity.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map(lc).filter((w) => !["the", "a", "an", "all", "every"].includes(w));
    const base = camel(words.length ? words : ["result"]);
    return IDENT.test(base) ? base : "result";
  }
  remember(entity: string, varName: string) {
    const words = tokens(entity);
    this.vars.set(words.join(" "), varName);
    if (words.length) this.vars.set(words[words.length - 1], varName);
    this.vars.set(lc(varName), varName);
    this.lastVar = varName;
  }
  /** A field or thing named in words: "the contact id", "email", "query page", "the error". */
  ref(phrase: string, register = true): Ref | null {
    const r = this.refInner(phrase, register);
    if (r && !r.words) { const w = stripArticles(phrase).replace(/'s\b/g, "").split(/[^A-Za-z0-9_]+/).filter(Boolean); if (w.length) r.words = w; }
    return r;
  }
  private refInner(phrase: string, register: boolean): Ref | null {
    let t = phrase.trim();
    if (!t) return null;
    const braces = /^\{\{\s*(.+?)\s*\}\}$/.exec(t);
    if (braces) return { expr: braces[1], key: tokens(braces[1]).pop() ?? "value", label: braces[1] };
    if (/^\$[A-Za-z_]/.test(t) && !/\s/.test(t)) return { expr: t, key: camel(tokens(t).slice(-2)) || "value", label: t };
    t = stripArticles(t).replace(/'s\b/g, "").replace(/\s+/g, " ").trim();
    const l = lc(t);
    let m: RegExpExecArray | null;
    if ((m = /^(?:query(?: string)?(?: parameter| param| value)?|parameter)\s+([\w-]+)$/i.exec(t)) || (m = /^([\w-]+)\s+query(?: parameter| param)?$/i.exec(t)))
      return { expr: `$request.query.${seg(m[1])}`, key: camel(tokens(m[1])), label: `the query parameter ${m[1]}` };
    if ((m = /^header\s+([\w-]+)$/i.exec(t)) || (m = /^([\w-]+)\s+header$/i.exec(t)))
      return { expr: `$request.headers.${jstr(lc(m[1]))}`, key: camel(tokens(m[1])), label: `the header ${m[1]}` };
    if ((m = /^(?:path (?:parameter|param)|url (?:parameter|param))\s+([\w-]+)$/i.exec(t)) || (m = /^:([\w-]+)$/.exec(t)))
      return { expr: `$request.params.${seg(m[1])}`, key: camel(tokens(m[1])), label: `the path parameter ${m[1]}` };
    if (/^request body$/i.test(t)) return { expr: "$request.body", key: "body", label: "the request body", whole: true };
    if (/^(?:payload|incoming data|input|data|body|message)$/i.test(t)) return { expr: "$", key: "data", label: "the incoming data", whole: true };
    if (/^error(?: message)?$/i.test(t)) return { expr: "$error.message", key: "error", label: "the error message" };
    if (/^error (?:status|code)$/i.test(t)) return { expr: "$error.status", key: "status", label: "the error status" };
    if (/^(?:current time|now|today|current date)$/i.test(t)) return { expr: "$now()", key: camel(tokens(t)), label: "the current time" };
    if (/^index$/i.test(t)) return { expr: "$index", key: "index", label: "the position in the list" };
    if (/^(?:result|response|answer|it|reply|outcome)$/i.test(t)) {
      return this.lastVar ? { expr: `$vars.${seg(this.lastVar)}`, key: this.lastVar, label: `the ${this.lastVar} kept above`, whole: true } : { expr: "$", key: "result", label: "the current data", whole: true };
    }
    // dotted path as written
    let words: string[];
    if (/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*|\[\d+\])+$/.test(t)) words = t.split(".");
    else words = t.split(" ");
    if (!words.length || words.length > 6 || words.some((w) => !/^[A-Za-z_][\w-]*(?:\[\d+\])?$/.test(w))) return null;
    if (words.some((w) => ["is", "are", "was", "if", "then", "with", "and", "or", "not", "to", "from"].includes(lc(w)))) return null;
    const first = lc(words[0]);
    const rest = words.slice(1);
    const restPath = (ws: string[]) => (ws.length === 0 ? "" : ws.length > 1 && !words.some((w) => w.includes("_")) && !t.includes(".") ? "." + seg(camel(ws)) : "." + ws.map(seg).join("."));
    for (let i = this.aliases.length - 1; i >= 0; i--) {
      const a = this.aliases[i];
      if (first === lc(a.name) || singular(first) === lc(a.name)) {
        if (rest.length) a.fields.add(rest.length > 1 ? camel(rest.map(lc)) : rest[0]);
        return { expr: a.expr + restPath(rest), key: camel(rest.length ? rest : [a.name]), label: rest.length ? `${rest.join(" ")} of the current ${a.name}` : `the current ${a.name}`, whole: !rest.length };
      }
    }
    if (first === "item" && this.aliases.length) return { expr: "$item" + restPath(rest), key: camel(rest.length ? rest : ["item"]), label: rest.length ? `${rest.join(" ")} of the current item` : "the current item", whole: !rest.length };
    // longest known entity at the start ("guest profile id" -> guestProfile + id)
    for (let n = Math.min(3, words.length); n >= 1; n--) {
      const ent = words.slice(0, n).map((w) => singular(lc(w))).join(" ");
      const v = this.vars.get(ent) ?? this.vars.get(words.slice(0, n).map(lc).join(" "));
      if (v) {
        const r = words.slice(n);
        return { expr: `$vars.${seg(v)}` + restPath(r), key: camel([v, ...r]), label: r.length ? `${r.join(" ")} of the ${v} kept above` : `the ${v} kept above`, whole: !r.length };
      }
    }
    if (!t.includes(".") && words.length > 3) return null;   // a field is named in at most three words
    const path = t.includes(".") ? words.map(seg).join(".") : words.length === 1 ? seg(words[0]) : seg(camel(words.map(lc)));
    const field = t.includes(".") ? t : words.length === 1 ? words[0] : camel(words.map(lc));
    const inLoop = this.aliases[this.aliases.length - 1];
    if (register) { if (inLoop) inLoop.fields.add(field); else this.payloadFields.add(field); }
    return { expr: path, key: camel(tokens(field).length ? field.split(".").slice(-1) : ["value"]), label: inLoop ? `${field} of the current ${inLoop.name}` : `${field} from the incoming data`, payloadPath: field };
  }
  /** A literal or a field: "web" -> "web", 18 -> 18, the contact id -> $vars.contact.id */
  value(text: string): { expr: string; label: string } | null {
    const t = text.trim();
    const q = unquote(t);
    if (q !== null) return { expr: jstr(q), label: `the text "${q}"` };
    if (/^-?\d+(\.\d+)?$/.test(t)) return { expr: t, label: t };
    if (/^(true|false|null|yes|no)$/i.test(t)) { const v = /^(true|yes)$/i.test(t) ? "true" : /^(false|no)$/i.test(t) ? "false" : "null"; return { expr: v, label: v }; }
    if (/^[{[]/.test(t)) { try { JSON.parse(t); return { expr: t, label: "this JSON" }; } catch { return null; } }
    const r = this.ref(t);
    if (r) return { expr: r.expr, label: r.label };
    return null;
  }
  /** A literal on the right of a condition: bare words are text ("is cancelled" -> "cancelled"). */
  literal(text: string): string {
    const t = text.trim();
    const q = unquote(t);
    if (q !== null) return jstr(q);
    if (/^-?\d+(\.\d+)?$/.test(t)) return t;
    if (/^(true|false|null)$/i.test(t)) return lc(t);
    if (/^[\w.@+-]+$/.test(t)) return jstr(t);
    throw new NotUnderstood(`Put text of more than one word in quotes: "${t}".`);
  }
  /** "Log "guest {email} checked"" -> "guest {{ email }} checked" */
  template(text: string): string {
    return text.replace(/\{\{[^}]*\}\}|\{([^{}]+)\}/g, (all, inner: string | undefined) => {
      if (!inner) return all;
      const r = this.ref(inner);
      return r ? `{{ ${r.expr} }}` : all;
    });
  }
  fieldList(text: string): Ref[] | null {
    const parts = splitOutside(text, /\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/i).map((p) => p.trim()).filter(Boolean);
    const out: Ref[] = [];
    for (const p of parts) { const r = this.ref(p); if (!r) return null; out.push(r); }
    return out.length ? out : null;
  }

  // -------------------------------------------------- conditions
  condition(text: string): { expr: string; explanation: string } | null {
    const t = stripArticles(text.trim().replace(/\?$/, "")).trim();
    let own: { expr: string; explanation: string } | null = null;
    try { own = this.conditionOwn(t); } catch (e) { if (!(e instanceof NotUnderstood)) throw e; }
    if (own) return own;
    for (const op of [/\s+or\s+/i, /\s+and\s+/i]) {
      const parts = splitOutside(t, op);
      if (parts.length > 1) {
        const got = parts.map((p) => this.condition(p));
        if (got.every(Boolean)) {
          const word = op.source.includes("or") ? "or" : "and";
          return { expr: got.map((g) => `(${g!.expr})`).join(` ${word} `), explanation: got.map((g) => g!.explanation).join(` ${word} `) };
        }
      }
    }
    if (this.opts.compileCondition) {
      const c = this.opts.compileCondition(t);
      if (c) return c;
    }
    return null;
  }
  private last(entity?: string): { expr: string; label: string } {
    if (entity) {
      const r = this.ref(entity);
      if (r && r.expr.startsWith("$vars.")) return { expr: r.expr, label: r.label };
    }
    return this.lastVar ? { expr: `$vars.${seg(this.lastVar)}`, label: `the ${this.lastVar} kept above` } : { expr: "$", label: "the current data" };
  }
  private conditionOwn(t: string): { expr: string; explanation: string } | null {
    let m: RegExpExecArray | null;
    // not found / found
    if ((m = /^(?:(?:it|nothing|none|no ([\w ]+?)|(?!not\b)([\w ]+?))\s+)?(?:(?:is|was|were|are)\s+)?(not found|not there|missing|unknown|found|there|known)$/i.exec(t)) && !/^(?:it|nothing|none)$/.test(t)) {
      const nothing = /^(?:nothing|none|no )/i.test(t);
      const negWord = /^(not found|not there|missing|unknown)$/i.test(m[3]);
      const entity = (m[1] || m[2] || "").trim();
      if (entity && !/^(it|nothing|none)$/i.test(entity) && !this.vars.has(singular(lc(entity))) && !this.vars.has(lc(entity))) {
        // "email is missing" on an incoming field
        const r = this.ref(entity);
        if (!r) return null;
        const empty = negWord !== nothing;
        return { expr: empty ? `$isEmpty(${r.expr})` : `$not($isEmpty(${r.expr}))`, explanation: `${r.label} ${empty ? "is empty or missing" : "has a value"}` };
      }
      const target = this.last(entity || undefined);
      const isEmpty = nothing || negWord;
      return { expr: isEmpty ? `$isEmpty(${target.expr})` : `$not($isEmpty(${target.expr}))`, explanation: `${target.label} ${isEmpty ? "is empty (nothing was found)" : "has a value (something was found)"}` };
    }
    if (/^(?:nothing|none)\s+(?:was\s+|were\s+)?(?:found|returned|there)$/i.test(t) || /^no (?:result|match|record|row)s?$/i.test(t)) {
      const target = this.last();
      return { expr: `$isEmpty(${target.expr})`, explanation: `${target.label} is empty (nothing was found)` };
    }
    const subj = (s: string) => this.ref(s);
    const bin = (s: string, op: string, v: string, words: string) => { const r = subj(s); return r ? { expr: `${r.expr} ${op} ${v}`, explanation: `${r.label} ${words}` } : null; };
    if ((m = /^(.+?)\s+(?:is|are)\s+(?:empty|blank|missing|not set|not given|null)$/i.exec(t)) || (m = /^(.+?)\s+(?:does not|doesn't)\s+exist$/i.exec(t))) { const r = subj(m[1]); return r ? { expr: `$isEmpty(${r.expr})`, explanation: `${r.label} is empty or missing` } : null; }
    if ((m = /^(.+?)\s+(?:is|are)\s+(?:not empty|set|given|present|filled in)$/i.exec(t)) || (m = /^(.+?)\s+(?:exists?|has a value)$/i.exec(t))) { const r = subj(m[1]); return r ? { expr: `$not($isEmpty(${r.expr}))`, explanation: `${r.label} has a value` } : null; }
    if ((m = /^(.+?)\s+(?:is|are)\s+between\s+(-?[\d.]+)\s+and\s+(-?[\d.]+)$/i.exec(t))) { const r = subj(m[1]); return r ? { expr: `${r.expr} >= ${m[2]} and ${r.expr} <= ${m[3]}`, explanation: `${r.label} is between ${m[2]} and ${m[3]}` } : null; }
    if ((m = /^(.+?)\s+(?:is|are)\s+(?:not\s+one of|not in)\s+(.+)$/i.exec(t))) { const r = subj(m[1]); const vs = splitOutside(m[2], /\s*,\s*(?:or\s+)?|\s+or\s+/i).map((v) => this.literal(v)); return r ? { expr: `$not(${r.expr} in [${vs.join(", ")}])`, explanation: `${r.label} is none of ${vs.join(", ")}` } : null; }
    if ((m = /^(.+?)\s+(?:is|are)\s+(?:one of|any of|in)\s+(.+)$/i.exec(t))) { const r = subj(m[1]); const vs = splitOutside(m[2], /\s*,\s*(?:or\s+)?|\s+or\s+/i).map((v) => this.literal(v)); return r ? { expr: `${r.expr} in [${vs.join(", ")}]`, explanation: `${r.label} is one of ${vs.join(", ")}` } : null; }
    const num = "(-?\\d+(?:\\.\\d+)?)";
    for (const [re, op, words] of [
      [`^(.+?)\\s+(?:is|are)\\s+(?:greater|more|higher|bigger|larger)\\s+than\\s+${num}$`, ">", "is greater than"], [`^(.+?)\\s+(?:is|are)\\s+(?:above|over)\\s+${num}$`, ">", "is greater than"], [`^(.+?)\\s*>\\s*${num}$`, ">", "is greater than"],
      [`^(.+?)\\s+(?:is|are)\\s+(?:less|lower|smaller|fewer)\\s+than\\s+${num}$`, "<", "is less than"], [`^(.+?)\\s+(?:is|are)\\s+(?:below|under)\\s+${num}$`, "<", "is less than"], [`^(.+?)\\s*<\\s*${num}$`, "<", "is less than"],
      [`^(.+?)\\s+(?:is|are)\\s+(?:at least|greater than or equal to|no less than)\\s+${num}$`, ">=", "is at least"], [`^(.+?)\\s*>=\\s*${num}$`, ">=", "is at least"],
      [`^(.+?)\\s+(?:is|are)\\s+(?:at most|less than or equal to|no more than)\\s+${num}$`, "<=", "is at most"], [`^(.+?)\\s*<=\\s*${num}$`, "<=", "is at most"],
    ] as [string, string, string][]) {
      if ((m = new RegExp(re, "i").exec(t))) return bin(m[1], op, m[2], `${words} ${m[2]}`);
    }
    if ((m = /^(.+?)\s+(?:does not|doesn't)\s+contain\s+(.+)$/i.exec(t))) { const r = subj(m[1]); const v = this.literal(m[2]); return r ? { expr: `$not($contains(${r.expr}, ${v}))`, explanation: `${r.label} does not contain ${v}` } : null; }
    if ((m = /^(.+?)\s+(?:contains|includes|has)\s+(.+)$/i.exec(t)) && !/^a value$/i.test(m[2])) { const r = subj(m[1]); const v = this.literal(m[2]); return r ? { expr: `$contains(${r.expr}, ${v})`, explanation: `${r.label} contains ${v}` } : null; }
    if ((m = /^(.+?)\s+(?:starts|begins)\s+with\s+(.+)$/i.exec(t))) { const r = subj(m[1]); const v = this.literal(m[2]); const n = (JSON.parse(v) as string).length; return r ? { expr: `$substring(${r.expr}, 0, ${n}) = ${v}`, explanation: `${r.label} starts with ${v}` } : null; }
    if ((m = /^(.+?)\s+ends\s+with\s+(.+)$/i.exec(t))) { const r = subj(m[1]); const v = this.literal(m[2]); const n = String(JSON.parse(v)).length; return r ? { expr: `$substring(${r.expr}, -${n}) = ${v}`, explanation: `${r.label} ends with ${v}` } : null; }
    if ((m = /^(.+?)\s+(?:is|are)\s+(true|yes)$/i.exec(t))) { const r = subj(m[1]); return r ? { expr: `$toBool(${r.expr}) = true`, explanation: `${r.label} is true` } : null; }
    if ((m = /^(.+?)\s+(?:is|are)\s+(false|no)$/i.exec(t))) { const r = subj(m[1]); return r ? { expr: `$toBool(${r.expr}) != true`, explanation: `${r.label} is not true` } : null; }
    if ((m = /^(.+?)\s+(?:is not|isn't|are not|aren't|does not equal|doesn't equal|!=|<>)\s+(.+)$/i.exec(t))) { const v = this.literal(m[2]); return bin(m[1], "!=", v, `is not ${v}`); }
    if ((m = /^(.+?)\s+(?:is|are|equals|is equal to|==|=)\s+(.+)$/i.exec(t))) { const v = this.literal(m[2]); return bin(m[1], "=", v, `is ${v}`); }
    return null;
  }

  // -------------------------------------------------- blocks
  block(items: Item[], tails: Tail[]): Outcome {
    let i = 0, terminal = false;
    while (i < items.length) {
      const r = this.statement(items, i, tails);
      tails = r.tails; i = r.next; terminal = !!r.terminal;
    }
    return { tails, next: items.length, terminal };
  }
  /** The lines that belong to the opener at `i`: indented below it, or (written flat) up to its "end". */
  body(items: Item[], i: number, stopAtOtherwise: boolean): { body: Item[]; next: number; closedBy?: Item } {
    const me = items[i];
    let j = i + 1;
    while (j < items.length && items[j].indent > me.indent) j++;
    if (j > i + 1) return { body: items.slice(i + 1, j), next: j };
    // written flat: up to the matching end (or otherwise for an If)
    let depth = 0;
    for (let k = i + 1; k < items.length; k++) {
      const t = items[k].text;
      if (END.test(t)) { if (depth === 0) { this.ok(items[k].line, "end of the block above"); this.line(items[k].line).role = "block"; return { body: items.slice(i + 1, k), next: k + 1, closedBy: items[k] }; } depth--; continue; }
      if (depth === 0 && stopAtOtherwise && OTHERWISE.test(t)) return { body: items.slice(i + 1, k), next: k };
      if (isOpener(t)) depth++;
    }
    if (i + 1 < items.length) this.warn(me.line, "Every line below belongs to this block, because it is neither indented nor closed with \"end\".");
    return { body: items.slice(i + 1), next: items.length };
  }

  statement(items: Item[], i: number, tails: Tail[]): Outcome {
    const it = items[i];
    const text = it.text.replace(/^(?:then|and then|next|after that|afterwards|finally|first|second|third|lastly)\s*,?\s+/i, "").trim();
    const L = it.line;
    let m: RegExpExecArray | null;

    // ---- trigger
    const trig = this.trigger(text, L);
    if (trig) { this.triggers++; return { tails: [{ id: trig.id, port: "out" }], next: i + 1 }; }
    if (!tails.length && !this.triggers) {
      const start = this.add("trigger.manual", "Start", { samplePayload: {} }, L);
      this.line(L).nodeIds = this.line(L).nodeIds.filter((x) => x !== start.id);
      this.notes.push("No start was described, so the flow starts with a Manual / Sub-flow start. Begin with a line such as \"When POST /path arrives\" to make it an API.");
      this.triggers++;
      tails = [{ id: start.id, port: "out" }];
    }
    if (!tails.length) {
      this.fail(L, "Nothing leads to this line: the step above ends the path (an answer or a stop). Indent it under a condition, or move it above the answer.");
      return { tails, next: i + 1 };
    }

    // ---- error path of the call above
    if ((m = FAIL.exec(text)) || (m = ONERR.exec(text))) {
      const action = (m[1] ?? "").trim();
      if (!this.lastCall) { this.fail(L, "There is no call above this line, so there is nothing that could fail."); return { tails, next: i + 1 }; }
      const call = this.lastCall;
      this.ok(L, `when "${call.name}" fails`);
      this.line(L).role = "block";
      this.link(L, call.id);
      let out: Outcome;
      this.inError++;
      if (action) out = this.inline(action, L, [{ id: call.id, port: "error" }]);
      else { const b = this.body(items, i, false); out = { ...this.block(b.body, [{ id: call.id, port: "error" }]), next: b.next }; }
      this.inError--;
      const next = action ? i + 1 : out.next;
      return { tails: out.terminal ? tails : [...tails, ...out.tails], next };
    }

    // ---- retry / timeout on the call above
    if ((m = RETRY.exec(text)) || (m = TRY_TIMES.exec(text)) || (m = TIMEOUT.exec(text)) || BACKGROUND_RE.test(text) || CACHE_RE.test(text) || SHARE_RE.test(text) || REUSE_RE.test(text)) { this.modifier(text, L); return { tails, next: i + 1 }; }

    // ---- otherwise without an If
    if (OTHERWISE.test(text) && !/^if not\b/i.test(text)) { this.fail(L, "\"Otherwise\" needs an \"If …\" line just above it, at the same indentation."); return { tails, next: i + 1 }; }
    if (END.test(text)) { this.fail(L, "This \"end\" closes nothing: there is no open \"If …:\" or \"For each …:\" above it."); return { tails, next: i + 1 }; }

    // ---- loop
    if ((m = FOREACH.exec(text)) || (m = FOREACH_OF.exec(text))) return this.loop(items, i, tails, m);

    // ---- condition
    if ((m = IF.exec(text))) return this.choice(items, i, tails, m[1]);

    // ---- map block / map lines
    if ((m = MAP_BLOCK.exec(text))) {
      const b = this.body(items, i, false);
      const src = this.ref(m[1]);
      if (!src) { this.fail(L, `"${m[1]}" is not a field or a thing named above.`); return { tails, next: b.next }; }
      const node = this.add("transform.map", `Map ${short(m[1], 40)}`, { input: src.expr, mapping: { rules: [], passthrough: false }, resultTarget: "payload" }, L);
      this.ok(L, `map ${src.label}; the result becomes the data`);
      this.line(L).role = "block";
      for (const c of b.body) this.mapRule(node, c.text.replace(/^map\s*:?\s*/i, ""), c.line);
      this.wire(tails, node);
      this.lastVar = null;
      return { tails: [{ id: node.id, port: "out" }], next: b.next };
    }
    if (MAP.test(text)) {
      const node = this.add("transform.map", "Map fields", { input: "$", mapping: { rules: [], passthrough: false }, resultTarget: "payload" }, L);
      let j = i;
      while (j < items.length && items[j].indent === it.indent && MAP.test(items[j].text)) {
        this.link(items[j].line, node.id);
        this.mapRule(node, items[j].text.replace(MAP, ""), items[j].line);
        j++;
      }
      this.wire(tails, node);
      this.lastVar = null;
      return { tails: [{ id: node.id, port: "out" }], next: j };
    }

    // ---- one-line steps
    const r = this.simple(text, L, tails);
    if (r) return { tails: r.tails, next: i + 1, terminal: r.terminal };
    this.fail(L);
    return { tails, next: i + 1 };
  }

  /** A step written after a comma ("If not found, create …"): one simple step or a nested If. */
  inline(action: string, L: number, tails: Tail[]): Outcome {
    const t = action.trim();
    let m: RegExpExecArray | null;
    if ((m = IF.exec(t))) return this.choice([{ line: L, indent: 0, text: t }], 0, tails, m[1]);
    if ((m = FAIL.exec(t))) { this.fail(L, "An error path cannot be written inside another step on the same line. Put it on its own line."); return { tails, next: 0 }; }
    const r = this.simple(t, L, tails);
    if (r) return { tails: r.tails, next: 0, terminal: r.terminal };
    this.fail(L, `"${short(t, 60)}" is not a step this reader knows.`);
    return { tails, next: 0 };
  }

  loop(items: Item[], i: number, tails: Tail[], m: RegExpExecArray): Outcome {
    const L = items[i].line;
    const itemName = (m.groups?.item ?? "item").trim();
    const listText = (m.groups?.list ?? "").trim();
    const action = (m.groups?.action ?? m.groups?.action2 ?? "").trim();
    const list = this.ref(listText);
    if (!list) { this.fail(L, `"${listText}" is not a list this reader can find.`); return { tails, next: i + 1 }; }
    const node = this.add("logic.foreach", `For each ${short(singular(itemName), 30)}`, { items: list.expr, concurrency: 1, collect: true }, L);
    this.wire(tails, node);
    this.ok(L, `for each ${itemName} in ${list.label}`);
    this.line(L).role = "block";
    const alias = { name: singular(lc(itemName.split(" ").pop() ?? "item")), expr: "$item", fields: new Set<string>(), list: list.payloadPath };
    this.aliases.push(alias);
    let next = i + 1;
    if (action) this.inline(action, L, [{ id: node.id, port: "each" }]);
    else { const b = this.body(items, i, false); this.block(b.body, [{ id: node.id, port: "each" }]); next = b.next; }
    this.aliases.pop();
    if (alias.list) { this.payloadFields.delete(alias.list); this.listSamples.set(alias.list, alias.fields); }
    this.lastVar = null;
    return { tails: [{ id: node.id, port: "done" }], next };
  }

  choice(items: Item[], i: number, tails: Tail[], rest: string): Outcome {
    const L = items[i].line;
    let condText = rest.trim(), action = "", elseAction = "";
    // condition and step: "then" first, else ":" at the end, else the first comma after which a step reads
    const thenCut = cutOutside(condText, /\s+then\s+|\s*,\s*then\s+/i);
    if (thenCut) { condText = thenCut[0]; action = thenCut[1]; }
    else if (/:\s*$/.test(condText)) condText = condText.replace(/:\s*$/, "");
    else {
      const commas = [...maskQuotes(condText).matchAll(/,/g)].map((x) => x.index ?? 0);
      for (const c of commas) {
        const after = condText.slice(c + 1).trim();
        if (looksLikeStep(after)) { action = after; condText = condText.slice(0, c); break; }
      }
      if (!action) { const colon = cutOutside(condText, /:\s+/); if (colon && looksLikeStep(colon[1])) { condText = colon[0]; action = colon[1]; } }
    }
    if (action) { const e = cutOutside(action, /\s*,?\s*\b(?:otherwise|else)\b\s*,?\s*/i); if (e) { action = e[0]; elseAction = e[1]; } }
    const cond = this.condition(condText);
    if (!cond) {
      this.fail(L, `The condition "${short(condText, 60)}" was not understood. Conditions read like: not found · the status is "A" · the age is at least 18 · the email is empty.`);
      // skip what belongs to it so its lines are not read as top-level steps
      if (!action) return { tails, next: this.body(items, i, true).next };
      return { tails, next: i + 1 };
    }
    const conditions = [{ id: "c1", label: short(cap(condText), 60), expr: cond.expr }];
    const node = this.add("logic.choice", `If ${short(condText, 40)}`, { conditions }, L);
    this.wire(tails, node);
    this.ok(L, `if ${cond.explanation} (${cond.expr})`);
    this.line(L).role = action ? "step" : "block";
    const out: Tail[] = [];
    let terminalAll = true;
    const branch = (o: Outcome) => { out.push(...o.tails); if (!o.terminal) terminalAll = false; };
    let next = i + 1;
    if (action) branch(this.inline(action, L, [{ id: node.id, port: "case:c1" }]));
    else { const b = this.body(items, i, true); branch(this.block(b.body, [{ id: node.id, port: "case:c1" }])); next = b.next; }
    let hasElse = false;
    if (elseAction) { hasElse = true; branch(this.inline(elseAction, L, [{ id: node.id, port: "otherwise" }])); }
    // following "Otherwise if …" / "Otherwise …" lines at the same indentation
    let n = 2;
    while (!hasElse && next < items.length && items[next].indent === items[i].indent && OTHERWISE.test(items[next].text) && !/^if not\b/i.test(items[next].text)) {
      const o = items[next];
      const om = OTHERWISE.exec(o.text)!;
      const restText = (om[1] ?? "").trim();
      const elif = /^if\s+(.+)$/i.exec(restText);
      if (elif) {
        let cText = elif[1], act = "";
        const tc = cutOutside(cText, /\s+then\s+|\s*,\s*then\s+/i);
        if (tc) { cText = tc[0]; act = tc[1]; }
        else if (/:\s*$/.test(cText)) cText = cText.replace(/:\s*$/, "");
        else { for (const c of [...maskQuotes(cText).matchAll(/,/g)].map((x) => x.index ?? 0)) { const after = cText.slice(c + 1).trim(); if (looksLikeStep(after)) { act = after; cText = cText.slice(0, c); break; } } }
        const c2 = this.condition(cText);
        if (!c2) { this.fail(o.line, `The condition "${short(cText, 60)}" was not understood.`); next = act ? next + 1 : this.body(items, next, true).next; continue; }
        const id = `c${n++}`;
        conditions.push({ id, label: short(cap(cText), 60), expr: c2.expr });
        this.link(o.line, node.id);
        this.ok(o.line, `otherwise, if ${c2.explanation} (${c2.expr})`);
        if (act) { branch(this.inline(act, o.line, [{ id: node.id, port: `case:${id}` }])); next++; }
        else { const b = this.body(items, next, true); branch(this.block(b.body, [{ id: node.id, port: `case:${id}` }])); next = b.next; }
        continue;
      }
      hasElse = true;
      this.link(o.line, node.id);
      this.ok(o.line, "otherwise");
      this.line(o.line).role = restText ? "step" : "block";
      if (restText && restText !== ":") { branch(this.inline(restText.replace(/^:\s*/, ""), o.line, [{ id: node.id, port: "otherwise" }])); next++; }
      else { const b = this.body(items, next, false); branch(this.block(b.body, [{ id: node.id, port: "otherwise" }])); next = b.next; }
    }
    if (!hasElse) { out.push({ id: node.id, port: "otherwise" }); terminalAll = false; }
    return { tails: out, next, terminal: terminalAll };
  }

  mapRule(node: FlowNode, text: string, L: number) {
    const spec = (node.config.mapping as { rules: MappingRule[] });
    const m = /^(.+?)\s*(?:\bfrom\b|=|<-|:|\bis\b|\bas\b)\s*(.+)$/i.exec(text.trim());
    if (!m) { this.fail(L, "A map line reads \"Map: TARGET from WORDS\", for example Map: fullName from join first name and last name with a space."); return; }
    const target = m[1].trim().replace(/^the\s+/i, "");
    const tgt = /^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*|\[\d+\])*$/.test(target) ? target : camel(tokens(target));
    const words = m[2].trim();
    const id = `r${spec.rules.length + 1}`;
    const peek = this.ref(words, false);
    const r = peek && (!peek.payloadPath || !/\s/.test(words)) ? this.ref(words) : null;
    if (r && !/\s/.test(words) && r.payloadPath) {
      spec.rules.push({ id, target: tgt, kind: "direct", source: r.payloadPath });
      this.ok(L, `${tgt} = ${r.label}`);
    } else if (r && !r.payloadPath) {
      spec.rules.push({ id, target: tgt, kind: "expr", expr: r.expr });
      this.ok(L, `${tgt} = ${r.label} (${r.expr})`);
    } else {
      spec.rules.push({ id, target: tgt, kind: "instruction", instruction: words, compiled: null });
      if (node.config.input === "$") for (const f of candidateFields(words)) { const r2 = this.ref(f); if (r2?.payloadPath) this.mapFields.add(r2.payloadPath); }
      this.instructions.push({ nodeId: node.id, ruleId: id, line: L, instruction: words });
      this.ok(L, `${tgt} = "${short(words, 60)}" (read by the mapping phrases)`);
    }
    this.link(L, node.id);
  }

  callMethod(call: FlowNode): string {
    if (call.type === "graphql.request") return "POST";
    const m = /^connector:([^:]+):(.+)$/.exec(call.type);
    if (m) return String((this.ctx.connectors ?? []).find((c) => c.id === m[1])?.operations.find((o) => o.id === m[2])?.method ?? "GET").toUpperCase();
    return String(call.config.method ?? "GET").toUpperCase();
  }

  modifier(text: string, L: number): boolean {
    const call = this.lastCall;
    let m: RegExpExecArray | null;
    if (!call) { this.fail(L, "There is no call above this line to apply it to."); return false; }
    const cfg = call.config;
    const isDb = DB_TYPES.some((t) => call.type === DB_NODE[t]);
    if ((m = RETRY.exec(text)) || (m = TRY_TIMES.exec(text))) {
      let n = numOf(m[1]) ?? 0;
      if (TRY_TIMES.test(text) && !RETRY.test(text)) n = Math.max(0, n - 1);
      if (isDb) { this.warn(L, `Database steps do not retry; "${call.name}" runs once.`); this.link(L, call.id); return true; }
      cfg.retries = n;
      if (m[2]) delete cfg.retryDelaysMs;   // one wait between retries, as written
      if (m[2]) cfg.retryDelayMs = Math.round(Number(m[2]) * (/^m/i.test(m[3] ?? "s") && !/^min/i.test(m[3] ?? "") ? 1 : /^min/i.test(m[3] ?? "") ? 60000 : 1000));
      this.link(L, call.id);
      this.ok(L, `"${call.name}" is retried ${n} time${n === 1 ? "" : "s"}${m[2] ? `, ${cfg.retryDelayMs} ms apart` : ""}`);
      return true;
    }
    if ((m = TIMEOUT.exec(text))) {
      const ms = Math.round(Number(m[1]) * (/^ms|^milli/i.test(m[2]) ? 1 : /^min/i.test(m[2]) ? 60000 : 1000));
      if (isDb) cfg.timeoutSeconds = Math.max(1, Math.round(ms / 1000)); else cfg.timeoutMs = ms;
      this.link(L, call.id);
      this.ok(L, `"${call.name}" gives up after ${ms} ms`);
      return true;
    }
    const secondsOf = (n: string | undefined, unit: string | undefined) => Math.round(Number(n) * (/^m/i.test(unit ?? "s") ? 60 : 1));
    const httpLike = call.type === "http.request" || call.type === "graphql.request" || call.type.startsWith("connector:");
    if (BACKGROUND_RE.test(text)) {
      this.link(L, call.id);
      if (!httpLike) { this.warn(L, `"${call.name}" cannot run in the background; only calls to a system can.`); return true; }
      cfg.background = true;
      this.ok(L, `"${call.name}" runs in the background: the flow does not wait for it; it is retried on connection failures and a failure is logged as an error (lesson L3)`);
      return true;
    }
    if ((m = CACHE_RE.exec(text)) || SHARE_RE.test(text)) {
      this.link(L, call.id);
      if (!httpLike || this.callMethod(call) !== "GET") { this.warn(L, `Only a read (GET) can share or keep its answer; "${call.name}" may change data, so it is called every time.`); return true; }
      cfg.shareIdentical = true;
      if (m) {
        const sec = secondsOf(m[1] ?? m[3], m[2] ?? m[4]);
        cfg.cacheSeconds = sec;
        this.ok(L, `"${call.name}" keeps its answer for ${sec} seconds and identical calls share one backend call; errors are never kept (lesson L2)`);
      } else this.ok(L, `identical calls of "${call.name}" share one backend call (lesson L2)`);
      return true;
    }
    if ((m = REUSE_RE.exec(text))) {
      this.link(L, call.id);
      if (!httpLike) { this.warn(L, `"${call.name}" is not a call to a system, so there is no session to reuse.`); return true; }
      cfg.reuseSession = true;
      cfg.sessionSeconds = m[1] ? secondsOf(m[1], m[2]) : LESSON_DEFAULTS.sessionSeconds;
      this.ok(L, `"${call.name}" logs in once and its answer is reused for ${cfg.sessionSeconds} seconds (dropped when the backend answers 401/403) (lesson L1)`);
      return true;
    }
    return false;
  }

  // -------------------------------------------------- triggers
  trigger(text: string, L: number): FlowNode | null {
    let m: RegExpExecArray | null;
    // HTTP
    let t = text;
    let guard = 0;
    while (guard++ < 6 && /^(?:when(?:ever)?|once|on|if|after|listen(?:\s+(?:for|on))?|expose|serve|accept|handle|receive|a|an|the|someone|somebody|client|calls?|sends?|makes?|receives?)\s+/i.test(t)) t = t.replace(/^\S+(?:\s+(?:for|on)(?=\s))?\s+/i, "");
    guard = 0;
    while (guard++ < 4 && /\s+(?:arrives?|comes?(?:\s+in)?|is\s+(?:received|called|made|hit)|hits?|happens|request|requests|endpoint)$/i.test(t)) t = t.replace(/\s+(?:arrives?|comes?(?:\s+in)?|is\s+(?:received|called|made|hit)|hits?|happens|request|requests|endpoint)$/i, "");
    if ((m = /^((?:GET|POST|PUT|PATCH|DELETE)(?:\s*(?:\/|,|\band\b|\bor\b)\s*(?:GET|POST|PUT|PATCH|DELETE))*)\s+(?:request\s+)?(?:(?:to|on|for|at)\s+)?(\/[^\s,]*)$/i.exec(t)) && (t !== text || /^(?:GET|POST|PUT|PATCH|DELETE)\s+\//i.test(text))) {
      if (/^call\b/i.test(text)) return null;
      const methods = [...new Set(m[1].toUpperCase().match(/GET|POST|PUT|PATCH|DELETE/g) ?? [])];
      const path = m[2].replace(/\{([^}]+)\}/g, ":$1").replace(/[),.;]+$/, "") || "/";
      const node = this.add("trigger.http", `${methods.join(", ")} ${path}`, { methods, path, summary: cap(path.replace(/^\/+/, "").replace(/[/:_-]+/g, " ").trim() || "root") }, L);
      this.ok(L, `an HTTP listener for ${methods.join(" and ")} ${path}`);
      if (!this.name) this.name = cap(path.replace(/^\/+/, "").replace(/\/:[^/]+/g, "").replace(/[/_-]+/g, " ").trim() || "API");
      return node;
    }
    // queue / topic
    if ((m = QUEUE.exec(text))) {
      const kind = lc(m.groups?.kind1 ?? m.groups?.kind2 ?? "queue");
      const name = m.groups?.name ?? "";
      const node = this.add("trigger.manual", `From ${kind} ${short(name, 40)}`, { samplePayload: {} }, L, `Meant to start when a message arrives on ${kind} ${name}. This server has no ${kind} listener yet: the component that reads ${name} can call this flow (Call Flow, or an HTTP listener).`);
      this.ok(L, `a start for messages from ${kind} ${name}`);
      this.warn(L, `This server has no ${kind} listener yet, so the flow starts with a Manual / Sub-flow start that says so. Whatever reads ${name} can call it.`);
      if (!this.name) this.name = `${cap(name)} messages`;
      return node;
    }
    // schedule
    const at = (h?: string, mi?: string, ap?: string) => { let hh = Number(h ?? 0); if (ap && /pm/i.test(ap) && hh < 12) hh += 12; if (ap && /am/i.test(ap) && hh === 12) hh = 0; return { h: hh, m: Number(mi ?? 0) }; };
    if ((m = /^(?:run\s+|start\s+|trigger\s+)?(?:once\s+)?every\s+(?:(\d+|one|two|three|four|five|six|ten|fifteen|twenty|thirty|a|an)\s+)?(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(text))) {
      const n = numOf(m[1]) ?? 1;
      const unit = lc(m[2]);
      if (m[3] !== undefined && /^day/.test(unit) && n === 1) {
        const a = at(m[3], m[4], m[5]);
        if (a.h > 23 || a.m > 59) return null;
        return this.cron(`${a.m} ${a.h} * * *`, `every day at ${String(a.h).padStart(2, "0")}:${String(a.m).padStart(2, "0")}`, L);
      }
      if (m[3] !== undefined) return null;
      const secs = n * (/^s/.test(unit) ? 1 : /^m/.test(unit) ? 60 : /^h/.test(unit) ? 3600 : /^d/.test(unit) ? 86400 : 604800);
      const node = this.add("trigger.schedule", `Every ${n === 1 ? "" : n + " "}${unit.replace(/s$/, "")}${n === 1 ? "" : "s"}`, { mode: "interval", everySeconds: secs, payload: {} }, L);
      this.ok(L, `a schedule every ${secs} seconds`);
      if (!this.name) this.name = `Every ${n === 1 ? "" : n + " "}${unit.replace(/s$/, "")}${n === 1 ? "" : "s"} job`;
      return node;
    }
    if ((m = /^(?:run\s+)?(?:every\s+)?(hourly|daily|nightly|weekly|weekday|weekdays|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(text)) && (/^(?:run\s+)?every\b/i.test(text) || /^(?:run\s+)?(hourly|daily|nightly|weekly)/i.test(text))) {
      const w = lc(m[1]);
      const a = at(m[2] ?? (w === "nightly" ? "2" : "0"), m[3], m[4]);
      if (a.h > 23 || a.m > 59) return null;
      const days: Record<string, string> = { monday: "1", tuesday: "2", wednesday: "3", thursday: "4", friday: "5", saturday: "6", sunday: "0", weekday: "1-5", weekdays: "1-5", weekly: "1" };
      if (w === "hourly") return this.cron(`${a.m} * * * *`, "every hour", L);
      const dow = days[w] ?? "*";
      return this.cron(`${a.m} ${a.h} * * ${dow}`, `${w === "daily" || w === "nightly" ? "every day" : `every ${w}`} at ${String(a.h).padStart(2, "0")}:${String(a.m).padStart(2, "0")}`, L);
    }
    if ((m = /^(?:on|run on|at)\s+(?:the\s+)?(?:schedule|cron)\s+"([^"]+)"$/i.exec(text)) || (m = /^cron\s+"([^"]+)"$/i.exec(text))) return this.cron(m[1].trim(), `the cron schedule ${m[1].trim()}`, L);
    // manual
    if (/^(?:when\s+)?(?:it\s+is\s+|it's\s+)?(?:started|run|triggered)\s+(?:manually|by hand|on demand)$|^(?:when\s+)?(?:it\s+is\s+)?called\s+(?:by|from)\s+(?:another|a|other)\s+flows?$|^(?:start manually|manual start|as a sub-?flow)$/i.test(text)) {
      const node = this.add("trigger.manual", "Start", { samplePayload: {} }, L);
      this.ok(L, "a manual / sub-flow start");
      return node;
    }
    return null;
  }
  cron(expr: string, words: string, L: number): FlowNode {
    const node = this.add("trigger.schedule", cap(words), { mode: "cron", cron: expr, payload: {} }, L);
    this.ok(L, `a schedule: ${words} (cron ${expr})`);
    if (!this.name) this.name = `${cap(words)} job`;
    return node;
  }

  // -------------------------------------------------- one-line steps
  simple(text: string, L: number, tails: Tail[]): { tails: Tail[]; terminal?: boolean } | null {
    let m: RegExpExecArray | null;
    let t = text.trim();
    // trailing modifiers on a call: ", retry 3 times", "(time out after 5 seconds)"
    const mods: string[] = [];
    let cut: [string, string, RegExpExecArray] | null;
    while ((cut = cutOutside(t, /\s*[,(]\s*(?:and\s+)?(?=(?:retry|try again|repeat|time\s*out|timeout|give up|cache\s|share\s+(?:identical|the\s+same)|reuse\s+the|re-use\s+the|log\s*in\s+once|(?:send|run|do)\s+(?:it|this|that)\s+in\s+the\s+background|in\s+the\s+background|don'?t\s+wait|do\s+not\s+wait|without\s+waiting)\b)/i))) { mods.unshift(cut[1].replace(/\)\s*$/, "").trim()); t = cut[0].trim(); }
    { const bg = /\s+(in\s+the\s+background|without\s+waiting)$/i.exec(t); if (bg && /^(?:send|notify|e-?mail|text|sms|push|call|post|create|add|submit)\b/i.test(t)) { mods.unshift(bg[1]); t = t.slice(0, bg.index).trim(); } }

    // log
    if ((m = LOG.exec(t))) return this.log(m, L, tails);
    // answer
    if ((m = ANSWER.exec(t))) return this.answer(m[1] ?? "", L, tails);
    // set / remember
    if ((m = SET.exec(t)) || (m = REMEMBER.exec(t))) {
      const isRemember = REMEMBER.test(t) && !SET.test(t);
      const name = isRemember ? m[2] : m[1];
      const valText = isRemember ? m[1] : m[2];
      const key = /^[A-Za-z_][\w]*$/.test(name.trim()) ? name.trim() : camel(tokens(name));
      let v = this.value(valText);
      if (!v && this.opts.compileValue) { const c = this.opts.compileValue(valText); if (c) v = { expr: c.expr, label: c.explanation }; }
      if (!v) { this.fail(L, `The value "${short(valText, 60)}" was not understood. Write text in quotes, a number, or a field.`); return { tails }; }
      const s = this.step(tails, "vars.set", `Set ${key}`, { assignments: [{ key, value: v.expr }] }, L);
      this.vars.set(lc(key), key); this.vars.set(tokens(name).join(" "), key);
      this.ok(L, `the variable ${key} = ${v.label}`);
      return { tails: s.tails };
    }
    // wait
    if ((m = /^(?:wait|pause|sleep|delay)\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|minutes?|mins?)$/i.exec(t))) {
      const ms = Math.round(Number(m[1]) * (/^ms|^milli/i.test(m[2]) ? 1 : /^min/i.test(m[2]) ? 60000 : 1000));
      const s = this.step(tails, "logic.delay", `Wait ${m[1]} ${m[2]}`, { ms }, L);
      this.ok(L, `wait ${ms} ms`);
      return { tails: s.tails };
    }
    // stop / fail
    if (/^(?:stop|end the flow|end here|finish quietly|do nothing(?: else)?)$/i.test(t)) {
      this.step(tails, "logic.stop", "Stop", { mode: "end" }, L);
      this.ok(L, "this path ends here");
      return { tails: [], terminal: true };
    }
    if ((m = /^(?:fail|raise an error|throw an error|stop with an error|reject)(?:\s+with)?(?:\s+(?:status\s+)?(\d{3}))?\s*(?:"([^"]*)")?$/i.exec(t)) && (m[1] || m[2] || /^fail$|error$/i.test(t))) {
      const status = Number(m[1] ?? 500);
      const msg = m[2] ? this.template(m[2]) : "";
      this.step(tails, "logic.stop", `Fail ${status}`, { mode: "error", status, message: msg }, L);
      this.ok(L, `stop with error ${status}${msg ? ` "${msg}"` : ""}`);
      return { tails: [], terminal: true };
    }
    // validate
    if ((m = /^reject(?:\s+(?:it|the request))?(?:\s+with\s+(\d{3}))?\s+(?:if|when)\s+(.+)$/i.exec(t))) {
      const c = this.condition(m[2]);
      if (!c) { this.fail(L, `The condition "${short(m[2], 60)}" was not understood.`); return { tails }; }
      const status = Number(m[1] ?? 400);
      const s = this.step(tails, "logic.validate", `Reject if ${short(m[2], 36)}`, { rules: [{ id: "v1", label: short(cap(m[2]), 80), expr: `$not(${c.expr})` }], status }, L);
      this.ok(L, `answer ${status} when ${c.explanation}`);
      return { tails: s.tails };
    }
    if ((m = /^(?:require|expect|check that|make sure(?: that)?|ensure(?: that)?|validate that)\s+(.+?)(?:\s+(?:otherwise|or)\s+(?:answer|reject(?: with)?)\s+(\d{3}))?$/i.exec(t))) {
      const status = Number(m[2] ?? 400);
      const c = /\s(?:is|are|contains|starts|ends|equals|>|<|=)\s|\s(?:is|are)\s/i.test(` ${m[1]} `) ? this.condition(m[1]) : null;
      if (c) {
        const s = this.step(tails, "logic.validate", `Check ${short(m[1], 36)}`, { rules: [{ id: "v1", label: short(cap(m[1]), 80), expr: c.expr }], status }, L);
        this.ok(L, `answer ${status} unless ${c.explanation}`);
        return { tails: s.tails };
      }
      const fields = this.fieldList(m[1].replace(/\s+(?:is|are)\s+(?:given|present|set)$/i, ""));
      if (!fields) { this.fail(L, `"${short(m[1], 60)}" is not a list of fields or a condition.`); return { tails }; }
      const rules = fields.map((f, k) => ({ id: `v${k + 1}`, label: `${f.payloadPath ?? f.label} is required`, expr: `$not($isEmpty(${f.expr}))` }));
      const s = this.step(tails, "logic.validate", `Require ${short(fields.map((f) => f.payloadPath ?? f.key).join(", "), 40)}`, { rules, status }, L);
      this.ok(L, `answer ${status} when ${fields.map((f) => f.payloadPath ?? f.label).join(", ")} ${fields.length === 1 ? "is" : "are"} missing`);
      return { tails: s.tails };
    }
    // xml
    if (/^convert\s+(?:the\s+)?(?:xml|payload|answer|result|response|data)?\s*(?:from\s+xml\s+)?(?:in)?to\s+json$/i.test(t)) { const s = this.step(tails, "xml.convert", "XML to JSON", { mode: "xml2json", input: "$", resultTarget: "payload" }, L); this.lastVar = null; this.ok(L, "XML text to JSON"); return { tails: s.tails }; }
    if (/^convert\s+(?:the\s+)?(?:json|payload|answer|result|response|data)?\s*(?:from\s+json\s+)?(?:in)?to\s+xml$/i.test(t)) { const s = this.step(tails, "xml.convert", "JSON to XML", { mode: "json2xml", input: "$", resultTarget: "payload" }, L); this.lastVar = null; this.ok(L, "JSON to XML text"); return { tails: s.tails }; }
    // run another flow
    if ((m = /^(?:run|call|start|invoke)\s+(?:the\s+)?(?:sub-?)?flow\s+"?(.+?)"?(?:\s+with\s+(.+))?$/i.exec(t))) return this.flowCall(m[1], m[2], L, tails, mods);
    // calls and databases
    const c = this.call(t, L, tails);
    if (c) { for (const mod of mods) if (!this.modifier(mod, L)) this.warn(L, `"${mod}" was not understood and was left out.`); return c; }
    return null;
  }

  log(m: RegExpExecArray, L: number, tails: Tail[]): { tails: Tail[] } {
    const lvlWord = lc(m[1] ?? m[3] ?? "");
    const level = /^warn/.test(lvlWord) ? "warn" : /^err/.test(lvlWord) ? "error" : /^debug/.test(lvlWord) ? "debug" : "info";
    let rest = (m[2] ?? m[4] ?? "").trim();
    let includePayload = false;
    const inc = cutOutside(rest, /\s*(?:,\s*)?(?:with|and|including|include)\s+(?:the\s+)?(?:whole\s+)?(?:payload|incoming data)$/i);
    if (inc) { includePayload = true; rest = inc[0].trim(); }
    let message = "";
    const q = /^"([^"]*)"\s*(?:(?:with|and|:|,)\s+(.+))?$/.exec(rest);
    if (q) {
      message = this.template(q[1]);
      if (q[2]) {
        const fields = this.fieldList(q[2]);
        if (!fields) { this.fail(L, `"${short(q[2], 60)}" is not a field this reader can find.`); return { tails }; }
        message = `${message}${/[\s:]$/.test(message) ? "" : " "}${fields.map((f) => `{{ ${f.expr} }}`).join(" ")}`;
      }
    } else if (rest) {
      const fields = this.fieldList(rest);
      if (!fields) { this.fail(L, "A log line reads Log \"text\", Log \"text {field}\" or Log FIELD."); return { tails }; }
      message = fields.map((f) => `${f.key}: {{ ${f.expr} }}`).join(", ");
    } else { this.fail(L, "Say what to write, for example Log \"guest checked\"."); return { tails }; }
    const s = this.step(tails, "log", level === "info" ? `Log ${short(message.replace(/\{\{.*?\}\}/g, "…"), 30)}` : `Log ${level}`, { level, message, includePayload }, L);
    this.ok(L, `log (${level}) "${short(message, 80)}"`);
    return { tails: s.tails };
  }

  answer(rest: string, L: number, tails: Tail[]): { tails: Tail[]; terminal: boolean } | null {
    let t = rest.trim().replace(/^(?:back\s+)?(?:with\s+)?(?:http\s+)?(?:status(?:\s+code)?|code)\s+/i, "");
    let status = 200, statusSaid = false;
    let m: RegExpExecArray | null;
    if ((m = /^(\d{3})\b\s*/.exec(t))) { status = Number(m[1]); statusSaid = true; t = t.slice(m[0].length); }
    for (const [re, code] of STATUS_WORDS) { const w = /^([a-z ]+?)(?=\s+with\b|\s*$|\s*,)/i.exec(t); if (w && re.test(w[1].trim())) { if (!statusSaid) status = code; t = t.slice(w[0].length).trim(); break; } }
    t = t.replace(/^(?:\(|-)\s*[a-z ]+\)?\s*/i, (x) => (/^\(?\s*-?\s*(ok|created|accepted|not found|bad request|conflict)\b/i.test(x) ? "" : x)).trim();
    t = t.replace(/^(?:,\s*)?(?:with|containing|and|:)\s*/i, "").trim();
    let body = "$", label = "the current data";
    if (t) {
      const b = this.body4answer(t, L);
      if (!b) return null;
      body = b.expr; label = b.label;
    } else if (!statusSaid) return null;
    this.step(tails, "respond", `Answer ${status}`, { status: String(status), body, headers: [] }, L);
    this.ok(L, `answer ${status} with ${label}`);
    return { tails: [], terminal: true };
  }
  body4answer(t: string, L = 0): { expr: string; label: string } | null {
    let m: RegExpExecArray | null;
    if (/^(?:nothing|no body|an empty body|empty)$/i.test(t)) return { expr: "null", label: "no body" };
    if ((m = /^(?:(?:a|the)\s+)?(message|error|text|reason|detail)\s+"([^"]*)"$/i.exec(t))) { const k = lc(m[1]) === "text" ? "message" : lc(m[1]); return { expr: `{ ${jstr(k)}: ${this.tplExpr(m[2])} }`, label: `{ "${k}": "${m[2]}" }` }; }
    const q = unquote(t);
    if (q !== null) return { expr: `{ "message": ${this.tplExpr(q)} }`, label: `{ "message": "${q}" }` };
    if (/^[{[]/.test(t)) { try { JSON.parse(t); return { expr: t, label: "this JSON" }; } catch { return /\{\{|\$/.test(t) ? { expr: t, label: "this JSON" } : null; } }
    if (/^(?:the\s+)?error$/i.test(t)) return { expr: "{ \"error\": { \"message\": $error.message } }", label: "the error message" };
    // a thing no earlier step produced ("Answer 200 with the lead" after "Call POST …"): never a silent reference
    const said = splitOutside(t, /\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/i).map((p) => p.trim()).filter(Boolean);
    const unknown = said.filter((p) => { const r = this.ref(p, false); return !!r?.payloadPath && !this.aliases.length && !this.payloadFields.has(r.payloadPath) && !this.payloadFields.has(r.payloadPath.split(".")[0]); });
    if (unknown.length === 1 && said.length === 1 && this.genericCall) {
      const call = this.genericCall;
      const old = String(call.config.resultVar ?? "");
      const thing = stripArticles(unknown[0]);
      const wanted = this.varFor(thing);
      const usedLater = this.nodes.some((n) => n !== call && JSON.stringify(n.config).includes(`$vars.${old}`));
      const name = usedLater || !IDENT.test(wanted) ? old : wanted;
      if (name !== old) {
        call.config.resultVar = name; for (const [k, v] of this.vars) if (v === old) this.vars.delete(k);
        for (const l of this.lines.values()) if (l.nodeIds.includes(call.id) && l.understood) l.understood = l.understood.replace(`kept as ${old}`, `kept as ${name}`);
      }
      this.remember(thing, name);
      if (L) this.ok(L, `"${unknown[0]}" is the answer of "${call.name}" (kept as ${name})`);
      return { expr: `$vars.${seg(name)}`, label: `the ${thing} (the answer of "${call.name}")` };
    }
    if (L) for (const u of unknown) this.warn(L, `Nothing earlier produces "${stripArticles(u)}", so it is read as a field of the incoming data. If it is the answer of a call, name it on the call line (for example "Create the ${stripArticles(u)} in …").`);
    const fields = this.fieldList(t);
    if (!fields) return null;
    if (fields.length === 1 && fields[0].whole) return { expr: fields[0].expr, label: fields[0].label };
    const keys = new Set<string>();
    const parts = fields.map((f) => { let k = f.key || "value"; let n = 2; while (keys.has(k)) k = `${f.key}${n++}`; keys.add(k); return `${jstr(k)}: ${f.expr}`; });
    return { expr: `{ ${parts.join(", ")} }`, label: `{ ${fields.map((f, i) => `"${[...keys][i]}": ${f.label}`).join(", ")} }` };
  }
  /** Quoted text in an expression, with {field} parts filled in. */
  tplExpr(text: string): string {
    const parts: string[] = [];
    let last = 0;
    for (const x of text.matchAll(/\{([^{}]+)\}/g)) {
      const r = this.ref(x[1]);
      if (!r) continue;
      if (x.index! > last) parts.push(jstr(text.slice(last, x.index)));
      parts.push(`$string(${r.expr})`);
      last = x.index! + x[0].length;
    }
    if (last < text.length || !parts.length) parts.push(jstr(text.slice(last)));
    return parts.join(" & ");
  }

  flowCall(name: string, withText: string | undefined, L: number, tails: Tail[], mods: string[]): { tails: Tail[] } {
    const f = this.find(this.ctx.flows ?? [], name);
    const input = withText ? this.value(withText) : null;
    if (withText && !input) { this.fail(L, `"${short(withText, 60)}" is not a field this reader can find.`); return { tails }; }
    const varName = this.varFor(`${name} result`);
    const s = this.step(tails, "flow.call", `Run flow ${short(name, 40)}`, { flow: f?.id ?? "", entry: "manual", input: input?.expr ?? "$", resultTarget: "variable", resultVar: varName }, L);
    this.lastCall = s.node; this.genericCall = s.node; this.remember(`${name} result`, varName);
    if (f) this.ok(L, `run the flow "${f.name}" with ${input?.label ?? "the current data"}; its answer is kept as ${varName}`);
    else { this.ok(L, `run a flow named "${name}"`); this.warn(L, `There is no flow called "${name}" on this server yet; choose it on the step.`); }
    for (const mod of mods) this.modifier(mod, L);
    return { tails: s.tails };
  }

  find<T extends { name: string }>(list: T[], name: string): T | undefined {
    const n = norm(name);
    if (!n) return undefined;
    return list.find((x) => norm(x.name) === n)
      ?? list.find((x) => norm(x.name).startsWith(n) && n.length >= 3)
      ?? list.find((x) => n.startsWith(norm(x.name)) && norm(x.name).length >= 3)
      ?? list.find((x) => norm(x.name).includes(n) && n.length >= 4);
  }

  // -------------------------------------------------- calls
  call(text: string, L: number, tails: Tail[]): { tails: Tail[] } | null {
    let m: RegExpExecArray | null;
    let kind: VerbKind | null = null, rest = "";
    if ((m = /^(?:look\s*up|lookup|find|search\s+for|search|get|fetch|read|load|retrieve|query|check)\s+(.+)$/i.exec(text))) { kind = "read"; rest = m[1]; }
    else if ((m = /^(?:create|add|register|insert|save|post|submit|send|push|write)\s+(.+)$/i.exec(text))) { kind = "create"; rest = m[1]; }
    else if ((m = /^(?:update|change|modify|edit|patch|upsert)\s+(.+)$/i.exec(text))) { kind = "update"; rest = m[1]; }
    else if ((m = /^(?:delete|remove|cancel)\s+(.+)$/i.exec(text))) { kind = "delete"; rest = m[1]; }
    else if ((m = /^(?:call|invoke|use|hit|notify|run)\s+(.+)$/i.exec(text))) { kind = "call"; rest = m[1]; }
    if (!kind) return null;
    const db = this.database(text, kind, rest, L, tails);
    if (db !== undefined) return db;

    // with / by tails
    let withText = "", byText = "", whereText = "";
    let c = cutOutside(rest, /\s+with\s+/i); if (c) { rest = c[0]; withText = c[1].trim(); }
    c = cutOutside(rest, /\s+(?:by|using its|using the|for the|matching)\s+(?=\S)/i); if (c && kind !== "call") { rest = c[0]; byText = c[1].trim(); }
    c = cutOutside(rest, /\s+where\s+/i); if (c) { rest = c[0]; whereText = c[1].trim(); }
    rest = rest.trim();
    if (whereText && !byText) { const w = /^(.+?)\s+(?:is|=|equals)\s+(.+)$/i.exec(whereText); if (w) byText = w[1]; }

    // explicit HTTP: call GET /path on CONNECTION / call POST https://…
    if ((m = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)(?:\s+(?:on|via|using|at|through)\s+(?:the\s+)?(.+))?$/i.exec(rest))) return this.httpCall(m[1].toUpperCase(), m[2], m[3]?.trim(), withText, byText, L, tails, `${m[1].toUpperCase()} ${m[2]}`);

    let entity = "", system = "", opWords: string[] = [];
    if (kind === "call") {
      // longest known system name at the start, the rest names the operation
      const words = rest.replace(/^(?:the\s+)/i, "").split(/\s+/);
      let found = -1;
      for (let n = words.length; n >= 1 && found < 0; n--) if (this.system(words.slice(0, n).join(" "), true)) found = n;
      for (let n = 1; n <= words.length && found < 0; n++) if (this.system(words.slice(0, n).join(" "))) found = n;
      if (found < 0) found = 1;
      system = words.slice(0, found).join(" ").replace(/^"|"$/g, "");
      opWords = words.slice(found);
      if (opWords[0] && /^(?:to|and)$/i.test(opWords[0])) opWords = opWords.slice(1);
      entity = opWords.join(" ");
    } else {
      m = /^(?:(?:the|a|an|all|every|new)\s+)*(.+?)\s+(?:in|from|on|to|into|at|via|using|through|with)\s+(?:the\s+)?(.+)$/i.exec(rest);
      if (!m) return null;
      entity = m[1].trim(); system = m[2].trim().replace(/^"|"$/g, "");
      opWords = [];
    }
    if (!system) return null;
    const sys = this.system(system);
    const method = VERB_METHOD[kind];
    const want = [...tokens(entity), ...(VERB_WORDS[kind] ?? []), ...opWords.flatMap(tokens)];
    const entityName = entity ? entity : `${system} result`;
    const varName = this.varFor(kind === "call" && opWords.length ? `${system} ${opWords.join(" ")}` : entityName);
    const verbLabel = kind === "read" ? "Look up" : kind === "create" ? "Create" : kind === "update" ? "Update" : kind === "delete" ? "Delete" : "Call";
    const title = kind === "call" ? `Call ${system}${opWords.length ? " " + opWords.join(" ") : ""}` : `${verbLabel} ${stripArticles(entity)} in ${system}`;
    const withRefs = withText ? this.fieldList(withText) : [];
    const byRefs = byText ? this.fieldList(byText) : [];
    if (withText && !withRefs) { this.fail(L, `After "with": "${short(withText, 60)}" is not a list of fields.`); return { tails }; }
    if (byText && !byRefs) { this.fail(L, `After "by": "${short(byText, 60)}" is not a field.`); return { tails }; }
    const fields = [...(byRefs ?? []), ...(withRefs ?? [])];

    if (sys?.kind === "connector") {
      const conn = sys.connector;
      const pick = this.pickOperation(conn.operations ?? [], opWords, want, method, kind);
      if (!pick) { this.fail(L, `${conn.name} has no operation that matches "${short(text, 50)}". Its operations: ${(conn.operations ?? []).map((o) => o.name || o.id).slice(0, 8).join(", ")}.`); return { tails }; }
      const op = pick.op;
      const cfg: Record<string, unknown> = { failOnStatus: true, output: "body", timeoutMs: LESSON_DEFAULTS.timeoutMs, retries: LESSON_DEFAULTS.retries, retryDelaysMs: LESSON_DEFAULTS.retryDelaysMs, resultTarget: "variable", resultVar: varName };
      const connection = conn.defaultConnectionId || this.connectionFor(conn.name, "http")?.id || "";
      cfg.connection = connection;
      const used = new Set<Ref>();
      for (const p of op.params ?? []) {
        const pk = tokens(p.key).join(" "), pl = tokens(p.label || "").join(" ");
        const hit = fields.find((f) => { const fk = tokens(f.key).join(" "); const tail = tokens(f.key).slice(-1).join(" "); return fk === pk || fk === pl || (pk && tail === pk) || (f.payloadPath && tokens(f.payloadPath).join(" ") === pk); });
        if (hit) { used.add(hit); cfg[p.key] = p.kind === "expr" || p.kind === "code" ? hit.expr : `{{ ${hit.expr} }}`; continue; }
        // "update the contact …" with an {id} parameter: the id of the contact kept above
        const known = entity ? this.vars.get(tokens(entity).join(" ")) : undefined;
        if (known && /^(?:id|.*Id)$/.test(p.key) && (p.key === "id" || norm(p.key) === norm(known + "id"))) { cfg[p.key] = `{{ $vars.${seg(known)}.id }}`; this.ok(L, `${p.label || p.key} = the id of the ${known} kept above`); }
      }
      const s = this.step(tails, `connector:${conn.id}:${op.id}`, title, cfg, L);
      this.lastCall = s.node; this.genericCall = entity ? null : s.node; this.remember(entityName, varName);
      this.ok(L, `${conn.name}: ${op.name || op.id} (${op.method} ${op.path}); the answer is kept as ${varName}`);
      if (pick.alternatives.length) this.warn(L, `Also possible: ${pick.alternatives.join(", ")}. Pick another operation on the step if this is not the one.`);
      const missingParams = (op.params ?? []).filter((p) => p.required && cfg[p.key] === undefined && p.default === undefined).map((p) => p.label || p.key);
      if (missingParams.length) this.warn(L, `Still to fill in on the step: ${missingParams.join(", ")}.`);
      const unused = fields.filter((f) => !used.has(f));
      if (unused.length) {
        if (!["GET", "DELETE", "HEAD"].includes(op.method.toUpperCase()) && !op.bodyTemplate) this.ok(L, `${unused.map((f) => f.payloadPath ?? f.label).join(", ")} ${unused.length === 1 ? "travels" : "travel"} in the body (the incoming data is sent as it is)`);
        else this.warn(L, `${unused.map((f) => f.payloadPath ?? f.label).join(", ")} ${unused.length === 1 ? "is" : "are"} not a parameter of ${op.name || op.id}.`);
      }
      if (!connection) this.need(conn.name, "http", L, s.node.id, `${conn.name} needs a connection that supplies its address and sign-in.`);
      return { tails: s.tails };
    }
    if (sys?.kind === "api") {
      const api = sys.api;
      const pick = this.pickOperation((api.operations ?? []).map((o) => ({ id: o.id, name: o.summary || o.id, method: o.method, path: o.path, params: [] } as ConnectorOperation)), opWords, want, method, kind);
      if (!pick) { this.fail(L, `The migrated API ${api.name} has no operation that matches "${short(text, 50)}".`); return { tails }; }
      const op = pick.op;
      const conn = this.connectionFor(api.name, "http");
      const pathParams = [...op.path.matchAll(/\{([^}]+)\}|:([A-Za-z_]\w*)/g)].map((x) => x[1] ?? x[2]);
      const usedInPath = new Set<Ref>();
      const fill = new Map<string, string>();
      for (const p of pathParams) { const hit = fields.find((f) => !usedInPath.has(f) && tokens(f.key).join(" ") === tokens(p).join(" ")); if (hit) { usedInPath.add(hit); fill.set(p, hit.expr); } }
      const open = pathParams.filter((p) => !fill.has(p));
      const byLeft = (byRefs ?? []).filter((f) => !usedInPath.has(f));
      // "… by FIELD" on an address with one parameter: the field is that parameter
      if (open.length === 1 && byLeft.length === 1) { fill.set(open[0], byLeft[0].expr); usedInPath.add(byLeft[0]); this.ok(L, `{${open[0]}} = ${byLeft[0].label}`); }
      for (const p of pathParams) if (!fill.has(p)) { const r2 = this.ref(p); if (r2) fill.set(p, r2.expr); }
      const url = `${(api.basePath ?? "").replace(/\/+$/, "")}${op.path}`.replace(/\{([^}]+)\}|:([A-Za-z_]\w*)/g, (_a, b: string | undefined, c2: string | undefined) => `{{ ${fill.get(b ?? c2 ?? "") ?? (b ?? c2)} }}`);
      const s = this.httpNode(op.method.toUpperCase(), url, conn?.id ?? "", fields.filter((f) => !usedInPath.has(f)), title, varName, L, tails);
      this.lastCall = s.node; this.remember(entityName, varName);
      this.ok(L, `the migrated API ${api.name}: ${op.method.toUpperCase()} ${op.path}; the answer is kept as ${varName}`);
      if (pick.alternatives.length) this.warn(L, `Also possible: ${pick.alternatives.join(", ")}.`);
      if (!conn) this.need(api.name, "http", L, s.node.id, `The migrated API ${api.name} needs a connection with its address.`, api.baseUrl ? { baseUrl: api.baseUrl } : undefined);
      return { tails: s.tails };
    }
    if (sys?.kind === "flow") return this.flowCall(sys.flow.name, withText || undefined, L, tails, []);
    // a plain HTTP connection, or a system that is not known yet
    const conn = sys?.kind === "connection" ? sys.connection : undefined;
    const path = opWords.length && /^\//.test(opWords[0]) ? opWords[0] : "";
    const s = this.httpNode(method, path, conn?.id ?? "", fields, title, varName, L, tails);
    this.lastCall = s.node; this.remember(entityName, varName);
    this.ok(L, `${method} on ${conn ? `the connection ${conn.name}` : system}; the answer is kept as ${varName}`);
    if (!path) this.warn(L, `Which address on ${conn?.name ?? system}? Fill in the path on the step (for example /contacts/search), or write "Call ${method} /path on ${conn?.name ?? system}".`);
    if (!conn) this.need(system, "http", L, s.node.id, `There is no connection or connector called "${system}" yet.`);
    return { tails: s.tails };
  }

  httpCall(method: string, address: string, connName: string | undefined, withText: string, byText: string, L: number, tails: Tail[], title: string): { tails: Tail[] } {
    const fields = [...(byText ? this.fieldList(byText) ?? [] : []), ...(withText ? this.fieldList(withText) ?? [] : [])];
    if ((withText && !this.fieldList(withText)) || (byText && !this.fieldList(byText))) { this.fail(L, "The fields after \"with\" or \"by\" were not understood."); return { tails }; }
    const full = /^https?:\/\//i.test(address);
    const conn = connName ? this.connectionFor(connName, "http") : undefined;
    const url = address.replace(/\{([^}]+)\}/g, (_a, p: string) => `{{ ${this.ref(p)?.expr ?? p} }}`);
    const varName = this.varFor(conn ? `${conn.name} result` : "response");
    const s = this.httpNode(method, url, conn?.id ?? "", fields, connName ? `${title} on ${connName}` : title, varName, L, tails);
    this.lastCall = s.node; this.genericCall = s.node; this.remember(conn ? `${conn.name} result` : "response", varName);
    this.ok(L, `${method} ${address}${conn ? ` on ${conn.name}` : ""}; the answer is kept as ${varName}`);
    if (!full && !conn) this.need(connName || "backend", "http", L, s.node.id, connName ? `There is no connection called "${connName}" yet.` : `"${address}" is a path, so the step needs a connection that supplies the address.`);
    return { tails: s.tails };
  }

  httpNode(method: string, url: string, connection: string, fields: Ref[], title: string, varName: string, L: number, tails: Tail[]) {
    const query: { key: string; value: string }[] = [];
    let body: unknown = undefined, bodyMode = "none";
    const read = method === "GET" || method === "DELETE";
    if (read) for (const f of fields) query.push({ key: f.key, value: `{{ ${f.expr} }}` });
    else if (fields.length === 1 && fields[0].whole) { bodyMode = "json"; body = `{{ ${fields[0].expr} }}`; }
    else if (fields.length) { bodyMode = "json"; body = Object.fromEntries(fields.map((f) => [f.key, `{{ ${f.expr} }}`])); }
    else { bodyMode = "json"; body = "{{ $ }}"; }
    const cfg: Record<string, unknown> = { connection, method, url, query, headers: [], forwardHeaders: [], bodyMode, failOnStatus: true, responseMode: "auto", output: "body", timeoutMs: LESSON_DEFAULTS.timeoutMs, retries: LESSON_DEFAULTS.retries, retryDelaysMs: LESSON_DEFAULTS.retryDelaysMs, resultTarget: "variable", resultVar: varName };
    if (body !== undefined) cfg.body = body;
    return this.step(tails, "http.request", title, cfg, L);
  }

  system(name: string, strict = false): { kind: "connector"; connector: ConnectorDef } | { kind: "api"; api: DescribeApi } | { kind: "connection"; connection: DescribeConnection } | { kind: "flow"; flow: DescribeFlowRef } | null {
    const cleaned = name.replace(/\s+(?:system|service|api|crm)$/i, "").trim() || name;
    if (strict) {
      const eq = <T extends { name: string }>(list: T[]) => list.find((x) => norm(x.name) === norm(name) || norm(x.name) === norm(cleaned));
      const c = eq(this.ctx.connectors ?? []); if (c) return { kind: "connector", connector: c };
      const a = eq(this.ctx.apis ?? []); if (a) return { kind: "api", api: a };
      const k = eq((this.ctx.connections ?? []).filter((x) => x.type === "http")); if (k) return { kind: "connection", connection: k };
      const f = eq(this.ctx.flows ?? []); if (f) return { kind: "flow", flow: f };
      return null;
    }
    for (const n of [name, cleaned]) {
      const c = this.find(this.ctx.connectors ?? [], n); if (c) return { kind: "connector", connector: c };
      const a = this.find(this.ctx.apis ?? [], n); if (a) return { kind: "api", api: a };
      const k = this.find((this.ctx.connections ?? []).filter((x) => x.type === "http"), n); if (k) return { kind: "connection", connection: k };
    }
    const f = (this.ctx.flows ?? []).find((x) => norm(x.name) === norm(name));
    if (f) return { kind: "flow", flow: f };
    return null;
  }
  connectionFor(name: string, type?: string): DescribeConnection | undefined {
    const list = (this.ctx.connections ?? []).filter((c) => !type || c.type === type);
    return list.find((c) => norm(c.name) === norm(name)) ?? this.find(list, name);
  }
  pickOperation(ops: ConnectorOperation[], opWords: string[], want: string[], method: string, kind: VerbKind): { op: ConnectorOperation; alternatives: string[] } | null {
    if (!ops.length) return null;
    const asked = norm(opWords.join(""));
    if (asked) { const exact = ops.find((o) => norm(o.id) === asked || norm(o.name || "") === asked); if (exact) return { op: exact, alternatives: [] }; }
    const wantSet = new Set(want.filter((w) => w.length > 1));
    const scored = ops.map((o) => {
      const have = new Set([...tokens(o.id), ...tokens(o.name || ""), ...tokens(o.description || ""), ...tokens(o.path.replace(/\{[^}]+\}/g, ""))]);
      let s = 0;
      for (const w of wantSet) if (have.has(w)) s += VERB_WORDS[kind].includes(w) ? 1 : 2;
      if (kind !== "call" && o.method.toUpperCase() === method) s += 1.5;
      if (kind === "update" && o.method.toUpperCase() === "PATCH") s += 1.5;
      return { o, s };
    }).sort((a, b) => b.s - a.s);
    const best = scored[0];
    if (!best || best.s < 2.5) return null;
    const alternatives = scored.slice(1).filter((x) => x.s === best.s).map((x) => x.o.name || x.o.id);
    return { op: best.o, alternatives };
  }

  // -------------------------------------------------- databases
  /** undefined: not a database line; null: looked like one but was not understood (already reported). */
  database(text: string, kind: VerbKind, rest: string, L: number, tails: Tail[]): { tails: Tail[] } | null | undefined {
    let m: RegExpExecArray | null;
    const dbAt = /\s+(?:in|on|from|of|using)\s+(?:the\s+)?(?:(mysql|mariadb|sql\s*server|mssql|postgres(?:ql)?|pg)\s+)?(?:database|db)\s+"?([\w.-]+)"?|\s+(?:in|on|from|using)\s+(?:the\s+)?"?([\w.-]+)"?\s+(?:(mysql|mariadb|sql\s*server|mssql|postgres(?:ql)?)\s+)?(?:database|db)\b/i;
    const procM = /^(?:run|call|execute|exec)\s+(?:the\s+)?(?:stored\s+)?procedure\s+"?([\w.$]+)"?/i.exec(text);
    const sqlM = /^(?:run|execute|query)\s+(?:the\s+)?(?:sql|query|statement)\s+"([^"]+)"/i.exec(text);
    const hasTable = /\btable\s+[\w."]+/i.test(text);
    const at = cutOutside(text, dbAt);
    if (!at && !procM && !sqlM && !hasTable) return undefined;
    if (!at) {
      if (procM || sqlM || hasTable) { this.fail(L, "Say which database, for example \"… in database crm\"."); return null; }
      return undefined;
    }
    const typeWord = lc(at[2][1] ?? at[2][4] ?? "");
    const dbName = at[2][2] ?? at[2][3] ?? "";
    const typeHint = /mysql|maria/.test(typeWord) ? "mysql" : /sql\s*server|mssql/.test(typeWord) ? "mssql" : /postgres|pg/.test(typeWord) ? "postgres" : "";
    const conns = (this.ctx.connections ?? []).filter((c) => DB_TYPES.includes(c.type) && (!typeHint || c.type === typeHint));
    const conn = conns.find((c) => norm(c.name) === norm(dbName)) ?? this.find(conns, dbName);
    const type = conn?.type ?? (typeHint || "mysql");
    const nodeType = DB_NODE[type];
    const ph = (i: number) => (type === "mysql" ? "?" : type === "mssql" ? `@p${i}` : `$${i}`);
    const before = at[0].trim(), after = at[1].trim();
    const whole = `${before} ${after}`.trim();
    const col = (r: Ref) => (r.payloadPath && !r.payloadPath.includes(".") && !/\s/.test(r.payloadPath) && (r.words?.length ?? 0) <= 1 ? snake([r.payloadPath]) : snake(r.words?.length ? r.words : [r.key]));
    const ident = (s: string) => (/^[A-Za-z_][\w.$]*$/.test(s) ? s : null);
    const tableOf = (s: string) => { const t = /\btable\s+"?([\w.$]+)"?/i.exec(s) ?? /\b(?:into|from)\s+(?:the\s+)?"?([\w.$]+)"?(?:\s+table)?/i.exec(s); return t ? ident(t[1]) : null; };
    const finish = (sql: string | null, params: string[], title: string, resultMode: string, entity: string, extra: Record<string, unknown> = {}, understood = ""): { tails: Tail[] } => {
      const varName = this.varFor(entity);
      const cfg: Record<string, unknown> = { connection: conn?.id ?? "", ...(type === "postgres" ? {} : { operation: "query", maxRows: 1000, timeoutSeconds: 60 }), sql: sql ?? "", params, resultMode, resultTarget: "variable", resultVar: varName, ...extra };
      const s = this.step(tails, nodeType, title, cfg, L);
      this.lastCall = s.node; this.genericCall = null; this.remember(entity, varName);
      this.ok(L, `${understood || title} on ${DB_LABEL[type]}${conn ? ` (${conn.name})` : ""}: ${sql ?? String(extra.procedure ?? "")}; the result is kept as ${varName}`);
      if (!conn) {
        this.need(dbName, type, L, s.node.id, `There is no ${typeHint ? DB_LABEL[type] + " " : ""}database connection called "${dbName}" yet.`);
        if (!typeHint) this.warn(L, `The kind of database was not said, so MySQL is assumed. Write "in the SQL Server database ${dbName}" or "in the Postgres database ${dbName}" to change it.`);
      }
      return { tails: s.tails };
    };
    const refsOf = (s: string): Ref[] | null => this.fieldList(s);
    const whereOf = (s: string, start: number): { sql: string; params: string[]; words: string } | null => {
      const parts = splitOutside(s, /\s+and\s+/i);
      const sqls: string[] = [], params: string[] = [];
      let i = start;
      for (const p of parts) {
        const w = /^(.+?)\s+(?:is|=|equals)\s+(.+)$/i.exec(p.trim());
        if (w) { const r = this.ref(w[1]); if (!r) return null; let v = this.value(w[2]); if (!v) { try { v = { expr: this.literal(w[2]), label: w[2] }; } catch { return null; } } sqls.push(`${col(r)} = ${ph(i++)}`); params.push(v.expr); continue; }
        const r = this.ref(p); if (!r) return null; sqls.push(`${col(r)} = ${ph(i++)}`); params.push(r.expr);
      }
      return { sql: sqls.join(" and "), params, words: s };
    };

    if (sqlM) {
      const statement = sqlM[1];
      const withC = cutOutside(after, /^with\s+/i);
      const params = withC ? refsOf(withC[1]) : [];
      if (withC && !params) { this.fail(L, "The fields after \"with\" were not understood."); return null; }
      return finish(statement, (params ?? []).map((p) => p.expr), `Run SQL on ${dbName}`, /^\s*select\b/i.test(statement) ? "rows" : "count", `${dbName} result`);
    }
    if (procM) {
      const name = procM[1];
      const withC = /(?:^|\s)with\s+(.+)$/i.exec(after) ?? /(?:^|\s)with\s+(.+)$/i.exec(before.slice(procM[0].length));
      const params = withC ? refsOf(withC[1]) : [];
      if (withC && !params) { this.fail(L, "The fields after \"with\" were not understood."); return null; }
      const ps = params ?? [];
      if (type === "postgres") return finish(`call ${name}(${ps.map((_p, i) => ph(i + 1)).join(", ")})`, ps.map((p) => p.expr), `Procedure ${name}`, "rows", `${name} result`);
      if (type === "mssql") return finish(null, [], `Procedure ${name}`, "rows", `${name} result`, { operation: "procedure", procedure: name, procInputs: ps.map((p) => ({ key: col(p), value: p.expr })), procOutputs: [] }, `run the procedure ${name}`);
      return finish(null, ps.map((p) => p.expr), `Procedure ${name}`, "rows", `${name} result`, { operation: "procedure", procedure: name }, `run the procedure ${name}`);
    }
    // INSERT
    if ((m = /^(?:insert|add|write|save|create)\s+(?:(?:a|an|the|new)\s+)*(?:(?:row|record)\s+)?(?:(.+?)\s+)?(?:into|to|in)\s+(?:the\s+)?(?:table\s+)?"?([\w.$]+)"?(?:\s+table)?(?:\s+with\s+(.+))?$/i.exec(whole)) && kind === "create") {
      const table = ident(m[2]);
      if (!table) return undefined;
      const withText = m[3] ?? (/^with\s+(.+)$/i.exec(after)?.[1]);
      const refs = withText ? refsOf(withText) : null;
      if (!refs) { this.fail(L, "Say which fields go in the row: \"… with first name, last name, email\"."); return null; }
      const cols = refs.map(col);
      const entity = m[1] && !/^(?:row|record)$/i.test(m[1]) ? stripArticles(m[1]) : `${singular(table)} insert`;
      return finish(`insert into ${table} (${cols.join(", ")}) values (${cols.map((_c, i) => ph(i + 1)).join(", ")})`, refs.map((r) => r.expr), `Insert into ${table}`, "count", entity);
    }
    // UPDATE
    if (kind === "update" && (m = /^(?:update|change)\s+(?:the\s+)?(?:table\s+)?"?([\w.$]+)"?(?:\s+table)?\s+(?:set|with)\s+(.+?)\s+(?:by|where|for)\s+(.+)$/i.exec(whole))) {
      const table = ident(m[1]);
      const refs = refsOf(m[2]);
      if (!table || !refs) { this.fail(L, "An update reads \"Update table T in database D set FIELD, FIELD by FIELD\"."); return null; }
      const w = whereOf(m[3], refs.length + 1);
      if (!w) { this.fail(L, `"${short(m[3], 50)}" after "by" was not understood.`); return null; }
      return finish(`update ${table} set ${refs.map((r, i) => `${col(r)} = ${ph(i + 1)}`).join(", ")} where ${w.sql}`, [...refs.map((r) => r.expr), ...w.params], `Update ${table}`, "count", `${singular(table)} update`);
    }
    // DELETE
    if (kind === "delete" && (m = /^(?:delete|remove)\s+(?:(?:the\s+)?(?:rows?|records?|.+?)\s+)?from\s+(?:the\s+)?(?:table\s+)?"?([\w.$]+)"?(?:\s+table)?\s+(?:by|where|for)\s+(.+)$/i.exec(whole))) {
      const table = ident(m[1]);
      const w = table ? whereOf(m[2], 1) : null;
      if (!table || !w) { this.fail(L, "A delete reads \"Delete from table T in database D by FIELD\"."); return null; }
      return finish(`delete from ${table} where ${w.sql}`, w.params, `Delete from ${table}`, "count", `${singular(table)} delete`);
    }
    // SELECT
    if (kind === "read" || kind === "call") {
      const table = tableOf(whole);
      if (!table) { this.fail(L, "Say which table, for example \"… in table guests in database crm by email\"."); return null; }
      const all = /\ball\b|\brows\b|\brecords\b|\blist\b/i.test(whole);
      const entM = /^(?:look\s*up|lookup|find|search\s+for|search|get|fetch|read|load|retrieve|query|check)\s+(?:(?:the|a|an|all)\s+)*(.+?)\s+(?:in|from)\s+(?:the\s+)?(?:table\s+)/i.exec(whole);
      const entity = entM && !/^(?:rows?|records?)$/i.test(entM[1]) ? entM[1] : all ? table : singular(table);
      const byM = /\s(?:by|where|for)\s+(.+)$/i.exec(whole);
      let where: { sql: string; params: string[] } | null = null;
      if (byM) { where = whereOf(byM[1].replace(/\s+(?:in|on)\s+(?:the\s+)?(?:table|database)\b.*$/i, ""), 1); if (!where) { this.fail(L, `"${short(byM[1], 50)}" after "by" / "where" was not understood.`); return null; } }
      const single = !all && (!!byM) && !/s$/i.test(stripArticles(entity));
      return finish(`select * from ${table}${where ? ` where ${where.sql}` : ""}`, where?.params ?? [], `${single ? "Find" : "Read"} ${stripArticles(entity)}`, single ? "first" : "rows", stripArticles(entity));
    }
    this.fail(L, "This database line was not understood.");
    return null;
  }
}

// ---------------------------------------------------------------- phrase patterns
const END = /^(?:end(?:\s+(?:if|for(?:\s+each)?|each|loop|of\s+(?:the\s+)?(?:loop|condition|if)))?|done|next|end\s+for\s+each)$/i;
const OTHERWISE = /^(?:otherwise|else|or else|if not)(?:\s*[,:]\s*|\s+|$)(.*)$/i;
const IF = /^(?:if|in case|when|whenever|only if|unless__never)\s+(.+)$/i;
const FAIL = /^(?:if|when|whenever|in case)\s+(?:(?:the|that|this|it|any|a|anything|something)\s+)?(?:[\w-]+\s+){0,3}?(?:fails|failed|errors|errored|returns an error|gives an error|goes wrong|times out|is down|does not answer|doesn't answer|cannot be reached|can't be reached)\s*(?:,\s*|\s+then\s+|\s*:\s*|$)(.*)$/i;
const ONERR = /^on\s+(?:an?\s+)?(?:error|failure)\s*(?:,\s*|\s*:\s*|\s+then\s+|$)(.*)$/i;
const RETRY = /^(?:and\s+)?(?:retry|repeat|try again)\s+(?:it\s+|the call\s+)?(?:up to\s+)?(\d+|once|twice|one|two|three|four|five)(?:\s*times?)?(?:\s*,?\s*(?:waiting|wait|with|every|pausing)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|minutes?)\s*(?:between(?:\s+(?:tries|attempts|retries))?|apart)?)?$/i;
const TRY_TIMES = /^try\s+(?:it\s+)?(?:up to\s+)?(\d+|two|three|four|five)\s+times(?:\s*,?\s*(?:waiting|wait|with|every|pausing)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\s*(?:between(?:\s+(?:tries|attempts))?|apart)?)?$/i;
// production lessons (lessons.ts): L3 background sends, L2 shared/cached reads, L1 session reuse
const BACKGROUND_RE = /^(?:and\s+)?(?:(?:send|run|do|make)\s+(?:it|this|that|them|the\s+[\w-]+(?:\s+[\w-]+)?)\s+in\s+the\s+background|(?:don'?t|do\s+not)\s+wait(?:\s+for\s+(?:it|this|that|the\s+[\w-]+(?:\s+[\w-]+)?))?|in\s+the\s+background|(?:send|run)\s+in\s+the\s+background|without\s+waiting)$/i;
const CACHE_RE = /^(?:and\s+)?(?:cache|keep)\s+(?:it|this|that|the\s+(?:answer|result|response|reply|data))\s+for\s+(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?)$|^(?:and\s+)?cache\s+(?:it\s+)?for\s+(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?)$/i;
const SHARE_RE = /^(?:and\s+)?share\s+(?:identical|the\s+same|duplicate)\s+(?:calls|requests)$/i;
const REUSE_RE = /^(?:and\s+)?(?:(?:reuse|re-use|keep)\s+the\s+(?:session|token|login)(?:\s+for\s+(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?))?|log\s*in\s+once|login\s+once)$/i;
const TIMEOUT = /^(?:time\s*out|timeout|give up)\s+after\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|minutes?|mins?)$/i;
const FOREACH = /^(?:for\s+(?:each|every|all)|loop\s+(?:over|through)\s+(?:each|every)|go\s+through\s+(?:each|every))\s+(?<item>[A-Za-z_][\w-]*(?:\s+[A-Za-z_][\w-]*)?)\s+(?:in|of|from)\s+(?<list>.+?)(?:\s*[,:]\s*(?<action>.*)|\s+do\s+(?<action2>.+))?$/i;
const FOREACH_OF = /^(?:for\s+each\s+of|loop\s+(?:over|through)|go\s+through)\s+(?<list>.+?)(?:\s*[,:]\s*(?<action>.*))?$/i;
const MAP = /^map\s*:\s*|^map\s+(?=\S+\s+(?:from|=|<-)\s)/i;
const MAP_BLOCK = /^map\s+(?:the\s+)?(.+?)\s*(?:to|into|as)?\s*:\s*$/i;
const LOG = /^(?:log|write\s+(?:to|in)\s+the\s+log|record\s+in\s+the\s+log)\b\s*(?:(?:a|an)\s+)?(debug|info|warning|warn|error)?\s*(?:message|line)?\s*:?\s*(.*)$|^(warn|debug)\s+(.+)$/i;
const ANSWER = /^(?:answer|respond|reply|return|send\s+back|send\s+the\s+response)\b\s*(.*)$/i;
const SET = /^(?:set|let)\s+(?:the\s+)?(?:variable\s+)?([A-Za-z_][\w-]*(?:\s+[A-Za-z_][\w-]*){0,3}?)\s+(?:to|=|be)\s+(.+)$/i;
const REMEMBER = /^(?:remember|keep|store)\s+(.+?)\s+as\s+(?:the\s+)?(?:variable\s+)?([A-Za-z_][\w-]*)$/i;
const QUEUE = /^(?:when(?:ever)?|on|if|once)\s+(?:(?:a|an|the)\s+)?(?:new\s+)?(?:message|event|record)s?\s+(?:arrives?|comes?(?:\s+in)?|is\s+(?:received|published|posted))\s+(?:on|in|from|to)\s+(?:the\s+)?(?:(?<kind1>queue|topic|subscription)\s+)?"?(?<name>[\w.\-/:]+)"?(?:\s+(?<kind2>queue|topic|subscription))?$/i;
function isOpener(t: string): boolean {
  if (FAIL.test(t) || ONERR.test(t)) return !/(?:,|then|:)\s*\S/.test(t.replace(/^[^,:]*?(fails|failed|errors|wrong|error|failure)/i, ""));
  if (/^(?:if|in case|when)\s+/i.test(t) && !/^(?:when\s+)?(?:GET|POST|PUT|PATCH|DELETE)\b/i.test(t.replace(/^when\s+/i, ""))) return /:\s*$/.test(t) || !/,|\bthen\b/i.test(maskQuotes(t));
  if (FOREACH.test(t) || FOREACH_OF.test(t)) { const m = FOREACH.exec(t) ?? FOREACH_OF.exec(t); return !(m?.groups?.action || m?.groups?.action2); }
  if (MAP_BLOCK.test(t)) return true;
  return false;
}
const STEP_START = /^(?:then\s+)?(?:look\s*up|lookup|find|search|get|fetch|read|load|retrieve|query|check|create|add|register|insert|save|post|submit|send|push|write|update|change|modify|edit|patch|upsert|delete|remove|cancel|call|invoke|use|hit|notify|run|log|warn|answer|respond|reply|return|set|let|remember|keep|store|wait|pause|stop|end the flow|fail|raise|throw|reject|require|ensure|make sure|convert|map|if|for each|retry)\b/i;
function looksLikeStep(s: string): boolean { return STEP_START.test(s.trim()); }

// ---------------------------------------------------------------- layout (left to right, like the canvas' Tidy up)
function layout(nodes: FlowNode[], edges: FlowEdge[]) {
  const ids = nodes.map((n) => n.id);
  const outs = new Map<string, { to: string; port: string }[]>();
  const indeg = new Map<string, number>(ids.map((i) => [i, 0]));
  const order = (port: string) => (port === "out" || port === "each" || port === "try" ? 0 : port.startsWith("case:") ? 1 + Number(port.slice(6).replace(/\D/g, "") || 0) / 100 : port === "otherwise" ? 2 : port === "done" ? 3 : port === "error" || port === "catch" ? 4 : 5);
  for (const e of edges) { const l = outs.get(e.from) ?? []; l.push({ to: e.to, port: e.fromPort }); outs.set(e.from, l); indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1); }
  for (const l of outs.values()) l.sort((a, b) => order(a.port) - order(b.port));
  const col = new Map<string, number>(ids.map((i) => [i, 0]));
  const deg = new Map(indeg);
  const queue = ids.filter((i) => (deg.get(i) ?? 0) === 0);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const { to } of outs.get(cur) ?? []) { col.set(to, Math.max(col.get(to) ?? 0, (col.get(cur) ?? 0) + 1)); deg.set(to, (deg.get(to) ?? 0) - 1); if (deg.get(to) === 0) queue.push(to); }
  }
  const row = new Map<string, number>();
  const colNext = new Map<number, number>();
  let cursor = 0;
  const place = (id: string): number => {
    if (row.has(id)) return row.get(id)!;
    const c = col.get(id) ?? 0;
    row.set(id, -1);
    const kids = (outs.get(id) ?? []).map((k) => k.to).filter((k) => !row.has(k) && (col.get(k) ?? 0) > c);
    let r: number;
    if (!kids.length) r = Math.max(cursor, colNext.get(c) ?? 0);
    else { r = place(kids[0]); for (const k of kids.slice(1)) place(k); r = Math.max(r, colNext.get(c) ?? 0); }
    row.set(id, r);
    colNext.set(c, r + 1);
    if (!kids.length) cursor = Math.max(cursor, r + 1);
    return r;
  };
  for (const s of [...ids.filter((i) => (indeg.get(i) ?? 0) === 0), ...ids]) if (!row.has(s)) { place(s); cursor = Math.max(cursor, ...Array.from(colNext.values())); }
  for (const n of nodes) n.position = { x: 60 + (col.get(n.id) ?? 0) * 300, y: 60 + (row.get(n.id) ?? 0) * 150 };
}

// ---------------------------------------------------------------- entry point
/** Reads a description and returns a draft flow, line by line. Deterministic: the same text and context
 *  always give the same flow. */
export function describeFlow(text: string, ctx: DescribeContext = {}, opts: DescribeOptions = {}): DescribeResult {
  const r = new Reader(ctx, opts);
  let src = String(text ?? "").replace(/\r\n?/g, "\n");
  // one line written with " / " between the steps (as in a chat message)
  if (!src.includes("\n") && / \/ /.test(src)) src = src.split(/\s+\/\s+/).join("\n");
  const raw = src.split("\n");
  const items: Item[] = [];
  let description = "";
  let firstContent = true;
  raw.forEach((rawLine, idx) => {
    const line = idx + 1;
    const { indent, text: t } = cleanLine(rawLine);
    const entry: DescribeLine = { line, text: t, status: "ignored", nodeIds: [] };
    r.lines.set(line, entry);
    if (!t) { firstContent = firstContent && true; return; }
    if (/^(?:#{2,}|\/\/|--\s)/.test(t) || (/^#\s/.test(t) && !firstContent)) { entry.role = "comment"; entry.understood = "a comment (not a step)"; firstContent = false; return; }
    const head = /^(?:#\s*)?(?:flow|name|title)\s*[:\-–]\s*(.+)$/i.exec(t) ?? (firstContent ? /^#\s+(.+)$/.exec(t) : null);
    const desc = /^(?:description|purpose|goal)\s*[:\-–]\s*(.+)$/i.exec(t);
    if (head) { r.name = head[1].trim().replace(/:$/, ""); entry.status = "ok"; entry.role = "header"; entry.understood = `the flow name: ${r.name}`; firstContent = false; return; }
    if (desc) { description = desc[1].trim(); entry.status = "ok"; entry.role = "header"; entry.understood = "the flow description"; firstContent = false; return; }
    if (firstContent && /:\s*$/.test(t) && !isOpener(t) && !OTHERWISE.test(t) && !looksLikeStep(t) && t.length <= 100) {
      r.name = t.replace(/:\s*$/, "").trim(); entry.status = "ok"; entry.role = "header"; entry.understood = `the flow name: ${r.name}`; firstContent = false; return;
    }
    firstContent = false;
    items.push({ line, indent, text: t });
  });
  // indentation relative to the shallowest step line
  const base = items.length ? Math.min(...items.map((i) => i.indent)) : 0;
  for (const i of items) i.indent -= base;
  const named = r.name;
  r.name = named;
  r.block(items, opts.attach ? [{ id: "__start", port: "out" }] : []);
  const entry = r.edges.filter((e) => e.from === "__start").map((e) => e.to);
  r.edges = r.edges.filter((e) => e.from !== "__start");
  for (const l of r.lines.values()) if (l.text && l.status === "ignored" && l.role !== "comment" && items.some((i) => i.line === l.line)) r.fail(l.line);
  layout(r.nodes, r.edges);
  const name = r.name || "Described flow";
  // a sample request for the Test button, with made-up values (never real data)
  const http = r.nodes.find((n) => n.type === "trigger.http");
  if (http) {
    const methods = (http.config.methods as string[]) ?? ["GET"];
    const body: Record<string, unknown> = {};
    for (const f of [...r.payloadFields, ...r.mapFields]) setPath(body, f, sampleValue(f));
    for (const [list, fields] of r.listSamples) { const item: Record<string, unknown> = {}; for (const f of fields) setPath(item, f, sampleValue(f)); setPath(body, list, [item]); }
    const path = String(http.config.path ?? "/").replace(/:([A-Za-z_]\w*)/g, "1");
    http.config.sampleRequest = { method: methods[0], path, ...(methods[0] === "GET" || methods[0] === "DELETE" ? {} : { body }) };
  }
  // the made-up sample also goes on each Map step, so its words can be read against field names
  const mapSample: Record<string, unknown> = {};
  for (const f of [...r.payloadFields, ...r.mapFields]) setPath(mapSample, f, sampleValue(f));
  for (const n of r.nodes) if (n.type === "transform.map" && n.config.input === "$" && Object.keys(mapSample).length) (n.config.mapping as { sampleSource?: unknown }).sampleSource = mapSample;
  const lines = [...r.lines.values()].sort((a, b) => a.line - b.line);
  return {
    flow: { name, ...(description ? { description } : {}), nodes: r.nodes, edges: r.edges },
    lines, missing: [...r.missing.values()], instructions: r.instructions, notes: r.notes,
    ok: lines.every((l) => l.status !== "not-understood") && r.nodes.length > 0,
    entry,
  };
}
