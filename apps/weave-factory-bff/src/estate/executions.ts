// Calls that went through the migrated services, rebuilt from what the estate already records:
// the services' own log lines (one correlation id follows a call across the layers) and the API
// gateway's request records. Read-only; everything is kept in memory on this server and nothing
// is sent anywhere.
import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { K8s, LogLine } from "./k8s.js";
import type { Layer } from "./model.js";

export type FieldValue = string | number | boolean;
export interface TraceLine { ms: number; api: string; component?: string; level?: string; message: string; fields: Record<string, FieldValue>; correlationId: string; }
export interface GatewayEvent {
  ms: number; at: string; kind: string; apiName: string; context?: string; version?: string; method?: string; resource?: string;
  status: number; targetStatus?: number; responseLatency?: number; backendLatency?: number; requestMediationLatency?: number; responseMediationLatency?: number;
  application?: string; keyType?: string; userAgent?: string; platform?: string; userIp?: string; userName?: string; cacheHit?: boolean;
  responseSize?: number; errorType?: string; errorMessage?: string; correlationId: string;
}
interface Part { key: string; api: string; component?: string; firstMs: number; started: boolean; lines: number; }
export interface TraceGroup { id: string; lines: TraceLine[]; dropped: number; firstMs: number; lastMs: number; errors: number; warnings: number; parts: Map<string, Part>; }
export interface ApiInfo { name: string; layer: Layer; published: boolean; context?: string; }

export type MigratedStatus = "success" | "error" | "running" | "unknown";
export type MigratedVia = "gateway" | "direct" | "internal" | "unknown";
export interface MigratedSummary {
  id: string; kind: "call" | "job"; api: string; component?: string; layer: Layer; chain: string[];
  operation?: string; route?: string; startedAt: string; finishedAt?: string; durationMs?: number; serviceMs?: number;
  status: MigratedStatus; httpStatus?: number; outcome?: string; errors: number; warnings: number;
  via?: MigratedVia; application?: string; trigger?: string; stepCount: number; source: "logs" | "gateway" | "both";
}
export interface MigratedStep { at: string; offsetMs: number; api: string; component?: string; level?: string; message: string; fields: Record<string, FieldValue>; }
export interface MigratedExecution extends MigratedSummary { correlationId?: string; steps: MigratedStep[]; hiddenSteps: number; gateway?: GatewayEvent & { matchedBy: "time" | "record" }; }

const MAX_VALUE = 400;
const clip = (s: string) => (s.length > MAX_VALUE ? s.slice(0, MAX_VALUE) + "…" : s);
const scalar = (v: unknown): FieldValue => (typeof v === "number" || typeof v === "boolean" ? v : clip(typeof v === "string" ? v : JSON.stringify(v) ?? ""));
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);

/** The fields of one structured log line: a JSON object, or key=value pairs (quoted or bare). */
export function parseFields(text: string): Record<string, FieldValue> | null {
  const t = text.trim();
  if (t.startsWith("{")) {
    try {
      const o = JSON.parse(t) as unknown;
      if (o && typeof o === "object" && !Array.isArray(o)) {
        const out: Record<string, FieldValue> = {};
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (v !== null && v !== undefined) out[k] = scalar(v);
        return out;
      }
    } catch { /* not JSON after all: read it as key=value */ }
  }
  const out: Record<string, FieldValue> = {};
  let n = 0;
  const re = /(?:^|\s)([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|[^\s"]*)/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const raw = m[2];
    let v: FieldValue;
    if (raw.startsWith('"')) { try { v = clip(String(JSON.parse(raw))); } catch { v = clip(raw.slice(1, -1)); } }
    else if (raw === "true" || raw === "false") v = raw === "true";
    else if (/^-?\d+(\.\d+)?$/.test(raw) && raw.length < 16) v = Number(raw);
    else v = clip(raw);
    out[m[1]] = v; n++;
  }
  return n ? out : null;
}

const SKIP = new Set(["time", "level", "module", "message", "msg", "correlationId", "correlation_id"]);

/** A log line that belongs to a traced call; null when it carries no correlation id. */
export function parseTraceLine(l: LogLine, api: string, component?: string): TraceLine | null {
  if (!l.text.includes("orrelation")) return null;
  const f = parseFields(l.text);
  if (!f) return null;
  const cid = str(f.correlationId) ?? str(f.correlation_id);
  if (!cid) return null;
  const own = typeof f.time === "string" ? Date.parse(f.time) : NaN;
  const ms = Number.isFinite(own) ? own : l.at ? Date.parse(l.at) : NaN;
  if (!Number.isFinite(ms)) return null;
  const fields: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(f)) if (!SKIP.has(k)) fields[k] = v;
  return { ms, api, component, level: l.level, message: str(f.message) ?? str(f.msg) ?? "", fields, correlationId: cid };
}

/** One request record of the API gateway (its analytics log), or null for any other line. */
export function parseGatewayLine(line: string): GatewayEvent | null {
  const m = /apim:(\w+),\s*properties\s*:\s*(\{.*\})\s*$/.exec(line);
  if (!m) return null;
  let e: Record<string, unknown>;
  try { e = JSON.parse(m[2]) as Record<string, unknown>; } catch { return null; }
  const at = str(e.requestTimestamp);
  const ms = at ? Date.parse(at) : NaN;
  const apiName = str(e.apiName);
  if (!apiName || !Number.isFinite(ms)) return null;
  const props = (e.properties && typeof e.properties === "object" ? e.properties : {}) as Record<string, unknown>;
  const none = (s?: string) => (s && !/^(n\/a|unknown|other|null)$/i.test(s) ? s : undefined);
  return {
    ms, at: new Date(ms).toISOString(), kind: m[1], apiName, context: str(e.apiContext), version: str(e.apiVersion), method: str(e.apiMethod), resource: str(e.apiResourceTemplate),
    status: num(e.proxyResponseCode) ?? 0, targetStatus: num(e.targetResponseCode), responseLatency: num(e.responseLatency), backendLatency: num(e.backendLatency),
    requestMediationLatency: num(e.requestMediationLatency), responseMediationLatency: num(e.responseMediationLatency),
    application: none(str(e.applicationName)), keyType: none(str(e.keyType)), userAgent: none(str(e.userAgent)), platform: none(str(e.platform)), userIp: none(str(e.userIp)), userName: none(str(e.userName)),
    cacheHit: typeof e.responseCacheHit === "boolean" ? e.responseCacheHit : undefined, responseSize: num(props.responseSize),
    errorType: none(str(e.errorType)), errorMessage: none(str(e.errorMessage)), correlationId: str(e.correlationId) ?? `${apiName}@${ms}`,
  };
}

// ---- grouping

const MAX_LINES = 400, HEAD = 300;
const STARTED = /\b(request|job|call|run)\s+(started|received|accepted)\b/i;
const partKey = (l: { api: string; component?: string }) => l.component || l.api;

export function addLine(groups: Map<string, TraceGroup>, l: TraceLine): TraceGroup {
  let g = groups.get(l.correlationId);
  if (!g) { g = { id: l.correlationId, lines: [], dropped: 0, firstMs: l.ms, lastMs: l.ms, errors: 0, warnings: 0, parts: new Map() }; groups.set(g.id, g); }
  if (l.ms < g.firstMs) g.firstMs = l.ms;
  if (l.ms > g.lastMs) g.lastMs = l.ms;
  if (l.level === "error") g.errors++; else if (l.level === "warn") g.warnings++;
  const key = partKey(l);
  const p = g.parts.get(key);
  const started = STARTED.test(l.message);
  if (!p) g.parts.set(key, { key, api: l.api, component: l.component, firstMs: l.ms, started, lines: 1 });
  else { p.lines++; if (l.ms < p.firstMs) p.firstMs = l.ms; if (started) p.started = true; }
  // a long-running job writes thousands of lines: keep how it began and the newest ones
  if (g.lines.length >= MAX_LINES) { g.lines.splice(HEAD, 1); g.dropped++; }
  g.lines.push(l);
  return g;
}
export function groupLines(lines: TraceLine[]): Map<string, TraceGroup> {
  const groups = new Map<string, TraceGroup>();
  for (const l of lines) addLine(groups, l);
  return groups;
}

const RANK: Record<string, number> = { exp: 0, proc: 1, sys: 2, other: 3 };
const DONE = /\b(completed|finished|served|done|answered|failed|rejected)\b/i;
const GOOD = /^(ok|success|succeeded|successful|completed|done|skipped)$/i;

interface Built extends MigratedExecution { startedMs: number; }

function fromGroup(g: TraceGroup, apis: Map<string, ApiInfo>, now: number): Built {
  const layer = (api: string): Layer => apis.get(api)?.layer ?? "other";
  const parts = [...g.parts.values()];
  const order = (a: Part, b: Part) => Number(b.started) - Number(a.started) || RANK[layer(a.api)] - RANK[layer(b.api)] || a.firstMs - b.firstMs;
  const entry = parts.slice().sort(order)[0];
  const lines = g.lines.slice().sort((a, b) => a.ms - b.ms);
  const own = lines.filter((l) => partKey(l) === entry.key);
  const pick = (name: string) => { for (const l of own) { const v = l.fields[name]; if (v !== undefined && v !== "") return v; } return undefined; };
  const job = str(pick("job"));
  const kind: "call" | "job" = entry.component || job ? "job" : "call";
  const operation = str(pick("operationName")) ?? str(pick("operation")) ?? job ?? str(pick("rootField")) ?? str(pick("sourceEndpoint"))
    ?? str(lines.find((l) => l.fields.operation !== undefined)?.fields.operation);
  // the line that says how it ended: the last one of the entry service with a status or an outcome
  const hasStatus = (l: TraceLine) => { const st = num(l.fields.status); return st !== undefined && st >= 100 && st < 600; };
  let end: TraceLine | undefined;
  for (let i = own.length - 1; i >= 0 && !end; i--) if ((hasStatus(own[i]) && DONE.test(own[i].message)) || own[i].fields.outcome !== undefined) end = own[i];
  // a service that only reports what its backend answered: its last answer is how the call ended
  if (!end && !entry.started) for (let i = own.length - 1; i >= 0 && !end; i--) if (hasStatus(own[i])) end = own[i];
  const httpStatus = end ? num(end.fields.status) : undefined;
  const outcome = end ? str(end.fields.outcome) : undefined;
  const ownErrors = own.filter((l) => l.level === "error").length;
  const startedMs = own[0]?.ms ?? g.firstMs;
  let status: MigratedStatus;
  if (httpStatus !== undefined) status = httpStatus >= 400 ? "error" : "success";
  else if (outcome) status = GOOD.test(outcome) ? "success" : "error";
  else if (ownErrors > 0) status = "error";
  else if (entry.started && now - g.lastMs < 120_000) status = "running";
  else status = "unknown";
  const took = end ? num(end.fields.durationMs) ?? (own.length === 1 ? num(end.fields.elapsedMs) : undefined) ?? end.ms - startedMs : undefined;
  const finishedMs = end ? end.ms : status === "running" ? undefined : g.lastMs;
  const chain = [entry.key, ...parts.filter((p) => p !== entry).sort((a, b) => a.firstMs - b.firstMs).map((p) => p.key)];
  return {
    id: g.id, correlationId: g.id, kind, api: entry.api, component: entry.component, layer: layer(entry.api), chain,
    operation, startedAt: new Date(startedMs).toISOString(), finishedAt: finishedMs !== undefined ? new Date(finishedMs).toISOString() : undefined,
    durationMs: took !== undefined ? Math.max(0, Math.round(took)) : undefined, serviceMs: took !== undefined ? Math.max(0, Math.round(took)) : undefined,
    status, httpStatus, outcome, errors: g.errors, warnings: g.warnings, trigger: kind === "job" ? str(pick("trigger"))?.toLowerCase() : undefined,
    stepCount: g.lines.length + g.dropped, source: "logs", hiddenSteps: g.dropped, startedMs,
    steps: lines.map((l) => ({ at: new Date(l.ms).toISOString(), offsetMs: Math.max(0, l.ms - startedMs), api: l.api, component: l.component, level: l.level, message: l.message, fields: l.fields })),
  };
}

function fromEvent(e: GatewayEvent, api: ApiInfo): Built {
  const failed = e.kind.startsWith("fault") || e.status >= 400 || e.status === 0;
  return {
    id: `gw:${e.correlationId}`, kind: "call", api: api.name, layer: api.layer, chain: [api.name], operation: undefined,
    route: [e.method, e.resource].filter(Boolean).join(" ") || undefined, startedAt: e.at,
    finishedAt: e.responseLatency !== undefined ? new Date(e.ms + e.responseLatency).toISOString() : undefined, durationMs: e.responseLatency,
    status: failed ? "error" : "success", httpStatus: e.status || undefined, errors: failed ? 1 : 0, warnings: 0, via: "gateway", application: e.application,
    stepCount: 0, source: "gateway", steps: [], hiddenSteps: 0, gateway: { ...e, matchedBy: "record" }, startedMs: e.ms,
  };
}

/** How far a call seen by the gateway and one seen by the service may be apart and still be the same call. */
const SAME_MS = 25, NEAR_MS = 60, FAR_MS = 500, BEFORE_MS = 30, END_MS = 60, LOOKBACK_MS = 90_000;

/**
 * Every execution the two sources know about, newest first. A gateway record and a service trace carry
 * different ids, so they are paired one to one by time: the service starts within milliseconds of the
 * gateway receiving the call, and its duration is what the gateway measured as backend time. A service
 * that writes its first line late (after reading a large request) still ends when the gateway got its answer.
 */
export function buildExecutions(groups: Iterable<TraceGroup>, events: GatewayEvent[], apiList: ApiInfo[], now = Date.now()): MigratedExecution[] {
  const apis = new Map(apiList.map((a) => [a.name, a]));
  const byContext = new Map(apiList.filter((a) => a.context).map((a) => [a.context!, a]));
  const out: Built[] = [];
  const calls = new Map<string, Built[]>();
  for (const g of groups) {
    if (!g.lines.length) continue;
    const x = fromGroup(g, apis, now);
    out.push(x);
    if (x.kind === "call") { const list = calls.get(x.api); if (list) list.push(x); else calls.set(x.api, [x]); }
  }
  const perApi = new Map<string, GatewayEvent[]>();
  let earliest = Infinity;
  for (const e of events) {
    const api = apis.get(e.apiName) ?? (e.context ? byContext.get(e.context) : undefined);
    if (!api) continue; // a flow built here, or an API that is not part of the estate
    if (e.ms < earliest) earliest = e.ms;
    const list = perApi.get(api.name); if (list) list.push(e); else perApi.set(api.name, [e]);
  }
  for (const [name, evs] of perApi) {
    const api = apis.get(name)!;
    const traces = (calls.get(name) || []).sort((a, b) => a.startedMs - b.startedMs);
    const used = new Uint8Array(traces.length);
    evs.sort((a, b) => a.ms - b.ms);
    let lo = 0;
    for (const e of evs) {
      // A trace that started well before the gateway's time can still be this call (see `ends` below).
      while (lo < traces.length && traces[lo].startedMs < e.ms - LOOKBACK_MS) lo++;
      let best = -1, bestScore = Infinity;
      const total = e.responseLatency ?? e.backendLatency;
      const gwEnd = total !== undefined ? e.ms + total : undefined;
      const until = e.ms + Math.max(FAR_MS, total ?? 0);
      for (let i = lo; i < traces.length && traces[i].startedMs <= until; i++) {
        if (used[i]) continue;
        const t = traces[i];
        const lateBy = t.startedMs - e.ms, delta = Math.abs(lateBy);
        const known = t.serviceMs !== undefined && e.backendLatency !== undefined;
        const off = known ? Math.abs(t.serviceMs! - e.backendLatency!) : 0;
        const svcEnd = t.serviceMs !== undefined ? t.startedMs + t.serviceMs : undefined;
        // The strongest sign: the service wrote its last line just before the gateway had the answer.
        const endOff = svcEnd !== undefined && gwEnd !== undefined ? Math.abs(gwEnd - svcEnd) : Infinity;
        const ends = endOff <= END_MS;
        let score: number;
        if (lateBy < -BEFORE_MS) {
          // The gateway sometimes stamps a call after the service has already started on it.
          if (!ends) continue;
          score = endOff;
        } else {
          // The service ran inside the gateway's call, and most of the gateway's time was the service's.
          const slack = svcEnd !== undefined && gwEnd !== undefined ? gwEnd - svcEnd + Math.max(0, lateBy) : Infinity;
          const inside = svcEnd !== undefined && gwEnd !== undefined && svcEnd <= gwEnd + END_MS && slack <= Math.max(250, (total ?? 0) * 0.5);
          const sameStart = delta <= SAME_MS || (delta <= NEAR_MS && (!known || off <= Math.max(250, (e.backendLatency ?? 0) * 0.5)));
          const sameLength = known && delta <= FAR_MS && off <= Math.max(60, (e.backendLatency ?? 0) * 0.1);
          if (!(ends || sameStart || sameLength || inside)) continue;
          score = ends ? Math.min(delta + off, endOff) : delta + off;
        }
        if (score < bestScore) { best = i; bestScore = score; }
      }
      if (best < 0) { out.push(fromEvent(e, api)); continue; }
      used[best] = 1;
      const t = traces[best];
      t.gateway = { ...e, matchedBy: "time" }; t.via = "gateway"; t.source = "both"; t.application = e.application;
      t.route = [e.method, e.resource].filter(Boolean).join(" ") || undefined;
      if (e.responseLatency !== undefined) {
        // Never report less than the service itself spent: then the gateway's time started late.
        t.durationMs = t.serviceMs !== undefined && t.serviceMs > e.responseLatency ? Math.max(t.serviceMs, e.ms + e.responseLatency - t.startedMs) : e.responseLatency;
      }
      if (e.status) { t.httpStatus = e.status; if (e.status >= 400 || e.kind.startsWith("fault")) t.status = "error"; else if (t.status !== "error") t.status = "success"; }
    }
  }
  for (const x of out) {
    if (x.kind !== "call" || x.via) continue;
    const api = apis.get(x.api);
    x.via = !api?.published ? "internal" : earliest <= x.startedMs ? "direct" : "unknown";
  }
  out.sort((a, b) => b.startedMs - a.startedMs);
  return out.map(({ startedMs: _drop, ...x }) => x);
}

export function summaryOf(x: MigratedExecution): MigratedSummary {
  const { steps: _s, hiddenSteps: _h, gateway: _g, correlationId: _c, ...rest } = x;
  return rest;
}

// ---- the gateway's request records (a log file written by the gateway on this server)

const MAX_READ = 16 * 1024 * 1024, MAX_EVENTS = 50_000;

function readFrom(file: string, from: number): { text: string; size: number; ino: number } {
  const fd = openSync(file, "r");
  try {
    const st = fstatSync(fd);
    const start = Math.max(Math.min(from, st.size), st.size - MAX_READ, 0);
    const buf = Buffer.alloc(st.size - start);
    let got = 0;
    while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, start + got); if (n <= 0) break; got += n; }
    return { text: buf.subarray(0, got).toString("utf8"), size: start + got, ino: st.ino };
  } finally { closeSync(fd); }
}

export class GatewayLog {
  private list: GatewayEvent[] = [];
  private seen = new Set<string>();
  private offset = 0; private ino = 0; private rest = ""; private loaded = false;
  error?: string;
  constructor(private file?: string) {}
  get configured(): boolean { return !!this.file; }
  get events(): GatewayEvent[] { return this.list; }

  /** Earlier files of the same log (the gateway renames the file when it rolls over), oldest first. */
  private rolled(): { path: string; ino: number }[] {
    const dir = dirname(this.file!), base = basename(this.file!).replace(/\.log$/, "");
    const out: { path: string; ino: number; at: number }[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(base) || !f.endsWith(".log") || f === basename(this.file!)) continue;
      try { const st = statSync(join(dir, f)); out.push({ path: join(dir, f), ino: st.ino, at: st.mtimeMs }); } catch { /* gone meanwhile */ }
    }
    return out.sort((a, b) => a.at - b.at).slice(-4);
  }
  private take(text: string, partial: boolean): void {
    const all = (partial ? this.rest : "") + text;
    const lines = all.split("\n");
    const tail = lines.pop() ?? "";
    if (partial) this.rest = tail; else if (tail) lines.push(tail);
    for (const line of lines) {
      if (!line.includes("apim:")) continue;
      const e = parseGatewayLine(line);
      if (!e) continue;
      const key = `${e.correlationId}|${e.ms}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key); this.list.push(e);
    }
    if (this.list.length > MAX_EVENTS + 5000) {
      for (const e of this.list.splice(0, this.list.length - MAX_EVENTS)) this.seen.delete(`${e.correlationId}|${e.ms}`);
    }
  }
  refresh(): void {
    if (!this.file) return;
    try {
      if (!this.loaded) { for (const f of this.rolled()) { try { this.take(readFrom(f.path, 0).text, false); } catch { /* skip an unreadable old file */ } } this.loaded = true; }
      const st = statSync(this.file);
      if (this.ino && st.ino !== this.ino) {
        // the file was rolled over since the last read: finish the old one first
        const old = this.rolled().find((f) => f.ino === this.ino);
        if (old) { try { this.take(readFrom(old.path, this.offset).text, true); } catch { /* the remainder is lost */ } }
        this.offset = 0; this.rest = "";
      } else if (st.size < this.offset) { this.offset = 0; this.rest = ""; }
      this.ino = st.ino;
      if (st.size > this.offset) { const r = readFrom(this.file, this.offset); this.offset = r.size; this.take(r.text, true); }
      this.error = undefined;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      this.error = code === "ENOENT" ? "The gateway has not written any request records yet" : "The gateway's request records are not readable on this server";
    }
  }
}

// ---- the feed: keeps what was read, reads only what is new

export interface FeedSource { pod: string; api: string; component?: string; }
export interface FeedOptions {
  k8s: Pick<K8s, "logs">; metricsLog?: string;
  sources: (userToken?: string | null) => Promise<{ apis: ApiInfo[]; pods: FeedSource[]; error?: string }>;
  firstTail?: number; now?: () => number;
}
export interface ListFilter { api?: string; status?: string; kind?: string; via?: string; q?: string; limit?: number; }

const REFRESH_MS = 8000, MAX_TRACES = 20_000;

export class MigratedExecutions {
  private groups = new Map<string, TraceGroup>();
  private cursors = new Map<string, { last?: string; recent: Set<string> }>();
  private gw: GatewayLog;
  private built: MigratedExecution[] = [];
  private byId = new Map<string, MigratedExecution>();
  private apis: ApiInfo[] = [];
  private at = 0; private lines = 0; private pods = 0;
  private inflight?: Promise<void>;
  private logError?: string;
  private podErrors: string[] = [];
  constructor(private o: FeedOptions) { this.gw = new GatewayLog(o.metricsLog); }
  private now(): number { return this.o.now ? this.o.now() : Date.now(); }

  async refresh(userToken?: string | null, force = false): Promise<void> {
    if (!force && this.at && this.now() - this.at < REFRESH_MS) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.load(userToken).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async load(userToken?: string | null): Promise<void> {
    const src = await this.o.sources(userToken);
    this.apis = src.apis; this.logError = src.error; this.pods = src.pods.length;
    const errors: string[] = [];
    await Promise.all(src.pods.map(async (p) => {
      const cur = this.cursors.get(p.pod) ?? { recent: new Set<string>() };
      let fetched: LogLine[];
      try { fetched = await this.o.k8s.logs(p.pod, this.o.firstTail ?? 20_000, cur.last); }
      catch (e) { errors.push(e instanceof Error ? e.message : `Logs of ${p.pod} are not available`); return; }
      const recent = new Set<string>();
      let last = cur.last;
      for (const l of fetched) {
        const key = `${l.at}|${l.text}`;
        if (l.at && (!last || l.at > last)) last = l.at;
        recent.add(key);
        if (cur.recent.has(key)) continue;
        const t = parseTraceLine(l, p.api, p.component);
        if (t) { addLine(this.groups, t); this.lines++; }
      }
      // remember only the lines of the newest moment: the next read starts there and repeats them
      const keep = new Set<string>();
      for (const k of recent) if (last && k.startsWith(last.slice(0, 19))) keep.add(k);
      this.cursors.set(p.pod, { last, recent: keep });
    }));
    for (const pod of [...this.cursors.keys()]) if (!src.pods.some((p) => p.pod === pod)) this.cursors.delete(pod);
    this.podErrors = errors;
    if (this.groups.size > MAX_TRACES + 1000) {
      const old = [...this.groups.values()].sort((a, b) => a.lastMs - b.lastMs).slice(0, this.groups.size - MAX_TRACES);
      for (const g of old) this.groups.delete(g.id);
    }
    this.gw.refresh();
    this.built = buildExecutions(this.groups.values(), this.gw.events, this.apis, this.now());
    this.byId = new Map(this.built.map((x) => [x.id, x]));
    this.at = this.now();
  }

  async list(userToken: string | null | undefined, f: ListFilter = {}) {
    await this.refresh(userToken);
    const perApi = new Map<string, { api: string; total: number; errors: number }>();
    for (const a of this.apis) perApi.set(a.name, { api: a.name, total: 0, errors: 0 });
    for (const x of this.built) { const c = perApi.get(x.api); if (c) { c.total++; if (x.status === "error") c.errors++; } }
    const needle = (f.q || "").trim().toLowerCase();
    const hit = this.built.filter((x) =>
      (!f.api || x.api === f.api || x.chain.includes(f.api)) && (!f.status || x.status === f.status) && (!f.kind || x.kind === f.kind) && (!f.via || x.via === f.via)
      && (!needle || [x.id, x.api, x.operation, x.route, x.application, x.outcome, ...x.chain].some((v) => v && v.toLowerCase().includes(needle))));
    const limit = Math.min(Math.max(f.limit ?? 200, 1), 1000);
    const evs = this.gw.events;
    const oldest = this.built[this.built.length - 1], newest = this.built[0];
    const notes: string[] = [];
    if (this.logError) notes.push(`The services' logs cannot be read right now: ${this.logError}.`);
    else if (this.podErrors.length) notes.push(`The log of ${this.podErrors.length} running part${this.podErrors.length === 1 ? "" : "s"} could not be read; calls through ${this.podErrors.length === 1 ? "it" : "them"} may be missing.`);
    if (!this.gw.configured) notes.push("The gateway's request records are not connected to this server, so only services that write a line per call are listed and the calling application is not known.");
    else if (this.gw.error) notes.push(`${this.gw.error}; the calling application is not known.`);
    return {
      executions: hit.slice(0, limit).map(summaryOf), total: hit.length, recorded: this.built.length,
      failed: this.built.filter((x) => x.status === "error").length,
      apis: [...perApi.values()].sort((a, b) => b.total - a.total || a.api.localeCompare(b.api)),
      window: { from: oldest?.startedAt, to: newest?.startedAt },
      sources: {
        logs: { available: !this.logError, parts: this.pods, lines: this.lines },
        gateway: { configured: this.gw.configured, available: this.gw.configured && !this.gw.error, records: evs.length, from: evs[0]?.at, to: evs[evs.length - 1]?.at },
      },
      notes, generatedAt: new Date(this.at || this.now()).toISOString(),
    };
  }

  async get(userToken: string | null | undefined, id: string): Promise<MigratedExecution | null> {
    await this.refresh(userToken);
    return this.byId.get(id) ?? null;
  }
}
