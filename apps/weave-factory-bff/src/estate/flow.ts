// Renders the model of a migrated API as a contract Flow: one row per operation, a trigger,
// the downstream calls in the order the source makes them, mappings, branches, loops and the
// response. Every node carries the source it was derived from in config.__source.
import type { Flow, FlowEdge, FlowNode, MappingRule } from "@traceit/weave-flow";
import type { ApiModel, CallModel, MappingModel, OperationModel } from "./model.js";
import { redact } from "./model.js";
import type { Step } from "./walk.js";
import type { Src } from "./bal.js";

export interface FlowOptions {
  /** Name of another estate API a connector points at (so the call is drawn as a call to that API). */
  apiOf: (connector: string) => string | undefined;
  gateway?: { published: boolean; context?: string; version?: string };
  operation?: string;
  /** An editable copy: no flow-to-flow references, connection ids filled in. */
  editable?: boolean;
  connections?: Record<string, string>;
  basePath?: string;
  name?: string;
}

const DX = 280, DY = 150, ROW_GAP = 60;
const short = (s: string, n = 48) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const words = (s: string) => s.replace(/Client$|Store$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
const REDIS_OPS: Record<string, string> = {
  get: "get", mget: "get", set: "set", setex: "set", psetex: "set", setnx: "set", del: "del", exists: "exists", expire: "expire", pexpire: "expire",
  incr: "incr", incrby: "incr", hget: "hget", hmget: "hget", hset: "hset", hmset: "hset", hgetall: "hgetall", keys: "keys", scan: "keys",
};

/** `/a/{id}` -> `/a/:id` for trigger paths. */
export const triggerPath = (p: string) => p.replace(/\{(\w+)\*?\}/g, ":$1") || "/";

/** Path or key written in the source, as a runtime template. Path parameters of the operation become
 *  `{{ $request.params.x }}`; anything else that is only known at run time stays as `{name}`. */
export function toTemplate(text: string, op: OperationModel): string {
  const params = new Set(op.params.filter((p) => p.in === "path").map((p) => p.name));
  const query = new Set(op.params.filter((p) => p.in === "query").map((p) => p.name));
  return text.replace(/\{([^{}]+)\}/g, (all, name: string) => {
    const n = name.trim();
    if (params.has(n)) return `{{ $request.params.${n} }}`;
    if (query.has(n)) return `{{ $request.query.${n} }}`;
    return all;
  });
}

/** Mapping fields as contract rules. Simple field paths become direct rules, literals constants;
 *  anything else is kept as a disabled rule with the original expression in its comment. */
export function mappingRules(m: MappingModel | undefined): MappingRule[] {
  const rules: MappingRule[] = [];
  let i = 0;
  for (const f of m?.fields || []) {
    const id = `r${++i}`;
    const src = f.source.trim();
    if (!src) { rules.push({ id, target: f.target, kind: "expr", expr: "", enabled: false, comment: "Source not recoverable from the code" }); continue; }
    if (/^"(?:[^"\\]|\\.)*"$/.test(src)) { let v = src.slice(1, -1); try { v = JSON.parse(src) as string; } catch { /* keep */ } rules.push({ id, target: f.target, kind: "const", value: v }); continue; }
    if (/^-?\d+(\.\d+)?$/.test(src)) { rules.push({ id, target: f.target, kind: "const", value: Number(src) }); continue; }
    if (src === "true" || src === "false") { rules.push({ id, target: f.target, kind: "const", value: src === "true" }); continue; }
    const path = /^(?:payload|input|body|request|req|source|data|in)\.([A-Za-z_][\w.]*)$/.exec(src);
    if (path) { rules.push({ id, target: f.target, kind: "direct", source: path[1], comment: `From the source: ${src}` }); continue; }
    rules.push({ id, target: f.target, kind: "expr", expr: "", enabled: false, comment: `Original: ${src}` });
  }
  return rules;
}

interface Tail { id: string; port: string; }
interface Placed { tails: Tail[]; maxX: number; rows: number; }

export function buildFlow(api: ApiModel, o: FlowOptions): Flow {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const names = new Set<string>();
  const mappingById = new Map(api.mappings.map((m) => [m.id, m]));
  const connectorByName = new Map(api.connectors.filter((c) => !c.component).map((c) => [c.name, c]));
  let seq = 0;

  const unique = (base: string) => { let n = short(base, 60), i = 2; while (names.has(n)) n = `${short(base, 56)} (${i++})`; names.add(n); return n; };
  const src = (s: Src | undefined) => (s ? { file: s.file, line: s.line, endLine: s.endLine, code: redact(s.code) } : undefined);
  const add = (type: string, name: string, x: number, row: number, config: Record<string, unknown>, source?: Src, notes?: string): FlowNode => {
    const node: FlowNode = { id: `n_${(++seq).toString(36).padStart(3, "0")}`, type, name: unique(name), position: { x, y: Math.round(row * DY) }, config: { ...config, __source: src(source) } };
    if (notes) node.notes = notes;
    nodes.push(node);
    return node;
  };
  const link = (from: Tail[], to: FlowNode) => { for (const t of from) edges.push({ id: `e_${edges.length + 1}`, from: t.id, fromPort: t.port, to: to.id }); };

  const callNode = (c: CallModel, op: OperationModel, s: Extract<Step, { kind: "call" }>, x: number, row: number, notes: string[]): FlowNode => {
    const conn = connectorByName.get(c.connector);
    const target = o.apiOf(c.connector);
    const connection = o.connections?.[c.connector] ?? "";
    const label = target || words(c.connector) || c.connector;
    const base = { __connector: c.connector, __target: conn?.target };
    const path = c.path ? toTemplate(c.path, op) : "";
    if (/\{[^{]/.test(path.replace(/\{\{[^}]*\}\}/g, ""))) notes.push(`Part of the address is worked out at run time in the original service (${path}).`);
    if (c.kind === "redis") {
      const opName = REDIS_OPS[c.op.toLowerCase()];
      if (!opName) notes.push(`Original command: ${c.op} (shown as the nearest supported command).`);
      const ttl = c.op.toLowerCase() === "setex" ? s.args[2]?.value ?? s.args[2]?.text : undefined;
      return add("redis.command", `Cache ${c.op}: ${short(c.path || "key", 34)}`, x, row, {
        ...base, connection, operation: opName || "get", key: path || "", field: "", value: "$", ttlSeconds: ttl && /^\d+$/.test(ttl) ? Number(ttl) : undefined,
        json: true, resultTarget: "variable", resultVar: "cached",
      }, c.src, notes.join("\n") || undefined);
    }
    if (c.kind === "postgres") {
      return add("postgres.query", `Database ${c.op}`, x, row, { ...base, connection, sql: c.body || "", params: [], resultMode: "rows" }, c.src, notes.join("\n") || undefined);
    }
    const method = c.method && /^[A-Z]+$/.test(c.method) ? c.method : "POST";
    if (c.mapping) notes.push(`Request built by ${mappingById.get(c.mapping)?.name || c.mapping}.`);
    if (target && !o.editable) {
      return add("flow.call", `Call ${target}: ${method} ${short(lastSegments(path), 30)}`, x, row, {
        ...base, flow: `estate:${target}`, entry: "http", input: "$", request: { method, path, forwardHeaders: c.forwarded }, __api: target,
      }, c.src, notes.join("\n") || undefined);
    }
    const headers = c.headers.filter((h) => !c.forwarded.includes(h) && !/^content-type$/i.test(h) && !h.startsWith("(")).map((h) => ({ key: h, value: /correlation/i.test(h) ? "{{ $env.executionId }}" : "" }));
    const gql = c.kind === "graphql" ? mappingById.get(c.mapping || "") : undefined;
    const doc = gql ? queryText(gql.code) : "";
    if (c.kind === "graphql" && (doc || !o.editable)) {
      if (!doc) notes.push("The GraphQL document comes from the incoming request and is passed through.");
      return add("graphql.request", `GraphQL ${label}: ${short(lastSegments(path) || "/", 28)}`, x, row, {
        ...base, connection, url: path, query: doc, variables: {}, operationName: "", headers, forwardHeaders: c.forwarded.filter((h) => !h.startsWith("(")), failOnErrors: true, output: "data",
      }, c.src, notes.join("\n") || undefined);
    }
    const hasBody = !!c.body && method !== "GET" && method !== "HEAD";
    return add("http.request", `${method} ${label}: ${short(lastSegments(path) || "/", 30)}`, x, row, {
      ...base, connection, method, url: path || "/", query: [], headers, forwardHeaders: c.forwarded.filter((h) => !h.startsWith("(")),
      bodyMode: hasBody ? "payload" : "none", body: "$", bodyRaw: "", contentType: "application/json", failOnStatus: true, responseMode: "auto", output: "body",
      timeoutMs: 30000, retries: 0, retryDelayMs: 500, resultTarget: "payload", resultVar: "",
    }, c.src, notes.join("\n") || undefined);
  };

  function place(steps: Step[], op: OperationModel, calls: CallModel[], x0: number, row0: number, entry: Tail[], end: boolean): Placed {
    let x = x0, tails = entry, rows = 1, maxX = x0 - DX;
    let pending: string[] = [];
    const guardNote = (r: Extract<Step, { kind: "respond" }>) => `Answers ${r.status}${r.when ? ` when ${short(r.when, 90)}` : ""}${r.message ? `: ${r.message}` : ""}`;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const last = i === steps.length - 1;
      if (!tails.length) break;
      if (s.kind === "respond") {
        if (!s.guard && last) {
          const n = add("respond", s.status === 501 ? "Not migrated yet" : `Respond ${s.status}`, x, row0, {
            status: String(s.status), body: s.message ? JSON.stringify({ message: s.message }) : "$", headers: [], contentType: "application/json",
          }, s.src, [...pending, s.message || ""].filter(Boolean).join("\n") || undefined);
          pending = [];
          link(tails, n); tails = []; maxX = Math.max(maxX, x); x += DX;
        } else pending.push(guardNote(s));
        continue;
      }
      if (s.kind === "map") {
        const next = steps[i + 1];
        if (next && next.kind === "respond") continue;               // the body of that response
        if (next && next.kind === "call" && next.body?.mapping === s.mapping) continue; // noted on the call
        const m = mappingById.get(s.mapping);
        const n = add("transform.map", `Map: ${words(m?.name || s.mapping)}`, x, row0, { input: "$", mapping: { rules: mappingRules(m), passthrough: false }, __mapping: s.mapping }, s.src,
          [...pending, m?.summary || "", "Rules marked off could not be converted automatically; the original expression is in each rule's comment."].filter(Boolean).join("\n"));
        pending = [];
        link(tails, n); tails = [{ id: n.id, port: "out" }]; maxX = Math.max(maxX, x); x += DX;
        continue;
      }
      if (s.kind === "call") {
        const c = calls.find((k) => k.src.line === s.src.line && k.src.file === s.src.file && k.connector === s.client && k.op === s.op) || calls[0];
        if (!c) continue;
        const n = callNode(c, op, s, x, row0, pending);
        pending = [];
        link(tails, n); tails = [{ id: n.id, port: "out" }]; maxX = Math.max(maxX, x); x += DX;
        continue;
      }
      if (s.kind === "if" && s.thenReturns && !s.else.length && s.then.every((t) => t.kind === "map" || t.kind === "respond")) {
        // a check that only answers with an error is a note on the step it guards, not a branch
        const r = s.then.find((t): t is Extract<Step, { kind: "respond" }> => t.kind === "respond");
        pending.push(r ? guardNote({ ...r, when: r.when || s.cond }) : `Stops when ${short(s.cond, 90)}`);
        continue;
      }
      if (s.kind === "if") {
        const n = add("logic.choice", `Check: ${short(s.cond, 40)}`, x, row0, { conditions: [{ id: "yes", label: short(s.cond, 60), expr: "" }], __condition: s.cond }, s.src,
          [...pending, `Original condition: ${s.cond}`, "The condition is shown as written; it has no expression yet in an editable copy."].join("\n"));
        pending = [];
        link(tails, n); maxX = Math.max(maxX, x);
        const then = place(s.then, op, calls, x + DX, row0, [{ id: n.id, port: "case:yes" }], end && last);
        const thenTails = s.thenReturns ? [] : then.tails;
        let elseTails: Tail[] = [{ id: n.id, port: "otherwise" }];
        let used = then.rows;
        if (s.else.length) {
          const els = place(s.else, op, calls, x + DX, row0 + then.rows, elseTails, end && last);
          elseTails = s.elseReturns ? [] : els.tails;
          used += els.rows; maxX = Math.max(maxX, els.maxX);
        }
        if (s.thenReturns && then.tails.length) closeRow(then.tails, then.maxX + DX, row0);
        rows = Math.max(rows, used); maxX = Math.max(maxX, then.maxX);
        tails = [...thenTails, ...elseTails];
        x = maxX + DX;
        continue;
      }
      if (s.kind === "match") {
        const cases = s.cases.filter((c) => c.steps.length);
        const n = add("logic.choice", `Route by ${short(s.subject, 36)}`, x, row0, {
          conditions: cases.map((c, k) => ({ id: `c${k + 1}`, label: short(c.label.replace(/^"|"$/g, ""), 40), expr: "" })), __condition: s.subject,
        }, s.src, [...pending, `Chooses a path by the value of ${s.subject}.`].join("\n"));
        pending = [];
        link(tails, n); maxX = Math.max(maxX, x);
        let used = 0; const out: Tail[] = [];
        cases.forEach((c, k) => {
          const p = place(c.steps, op, calls, x + DX, row0 + used, [{ id: n.id, port: `case:c${k + 1}` }], false);
          used += p.rows; maxX = Math.max(maxX, p.maxX); out.push(...p.tails);
        });
        rows = Math.max(rows, used || 1);
        tails = [...out, { id: n.id, port: "otherwise" }];
        x = maxX + DX;
        continue;
      }
      if (s.kind === "loop") {
        const item = /foreach\s+[\w:<>[\]?|]+\s+'?(\w+)\s+in\s+(.+)$/.exec(s.header);
        const n = add("logic.foreach", item ? `For each ${words(item[1])}` : "Repeat", x, row0, { items: "$", concurrency: 1, collect: true, __loop: s.header }, s.src,
          [...pending, `Original loop: ${s.header}`].join("\n"));
        pending = [];
        link(tails, n); maxX = Math.max(maxX, x);
        const body = place(s.steps, op, calls, x + DX, row0 + 1, [{ id: n.id, port: "each" }], false);
        rows = Math.max(rows, 1 + body.rows); maxX = Math.max(maxX, body.maxX);
        tails = [{ id: n.id, port: "done" }];
        x = maxX + DX;
        continue;
      }
      if (s.kind === "async") {
        const n = add("logic.parallel", `In the background: ${words(s.fn)}`, x, row0, { branches: [{ id: "bg", label: "In the background" }], __async: s.fn }, s.src,
          [...pending, "The original service starts this work and answers without waiting for it."].join("\n"));
        pending = [];
        link(tails, n); maxX = Math.max(maxX, x);
        const body = place(s.steps, op, calls, x + DX, row0 + 1, [{ id: n.id, port: "branch:bg" }], false);
        rows = Math.max(rows, 1 + body.rows); maxX = Math.max(maxX, body.maxX);
        tails = [{ id: n.id, port: "done" }];
        x = maxX + DX;
        continue;
      }
    }
    if (pending.length) {
      const lastNode = tails.length ? nodes.find((n) => n.id === tails[0].id) : nodes[nodes.length - 1];
      if (lastNode) lastNode.notes = [lastNode.notes || "", ...pending].filter(Boolean).join("\n");
    }
    return { tails, maxX, rows };
  }
  function closeRow(tails: Tail[], x: number, row: number): void {
    const n = add("respond", "Send response", x, row, { status: "200", body: "$", headers: [], contentType: "application/json" });
    link(tails, n);
  }

  const ops = o.operation ? api.operations.filter((p) => p.id === o.operation) : api.operations;
  let row = 0;
  for (const op of ops) {
    const base = api.basePaths[0] || "";
    const rel = op.fullPath.startsWith(base) && base ? op.fullPath.slice(base.length) || "/" : op.fullPath;
    const trigger = add("trigger.http", `${op.method} ${rel}`, 0, row, {
      methods: [op.method === "ANY" ? "GET" : op.method], path: triggerPath(rel), summary: op.summary || "", sampleRequest: undefined, __operation: op.id, __implemented: op.implemented,
    }, { file: op.file, line: op.line, endLine: op.endLine, code: op.code },
    [op.implemented ? "" : "Not migrated yet: this operation answers 501.", op.headersForwarded.length ? `Passes on headers: ${op.headersForwarded.join(", ")}` : "", op.features.length ? `Uses: ${op.features.join(", ")}` : ""].filter(Boolean).join("\n") || undefined);
    const p = place(op.steps, op, op.calls, DX, row, [{ id: trigger.id, port: "out" }], true);
    let width = p.maxX;
    if (p.tails.length) {
      const stub = !op.implemented;
      const n = add("respond", stub ? "Not migrated yet" : "Send response", Math.max(p.maxX, 0) + DX, row, { status: stub ? "501" : "200", body: "$", headers: [], contentType: "application/json" });
      link(p.tails, n); width = n.position.x;
    }
    void width;
    row += p.rows + ROW_GAP / DY;
  }

  const now = new Date().toISOString();
  const slug = api.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  for (const n of nodes) n.position.y = Math.round(n.position.y);
  return {
    id: `estate:${api.name}`, name: o.name || api.name, slug,
    description: `Read from the deployed ${api.technology} service ${api.name}: ${api.operations.length} operation${api.operations.length === 1 ? "" : "s"}, ${api.connectors.length} connector${api.connectors.length === 1 ? "" : "s"}.`,
    tags: ["migrated", api.technology.toLowerCase()],
    nodes, edges,
    settings: {
      basePath: o.basePath || api.basePaths[0] || `/${slug}`,
      gateway: { publish: !!o.gateway?.published, context: o.gateway?.context, version: o.gateway?.version || "v1", security: "oauth2" },
    },
    origin: { kind: "migrated", ref: api.name },
    revision: 1, createdAt: now, updatedAt: now,
    readOnly: !o.editable,
  };
}

function lastSegments(path: string): string {
  const clean = path.replace(/^https?:\/\/[^/]+/, "");
  const parts = clean.split("/").filter(Boolean);
  return parts.length > 2 ? "/" + parts.slice(-2).join("/") : clean;
}
/** The first GraphQL document written in a mapping function, if any. */
function queryText(code: string): string {
  for (const m of code.matchAll(/`([^`]*)`|"((?:[^"\\\n]|\\.)*)"/g)) {
    const t = (m[1] ?? m[2] ?? "").trim();
    if (/^(query|mutation)\b[^{]*\{/.test(t) || /^\{\s*\w+\s*(\([^)]*\))?\s*\{/.test(t)) return t.replace(/\$\{\s*([^}]+?)\s*\}/g, "{{ $1 }}");
  }
  return "";
}
