// Entry points of a migrated service that are not HTTP operations (a timer, a queue or topic
// listener) and the chain of old sub-flows behind every entry, added to the read-only estate
// flow. Built from the migration tool's item-by-item map of the old application (flow names,
// what each one calls, its conditions and error handlers, where it lives in the new code and
// whether it was found) and from the service's switches. Never a settings value or a host.
import type { Flow, FlowEdge, FlowNode } from "@traceit/weave-flow";
import type { StartState } from "./starts.js";

export interface ParityCall { what: string; found?: boolean | null; where?: string }
export interface ParityFlow {
  name: string; kind?: string; file?: string; trigger?: string; uses?: string[];
  status?: "complete" | "gaps" | "dead" | string; note?: string; missing?: string[];
  calls?: ParityCall[]; fields?: { name: string; found?: boolean; where?: string }[];
  conditions?: { value: string; found?: boolean }[]; errors?: (string | { type?: string; how?: string; handled?: boolean })[];
  discarded?: { name: string; why?: string }[];
}
export interface ParityMap { ok?: boolean; flows?: ParityFlow[] }

const DX = 280, DY = 150;
/** No host, address or mailbox ever reaches the page. */
export const scrub = (s: unknown): string => String(s ?? "")
  .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"',)]+/gi, "<address>")
  .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+/g, "<mailbox>")
  .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>");
const short = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

export type EntryKind = "timer" | "queue" | "topic" | "file" | "other";
export function entryKind(trigger: string | undefined): EntryKind | "http" | null {
  const t = (trigger || "").toLowerCase();
  if (!t) return null;
  if (t.startsWith("http")) return "http";
  if (t.includes("scheduler") || t.includes("poll") || t.includes("cron")) return "timer";
  if (t.includes("kafka") || t.includes("topic")) return "topic";
  if (t.includes("jms") || t.includes("mq") || t.includes("amqp") || t.includes("vm ") || t.includes("queue") || t.includes("listener")) return "queue";
  if (t.includes("file") || t.includes("ftp") || t.includes("s3")) return "file";
  return "other";
}

const statusWords = (f: ParityFlow): string => f.status === "complete" ? "found in the new code" : f.status === "dead" ? "unused in the old app"
  : f.status === "gaps" ? `not complete: ${(f.missing || []).slice(0, 4).map(scrub).join(", ")}${(f.missing || []).length > 4 ? " …" : ""}` : "not checked";
const errorWords = (e: ParityFlow["errors"] extends (infer X)[] | undefined ? X : never): string => typeof e === "string" ? scrub(e)
  : `${e?.type && e.type !== "ANY" ? e.type : "Any error"} → ${e?.how === "propagate" ? "passed on" : "continue"}${e?.handled === false ? " (not handled in the new service)" : ""}`;
/** Where the old flow lives in the new code: the first location the map found for one of its items. */
export function whereOf(f: ParityFlow): string | undefined {
  const w = [...(f.calls || []), ...(f.fields || [])].map((x) => x.where).find((x) => typeof x === "string" && x);
  return w ? scrub(w).replace(/^.*?(?=services\/)/, "") : undefined;
}
/** Seconds of a timer from what the service logged at start-up ("ON, every 60.0s …"). */
export function intervalOf(said: string | undefined): number | undefined {
  const m = /every\s+([\d.]+)\s*s/i.exec(said || "");
  return m ? Math.round(Number(m[1])) : undefined;
}

/** Adds one trigger row per non-HTTP entry, with the tree of old sub-flows behind it. HTTP entries
 *  already come from the code; their old sub-flows are attached as a tree under their trigger when
 *  the map can tell which operation they belong to (by the operation path in the trigger). */
export function appendEntries(flow: Flow, map: ParityMap | null | undefined, starts: StartState[]): Flow {
  const flows = (map?.flows || []).filter((f) => f && f.name);
  if (!flows.length) return flow;
  const byName = new Map(flows.map((f) => [f.name, f]));
  const nodes: FlowNode[] = [...flow.nodes], edges: FlowEdge[] = [...flow.edges];
  const names = new Set(nodes.map((n) => n.name));
  let seq = 0, row = Math.max(0, ...nodes.map((n) => n.position.y / DY)) + 1.5;
  const unique = (base: string) => { let n = short(base, 60), i = 2; while (names.has(n)) n = `${short(base, 56)} (${i++})`; names.add(n); return n; };
  const id = () => `e_${(++seq).toString(36).padStart(3, "0")}`;
  const node = (type: string, name: string, x: number, y: number, config: Record<string, unknown>, notes?: string): FlowNode => {
    const n: FlowNode = { id: id(), type, name: unique(name), position: { x, y: Math.round(y * DY) }, config };
    if (notes) n.notes = notes;
    nodes.push(n); return n;
  };
  const link = (from: string, to: string) => edges.push({ id: `ee_${edges.length + 1}`, from, fromPort: "out", to });

  const subNode = (f: ParityFlow, depth: number, x: number, y: number): FlowNode => {
    const calls = (f.calls || []).map((c) => `${scrub(c.what)}${c.found === false ? " (missing)" : ""}`);
    const conds = (f.conditions || []).map((c) => scrub(c.value));
    const errs = (f.errors || []).map(errorWords);
    const where = whereOf(f);
    const notes = [
      `Old ${f.kind || "flow"} ${f.name}${f.file ? ` (${scrub(f.file)})` : ""}: ${statusWords(f)}.`,
      where ? `In the new code: ${where}` : "",
      calls.length ? `Calls: ${calls.slice(0, 8).join("; ")}${calls.length > 8 ? ` and ${calls.length - 8} more` : ""}` : "",
      conds.length ? `Conditions: ${conds.slice(0, 6).join("; ")}` : "",
      errs.length ? `Errors: ${errs.slice(0, 4).join("; ")}` : "",
      f.note ? scrub(f.note) : "",
    ].filter(Boolean).join("\n");
    return node("flow.call", f.name, x, y, {
      flow: f.name, entry: "manual", input: "$",
      __subflow: { name: f.name, kind: f.kind || "sub-flow", status: f.status || "unknown", where, calls, conditions: conds, errors: errs },
      __depth: depth,
    }, notes);
  };

  /** The tree of sub-flows under `parent`, depth-first, each flow once per entry (no loops). */
  const tree = (f: ParityFlow, parent: FlowNode, depth: number, seen: Set<string>): number => {
    let y = parent.position.y / DY, rows = 0;
    for (const u of f.uses || []) {
      const child = byName.get(u);
      if (!child || seen.has(u)) continue;
      seen.add(u);
      const n = subNode(child, depth, DX * depth, y + rows);
      link(parent.id, n.id);
      rows += Math.max(1, tree(child, n, depth + 1, seen));
    }
    return rows;
  };

  for (const f of flows) {
    const kind = entryKind(f.trigger);
    if (!kind || kind === "http") continue;
    const st = starts.find((s) => s.name === f.name) || (starts.length === 1 ? starts[0] : undefined);
    const on = st ? (st.live === "on" ? "switched on and running" : st.live === "not-started" ? `switched on, not started: ${scrub(st.why || "")}` : st.on === false || st.live === "off" ? "switched off" : st.on ? "switched on" : "state not known") : "state not known";
    const every = intervalOf(st?.said);
    const label = kind === "timer" ? `Timer: ${f.name}` : kind === "topic" ? `Topic: ${f.name}` : kind === "file" ? `File: ${f.name}` : kind === "queue" ? `Queue: ${f.name}` : `Starts by itself: ${f.name}`;
    const trig = kind === "timer"
      ? node("trigger.schedule", label, 0, row, { mode: "interval", everySeconds: every ?? 0, payload: {}, __entry: { kind, flow: f.name, state: on, everySeconds: every ?? null, switch: st?.switch ?? null } },
        [`${every ? `Every ${every} s` : "Runs on a timer"}, ${on}.`, `Old flow ${f.name}: ${statusWords(f)}.`, whereOf(f) ? `In the new code: ${whereOf(f)}` : ""].filter(Boolean).join("\n"))
      : node("trigger.manual", label, 0, row, { samplePayload: {}, __entry: { kind, flow: f.name, state: on, switch: st?.switch ?? null } },
        [`${kind === "queue" ? "Starts from a message queue" : kind === "topic" ? "Starts from a topic" : "Starts by itself"}, ${on}.`, `Old flow ${f.name}: ${statusWords(f)}.`].join("\n"));
    const rows = tree(f, trig, 1, new Set([f.name]));
    row += Math.max(1, rows) + 1;
  }
  const extra = nodes.length - flow.nodes.length;
  return extra ? { ...flow, nodes, edges, description: `${flow.description || ""} Entry points that start by themselves and the old sub-flows behind them are shown from the item-by-item map.`.trim() } : flow;
}
