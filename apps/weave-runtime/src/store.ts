// File store under DATA_DIR. Everything is plain JSON, written atomically (temp file + rename),
// cached in memory and re-read at start, so flows, versions, connections, deployments and
// execution history survive restarts and redeploys.
//
//   flows/<flowId>.json                 current flow
//   versions/<flowId>/<revision>.json   snapshot written on every save
//   deployments/<flowId>.json           live deployment record (does not bump the revision)
//   connections/<id>.json               config + AES-256-GCM encrypted secrets
//   connectors/<id>.json                custom connector definitions
//   executions/<flowId>/<execId>.json   bounded history per flow
//   logs/<flowId>.jsonl                 flow log lines (rotated)
//   metrics/<yyyy-mm-dd>.jsonl          one line per live execution (stats)
//   state/<name>.json                   small internal state (gateway client, test app keys)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ConnectorDef, Execution, ExecutionSummary, Flow, FlowDeployment, FlowVersion, LogLine } from "@traceit/weave-flow";

export interface StoredConnection {
  id: string; name: string; type: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;      // field -> encrypted value
  createdAt: string; updatedAt: string;
}
export interface MetricPoint { t: number; flowId: string; ms: number; ok: boolean; }

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
export const execId = () => `ex_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return undefined; }
}
export function writeAtomic(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const safe = (id: string) => { if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error("invalid id"); return id; };

export function summarize(e: Execution): ExecutionSummary {
  const { steps, logs: _l, request: _rq, response, ...rest } = e;
  return { ...rest, stepCount: steps?.length ?? 0, responseStatus: response?.status };
}

export class Store {
  private flows = new Map<string, Flow>();
  private deployments = new Map<string, FlowDeployment>();
  private connections = new Map<string, StoredConnection>();
  private connectors = new Map<string, ConnectorDef>();
  private execIndex = new Map<string, ExecutionSummary[]>();   // flowId -> oldest..newest
  private execFlow = new Map<string, string>();                // execId -> flowId
  private running = new Map<string, Execution>();
  private metrics: MetricPoint[] = [];
  readonly maxVersions = 100;
  readonly metricDays = 14;

  constructor(readonly dir: string, readonly execHistoryPerFlow = 200) {
    for (const d of ["flows", "versions", "deployments", "connections", "connectors", "executions", "logs", "metrics", "state"]) {
      fs.mkdirSync(path.join(dir, d), { recursive: true });
    }
    this.load();
  }
  private p(...parts: string[]) { return path.join(this.dir, ...parts); }
  private loadDir<T>(sub: string, into: Map<string, T>) {
    for (const f of fs.readdirSync(this.p(sub))) {
      if (!f.endsWith(".json")) continue;
      const v = readJson<T>(this.p(sub, f));
      if (v) into.set(f.slice(0, -5), v);
    }
  }
  private load() {
    this.loadDir("flows", this.flows);
    this.loadDir("deployments", this.deployments);
    this.loadDir("connections", this.connections);
    this.loadDir("connectors", this.connectors);
    for (const flowId of fs.readdirSync(this.p("executions"))) {
      const dir = this.p("executions", flowId);
      if (!fs.statSync(dir).isDirectory()) continue;
      const list: ExecutionSummary[] = [];
      for (const f of fs.readdirSync(dir).sort()) {
        if (!f.endsWith(".json")) continue;
        const e = readJson<Execution>(path.join(dir, f));
        if (e) { list.push(summarize(e)); this.execFlow.set(e.id, flowId); }
      }
      list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      this.execIndex.set(flowId, list);
    }
    const cutoff = Date.now() - this.metricDays * 86400_000;
    for (const f of fs.readdirSync(this.p("metrics")).sort()) {
      if (!f.endsWith(".jsonl")) continue;
      if (Date.parse(f.slice(0, 10) + "T23:59:59Z") < cutoff) { try { fs.unlinkSync(this.p("metrics", f)); } catch { /* ignore */ } continue; }
      for (const line of fs.readFileSync(this.p("metrics", f), "utf8").split("\n")) {
        if (!line) continue;
        try { const [t, flowId, ms, ok] = JSON.parse(line); this.metrics.push({ t, flowId, ms, ok: !!ok }); } catch { /* skip */ }
      }
    }
  }

  // ------------------------------------------------------------------ flows
  listFlows(): Flow[] { return [...this.flows.values()].map((f) => this.withDeployment(f)); }
  getFlow(id: string): Flow | undefined { const f = this.flows.get(id); return f ? this.withDeployment(f) : undefined; }
  private withDeployment(f: Flow): Flow { return { ...f, deployment: this.deployments.get(f.id) ?? null }; }
  /** Writes the flow and a version snapshot. The caller sets revision/updatedAt. */
  saveFlow(flow: Flow, meta: { note?: string } = {}): Flow {
    const { deployment: _d, readOnly: _r, ...clean } = flow;
    const stored = clean as Flow;
    writeAtomic(this.p("flows", `${safe(stored.id)}.json`), JSON.stringify(stored, null, 1));
    writeAtomic(this.p("versions", safe(stored.id), `${stored.revision}.json`),
      JSON.stringify({ flow: stored, savedAt: stored.updatedAt, savedBy: stored.updatedBy, note: meta.note }));
    this.flows.set(stored.id, stored);
    this.pruneVersions(stored.id);
    return this.withDeployment(stored);
  }
  deleteFlow(id: string) {
    safe(id);
    this.flows.delete(id); this.deployments.delete(id);
    for (const f of [this.p("flows", `${id}.json`), this.p("deployments", `${id}.json`), this.p("logs", `${id}.jsonl`), this.p("logs", `${id}.jsonl.1`)]) { try { fs.unlinkSync(f); } catch { /* absent */ } }
    fs.rmSync(this.p("versions", id), { recursive: true, force: true });
    this.clearExecutions(id);
  }
  listVersions(id: string): FlowVersion[] {
    const dir = this.p("versions", safe(id));
    if (!fs.existsSync(dir)) return [];
    const live = this.deployments.get(id);
    const out: FlowVersion[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const v = readJson<{ flow: Flow; savedAt: string; savedBy?: string; note?: string }>(path.join(dir, f));
      if (!v) continue;
      out.push({ revision: v.flow.revision, savedAt: v.savedAt, savedBy: v.savedBy, note: v.note, deployed: !!live && live.status === "deployed" && live.revision === v.flow.revision });
    }
    return out.sort((a, b) => b.revision - a.revision);
  }
  getVersion(id: string, revision: number): Flow | undefined {
    if (!Number.isInteger(revision)) return undefined;
    return readJson<{ flow: Flow }>(this.p("versions", safe(id), `${revision}.json`))?.flow;
  }
  private pruneVersions(id: string) {
    const dir = this.p("versions", id);
    const revs = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => Number(f.slice(0, -5))).filter(Number.isFinite).sort((a, b) => a - b);
    const keep = this.deployments.get(id)?.revision;
    while (revs.length > this.maxVersions) {
      const r = revs.shift()!;
      if (r === keep) continue;
      try { fs.unlinkSync(path.join(dir, `${r}.json`)); } catch { /* ignore */ }
    }
  }

  // ------------------------------------------------------------------ deployments
  getDeployment(id: string) { return this.deployments.get(id); }
  setDeployment(id: string, dep: FlowDeployment | null) {
    if (dep) { this.deployments.set(id, dep); writeAtomic(this.p("deployments", `${safe(id)}.json`), JSON.stringify(dep, null, 1)); }
    else { this.deployments.delete(id); try { fs.unlinkSync(this.p("deployments", `${safe(id)}.json`)); } catch { /* absent */ } }
  }

  // ------------------------------------------------------------------ connections & connectors
  listConnections(): StoredConnection[] { return [...this.connections.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  getConnection(id: string) { return this.connections.get(id); }
  saveConnection(c: StoredConnection) { writeAtomic(this.p("connections", `${safe(c.id)}.json`), JSON.stringify(c, null, 1)); this.connections.set(c.id, c); }
  deleteConnection(id: string) { this.connections.delete(id); try { fs.unlinkSync(this.p("connections", `${safe(id)}.json`)); } catch { /* absent */ } }
  listConnectors(): ConnectorDef[] { return [...this.connectors.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  getConnector(id: string) { return this.connectors.get(id); }
  saveConnector(c: ConnectorDef) { writeAtomic(this.p("connectors", `${safe(c.id)}.json`), JSON.stringify(c, null, 1)); this.connectors.set(c.id, c); }
  deleteConnector(id: string) { this.connectors.delete(id); try { fs.unlinkSync(this.p("connectors", `${safe(id)}.json`)); } catch { /* absent */ } }

  // ------------------------------------------------------------------ executions
  trackRunning(e: Execution) { this.running.set(e.id, e); }
  addExecution(e: Execution) {
    this.running.delete(e.id);
    const dir = this.p("executions", safe(e.flowId));
    try {
      writeAtomic(path.join(dir, `${safe(e.id)}.json`), JSON.stringify(e));
    } catch { return; }
    const list = this.execIndex.get(e.flowId) ?? [];
    list.push(summarize(e)); this.execFlow.set(e.id, e.flowId);
    while (list.length > this.execHistoryPerFlow) {
      const old = list.shift()!;
      this.execFlow.delete(old.id);
      try { fs.unlinkSync(path.join(dir, `${old.id}.json`)); } catch { /* ignore */ }
    }
    this.execIndex.set(e.flowId, list);
  }
  getExecution(id: string): Execution | undefined {
    const run = this.running.get(id); if (run) return run;
    const flowId = this.execFlow.get(id); if (!flowId) return undefined;
    return readJson<Execution>(this.p("executions", flowId, `${safe(id)}.json`));
  }
  listExecutions(q: { flowId?: string; status?: string; mode?: string; limit?: number; before?: string }): ExecutionSummary[] {
    let all: ExecutionSummary[] = [];
    if (q.flowId) all = [...(this.execIndex.get(q.flowId) ?? [])];
    else for (const l of this.execIndex.values()) all.push(...l);
    for (const r of this.running.values()) if (!q.flowId || r.flowId === q.flowId) all.push(summarize(r));
    let before = q.before;
    if (before && this.execFlow.has(before)) before = all.find((e) => e.id === q.before)?.startedAt ?? before;
    all = all.filter((e) => (!q.status || e.status === q.status) && (!q.mode || e.mode === q.mode) && (!before || e.startedAt < before));
    all.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    return all.slice(0, Math.min(Math.max(q.limit ?? 50, 1), 500));
  }
  lastExecution(flowId: string): ExecutionSummary | undefined { const l = this.execIndex.get(flowId); return l && l.length ? l[l.length - 1] : undefined; }
  clearExecutions(flowId: string) {
    for (const e of this.execIndex.get(flowId) ?? []) this.execFlow.delete(e.id);
    this.execIndex.delete(flowId);
    fs.rmSync(this.p("executions", safe(flowId)), { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ logs
  appendLog(line: LogLine) {
    const file = this.p("logs", `${safe(line.flowId)}.jsonl`);
    try {
      fs.appendFileSync(file, JSON.stringify(line) + "\n");
      if (Math.random() < 0.02 && fs.statSync(file).size > 2_000_000) fs.renameSync(file, file + ".1");
    } catch { /* logging must never break a run */ }
  }
  readLogs(flowId: string, limit = 200, level?: string): LogLine[] {
    const out: LogLine[] = [];
    const rank: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    const min = level ? rank[level] ?? 0 : 0;
    for (const f of [this.p("logs", `${safe(flowId)}.jsonl.1`), this.p("logs", `${safe(flowId)}.jsonl`)]) {
      let text = ""; try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
      for (const l of text.split("\n")) { if (!l) continue; try { const j = JSON.parse(l) as LogLine; if ((rank[j.level] ?? 1) >= min) out.push(j); } catch { /* skip */ } }
    }
    return out.slice(-Math.min(Math.max(limit, 1), 2000)).reverse();
  }

  // ------------------------------------------------------------------ metrics
  addMetric(m: MetricPoint) {
    this.metrics.push(m);
    if (this.metrics.length > 300_000) this.metrics.splice(0, 50_000);
    try { fs.appendFileSync(this.p("metrics", `${new Date(m.t).toISOString().slice(0, 10)}.jsonl`), JSON.stringify([m.t, m.flowId, m.ms, m.ok ? 1 : 0]) + "\n"); } catch { /* ignore */ }
  }
  metricsSince(t: number): MetricPoint[] { return this.metrics.filter((m) => m.t >= t); }

  // ------------------------------------------------------------------ small state
  getState<T>(name: string): T | undefined { return readJson<T>(this.p("state", `${safe(name)}.json`)); }
  setState(name: string, value: unknown) { writeAtomic(this.p("state", `${safe(name)}.json`), JSON.stringify(value)); }
}
