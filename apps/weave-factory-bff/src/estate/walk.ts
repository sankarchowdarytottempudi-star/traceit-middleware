// Follows a resource function through the functions it calls and records, in order, what it does:
// connector calls, data mappings, branches, loops, background work and the responses it can give.
// Purely textual and deterministic; conditions are kept as written, never evaluated.
import {
  type BalClient, type BalFile, type BalFunction, type BalPackage, type BalResource, type Src, type Stmt,
  findCalls, parseBlock, parseLiteral, isExpr, srcOf, matchClose, splitTop, maskSource,
} from "./bal.js";

export interface Bound {
  text: string;            // the expression as written
  value?: string;          // resolved text where known ({name} marks parts only known at run time)
  keys: string[];          // configuration keys that fed the value
  mapping?: string;        // id of the mapping function that produced it
  headers?: HeaderInfo;
}
export interface HeaderInfo { names: string[]; forwarded: string[]; }

export type Step =
  | { kind: "call"; client: string; op: string; args: Bound[]; path?: Bound; body?: Bound; headers?: HeaderInfo; inFunction: string; src: Src }
  | { kind: "map"; mapping: string; src: Src }
  | { kind: "if"; cond: string; then: Step[]; else: Step[]; thenReturns: boolean; elseReturns: boolean; src: Src }
  | { kind: "match"; subject: string; subjectBound?: Bound; cases: { label: string; steps: Step[]; src: Src }[]; src: Src }
  | { kind: "loop"; header: string; steps: Step[]; src: Src }
  | { kind: "async"; fn: string; steps: Step[]; src: Src }
  | { kind: "respond"; status: number; message?: string; when?: string; guard?: boolean; src: Src };

export interface WalkResult { steps: Step[]; features: string[]; headersRead: string[]; passThrough: boolean; truncated: boolean; }

export interface WalkContext {
  pkg: BalPackage;
  clients: Map<string, BalClient>;
  config: (path: string) => unknown;            // resolved configuration value for `a.b.c`, or undefined
  mappingOf: (fn: BalFunction) => string | undefined;
  mappingHeaders?: (id: string) => string[] | undefined;
}

/** Framework error types and the HTTP status they produce. */
export const ERROR_STATUS: Record<string, number> = {
  BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, VALIDATION_ERROR: 406,
  NOT_ACCEPTABLE: 406, CONFLICT: 409, UNSUPPORTED_MEDIA_TYPE: 415, TOO_MANY_REQUESTS: 429, INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501, BAD_GATEWAY: 502, CONNECTIVITY: 502, CIRCUIT_OPEN: 503, SERVICE_UNAVAILABLE: 503,
  BACKEND_NOT_CONFIGURED: 503, TIMEOUT: 504,
};
/** Headers the shared framework copies from the caller on `forwardHeaders(...)`. */
export const PASS_THROUGH_HEADERS = ["Authorization", "client_id", "client_secret", "client_channel", "origin", "accept-language", "uniquePkgType", "X-Seaware-Authorization"];

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const MAX_STEPS = 400;
const MAX_DEPTH = 12;

interface Scope {
  file: BalFile; module: string; fnName: string;
  env: Map<string, Bound>;
  locals: Map<string, string>;
  assigns: Map<string, [string, string][]>;
  resolving: Set<string>;
}

export function walkResource(ctx: WalkContext, res: BalResource): WalkResult {
  const state = { count: 0, features: new Set<string>(), headersRead: new Set<string>(), truncated: false, passThrough: false };
  const scope: Scope = { file: res.file, module: res.file.module, fnName: `${res.method} ${res.path}`, env: new Map(), locals: new Map(), assigns: new Map(), resolving: new Set() };
  for (const p of res.params) scope.env.set(p.name, { text: p.name, keys: [] });
  const stmts: Stmt[] = res.exprBodied ? [{ kind: "simple", start: res.bodyStart, end: res.bodyEnd }] : parseBlock(res.file.masked, res.bodyStart, res.bodyEnd);

  const lookupFn = (qualifier: string, name: string, module: string): BalFunction | undefined => {
    if (!qualifier) return ctx.pkg.functions.get(`${module}:${name}`) ?? ctx.pkg.functions.get(`:${name}`);
    const mod = ctx.pkg.imports.get(qualifier);
    if (!mod) return undefined;
    const bare = mod.includes("/") ? mod.slice(mod.indexOf("/") + 1) : mod;
    const sub = bare.startsWith(ctx.pkg.name + ".") ? bare.slice(ctx.pkg.name.length + 1) : null;
    return sub === null ? undefined : ctx.pkg.functions.get(`${sub}:${name}`);
  };

  function evalExpr(raw: string, sc: Scope, depth = 0): Bound {
    let t = raw.trim().replace(/^check\s+/, "").replace(/^<[^>]+>\s*/, "").trim();
    const text = squash(t);
    if (depth > 6 || !t) return { text, keys: [] };
    const lit = /^"((?:[^"\\]|\\.)*)"$/.exec(t);
    if (lit) { let v = lit[1]; try { v = JSON.parse(t); } catch { /* keep */ } return { text, value: v, keys: [] }; }
    const tpl = /^string\s*`([^`]*)`$/.exec(t);
    if (tpl) return { text, value: tpl[1].replace(/\$\{\s*'?([^}]+?)\s*\}/g, "{$1}"), keys: [] };
    const masked = maskSource(t);
    const parts = splitTop(masked, 0, t.length, "+");
    if (parts.length > 1) {
      const bs = parts.map((p) => evalExpr(t.slice(p.start, p.end), sc, depth + 1));
      return { text, value: bs.map((b) => b.value ?? `{${b.text}}`).join(""), keys: bs.flatMap((b) => b.keys) };
    }
    if (/^'?[A-Za-z_]\w*$/.test(t)) {
      const name = t.replace(/^'/, "");
      const env = sc.env.get(name);
      if (env && (env.text !== name || env.value !== undefined || env.mapping || env.headers)) return env;
      const local = sc.locals.get(name);
      if (local !== undefined && !sc.resolving.has(name)) {
        sc.resolving.add(name);
        const b = evalExpr(local, sc, depth + 1);
        sc.resolving.delete(name);
        const hdr = headerInfo(name, sc);
        return { ...b, text: b.value !== undefined || b.mapping ? b.text : name, headers: hdr ?? b.headers };
      }
      const cfg = ctx.config(name);
      if (typeof cfg === "string" || typeof cfg === "number" || typeof cfg === "boolean") return { text, value: String(cfg), keys: [name] };
      if (cfg !== undefined) return { text, keys: [name] };
      const c = ctx.pkg.consts.get(`${sc.module}:${name}`) ?? ctx.pkg.consts.get(`:${name}`);
      if (c) { const b = evalExpr(c.raw, sc, depth + 1); return { ...b, text }; }
      return { text, keys: [] };
    }
    if (/^[A-Za-z_]\w*(\.'?[A-Za-z_]\w*)+$/.test(t)) {
      const path = t.replace(/'/g, "");
      const root = path.split(".")[0];
      if (!sc.env.has(root) && !sc.locals.has(root)) {
        const cfg = ctx.config(path);
        if (typeof cfg === "string" || typeof cfg === "number" || typeof cfg === "boolean") return { text, value: String(cfg), keys: [path] };
        if (cfg !== undefined) return { text, keys: [path] };
      } else {
        const b = sc.env.get(root);
        if (b && b.text !== root) return { text: b.text + path.slice(root.length), keys: b.keys };
      }
      return { text, keys: [] };
    }
    // a call to a function of this package: a mapping, or something whose headers we can read
    const call = /^(?:([A-Za-z_]\w*):)?([A-Za-z_]\w*)\s*\(/.exec(t);
    if (call && matchClose(masked, call[0].length - 1) === t.length - 1) {
      const fn = lookupFn(call[1] || "", call[2], sc.module);
      if (fn) {
        const id = ctx.mappingOf(fn);
        if (id) { const h = ctx.mappingHeaders?.(id); return { text, keys: [], mapping: id, headers: h ? { names: h, forwarded: [] } : undefined }; }
      }
      if (call[2] === "forwardHeaders") {
        const args = splitTop(masked, call[0].length, t.length - 1).map((a) => t.slice(a.start, a.end).trim());
        const names = [...PASS_THROUGH_HEADERS];
        if (args[2]) { const l = parseLiteral(args[2]); if (l && typeof l === "object" && !Array.isArray(l) && !isExpr(l)) for (const k of Object.keys(l)) if (!names.includes(k)) names.push(headerKey(k, sc)); }
        return { text, keys: [], headers: { names, forwarded: [...PASS_THROUGH_HEADERS] } };
      }
    }
    if (t.startsWith("{")) {
      const h = literalHeaders(t, sc);
      if (h) return { text, keys: [], headers: h };
    }
    return { text, keys: [] };
  }

  function headerKey(k: string, sc: Scope): string {
    if (/^[\w:]*CORRELATION_HEADER$/.test(k)) return "correlationId";
    if (/^[A-Za-z_]\w*:[A-Za-z_]\w*$/.test(k)) return k.split(":")[1];
    const c = ctx.pkg.consts.get(`${sc.module}:${k}`) ?? ctx.pkg.consts.get(`:${k}`);
    if (c) { const v = /^"([^"]*)"$/.exec(c.raw.trim()); if (v) return v[1]; }
    return k.replace(/^"|"$/g, "");
  }
  const fromRequest = (expr: string, sc: Scope): boolean => {
    const e = expr.trim();
    if (/headerOf\s*\(|getHeader\s*\(|\bheader\s*\(/.test(e)) return true;
    if (/^[A-Za-z_]\w*$/.test(e)) { const l = sc.locals.get(e); if (l && /headerOf\s*\(|getHeader\s*\(|\bheader\s*\(|\.headers\s*\[/.test(l)) return true; }
    return false;
  };
  function literalHeaders(text: string, sc: Scope): HeaderInfo | null {
    const l = parseLiteral(text);
    if (!l || typeof l !== "object" || Array.isArray(l) || isExpr(l)) return null;
    const names: string[] = [], forwarded: string[] = [];
    for (const [k, v] of Object.entries(l)) {
      if (k.startsWith("...")) continue;
      const name = headerKey(k, sc);
      names.push(name);
      if (isExpr(v) && fromRequest(v.__expr, sc)) forwarded.push(name);
    }
    return { names, forwarded };
  }
  function headerInfo(name: string, sc: Scope): HeaderInfo | undefined {
    const init = sc.locals.get(name);
    const extra = sc.assigns.get(name) || [];
    if (init === undefined && !extra.length) return undefined;
    let info: HeaderInfo | undefined;
    if (init !== undefined) {
      const t = init.trim();
      if (t.startsWith("{")) info = literalHeaders(t, sc) ?? undefined;
      else if (!sc.resolving.has(name + "#h")) {
        sc.resolving.add(name + "#h");
        info = evalExpr(t, sc, 3).headers;
        sc.resolving.delete(name + "#h");
      }
    }
    if (!info && !extra.length) return undefined;
    const out: HeaderInfo = { names: [...(info?.names || [])], forwarded: [...(info?.forwarded || [])] };
    for (const [k, v] of extra) {
      const key = headerKey(k.trim(), sc);
      if (!out.names.includes(key)) out.names.push(key);
      if (fromRequest(v, sc) && !out.forwarded.includes(key)) out.forwarded.push(key);
    }
    return out;
  }

  function messageIn(f: BalFile, start: number, end: number): string | undefined {
    const text = f.text.slice(start, end);
    const m1 = /\bmessage\s*[:=]\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    if (m1) return m1[1];
    const m2 = /envelopeOf\s*\(\s*[\w:]+\s*,\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    if (m2) return m2[1];
    const m3 = /statusBody\s*\(\s*"error"\s*,\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    return m3 ? m3[1] : undefined;
  }

  function walkSimple(st: { start: number; end: number }, sc: Scope, out: Step[], stack: string[]) {
    const f = sc.file, m = f.masked;
    const mText = m.slice(st.start, st.end);
    const oText = f.text.slice(st.start, st.end);
    if (/\b(breaker|circuitBreaker)\s*\.\s*\w+\s*\(/i.test(mText)) state.features.add("Circuit breaker");
    if (/isRetryable|waitBeforeRetry|maxAttempts|retryPolicy/.test(mText)) state.features.add("Retry");
    if (/auditSink\s*\./.test(mText)) state.features.add("Audit trail");
    if (/\bforwardHeaders\s*\(/.test(mText)) state.passThrough = true;
    if (/notifier\s*\.\s*notify/.test(mText)) state.features.add("Error notification");
    for (const h of oText.matchAll(/(?:headerOf|getHeader|\bheader)\s*\(\s*(?:\w+\s*,\s*)?"([^"]+)"/g)) state.headersRead.add(h[1]);

    const decl = /^\s*(?:final\s+)?(?!return\b)[\w:<>\[\]?|&,' ]+?\s+'?([A-Za-z_]\w*)\s*=(?!=)\s*/.exec(mText);
    const declName = decl ? decl[1] : "";
    const idx = /^\s*([A-Za-z_]\w*)\s*\[/.exec(mText);
    if (idx) {
      const open = st.start + idx[0].length - 1;
      const close = matchClose(m, open, st.end);
      const eq = close > 0 ? /^\s*=(?!=)\s*/.exec(m.slice(close + 1, st.end)) : null;
      if (eq) {
        const list = sc.assigns.get(idx[1]) || [];
        list.push([f.text.slice(open + 1, close), f.text.slice(close + 1 + eq[0].length, st.end).replace(/;\s*$/, "")]);
        sc.assigns.set(idx[1], list);
      }
    }

    for (const c of findCalls(m, st.start, st.end)) {
      if (state.count >= MAX_STEPS) { state.truncated = true; return; }
      const args = c.args.map((a) => f.text.slice(a.start, a.end).trim());
      if (c.remote) {
        const client = ctx.clients.get(c.receiver);
        if (!client) continue;
        const bound = args.map((a) => evalExpr(a, sc));
        const step: Extract<Step, { kind: "call" }> = { kind: "call", client: client.name, op: c.name, args: bound, inFunction: sc.fnName, src: srcOf(f, st.start, st.end) };
        if (client.kind === "http" || client.kind === "graphql" || client.kind === "soap") {
          const op = c.name.toLowerCase();
          let pi = 0, bi = 1, hi = 2;
          if (op === "execute") { pi = 1; bi = 2; hi = 3; }
          else if (op === "get" || op === "head" || op === "options") { bi = -1; hi = 1; }
          else if (op === "forward") { hi = -1; }
          step.path = bound[pi];
          if (bi >= 0) step.body = bound[bi];
          if (hi >= 0 && bound[hi]) step.headers = bound[hi].headers ?? headersOfText(args[hi], sc);
          if (op === "forward") step.headers = { names: ["(all incoming headers)"], forwarded: ["(all incoming headers)"] };
        } else if (client.kind === "redis") {
          state.features.add("Cache");
          step.path = bound[0];
        } else step.path = bound[0];
        state.count++;
        out.push(step);
        continue;
      }
      // framework helpers with a known meaning
      if (c.name === "envelopeOf" && args[0]) {
        const type = /([A-Z][A-Z_]+)$/.exec(args[0]);
        const status = type ? ERROR_STATUS[type[1]] : undefined;
        if (status) {
          const msg = args[1] ? evalExpr(args[1], sc) : undefined;
          out.push({ kind: "respond", status, message: msg?.value ?? undefined, src: srcOf(f, st.start, st.end) });
          state.count++;
        }
        continue;
      }
      const fn = lookupFn(c.qualifier, c.name, sc.module);
      if (!fn) continue;
      const mapping = ctx.mappingOf(fn);
      if (mapping) { out.push({ kind: "map", mapping, src: srcOf(f, st.start, st.end) }); state.count++; continue; }
      const key = `${fn.module}:${fn.name}`;
      if (stack.includes(key) || stack.length >= MAX_DEPTH) continue;
      const inner: Scope = { file: fn.file, module: fn.module, fnName: fn.name, env: new Map(), locals: new Map(), assigns: new Map(), resolving: new Set() };
      fn.params.forEach((p, i) => inner.env.set(p.name, args[i] !== undefined ? evalExpr(args[i], sc) : { text: p.name, keys: [] }));
      const body: Stmt[] = fn.exprBodied ? [{ kind: "simple", start: fn.bodyStart, end: fn.bodyEnd }] : parseBlock(fn.file.masked, fn.bodyStart, fn.bodyEnd);
      const steps: Step[] = [];
      walkStmts(body, inner, steps, [...stack, key]);
      if (c.started) {
        state.features.add("Background processing");
        if (steps.length) out.push({ kind: "async", fn: fn.name, steps, src: srcOf(f, st.start, st.end) });
      } else out.push(...steps);
    }

    if (decl) sc.locals.set(declName, f.text.slice(st.start + decl[0].length, st.end).replace(/;\s*$/, ""));

    // literal statuses set or returned here
    const hasEnvelope = /envelopeOf\s*\(/.test(mText);
    if (!hasEnvelope) {
      const seen = new Set<number>();
      for (const s of mText.matchAll(/\bstatus(?:Code)?\s*[:=]\s*(\d{3})\b/g)) {
        const status = Number(s[1]);
        if (status < 100 || status > 599 || seen.has(status)) continue;
        seen.add(status);
        out.push({ kind: "respond", status, message: messageIn(f, st.start, st.end), src: srcOf(f, st.start, st.end) });
        state.count++;
      }
    }
  }
  function headersOfText(text: string | undefined, sc: Scope): HeaderInfo | undefined {
    if (!text) return undefined;
    const t = text.trim();
    if (t.startsWith("{")) return literalHeaders(t, sc) ?? undefined;
    if (/^[A-Za-z_]\w*$/.test(t)) return headerInfo(t, sc);
    return undefined;
  }

  const returns = (stmts: Stmt[], m: string): boolean => {
    const last = stmts[stmts.length - 1];
    if (!last) return false;
    if (last.kind === "simple") return /^\s*(return|panic|break|continue)\b/.test(m.slice(last.start, last.end));
    if (last.kind === "if") return last.else.length > 0 && returns(last.then, m) && returns(last.else, m);
    return false;
  };

  function walkStmts(stmts: Stmt[], sc: Scope, out: Step[], stack: string[]) {
    const f = sc.file, m = f.masked;
    for (const st of stmts) {
      if (state.count >= MAX_STEPS) { state.truncated = true; return; }
      if (st.kind === "simple") { walkSimple(st, sc, out, stack); continue; }
      if (st.kind === "if") {
        walkSimple({ start: st.condStart, end: st.condEnd }, sc, out, stack);
        const then: Step[] = [], els: Step[] = [];
        walkStmts(st.then, sc, then, stack);
        walkStmts(st.else, sc, els, stack);
        if (!then.length && !els.length) continue;
        const cond = squash(f.text.slice(st.condStart, st.condEnd));
        const thenReturns = returns(st.then, m), elseReturns = returns(st.else, m);
        const onlyResponds = (xs: Step[]) => xs.length > 0 && xs.every((x) => x.kind === "respond");
        if (onlyResponds(then) && thenReturns && !els.length) {
          const r = then[0] as Extract<Step, { kind: "respond" }>;
          out.push({ ...r, guard: true, when: cond, message: r.message ?? messageIn(f, st.start, st.thenEnd), src: srcOf(f, st.start, st.thenEnd) });
          continue;
        }
        out.push({ kind: "if", cond, then, else: els, thenReturns, elseReturns, src: srcOf(f, st.start, st.condEnd + 1) });
        continue;
      }
      if (st.kind === "loop") {
        walkSimple({ start: st.headStart, end: st.headEnd }, sc, out, stack);
        const body: Step[] = [];
        walkStmts(st.body, sc, body, stack);
        if (body.some(hasCall)) out.push({ kind: "loop", header: squash(f.text.slice(st.headStart, st.headEnd)), steps: body, src: srcOf(f, st.headStart, st.headEnd + 1) });
        else out.push(...body.filter((b) => b.kind === "respond" && b.guard));
        continue;
      }
      if (st.kind === "match") {
        const subject = squash(f.text.slice(st.headStart, st.headEnd));
        const cases = st.cases.map((c) => {
          const steps: Step[] = [];
          walkStmts(c.body, sc, steps, stack);
          return { label: squash(f.text.slice(c.patStart, c.patEnd)), steps, src: srcOf(f, c.start, c.end) };
        });
        if (cases.some((c) => c.steps.length)) out.push({ kind: "match", subject, subjectBound: evalExpr(subject, sc), cases, src: srcOf(f, st.start, st.headEnd + 1) });
        continue;
      }
      walkStmts(st.body, sc, out, stack);
      walkStmts(st.onFail, sc, out, stack);
    }
  }

  const steps: Step[] = [];
  walkStmts(stmts, scope, steps, []);
  return { steps, features: [...state.features], headersRead: [...state.headersRead], passThrough: state.passThrough, truncated: state.truncated };
}

export function hasCall(s: Step): boolean {
  if (s.kind === "call") return true;
  if (s.kind === "if") return s.then.some(hasCall) || s.else.some(hasCall);
  if (s.kind === "match") return s.cases.some((c) => c.steps.some(hasCall));
  if (s.kind === "loop" || s.kind === "async") return s.steps.some(hasCall);
  return false;
}
/** Every connector call in the order the source reaches it. */
export function flatCalls(steps: Step[], out: Extract<Step, { kind: "call" }>[] = []): Extract<Step, { kind: "call" }>[] {
  for (const s of steps) {
    if (s.kind === "call") out.push(s);
    else if (s.kind === "if") { flatCalls(s.then, out); flatCalls(s.else, out); }
    else if (s.kind === "match") for (const c of s.cases) flatCalls(c.steps, out);
    else if (s.kind === "loop" || s.kind === "async") flatCalls(s.steps, out);
  }
  return out;
}
export function flatSteps(steps: Step[], out: Step[] = []): Step[] {
  for (const s of steps) {
    out.push(s);
    if (s.kind === "if") { flatSteps(s.then, out); flatSteps(s.else, out); }
    else if (s.kind === "match") for (const c of s.cases) flatSteps(c.steps, out);
    else if (s.kind === "loop" || s.kind === "async") flatSteps(s.steps, out);
  }
  return out;
}
