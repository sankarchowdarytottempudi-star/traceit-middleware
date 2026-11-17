// "Describe the flow", requirement-document mode: a whole requirement document (as pasted from Word:
// numbered section headings, prose, tables with one cell per line, JSON samples, a curl) is read by
// FIXED rules into a draft API flow. Every item taken from the document keeps the section and line it
// came from and the steps it made. What the rules cannot turn into a step is never dropped silently:
// it is listed as a decision to take, a conflict (with the choice made), a rule that needs a
// hand-written step, or prose that is not used for steps. No model and no other service is used.
import type { FlowEdge, FlowNode, FlowSettings, MappingRule } from "./types.js";
import type { DescribeContext, DescribeResult, MissingConnection } from "./describe.js";
import { zohoApiFor, zohoCentre, zohoMismatch, zohoTokenUrlFor } from "./zoho.js";

// ---------------------------------------------------------------- result
export interface DocRef { section: string; line: number; }
export interface DocItem { kind: string; title: string; detail: string; ref: DocRef; nodeIds: string[]; }
export interface DocDecision { id: string; text: string; status: string; owner?: string; ref: DocRef; choice?: string; affects?: string; }
export interface DocConflict { text: string; refs: DocRef[]; choice: string; }
export interface DocHandWritten { text: string; ref: DocRef; why: string; }
export interface DocNotUsed { section: string; ref: DocRef; reason: string; }
export interface DocRequest { method: string; path: string; headers: Record<string, string>; body: unknown; }
export interface DocScenario {
  id: string; title: string; ref: DocRef;
  requests: DocRequest[];
  expect: { status: number; code?: string; checks: string[]; words: string };
  standIn?: { tokenExpired?: boolean; timeout?: boolean; existingTags?: string[] };
  derived: boolean;            // false: the inputs could not be derived from the words (shown, not run)
}
export interface DocumentInfo {
  title: string;
  sections: { num: string; title: string; line: number; use: "used" | "partly" | "not used" }[];
  items: DocItem[]; decisions: DocDecision[]; conflicts: DocConflict[]; handWritten: DocHandWritten[]; notUsed: DocNotUsed[];
  scenarios: DocScenario[];
  blocking: string[];          // real problems that stop Create (e.g. no endpoint)
}
export interface DocumentResult extends DescribeResult {
  mode: "document";
  flow: DescribeResult["flow"] & { settings?: Partial<FlowSettings> & { gateway?: Partial<FlowSettings["gateway"]> } };
  doc: DocumentInfo;
}

// ---------------------------------------------------------------- detection
const HEADING = /^(\d{1,2}(?:\.\d{1,2})*)\.?\s(?!\s)([A-Z(][^]{1,90})$/;
function isHeading(raw: string): RegExpExecArray | null {
  const t = raw.replace(/\s+$/, "");
  const m = HEADING.exec(t);
  if (!m) return null;
  const title = m[2].trim();
  if (/[.;:,]$/.test(title) || title.split(/\s+/).length > 10) return null;
  if (/^(?:When|Look|If|Log|Answer|Create|Call|For|Set|Map|Every|Find|Get|Insert|Update|Delete|Run|Retry|Require|Reject|Fail|Wait|Remember|Convert)\b/.test(title)) return null;
  return m;
}
const TABLE_HEADS: { kind: string; heads: RegExp[]; first?: RegExp }[] = [
  { kind: "headers", heads: [/^header$/i, /^mandatory$/i, /^allowed values?$/i, /^notes?$/i] },
  { kind: "errors", heads: [/^http status$/i, /^error code$/i, /^when$/i], first: /^\d{3}(?:\s*\/\s*\d{3})*$/ },
  { kind: "mapping", heads: [/field/i, /^mandatory$/i, /field|target|api name/i, /^response field$/i, /^rule$/i] },
  { kind: "tests", heads: [/^#$/, /^scenario$/i, /^expected/i], first: /^\d+$/ },
  { kind: "questions", heads: [/^#$/, /^question/i, /^owner$/i, /^status$/i], first: /^[A-Z]{1,2}\d+$/ },
  { kind: "fields", heads: [/field/i, /^sample value$/i, /^value .*send/i] },
  { kind: "cases", heads: [/^case$/i, /^expected behaviou?r$/i] },
  { kind: "kv", heads: [/^(?:item|area|setting|name|property)$/i, /^(?:value|requirement|details?)\b/i] },
];
/** True when the text reads like a requirement document rather than one step per line. */
export function looksLikeDocument(text: string): boolean {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let headings = 0, prose = 0, json = 0, curl = 0, tables = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (isHeading(lines[i])) headings++;
    if (t.length > 110 && /[a-z][.,;:] [A-Za-z]/.test(t)) prose++;
    if (t === "{" || t === "[") json++;
    if (/^curl\s/i.test(t)) curl++;
    for (const h of TABLE_HEADS) if (h.heads.every((re, k) => re.test((lines[i + k] ?? "").trim()))) { tables++; break; }
  }
  const score = (headings >= 2 ? 2 : 0) + (prose >= 3 ? 1 : 0) + (json ? 1 : 0) + (curl ? 1 : 0) + (tables ? 1 : 0) + (tables >= 3 ? 1 : 0);
  return score >= 3;
}

// ---------------------------------------------------------------- structure
interface Section { num: string; title: string; line: number; end: number; parent?: string; }
interface Table { kind: string; head: string[]; rows: { line: number; cells: string[] }[]; line: number; end: number; section: Section; }
interface JsonBlock { line: number; end: number; value: unknown; section: Section; before: string[]; }
interface Curl { line: number; end: number; method: string; url: string; headers: Record<string, string>; body: unknown; section: Section; }
interface ListItem { line: number; n: number; text: string; section: Section; }

function sectionsOf(lines: string[]): Section[] {
  const out: Section[] = [];
  lines.forEach((l, i) => { const m = isHeading(l); if (m) out.push({ num: m[1], title: m[2].trim(), line: i + 1, end: lines.length }); });
  for (let k = 0; k < out.length; k++) {
    const next = out.slice(k + 1).find((s) => !s.num.startsWith(out[k].num + ".") );
    out[k].end = (next ? next.line : lines.length + 1) - 1;
    const sub = out[k + 1];
    if (sub) out[k].end = Math.max(out[k].end, 0);
    if (out[k].num.includes(".")) out[k].parent = out[k].num.split(".")[0];
  }
  return out;
}
function sectionAt(sections: Section[], line: number): Section {
  let best: Section = { num: "", title: "Top of the document", line: 1, end: Infinity };
  for (const s of sections) if (s.line <= line) best = s;
  return best;
}
const refOf = (s: Section, line: number): DocRef => ({ section: s.num ? `${s.num} ${s.title}` : s.title, line });
const proseCell = (t: string) => t.length > 100 && /[.:]\s|\.$/.test(t);

function tablesOf(lines: string[], sections: Section[]): Table[] {
  const out: Table[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const def of TABLE_HEADS) {
      const k = def.heads.length;
      if (!def.heads.every((re, j) => re.test((lines[i + j] ?? "").trim()))) continue;
      const head = lines.slice(i, i + k).map((x) => x.trim());
      const rows: Table["rows"] = [];
      let j = i + k;
      while (j < lines.length) {
        const first = (lines[j] ?? "").trim();
        if (isHeading(lines[j])) break;
        if (def.first ? !def.first.test(first) : (proseCell(first) || (!first && !(lines[j + 1] ?? "").trim()))) break;
        if (TABLE_HEADS.some((d) => d.heads.every((re, q) => re.test((lines[j + q] ?? "").trim())))) break;
        const cells = lines.slice(j, j + k).map((x) => (x ?? "").trim());
        if (cells.length < k || lines.slice(j, j + k).some((x) => isHeading(x))) break;
        rows.push({ line: j + 1, cells });
        j += k;
      }
      if (rows.length) { out.push({ kind: def.kind, head, rows, line: i + 1, end: j, section: sectionAt(sections, i + 1) }); i = j - 1; }
      break;
    }
  }
  return out;
}
function jsonBlocks(lines: string[], sections: Section[], skip: Set<number>): JsonBlock[] {
  const out: JsonBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (skip.has(i + 1) || lines[i].trim() !== "{") continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < lines.length && end < 0; j++) {
      for (const ch of lines[j]) {
        if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === "\"") inStr = false; continue; }
        if (ch === "\"") inStr = true; else if (ch === "{" || ch === "[") depth++; else if (ch === "}" || ch === "]") { depth--; if (depth === 0) { end = j; break; } }
      }
    }
    if (end < 0) continue;
    const raw = lines.slice(i, end + 1).join("\n");
    let value: unknown;
    try { value = JSON.parse(raw); } catch { try { value = JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1")); } catch { value = undefined; } }
    if (value !== undefined) out.push({ line: i + 1, end: end + 1, value, section: sectionAt(sections, i + 1), before: lines.slice(Math.max(0, i - 3), i).map((x) => x.trim()) });
    i = end;
  }
  return out;
}
function curls(lines: string[], sections: Section[]): Curl[] {
  const out: Curl[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^curl\s/i.test(lines[i].trim())) continue;
    let j = i, text = "";
    let inData = false;
    for (; j < lines.length; j++) {
      text += lines[j] + "\n";
      const t = lines[j].trim();
      if (/--data(?:-raw)?\s+'/.test(t) && !/'\s*$/.test(t.replace(/--data(?:-raw)?\s+'/, ""))) inData = true;
      else if (inData && /'\s*$/.test(t)) { inData = false; if (!t.endsWith("\\")) break; }
      else if (!inData && !t.endsWith("\\")) break;
    }
    const url = /curl\s+(?:--location\s+)?(?:--request\s+(\w+)\s+)?'?(https?:\/\/[^'\s]+)'?/i.exec(text);
    const method = /--request\s+(\w+)|-X\s+(\w+)/i.exec(text);
    const headers: Record<string, string> = {};
    for (const h of text.matchAll(/--header\s+'([^:']+):\s*([^']*)'/gi)) headers[h[1].trim()] = h[2].trim();
    const data = /--data(?:-raw)?\s+'([\s\S]*?)'\s*$/m.exec(text) ?? /--data(?:-raw)?\s+'([\s\S]*)'/.exec(text);
    let body: unknown;
    if (data) { try { body = JSON.parse(data[1]); } catch { body = undefined; } }
    if (url) out.push({ line: i + 1, end: j + 1, method: (method?.[1] ?? method?.[2] ?? (data ? "POST" : "GET")).toUpperCase(), url: url[2], headers, body, section: sectionAt(sections, i + 1) });
    i = j;
  }
  return out;
}
function listItems(lines: string[], sections: Section[], skip: Set<number>): ListItem[] {
  const out: ListItem[] = [];
  lines.forEach((l, i) => {
    if (skip.has(i + 1) || isHeading(l)) return;
    const m = /^(\d+)\.\s+(\S.*)$/.exec(l.trim());
    if (m) out.push({ line: i + 1, n: Number(m[1]), text: m[2].trim(), section: sectionAt(sections, i + 1) });
  });
  return out;
}

// ---------------------------------------------------------------- small helpers
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const seg = (k: string) => (IDENT.test(k) ? k : "`" + k.replace(/`/g, "") + "`");
const jstr = (v: unknown) => JSON.stringify(v);
const camel = (s: string) => { const w = s.replace(/^x-/i, "").split(/[^A-Za-z0-9]+/).filter(Boolean); return w.map((x, i) => (i ? x.charAt(0).toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join("") || "value"; };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const short = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** The JSONata string for a regular expression built from text (always valid). */
const reLit = (src: string) => `/${src.replace(/\//g, "\\/")}/`;

interface FieldSpec {
  source: string;                 // request field name ("" for a field the service builds or fixes)
  label: string;                  // first cell as written
  mandatory: boolean;
  target: string;                 // target system field ("" when not sent)
  response: string;               // response field ("" when not returned)
  rule: string;
  ref: DocRef;
  trim: boolean; lower: boolean; email: boolean; maxLen?: number; integer: boolean; dropEmpty: boolean; pattern?: { re: string; words: string };
  digits: boolean; partOf?: string; fixed?: unknown; template?: string; valueMap?: Record<string, string>; fromHeader?: string; tag?: string;
  checkedByTarget?: string; duplicateKey: boolean; built?: { crmJoin: string; responseJoin: string };
  understood: string[]; notUnderstood: string[];
}

// ---------------------------------------------------------------- reading the rule words of a mapping row
function readRule(f: FieldSpec, headers: Map<string, { allowed: string[] }>) {
  const r = f.rule;
  const said = (x: string) => f.understood.push(x);
  if (/\btrim\b/i.test(r)) { f.trim = true; said("trim spaces"); }
  if (/lower ?case/i.test(r)) { f.lower = true; said("lower case"); }
  if (/valid e-?mail/i.test(r)) { f.email = true; said("valid e-mail format"); }
  const max = /max(?:imum)?\.?\s+(\d+)\s+char/i.exec(r); if (max) { f.maxLen = Number(max[1]); said(`at most ${max[1]} characters`); }
  if (/whole number|integer/i.test(r)) { f.integer = true; said("a whole number"); }
  if (/only if not empty|left out when empty|omit(?:ted)? if empty/i.test(r)) { f.dropEmpty = true; said("left out when empty"); }
  if (/duplicate check/i.test(r)) { f.duplicateKey = true; said("the duplicate check"); }
  const start = /must start with \+ followed by (\d+) to (\d+) digits/i.exec(r);
  if (start) { f.pattern = { re: `^\\+\\d{${start[1]},${start[2]}}$`, words: `+ followed by ${start[1]} to ${start[2]} digits` }; said(`starts with + and ${start[1]} to ${start[2]} digits`); }
  if (/digits only/i.test(r)) { f.digits = true; said("digits only after cleaning"); }
  const pick = /must match (?:a )?(?:\w+ )?picklist value|must be a (?:currency )?code enabled in (\w+)/i.exec(r);
  if (pick) { f.checkedByTarget = short(r.replace(/^.*?(must)/i, "$1"), 80); said("checked by the target system"); }
  const always = /always set to "?([\w -]+?)"?(?: by [\w ]+)?(?:,|\.|$)/i.exec(r);
  if (always) { f.fixed = always[1].trim(); said(`always "${f.fixed}"`); }
  if (/^always true\b/i.test(r)) { f.fixed = true; said("always true"); }
  if (/^always false\b/i.test(r)) { f.fixed = false; said("always false"); }
  if (/^always added\b/i.test(r) && /^tag\s+/i.test(f.target)) { f.tag = f.target.replace(/^tag\s+/i, "").trim(); said(`tag ${f.tag}, existing tags kept`); }
  const tpl = /^([A-Z][^{}]*\{(\w+)\}[^{}]*)$/.exec(r.trim());
  if (tpl) { f.template = tpl[1].trim(); said(`the text "${f.template}"`); }
  const pairs = [...r.matchAll(/([A-Z][A-Z0-9_]+)\s*(?:→|->|=>)\s*([A-Za-z][\w ]*?)(?=,\s*[A-Z][A-Z0-9_]+\s*(?:→|->|=>)|$)/g)];
  if (pairs.length >= 2) { f.valueMap = Object.fromEntries(pairs.map((p) => [p[1], p[2].trim()])); said(`values mapped: ${pairs.map((p) => `${p[1]} → ${p[2].trim()}`).join(", ")}`); }
  const hdr = /^(X-[\w-]+|[\w-]+) header$/i.exec(f.label);
  if (hdr && headers.has(hdr[1].toLowerCase())) { f.fromHeader = hdr[1]; said(`from the ${hdr[1]} header`); }
  if (/^part of (\w+)/i.test(f.target)) { f.partOf = /^part of (\w+)/i.exec(f.target)![1]; said(`part of ${f.partOf}`); }
  const built = /no space/i.test(r) && /one space|with a space/i.test(r);
  if (built) { f.built = { crmJoin: "", responseJoin: " " }; said("built: no space for the target system, one space in the response"); }
  if (f.fixed === undefined && !f.template && !f.valueMap && !f.tag && !f.built && !f.source && f.target) {
    // "(fixed by …)" row written as "<Value> while …" / "<Value>, unless …"
    const lead = /^([A-Z][\w ]*?)\s+(?:while|unless|when|except|\()/.exec(r) ?? /^([A-Z][\w ]*?)\s*,\s*unless\b/.exec(r);
    if (lead) { f.fixed = lead[1].trim(); said(`fixed value "${f.fixed}" (read from the wording)`); }
  }
  // what is left that was not understood
  const known = /trim|lower ?case|valid e-?mail|max|whole number|integer|only if not empty|duplicate check|requires this|must start with|digits only|see \d|picklist|currency code|always|→|->|no space|one space|used as|required|empty|\{\w+\}|\bwhile\b|\bunless\b|existing tags/i;
  const plain = r.replace(/\(e\.g\.[^)]*\)/gi, "").replace(/,?\s*e\.g\.\s*[^,;]*?(?=\.\s+[A-Z]|\.?$)/gi, "");
  for (const part of plain.split(/(?<=\.)\s+(?=[A-Z])/)) { const t = part.trim(); if (t && !/^[+\d ().-]+\.?$/.test(t) && !known.test(t)) f.notUnderstood.push(t); }
}

// ---------------------------------------------------------------- the reader
export function readDocument(text: string, ctx: DescribeContext = {}): DocumentResult {
  const src = String(text ?? "").replace(/\r\n?/g, "\n").replace(/[“”]/g, "\"").replace(/[‘’]/g, "'");
  const lines = src.split("\n");
  const sections = sectionsOf(lines);
  const tables = tablesOf(lines, sections);
  const used = new Set<number>();
  for (const t of tables) for (let l = t.line; l <= t.end; l++) used.add(l);
  const blocks = jsonBlocks(lines, sections, used);
  for (const b of blocks) for (let l = b.line; l <= b.end; l++) used.add(l);
  const curlList = curls(lines, sections);
  for (const c of curlList) for (let l = c.line; l <= c.end; l++) used.add(l);
  const lists = listItems(lines, sections, used);

  const items: DocItem[] = [], decisions: DocDecision[] = [], conflicts: DocConflict[] = [], handWritten: DocHandWritten[] = [], notUsed: DocNotUsed[] = [], blocking: string[] = [];
  const missing: MissingConnection[] = [];
  const notes: string[] = [];
  const usedSections = new Map<string, "used" | "partly">();
  const mark = (s: Section, how: "used" | "partly" = "used") => { if (s.num) { const top = s.num; if (usedSections.get(top) !== "used") usedSections.set(top, how); } };
  const item = (kind: string, title: string, detail: string, s: Section, line: number): DocItem => { const it: DocItem = { kind, title, detail, ref: refOf(s, line), nodeIds: [] }; items.push(it); mark(s); return it; };
  const titleLine = lines.find((l) => l.trim()) ?? "Requirement";
  const title = titleLine.trim().replace(/\s+[–—-]\s+.*$/, "").slice(0, 100);

  // ---- endpoint
  let method = "", fullPath = "", contentType = "";
  let epItem: DocItem | null = null;
  for (const t of tables.filter((x) => x.kind === "kv")) {
    const get = (re: RegExp) => t.rows.find((r) => re.test(r.cells[0]));
    const m = get(/^method$/i), p = get(/^(?:path|resource|url path)$/i);
    if (m && p && /^(GET|POST|PUT|PATCH|DELETE)$/i.test(m.cells[1]) && /^\//.test(p.cells[1])) {
      method = m.cells[1].toUpperCase(); fullPath = p.cells[1].split(/\s/)[0];
      const ct = get(/^content.?type$/i); if (ct) contentType = ct.cells[1];
      epItem = item("endpoint", `${method} ${fullPath}`, `the API to expose${contentType ? `, ${contentType}` : ""}`, t.section, m.line);
      const auth = get(/^authentication/i);
      if (auth) item("security", "Caller authentication", `${short(auth.cells[1], 120)} → published on the gateway with OAuth2`, t.section, auth.line);
      const env = get(/^environments?$/i);
      if (env) decisions.push({ id: "ENV", text: `Environments: ${env.cells[1]}`, status: "To set up", ref: refOf(t.section, env.line), choice: "One flow; each environment gets its own Zoho connection (credentials are entered on the connection, never in the flow)." });
      break;
    }
  }
  if (!method) {
    for (let i = 0; i < lines.length; i++) {
      const m = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w\-./{}:]+)/.exec(lines[i]);
      if (m) { method = m[1]; fullPath = m[2]; epItem = item("endpoint", `${method} ${fullPath}`, "the API to expose (found in the text)", sectionAt(sections, i + 1), i + 1); break; }
    }
  }
  if (!method) blocking.push("No endpoint was found. Write the method and path, for example a line \"POST /orders/v1/create\", or an Item / Value table with Method and Path.");
  const bp = /^(\/[\w-]+\/v\d+)(\/.*)$/.exec(fullPath);
  const basePath = bp ? bp[1] : "";
  const listenPath = (bp ? bp[2] : fullPath).replace(/\{([^}]+)\}/g, ":$1") || "/";

  // ---- request headers
  const headerSpecs = new Map<string, { name: string; mandatory: boolean; allowed: string[]; caseInsensitive: boolean; generate: boolean; ref: DocRef; line: number; section: Section; notes: string }>();
  for (const t of tables.filter((x) => x.kind === "headers")) {
    for (const r of t.rows) {
      const [name, mand, allowedRaw, notesRaw] = r.cells;
      if (!name) continue;
      const allowed = /^[A-Z0-9_]+(?:\s*,\s*[A-Z0-9_]+)+$/.test(allowedRaw) ? allowedRaw.split(/\s*,\s*/) : [];
      headerSpecs.set(name.toLowerCase(), { name, mandatory: /^yes$/i.test(mand), allowed, caseInsensitive: /case.?insensitive/i.test(notesRaw ?? ""), generate: /generates? one/i.test(notesRaw ?? ""), ref: refOf(t.section, r.line), line: r.line, section: t.section, notes: notesRaw ?? "" });
    }
  }
  // ---- samples
  const sample = (re: RegExp) => blocks.find((b) => re.test(b.section.title) || b.before.some((x) => re.test(x)));
  const reqBlock = sample(/request body|request sample|request \(/i);
  const resBlock = sample(/success response|response \(to|200 ok/i);
  const errBlock = blocks.find((b) => b !== reqBlock && b !== resBlock && /error/i.test(b.section.title) && typeof b.value === "object" && b.value && "error" in (b.value as object));
  const wrapperOf = (v: unknown): { key: string; fields: Record<string, unknown> } | null => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const keys = Object.keys(v as object);
    if (keys.length === 1 && (v as Record<string, unknown>)[keys[0]] && typeof (v as Record<string, unknown>)[keys[0]] === "object" && !Array.isArray((v as Record<string, unknown>)[keys[0]])) return { key: keys[0], fields: (v as Record<string, Record<string, unknown>>)[keys[0]] };
    return { key: "", fields: v as Record<string, unknown> };
  };
  const req = wrapperOf(reqBlock?.value), res = wrapperOf(resBlock?.value);
  const wrap = req?.key ?? "";
  const inExpr = (k: string) => (wrap ? `${seg(wrap)}.${seg(k)}` : seg(k));
  if (reqBlock && req) item("request-sample", "Request body", `${wrap ? `wrapped in "${wrap}", ` : ""}fields ${Object.keys(req.fields).join(", ")}`, reqBlock.section, reqBlock.line);
  else blocking.push("No JSON sample of the request body was found, so the fields could not be read.");
  let okStatus = 200;
  if (resBlock) { const st = resBlock.before.map((x) => /^HTTP\s+(\d{3})/i.exec(x)).find(Boolean); if (st) okStatus = Number(st[1]); }
  const resFields = res ? Object.keys(res.fields) : [];
  if (resBlock && res) item("response-sample", `Success response ${okStatus}`, `fields in this order: ${resFields.join(", ")}`, resBlock.section, resBlock.line);

  // ---- errors
  const errors: { status: number; code: string; when: string; line: number; section: Section }[] = [];
  for (const t of tables.filter((x) => x.kind === "errors")) mark(t.section);
  for (const t of tables.filter((x) => x.kind === "errors")) for (const r of t.rows) errors.push({ status: Number(r.cells[0].split("/")[0].trim()), code: r.cells[1], when: r.cells[2], line: r.line, section: t.section });
  const errSample = errBlock ? (errBlock.value as { error: Record<string, unknown> }).error : null;
  const errMessage = (code: string, fallback: string) => (errSample && errSample.code === code && typeof errSample.message === "string" ? errSample.message : fallback);
  const codeFor = (re: RegExp, fallback: string) => errors.find((e) => re.test(e.when) || re.test(e.code))?.code ?? fallback;
  const errFor = (code: string) => errors.find((e) => e.code === code);

  // ---- mapping table
  const fields: FieldSpec[] = [];
  let dropAllEmpty = false;
  for (const t of tables.filter((x) => x.kind === "mapping")) {
    for (const r of t.rows) {
      const [label, mand, target, response, rule] = r.cells;
      const isSource = !!req && Object.prototype.hasOwnProperty.call(req.fields, label);
      const f: FieldSpec = {
        source: isSource ? label : "", label, mandatory: /^yes$/i.test(mand), target: /^(?:–|-|not sent|none)$/i.test(target) ? "" : target.replace(/\s*\(existing field\)$/i, ""), response: /not returned|^(?:–|-)$/i.test(response) ? "" : response,
        rule: rule ?? "", ref: refOf(t.section, r.line), trim: false, lower: false, email: false, integer: false, dropEmpty: false, digits: false, duplicateKey: false, understood: [], notUnderstood: [],
      };
      // a "(built by …)" / "(fixed by …)" row names the target field in the target column
      if (!isSource && /^\(/.test(label) && /^(?:–|-)$/.test(mand)) { f.target = target; f.response = response && !/not returned/i.test(response) ? response : ""; }
      if (!isSource && !/^\(/.test(label) && !/header$/i.test(label)) f.notUnderstood.push(`"${label}" is not a field of the request sample`);
      readRule(f, new Map([...headerSpecs].map(([k, v]) => [k, { allowed: v.allowed }])));
      if (/^\(fixed|^\(built/i.test(label) && f.target === "–") f.target = "";
      fields.push(f);
    }
    const after = lines.slice(t.end, t.end + 3).find((l) => /empty strings? must be left out|leave out empty|do not send empty/i.test(l));
    if (after) { dropAllEmpty = true; item("rule", "Empty values are left out of the target request", short(after.trim(), 140), t.section, lines.indexOf(after) + 1); }
  }
  if (!fields.length && req) for (const k of Object.keys(req.fields)) fields.push({ source: k, label: k, mandatory: false, target: k, response: resFields.includes(k) ? k : "", rule: "", ref: refOf(reqBlock!.section, reqBlock!.line), trim: false, lower: false, email: false, integer: false, dropEmpty: false, digits: false, duplicateKey: false, understood: ["copied as it is (no mapping table)"], notUnderstood: [] });
  if (dropAllEmpty) for (const f of fields) if (f.source && !f.mandatory) f.dropEmpty = true;

  // ---- numbered rule lists ("5.2 Mobile number rules")
  const builtField = fields.find((f) => f.built);
  const parts = fields.filter((f) => f.partOf);
  const ccField = parts.find((f) => f.pattern) ?? parts[0];
  const numField = parts.find((f) => f !== ccField && f.digits) ?? parts.find((f) => f !== ccField);
  interface Clean { expr: (v: string, cc: string) => string; words: string; ref: DocRef; }
  const cleaners: Clean[] = [];
  const mobileChecks: { cond: (num: string, cc: string, ccd: string) => string; words: string; ref: DocRef }[] = [];
  const ruleSections = [...new Set(lists.filter((l) => /rules?\b/i.test(l.section.title)).map((l) => l.section))];
  for (const s of ruleSections) {
    for (const li of lists.filter((l) => l.section === s)) {
      const t = li.text;
      const ref = refOf(s, li.line);
      const chars = /^remove\s+((?:spaces|dashes|hyphens|brackets|parentheses|dots|commas|plus signs?|slashes)(?:,?\s*(?:and\s+)?(?:spaces|dashes|hyphens|brackets|parentheses|dots|commas|plus signs?|slashes))*)\b/i.exec(t);
      if (chars) {
        const cls = chars[1].toLowerCase();
        const set = [/space/.test(cls) && "\\s", /dash|hyphen/.test(cls) && "\\-", /bracket|parenthes/.test(cls) && "()\\[\\]", /dot/.test(cls) && ".", /comma/.test(cls) && ",", /plus/.test(cls) && "+", /slash/.test(cls) && "\\/"].filter(Boolean).join("");
        cleaners.push({ expr: (v) => `$replace(${v}, ${reLit(`[${set}]`)}, "")`, words: `remove ${chars[1]}`, ref });
        items.push({ kind: "rule", title: `Rule ${li.n}`, detail: t, ref, nodeIds: [] }); continue;
      }
      if (/remove one leading 0|strip one leading 0|drop one leading zero/i.test(t)) { cleaners.push({ expr: (v) => `$replace(${v}, /^0/, "")`, words: "remove one leading 0", ref }); items.push({ kind: "rule", title: `Rule ${li.n}`, detail: t, ref, nodeIds: [] }); continue; }
      if (/remove the country code if .*(?:typed|entered|included) it inside/i.test(t)) {
        cleaners.push({ expr: (v, cc) => `($x := ${v}; $d := $substringAfter(${cc}, "+"); $y := $substring($x, 0, 1) = "+" ? $substring($x, 1) : ($substring($x, 0, 2) = "00" ? $substring($x, 2) : $x); ($d != "" and $substring($y, 0, $length($d)) = $d and $length($y) - $length($d) >= 6) ? $substring($y, $length($d)) : $x)`, words: "remove the country code typed inside the number", ref });
        items.push({ kind: "rule", title: `Rule ${li.n}`, detail: t, ref, nodeIds: [] }); continue;
      }
      const exact = /for \+(\d{1,4})\b.*?must be exactly (\d+) digits(?: starting with (\d))?/i.exec(t);
      if (exact) {
        const [, code, n, first] = exact;
        const re = first ? `^${first}\\d{${Number(n) - 1}}$` : `^\\d{${n}}$`;
        mobileChecks.push({ cond: (num, cc) => `(${cc} = "+${code}" and $not($contains(${num}, ${reLit(re)})))`, words: `for +${code}: exactly ${n} digits${first ? ` starting with ${first}` : ""}`, ref });
        items.push({ kind: "rule", title: `Rule ${li.n}`, detail: t, ref, nodeIds: [] }); continue;
      }
      const range = /other country codes.*?(\d+)\s*to\s*(\d+)\s*digits/i.exec(t);
      if (range) {
        const others = mobileChecks.map((m) => /"\+(\d+)"/.exec(m.cond("n", "c", "d"))?.[1]).filter(Boolean) as string[];
        mobileChecks.push({ cond: (num, cc, ccd) => `(${others.map((o) => `${cc} != "+${o}"`).join(" and ") || "true"} and ($length(${ccd} & ${num}) < ${range[1]} or $length(${ccd} & ${num}) > ${range[2]}))`, words: `other codes: ${range[1]} to ${range[2]} digits in total`, ref });
        items.push({ kind: "rule", title: `Rule ${li.n}`, detail: t, ref, nodeIds: [] }); continue;
      }
      if (/never (?:cut|truncate|shorten)|not shortened/i.test(t)) { items.push({ kind: "rule", title: `Rule ${li.n}`, detail: `${t} Kept: no step shortens a value; a wrong number is rejected.`, ref, nodeIds: [] }); continue; }
      handWritten.push({ text: t, ref, why: "This rule does not match any rule wording the reader knows, so no step was made for it. Add an Expression step for it." });
    }
    mark(s);
    // "Data issue to confirm" paragraphs in the rules section: a conflict with the choice made
    for (let l = s.line; l <= Math.min(s.end, lines.length); l++) {
      const t = lines[l - 1]?.trim() ?? "";
      if (/^(?:data issue|conflict|inconsistency)/i.test(t)) conflicts.push({ text: short(t.replace(/^data issue to confirm:\s*/i, ""), 260), refs: [refOf(s, l)], choice: "The rules are applied as written: a number that breaks them is rejected with the error for the number, never shortened." });
    }
  }

  // ---- target system (Item / Value table in the integration section, and the curl sample)
  const target: { tokenLine?: number; baseLine?: number; baseUrl?: string; tokenUrl?: string; method?: string; path?: string; prefix?: string; scopes?: string; oauth?: string; extras: Record<string, unknown>; name: string; ref?: DocRef; section?: Section } = { extras: {}, name: "" };
  for (const t of tables.filter((x) => x.kind === "kv" && /integration|crm|target|backend|zoho|system/i.test(x.section.title))) {
    target.section = t.section; target.ref = refOf(t.section, t.line);
    for (const r of t.rows) {
      const [k, v] = r.cells;
      if (/base url/i.test(k)) { target.baseUrl = /https?:\/\/[^\s)]+/.exec(v)?.[0]; target.baseLine = r.line; }
      else if (/accounts|token/i.test(k) && /url/i.test(k)) { const u = /https?:\/\/[^\s)]+/.exec(v)?.[0]; if (u) { target.tokenUrl = zohoTokenUrlFor(u) ?? u.replace(/\/+$/, "") + (/\/oauth\//.test(u) ? "" : "/oauth/v2/token"); target.tokenLine = r.line; } }
      else if (/operation .*use|operation to use|^operation$/i.test(k)) { const m = /\b(GET|POST|PUT|PATCH)\s+(https?:\/\/[^\s]+)/i.exec(v); if (m) { target.method = m[1].toUpperCase(); target.path = m[2]; } }
      else if (/auth header/i.test(k)) { const m = /authorization:\s*([\w-]+)\s+\{/i.exec(v); if (m) target.prefix = m[1]; }
      else if (/scopes?/i.test(k)) target.scopes = v.replace(/\s*\(.*\)$/, "").trim();
      else if (/oauth client|client type/i.test(k)) target.oauth = v;
    }
    mark(t.section);
  }
  const titleSys = /^(?:\d+(?:\.\d+)*\s+)?([A-Z][\w ]*?)\s+integration/i.exec(target.section?.title ?? "")?.[1];
  const curl = curlList.find((c) => target.path && c.url.split("?")[0] === target.path.split("?")[0]) ?? curlList[curlList.length - 1];
  if (curl) {
    if (!target.method) { target.method = curl.method; target.path = curl.url; }
    const auth = Object.entries(curl.headers).find(([k]) => /^authorization$/i.test(k));
    if (auth && !target.prefix) target.prefix = /^([\w-]+)\s+\{/.exec(auth[1])?.[1];
    if (curl.body && typeof curl.body === "object") for (const [k, v] of Object.entries(curl.body as Record<string, unknown>)) if (k !== "data") target.extras[k] = v;
    item("target-sample", "Request the service sends", `${curl.method} ${curl.url}${Object.keys(target.extras).length ? ` with ${Object.keys(target.extras).join(", ")}` : ""}`, curl.section, curl.line);
  }
  const record = curl && curl.body && typeof curl.body === "object" && Array.isArray((curl.body as { data?: unknown }).data) ? ((curl.body as { data: Record<string, unknown>[] }).data[0] ?? {}) : null;
  let tPath = "", tBase = target.baseUrl ?? "";
  if (target.path) { const u = /^(https?:\/\/[^/]+)(\/.*)?$/.exec(target.path); if (u) { tBase = tBase || u[1]; tPath = (u[2] ?? "/").replace(/[?#].*$/, ""); } else tPath = target.path; }
  // Zoho: the API address follows the accounts (token) address's data centre; different centres are a conflict
  if (target.tokenUrl && zohoCentre(target.tokenUrl)) {
    const paired = zohoApiFor(target.tokenUrl)!;
    const clash = tBase ? zohoMismatch(target.tokenUrl, tBase) : null;
    if (clash) conflicts.push({ text: clash, refs: [refOf(target.section ?? sectionAt(sections, 1), target.tokenLine ?? 1), refOf(target.section ?? sectionAt(sections, 1), target.baseLine ?? 1)], choice: `The connection is offered with ${paired} (the centre of the token address); check which centre the org is in.` });
    if (!tBase || clash) tBase = paired;
  }
  target.name = titleSys ? (/crm/i.test(target.section?.title ?? "") && !/crm/i.test(titleSys) ? `${titleSys} CRM` : titleSys) : tBase ? (/^https?:\/\/([^/:]+)/.exec(tBase)?.[1] ?? "").split(".").slice(-2, -1)[0] || "Target" : "Target";
  if (!target.method || !tPath) { if (fields.some((f) => f.target)) handWritten.push({ text: "The call to the target system", ref: target.ref ?? { section: "", line: 1 }, why: "No method and address for the target system were found (an Item / Value table with \"Operation\" or a curl sample)." }); }

  // ---- non-functional table
  const nfr = { timeoutMs: 0, retries: 0, delays: [] as number[], mask: false, logFields: "", queue: "", throttling: "", ref: undefined as DocRef | undefined };
  for (const t of tables.filter((x) => x.kind === "kv" && /non.?functional|quality|operational/i.test(x.section.title))) {
    for (const r of t.rows) {
      const [k, v] = r.cells; const ref = refOf(t.section, r.line);
      if (/timeout/i.test(k)) { const m = /(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)\b/i.exec(v); if (m) { nfr.timeoutMs = Math.round(Number(m[1]) * (/^ms/i.test(m[2]) ? 1 : 1000)); items.push({ kind: "nonfunctional", title: "Call timeout", detail: `${nfr.timeoutMs} ms`, ref, nodeIds: [] }); } }
      else if (/retr/i.test(k)) {
        const n = /up to (\d+)|(\d+) retries/i.exec(v); if (n) nfr.retries = Number(n[1] ?? n[2]);
        const back = /\(([^)]*\d+\s*s[^)]*)\)/i.exec(v); if (back) nfr.delays = [...back[1].matchAll(/(\d+(?:\.\d+)?)\s*s\b/g)].map((x) => Math.round(Number(x[1]) * 1000));
        items.push({ kind: "nonfunctional", title: "Retries", detail: `${nfr.retries} retries${nfr.delays.length ? `, waiting ${nfr.delays.join(" ms then ")} ms` : ""}; ${/no retry on 4xx/i.test(v) ? "no retry on 4xx (the call step never retries 4xx except 429)" : v}`, ref, nodeIds: [] });
      } else if (/privacy|mask/i.test(k) || /masked in logs/i.test(v)) { nfr.mask = true; items.push({ kind: "nonfunctional", title: "Masking in logs", detail: `${short(v, 120)} → log lines show masked e-mail and mobile; step traces do not keep the payload`, ref, nodeIds: [] }); }
      else if (/^logging$/i.test(k)) { nfr.logFields = v; items.push({ kind: "nonfunctional", title: "Logging", detail: v, ref, nodeIds: [] }); }
      else if (/failed calls|dead letter|error queue/i.test(k) || /error queue|re-?processing/i.test(v)) { nfr.queue = v; }
      else if (/throttl|rate limit/i.test(k)) { nfr.throttling = v; decisions.push({ id: "THROTTLE", text: `Throttling: ${short(v, 160)}`, status: "To set on the gateway", ref, choice: "Published on the gateway with the default policy; pick a 60-per-minute policy on the Deploy dialog's gateway settings once it exists on the gateway." }); }
      else notUsed.push({ section: `${t.section.num} ${t.section.title}: ${k}`, ref, reason: `${short(v, 120)} (an operations requirement, not a flow step)` });
    }
    mark(t.section);
  }

  // ---- open questions
  for (const t of tables.filter((x) => x.kind === "questions")) {
    for (const r of t.rows) {
      const [id, q, owner, status] = r.cells;
      if (/^received|^done|^resolved|^closed/i.test(status)) { notUsed.push({ section: `${id} ${short(q, 80)}`, ref: refOf(t.section, r.line), reason: `${status} (an input that was received, nothing to build)` }); continue; }
      decisions.push({ id, text: q, status, owner, ref: refOf(t.section, r.line) });
    }
    mark(t.section, "partly");
  }

  // ---------------------------------------------------------------- build the flow
  const nodes: FlowNode[] = [], edges: FlowEdge[] = [];
  let seq = 0, eseq = 0;
  const add = (type: string, name: string, config: Record<string, unknown>, notesText?: string): FlowNode => { const n: FlowNode = { id: `n_d${String(++seq).padStart(2, "0")}`, type, name, position: { x: 0, y: 0 }, config, ...(notesText ? { notes: notesText } : {}) }; nodes.push(n); return n; };
  const wire = (from: FlowNode, port: string, to: FlowNode) => edges.push({ id: `e_d${String(++eseq).padStart(2, "0")}`, from: from.id, fromPort: port, to: to.id });
  const link = (it: DocItem | undefined, n: FlowNode) => { if (it && !it.nodeIds.includes(n.id)) it.nodeIds.push(n.id); };
  const corrHeader = [...headerSpecs.values()].find((h) => h.generate);
  const corrVar = "$vars.correlationId";
  const respHeaders = corrHeader ? [{ key: corrHeader.name, value: `{{ ${corrVar} }}` }] : [];

  const trigger = add("trigger.http", `${method || "POST"} ${fullPath || listenPath}`, { methods: [method || "POST"], path: listenPath, summary: title });
  link(epItem ?? undefined, trigger);

  // prepare: correlation id, headers, cleaned fields, built fields
  const assign: { key: string; value: string }[] = [];
  const v = (k: string) => `$vars.${k}`;
  const str = (e: string) => `($v := ${e}; $exists($v) and $v != null ? $string($v) : "")`;
  if (corrHeader) { assign.push({ key: "correlationId", value: `($h := $request.headers.${jstr(corrHeader.name.toLowerCase())}; $exists($h) and $trim($string($h)) != "" ? $trim($string($h)) : $uuid())` }); }
  assign.push({ key: "startMs", value: "$millis()" });
  const headerVars = new Map<string, string>();
  for (const h of headerSpecs.values()) {
    if (h.generate || /^content-type$/i.test(h.name) || /authori[sz]ation|api key/i.test(h.name)) continue;
    const key = camel(h.name);
    headerVars.set(h.name.toLowerCase(), key);
    const raw = `$request.headers.${jstr(h.name.toLowerCase())}`;
    assign.push({ key, value: h.caseInsensitive ? `$uppercase($trim(${str(raw)}))` : `$trim(${str(raw)})` });
  }
  const fieldVar = new Map<FieldSpec, string>();
  for (const f of fields.filter((x) => x.source)) {
    const key = camel(f.source);
    fieldVar.set(f, key);
    let e = str(inExpr(f.source));
    if (f.trim || f.email || f.lower) e = `$trim(${e})`;
    if (f.lower) e = `$lowercase(${e})`;
    assign.push({ key, value: e });
  }
  let numClean = "", ccVar = "", ccDigits = "";
  if (numField && fieldVar.get(numField)) {
    ccVar = ccField && fieldVar.get(ccField) ? v(fieldVar.get(ccField)!) : '""';
    ccDigits = "ccDigits";
    assign.push({ key: ccDigits, value: `$substringAfter(${ccVar}, "+")` });
    let cur = v(fieldVar.get(numField)!);
    cleaners.forEach((c, i) => { const key = `${fieldVar.get(numField)}Step${i + 1}`; assign.push({ key, value: c.expr(cur, ccVar) }); cur = v(key); });
    numClean = `${fieldVar.get(numField)}Clean`;
    assign.push({ key: numClean, value: cur });
    if (builtField) {
      assign.push({ key: `${camel(builtField.target)}ForTarget`, value: `${ccVar} & ${jstr(builtField.built!.crmJoin)} & ${v(numClean)}` });
      assign.push({ key: `${camel(builtField.target)}ForResponse`, value: `${ccVar} & ${jstr(builtField.built!.responseJoin)} & ${v(numClean)}` });
    }
  }
  const channelField = fields.find((f) => f.fromHeader && f.valueMap);
  if (channelField) assign.push({ key: `${camel(channelField.fromHeader!)}Label`, value: `$lookup(${jstr(channelField.valueMap)}, ${v(headerVars.get(channelField.fromHeader!.toLowerCase()) ?? camel(channelField.fromHeader!))})` });
  if (nfr.mask) {
    const em = fields.find((f) => f.email); const emv = em ? fieldVar.get(em) : undefined;
    if (emv) assign.push({ key: "emailMasked", value: `($e := ${v(emv)}; $contains($e, "@") ? $substring($e, 0, 2) & "***@" & $substringAfter($e, "@") : "***")` });
    if (numClean) assign.push({ key: "mobileMasked", value: `($n := ${v(numClean)}; ${ccVar} & " " & $substring($n, 0, 2) & "*****" & $substring($n, -2))` });
  }
  const prep = add("vars.set", "Prepare the request", { assignments: assign }, "Correlation id, header values, cleaned fields and the built fields, in the order of the document's rules.");
  wire(trigger, "out", prep);
  for (const it of items.filter((x) => x.kind === "rule")) link(it, prep);

  // checks, in the order of the error table
  const errBody = (code: string, message: string) => {
    const msg = message.startsWith("(") ? message : jstr(message);
    if (errSample) return `{ "error": { ${Object.keys(errSample).map((k) => `${jstr(k)}: ${k === "code" ? jstr(code) : k === "message" ? msg : /correlation/i.test(k) ? corrVar : jstr(errSample[k])}`).join(", ")} } }`;
    return `{ "error": { "code": ${jstr(code)}, "message": ${msg} } }`;
  };
  const conds: { id: string; label: string; expr: string; code: string; status: number; message: string; refs: DocRef[]; errRef?: DocRef }[] = [];
  const addCheck = (code: string, label: string, expr: string, message: string, refs: DocRef[]) => {
    const e = errFor(code);
    const prevC = conds[conds.length - 1];
    const exist = prevC && prevC.code === code && prevC.message === message ? prevC : undefined;
    if (exist) { exist.expr = `(${exist.expr}) or (${expr})`; exist.label = short(`${exist.label}; ${label}`, 100); exist.refs.push(...refs); return; }
    conds.push({ id: `c${conds.length + 1}`, label: short(label, 100), expr, code, status: e?.status ?? 400, message, refs: e ? [...refs, refOf(e.section, e.line)] : refs, errRef: e ? refOf(e.section, e.line) : undefined });
  };
  for (const h of headerSpecs.values()) {
    const key = headerVars.get(h.name.toLowerCase());
    if (!key || !h.mandatory) continue;
    const code = codeFor(new RegExp(reEsc(h.name), "i"), "INVALID_REQUEST");
    const allowed = h.allowed.length ? ` or $not(${v(key)} in ${jstr(h.allowed)})` : "";
    addCheck(code, `${h.name} missing${h.allowed.length ? " or not allowed" : ""}`, `${v(key)} = ""${allowed}`, errMessage(code, errFor(code)?.when ?? `${h.name} is missing`), [h.ref]);
  }
  const reqCode = codeFor(/valid json|object is missing|request/i, "INVALID_REQUEST");
  if (wrap) addCheck(reqCode, `"${wrap}" object missing`, `$type(${seg(wrap)}) != "object"`, errMessage(reqCode, errFor(reqCode)?.when ?? "The request is not valid"), reqBlock ? [refOf(reqBlock.section, reqBlock.line)] : []);
  const emailF = fields.find((f) => f.email && fieldVar.get(f));
  if (emailF) {
    const code = codeFor(/e-?mail/i, "INVALID_REQUEST");
    addCheck(code, `${emailF.source} missing or not a valid e-mail${emailF.maxLen ? ` (at most ${emailF.maxLen})` : ""}`, `${v(fieldVar.get(emailF)!)} = "" or $not($contains(${v(fieldVar.get(emailF)!)}, /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/))${emailF.maxLen ? ` or $length(${v(fieldVar.get(emailF)!)}) > ${emailF.maxLen}` : ""}`, errMessage(code, errFor(code)?.when ?? "Email is not valid"), [emailF.ref]);
  }
  const mandatoryOthers = fields.filter((f) => f.mandatory && fieldVar.get(f) && f !== emailF);
  const missingCode = codeFor(/mandatory field|missing_field|is empty/i, "MISSING_FIELD");
  if (mandatoryOthers.length) {
    const list = mandatoryOthers.map((f) => `${v(fieldVar.get(f)!)} = "" ? ${jstr(f.source)}`).join(", ");
    addCheck(missingCode, `empty: ${mandatoryOthers.map((f) => f.source).join(", ")}`, mandatoryOthers.map((f) => `${v(fieldVar.get(f)!)} = ""`).join(" or "), `($m := [${list}]; $m[0] & " is required")`, mandatoryOthers.map((f) => f.ref));
  }
  if (numField && numClean) {
    const code = codeFor(/mobile|phone|contact number|country code/i, "INVALID_REQUEST");
    const ccCheck = ccField?.pattern ? `$not($contains(${ccVar}, ${reLit(ccField.pattern.re)}))` : "false";
    const digits = `$not($contains(${v(numClean)}, /^\\d+$/))`;
    const rules = mobileChecks.map((m) => m.cond(v(numClean), ccVar, v(ccDigits)));
    addCheck(code, `${[ccField?.source, numField.source].filter(Boolean).join(" / ")} breaks the number rules`, [ccCheck, digits, ...rules].join(" or "), errMessage(code, errFor(code)?.when ?? "The number is not valid"), [ccField?.ref, numField.ref, ...mobileChecks.map((m) => m.ref)].filter(Boolean) as DocRef[]);
  }
  for (const f of fields.filter((x) => fieldVar.get(x) && (x.integer || (x.maxLen && x !== emailF)))) {
    const code = reqCode;
    const parts2: string[] = [];
    if (f.integer) parts2.push(`(${v(fieldVar.get(f)!)} != "" and $not($contains(${v(fieldVar.get(f)!)}, /^\\d+$/)))`);
    if (f.maxLen && f !== emailF) parts2.push(`$length(${v(fieldVar.get(f)!)}) > ${f.maxLen}`);
    addCheck(code, `${f.source} ${[f.integer && "not a whole number", f.maxLen && f !== emailF && `longer than ${f.maxLen}`].filter(Boolean).join(" or ")}`, parts2.join(" or "), errMessage(code, errFor(code)?.when ?? "The request is not valid"), [f.ref]);
  }
  let last: FlowNode = prep, lastPort = "out";
  if (conds.length) {
    const check = add("logic.choice", "Check the request", { conditions: conds.map((c) => ({ id: c.id, label: c.label, expr: c.expr })) }, "The first problem found answers with its error; otherwise the request goes on.");
    wire(prep, "out", check);
    const answers = new Map<string, FlowNode>();
    for (const c of conds) {
      const key = `${c.code}|${c.message}`;
      const r = answers.get(key) ?? add("respond", `Answer ${c.status} ${c.code}`, { status: String(c.status), body: errBody(c.code, c.message), headers: respHeaders, contentType: "application/json" });
      answers.set(key, r);
      wire(check, `case:${c.id}`, r);
      items.push({ kind: "error", title: `${c.status} ${c.code}`, detail: c.label, ref: c.errRef ?? c.refs[0], nodeIds: [check.id, r.id] });
    }
    last = check; lastPort = "otherwise";
  }
  for (const h of headerSpecs.values()) {
    const it: DocItem = { kind: "header", title: h.name, detail: h.generate ? "generated when missing and returned in the response header" : /^content-type$/i.test(h.name) ? "JSON requests (read by the listener)" : /authori|api key/i.test(h.name) ? "checked by the gateway (OAuth2), not by the flow" : `${h.mandatory ? "required" : "optional"}${h.allowed.length ? `; allowed: ${h.allowed.join(", ")}` : ""}${h.caseInsensitive ? "; any letter case" : ""}`, ref: h.ref, nodeIds: [] };
    if (!/authori|api key|^content-type$/i.test(h.name)) it.nodeIds.push(prep.id);
    if (conds.some((c) => c.refs.some((r) => r.line === h.line))) it.nodeIds.push(nodes.find((n) => n.type === "logic.choice")!.id);
    items.push(it); mark(h.section);
  }
  for (const e of errors) if (!conds.some((c) => c.code === e.code)) {
    const how = e.status === 401 || e.status === 403 ? "answered by the gateway (OAuth2)" : e.status === 429 ? "answered by the gateway throttling policy" : /crm|target|timeout|error after retries/i.test(e.when) ? "answered after the target call fails (see below)" : "no check could be derived for it";
    if (how.startsWith("no check")) handWritten.push({ text: `${e.status} ${e.code}: ${e.when}`, ref: refOf(e.section, e.line), why: "The reader could not tell which condition this error belongs to." });
    else if (!/after the target/.test(how)) items.push({ kind: "error", title: `${e.status} ${e.code}`, detail: how, ref: refOf(e.section, e.line), nodeIds: [] });
  }

  // the record for the target system
  const rules: MappingRule[] = [];
  const recordOrder = record ? Object.keys(record) : [];
  const targetFields = fields.filter((f) => f.target && !f.partOf && !/^part of/i.test(f.target));
  const ordered = [...recordOrder.map((k) => targetFields.find((f) => (f.tag ? "Tag" : f.target) === k)).filter(Boolean) as FieldSpec[], ...targetFields.filter((f) => !recordOrder.includes(f.tag ? "Tag" : f.target))];
  for (const f of ordered) {
    const tgt = f.tag ? "Tag" : f.target;
    let expr = "";
    if (f.built && builtField) expr = v(`${camel(builtField.target)}ForTarget`);
    else if (f.tag) expr = jstr([{ name: f.tag }]);
    else if (f.fromHeader && f.valueMap) expr = v(`${camel(f.fromHeader)}Label`);
    else if (f.template) { const t = f.template.replace(/\{(\w+)\}/g, (_a, n: string) => `" & ${channelField ? v(`${camel(channelField.fromHeader!)}Label`) : `$vars.${camel(n)}`} & "`); expr = `"${t}"`.replace(/^"" & /, "").replace(/ & ""$/, ""); }
    else if (f.fixed !== undefined) expr = jstr(f.fixed);
    else if (fieldVar.get(f)) { const fv = v(fieldVar.get(f)!); const val = f.integer ? `$number(${fv})` : fv; expr = f.dropEmpty ? `${fv} != "" ? ${val}` : val; }
    if (!expr) { handWritten.push({ text: `${tgt}: ${f.rule}`, ref: f.ref, why: "No value could be read for this field." }); continue; }
    // the sample request decides when it disagrees with a fixed value read from wording
    if (record && f.fixed !== undefined && typeof f.fixed === "string" && record[tgt] !== undefined && record[tgt] !== f.fixed && typeof record[tgt] === "string") {
      conflicts.push({ text: `${tgt}: the mapping reads "${f.fixed}" but the sample request sends "${record[tgt]}".`, refs: [f.ref, refOf(curl!.section, curl!.line)], choice: `"${record[tgt]}" (the sample request) is sent.` });
      expr = jstr(record[tgt]);
    }
    rules.push({ id: `r${rules.length + 1}`, target: tgt, kind: "expr", expr, comment: `${f.ref.section}, line ${f.ref.line}: ${short(f.rule || "(no rule)", 160)}` });
    if (f.notUnderstood.length) for (const n of f.notUnderstood) handWritten.push({ text: `${f.label}: ${n}`, ref: f.ref, why: "Part of this rule was not turned into a step." });
    if (f.checkedByTarget) handWritten.push({ text: `${f.label}: ${f.checkedByTarget}`, ref: f.ref, why: "Only the target system knows its allowed values; a wrong value comes back as a target error (502). A list check can be added with a Choice once the values are known." });
  }
  if (record) for (const [k, val] of Object.entries(record)) if (!rules.some((r) => r.target === k)) {
    if (typeof val === "string" && /@|\d{6,}/.test(val)) continue;
    rules.push({ id: `r${rules.length + 1}`, target: k, kind: "expr", expr: jstr(val), comment: `From the sample request (${refOf(curl!.section, curl!.line).section}, line ${curl!.line})` });
  }
  let mapNode: FlowNode | null = null;
  if (rules.length) {
    mapNode = add("transform.map", `Build the ${target.name || "target"} record`, { input: "$", mapping: { rules, passthrough: false }, resultTarget: "variable", resultVar: "record" }, "Empty values produce no field, so they are left out of the request.");
    wire(last, lastPort, mapNode); last = mapNode; lastPort = "out";
    for (const f of fields) items.push({ kind: "mapping", title: f.label, detail: [f.target && `→ ${f.tag ? `Tag [${f.tag}]` : f.target}`, f.response && `response: ${f.response}`, f.understood.join(", ")].filter(Boolean).join("; "), ref: f.ref, nodeIds: [mapNode.id, ...(fieldVar.get(f) || f.built || f.fromHeader ? [prep.id] : [])] });
  }

  // the call
  let call: FlowNode | null = null;
  if (target.method && tPath) {
    const conn = (ctx.connections ?? []).find((c) => c.type === "http" && (norm(c.name) === norm(target.name) || (norm(target.name).length >= 4 && norm(c.name).includes(norm(target.name.split(" ")[0])))));
    const body: Record<string, unknown> = { ...(record ? { data: ["{{ $vars.record }}"] } : {}), ...target.extras };
    call = add("http.request", `${target.method === "POST" && /upsert/i.test(tPath) ? "Upsert" : "Call"} ${target.name}${/\/(\w+)\/upsert/i.test(tPath) ? ` ${/\/(\w+)\/upsert/i.exec(tPath)![1]}` : ""}`, {
      connection: conn?.id ?? "", method: target.method, url: tPath, query: [], headers: [], forwardHeaders: [],
      bodyMode: "json", body: record ? body : "{{ $vars.record }}", failOnStatus: true, responseMode: "auto", output: "body",
      timeoutMs: nfr.timeoutMs || 30000, retries: nfr.retries, retryDelayMs: nfr.delays[0] ?? 500, ...(nfr.delays.length > 1 ? { retryDelaysMs: nfr.delays.join(", ") } : {}),
      resultTarget: "variable", resultVar: "targetResponse",
    });
    wire(last, lastPort, call);
    for (const it of items.filter((x) => x.kind === "target-sample" || (x.kind === "nonfunctional" && /timeout|retries/i.test(x.title)))) link(it, call);
    const tIt = item("target", `${target.name}: ${target.method} ${tPath}`, `${tBase}${target.oauth ? `; ${target.oauth}` : ""}${target.prefix ? `; header Authorization: ${target.prefix} …` : ""}`, target.section ?? sectionAt(sections, 1), target.ref?.line ?? 1);
    link(tIt, call);
    // a connection exists but does not fit the document (sign-in or data centre): offer to edit it
    const wantRefresh = !!target.tokenUrl;
    const misfit = conn ? [
      wantRefresh && conn.authType && conn.authType !== "oauth2refresh" ? `signs in with ${conn.authType === "apiKey" ? "an API key" : conn.authType === "oauth2cc" ? "OAuth2 client credentials" : conn.authType === "bearer" ? "a fixed bearer token" : conn.authType === "basic" ? "a user name and password" : `"${conn.authType}"`}, but the document asks for ${target.oauth ? short(target.oauth.replace(/\s*\(.*$/, ""), 40) + " (" : ""}a refresh token${target.oauth ? ")" : ""}` : "",
      conn.baseUrl && tBase && zohoCentre(tBase) && zohoCentre(conn.baseUrl) && zohoCentre(tBase) !== zohoCentre(conn.baseUrl) ? `points at the Zoho ${zohoCentre(conn.baseUrl)!.label} data centre while the document uses ${zohoCentre(tBase)!.label}` : "",
    ].filter(Boolean) : [];
    // an existing connection keeps its own data centre: the document's address is not forced over a working one
    const connCentre = conn?.baseUrl ? zohoCentre(conn.baseUrl) : null;
    const keepBase = connCentre && zohoCentre(tBase) && connCentre !== zohoCentre(tBase) ? `https://${connCentre.api}` : "";
    if (keepBase) conflicts.push({ text: `The document uses the Zoho ${zohoCentre(tBase)!.label} data centre, but the existing connection "${conn!.name}" is in ${connCentre!.label}.`, refs: [target.ref ?? { section: "", line: 1 }], choice: `The connection's centre (${connCentre!.label}) is kept, with its own token address; change it only if the org really is in ${zohoCentre(tBase)!.label}.` });
    const editBase = keepBase || tBase;
    const editToken = keepBase ? zohoTokenUrlFor(keepBase)! : target.tokenUrl;
    if (conn && misfit.length) missing.push({
      key: `http:${norm(target.name)}:edit`, name: conn.name, type: "http", lines: [target.ref?.line ?? 1], nodeIds: [call.id], existingId: conn.id,
      why: `The connection "${conn.name}" ${misfit.filter((x) => !(keepBase && /data centre/.test(x))).join(", and ") || "does not fit the document"}. Edit it: the sign-in settings are pre-filled${keepBase ? ` for its own data centre (${connCentre!.label})` : ""}; the client id, client secret and refresh token are entered there.`,
      suggested: { baseUrl: editBase, config: { baseUrl: editBase, ...(target.tokenUrl ? { authType: "oauth2refresh", tokenUrl: editToken, clientAuth: "body", tokenPrefix: target.prefix || "Bearer", ...(target.scopes ? { scope: target.scopes } : {}) } : {}), ...(nfr.timeoutMs ? { timeoutMs: nfr.timeoutMs } : {}) } },
    } as MissingConnection);
    if (!conn) missing.push({
      key: `http:${norm(target.name)}`, name: target.name, type: "http", lines: [target.ref?.line ?? 1], nodeIds: [call.id],
      why: `There is no connection for ${target.name} yet. It is offered with the address${target.tokenUrl ? ", token address and scopes" : ""} from the document; the client id, client secret and refresh token are entered there (never in the flow).`,
      suggested: { baseUrl: tBase, config: { baseUrl: tBase, ...(target.tokenUrl ? { authType: "oauth2refresh", tokenUrl: target.tokenUrl, clientAuth: "body", tokenPrefix: target.prefix || "Bearer", ...(target.scopes ? { scope: target.scopes } : {}) } : {}), ...(nfr.timeoutMs ? { timeoutMs: nfr.timeoutMs } : {}) } },
    } as MissingConnection);
    // did the target accept it? (Zoho answers 200 with a status per record)
    const rec0 = record ? "$vars.targetResponse.data[0]" : "$vars.targetResponse";
    const accepted = add("logic.choice", `Did ${target.name} accept it?`, { conditions: [{ id: "c1", label: "Accepted", expr: record ? `${rec0}.status = "success" or ($exists($vars.targetResponse) and $not($exists(${rec0}.status)))` : "true" }] });
    wire(call, "out", accepted);
    const failLog = add("log", "Log the failed subscription", { level: "error", message: `Failed after retries: correlation {{ ${corrVar} }}${headerVars.size ? `, ${[...headerVars.values()].map((k) => `${k} {{ $vars.${k} }}`).join(", ")}` : ""}${nfr.mask ? ", email {{ $vars.emailMasked }}, mobile {{ $vars.mobileMasked }}" : ""}, reason {{ $exists($error) ? $error.message : ${rec0}.code }}`, includePayload: false },
      nfr.queue ? "Stands in for the error queue or table: this Factory has no queue or table target for it yet." : undefined);
    wire(call, "error", failLog); wire(accepted, "otherwise", failLog);
    const tCode = errors.find((e) => /did not respond|timeout|timed out/i.test(e.when) || /TIMEOUT/.test(e.code));
    const eCode = errors.find((e) => /returned an error|error after retries/i.test(e.when) || /_ERROR$/.test(e.code) && e.status >= 500);
    const timedOut = add("logic.choice", "Timed out?", { conditions: [{ id: "c1", label: "Timed out", expr: "$exists($error) and $error.status = 504" }] });
    wire(failLog, "out", timedOut);
    const r504 = add("respond", `Answer ${tCode?.status ?? 504} ${tCode?.code ?? "TIMEOUT"}`, { status: String(tCode?.status ?? 504), body: errBody(tCode?.code ?? "TIMEOUT", tCode?.when ?? "The target system did not respond in time"), headers: respHeaders, contentType: "application/json" });
    const r502 = add("respond", `Answer ${eCode?.status ?? 502} ${eCode?.code ?? "TARGET_ERROR"}`, { status: String(eCode?.status ?? 502), body: errBody(eCode?.code ?? "TARGET_ERROR", eCode?.when ?? "The target system returned an error"), headers: respHeaders, contentType: "application/json" });
    wire(timedOut, "case:c1", r504); wire(timedOut, "otherwise", r502);
    for (const e of [tCode, eCode]) if (e) items.push({ kind: "error", title: `${e.status} ${e.code}`, detail: `${e.when}; the details are logged, not passed back`, ref: refOf(e.section, e.line), nodeIds: [failLog.id, e === tCode ? r504.id : r502.id] });
    if (nfr.queue) { const q = nfr.queue; notes.push(`Failed calls: "${short(q, 120)}". This Factory has no queue or table target for that yet, so a masked error line is logged instead.`); decisions.push({ id: "QUEUE", text: `Failed calls go to an error queue or table: ${short(q, 140)}`, status: "Needs a target", ref: nfr.ref ?? refOf(sectionAt(sections, 1), 1), choice: "Logged as an error line (masked) until a queue or table connection is chosen; replace the log step with a database insert then." }); }
    last = accepted; lastPort = "case:c1";
    if (target.oauth || target.tokenUrl) items.push({ kind: "target", title: "Access token", detail: `${target.oauth ?? "OAuth2"}: the connection uses the refresh-token grant${target.prefix ? ` with "${target.prefix}"` : ""}, caches the token, and fetches a new one once when the API answers 401, then repeats the call.`, ref: target.ref ?? { section: "", line: 1 }, nodeIds: [call.id] });
  }

  // log + answer
  if (nfr.logFields || nfr.mask) {
    const rec0 = record ? "$vars.targetResponse.data[0]" : "$vars.targetResponse";
    const okLog = add("log", "Log the subscription", { level: "info", message: `Stored: correlation {{ ${corrVar} }}${headerVars.size ? `, ${[...headerVars.values()].map((k) => `${k} {{ $vars.${k} }}`).join(", ")}` : ""}, result {{ ${rec0}.action = "insert" ? "created" : (${rec0}.action = "update" ? "updated" : ${rec0}.action) }}, record {{ ${rec0}.details.id }}, {{ $millis() - $vars.startMs }} ms${nfr.mask ? ", email {{ $vars.emailMasked }}, mobile {{ $vars.mobileMasked }}" : ""}`, includePayload: false });
    wire(last, lastPort, okLog); last = okLog; lastPort = "out";
    for (const it of items.filter((x) => x.kind === "nonfunctional" && /logging|masking/i.test(x.title))) link(it, okLog);
  }
  const outFields = resFields.length ? resFields : Object.keys(req?.fields ?? {});
  const resWrap = res?.key ?? "";
  const valueFor = (k: string): string => {
    if (builtField && (builtField.response === k || builtField.target === k)) return v(`${camel(builtField.target)}ForResponse`);
    const f = fields.find((x) => x.source === k);
    if (f && f.email && fieldVar.get(f)) return v(fieldVar.get(f)!);
    return inExpr(k);
  };
  const okBody = `{ ${resWrap ? `${jstr(resWrap)}: { ` : ""}${outFields.map((k) => `${jstr(k)}: ${valueFor(k)}`).join(", ")}${resWrap ? " }" : ""} }`;
  const okNode = add("respond", `Answer ${okStatus}`, { status: String(okStatus), body: okBody, headers: respHeaders, contentType: contentType || "application/json" });
  wire(last, lastPort, okNode);
  for (const it of items.filter((x) => x.kind === "response-sample")) link(it, okNode);
  if (req && res) {
    const gone = Object.keys(req.fields).filter((k) => !resFields.includes(k));
    const added = resFields.filter((k) => !(k in req.fields));
    if (gone.length || added.length) items.push({ kind: "response-rule", title: "Fields replaced in the response", detail: `${gone.join(" and ")} not returned${added.length ? `; ${added.join(", ")} added` : ""}; the other fields keep their names and order`, ref: refOf(resBlock!.section, resBlock!.line), nodeIds: [okNode.id] });
  }
  for (const it of items.filter((x) => x.kind === "request-sample")) link(it, prep);
  if (epItem) link(epItem, okNode);

  // ---- builder decisions that answer open questions
  const dq = (re: RegExp) => decisions.find((d) => re.test(d.text));
  const q2 = dq(/lead_source.*response|response.*lead_source|return .*instead of the empty/i); if (q2) { q2.choice = "Not changed: the response returns what the front end sent (empty). Change the answer step if Q2 says otherwise."; q2.affects = okNode.id; }
  const q4 = dq(/company/i); const company = rules.find((r) => r.target === "Company"); if (q4 && company) { q4.choice = `Company is sent as ${company.expr} (as in the sample request); remove the rule if the CRM admin makes it optional.`; q4.affects = mapNode?.id; }
  const q10 = dq(/store (?:the )?mobile|mobile in (?:the )?crm|without a space.*(?:response|while)/i); if (q10 && builtField) { q10.choice = "Yes: the target system gets no space, the response has one space (as the mapping table says)."; q10.affects = prep.id; }
  const q5 = dq(/first channel|latest/i); if (q5) q5.choice = "The latest channel is sent on every subscription (an upsert overwrites it).";
  const q3 = dq(/rename|country_code/i); if (q3) q3.choice = `The field is read as "${ccField?.source ?? "country code"}" from the request sample; rename it in "Prepare the request" when agreed.`;
  const q1 = dq(/typo|truncat/i); if (q1) q1.choice = "Numbers are never shortened: a 10-digit Saudi number is rejected.";
  const q6 = dq(/already exists as a contact|tag the contact/i); if (q6) q6.choice = "Not built: only Leads are written (upsert by Email); Contacts are not looked up.";
  const q7 = dq(/send the confirmation email again|email again/i); if (q7) q7.choice = "The workflow trigger is sent on every call; whether the e-mail goes out again is decided by the CRM workflow rule.";
  const tagRule = rules.find((r) => r.target === "Tag");
  if (tagRule) decisions.push({ id: "TAGS", text: "Existing tags must be kept when the Newsletter tag is sent inside the record.", status: "Verify in UAT", ref: fields.find((f) => f.tag)?.ref ?? { section: "", line: 1 }, choice: "The record carries Tag [Newsletter] only, as the document says; that the target system keeps other tags on upsert is checked against the stand-in, and must be confirmed on the real org.", affects: mapNode?.id });

  // ---- conflicts between examples and rules
  const testsTable = tables.find((t) => t.kind === "tests");
  if (builtField && testsTable) {
    for (const r of testsTable.rows) {
      const m = /stored as\s+(\+?\d[\d ]*\d)/i.exec(r.cells[2] ?? "");
      if (m && builtField.built!.crmJoin === "" && /\s/.test(m[1].trim())) conflicts.push({ text: `Test ${r.cells[0]} expects the ${builtField.target} stored with a space, but the mapping table${q10 ? ` and ${q10.id}` : ""} say the target system gets it without a space.`, refs: [refOf(testsTable.section, r.line), builtField.ref, ...(q10 ? [q10.ref] : [])], choice: "Stored without a space (mapping table); the test checks the stored value without the space." });
    }
  }

  // ---- test scenarios
  const scenarios: DocScenario[] = [];
  if (testsTable && req) {
    mark(testsTable.section);
    const baseBody = JSON.parse(JSON.stringify(reqBlock!.value)) as Record<string, unknown>;
    const bf = (wrap ? baseBody[wrap] : baseBody) as Record<string, unknown>;
    for (const [k, val] of Object.entries(bf)) {
      if (typeof val !== "string" || !val) continue;
      if (/@/.test(val)) bf[k] = "newsletter.test@example.invalid";
      else if (/name/i.test(k)) bf[k] = /first/i.test(k) ? "Test" : /last/i.test(k) ? "Guest" : "Test";
    }
    const ccSample = ccField ? String(bf[ccField.source] ?? "") : "";
    const okNumber = (cc: string) => { const exact = mobileChecks.map((m) => new RegExp(`"\\+(\\d+)"[^]*?\\/\\^(\\d)\\\\d\\{(\\d+)\\}`).exec(m.cond("n", "c", "d"))).find((x) => x && `+${x[1]}` === cc); return exact ? exact[2] + "1234567890".repeat(2).slice(0, Number(exact[3])) : "21234567"; };
    if (numField) bf[numField.source] = okNumber(ccSample);
    const allowed = [...headerSpecs.values()].find((h) => h.allowed.length);
    const baseHeaders: Record<string, string> = { "content-type": "application/json" };
    if (allowed) baseHeaders[allowed.name.toLowerCase()] = allowed.allowed[0];
    const reqOf = (h: Record<string, string>, b: unknown): DocRequest => ({ method: method || "POST", path: listenPath, headers: h, body: b });
    const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
    let prev: DocScenario | null = null;
    // numbers in the document's tests may be real: the scenarios use made-up digits of the same shape
    const fake = (num: string) => num.replace(/\d+/g, (d) => { if (d.length < 4) return d; const keep = /^0*\d/.exec(d)![0]; return keep + "1234567890".repeat(3).slice(0, d.length - keep.length); });
    for (const r of testsTable.rows) {
      const [id, scen, exp] = r.cells;
      const ref = refOf(testsTable.section, r.line);
      let st = /\b([1-5]\d{2})\b/.exec(exp)?.[1];
      const code = /\b([A-Z][A-Z_]{3,}[A-Z])\b/.exec(exp)?.[1];
      const checks: string[] = [];
      if (/nothing written/i.test(exp)) checks.push("nothing-written");
      if (/only one lead|no second/i.test(exp)) checks.push("one-record");
      if (/empty fields not sent/i.test(exp)) checks.push("no-empty-fields");
      if (/other tags kept/i.test(exp)) checks.push("tags-kept");
      if (/Mobile present/i.test(exp) || /matches section/i.test(exp)) checks.push("response-shape");
      if (/channel (?:value|web)|correct channel/i.test(exp)) checks.push("channel-label");
      if (/lead source newsletter/i.test(exp)) checks.push("lead-source");
      if (/newsletter tag/i.test(exp)) checks.push("tag");
      if (/token refreshed/i.test(exp)) checks.push("token-refreshed");
      if (/retried/i.test(exp)) checks.push("retried");
      if (/error queue|error table/i.test(exp)) checks.push("error-record");
      const stored = /stored as\s+(\+?\d[\d ]*\d)/i.exec(exp); if (stored) checks.push(`stored:${fake(stored[1]).replace(/\s+/g, builtField?.built?.crmJoin ?? "")}`);
      if (!st && checks.some((c) => ["tags-kept", "response-shape", "token-refreshed"].includes(c))) st = String(okStatus);
      let body = clone(baseBody); let headers = { ...baseHeaders };
      const f = (wrap ? body[wrap] : body) as Record<string, unknown>;
      let derived = true; let touched = false; const standIn: DocScenario["standIn"] = {};
      let requests: DocRequest[] | null = null;
      let m: RegExpExecArray | null;
      const hdrName = allowed?.name.toLowerCase() ?? "";
      if ((m = /^same for ([A-Z_, ]+(?:and [A-Z_]+)?)$/i.exec(scen)) && prev) {
        for (const val of m[1].split(/\s*,\s*|\s+and\s+/).filter(Boolean)) {
          scenarios.push({ ...clone(prev), id: `${id}-${val}`, title: `${prev.title.replace(new RegExp(prev.requests[0].headers[hdrName] ?? "$^"), val)}`, ref, requests: prev.requests.map((q) => ({ ...q, headers: { ...q.headers, [hdrName]: val } })), expect: { status: Number(st ?? prev.expect.status), code, checks: [...checks, "channel-label"], words: exp }, derived: true });
        }
        continue;
      }
      if ((m = /([A-Z]-[\w-]+|X-[\w-]+):\s*([A-Z_]+)/.exec(scen))) { headers[m[1].toLowerCase()] = m[2]; touched = true; }
      if ((m = /^([\w-]+) missing$/i.exec(scen.trim()))) { if (headers[m[1].toLowerCase()] !== undefined) delete headers[m[1].toLowerCase()]; else if (m[1] in f) delete f[m[1]]; else derived = false; }
      else if (/sent twice|twice/i.test(scen)) requests = [reqOf(headers, body), reqOf(headers, clone(body))];
      else if ((m = /invalid e-?mail \(([^)]+)\)/i.exec(scen)) && emailF) f[emailF.source] = m[1];
      else if ((m = /^(\+\d{1,4}) with (?:\d+ digits )?(\+?[\d ]+)$/i.exec(scen)) && ccField && numField) { f[ccField.source] = m[1]; f[numField.source] = fake(m[2].trim()); }
      else if ((m = /^empty ([\w ]+)$/i.exec(scen)) && m[1].trim() in f) f[m[1].trim()] = "";
      else if (/all optional fields empty/i.test(scen)) { for (const x of fields) if (x.source && !x.mandatory && x.source in f) f[x.source] = ""; }
      else if ((m = /^([\w ]+):\s*"([^"]*)"$/.exec(scen)) && m[1] in f) f[m[1]] = m[2];
      else if (/token expired/i.test(scen)) standIn.tokenExpired = true;
      else if (/down|timeout/i.test(scen)) standIn.timeout = true;
      else if (/already has other tags/i.test(scen)) standIn.existingTags = ["VIP"];
      else if (/response shape|valid request/i.test(scen)) { /* the base request */ }
      else if (!touched) derived = false;
      if (!st) derived = false;
      checks.splice(0, checks.length, ...new Set(checks));
      const sc: DocScenario = { id, title: scen, ref, requests: requests ?? [reqOf(headers, body)], expect: { status: Number(st ?? 0), ...(code ? { code } : {}), checks, words: exp }, ...(Object.keys(standIn).length ? { standIn } : {}), derived };
      scenarios.push(sc); prev = sc;
      body = {}; headers = {};
      void body; void headers;
    }
    trigger.config.testScenarios = scenarios;
    trigger.config.sampleRequest = scenarios[0]?.requests[0] ? { method: scenarios[0].requests[0].method, path: scenarios[0].requests[0].path, headers: scenarios[0].requests[0].headers, body: scenarios[0].requests[0].body } : undefined;
    items.push({ kind: "tests", title: `${scenarios.length} test scenarios`, detail: `from the test table; ${scenarios.filter((s) => !s.derived).length} could not be turned into a request`, ref: refOf(testsTable.section, testsTable.line), nodeIds: [trigger.id] });
    if (/email received/i.test(testsTable.rows.map((r) => r.cells[2]).join(" "))) handWritten.push({ text: "\"email received\" in the tests", ref: refOf(testsTable.section, testsTable.line), why: "The confirmation e-mail is sent by the CRM workflow, not by the flow; the scenarios check that the workflow trigger is sent." });
  }

  // ---- sections not used for steps
  const usedNums = new Set([...usedSections.keys()].map((n) => n.split(".")[0]));
  for (const s of sections) {
    const top = s.num.split(".")[0];
    if (usedSections.has(s.num) || (s.num.includes(".") && usedSections.has(s.num))) continue;
    if (!s.num.includes(".") && usedNums.has(top) && sections.some((x) => x.num.startsWith(top + ".") && usedSections.has(x.num))) continue;
    if (s.num.includes(".") && usedSections.has(top)) continue;
    const reason = /background|context|overview|purpose/i.test(s.title) ? "background" : /scope/i.test(s.title) ? "scope (who does what)" : /deliverable/i.test(s.title) ? "deliverables" : /acceptance/i.test(s.title) ? "acceptance criteria (covered by the test scenarios)" : /setup|admin/i.test(s.title) ? "setup in the target system, done outside the flow" : /email|notification/i.test(s.title) ? "done by the target system's own workflow (the call sends the workflow trigger)" : /duplicate|repeat/i.test(s.title) ? "handled by the upsert with the duplicate check" : /flow$|end-to-end|steps/i.test(s.title) ? "an overview of the same steps" : "prose with no step wording";
    notUsed.push({ section: `${s.num} ${s.title}`, ref: refOf(s, s.line), reason });
  }
  const credLine = lines.findIndex((l) => /^credentials:/i.test(l.trim()));
  if (credLine >= 0) notUsed.push({ section: "Credentials note", ref: refOf(sectionAt(sections, credLine + 1), credLine + 1), reason: "Credentials are entered on the connection (encrypted on this server), never in the flow or the preview." });

  // ---- layout and result
  layoutDoc(nodes, edges);
  const slugBase = (basePath.split("/")[1] ?? "") || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const settings = {
    ...(basePath ? { basePath } : {}), logPayloads: nfr.mask ? false : true, timeoutMs: 60000,
    gateway: { publish: true, security: "oauth2" as const, ...(basePath ? { context: "/" + (basePath.split("/")[1] ?? slugBase), version: basePath.split("/")[2] ?? "v1" } : {}) },
  };
  if (nfr.mask) items.push({ kind: "nonfunctional", title: "Step traces keep no payload", detail: "The flow setting \"store step input/output\" is off, so personal data stays out of execution traces.", ref: nfr.ref ?? items.find((i) => /masking/i.test(i.title))?.ref ?? { section: "", line: 1 }, nodeIds: [] });
  const sectionList = sections.map((s) => ({ num: s.num, title: s.title, line: s.line, use: (usedSections.get(s.num) ?? (notUsed.some((n) => n.ref.line === s.line) ? "not used" : "partly")) as "used" | "partly" | "not used" }));
  const name = title.length > 80 ? title.slice(0, 79) + "…" : title;
  return {
    mode: "document",
    flow: { name, description: `Built from the requirement document "${short(title, 120)}".`, nodes, edges, settings },
    lines: [], missing, instructions: [], notes, entry: [],
    ok: blocking.length === 0 && nodes.length > 1,
    doc: { title, sections: sectionList, items, decisions, conflicts, handWritten, notUsed, scenarios, blocking },
  };
}

function layoutDoc(nodes: FlowNode[], edges: FlowEdge[]) {
  const col = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const q = nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
  const deg = new Map(indeg);
  while (q.length) { const id = q.shift()!; for (const e of edges.filter((x) => x.from === id)) { col.set(e.to, Math.max(col.get(e.to) ?? 0, (col.get(id) ?? 0) + 1)); deg.set(e.to, (deg.get(e.to) ?? 0) - 1); if (!deg.get(e.to)) q.push(e.to); } }
  const rows = new Map<number, number>();
  // main path first: nodes reached through "out"/"otherwise"/"case:c1 of the accept check" keep row 0
  const main = new Set<string>();
  let cur: string | undefined = nodes[0]?.id;
  while (cur && !main.has(cur)) { main.add(cur); const id: string = cur; const next: FlowEdge | undefined = edges.find((e) => e.from === id && (e.fromPort === "out" || e.fromPort === "otherwise" || (e.fromPort === "case:c1" && nodes.find((n) => n.id === id)?.name.startsWith("Did ")))); cur = next?.to; }
  for (const n of nodes) {
    const c = col.get(n.id) ?? 0;
    const r = main.has(n.id) ? 0 : (rows.get(c) ?? 0) + 1;
    if (!main.has(n.id)) rows.set(c, r);
    n.position = { x: 60 + c * 300, y: 60 + r * 130 };
  }
}
