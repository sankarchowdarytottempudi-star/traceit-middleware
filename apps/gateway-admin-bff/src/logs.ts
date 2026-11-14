// Log reading: recent lines of one or several APIs, merged across replicas.
// Sources: services (pods in the services namespace), the gateway itself, and Weave flows
// (runtime). Everything is read on demand through the read-only Kubernetes API / the runtime.
import type { K8s, K8sPod } from "./k8s.js";
import type { Runtime } from "./runtime.js";
import { reason } from "./http.js";

export type Level = "ERROR" | "WARN" | "INFO" | "DEBUG" | "";
export interface LogEntry {
  t: number;            // epoch ms (0 when the line carries no usable time)
  source: string;       // source id, e.g. "svc:cms-proc-api", "gw", "flow:fl_123"
  pod: string;          // replica (pod name), or the flow step for flows
  level: Level;
  msg: string;          // the message part, for display
  cid: string;          // correlation id when the line carries one
  text: string;         // the full original line(s), for copy/download
}

const K8S_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s?/;
const LEVEL_WORD = /\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|SEVERE)\b/;
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const CID_NEAR = new RegExp(`(?:correlation[-_ ]?id|x-correlation-id|activityid|activity[-_ ]id|requestid|request[-_ ]id)["'\\s:=\\[]{1,6}(${UUID}|[A-Za-z0-9_.-]{8,64})`, "i");
const CONTINUATION = /^(\s+at\s|\s*Caused by:|\s+\.\.\. \d+ (?:more|common frames)|\t|\s{4,}\S)/;

export function normLevel(v: unknown): Level {
  const s = String(v ?? "").toUpperCase();
  if (s === "ERROR" || s === "FATAL" || s === "SEVERE") return "ERROR";
  if (s === "WARN" || s === "WARNING") return "WARN";
  if (s === "INFO") return "INFO";
  if (s === "DEBUG" || s === "TRACE") return "DEBUG";
  return "";
}

/** key=value / key="quoted value" pairs (Ballerina and logfmt style). */
export function parseLogfmt(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w.-]*)=(?:"((?:[^"\\]|\\.)*)"|(\S*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = m[2] !== undefined ? m[2].replace(/\\(["\\])/g, "$1").replace(/\\n/g, "\n") : m[3];
  return out;
}

/** Parses one physical line as written by `kubectl logs --timestamps`. */
export function parseLine(raw: string, source: string, pod: string): LogEntry {
  let line = raw.replace(/\r$/, ""); let t = 0;
  const ts = K8S_TS.exec(line);
  if (ts) { const p = Date.parse(ts[1].replace(/(\.\d{3})\d+/, "$1")); if (Number.isFinite(p)) t = p; line = line.slice(ts[0].length); }
  let level: Level = ""; let msg = line; let cid = "";
  const trimmed = line.trimStart();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const j = JSON.parse(trimmed);
      if (j && typeof j === "object") {
        level = normLevel(j.level ?? j.severity ?? j.lvl);
        const m = j.message ?? j.msg;
        if (typeof m === "string") {
          const mod = typeof j.module === "string" && j.module ? ` (${j.module})` : "";
          const err = typeof j.error === "string" ? ` · ${j.error}` : j.error && typeof j.error === "object" && typeof j.error.message === "string" ? ` · ${j.error.message}` : "";
          msg = `${m}${err}${mod}`;
        }
        const c = j.correlationId ?? j.correlation_id ?? j["x-correlation-id"] ?? j.traceId;
        if (typeof c === "string") cid = c;
      }
    } catch { /* not JSON after all */ }
  } else if (/^time=\S+\s+level=/.test(trimmed) || /\blevel=\w+\b.*\bmessage=/.test(trimmed)) {
    const f = parseLogfmt(trimmed);
    level = normLevel(f.level);
    if (f.message !== undefined) {
      const rest = Object.entries(f).filter(([k]) => !["time", "level", "message", "module", "correlationId"].includes(k)).map(([k, v]) => `${k}=${/\s/.test(v) ? JSON.stringify(v) : v}`).join(" ");
      msg = `${f.message}${rest ? ` · ${rest}` : ""}${f.module ? ` (${f.module})` : ""}`;
    }
    cid = f.correlationId ?? f.correlation_id ?? "";
  } else {
    const head = trimmed.slice(0, 160);
    const lw = LEVEL_WORD.exec(head);
    if (lw) level = normLevel(lw[1]);
    else if (/^(error|panic|fatal)\b[: ]/i.test(trimmed)) level = "ERROR";
    else if (/^warn(ing)?\b[: ]/i.test(trimmed)) level = "WARN";
    // log4j: "[2026-11-14 12:00:00,123]  INFO {some.Class} - message" -> keep the message part
    const l4 = /^(?:TID: \[[^\]]*\] )?(?:\[[^\]]*\] )*\s*(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+\{([^}]*)\}\s+-\s+(.*)$/.exec(trimmed);
    if (l4) { const cls = l4[1].split(".").pop() ?? ""; msg = `${l4[2]}${cls ? ` (${cls})` : ""}`; }
    else {
      // gateway mediation logs: "[2026-11-14 12:00:00,123]  INFO - LogMediator message"
      const l5 = /^(?:TID: \[[^\]]*\] )?(?:\[[^\]]*\] )+\s*(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+-\s+([A-Za-z_][\w.$]*)\s+(.*)$/.exec(trimmed);
      if (l5) { const cls = l5[1].split(".").pop() ?? ""; msg = `${l5[2]}${cls ? ` (${cls})` : ""}`; }
    }
  }
  if (!cid) { const c = CID_NEAR.exec(line); if (c) cid = c[1]; }
  return { t, source, pod, level, msg, cid, text: line };
}

/** Turns the raw text of one pod's log into entries, folding stack traces into the line they belong to. */
export function parsePodLog(text: string, source: string, pod: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const e = parseLine(raw, source, pod);
    const prev = out[out.length - 1];
    if (prev && CONTINUATION.test(e.text) && e.level === "") {
      if (prev.text.length < 16_000) { prev.text += `\n${e.text}`; prev.msg += `\n${e.text}`; }
      continue;
    }
    if (e.t === 0 && prev) e.t = prev.t;
    out.push(e);
  }
  return out;
}

const RANK: Record<string, number> = { DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4 };
export interface LogFilter { level?: string; q?: string; cid?: string; limit?: number; }

/** Merges per-replica entries into one timeline (oldest first), then applies the filters and keeps the newest `limit`. */
export function mergeLogs(groups: LogEntry[][], f: LogFilter = {}): { lines: LogEntry[]; matched: number; scanned: number } {
  const all: (LogEntry & { _g: number; _i: number })[] = [];
  groups.forEach((g, gi) => g.forEach((e, i) => all.push({ ...e, _g: gi, _i: i })));
  // Stable: by time, then keep each replica's own order.
  all.sort((a, b) => a.t - b.t || a._g - b._g || a._i - b._i);
  const min = RANK[normLevel(f.level)] ?? 0;
  const q = (f.q ?? "").trim().toLowerCase(); const cid = (f.cid ?? "").trim().toLowerCase();
  const kept = all.filter((e) => {
    if (min && (RANK[e.level] ?? (min <= 2 ? 2 : 0)) < min) return false; // lines without a level count as INFO
    if (cid && e.cid.toLowerCase() !== cid && !e.text.toLowerCase().includes(cid)) return false;
    if (q && !e.text.toLowerCase().includes(q) && !e.pod.toLowerCase().includes(q)) return false;
    return true;
  });
  const limit = Math.max(1, Math.min(f.limit ?? 1000, 5000));
  const lines = kept.slice(-limit).map(({ _g, _i, ...e }) => e);
  return { lines, matched: kept.length, scanned: all.length };
}

export interface LogSource { id: string; label: string; kind: "service" | "gateway" | "flow" | "component"; replicas: number; }
export interface LogQuery extends LogFilter { sources: string[]; tail?: number; sinceSeconds?: number; }
export interface LogResult {
  lines: LogEntry[]; matched: number; scanned: number; limit: number;
  sources: { id: string; label: string; replicas: string[]; lines: number; error?: string }[];
  generatedAt: string;
}

export interface LogDeps {
  k8s: K8s | null; runtime: Runtime; servicesNs: string; gatewayNs: string; gatewayPodPrefix: string;
}

export function createLogs(d: LogDeps) {
  const appOf = (p: K8sPod) => p.labels["app.kubernetes.io/name"] ?? p.labels.app ?? "";
  const podsOf = (pods: K8sPod[], name: string) => pods.filter((p) => appOf(p) === name || (!appOf(p) && p.name.startsWith(`${name}-`)));
  const live = (p: K8sPod) => p.phase === "Running" || p.phase === "Pending" || p.phase === "Terminating";

  async function sources(serviceNames: { name: string; kind: "service" | "component" }[]): Promise<{ list: LogSource[]; errors: string[] }> {
    const list: LogSource[] = []; const errors: string[] = [];
    if (d.k8s) {
      try {
        const [svcPods, gwPods] = await Promise.all([d.k8s.pods(d.servicesNs), d.k8s.pods(d.gatewayNs).catch(() => [] as K8sPod[])]);
        const gw = gwPods.filter((p) => p.name.startsWith(d.gatewayPodPrefix) && live(p));
        if (gw.length) list.push({ id: "gw", label: "Gateway", kind: "gateway", replicas: gw.length });
        for (const s of serviceNames) list.push({ id: `svc:${s.name}`, label: s.name, kind: s.kind, replicas: podsOf(svcPods, s.name).filter(live).length });
      } catch (e) { errors.push(`Kubernetes: ${reason(e)}`); }
    } else errors.push("Kubernetes access is not configured");
    const fl = await d.runtime.flows();
    if (fl.ok) for (const f of fl.data) list.push({ id: `flow:${f.id}`, label: f.name || f.slug, kind: "flow", replicas: 1 });
    else if (d.runtime.configured) errors.push(`Flow runtime: ${fl.detail}`);
    return { list, errors };
  }

  async function read(q: LogQuery): Promise<LogResult> {
    const filtered = !!(q.q?.trim() || q.cid?.trim() || q.level);
    const limit = Math.max(10, Math.min(q.tail ?? 500, 5000));
    // When filtering, look further back than what will be shown so matches are not missed.
    const perPod = filtered ? Math.min(Math.max(limit * 4, 2000), 10_000) : limit;
    const since = q.sinceSeconds && q.sinceSeconds > 0 ? Math.floor(q.sinceSeconds) : undefined;
    const ids = [...new Set(q.sources)].slice(0, 20);
    const groups: LogEntry[][] = []; const meta: LogResult["sources"] = [];
    const cache = new Map<string, Promise<K8sPod[]>>();
    const pods = (ns: string) => { let p = cache.get(ns); if (!p) { p = d.k8s!.pods(ns); cache.set(ns, p); } return p; };

    let names: Promise<Map<string, string>> | undefined;
    const flowNames = () => (names ??= d.runtime.flows().then((r) => new Map(r.ok ? r.data.map((f): [string, string] => [f.id, f.name || f.slug]) : [])).catch(() => new Map<string, string>()));

    await Promise.all(ids.map(async (id) => {
      const m: LogResult["sources"][number] = { id, label: id, replicas: [], lines: 0 };
      meta.push(m);
      try {
        if (id.startsWith("flow:")) {
          const fid = id.slice(5); m.label = fid;
          const fl = await flowNames();
          m.label = fl.get(fid) ?? fid;
          const r = await d.runtime.flowLogs(fid, Math.min(perPod, 2000));
          if (!r.ok) { m.error = `Flow runtime: ${r.detail}`; return; }
          const cutoff = since ? Date.now() - since * 1000 : 0;
          const g = r.data.map((l): LogEntry => {
            const t = Date.parse(l.at); const step = l.nodeName ? `[${l.nodeName}] ` : "";
            return { t: Number.isFinite(t) ? t : 0, source: id, pod: l.nodeName ?? "flow", level: normLevel(l.level), msg: `${step}${l.message}`, cid: l.executionId ?? "", text: `${l.at} ${String(l.level).toUpperCase()} ${step}${l.message}${l.executionId ? ` execution=${l.executionId}` : ""}` };
          }).filter((e) => e.t >= cutoff).sort((a, b) => a.t - b.t);
          groups.push(g); m.lines = g.length; m.replicas = ["runtime"];
          return;
        }
        if (!d.k8s) { m.error = "Kubernetes access is not configured"; return; }
        let ns = d.servicesNs; let mine: K8sPod[];
        if (id === "gw") { ns = d.gatewayNs; m.label = "Gateway"; mine = (await pods(ns)).filter((p) => p.name.startsWith(d.gatewayPodPrefix)); }
        else if (id.startsWith("svc:")) { const name = id.slice(4); m.label = name; mine = podsOf(await pods(ns), name); }
        else { m.error = "Unknown source"; return; }
        mine = mine.filter(live);
        if (!mine.length) { m.error = "No running replicas"; return; }
        await Promise.all(mine.map(async (p) => {
          try {
            const container = p.containers.includes("api") ? "api" : p.containers[0];
            const text = await d.k8s!.podLog(ns, p.name, { container, tailLines: perPod, sinceSeconds: since });
            const g = parsePodLog(text, id, p.name);
            groups.push(g); m.lines += g.length; m.replicas.push(p.name);
          } catch (e) { m.error = `${p.name}: ${reason(e)}`; }
        }));
      } catch (e) { m.error = reason(e); }
    }));
    const merged = mergeLogs(groups, { level: q.level, q: q.q, cid: q.cid, limit });
    meta.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    return { ...merged, limit, sources: meta, generatedAt: new Date().toISOString() };
  }
  return { sources, read };
}
export type Logs = ReturnType<typeof createLogs>;
