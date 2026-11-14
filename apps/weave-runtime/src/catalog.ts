// Effective catalog: built-in node types + one node type per custom connector operation,
// plus the starter templates offered by POST /v1/flows { templateId }.
import { BUILTIN_CONNECTION_TYPES, BUILTIN_NODE_TYPES } from "@traceit/weave-flow";
import type { CatalogResponse, ConnectorDef, FieldDef, Flow, FlowEdge, FlowNode, NodeTypeDef } from "@traceit/weave-flow";
import { FUNCTION_DOCS } from "./expr.js";
import { INSTRUCTION_EXAMPLES } from "./mapping/instruction.js";

const BUILTIN = new Map(BUILTIN_NODE_TYPES.map((t) => [t.type, t]));

const CONNECTOR_TAIL: FieldDef[] = [
  { key: "failOnStatus", label: "Treat 4xx/5xx as error", kind: "boolean", group: "Advanced", default: true },
  { key: "output", label: "Output", kind: "select", group: "Result", default: "body", options: [{ value: "body", label: "Response body" }, { value: "full", label: "{ status, headers, body }" }] },
  { key: "timeoutMs", label: "Timeout (ms)", kind: "number", group: "Advanced", default: 30000 },
  { key: "retries", label: "Retries", kind: "number", group: "Advanced", default: 0 },
  { key: "retryDelayMs", label: "Retry delay (ms)", kind: "number", group: "Advanced", default: 500 },
  { key: "resultTarget", label: "Put result in", kind: "select", group: "Result", default: "payload", options: [{ value: "payload", label: "Payload (replace)" }, { value: "variable", label: "A variable (keep payload)" }] },
  { key: "resultVar", label: "Variable name", kind: "text", group: "Result", showIf: { key: "resultTarget", equals: "variable" } },
];
const RESERVED_KEYS = new Set(["connection", ...CONNECTOR_TAIL.map((f) => f.key)]);

export function connectorNodeTypes(c: ConnectorDef): NodeTypeDef[] {
  return (c.operations ?? []).map((op) => {
    const params = (op.params ?? []).filter((p) => !RESERVED_KEYS.has(p.key));
    const defaults: Record<string, unknown> = { failOnStatus: true, output: "body", timeoutMs: 30000, retries: 0, resultTarget: "payload" };
    if (c.defaultConnectionId) defaults.connection = c.defaultConnectionId;
    for (const p of params) if (p.default !== undefined) defaults[p.key] = p.default;
    return {
      type: `connector:${c.id}:${op.id}`, label: op.name || op.id, category: "custom" as const,
      description: op.description || `${op.method} ${op.path}`, icon: c.icon || "Plug", color: "custom", hasInput: true,
      outputs: [{ id: "out", label: "Next" }, { id: "error", label: "On error", kind: "error" as const }],
      fields: [
        { key: "connection", label: "Connection", kind: "connection" as const, connectionType: "http", help: `Supplies the base URL and authentication for ${c.name}.` },
        ...params, ...CONNECTOR_TAIL,
      ],
      defaults,
      docs: `**${c.name}** - \`${op.method} ${op.path}\`. Parameters are available to the operation as \`$params.<name>\`.`,
    };
  });
}
export function nodeTypeDef(type: string, getConnector: (id: string) => ConnectorDef | undefined): NodeTypeDef | undefined {
  const b = BUILTIN.get(type);
  if (b) return b;
  const m = /^connector:([^:]+):(.+)$/.exec(type);
  if (!m) return undefined;
  const c = getConnector(m[1]);
  return c ? connectorNodeTypes(c).find((t) => t.type === type) : undefined;
}

export const TEMPLATES: { id: string; name: string; description: string; build: () => { nodes: FlowNode[]; edges: FlowEdge[] } }[] = [
  { id: "blank-http", name: "Blank HTTP API", description: "One HTTP listener wired to a response. Start here and add steps in between.",
    build: () => graph([
      node("n_in", "trigger.http", "HTTP Listener", 80, 160, { methods: ["GET"], path: "/", summary: "Describe this operation" }),
      node("n_out", "respond", "Respond", 420, 160, { status: "200", body: "$", headers: [] }),
    ], [["n_in", "out", "n_out"]]) },
  { id: "rest-proxy-map", name: "Call a backend and reshape the answer", description: "HTTP listener, one backend call with header forwarding, a field mapping and the response.",
    build: () => graph([
      node("n_in", "trigger.http", "HTTP Listener", 60, 180, { methods: ["GET"], path: "/items/:id", summary: "Get one item" }),
      node("n_call", "http.request", "Call backend", 340, 180, { method: "GET", url: "/items/{{ $request.params.id }}", forwardHeaders: ["authorization"], query: [], headers: [], bodyMode: "none" }),
      node("n_map", "transform.map", "Reshape", 620, 180, { input: "$", mapping: { rules: [], passthrough: true }, resultTarget: "payload" }),
      node("n_out", "respond", "Respond", 900, 180, { status: "200", body: "$", headers: [] }),
      node("n_err", "respond", "Backend failed", 620, 360, { status: "$error.status ? $error.status : 502", body: "{ \"error\": { \"message\": $error.message } }", headers: [] }),
    ], [["n_in", "out", "n_call"], ["n_call", "out", "n_map"], ["n_map", "out", "n_out"], ["n_call", "error", "n_err"]]) },
  { id: "cache-aside", name: "Cache in front of a backend", description: "Look in the cache first; on a miss call the backend, store the answer with a time to live, then respond.",
    build: () => graph([
      node("n_in", "trigger.http", "HTTP Listener", 40, 200, { methods: ["GET"], path: "/items/:id", summary: "Get one item (cached)" }),
      node("n_get", "redis.command", "Cache lookup", 300, 200, { operation: "get", key: "item:{{ $request.params.id }}", json: true, resultTarget: "variable", resultVar: "cached" }),
      node("n_if", "logic.choice", "Cached?", 560, 200, { conditions: [{ id: "hit", label: "Cache hit", expr: "$exists($vars.cached) and $vars.cached != null" }] }),
      node("n_hit", "respond", "Respond from cache", 840, 100, { status: "200", body: "$vars.cached", headers: [{ key: "x-cache", value: "HIT" }] }),
      node("n_call", "http.request", "Call backend", 840, 300, { method: "GET", url: "/items/{{ $request.params.id }}", forwardHeaders: ["authorization"], query: [], headers: [], bodyMode: "none" }),
      node("n_set", "redis.command", "Cache fill", 1100, 300, { operation: "set", key: "item:{{ $request.params.id }}", value: "$", ttlSeconds: 300, json: true, resultTarget: "variable", resultVar: "cacheWrite" }),
      node("n_out", "respond", "Respond", 1360, 300, { status: "200", body: "$", headers: [{ key: "x-cache", value: "MISS" }] }),
    ], [["n_in", "out", "n_get"], ["n_get", "out", "n_if"], ["n_if", "case:hit", "n_hit"], ["n_if", "otherwise", "n_call"], ["n_call", "out", "n_set"], ["n_set", "out", "n_out"]]) },
  { id: "scheduled-job", name: "Scheduled job", description: "Runs on a timer: fetch something, process each item, write a log line.",
    build: () => graph([
      node("n_in", "trigger.schedule", "Every 5 minutes", 60, 180, { mode: "interval", everySeconds: 300, payload: {} }),
      node("n_call", "http.request", "Fetch items", 340, 180, { method: "GET", url: "", query: [], headers: [], bodyMode: "none" }),
      node("n_log", "log", "Log result", 620, 180, { level: "info", message: "Fetched {{ $count($) }} items", includePayload: false }),
    ], [["n_in", "out", "n_call"], ["n_call", "out", "n_log"]]) },
  { id: "sub-flow", name: "Reusable sub-flow", description: "Has a Manual / Sub-flow start so other flows can run it with Call Flow.",
    build: () => graph([
      node("n_in", "trigger.manual", "Start", 80, 160, { samplePayload: {} }),
      node("n_x", "transform.expr", "Compute", 380, 160, { expr: "$", resultTarget: "payload" }),
    ], [["n_in", "out", "n_x"]]) },
];
function node(id: string, type: string, name: string, x: number, y: number, config: Record<string, unknown>): FlowNode {
  return { id, type, name, position: { x, y }, config: { ...(BUILTIN.get(type)?.defaults ?? {}), ...config } };
}
function graph(nodes: FlowNode[], edges: [string, string, string][]): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return { nodes, edges: edges.map(([from, fromPort, to], i) => ({ id: `e_${i + 1}`, from, fromPort, to })) };
}
export function templateGraph(id: string | undefined): Pick<Flow, "nodes" | "edges"> | undefined {
  const t = TEMPLATES.find((x) => x.id === id);
  return t ? JSON.parse(JSON.stringify(t.build())) : undefined;
}

export function buildCatalog(connectors: ConnectorDef[]): CatalogResponse {
  return {
    nodeTypes: [...BUILTIN_NODE_TYPES, ...connectors.flatMap(connectorNodeTypes)],
    connectionTypes: BUILTIN_CONNECTION_TYPES,
    functions: FUNCTION_DOCS,
    instructionExamples: INSTRUCTION_EXAMPLES,
    templates: TEMPLATES.map(({ id, name, description }) => ({ id, name, description })),
  };
}
