// Flow validation. Errors block deploy; warnings are advice. Nothing here executes the flow.
import type { ConnectorDef, FieldDef, Flow, FlowNode, MappingSpec, NodeTypeDef, ValidationIssue } from "@traceit/weave-flow";
import { Cron } from "croner";
import { checkDeep, checkExpr, checkTemplate } from "./expr.js";
import { nodeTypeDef } from "./catalog.js";
import { parsePath } from "./mapping/apply.js";

export interface ValidateCtx {
  getConnection(id: string): { id: string; name: string; type: string } | undefined;
  getConnector(id: string): ConnectorDef | undefined;
  getFlow(id: string): { id: string; name: string } | undefined;
  /** Contexts on the gateway that belong to somebody else. */
  reservedContexts?: string[];
}
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

function visible(f: FieldDef, cfg: Record<string, unknown>): boolean {
  if (!f.showIf) return true;
  const v = cfg[f.showIf.key];
  if (f.showIf.in) return f.showIf.in.includes(v);
  if ("equals" in f.showIf) return v === f.showIf.equals;
  return true;
}
export function portsOf(def: NodeTypeDef, cfg: Record<string, unknown>): string[] {
  const ports = def.outputs.map((p) => p.id);
  if (def.dynamicPorts) {
    const field = def.fields.find((f) => f.kind === def.dynamicPorts);
    const list = field ? cfg[field.key] : undefined;
    const prefix = def.dynamicPorts === "conditions" ? "case:" : "branch:";
    if (Array.isArray(list)) for (const x of list) if (x && typeof x === "object" && (x as { id?: unknown }).id) ports.push(prefix + String((x as { id: unknown }).id));
  }
  return ports;
}

export function validateMapping(spec: MappingSpec | undefined, nodeId: string | undefined, issues: ValidationIssue[]) {
  const rules = Array.isArray(spec?.rules) ? spec!.rules : [];
  const seen = new Map<string, number>();
  rules.forEach((r, i) => {
    if (!r || r.enabled === false) return;
    const where = `mapping.rules[${i}]`;
    const label = r.target ? `"${r.target}"` : `rule ${i + 1}`;
    const err = (message: string) => issues.push({ level: "error", nodeId, field: where, message });
    const valuesOnly = spec?.shape?.kind === "values" || spec?.shape?.kind === "value";
    if (!valuesOnly && (!r.target || !String(r.target).trim())) err(`Mapping rule ${i + 1} has no target field`);
    else { try { parsePath(r.target); } catch (e) { err((e as Error).message); } seen.set(r.target, (seen.get(r.target) ?? 0) + 1); }
    switch (r.kind) {
      case "direct": if (!r.source || !r.source.trim()) err(`Mapping ${label}: choose the source field to copy`); else { try { parsePath(r.source); } catch (e) { err(`Mapping ${label}: ${(e as Error).message}`); } } break;
      case "expr": { if (!r.expr || !r.expr.trim()) err(`Mapping ${label}: the expression is empty`); else { const bad = checkExpr(r.expr); if (bad) err(`Mapping ${label}: ${bad}. If this is meant as plain words, switch the rule to "In my own words".`); } break; }
      case "const": if (r.value === undefined) issues.push({ level: "warning", nodeId, field: where, message: `Mapping ${label}: the constant has no value` }); break;
      case "instruction": {
        if (!r.instruction || !r.instruction.trim()) err(`Mapping ${label}: describe in your own words what the field should contain`);
        else if (!r.compiled || typeof r.compiled.expr !== "string" || !r.compiled.expr.trim()) err(`Mapping ${label}: "${r.instruction}" was not understood, so the field would be missing. Rephrase it or write an expression.`);
        else { const bad = checkExpr(r.compiled.expr); if (bad) err(`Mapping ${label}: the expression behind "${r.instruction}" is not valid: ${bad}`); }
        break;
      }
      default: err(`Mapping ${label}: unknown rule kind "${String((r as { kind?: unknown }).kind)}"`);
    }
  });
  for (const [t, n] of seen) if (n > 1) issues.push({ level: "warning", nodeId, field: "mapping", message: `Target "${t}" is set by ${n} rules; the last one wins` });
}

function checkField(node: FlowNode, f: FieldDef, v: unknown, ctx: ValidateCtx, issues: ValidationIssue[], flow: Flow) {
  const err = (message: string) => issues.push({ level: "error", nodeId: node.id, field: f.key, message: `${node.name}: ${message}` });
  const exprErr = (e: string | null, what = f.label) => { if (e) err(`${what}: ${e}`); };
  switch (f.kind) {
    case "expr": case "code": if (typeof v === "string") exprErr(checkExpr(v)); else if (typeof v !== "number" && typeof v !== "boolean") err(`${f.label} must be an expression`); break;
    case "template": if (typeof v === "string") exprErr(checkTemplate(v)); break;
    case "json": { let val = v; if (typeof v === "string") { try { val = JSON.parse(v); } catch { val = v; } } exprErr(checkDeep(val)); break; }
    case "keyvalue": {
      if (!Array.isArray(v)) { if (v && typeof v !== "object") err(`${f.label} must be a list of key/value pairs`); break; }
      for (const kv of v as { key?: unknown; value?: unknown }[]) {
        if (!kv || isBlank(kv.key)) continue;
        if (typeof kv.value !== "string") continue;
        // Set Variables holds bare expressions; every other key/value list holds templates.
        exprErr(node.type === "vars.set" && !kv.value.includes("{{") ? checkExpr(kv.value) : checkTemplate(kv.value), `${f.label} "${String(kv.key)}"`);
      }
      break;
    }
    case "conditions": {
      if (!Array.isArray(v)) { err(`${f.label} must be a list`); break; }
      const ids = new Set<string>();
      for (const c of v as { id?: string; label?: string; expr?: string }[]) {
        if (!c || !c.id) { err(`${f.label}: every entry needs an id`); continue; }
        if (ids.has(c.id)) err(`${f.label}: duplicate id "${c.id}"`);
        ids.add(c.id);
        if (isBlank(c.expr)) err(`${f.label}: "${c.label || c.id}" has no condition`); else exprErr(checkExpr(String(c.expr)), `${f.label} "${c.label || c.id}"`);
      }
      break;
    }
    case "branches": {
      if (!Array.isArray(v)) { err(`${f.label} must be a list`); break; }
      const ids = new Set<string>();
      for (const b of v as { id?: string }[]) { if (!b || !b.id) { err(`${f.label}: every branch needs an id`); continue; } if (ids.has(b.id)) err(`${f.label}: duplicate id "${b.id}"`); ids.add(b.id); }
      break;
    }
    case "stringlist":
      if (!Array.isArray(v)) { err(`${f.label} must be a list`); break; }
      if (node.type === "postgres.query" && f.key === "params") (v as unknown[]).forEach((p, i) => { if (typeof p === "string") exprErr(checkExpr(p), `Parameter $${i + 1}`); });
      break;
    case "number": if (typeof v !== "number" && !(typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))) err(`${f.label} must be a number`); break;
    case "select": if (f.options && !f.options.some((o) => o.value === v)) err(`${f.label}: "${String(v)}" is not one of the choices`); break;
    case "multiselect": if (!Array.isArray(v)) err(`${f.label} must be a list`); else if (f.options) for (const x of v) if (!f.options.some((o) => o.value === x)) err(`${f.label}: "${String(x)}" is not one of the choices`); break;
    case "connection": {
      const c = ctx.getConnection(String(v));
      if (!c) err("the connection it uses no longer exists");
      else if (f.connectionType && c.type !== f.connectionType) err(`needs a ${f.connectionType} connection but "${c.name}" is a ${c.type} connection`);
      break;
    }
    case "flow": {
      if (String(v) === flow.id) issues.push({ level: "warning", nodeId: node.id, field: f.key, message: `${node.name}: this flow calls itself` });
      else if (!ctx.getFlow(String(v))) err("the flow it calls no longer exists");
      break;
    }
    case "mapping": validateMapping(v as MappingSpec, node.id, issues); break;
    default: break;
  }
}

export function validateFlow(flow: Flow, ctx: ValidateCtx): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (message: string, nodeId?: string, field?: string) => issues.push({ level: "error", nodeId, field, message });
  const warn = (message: string, nodeId?: string, field?: string) => issues.push({ level: "warning", nodeId, field, message });
  if (!flow || typeof flow !== "object") return [{ level: "error", message: "The flow is empty" }];
  if (!flow.name || !String(flow.name).trim()) err("The flow needs a name", undefined, "name");
  if (flow.slug !== undefined && !SLUG_RE.test(String(flow.slug))) err("The slug may contain lower-case letters, digits and dashes only", undefined, "slug");
  const basePath = flow.settings?.basePath;
  if (!basePath || !/^\/[A-Za-z0-9._~\-/]*$/.test(basePath) || basePath.includes("//")) err("The base path must start with / and contain only letters, digits, dashes and slashes", undefined, "settings.basePath");
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const edges = Array.isArray(flow.edges) ? flow.edges : [];
  const byId = new Map<string, FlowNode>(); const names = new Map<string, number>();
  for (const n of nodes) {
    if (!n || !n.id) { err("A step has no id"); continue; }
    if (byId.has(n.id)) err(`Two steps share the id "${n.id}"`, n.id);
    byId.set(n.id, n);
    if (n.type !== "note") { if (!n.name || !String(n.name).trim()) err("A step has no name", n.id, "name"); else names.set(n.name, (names.get(n.name) ?? 0) + 1); }
  }
  for (const [name, count] of names) if (count > 1) err(`${count} steps are called "${name}"; step names must be unique`, nodes.find((n) => n.name === name)?.id, "name");

  const defs = new Map<string, NodeTypeDef | undefined>();
  const triggers: FlowNode[] = [];
  const routes = new Map<string, string>();
  for (const n of nodes) {
    if (!n?.id) continue;
    const def = nodeTypeDef(n.type, ctx.getConnector);
    defs.set(n.id, def);
    if (!def) { err(`${n.name || n.id}: unknown step type "${n.type}"${n.type.startsWith("connector:") ? " (the custom connector or its operation was removed)" : ""}`, n.id, "type"); continue; }
    if (n.type === "note") continue;
    if (n.type.startsWith("trigger.") && !n.disabled) triggers.push(n);
    const cfg = { ...(def.defaults ?? {}), ...(n.config ?? {}) };
    for (const f of def.fields) {
      if (!visible(f, cfg)) continue;
      const v = cfg[f.key];
      if (isBlank(v)) { if (f.required && !n.disabled) err(`${n.name}: "${f.label}" is required`, n.id, f.key); continue; }
      checkField(n, f, v, ctx, issues, flow);
    }
    if (n.type === "trigger.http") {
      const p = String(cfg.path ?? "");
      if (p && !p.startsWith("/")) err(`${n.name}: the path must start with /`, n.id, "path");
      if (/\s/.test(p)) err(`${n.name}: the path must not contain spaces`, n.id, "path");
      if (!n.disabled) for (const m of Array.isArray(cfg.methods) ? (cfg.methods as string[]) : []) {
        const key = `${String(m).toUpperCase()} ${p.replace(/:[A-Za-z_][\w-]*|\{[^}]+\}/g, ":p").replace(/\/+$/, "") || "/"}`;
        if (routes.has(key)) err(`${n.name}: ${String(m).toUpperCase()} ${p} is already served by "${routes.get(key)}"`, n.id, "path"); else routes.set(key, n.name);
      }
    }
    if (n.type === "trigger.schedule") {
      if (cfg.mode === "cron") { try { new Cron(String(cfg.cron ?? ""), { paused: true }).stop(); } catch (e) { err(`${n.name}: the cron expression is not valid (${(e as Error).message})`, n.id, "cron"); } }
      else if (!(Number(cfg.everySeconds) >= 1)) err(`${n.name}: "Every (seconds)" must be 1 or more`, n.id, "everySeconds");
    }
    if ((n.type === "http.request" || n.type === "graphql.request") && isBlank(cfg.connection)) {
      const u = String(cfg.url ?? "").trim();
      if (u && !/^https?:\/\//i.test(u) && !u.startsWith("{{")) err(`${n.name}: "${u}" is a path, so the step needs a connection that supplies the base URL (or use a full http:// URL)`, n.id, "url");
      if (!u && n.type === "graphql.request") err(`${n.name}: give an endpoint URL or choose a connection`, n.id, "url");
    }
    if (n.type.startsWith("connector:") && isBlank(cfg.connection)) err(`${n.name}: choose the connection that supplies the base URL`, n.id, "connection");
    if (n.type === "redis.command" && (cfg.operation === "set" || cfg.operation === "expire") && cfg.operation === "expire" && !(Number(cfg.ttlSeconds) > 0)) err(`${n.name}: EXPIRE needs a TTL`, n.id, "ttlSeconds");
  }
  if (triggers.length === 0) err("The flow has no trigger. Add an HTTP Listener, a Schedule or a Manual start.");

  const incoming = new Map<string, number>(); const outgoing = new Map<string, string[]>(); const edgeIds = new Set<string>();
  for (const e of edges) {
    if (!e || !e.from || !e.to) { err("A connection between steps is incomplete"); continue; }
    if (e.id && edgeIds.has(e.id)) err(`Two connections share the id "${e.id}"`); if (e.id) edgeIds.add(e.id);
    const from = byId.get(e.from), to = byId.get(e.to);
    if (!from || !to) { err("A connection points at a step that no longer exists"); continue; }
    const fd = defs.get(from.id), td = defs.get(to.id);
    if (fd) { const ports = portsOf(fd, { ...(fd.defaults ?? {}), ...(from.config ?? {}) }); if (!ports.includes(e.fromPort || "out")) err(`${from.name}: there is no output "${e.fromPort}" (a branch or condition was removed)`, from.id); }
    if (td && !td.hasInput) err(`${to.name}: this step cannot have an incoming connection`, to.id);
    incoming.set(to.id, (incoming.get(to.id) ?? 0) + 1);
    const l = outgoing.get(from.id); if (l) l.push(to.id); else outgoing.set(from.id, [to.id]);
  }
  // Reachability from any trigger.
  const reached = new Set<string>(); const stack = triggers.map((t) => t.id);
  while (stack.length) { const id = stack.pop()!; if (reached.has(id)) continue; reached.add(id); for (const t of outgoing.get(id) ?? []) stack.push(t); }
  for (const n of nodes) {
    if (!n?.id || n.type === "note" || n.type.startsWith("trigger.")) continue;
    if (!reached.has(n.id)) warn(`${n.name}: nothing leads to this step, so it never runs`, n.id);
  }
  for (const t of triggers) if (!(outgoing.get(t.id) ?? []).length) warn(`${t.name}: nothing is connected after this trigger`, t.id);

  const gw = flow.settings?.gateway;
  if (gw?.publish) {
    const context = String(gw.context || "/" + flow.slug);
    if (!/^\/[A-Za-z0-9._\-/]+$/.test(context)) err("The gateway context must start with / and contain only letters, digits, dashes and slashes", undefined, "settings.gateway.context");
    if ((ctx.reservedContexts ?? []).some((r) => r.toLowerCase() === context.toLowerCase())) err(`The gateway context ${context} already belongs to another API on the gateway; choose a different one`, undefined, "settings.gateway.context");
    if (gw.version !== undefined && gw.version !== "" && !/^[A-Za-z0-9._-]+$/.test(String(gw.version))) err("The gateway version may contain letters, digits, dots and dashes only", undefined, "settings.gateway.version");
    if (!nodes.some((n) => n.type === "trigger.http" && !n.disabled)) warn("Publishing on the gateway needs at least one HTTP Listener; nothing will be published");
    if (gw.security === "none") warn("Gateway security is off: anyone who can reach the gateway can call this API");
  }
  return issues;
}
