// Node implementations. One handler per node type in the catalog.
import type { ConnectorOperation, FieldDef } from "@traceit/weave-flow";
import { evalExpr, renderDeep, renderString, renderTemplate, truthy, xmlToJson, jsonToXml, isEmpty } from "../expr.js";
import { applyMapping } from "../mapping/apply.js";
import { readBody, type HttpResult } from "../clients/http.js";
import type { ResolvedConnection } from "../clients/data.js";
import { FlowError, type NodeCtx, type NodeHandler, type NodeResult, type RuntimeRequest, type Scope, lowerKeys } from "./engine.js";
import { redact } from "../redact.js";
import { mssqlQuery, mysqlQuery } from "./sqlnodes.js";

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(Object.assign(new Error("Cancelled: the flow timed out"), { code: "ETIMEDOUT" })); return; }
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error("Cancelled: the flow timed out"), { code: "ETIMEDOUT" })); };
  signal?.addEventListener("abort", onAbort, { once: true });
});
const numOr = (v: unknown, d: number) => { const n = Number(v); return v !== undefined && v !== null && v !== "" && Number.isFinite(n) ? n : d; };

/** keyvalue fields are [{ key, value }]; a plain object is accepted too. */
export function kvList(v: unknown): { key: string; value: unknown }[] {
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object" && String((x as { key?: unknown }).key ?? "").trim() !== "").map((x) => ({ key: String((x as { key: unknown }).key).trim(), value: (x as { value?: unknown }).value }));
  if (v && typeof v === "object") return Object.entries(v).map(([key, value]) => ({ key, value }));
  return [];
}
const asText = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

// ---------------------------------------------------------------- connections
export function connectionOf(c: NodeCtx, id: unknown, type: string, required: boolean): ResolvedConnection | undefined {
  if (id === undefined || id === null || id === "") {
    if (required) throw new FlowError(`Choose a ${type} connection for this step`, { status: 500 });
    return undefined;
  }
  const conn = c.run.deps.resolveConnection(String(id));
  if (!conn) throw new FlowError("The connection this step uses no longer exists", { status: 500 });
  if (conn.type !== type) throw new FlowError(`This step needs a ${type} connection but "${conn.name}" is a ${conn.type} connection`, { status: 500 });
  for (const s of Object.values(conn.secrets)) if (s) c.run.secrets.add(s);
  return conn;
}

const tokenCache = new Map<string, { token: string; until: number }>();
export async function authHeaders(conn: ResolvedConnection, http: NodeCtx["run"]["deps"]["http"], secrets?: Set<string>): Promise<Record<string, string>> {
  const cfg = conn.config, sec = conn.secrets;
  switch (cfg.authType) {
    case "basic": {
      const v = Buffer.from(`${cfg.username ?? ""}:${sec.password ?? ""}`).toString("base64"); secrets?.add(v);
      return { authorization: `Basic ${v}` };
    }
    case "bearer": return sec.token ? { authorization: `Bearer ${sec.token}` } : {};
    case "apiKey": return sec.apiKey ? { [String(cfg.apiKeyHeader || "X-API-Key").toLowerCase()]: sec.apiKey } : {};
    case "oauth2cc": {
      const key = `${conn.id}|${conn.updatedAt}`;
      const hit = tokenCache.get(key);
      if (hit && hit.until > Date.now()) { secrets?.add(hit.token); return { authorization: `Bearer ${hit.token}` }; }
      if (!cfg.tokenUrl) throw new FlowError(`Connection "${conn.name}" has no token URL`, { status: 500 });
      const form = new URLSearchParams({ grant_type: "client_credentials" });
      if (cfg.scope) form.set("scope", String(cfg.scope));
      const basic = Buffer.from(`${cfg.clientId ?? ""}:${sec.clientSecret ?? ""}`).toString("base64"); secrets?.add(basic);
      const r = await http.request({ method: "POST", url: String(cfg.tokenUrl), headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString(), timeoutMs: 15_000, tlsVerify: cfg.tlsVerify !== false });
      let j: { access_token?: string; expires_in?: number } = {};
      try { j = JSON.parse(r.body.toString("utf8")); } catch { /* handled below */ }
      if (r.status >= 400 || !j.access_token) throw new FlowError(`Could not get a token for connection "${conn.name}" (HTTP ${r.status})`, { status: 502 });
      tokenCache.set(key, { token: j.access_token, until: Date.now() + Math.max(30, (j.expires_in ?? 300) - 30) * 1000 });
      secrets?.add(j.access_token);
      return { authorization: `Bearer ${j.access_token}` };
    }
    default: return {};
  }
}

// ---------------------------------------------------------------- HTTP
interface HttpSpec {
  conn?: ResolvedConnection; method: string; url: string;
  query: { key: string; value: unknown }[]; headers: Record<string, string>;
  body?: string | Buffer; timeoutMs: number; retries: number; retryDelayMs: number; failOnStatus: boolean; responseMode: string;
}
export function joinUrl(base: string | undefined, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (!base) throw new FlowError(path ? `"${path}" is not a full URL and the step has no connection that supplies a base URL` : "The step has no URL", { status: 500 });
  const b = String(base).replace(/\/+$/, "");
  if (!path) return b;
  return b + (path.startsWith("/") || path.startsWith("?") ? path : "/" + path);
}
async function doHttp(c: NodeCtx, s: HttpSpec): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  let url: URL;
  try { url = new URL(s.url); } catch { throw new FlowError(`Not a valid URL: ${s.url}`, { status: 500 }); }
  for (const q of s.query) { if (q.value === undefined || q.value === null || q.value === "") continue; if (Array.isArray(q.value)) for (const v of q.value) url.searchParams.append(q.key, asText(v)); else url.searchParams.append(q.key, asText(q.value)); }
  const shown = String(redact(url.toString(), c.run.secrets));
  c.step.meta = { ...(c.step.meta ?? {}), http: { method: s.method, url: shown } };
  const attempts = 1 + Math.max(0, Math.min(10, Math.floor(s.retries)));
  let lastErr: FlowError | undefined;
  for (let i = 1; i <= attempts; i++) {
    let res: HttpResult | undefined;
    try {
      res = await c.run.deps.http.request({ method: s.method, url: url.toString(), headers: s.headers, body: s.body, timeoutMs: s.timeoutMs, tlsVerify: s.conn ? s.conn.config.tlsVerify !== false : true, signal: c.run.abort.signal });
    } catch (e) {
      const x = e as { code?: string; message?: string };
      const timedOut = x.code === "ETIMEDOUT";
      lastErr = new FlowError(timedOut ? `${s.method} ${shown} timed out after ${s.timeoutMs} ms` : `${s.method} ${shown} failed: ${x.message ?? String(e)}`, { status: timedOut ? 504 : 502, detail: { code: x.code ?? null } });
    }
    if (res) {
      c.step.meta = { ...(c.step.meta ?? {}), http: { method: s.method, url: shown, status: res.status } };
      let body: unknown;
      try { body = readBody(res, s.responseMode); } catch (e) { throw new FlowError(`${s.method} ${shown}: ${(e as Error).message}`, { status: 502, detail: { status: res.status } }); }
      if (!(s.failOnStatus && res.status >= 400)) return { status: res.status, headers: res.headers, body };
      lastErr = new FlowError(`${s.method} ${shown} answered ${res.status}`, { status: res.status >= 500 ? 502 : res.status, detail: { status: res.status, body: body as never } });
      if (res.status < 500 && res.status !== 429) break;
    }
    if (i < attempts) { c.run.log("warn", `${lastErr!.message}; retrying (${i}/${attempts - 1})`, c.node.name); await sleep(Math.max(0, s.retryDelayMs), c.run.abort.signal); }
  }
  throw lastErr!;
}
async function buildHeaders(c: NodeCtx, conn: ResolvedConnection | undefined, extra: unknown): Promise<Record<string, string>> {
  const h: Record<string, string> = {};
  if (conn) {
    for (const kv of kvList(conn.config.defaultHeaders)) { const v = await renderString(kv.value, c.run.es(c.scope)); if (v !== "") h[kv.key.toLowerCase()] = v; }
    Object.assign(h, await authHeaders(conn, c.run.deps.http, c.run.secrets));
  }
  const incoming = c.run.request?.headers ?? {};
  for (const name of Array.isArray(c.cfg.forwardHeaders) ? (c.cfg.forwardHeaders as unknown[]) : []) {
    const k = String(name).trim().toLowerCase();
    if (k && incoming[k] !== undefined) h[k] = incoming[k];
  }
  for (const kv of kvList(extra)) { const v = await renderString(kv.value, c.run.es(c.scope)); if (v !== "") h[kv.key.toLowerCase()] = v; }
  return h;
}

const httpRequest: NodeHandler = async (c) => {
  const cfg = c.cfg;
  const conn = connectionOf(c, cfg.connection, "http", false);
  const es = c.run.es(c.scope);
  const method = String(cfg.method || "GET").toUpperCase();
  const url = joinUrl(conn?.config.baseUrl as string | undefined, (await renderString(cfg.url, es)).trim());
  const query: { key: string; value: unknown }[] = [];
  for (const kv of kvList(cfg.query)) query.push({ key: kv.key, value: await renderTemplate(kv.value, es) });
  const headers = await buildHeaders(c, conn, cfg.headers);
  let body: string | undefined;
  const setCt = (ct: string) => { if (!headers["content-type"]) headers["content-type"] = ct; };
  switch (cfg.bodyMode) {
    case "payload":
      if (typeof c.scope.payload === "string") { body = c.scope.payload; setCt(/^\s*</.test(body) ? "application/xml" : "text/plain"); }
      else { body = JSON.stringify(c.scope.payload ?? null); setCt("application/json"); }
      break;
    case "json": { const v = await renderDeep(typeof cfg.body === "string" ? tryJson(cfg.body) : cfg.body, es); body = JSON.stringify(v ?? null); setCt("application/json"); break; }
    case "form": { const v = (await renderDeep(typeof cfg.body === "string" ? tryJson(cfg.body) : cfg.body, es)) as Record<string, unknown> | undefined; const f = new URLSearchParams(); for (const [k, x] of Object.entries(v ?? {})) if (x !== undefined && x !== null) f.append(k, asText(x)); body = f.toString(); setCt("application/x-www-form-urlencoded"); break; }
    case "raw": body = await renderString(cfg.bodyRaw, es); setCt(String(cfg.contentType || "text/plain")); break;
    default: break;
  }
  if (!headers.accept) headers.accept = "application/json, */*;q=0.8";
  const res = await doHttp(c, { conn, method, url, query, headers, body, timeoutMs: numOr(cfg.timeoutMs, numOr(conn?.config.timeoutMs, 30_000)), retries: numOr(cfg.retries, 0), retryDelayMs: numOr(cfg.retryDelayMs, 500), failOnStatus: cfg.failOnStatus !== false, responseMode: String(cfg.responseMode || "auto") });
  return { result: cfg.output === "full" ? { status: res.status, headers: res.headers, body: res.body } : res.body };
};
function tryJson(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }

const graphqlRequest: NodeHandler = async (c) => {
  const cfg = c.cfg;
  const conn = connectionOf(c, cfg.connection, "http", false);
  const es = c.run.es(c.scope);
  const url = joinUrl(conn?.config.baseUrl as string | undefined, (await renderString(cfg.url, es)).trim());
  const headers = await buildHeaders(c, conn, cfg.headers);
  headers["content-type"] = "application/json"; if (!headers.accept) headers.accept = "application/json";
  if (!String(cfg.query || "").trim()) throw new FlowError("The GraphQL query is empty", { status: 500 });
  const variables = await renderDeep(typeof cfg.variables === "string" ? tryJson(cfg.variables) : cfg.variables ?? {}, es);
  const payload: Record<string, unknown> = { query: String(cfg.query), variables: variables ?? {} };
  if (cfg.operationName) payload.operationName = String(cfg.operationName);
  const res = await doHttp(c, { conn, method: "POST", url, query: [], headers, body: JSON.stringify(payload), timeoutMs: numOr(cfg.timeoutMs, numOr(conn?.config.timeoutMs, 30_000)), retries: numOr(cfg.retries, 0), retryDelayMs: numOr(cfg.retryDelayMs, 500), failOnStatus: true, responseMode: "auto" });
  const body = (res.body && typeof res.body === "object" ? res.body : { data: null, errors: [{ message: "The endpoint did not return a GraphQL response" }] }) as { data?: unknown; errors?: { message?: string }[] };
  if (cfg.failOnErrors !== false && Array.isArray(body.errors) && body.errors.length) {
    throw new FlowError(`GraphQL error: ${body.errors.map((e) => e?.message ?? "unknown").join("; ")}`, { status: 502, detail: { errors: body.errors as never } });
  }
  return { result: cfg.output === "full" ? { data: body.data ?? null, errors: body.errors ?? [] } : body.data ?? null };
};

export const connectorHandler: NodeHandler = async (c) => {
  const [, connectorId, opId] = /^connector:([^:]+):(.+)$/.exec(c.node.type) ?? [];
  const connector = connectorId ? c.run.deps.getConnector(connectorId) : undefined;
  if (!connector) throw new FlowError("The custom connector this step uses no longer exists", { status: 500 });
  const op: ConnectorOperation | undefined = connector.operations.find((o) => o.id === opId);
  if (!op) throw new FlowError(`Connector "${connector.name}" no longer has the operation "${opId}"`, { status: 500 });
  const cfg = c.cfg;
  const conn = connectionOf(c, cfg.connection || connector.defaultConnectionId, "http", false);
  const es0 = c.run.es(c.scope);
  const params: Record<string, unknown> = {};
  for (const f of op.params ?? []) {
    const raw = cfg[f.key] !== undefined ? cfg[f.key] : f.default;
    params[f.key] = await renderParam(f, raw, es0);
    if (f.required && isEmpty(params[f.key])) throw new FlowError(`"${f.label || f.key}" is required for ${op.name}`, { status: 400 });
  }
  const es = { ...es0, params };
  const path = op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => encodeURIComponent(asText(params[name])));
  const url = joinUrl(conn?.config.baseUrl as string | undefined, path);
  const query: { key: string; value: unknown }[] = [];
  for (const kv of kvList(op.query)) query.push({ key: kv.key, value: await renderTemplate(kv.value, es) });
  const headers = await buildHeaders(c, conn, undefined);
  for (const kv of kvList(op.headers)) { const v = await renderString(kv.value, es); if (v !== "") headers[kv.key.toLowerCase()] = v; }
  const method = String(op.method || "GET").toUpperCase();
  let body: string | undefined;
  if (!["GET", "HEAD", "DELETE"].includes(method) || op.bodyTemplate) {
    const v = op.bodyTemplate ? await renderTemplate(op.bodyTemplate, es) : c.scope.payload;
    if (v !== undefined && v !== null && v !== "") {
      body = typeof v === "string" ? v : JSON.stringify(v);
      if (!headers["content-type"]) headers["content-type"] = typeof v === "string" && /^\s*</.test(v) ? "application/xml" : "application/json";
    }
  }
  if (!headers.accept) headers.accept = "application/json, */*;q=0.8";
  const res = await doHttp(c, { conn, method, url, query, headers, body, timeoutMs: numOr(cfg.timeoutMs, numOr(conn?.config.timeoutMs, 30_000)), retries: numOr(cfg.retries, 0), retryDelayMs: numOr(cfg.retryDelayMs, 500), failOnStatus: cfg.failOnStatus !== false, responseMode: "auto" });
  return { result: cfg.output === "full" ? { status: res.status, headers: res.headers, body: res.body } : res.body };
};
async function renderParam(f: FieldDef, raw: unknown, es: Parameters<typeof renderTemplate>[1]): Promise<unknown> {
  if (raw === undefined || raw === null) return undefined;
  if (f.kind === "expr" || f.kind === "code") return typeof raw === "string" ? evalExpr(raw, es) : raw;
  if (f.kind === "json") return renderDeep(typeof raw === "string" ? tryJson(raw) : raw, es);
  return renderDeep(raw, es);
}

// ---------------------------------------------------------------- Redis & Postgres
const redisCommand: NodeHandler = async (c) => {
  const cfg = c.cfg;
  const conn = connectionOf(c, cfg.connection, "redis", true)!;
  const es = c.run.es(c.scope);
  const prefix = String(conn.config.keyPrefix ?? "");
  const key = prefix + (await renderString(cfg.key, es));
  const op = String(cfg.operation || "get").toLowerCase();
  if (!key && op !== "keys") throw new FlowError("The cache key is empty", { status: 500 });
  const asJson = cfg.json !== false;
  const enc = (v: unknown) => (asJson ? JSON.stringify(v ?? null) : asText(v));
  const dec = (v: string | null | undefined) => { if (v === null || v === undefined) return null; if (!asJson) return v; try { return JSON.parse(v); } catch { return v; } };
  let client;
  try { client = await c.run.deps.data.redisFor(conn); } catch (e) { throw new FlowError(`Cannot reach Redis "${conn.name}": ${(e as Error).message}`, { status: 502 }); }
  try {
    switch (op) {
      case "get": { const v = await client.get(key); c.step.meta = { cache: { hit: v !== null } }; return { result: dec(v) }; }
      case "set": { const v = await evalExpr(String(cfg.value ?? "$"), es); const ttl = numOr(cfg.ttlSeconds, 0); if (ttl > 0) await client.set(key, enc(v), { EX: Math.floor(ttl) }); else await client.set(key, enc(v)); return { output: { ok: true, key } }; }
      case "del": return { result: await client.del(key) };
      case "exists": return { result: (await client.exists(key)) > 0 };
      case "expire": return { result: await client.expire(key, Math.floor(numOr(cfg.ttlSeconds, 60))) };
      case "incr": return { result: await client.incr(key) };
      case "hget": { const v = await client.hGet(key, await renderString(cfg.field, es)); c.step.meta = { cache: { hit: v !== undefined && v !== null } }; return { result: dec(v ?? null) }; }
      case "hset": { const v = await evalExpr(String(cfg.value ?? "$"), es); await client.hSet(key, await renderString(cfg.field, es), enc(v)); return { output: { ok: true, key } }; }
      case "hgetall": { const all = await client.hGetAll(key); const out: Record<string, unknown> = {}; for (const [k, v] of Object.entries(all)) out[k] = dec(v); return { result: out }; }
      case "keys": { const keys = await client.keys(key || prefix + "*"); return { result: prefix ? keys.map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : k)) : keys }; }
      default: throw new FlowError(`Unsupported cache operation "${op}"`, { status: 500 });
    }
  } catch (e) {
    if (e instanceof FlowError) throw e;
    throw new FlowError(`Redis ${op.toUpperCase()} failed: ${(e as Error).message}`, { status: 502 });
  }
};
const postgresQuery: NodeHandler = async (c) => {
  const cfg = c.cfg;
  const conn = connectionOf(c, cfg.connection, "postgres", true)!;
  const es = c.run.es(c.scope);
  if (!String(cfg.sql || "").trim()) throw new FlowError("The SQL statement is empty", { status: 500 });
  const params: unknown[] = [];
  for (const p of Array.isArray(cfg.params) ? cfg.params : []) { const v = typeof p === "string" ? await evalExpr(p, es) : p; params.push(v === undefined ? null : v && typeof v === "object" ? JSON.stringify(v) : v); }
  try {
    const pool = await c.run.deps.data.pgFor(conn);
    let res;
    if (conn.config.readOnly === true) {
      // read-only connection: the statement runs in a read-only transaction, so the database refuses changes
      const client = await pool.connect();
      try { await client.query("BEGIN READ ONLY"); res = await client.query(String(cfg.sql), params); await client.query("COMMIT"); }
      catch (e) { await client.query("ROLLBACK").catch(() => undefined); throw e; }
      finally { client.release(); }
    } else res = await pool.query(String(cfg.sql), params);
    const rows = (Array.isArray(res) ? res[res.length - 1].rows : res.rows) ?? [];
    const count = (Array.isArray(res) ? res[res.length - 1].rowCount : res.rowCount) ?? rows.length;
    return { result: cfg.resultMode === "first" ? rows[0] ?? null : cfg.resultMode === "count" ? count : rows };
  } catch (e) {
    throw new FlowError(`Database query failed: ${(e as Error).message}`, { status: 502, detail: { code: (e as { code?: string }).code ?? null } });
  }
};

// ---------------------------------------------------------------- flow.call
const flowCall: NodeHandler = async (c) => {
  const cfg = c.cfg;
  if (!cfg.flow) throw new FlowError("Choose the flow to call", { status: 500 });
  const target = c.run.deps.getFlowForCall(String(cfg.flow), c.run.exec.mode);
  if (!target) throw new FlowError("The flow this step calls no longer exists", { status: 500 });
  const es = c.run.es(c.scope);
  const input = await evalExpr(String(cfg.input ?? "$"), es);
  const mode = c.run.exec.mode === "node-test" ? "test" : c.run.exec.mode;
  let request: RuntimeRequest | undefined; let triggerNodeId: string | undefined; const warnings: string[] = [];
  if (cfg.entry === "http") {
    const r = ((await renderDeep(typeof cfg.request === "string" ? tryJson(cfg.request) : cfg.request ?? {}, es)) ?? {}) as { method?: string; path?: string; query?: Record<string, unknown>; headers?: Record<string, unknown> };
    const method = String(r.method || "GET").toUpperCase(); const path = String(r.path || "/");
    const m = matchHttpTrigger(target, method, path);
    if (!m) throw new FlowError(`"${target.name}" has no HTTP listener for ${method} ${path}`, { status: 404 });
    triggerNodeId = m.nodeId;
    request = { method, path, params: m.params, query: { ...(r.query ?? {}) }, headers: lowerKeys(r.headers ?? {}), body: input ?? null };
  } else {
    const manual = target.nodes.find((n) => n.type === "trigger.manual" && !n.disabled);
    if (!manual) throw new FlowError(`"${target.name}" has no Manual / Sub-flow start to enter through`, { status: 500 });
    triggerNodeId = manual.id;
  }
  const child = await c.run.engine.run({ flow: target, mode, via: c.run.exec.via, triggerNodeId, request, payload: input ?? null, depth: c.run.depth + 1, warnings });
  // The caller's request stays visible to a sub-flow entered manually (header forwarding keeps working).
  c.step.meta = { ...(c.step.meta ?? {}), flow: { id: target.id, name: target.name, executionId: child.execution.id, status: child.response.status } };
  if (child.execution.status === "error") {
    throw new FlowError(`"${target.name}" failed: ${child.execution.error?.message ?? "unknown error"}`, { status: child.execution.error?.status ?? 500, detail: { flow: target.name, executionId: child.execution.id, node: child.execution.error?.nodeName ?? null } });
  }
  if (cfg.entry === "http" && child.response.status >= 400) {
    throw new FlowError(`"${target.name}" answered ${child.response.status}`, { status: child.response.status, detail: { flow: target.name, executionId: child.execution.id, body: child.response.body as never } });
  }
  return { result: child.response.body };
};

// ---------------------------------------------------------------- HTTP trigger matching (shared with the listeners)
export interface TriggerRoute { nodeId: string; methods: string[]; path: string; regex: RegExp; names: string[]; score: number; }
export function compileTriggerPath(path: string): { regex: RegExp; names: string[]; score: number } {
  const names: string[] = []; let score = 0;
  const norm = "/" + String(path || "/").replace(/^\/+|\/+$/g, "");
  const parts = norm.split("/").filter(Boolean).map((seg) => {
    let m: RegExpExecArray | null;
    if ((m = /^:([A-Za-z_][\w-]*)$/.exec(seg)) || (m = /^\{([A-Za-z_][\w-]*)\}$/.exec(seg))) { names.push(m[1]); return "([^/]+)"; }
    if (seg === "*" || seg === "**") { names.push("wildcard"); return "(.*)"; }
    score += 10;
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { regex: new RegExp("^/" + parts.join("/") + "/?$"), names, score: score + parts.length };
}
export function triggerRoutes(flow: { nodes: { id: string; type: string; disabled?: boolean; config: Record<string, unknown> }[] }): TriggerRoute[] {
  const out: TriggerRoute[] = [];
  for (const n of flow.nodes) {
    if (n.type !== "trigger.http" || n.disabled) continue;
    const methods = (Array.isArray(n.config?.methods) && n.config.methods.length ? (n.config.methods as unknown[]) : ["GET"]).map((m) => String(m).toUpperCase());
    const path = String(n.config?.path || "/");
    out.push({ nodeId: n.id, methods, path, ...compileTriggerPath(path) });
  }
  return out.sort((a, b) => b.score - a.score);
}
export function matchRoutes(routes: TriggerRoute[], method: string, path: string): { nodeId: string; params: Record<string, string>; methodMismatch?: boolean } | undefined {
  const p = "/" + String(path || "/").replace(/^\/+/, "").replace(/\?.*$/, "");
  let wrongMethod = false;
  for (const r of routes) {
    const m = r.regex.exec(p);
    if (!m) continue;
    if (!r.methods.includes(method.toUpperCase())) { wrongMethod = true; continue; }
    const params: Record<string, string> = {};
    r.names.forEach((n, i) => { try { params[n] = decodeURIComponent(m[i + 1] ?? ""); } catch { params[n] = m[i + 1] ?? ""; } });
    return { nodeId: r.nodeId, params };
  }
  return wrongMethod ? { nodeId: "", params: {}, methodMismatch: true } : undefined;
}
export function matchHttpTrigger(flow: Parameters<typeof triggerRoutes>[0], method: string, path: string) {
  const m = matchRoutes(triggerRoutes(flow), method, path);
  return m && !m.methodMismatch ? m : undefined;
}

// ---------------------------------------------------------------- transform
const transformMap: NodeHandler = async (c) => {
  const es = c.run.es(c.scope);
  const source = await evalExpr(String(c.cfg.input ?? "$"), es);
  const spec = c.cfg.mapping as Parameters<typeof applyMapping>[0];
  const { output, rules } = await applyMapping(spec, source, es, c.run.deps.compileInstruction);
  const failed = rules.filter((r) => !r.ok);
  c.step.meta = { ...(c.step.meta ?? {}), mapping: { rules: rules.length, failed: failed.length } };
  if (failed.length) {
    const targets = new Map((spec?.rules ?? []).map((r) => [r.id, r.target]));
    throw new FlowError(`${failed.length} mapping rule${failed.length > 1 ? "s" : ""} failed: ` + failed.map((f) => `${targets.get(f.id) || f.id}: ${f.error}`).join(" | "),
      { status: 500, detail: { rules: failed.map((f) => ({ id: f.id, target: targets.get(f.id) ?? null, message: f.error ?? "" })), partialOutput: output } });
  }
  return { result: output };
};
const transformExpr: NodeHandler = async (c) => ({ result: await evalExpr(String(c.cfg.expr ?? "$"), c.run.es(c.scope)) });
const varsSet: NodeHandler = async (c) => {
  const set: Record<string, unknown> = {};
  for (const kv of kvList(c.cfg.assignments)) {
    const es = c.run.es(c.scope);
    const raw = kv.value;
    const v = typeof raw !== "string" ? raw : raw.includes("{{") ? await renderTemplate(raw, es) : await evalExpr(raw, es);
    c.run.vars[kv.key] = v === undefined ? null : v; set[kv.key] = c.run.vars[kv.key];
  }
  return { output: set };
};
const xmlConvert: NodeHandler = async (c) => {
  const input = await evalExpr(String(c.cfg.input ?? "$"), c.run.es(c.scope));
  try {
    if (c.cfg.mode === "json2xml") return { result: jsonToXml(input) };
    if (input !== undefined && input !== null && typeof input !== "string") throw new Error("the input is not XML text");
    return { result: xmlToJson(input) ?? null };
  } catch (e) { throw new FlowError(`XML conversion failed: ${(e as Error).message}`, { status: 400 }); }
};

// ---------------------------------------------------------------- logic
const choice: NodeHandler = async (c) => {
  const conds = Array.isArray(c.cfg.conditions) ? (c.cfg.conditions as { id: string; label?: string; expr?: string }[]) : [];
  for (const cond of conds) {
    if (!cond || !String(cond.expr ?? "").trim()) continue;
    if (truthy(await evalExpr(String(cond.expr), c.run.es(c.scope)))) return { port: `case:${cond.id}`, output: { matched: cond.label || cond.id } };
  }
  return { port: "otherwise", output: { matched: "otherwise" } };
};
/** Runs the sub-graph behind a port; the result is the payload at the end of its last path. */
async function subgraph(c: NodeCtx, port: string, scope: Scope): Promise<unknown> { return c.run.follow(c.node.id, port, scope); }

const forEach: NodeHandler = async (c) => {
  let items = await evalExpr(String(c.cfg.items ?? "$"), c.run.es(c.scope));
  if (items === undefined || items === null) items = [];
  if (!Array.isArray(items)) throw new FlowError("For Each needs a list, but the Items expression gave a single value", { status: 500 });
  const list = items as unknown[];
  const results: unknown[] = new Array(list.length);
  const conc = Math.max(1, Math.min(20, Math.floor(numOr(c.cfg.concurrency, 1))));
  let next = 0; let failure: unknown;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length || failure) return;
      try { results[i] = await subgraph(c, "each", { ...c.scope, payload: list[i], item: list[i], index: i, iteration: i }); }
      catch (e) { failure = failure ?? e; return; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, list.length || 1) }, worker));
  if (failure) throw failure;
  if (c.cfg.collect !== false) c.scope.payload = results.map((r) => (r === undefined ? null : r));
  return { port: "done", output: { items: list.length, collected: c.cfg.collect !== false } };
};
const parallel: NodeHandler = async (c) => {
  const branches = Array.isArray(c.cfg.branches) ? (c.cfg.branches as { id: string; label?: string }[]) : [];
  const settled = await Promise.allSettled(branches.map((b) => subgraph(c, `branch:${b.id}`, { ...c.scope, branch: b.label || b.id })));
  const out: Record<string, unknown> = {};
  let failure: unknown;
  settled.forEach((s, i) => { if (s.status === "fulfilled") out[branches[i].label || branches[i].id] = s.value === undefined ? null : s.value; else failure = failure ?? s.reason; });
  if (failure) throw failure;
  c.scope.payload = out;
  return { port: "done", output: out };
};
const tryCatch: NodeHandler = async (c) => {
  try {
    c.scope.payload = await subgraph(c, "try", { ...c.scope });
    return { port: "done", output: { caught: false } };
  } catch (e) {
    const err = e instanceof FlowError ? e : new FlowError((e as Error)?.message || String(e));
    if (c.run.abort.signal.aborted) throw err;
    const error = { message: err.message, status: err.status ?? 500, node: err.nodeName ?? null, detail: err.detail ?? null };
    c.scope.error = error;
    if (c.run.edges(c.node.id, "catch").length) c.scope.payload = await subgraph(c, "catch", { ...c.scope, error });
    else c.run.log("warn", `Error ignored by "${c.node.name}" (nothing is connected to Catch): ${err.message}`, c.node.name);
    return { port: "done", output: { caught: true, error } };
  }
};
const validate: NodeHandler = async (c) => {
  const rules = Array.isArray(c.cfg.rules) ? (c.cfg.rules as { id: string; label?: string; expr?: string }[]) : [];
  const failed: string[] = [];
  for (const r of rules) {
    if (!r || !String(r.expr ?? "").trim()) continue;
    if (!truthy(await evalExpr(String(r.expr), c.run.es(c.scope)))) failed.push(r.label || r.expr || r.id);
  }
  if (failed.length) throw new FlowError(failed.join("; "), { status: numOr(c.cfg.status, 400), detail: { failed } });
  return { output: { checked: rules.length } };
};
const delay: NodeHandler = async (c) => { await sleep(Math.max(0, Math.min(numOr(c.cfg.ms, 1000), 600_000)), c.run.abort.signal); return {}; };
const stop: NodeHandler = async (c) => {
  if (c.cfg.mode === "end") return { end: true, output: { stopped: true } };
  const msg = (await renderString(c.cfg.message, c.run.es(c.scope))) || "Stopped by the flow";
  throw new FlowError(msg, { status: numOr(c.cfg.status, 500) });
};

// ---------------------------------------------------------------- utility
const respond: NodeHandler = async (c) => {
  const es = c.run.es(c.scope);
  const rawStatus = c.cfg.status;
  const st = typeof rawStatus === "number" ? rawStatus : Number(await evalExpr(String(rawStatus ?? "200"), es));
  const status = Number.isInteger(st) && st >= 100 && st <= 599 ? st : 200;
  const body = await evalExpr(String(c.cfg.body ?? "$"), es);
  const headers: Record<string, string> = {};
  for (const kv of kvList(c.cfg.headers)) { const v = await renderString(kv.value, es); if (v !== "") headers[kv.key.toLowerCase()] = v; }
  const contentType = String(c.cfg.contentType || "").trim() || undefined;
  const sent = c.run.respond({ status, headers, body: body === undefined ? null : body, contentType });
  if (!sent) c.run.log("warn", `"${c.node.name}" was reached after a response had already been sent; it was ignored`, c.node.name);
  return { output: { status, headers, body: body === undefined ? null : body, sent } };
};
const logNode: NodeHandler = async (c) => {
  let msg = await renderString(c.cfg.message, c.run.es(c.scope));
  if (c.cfg.includePayload) msg += " " + JSON.stringify(redact(c.scope.payload, c.run.secrets));
  if (msg.length > 8000) msg = msg.slice(0, 8000) + "…";
  c.run.log(String(c.cfg.level || "info"), msg, c.node.name);
  return { output: { logged: msg } };
};
const passthrough: NodeHandler = async (): Promise<NodeResult> => ({});

export const HANDLERS: Record<string, NodeHandler> = {
  "trigger.http": passthrough, "trigger.schedule": passthrough, "trigger.manual": passthrough,
  "http.request": httpRequest, "graphql.request": graphqlRequest, "redis.command": redisCommand, "postgres.query": postgresQuery, "mysql.query": mysqlQuery, "mssql.query": mssqlQuery, "flow.call": flowCall,
  "transform.map": transformMap, "transform.expr": transformExpr, "vars.set": varsSet, "xml.convert": xmlConvert,
  "logic.choice": choice, "logic.foreach": forEach, "logic.parallel": parallel, "logic.try": tryCatch, "logic.validate": validate, "logic.delay": delay, "logic.stop": stop,
  respond, log: logNode, note: passthrough,
};
