// Builds the estate model of one migrated API from its Ballerina source and its deployed
// configuration: operations, connectors, mappings, configuration (secrets masked) and the calls
// each operation makes. Everything here is read from disk and worked out by plain code.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  type BalClient, type BalFile, type BalFunction, type BalPackage, type BalResource, type Lit, type Src,
  isExpr, makeFile, maskSource, matchClose, parseLiteral, parsePackage, splitTop, srcOf,
} from "./bal.js";
import { flatten, isSecretKey, parseToml, scrubUrl, showValue } from "./toml.js";
import { type Step, type WalkContext, PASS_THROUGH_HEADERS, flatCalls, flatSteps, walkResource } from "./walk.js";

export type Layer = "exp" | "proc" | "sys" | "other";

export interface OperationModel {
  id: string; method: string; path: string; fullPath: string; summary?: string; implemented: boolean;
  file: string; line: number; endLine: number; code: string; service: string;
  params: { name: string; type: string; in: string }[];
  calls: CallModel[];
  responses: { status: number; message?: string; when?: string }[];
  features: string[];
  headersForwarded: string[];
  headersRead: string[];
  steps: Step[];
}
export interface CallModel {
  connector: string; kind: string; op: string; method?: string; path?: string; configKeys: string[];
  body?: string; mapping?: string; headers: string[]; forwarded: string[]; inFunction: string; src: Src;
}
export interface ConnectorModel {
  name: string; kind: string; target: string; configKey?: string; auth: string; usedBy: string[];
  component?: string; file: string; line: number; code: string; paths: string[]; secrets: string[];
  settings: { key: string; value: string }[];
}
export interface MappingModel {
  id: string; operation?: string; name: string; kind: "function" | "record" | "query" | "inline";
  file: string; line: number; code: string; fields?: { target: string; source: string }[]; summary?: string;
  usedBy?: string[];
}
export interface ConfigEntry { key: string; value: string; source: "deployed" | "default" | "example" | "required" | "platform"; secret: boolean; component?: string; doc?: string; }
export interface ApiModel {
  name: string; org: string; packageName: string; technology: string; sourceAvailable: boolean;
  basePath?: string; basePaths: string[];
  operations: OperationModel[]; connectors: ConnectorModel[]; mappings: MappingModel[]; config: ConfigEntry[];
  configSource: "deployed" | "example" | "defaults";
  components: { name: string; dir: string; files: number; lines: number }[];
  features: string[];
  warnings: string[];
}

export interface SourceEntry { name: string; dirs: string[]; }

// ------------------------------------------------------------------ discovery

const hasToml = (d: string) => existsSync(join(d, "Ballerina.toml"));

/** SERVICES_DIR: comma separated. `/dir` = a folder of service folders (or one service folder);
 *  `name=/a+/b` = one API made of several packages (first is the service, the rest companions). */
export function discoverSources(spec: string | undefined): SourceEntry[] {
  const out: SourceEntry[] = [];
  const seen = new Set<string>();
  const add = (name: string, dirs: string[]) => {
    const i = out.findIndex((e) => e.name === name);
    if (i >= 0) out[i] = { name, dirs }; else out.push({ name, dirs });
    seen.add(name);
  };
  for (const raw of (spec || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = raw.indexOf("=");
    if (eq > 0 && !raw.slice(0, eq).includes("/")) {
      const dirs = raw.slice(eq + 1).split("+").map((s) => s.trim()).filter((d) => d && existsSync(d) && hasToml(d));
      if (dirs.length) add(raw.slice(0, eq).trim(), dirs);
      continue;
    }
    if (!existsSync(raw)) continue;
    if (hasToml(raw)) { add(basename(raw), [raw]); continue; }
    let names: string[] = [];
    try { names = readdirSync(raw).sort(); } catch { /* unreadable */ }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const d = join(raw, n);
      try { if (statSync(d).isDirectory() && hasToml(d) && !seen.has(n)) add(n, [d]); } catch { /* skip */ }
    }
  }
  return out;
}

const SKIP_DIRS = new Set(["tests", "target", "node_modules", "resources", "docs", "testdata"]);
function balFiles(dir: string, prefix: string): BalFile[] {
  const out: BalFile[] = [];
  const visit = (d: string) => {
    let names: string[] = [];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!SKIP_DIRS.has(n)) visit(p); continue; }
      if (!n.endsWith(".bal") || st.size > 2_000_000) continue;
      const rel = relative(dir, p).split("\\").join("/");
      const mod = /^modules\/([^/]+)\//.exec(rel);
      out.push(makeFile(prefix ? `${prefix}/${rel}` : rel, mod ? mod[1] : "", readFileSync(p, "utf8")));
    }
  };
  visit(dir);
  return out;
}

export function loadPackage(dir: string, prefix = ""): BalPackage | null {
  let org = "", name = basename(dir).replace(/-/g, "_");
  try {
    const t = parseToml(readFileSync(join(dir, "Ballerina.toml"), "utf8"));
    const pkg = (t.package || {}) as Record<string, unknown>;
    if (typeof pkg.org === "string") org = pkg.org;
    if (typeof pkg.name === "string") name = pkg.name;
  } catch { return null; }
  return parsePackage(org, name, prefix, balFiles(dir, prefix));
}

// ------------------------------------------------------------------ configuration

type Plain = string | number | boolean | null | Plain[] | { [k: string]: Plain };
const isObj = (v: unknown): v is Record<string, Plain> => !!v && typeof v === "object" && !Array.isArray(v);

/** A parsed literal as a plain value; text that is not a literal is kept as written. */
function plain(l: Lit): Plain {
  if (isExpr(l)) {
    const t = l.__expr;
    const parts = splitTop(maskSource(t), 0, t.length, "+").map((p) => t.slice(p.start, p.end).trim());
    if (parts.length > 1 && parts.every((p) => /^"(?:[^"\\]|\\.)*"$/.test(p))) {
      try { return parts.map((p) => JSON.parse(p) as string).join(""); } catch { /* keep */ }
    }
    return t;
  }
  if (Array.isArray(l)) return l.map(plain);
  if (l && typeof l === "object") {
    const out: Record<string, Plain> = {};
    for (const [k, v] of Object.entries(l)) if (!k.startsWith("...")) out[k] = plain(v as Lit);
    return out;
  }
  return l as Plain;
}
function merge(a: Plain | undefined, b: Plain | undefined): Plain | undefined {
  if (b === undefined) return a;
  if (isObj(a) && isObj(b)) {
    const out: Record<string, Plain> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v) as Plain;
    return out;
  }
  return b;
}

interface Libs { find(importModule: string): BalPackage | null; }
function libsFor(dirs: string[]): Libs {
  const cache = new Map<string, BalPackage | null>();
  const candidates: string[] = [];
  for (const d of dirs) {
    const parent = dirname(d);
    for (const base of [parent, join(dirname(parent), "framework"), join(parent, "framework")]) {
      let names: string[] = [];
      try { names = readdirSync(base); } catch { continue; }
      for (const n of names) { const c = join(base, n); if (!dirs.includes(c) && !candidates.includes(c) && hasToml(c)) candidates.push(c); }
    }
  }
  return {
    find(mod: string) {
      if (cache.has(mod)) return cache.get(mod)!;
      const [org, rest] = mod.includes("/") ? [mod.slice(0, mod.indexOf("/")), mod.slice(mod.indexOf("/") + 1)] : ["", mod];
      const name = rest.split(".")[0];
      let found: BalPackage | null = null;
      for (const c of candidates) {
        try {
          const t = parseToml(readFileSync(join(c, "Ballerina.toml"), "utf8"));
          const p = (t.package || {}) as Record<string, unknown>;
          if (p.name === name && (!org || p.org === org)) { found = loadPackage(c, basename(c)); break; }
        } catch { /* next */ }
      }
      cache.set(mod, found);
      return found;
    },
  };
}

function recordDefaults(pkg: BalPackage, libs: Libs, type: string, module: string, depth = 0): Plain | undefined {
  if (depth > 4) return undefined;
  const t = type.replace(/\?$/, "").replace(/^readonly\s*&\s*/, "").trim();
  let fields; let owner = pkg; let mod = module;
  const q = /^([A-Za-z_]\w*):([A-Za-z_]\w*)$/.exec(t);
  if (q) {
    const imp = pkg.imports.get(q[1]);
    if (!imp) return undefined;
    const bare = imp.includes("/") ? imp.slice(imp.indexOf("/") + 1) : imp;
    if (bare.startsWith(pkg.name + ".")) { mod = bare.slice(pkg.name.length + 1); fields = pkg.records.get(`${mod}:${q[2]}`); }
    else { const lib = libs.find(imp); if (!lib) return undefined; owner = lib; mod = bare.includes(".") ? bare.slice(bare.indexOf(".") + 1) : ""; fields = lib.records.get(`${mod}:${q[2]}`); }
  } else if (/^[A-Za-z_]\w*$/.test(t)) fields = pkg.records.get(`${module}:${t}`) ?? pkg.records.get(`:${t}`);
  if (!fields) return undefined;
  const out: Record<string, Plain> = {};
  for (const f of fields) {
    const nested = recordDefaults(owner, libs, f.type, mod, depth + 1);
    const own = f.raw !== undefined ? plain(parseLiteral(f.raw)) : undefined;
    const v = merge(nested, own);
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

interface DeployedConfig { table?: Record<string, Plain>; platform: Record<string, Plain>; source: "deployed" | "example" | "defaults"; file?: string; unreadable?: string; }
function readDeployed(pkg: BalPackage, dir: string, configDirs: string[]): DeployedConfig {
  const pick = (t: Record<string, unknown>): Record<string, Plain> | undefined => {
    const o = pkg.org ? (t[pkg.org] as Record<string, unknown> | undefined) : undefined;
    const tab = o && isObj(o as Plain) ? (o as Record<string, unknown>)[pkg.name] : undefined;
    return isObj(tab as Plain) ? (tab as Record<string, Plain>) : undefined;
  };
  const platformOf = (t: Record<string, unknown>) => {
    const out: Record<string, Plain> = {};
    for (const [k, v] of Object.entries(t)) if (k !== pkg.org) out[k] = v as Plain;
    return out;
  };
  let best: { mtime: number; t: Record<string, unknown>; file: string } | undefined;
  // a settings file named after this service that exists but cannot be opened
  const own = new Set([basename(dir), pkg.name.replace(/_/g, "-")].map((n) => `${n}.toml`));
  let unreadable: string | undefined;
  for (const cd of configDirs) {
    let names: string[] = [];
    try { names = readdirSync(cd); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".toml")) continue;
      let text: string; let mtime: number;
      try {
        const p = join(cd, n);
        const st = statSync(p);
        if (!st.isFile() || st.size > 1_000_000) continue;
        text = readFileSync(p, "utf8"); mtime = st.mtimeMs;
      } catch { if (own.has(n)) unreadable = n; continue; }
      try {
        const t = parseToml(text) as Record<string, unknown>;
        if (pick(t) && (!best || mtime > best.mtime)) best = { mtime, t, file: n };
      } catch { /* not toml */ }
    }
  }
  if (best) return { table: pick(best.t), platform: platformOf(best.t), source: "deployed", file: best.file };
  for (const [n, source] of [["Config.toml", "deployed"], ["Config.toml.example", "example"]] as const) {
    try {
      const t = parseToml(readFileSync(join(dir, n), "utf8")) as Record<string, unknown>;
      const table = pick(t) ?? (Object.values(t).some((v) => !isObj(v as Plain)) ? (t as Record<string, Plain>) : undefined);
      if (table) return { table, platform: pick(t) ? platformOf(t) : {}, source, file: n, unreadable };
    } catch { /* absent */ }
  }
  return { platform: {}, source: "defaults", unreadable };
}

interface Resolved { values: Map<string, Plain | undefined>; entries: ConfigEntry[]; source: DeployedConfig["source"]; unreadable?: string; }
function resolveConfig(pkg: BalPackage, libs: Libs, dep: DeployedConfig, component?: string): Resolved {
  const values = new Map<string, Plain | undefined>();
  const entries: ConfigEntry[] = [];
  const deployedHas = (path: string[]): boolean => {
    let cur: Plain | undefined = dep.table;
    for (const p of path) { if (!isObj(cur) || !(p in cur)) return false; cur = cur[p]; }
    return true;
  };
  const known = new Set<string>();
  for (const c of pkg.configurables) {
    known.add(c.key);
    const defaults = merge(recordDefaults(pkg, libs, c.type, c.file.module), c.required ? undefined : plain(parseLiteral(c.raw)));
    const deployed = dep.table ? dep.table[c.key] : undefined;
    const value = merge(defaults, deployed);
    values.set(c.key, value);
    const doc = c.doc.map((l) => l.replace(/^[#/]+\s?/, "").trim()).filter((l) => l && !l.startsWith("+")).join(" ") || undefined;
    if (value === undefined) { entries.push({ key: c.key, value: "not set", source: "required", secret: isSecretKey(c.key), component, doc }); continue; }
    for (const e of flatten(value, c.key)) {
      const path = e.key.split(".").map((s) => s.replace(/^"|"$/g, ""));
      const src = deployedHas(path) ? (dep.source === "example" ? "example" : "deployed") : "default";
      entries.push({ key: e.key, value: showValue(e.key, e.value), source: src, secret: isSecretKey(e.key), component, doc: e.key === c.key ? doc : undefined });
    }
    if (isObj(value) && !Object.keys(value).length) entries[entries.length - 1].doc = doc;
  }
  for (const [k, v] of Object.entries(dep.table || {})) {
    if (known.has(k)) continue;
    for (const e of flatten(v, k)) entries.push({ key: e.key, value: showValue(e.key, e.value), source: dep.source === "example" ? "example" : "deployed", secret: isSecretKey(e.key), component });
  }
  for (const e of flatten(dep.platform)) entries.push({ key: e.key, value: showValue(e.key, e.value), source: "platform", secret: isSecretKey(e.key), component });
  return { values, entries, source: dep.source, unreadable: dep.unreadable };
}
const configLookup = (r: Resolved) => (path: string): unknown => {
  const parts = path.split(".");
  if (!r.values.has(parts[0])) return undefined;
  let cur: Plain | undefined = r.values.get(parts[0]);
  for (const p of parts.slice(1)) { if (!isObj(cur)) return undefined; cur = cur[p]; }
  return cur === undefined ? (parts.length === 1 ? "" : undefined) : cur;
};

// ------------------------------------------------------------------ mappings

const SQL = /\b(SELECT\s+[\w*"`(]|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i;
/** True when a string or template in the code holds SQL or a GraphQL document. */
export function hasQueryText(code: string): boolean {
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|`([^`]*)`/g)) {
    const t = m[1] ?? m[2] ?? "";
    if (SQL.test(t)) return true;
    if (/^\s*(query|mutation|subscription)\b[^{]*\{/.test(t) || /^\s*\{\s*\w+\s*(\([^)]*\))?\s*\{/.test(t)) return true;
  }
  return false;
}
const compact = (s: string, n = 160) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

function litFields(l: Lit, prefix = "", depth = 0, out: { target: string; source: string }[] = []): { target: string; source: string }[] {
  if (!l || typeof l !== "object" || Array.isArray(l) || isExpr(l)) return out;
  for (const [k, v] of Object.entries(l)) {
    if (out.length >= 80) break;
    if (k.startsWith("...")) { out.push({ target: prefix ? `${prefix}.*` : "*", source: `all fields of ${k.slice(3)}` }); continue; }
    const target = prefix ? `${prefix}.${k}` : k;
    if (isSecretKey(k) && typeof v === "string") { out.push({ target, source: "(fixed value, hidden)" }); continue; }
    if (v && typeof v === "object" && !Array.isArray(v) && !isExpr(v) && depth < 2) { litFields(v as Lit, target, depth + 1, out); continue; }
    let source: string;
    if (isExpr(v)) source = compact(v.__expr);
    else if (typeof v === "string") source = JSON.stringify(compact(v, 120));
    else if (Array.isArray(v)) source = compact(JSON.stringify(plain(v)), 120);
    else source = String(v);
    out.push({ target, source });
  }
  return out;
}

function returnedLiteral(fn: BalFunction): string | null {
  const f = fn.file;
  if (fn.exprBodied) { const t = f.text.slice(fn.bodyStart, fn.bodyEnd).trim().replace(/;$/, ""); return t.startsWith("{") ? t : null; }
  const m = f.masked;
  let last = -1;
  const re = /\breturn\s*\{/g;
  re.lastIndex = fn.bodyStart;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(m)) && mm.index < fn.bodyEnd) last = mm.index + mm[0].length - 1;
  if (last < 0) return null;
  const close = matchClose(m, last, fn.bodyEnd);
  return close > 0 ? f.text.slice(last, close + 1) : null;
}

const MAPPING_NAME = /(Query|Queries|Body|Payload|Request|Variables|Document|Envelope|Mapping|Params|Headers)$/;
const MAPPING_FILE = /(transform|mapping|mapper|convert)/i;

interface MappingIndex { list: MappingModel[]; byFn: Map<string, string>; kindOf: Map<string, MappingModel>; }
function findMappings(pkg: BalPackage, prefix: string): MappingIndex {
  const list: MappingModel[] = [];
  const byFn = new Map<string, string>();
  const kindOf = new Map<string, MappingModel>();
  const ids = new Set<string>();
  const mkId = (base: string) => { let id = base, n = 2; while (ids.has(id)) id = `${base}-${n++}`; ids.add(id); return id; };
  for (const [key, fn] of pkg.functions) {
    const f = fn.file;
    const file = basename(f.path);
    const body = f.text.slice(fn.bodyStart, fn.bodyEnd);
    const mbody = f.masked.slice(fn.bodyStart, fn.bodyEnd);
    if (/->/.test(mbody) || !fn.returns || /^(boolean|int|error\??|\(\))$/.test(fn.returns.trim())) continue;
    const inTransformFile = MAPPING_FILE.test(file);
    const lit = returnedLiteral(fn);
    const pureModule = f.module !== "" || /(request|quer|payload|bod)/i.test(file);
    if (!(inTransformFile || (pureModule && (lit || MAPPING_NAME.test(fn.name))))) continue;
    if (!inTransformFile && !lit && !hasQueryText(body)) continue;
    const doc = fn.doc.map((l) => l.replace(/^[#/]+\s?/, "").trimEnd());
    let fields: { target: string; source: string }[] | undefined;
    if (lit) { const fl = litFields(parseLiteral(lit)); if (fl.length) fields = fl; }
    if (!fields) {
      // generated transforms keep the original script as comments: `// "key": expr,`
      const fl: { target: string; source: string }[] = [];
      for (const line of body.split("\n")) {
        const c = /^\s*\/\/\s*"?([A-Za-z_][\w.-]*)"?\s*:\s*(.+?),?\s*$/.exec(line);
        if (c && !/^https?$/.test(c[1])) fl.push({ target: c[1], source: isSecretKey(c[1]) ? "(hidden)" : compact(c[2]) });
      }
      const outDoc = doc.find((l) => /^Output fields:/i.test(l.trim()));
      if (!fl.length && outDoc) for (const n of outDoc.replace(/^.*?:/, "").replace(/\.\s*$/, "").split(",")) if (n.trim()) fl.push({ target: n.trim(), source: "" });
      if (fl.length) fields = fl.slice(0, 80);
    }
    const returnsRecord = /^[A-Za-z_]\w*(:[A-Za-z_]\w*)?$/.test(fn.returns.trim()) && !/^(json|string|xml|anydata|any|map)$/.test(fn.returns.trim());
    const kind: MappingModel["kind"] = hasQueryText(body) ? "query" : returnsRecord ? "record" : "function";
    const src = srcOf(f, fn.start, fn.end);
    const summary = doc.map((l) => l.trim()).find((l) => l && !l.startsWith("+")) || undefined;
    const m: MappingModel = { id: mkId(`${prefix}${f.module ? f.module + "." : ""}${fn.name}`), name: fn.name, kind, file: src.file, line: src.line, code: redact(src.code), fields, summary };
    list.push(m);
    byFn.set(`${prefix}|${key}`, m.id);
    kindOf.set(m.id, m);
  }
  for (const [, c] of pkg.consts) {
    if (!hasQueryText(c.raw)) continue;
    const src = srcOf(c.file, c.start, c.end);
    const m: MappingModel = { id: mkId(`${prefix}${c.file.module ? c.file.module + "." : ""}${c.name}`), name: c.name, kind: "query", file: src.file, line: src.line, code: redact(src.code) };
    list.push(m);
    kindOf.set(m.id, m);
  }
  return { list, byFn, kindOf };
}

/** Source shown to users: fixed credentials written into the code are blanked. */
export function redact(code: string): string {
  return scrubUrl(code).replace(/((?:pass(?:word|wd)?|secret|token|api[-_]?key|client[-_]?secret|authorization)"?\s*[:=]\s*)"(?!\s*")[^"\n]{3,}"/gi, '$1"***"');
}

// ------------------------------------------------------------------ assembling one API

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const joinPath = (a: string, b: string) => ("/" + [a, b].map((x) => x.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")) || "/";

function paramIn(p: { type: string; name: string; annotation?: string }, path: string): string {
  if (/http:(Request|Caller|Headers|RequestContext)/.test(p.type)) return "request";
  if (p.annotation && /Payload/.test(p.annotation)) return "body";
  if (p.annotation && /Header/.test(p.annotation)) return "header";
  if (path.includes(`{${p.name}}`) || path.includes(`{${p.name}*}`)) return "path";
  return "query";
}

function resolveTarget(c: BalClient, cfg: (p: string) => unknown, r: Resolved): { target: string; configKey?: string; settingsKey?: string } {
  const a0 = (c.args[0] || "").trim();
  const lit = /^"([^"]*)"$/.exec(a0);
  if (lit) return { target: scrubUrl(lit[1]) };
  if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(a0)) {
    const v = cfg(a0);
    if (typeof v === "string") return { target: v ? scrubUrl(v) : "(not configured)", configKey: a0, settingsKey: a0.includes(".") ? a0.slice(0, a0.lastIndexOf(".")) : undefined };
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      for (const k of ["url", "baseUrl", "endpoint", "uri"]) if (typeof o[k] === "string") return { target: o[k] ? scrubUrl(o[k] as string) : "(not configured)", configKey: `${a0}.${k}`, settingsKey: a0 };
      if (typeof o.host === "string") {
        const scheme = c.kind === "redis" ? "redis://" : c.kind === "postgres" ? "postgres://" : "";
        const db = typeof o.database === "string" && o.database ? `/${o.database}` : "";
        return { target: `${scheme}${o.host}${o.port !== undefined ? ":" + String(o.port) : ""}${db}`, configKey: `${a0}.host`, settingsKey: a0 };
      }
      return { target: "(see configuration)", configKey: a0, settingsKey: a0 };
    }
    if (r.values.has(a0.split(".")[0])) return { target: "(not configured)", configKey: a0 };
  }
  // connection settings built in place: look for a url/host entry
  const inline = /\b(url|host)\s*:\s*([A-Za-z_][\w.]*)/.exec(c.init);
  if (inline) { const v = cfg(inline[2]); if (typeof v === "string" && v) return { target: scrubUrl(v), configKey: inline[2] }; }
  return { target: a0 ? `(set in code: ${compact(a0, 60)})` : "(set in code)" };
}

interface Built { pkg: BalPackage; resolved: Resolved; mappings: MappingIndex; clients: Map<string, BalClient>; ctx: WalkContext; prefix: string; }
// Connections the code opens inside a class or a function have no module-level client to read.
// Their settings are still declared, so such a connection is described from its settings.
const ADDRESS_KEYS = ["url", "baseUrl", "endpoint", "uri", "brokerUrl"];
const SQL_MODULE = /(^|\/)(postgresql|mysql|mssql|oracledb|sql|java\.jdbc)$/;
const bare = (code: string) => code.replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
function derivedConnectors(b: Built, component: string | undefined, taken: Set<string>, ops: OperationModel[]): ConnectorModel[] {
  const out: ConnectorModel[] = [];
  const declared = b.pkg.clients.map((c) => `${c.args.join(" ")} ${c.init}`).join("\n");
  const mods = [...b.pkg.imports.values()];
  const sql = mods.some((m) => SQL_MODULE.test(m));
  const uses = (key: string, own: BalFile) => {
    const re = new RegExp(`\\b${key}\\b`, "g");
    return b.pkg.files.filter((f) => (f.masked.match(re) || []).length > (f === own ? 1 : 0));
  };
  for (const c of b.pkg.configurables) {
    if (taken.has(c.key) || new RegExp(`\\b${c.key}\\b`).test(declared)) continue;
    const value = b.resolved.values.get(c.key);
    const hint = `${c.type} ${c.key}`;
    let kind = ""; let target = "(not configured)"; let configKey = c.key;
    const o: Record<string, unknown> = isObj(value) ? value : {};
    const ak = ADDRESS_KEYS.find((k) => typeof o[k] === "string");
    if (ak) {
      const u = o[ak] as string;
      kind = /redis/i.test(hint) || /^rediss?:/i.test(u) ? "redis" : ak === "brokerUrl" || (u && !/^https?:/i.test(u)) ? "other" : "http";
      if (u) target = scrubUrl(u);
      configKey = `${c.key}.${ak}`;
    } else if (typeof o.host === "string") {
      if (/redis/i.test(hint)) kind = "redis";
      else if (sql && /postgres|database|sql|(^|[^a-z])db/i.test(hint)) kind = mods.some((m) => /postgresql$/.test(m)) ? "postgres" : "other";
      else if (/smtp|mail/i.test(hint)) kind = "other";
      else continue;
      const other = mods.map((m) => /(mysql|mssql|oracledb)$/.exec(m)?.[1]).find(Boolean);
      const scheme = kind === "redis" ? "redis://" : kind === "postgres" ? "postgres://" : sql && other ? `${other}://` : "";
      const dbName = ["database", "name", "db"].map((k) => o[k]).find((v) => typeof v === "string" && v);
      if (o.host) target = `${scheme}${o.host}${o.port !== undefined ? ":" + String(o.port) : ""}${dbName && kind !== "redis" ? "/" + String(dbName) : ""}`;
      configKey = `${c.key}.host`;
    } else if (/(Downstream|Backend|Endpoint)Settings$/.test(c.type)) {
      // a required address that has no value yet
      kind = "http"; configKey = `${c.key}.url`;
    } else continue;
    // settings the code does not use yet still name a backend of this API, but only an address counts
    const where = uses(c.key, c.file);
    if (!where.length && kind !== "http") continue;
    const settings: { key: string; value: string }[] = [];
    const secrets: string[] = [];
    for (const e of flatten(value, c.key)) {
      settings.push({ key: e.key, value: showValue(e.key, e.value) });
      if (isSecretKey(e.key)) secrets.push(e.key);
    }
    let auth = "None found in the source";
    const setSecrets = settings.filter((x) => isSecretKey(x.key) && x.value === "set").map((x) => x.key.split(".").pop());
    if (setSecrets.length) auth = `Credentials from configuration (${setSecrets.join(", ")}: set)`;
    else if (secrets.length) auth = "Optional credentials in configuration (not set)";
    else if (kind === "postgres" || (kind === "other" && sql)) {
      // accounts kept in their own settings, used in the same file as the database settings
      const accounts: string[] = [];
      for (const a of b.pkg.configurables) {
        const av = b.resolved.values.get(a.key);
        if (a === c || !isObj(av)) continue;
        const keys = Object.keys(av);
        if (!keys.some((k) => /^user(name)?$/i.test(k)) || !keys.some((k) => isSecretKey(`${a.key}.${k}`))) continue;
        if (keys.some((k) => ADDRESS_KEYS.includes(k) || k === "host")) continue;
        if (!uses(a.key, a.file).some((f) => where.includes(f))) continue;
        const filled = keys.filter((k) => isSecretKey(`${a.key}.${k}`)).every((k) => showValue(`${a.key}.${k}`, (av as Record<string, unknown>)[k]) === "set");
        accounts.push(`${a.key} (${filled ? "set" : "not set"})`);
        secrets.push(...keys.filter((k) => isSecretKey(`${a.key}.${k}`)).map((k) => `${a.key}.${k}`));
      }
      if (accounts.length) auth = `Accounts from configuration: ${accounts.join(", ")}`;
    }
    const word = new RegExp(`\\b${c.key}\\b`);
    const direct = ops.filter((op) => word.test(bare(op.code))).map((op) => op.id);
    const src = srcOf(c.file, c.start, c.end);
    out.push({
      name: c.key, kind, target, configKey, auth,
      usedBy: direct.length ? direct : [!where.length ? "(not used by the code yet)" : component ? `(${component})` : "(inside the service's code)"],
      component, file: src.file, line: src.line, code: redact(src.code), paths: [], secrets, settings,
    });
  }
  return out;
}

function build(pkg: BalPackage, libs: Libs, dir: string, configDirs: string[], component: string | undefined): Built {
  const prefix = component ? `${component}/` : "";
  const resolved = resolveConfig(pkg, libs, readDeployed(pkg, dir, configDirs), component);
  const mappings = findMappings(pkg, prefix);
  const clients = new Map(pkg.clients.map((c) => [c.name, c]));
  const ctx: WalkContext = {
    pkg, clients, config: configLookup(resolved),
    mappingOf: (fn) => mappings.byFn.get(`${prefix}|${fn.module}:${fn.name}`),
  };
  return { pkg, resolved, mappings, clients, ctx, prefix };
}

const HTTP_OPS: Record<string, string> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", head: "HEAD", options: "OPTIONS" };

function callModel(b: Built, s: Extract<Step, { kind: "call" }>): CallModel {
  const client = b.clients.get(s.client)!;
  let method: string | undefined;
  if (client.kind === "http" || client.kind === "graphql" || client.kind === "soap") {
    method = HTTP_OPS[s.op.toLowerCase()];
    if (!method && s.op === "execute") method = (s.args[0]?.value || s.args[0]?.text || "").replace(/"/g, "").toUpperCase() || undefined;
    if (!method && s.op === "forward") method = "(same as request)";
  }
  const path = s.path ? (s.path.value ?? `{${s.path.text}}`) : undefined;
  return {
    connector: client.name, kind: client.kind, op: s.op, method, path, configKeys: s.path?.keys || [],
    body: s.body ? compact(s.body.text, 200) : undefined, mapping: s.body?.mapping,
    headers: s.headers?.names || [], forwarded: s.headers?.forwarded || [], inFunction: s.inFunction, src: { ...s.src, code: redact(s.src.code) },
  };
}

export function buildApi(entry: SourceEntry, configDirs: string[] = []): ApiModel {
  const libs = libsFor(entry.dirs);
  const warnings: string[] = [];
  const builts: Built[] = [];
  const components: ApiModel["components"] = [];
  entry.dirs.forEach((dir, i) => {
    const component = i === 0 ? undefined : basename(dir);
    const pkg = loadPackage(dir, component || "");
    if (!pkg) { warnings.push(`No readable Ballerina package in ${basename(dir)}`); return; }
    builts.push(build(pkg, libs, dir, configDirs, component));
    components.push({ name: component || entry.name, dir: basename(dir), files: pkg.files.length, lines: pkg.files.reduce((n, f) => n + f.lineStarts.length, 0) });
  });
  const main = builts[0];
  const model: ApiModel = {
    name: entry.name, org: main?.pkg.org || "", packageName: main?.pkg.name || "", technology: "Ballerina", sourceAvailable: !!main,
    basePaths: [], operations: [], connectors: [], mappings: [], config: [], configSource: main?.resolved.source || "defaults",
    components, features: [], warnings,
  };
  if (!main) return model;

  // --- operations (service package only)
  const cfg = main.ctx.config;
  const opIds = new Set<string>();
  const features = new Set<string>();
  const connectorUse = new Map<string, Set<string>>();
  const connectorCalls = new Map<string, CallModel[]>();
  const mappingUse = new Map<string, Set<string>>();
  const inline: MappingModel[] = [];
  for (const svc of main.pkg.services) {
    if (!svc.http) continue;
    const bases: string[] = [];
    if (svc.literalPath) bases.push(svc.literalPath);
    for (const a of main.pkg.attaches) {
      if (a.service !== svc.name) continue;
      const e = a.pathExpr.trim();
      const lit = /^"([^"]*)"$/.exec(e);
      const v = lit ? lit[1] : cfg(e);
      if (typeof v === "string" && v) bases.push(v.startsWith("/") ? v : "/" + v);
      else if (typeof v !== "string") bases.push(`/{${e}}`);
    }
    if (!bases.length && !svc.literalPath && !main.pkg.attaches.some((a) => a.service === svc.name)) bases.push("/");
    for (const base of [...new Set(bases)]) {
      const isHealth = /^\/(health|healthz|ready|live|metrics)\b/.test(base);
      if (!isHealth && !model.basePaths.includes(base)) model.basePaths.push(base);
      if (isHealth) continue;
      for (const res of svc.resources) model.operations.push(operation(res, base, svc.name));
    }
  }
  model.basePath = model.basePaths[0];

  function operation(res: BalResource, base: string, service: string): OperationModel {
    const walked = walkResource(main.ctx, res);
    const fullPath = joinPath(base, res.path);
    let id = slug(`${res.method} ${model.basePaths.length > 1 || base !== model.basePaths[0] ? fullPath : res.path}`) || slug(res.method);
    for (let n = 2; opIds.has(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
    opIds.add(id);
    const src = srcOf(res.file, res.start, res.end);
    const calls = flatCalls(walked.steps).map((s) => callModel(main, s));
    const all = flatSteps(walked.steps);
    const responds = all.filter((s): s is Extract<Step, { kind: "respond" }> => s.kind === "respond");
    const stub = !calls.length && responds.some((r) => r.status === 501 && !r.guard);
    const responses: OperationModel["responses"] = [];
    for (const r of responds) if (!responses.some((x) => x.status === r.status && x.message === r.message)) responses.push({ status: r.status, message: r.message, when: r.when });
    const doc = res.doc.map((l) => l.replace(/^[#/]+\s?/, "").trim()).filter((l) => l && !l.startsWith("+"));
    for (const c of calls) {
      (connectorUse.get(c.connector) || connectorUse.set(c.connector, new Set()).get(c.connector)!).add(id);
      (connectorCalls.get(c.connector) || connectorCalls.set(c.connector, []).get(c.connector)!).push(c);
      if (c.mapping) (mappingUse.get(c.mapping) || mappingUse.set(c.mapping, new Set()).get(c.mapping)!).add(id);
    }
    for (const s of all) if (s.kind === "map") (mappingUse.get(s.mapping) || mappingUse.set(s.mapping, new Set()).get(s.mapping)!).add(id);
    // literal bodies and header sets written at the call site
    let n = 0;
    for (const s of flatCalls(walked.steps)) {
      const body = s.body?.text.trim() || "";
      if (body.startsWith("{")) {
        const fields = litFields(parseLiteral(body));
        if (fields.length) inline.push({ id: `${id}.body-${++n}`, operation: id, name: `Request to ${s.client} (${s.op})`, kind: "inline", file: s.src.file, line: s.src.line, code: redact(s.src.code), fields });
      }
    }
    for (const ft of walked.features) features.add(ft);
    if (walked.truncated) warnings.push(`${res.method} ${fullPath}: very long flow, only the first part is shown`);
    return {
      id, method: res.method, path: res.path, fullPath, summary: doc[0], implemented: !stub,
      file: src.file, line: src.line, endLine: src.endLine, code: redact(src.code), service,
      params: res.params.filter((p) => !/http:Caller/.test(p.type)).map((p) => ({ name: p.name, type: p.type, in: paramIn(p, res.path) })),
      calls, responses, features: walked.features,
      headersForwarded: [...new Set([...calls.flatMap((c) => c.forwarded), ...(walked.passThrough && calls.length ? PASS_THROUGH_HEADERS : [])])], headersRead: walked.headersRead, steps: walked.steps,
    };
  }

  // --- connectors (service package and companions)
  for (const b of builts) {
    const component = b.prefix ? b.prefix.slice(0, -1) : undefined;
    for (const c of b.pkg.clients) {
      const t = resolveTarget(c, b.ctx.config, b.resolved);
      const src = srcOf(c.file, c.start, c.end);
      const calls = b === main ? connectorCalls.get(c.name) || [] : [];
      let usedBy = b === main ? [...(connectorUse.get(c.name) || [])] : [];
      const paths = [...new Set(calls.map((x) => x.path).filter((p): p is string => !!p && c.kind !== "redis"))];
      // calls outside any operation (background jobs, companions)
      let background = 0; let gql = false;
      for (const f of b.pkg.files) {
        const re = new RegExp(`\\b${c.name}\\s*->\\s*(\\w+)\\s*\\(`, "g");
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(f.masked))) {
          background++;
          const close = matchClose(f.masked, mm.index + mm[0].length - 1);
          if (close > 0 && /\{\s*"?query"?\s*[:,}]/.test(f.text.slice(mm.index, close))) gql = true;
        }
      }
      if (!usedBy.length && background) usedBy = [component ? `(${component})` : "(background work)"];
      const settings: { key: string; value: string }[] = [];
      const secrets: string[] = [];
      if (t.settingsKey) {
        const v = b.ctx.config(t.settingsKey);
        for (const e of flatten(v, t.settingsKey)) {
          settings.push({ key: e.key, value: showValue(e.key, e.value) });
          if (isSecretKey(e.key)) secrets.push(e.key);
        }
      }
      let kind: string = c.kind;
      const bodyKinds = calls.map((x) => (x.mapping ? b.mappings.kindOf.get(x.mapping) : undefined));
      if (kind === "http" && (gql || /graphql/i.test(t.target + " " + (t.configKey || "") + " " + paths.join(" ")) || calls.some((x) => /^\{\s*"?query"?\s*[:,]/.test(x.body || "")) || bodyKinds.some((m) => m && m.kind === "query" && !SQL.test(m.code)))) kind = "graphql";
      let auth = "None found in the source";
      const fw = new Set(calls.flatMap((x) => x.forwarded));
      const hs = new Set(calls.flatMap((x) => x.headers));
      const authHeaders = [...hs].filter((h) => /authorization|api[-_]?key|token/i.test(h));
      const setSecrets = settings.filter((s) => isSecretKey(s.key) && s.value === "set").map((s) => s.key.split(".").pop());
      if (setSecrets.length) auth = `Credentials from configuration (${setSecrets.join(", ")}: set)`;
      else if (/\bauth\s*:/.test(c.init)) auth = "Credentials set in the client definition";
      else if ([...fw].some((h) => /authorization/i.test(h))) auth = `Passes on the caller's ${[...fw].filter((h) => /authorization/i.test(h)).join(" and ")} header`;
      else if (authHeaders.length) auth = `Sends ${authHeaders.join(", ")} header`;
      else if (secrets.length) auth = "Optional credentials in configuration (not set)";
      model.connectors.push({
        name: c.name, kind, target: t.target, configKey: t.configKey, auth, usedBy, component,
        file: src.file, line: src.line, code: redact(src.code), paths, secrets, settings,
      });
    }
    const taken = new Set(model.connectors.map((k) => k.name));
    model.connectors.push(...derivedConnectors(b, component, taken, b === main ? model.operations : []));
    for (const e of b.resolved.entries) model.config.push(e);
    for (const m of b.mappings.list) {
      const used = [...(mappingUse.get(m.id) || [])];
      model.mappings.push({ ...m, usedBy: used, operation: used.length === 1 ? used[0] : undefined });
    }
  }
  model.mappings.push(...inline);
  for (const b of builts) {
    if (b.resolved.unreadable) warnings.push(`The installed settings of this service (${b.resolved.unreadable}) cannot be read by the Factory. Addresses and settings shown here are the defaults in the code, not the installed values.`);
  }
  model.features = [...features];
  if (!model.operations.length) {
    warnings.push(model.mappings.length
      ? "The deployed code answers health checks only. The business operations of this API were not generated; the transformations listed under Mappings exist in the code but nothing calls them yet."
      : "The deployed code answers health checks only; no business operations were found.");
  }
  return model;
}
