// Deterministic reader for Ballerina (Swan Lake) service sources.
// Plain text scanning only: comments and string contents are masked (offsets preserved), then
// declarations, services, resources, clients and function bodies are found by brace matching.
// No network, no model, nothing leaves this process.

export interface Src { file: string; line: number; endLine: number; code: string; }

export interface BalFile {
  path: string;          // path shown to the user (relative to the service directory)
  module: string;        // "" for the root module, otherwise the sub-module name (e.g. "core")
  text: string;
  masked: string;
  lineStarts: number[];
}
export interface BalParam { type: string; name: string; annotation?: string; annotationArg?: string; }
export interface BalFunction {
  name: string; module: string; file: BalFile; start: number; end: number;
  params: BalParam[]; returns: string; bodyStart: number; bodyEnd: number;
  exprBodied: boolean; isPublic: boolean; doc: string[];
}
export interface BalConfigurable { key: string; type: string; raw: string; required: boolean; doc: string[]; file: BalFile; start: number; end: number; }
export type ClientKind = "http" | "graphql" | "redis" | "postgres" | "soap" | "other";
export interface BalClient { name: string; kind: ClientKind; type: string; init: string; args: string[]; file: BalFile; start: number; end: number; }
export interface BalResource {
  method: string; path: string; rawPath: string; params: BalParam[]; file: BalFile; start: number; end: number;
  bodyStart: number; bodyEnd: number; exprBodied: boolean; doc: string[];
}
export interface BalService {
  name: string;            // variable name for service objects, the literal path for `service /x on l`
  literalPath?: string;    // `/health`
  listener?: string;
  http: boolean;
  resources: BalResource[];
  file: BalFile; start: number; end: number;
}
export interface BalRecordField { name: string; type: string; raw?: string; optional: boolean; }
export interface BalConst { name: string; raw: string; file: BalFile; start: number; end: number; }
export interface BalPackage {
  org: string; name: string; component: string;
  files: BalFile[];
  imports: Map<string, string>;                 // alias -> imported module ("ballerina/http", "pkg.core", ...)
  functions: Map<string, BalFunction>;          // "<module>:<name>" (root module: ":name")
  configurables: BalConfigurable[];
  clients: BalClient[];
  services: BalService[];
  attaches: { service: string; pathExpr: string }[];
  records: Map<string, BalRecordField[]>;
  consts: Map<string, BalConst>;
}

// ------------------------------------------------------------------ text helpers

/** Blank out comments, doc lines and the contents of string / template literals. Length and
 *  line breaks are preserved so every offset in the result maps 1:1 onto the source. */
export function maskSource(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (a: number, b: number) => { for (let k = a; k < b && k < n; k++) if (out[k] !== "\n") out[k] = " "; };
  let i = 0;
  let lineStart = true;
  while (i < n) {
    const c = src[i];
    if (c === "\n") { lineStart = true; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "#" && lineStart) { let e = src.indexOf("\n", i); if (e < 0) e = n; blank(i, e); i = e; continue; }
    lineStart = false;
    if (c === "/" && src[i + 1] === "/") { let e = src.indexOf("\n", i); if (e < 0) e = n; blank(i, e); i = e; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"' && src[j] !== "\n") { if (src[j] === "\\") j++; j++; }
      blank(i + 1, j); i = j + 1; continue;
    }
    if (c === "`") { let j = src.indexOf("`", i + 1); if (j < 0) j = n; blank(i + 1, j); i = j + 1; continue; }
    if (c === "\\") { out[i] = "_"; if (i + 1 < n && src[i + 1] !== "\n") out[i + 1] = "_"; i += 2; continue; }
    i++;
  }
  return out.join("");
}

function lineStartsOf(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}
export function lineAt(f: BalFile, off: number): number {
  let lo = 0, hi = f.lineStarts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (f.lineStarts[mid] <= off) lo = mid; else hi = mid - 1; }
  return lo + 1;
}
export function makeFile(path: string, module: string, text: string): BalFile {
  return { path, module, text, masked: maskSource(text), lineStarts: lineStartsOf(text) };
}
const MAX_CODE = 6000;
export function srcOf(f: BalFile, start: number, end: number): Src {
  // widen to whole lines so the snippet reads naturally
  let s = start; while (s > 0 && f.text[s - 1] !== "\n") s--;
  let e = end; while (e < f.text.length && f.text[e] !== "\n") e++;
  let code = f.text.slice(s, e);
  // drop the common indentation
  const lines = code.split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  code = lines.map((l) => l.slice(Math.min(cut, l.length))).join("\n");
  if (code.length > MAX_CODE) code = code.slice(0, MAX_CODE) + "\n// ... (truncated)";
  return { file: f.path, line: lineAt(f, start), endLine: lineAt(f, Math.max(start, end - 1)), code };
}

const OPEN = "({[", CLOSE = ")}]";
/** Index of the bracket closing the one at `open` (in masked text), or -1. */
export function matchClose(masked: string, open: number, limit = masked.length): number {
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const c = masked[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
/** Split [start,end) at top-level occurrences of `sep` (a single character). */
export function splitTop(masked: string, start: number, end: number, sep = ","): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let depth = 0, from = start;
  for (let i = start; i < end; i++) {
    const c = masked[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (c === sep && depth === 0) { out.push({ start: from, end: i }); from = i + 1; }
  }
  if (masked.slice(from, end).trim() || out.length) out.push({ start: from, end });
  return out.filter((p) => masked.slice(p.start, p.end).trim().length > 0);
}
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function docBefore(f: BalFile, start: number): string[] {
  const out: string[] = [];
  let ln = lineAt(f, start) - 2; // zero-based index of the previous line
  while (ln >= 0) {
    const line = f.text.slice(f.lineStarts[ln], (f.lineStarts[ln + 1] ?? f.text.length + 1) - 1).trim();
    if (line.startsWith("#")) out.unshift(line.replace(/^#\s?/, ""));
    else if (line.startsWith("//")) out.unshift(line.replace(/^\/\/\s?/, ""));
    else if (line.startsWith("@")) { ln--; continue; }
    else break;
    ln--;
  }
  return out;
}

// ------------------------------------------------------------------ declarations

interface Range { start: number; end: number; }
const BLOCK_DECL = /^(?:@[\w:]+\s*(?:\{[^}]*\})?\s*)*(?:public\s+|isolated\s+|transactional\s+|client\s+|readonly\s+|distinct\s+)*(?:function|service|class|enum)\b/;

function topStatements(f: BalFile): Range[] {
  const m = f.masked, n = m.length, out: Range[] = [];
  let i = 0;
  while (i < n) {
    while (i < n && (/\s/.test(m[i]) || m[i] === ";")) i++;
    if (i >= n) break;
    const start = i;
    const blockDecl = BLOCK_DECL.test(m.slice(i, i + 400));
    let depth = 0, end = -1, arrow = false, sawBrace = false;
    for (; i < n; i++) {
      const c = m[i];
      if (OPEN.includes(c)) { if (c === "{" && depth === 0) sawBrace = true; depth++; }
      else if (CLOSE.includes(c)) {
        depth--;
        if (depth === 0 && c === "}" && blockDecl && !arrow) { end = i + 1; break; }
      } else if (c === "=" && m[i + 1] === ">" && depth === 0 && !sawBrace) arrow = true;
      else if (c === ";" && depth === 0) { end = i + 1; break; }
    }
    if (end < 0) end = n;
    out.push({ start, end });
    i = end;
  }
  return out;
}

function parseParams(f: BalFile, start: number, end: number): BalParam[] {
  const out: BalParam[] = [];
  for (const p of splitTop(f.masked, start, end)) {
    let s = p.start, e = p.end;
    let annotation: string | undefined, annotationArg: string | undefined;
    for (;;) {
      const lead = /^\s*@([\w:]+)\s*/.exec(f.masked.slice(s, e));
      if (!lead) break;
      annotation = lead[1];
      s += lead[0].length;
      if (f.masked[s] === "{") {
        const c = matchClose(f.masked, s, e);
        if (c > 0) { annotationArg = f.text.slice(s, c + 1); s = c + 1; }
      }
    }
    // strip a default value
    let depth = 0;
    for (let i = s; i < e; i++) {
      const c = f.masked[i];
      if (OPEN.includes(c)) depth++; else if (CLOSE.includes(c)) depth--;
      else if (c === "=" && depth === 0) { e = i; break; }
    }
    const text = squash(f.text.slice(s, e));
    const mm = /^(.*?)\s*([A-Za-z_'][\w]*)$/.exec(text);
    if (!mm) continue;
    out.push({ type: mm[1].trim(), name: mm[2].replace(/^'/, ""), annotation, annotationArg });
  }
  return out;
}

function parseFunction(f: BalFile, r: Range): BalFunction | null {
  const head = /^((?:public\s+|isolated\s+|transactional\s+)*)function\s+([A-Za-z_]\w*)\s*\(/.exec(f.masked.slice(r.start, r.end));
  if (!head) return null;
  const open = r.start + head[0].length - 1;
  const close = matchClose(f.masked, open, r.end);
  if (close < 0) return null;
  let bodyStart = -1, expr = false, i = close + 1;
  for (; i < r.end; i++) {
    if (f.masked[i] === "=" && f.masked[i + 1] === ">") { expr = true; bodyStart = i + 2; break; }
    if (f.masked[i] === "{") { bodyStart = i + 1; break; }
  }
  if (bodyStart < 0) return null;
  const returns = squash(f.text.slice(close + 1, i)).replace(/^returns\s+/, "");
  return {
    name: head[2], module: f.module, file: f, start: r.start, end: r.end, params: parseParams(f, open + 1, close), returns,
    bodyStart, bodyEnd: r.end - 1, exprBodied: expr, isPublic: /public/.test(head[1]), doc: docBefore(f, r.start),
  };
}

/** `get getFolio/\(accountId\)/[string id]` -> `/getFolio/(accountId)/{id}` */
export function resourcePath(raw: string): string {
  const t = raw.trim();
  if (t === "." || t === "") return "/";
  const segs = t.split("/").map((s) => s.trim()).filter(Boolean).map((s) => {
    const p = /^\[\s*(.+?)\s*\]$/.exec(s);
    if (p) {
      const rest = /\.\.\.\s*(\w+)?$/.exec(p[1]);
      if (rest) return `{${rest[1] || "path"}*}`;
      const name = /([A-Za-z_]\w*)$/.exec(p[1]);
      return `{${name ? name[1] : "param"}}`;
    }
    return s.replace(/\\(.)/g, "$1").replace(/^'/, "");
  });
  return "/" + segs.join("/");
}

function parseResources(f: BalFile, start: number, end: number): BalResource[] {
  const out: BalResource[] = [];
  const m = f.masked;
  const re = /(?:isolated\s+|transactional\s+)*resource\s+function\s+([A-Za-z_']\w*)\s+/g;
  re.lastIndex = start;
  for (;;) {
    const hit = re.exec(m);
    if (!hit || hit.index >= end) break;
    const pathStart = hit.index + hit[0].length;
    const open = m.indexOf("(", pathStart);
    if (open < 0 || open >= end) break;
    const close = matchClose(m, open, end);
    if (close < 0) break;
    let bodyStart = -1, expr = false, i = close + 1;
    for (; i < end; i++) {
      if (m[i] === "=" && m[i + 1] === ">") { expr = true; bodyStart = i + 2; break; }
      if (m[i] === "{") { bodyStart = i + 1; break; }
    }
    if (bodyStart < 0) break;
    let stop: number;
    if (expr) {
      let depth = 0; stop = bodyStart;
      for (; stop < end; stop++) { const c = m[stop]; if (OPEN.includes(c)) depth++; else if (CLOSE.includes(c)) depth--; else if (c === ";" && depth === 0) break; }
    } else stop = matchClose(m, bodyStart - 1, end);
    if (stop < 0) break;
    const rawPath = f.text.slice(pathStart, open);
    const accessor = hit[1].replace(/^'/, "").toUpperCase();
    out.push({
      method: accessor === "DEFAULT" ? "ANY" : accessor, path: resourcePath(rawPath), rawPath: rawPath.trim(),
      params: parseParams(f, open + 1, close), file: f, start: hit.index, end: stop + 1,
      bodyStart, bodyEnd: stop, exprBodied: expr, doc: docBefore(f, hit.index),
    });
    re.lastIndex = stop + 1;
  }
  return out;
}

function parseRecordFields(f: BalFile, start: number, end: number): BalRecordField[] {
  const out: BalRecordField[] = [];
  for (const p of splitTop(f.masked, start, end, ";")) {
    const mText = f.masked.slice(p.start, p.end);
    if (/^\s*\*/.test(mText)) continue;
    let eq = -1, depth = 0;
    for (let i = p.start; i < p.end; i++) {
      const c = f.masked[i];
      if (OPEN.includes(c)) depth++; else if (CLOSE.includes(c)) depth--;
      else if (c === "=" && depth === 0) { eq = i; break; }
    }
    const declText = squash(f.text.slice(p.start, eq < 0 ? p.end : eq)).replace(/^\|/, "").replace(/\|$/, "").trim();
    const mm = /^(?:readonly\s+)?(.*?)\s+'?([A-Za-z_]\w*)(\?)?$/.exec(declText);
    if (!mm) continue;
    out.push({ name: mm[2], type: mm[1], optional: !!mm[3], raw: eq < 0 ? undefined : f.text.slice(eq + 1, p.end).trim() });
  }
  return out;
}

const CLIENT_TYPE = /\b([A-Za-z_]\w*):(Client|Caller|Producer|Consumer|SmtpClient|Listener)\b/;
function clientKind(type: string, pkgImports: Map<string, string>): ClientKind | null {
  const mm = CLIENT_TYPE.exec(type);
  if (!mm || mm[2] === "Caller" || mm[2] === "Listener") return null;
  const mod = (pkgImports.get(mm[1]) || mm[1]).toLowerCase();
  if (/redis/.test(mod)) return "redis";
  if (/graphql/.test(mod)) return "graphql";
  if (/postgres|mysql|mssql|oracledb|jdbc|\bsql\b/.test(mod)) return "postgres";
  if (/soap/.test(mod)) return "soap";
  if (/http/.test(mod)) return "http";
  return "other";
}

function parseTopLevel(pkg: BalPackage, f: BalFile) {
  const m = f.masked;
  for (const r of topStatements(f)) {
    let head = m.slice(r.start, r.end);
    let s = r.start;
    // leading annotations
    for (;;) {
      const a = /^@[\w:]+\s*/.exec(head);
      if (!a) break;
      s += a[0].length;
      if (m[s] === "{") { const c = matchClose(m, s, r.end); if (c < 0) break; s = c + 1; }
      while (s < r.end && /\s/.test(m[s])) s++;
      head = m.slice(s, r.end);
    }
    const stmt: Range = { start: s, end: r.end };
    let mm: RegExpExecArray | null;
    if ((mm = /^import\s+([\w./']+)(?:\s+as\s+(\w+))?\s*;/.exec(head))) {
      const mod = mm[1];
      const alias = mm[2] || mod.split(/[/.]/).pop()!;
      if (alias !== "_") pkg.imports.set(alias, mod);
      continue;
    }
    if (/^(?:public\s+|isolated\s+|transactional\s+)*function\b/.test(head)) {
      const fn = parseFunction(f, stmt);
      if (fn) pkg.functions.set(`${f.module}:${fn.name}`, fn);
      continue;
    }
    if ((mm = /^(?:isolated\s+)?service\s+/.exec(head)) && !/^(?:isolated\s+)?service\s+class\b/.test(head)) {
      const open = m.indexOf("{", s);
      if (open < 0 || open >= r.end) continue;
      const headText = squash(f.text.slice(s + mm[0].length, open));
      const on = /^(.*?)\s*\bon\s+(.+)$/.exec(headText);
      const what = (on ? on[1] : headText).trim();
      const listener = on ? on[2].trim() : undefined;
      const pathMatch = /(\/[^\s]*|"[^"]*")\s*$/.exec(what);
      const literal = pathMatch ? pathMatch[1] : "";
      const isHttp = literal.startsWith("/") || /http:/.test(what) || (!literal && !what);
      pkg.services.push({
        name: literal || what || "service", literalPath: literal.startsWith("/") ? literal.replace(/\\(.)/g, "$1") : undefined,
        listener, http: isHttp, resources: parseResources(f, open + 1, r.end - 1), file: f, start: r.start, end: r.end,
      });
      continue;
    }
    if ((mm = /^configurable\s+([\s\S]+?)\s+'?([A-Za-z_]\w*)\s*=\s*/.exec(head))) {
      const raw = f.text.slice(s + mm[0].length, r.end - 1).trim();
      pkg.configurables.push({
        key: mm[2], type: squash(mm[1]), raw, required: raw === "?", doc: docBefore(f, r.start), file: f, start: r.start, end: r.end,
      });
      continue;
    }
    if ((mm = /^(?:public\s+)?type\s+([A-Za-z_]\w*)\s+(?:readonly\s*&\s*)?record\s*\{\|?/.exec(head))) {
      const open = m.indexOf("{", s);
      const close = matchClose(m, open, r.end);
      if (close > 0) {
        const inner0 = m[open + 1] === "|" ? open + 2 : open + 1;
        const inner1 = m[close - 1] === "|" ? close - 1 : close;
        pkg.records.set(`${f.module}:${mm[1]}`, parseRecordFields(f, inner0, inner1));
      }
      continue;
    }
    if ((mm = /^(?:public\s+)?const\s+(?:[\w:<>\[\]?|]+\s+)?([A-Za-z_]\w*)\s*=\s*/.exec(head))) {
      pkg.consts.set(`${f.module}:${mm[1]}`, { name: mm[1], raw: f.text.slice(s + mm[0].length, r.end - 1).trim(), file: f, start: r.start, end: r.end });
      continue;
    }
    if ((mm = /^listener\s+([\s\S]+?)\s+([A-Za-z_]\w*)\s*=\s*/.exec(head))) continue;
    if ((mm = /^(?:public\s+)?(?:isolated\s+)?final\s+([\s\S]+?)\s+'?([A-Za-z_]\w*)\s*=\s*/.exec(head))) {
      const type = squash(mm[1]);
      const name = mm[2];
      const exprStart = s + mm[0].length;
      const exprMasked = m.slice(exprStart, r.end - 1);
      if (/^(?:isolated\s+)?service\s+object\s*\{/.test(exprMasked.trim())) {
        const open = m.indexOf("{", exprStart);
        const close = matchClose(m, open, r.end);
        pkg.services.push({ name, http: true, resources: parseResources(f, open + 1, close < 0 ? r.end : close), file: f, start: r.start, end: r.end });
        continue;
      }
      const kind = clientKind(type, pkg.imports);
      if (kind) {
        const init = f.text.slice(exprStart, r.end - 1).trim();
        const open = m.indexOf("(", exprStart);
        let args: string[] = [];
        if (open > 0 && open < r.end) {
          const close = matchClose(m, open, r.end);
          if (close > 0) args = splitTop(m, open + 1, close).map((a) => f.text.slice(a.start, a.end).trim());
        }
        pkg.clients.push({ name, kind, type, init, args, file: f, start: r.start, end: r.end });
        continue;
      }
      pkg.consts.set(`${f.module}:${name}`, { name, raw: f.text.slice(exprStart, r.end - 1).trim(), file: f, start: r.start, end: r.end });
      continue;
    }
  }
}

/** Build a package model from already-loaded files. `component` labels where the files came from. */
export function parsePackage(org: string, name: string, component: string, files: BalFile[]): BalPackage {
  const pkg: BalPackage = {
    org, name, component, files, imports: new Map(), functions: new Map(), configurables: [], clients: [], services: [],
    attaches: [], records: new Map(), consts: new Map(),
  };
  // imports first: client kinds depend on aliases
  for (const f of files) {
    const re = /^[ \t]*import\s+([\w./']+)(?:\s+as\s+(\w+))?\s*;/gm;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(f.masked))) { const alias = mm[2] || mm[1].split(/[/.]/).pop()!; if (alias !== "_") pkg.imports.set(alias, mm[1]); }
  }
  for (const f of files) parseTopLevel(pkg, f);
  for (const f of files) {
    const re = /\.attach\s*\(/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(f.masked))) {
      const open = mm.index + mm[0].length - 1;
      const close = matchClose(f.masked, open);
      if (close < 0) continue;
      const args = splitTop(f.masked, open + 1, close).map((a) => f.text.slice(a.start, a.end).trim());
      if (args.length >= 2) pkg.attaches.push({ service: args[0], pathExpr: args[1] });
    }
  }
  return pkg;
}

// ------------------------------------------------------------------ literals

export type Lit = string | number | boolean | null | Lit[] | { [k: string]: Lit } | { __expr: string };
export const isExpr = (v: unknown): v is { __expr: string } => !!v && typeof v === "object" && "__expr" in (v as object);

/** Parse a Ballerina literal ({a: 1, "b": [..]}, strings, numbers, booleans). Anything that is not a
 *  literal comes back as { __expr: "<source text>" }. */
export function parseLiteral(text: string): Lit {
  const src = text.trim();
  const masked = maskSource(src);
  function at(s: number, e: number): Lit {
    while (s < e && /\s/.test(src[s])) s++;
    while (e > s && /\s/.test(src[e - 1])) e--;
    const t = src.slice(s, e);
    if (!t) return { __expr: "" };
    if (t === "()" || t === "null") return null;
    if (t === "true") return true;
    if (t === "false") return false;
    if (/^-?\d+(\.\d+)?[dDfF]?$/.test(t)) return Number(t.replace(/[dDfF]$/, ""));
    if (src[s] === '"' && masked.indexOf('"', s + 1) === e - 1) {
      try { return JSON.parse(t) as string; } catch { return t.slice(1, -1); }
    }
    if (/^string\s*`/.test(t) && t.endsWith("`")) return t.slice(t.indexOf("`") + 1, -1);
    if (src[s] === "{" && matchClose(masked, s, e) === e - 1) {
      const out: { [k: string]: Lit } = {};
      for (const p of splitTop(masked, s + 1, e - 1)) {
        let colon = -1, depth = 0;
        for (let i = p.start; i < p.end; i++) {
          const c = masked[i];
          if (OPEN.includes(c)) depth++; else if (CLOSE.includes(c)) depth--;
          else if (c === ":" && depth === 0) {
            const before = src.slice(p.start, i).trim();
            if (/^("[^"]*"|'?[A-Za-z_]\w*|\[[^\]]+\])$/.test(before)) colon = i;
            break;
          }
        }
        const whole = src.slice(p.start, p.end).trim();
        if (colon < 0) {
          if (whole.startsWith("...")) out["..." + whole.slice(3)] = { __expr: whole.slice(3) };
          else out[whole.replace(/^'/, "")] = { __expr: whole };
          continue;
        }
        let key = src.slice(p.start, colon).trim();
        if (key.startsWith('"')) { try { key = JSON.parse(key); } catch { key = key.slice(1, -1); } }
        else if (key.startsWith("[")) key = key.slice(1, -1).trim();
        out[key.replace(/^'/, "")] = at(colon + 1, p.end);
      }
      return out;
    }
    if (src[s] === "[" && matchClose(masked, s, e) === e - 1) return splitTop(masked, s + 1, e - 1).map((p) => at(p.start, p.end));
    return { __expr: squash(t) };
  }
  return at(0, src.length);
}

// ------------------------------------------------------------------ statements

export type Stmt =
  | { kind: "simple"; start: number; end: number }
  | { kind: "if"; start: number; end: number; condStart: number; condEnd: number; then: Stmt[]; else: Stmt[]; thenEnd: number }
  | { kind: "loop"; start: number; end: number; headStart: number; headEnd: number; body: Stmt[] }
  | { kind: "match"; start: number; end: number; headStart: number; headEnd: number; cases: { start: number; end: number; patStart: number; patEnd: number; body: Stmt[] }[] }
  | { kind: "block"; start: number; end: number; body: Stmt[]; onFail: Stmt[] };

function wordAt(m: string, i: number): string { const mm = /^[A-Za-z_]\w*/.exec(m.slice(i, i + 24)); return mm ? mm[0] : ""; }
function findBlockOpen(m: string, i: number, end: number): number {
  let depth = 0;
  for (; i < end; i++) {
    const c = m[i];
    if (c === "{" && depth === 0) return i;
    if (OPEN.includes(c)) depth++; else if (CLOSE.includes(c)) depth--;
  }
  return -1;
}

/** Parse the statements of a block body [start,end) (masked text of one file). */
export function parseBlock(m: string, start: number, end: number): Stmt[] {
  const out: Stmt[] = [];
  let i = start;
  const ws = () => { while (i < end && (/\s/.test(m[i]) || m[i] === ";")) i++; };
  for (;;) {
    ws();
    if (i >= end) break;
    const s = i;
    const w = wordAt(m, i);
    if (w === "if") {
      const open = findBlockOpen(m, i + 2, end);
      const close = open < 0 ? -1 : matchClose(m, open, end);
      if (close < 0) { out.push({ kind: "simple", start: s, end }); break; }
      const node: Extract<Stmt, { kind: "if" }> = { kind: "if", start: s, end: close + 1, condStart: s + 2, condEnd: open, then: parseBlock(m, open + 1, close), else: [], thenEnd: close + 1 };
      i = close + 1;
      const save = i; ws();
      if (wordAt(m, i) === "else") {
        i += 4; ws();
        if (wordAt(m, i) === "if") {
          const rest = parseBlock(m, i, end);
          // only the first statement belongs to this chain
          if (rest.length) { node.else = [rest[0]]; node.end = rest[0].end; i = rest[0].end; }
        } else if (m[i] === "{") {
          const c2 = matchClose(m, i, end);
          if (c2 > 0) { node.else = parseBlock(m, i + 1, c2); node.end = c2 + 1; i = c2 + 1; }
        }
      } else i = save;
      out.push(node);
      continue;
    }
    if (w === "foreach" || w === "while") {
      const open = findBlockOpen(m, i + w.length, end);
      const close = open < 0 ? -1 : matchClose(m, open, end);
      if (close < 0) { out.push({ kind: "simple", start: s, end }); break; }
      out.push({ kind: "loop", start: s, end: close + 1, headStart: s, headEnd: open, body: parseBlock(m, open + 1, close) });
      i = close + 1;
      continue;
    }
    if (w === "match") {
      const open = findBlockOpen(m, i + 5, end);
      const close = open < 0 ? -1 : matchClose(m, open, end);
      if (close < 0) { out.push({ kind: "simple", start: s, end }); break; }
      const cases: Extract<Stmt, { kind: "match" }>["cases"] = [];
      let j = open + 1;
      while (j < close) {
        while (j < close && /\s/.test(m[j])) j++;
        if (j >= close) break;
        const arrow = m.indexOf("=>", j);
        if (arrow < 0 || arrow >= close) break;
        const bo = findBlockOpen(m, arrow + 2, close);
        const bc = bo < 0 ? -1 : matchClose(m, bo, close + 1);
        if (bc < 0) break;
        cases.push({ start: j, end: bc + 1, patStart: j, patEnd: arrow, body: parseBlock(m, bo + 1, bc) });
        j = bc + 1;
      }
      out.push({ kind: "match", start: s, end: close + 1, headStart: s + 5, headEnd: open, cases });
      i = close + 1;
      continue;
    }
    if (w === "do" || w === "lock" || w === "transaction" || w === "retry" || m[i] === "{") {
      const open = m[i] === "{" ? i : findBlockOpen(m, i + w.length, end);
      const close = open < 0 ? -1 : matchClose(m, open, end);
      // `retry` and `do` must be followed directly by a block; otherwise it is an ordinary statement
      if (close > 0 && (m[i] === "{" || /^[\s<>\w(),]*$/.test(m.slice(i + w.length, open)))) {
        const node: Extract<Stmt, { kind: "block" }> = { kind: "block", start: s, end: close + 1, body: parseBlock(m, open + 1, close), onFail: [] };
        i = close + 1;
        const save = i; ws();
        if (wordAt(m, i) === "on" && /^on\s+fail\b/.test(m.slice(i, i + 12))) {
          const o2 = findBlockOpen(m, i, end);
          const c2 = o2 < 0 ? -1 : matchClose(m, o2, end);
          if (c2 > 0) { node.onFail = parseBlock(m, o2 + 1, c2); node.end = c2 + 1; i = c2 + 1; } else i = save;
        } else i = save;
        out.push(node);
        continue;
      }
    }
    // simple statement: up to ';' at depth 0
    let depth = 0, e = i;
    for (; e < end; e++) {
      const c = m[e];
      if (OPEN.includes(c)) depth++; else if (CLOSE.includes(c)) depth--;
      else if (c === ";" && depth === 0) break;
    }
    out.push({ kind: "simple", start: s, end: Math.min(e + 1, end) });
    i = e + 1;
  }
  return out;
}

export interface CallSite { qualifier: string; name: string; remote: boolean; receiver: string; start: number; open: number; close: number; args: Range[]; started: boolean; }
const NOT_CALLS = new Set(["if", "while", "foreach", "match", "return", "check", "checkpanic", "new", "function", "returns", "typeof", "trap", "wait", "start", "is", "in", "let", "from", "where", "select", "on", "fail", "panic", "lock", "error", "object", "service", "record", "map", "string", "int", "boolean", "decimal", "float", "json", "xml", "byte", "anydata", "any", "table", "stream", "future", "typedesc", "handle", "never", "readonly"]);

/** Function calls and remote (`client->method(...)`) calls inside [start,end), innermost first. */
export function findCalls(m: string, start: number, end: number): CallSite[] {
  const out: CallSite[] = [];
  const text = m.slice(start, end);
  const remote = /([A-Za-z_][\w']*(?:\.[A-Za-z_'][\w']*)*)\s*->\s*([A-Za-z_]\w*)\s*\(/g;
  let mm: RegExpExecArray | null;
  const taken = new Set<number>();
  while ((mm = remote.exec(text))) {
    const open = start + mm.index + mm[0].length - 1;
    const close = matchClose(m, open, end);
    if (close < 0) continue;
    taken.add(open);
    out.push({ qualifier: "", name: mm[2], remote: true, receiver: mm[1], start: start + mm.index, open, close, args: splitTop(m, open + 1, close), started: false });
  }
  const fn = /(^|[^\w.:'>])((?:([A-Za-z_]\w*):)?'?([A-Za-z_]\w*))\s*\(/g;
  while ((mm = fn.exec(text))) {
    const open = start + mm.index + mm[0].length - 1;
    if (taken.has(open)) continue;
    if (!mm[3] && NOT_CALLS.has(mm[4])) { fn.lastIndex = mm.index + mm[0].length - 1; continue; }
    const close = matchClose(m, open, end);
    if (close < 0) continue;
    const callStart = start + mm.index + mm[1].length;
    const before = m.slice(Math.max(start, callStart - 8), callStart);
    out.push({ qualifier: mm[3] || "", name: mm[4], remote: false, receiver: "", start: callStart, open, close, args: splitTop(m, open + 1, close), started: /\bstart\s+$/.test(before) });
    fn.lastIndex = mm.index + mm[0].length - 1; // look inside the arguments too
  }
  return out.sort((a, b) => a.close - b.close);
}
