// What an expression can see at a given step, rebuilt from the last test run. Pure.
import type { Execution, HttpRequestSample, Json, StepTrace } from "@traceit/weave-flow";
import type { ExprContext } from "./api.ts";

export const VARIABLES: { name: string; description: string }[] = [
  { name: "$", description: "The current payload (what the previous step produced). Fields are read directly: customer.name" },
  { name: "$payload", description: "The same payload, by name." },
  { name: "$request", description: "The incoming HTTP request: $request.params, $request.query, $request.headers, $request.body, $request.method, $request.path" },
  { name: "$vars", description: "Variables set earlier in the flow with Set Variables or a step's \"Put result in\"." },
  { name: "$nodes", description: "Output of any earlier step by its name: $nodes.\"Get voyage\".id" },
  { name: "$item", description: "Inside For Each: the current item." },
  { name: "$index", description: "Inside For Each: the position of the current item, starting at 0." },
  { name: "$error", description: "On an error path: the error (message, status, detail)." },
  { name: "$env", description: "Server settings made available to flows." },
];

/** `$nodes.Name` or `$nodes."My step"` */
export function nodeRef(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `$nodes.${name}` : `$nodes."${name.replace(/"/g, '\\"')}"`;
}
/** The steps of the flow as far as their settings matter for rebuilding variables. */
export type GraphConfigs = { id: string; data: { config: Record<string, unknown> } }[];
/** The data available to expressions of `nodeId`, taken from the last run. Null when nothing has run yet.
 *  Traces do not carry the flow variables, so they are rebuilt from the steps that ran before:
 *  Set Variables steps and steps whose result goes to a variable. */
export function contextForNode(run: Execution | null, traces: Record<string, StepTrace[]>, nodeId: string | undefined, sample?: HttpRequestSample | null, graph?: GraphConfigs): ExprContext | null {
  const own = nodeId ? traces[nodeId]?.[0] : undefined;
  if (!run && !own) {
    if (!sample) return null;
    return { payload: (sample.body ?? null) as Json, request: sample, vars: {}, nodes: {} };
  }
  const steps = run?.steps ?? [];
  const nodes: Record<string, Json> = {};
  const vars: Record<string, Json> = {};
  let before: StepTrace | undefined;
  for (const s of steps) {
    if (own && s.seq >= own.seq && s.nodeId !== own.nodeId) continue;
    if (s.nodeId === nodeId) continue;
    if (s.output !== undefined) nodes[s.nodeName] = s.output;
    if (s.status === "success" && s.output !== undefined) {
      if (s.nodeType === "vars.set" && s.output && typeof s.output === "object" && !Array.isArray(s.output)) Object.assign(vars, s.output);
      const c = graph?.find((n) => n.id === s.nodeId)?.data.config;
      if (c && c.resultTarget === "variable" && typeof c.resultVar === "string" && c.resultVar.trim()) vars[c.resultVar.trim()] = s.output;
    }
    before = s;
  }
  const payload = own?.input !== undefined ? own.input : before?.output !== undefined ? before.output : ((run?.request?.body ?? null) as Json);
  const ctx: ExprContext = { payload, vars, nodes };
  const req = run?.request ?? sample ?? undefined;
  if (req) ctx.request = req;
  if (own?.iteration !== undefined) { ctx.item = payload; ctx.index = own.iteration; }
  return ctx;
}
/** Path parameters named in a listener path ("/voyages/:id/cabins/:cabin" -> ["id", "cabin"]). */
export function pathParams(path: string): string[] {
  return Array.from(String(path ?? "").matchAll(/[:{]([A-Za-z_][A-Za-z0-9_]*)\}?/g), (m) => m[1]);
}
/** Fills path parameters into a listener path; missing values keep a readable placeholder. */
export function fillPath(path: string, values: Record<string, string>): string {
  return String(path ?? "/").replace(/:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, a: string, b: string) => {
    const v = values[a ?? b];
    return v !== undefined && v !== "" ? encodeURIComponent(v) : `:${a ?? b}`;
  });
}
export function kvToRecord(rows: { key: string; value: string }[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows ?? []) if (r && typeof r.key === "string" && r.key.trim()) out[r.key.trim()] = String(r.value ?? "");
  return out;
}
export function recordToKv(rec: Record<string, unknown> | undefined | null): { key: string; value: string }[] {
  return Object.entries(rec ?? {}).map(([key, value]) => ({ key, value: typeof value === "string" ? value : JSON.stringify(value) }));
}
/** Joins base path and listener path the way the runtime serves them. */
export function joinUrl(...parts: (string | undefined)[]): string {
  const [first, ...rest] = parts.filter((p): p is string => !!p);
  if (first === undefined) return "";
  return rest.reduce((acc, p) => `${acc.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`, first);
}
