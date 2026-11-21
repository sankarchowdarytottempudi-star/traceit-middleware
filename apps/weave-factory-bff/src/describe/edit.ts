// "Change in your own words": /api/factory/describe/edit{,/apply,/undo,/model}. The words are read on THIS
// server by the fixed rules in @traceit/weave-flow (editFlow) against the saved flow; mapping words go to
// the flow engine's interpreter; the changed flow is checked by the flow engine's validator (before and
// after, so only new problems are flagged) plus the Zoho lesson checks. Apply reads the words again here
// (the browser's copy is never trusted) and saves a NEW revision with the words as its note; Undo
// restores the previous revision (and the previous connection settings). A deployed flow keeps running
// its deployed revision until it is deployed again. Secrets are never read, sent or shown.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { EDIT_PHRASES, editFlow, scopeOf, type EditResult, type EditTarget, type Flow, type FullConnection, type ValidationIssue } from "@traceit/weave-flow";
import { compileWithFallback, runtimeRequest, type StudioConfig } from "../studio.js";
import { askModel, describeContext, isLocalModelUrl, loadDescribeConfig, type DescribeConfig } from "./routes.js";

export const MAX_EDIT_TEXT = 4000;
export const MAX_EDIT_LINES = 40;
type Send = typeof runtimeRequest;
const parse = (t: string): unknown => { try { return JSON.parse(t); } catch { return null; } };

export interface EditPreview {
  engine: "rules" | "local-model";
  target: EditTarget; targetLabel: string;
  flowId?: string; baseRevision?: number; deployedRevision?: number | null;
  lines: EditResult["lines"]; changes: EditResult["changes"]; diagnoses: EditResult["diagnoses"];
  lessonWarnings: EditResult["lessonWarnings"]; missing: EditResult["missing"];
  connection?: EditResult["connection"];
  flow?: Flow;                                    // the changed flow (for the preview canvas)
  issues: (ValidationIssue & { new?: boolean })[] | null; validationError?: string;
  ok: boolean; modelText?: string;
}

function checkBody(body: unknown): { text: string; target: EditTarget; flowId?: string; baseRevision?: number } | { error: string } {
  const b = (body ?? {}) as { text?: unknown; target?: unknown; flowId?: unknown; baseRevision?: unknown };
  if (typeof b.text !== "string" || !b.text.trim()) return { error: "Write the change first, one change per line." };
  if (b.text.length > MAX_EDIT_TEXT || b.text.split("\n").length > MAX_EDIT_LINES) return { error: `Write at most ${MAX_EDIT_LINES} lines for one change. Larger changes are easier as several steps.` };
  const t = b.target as { kind?: unknown; nodeId?: unknown; connectionId?: unknown } | undefined;
  const target: EditTarget | null = t?.kind === "flow" ? { kind: "flow" } : t?.kind === "node" && typeof t.nodeId === "string" ? { kind: "node", nodeId: t.nodeId } : t?.kind === "connection" && typeof t.connectionId === "string" ? { kind: "connection", connectionId: t.connectionId } : null;
  if (!target) return { error: "Choose what to change: a step, the flow, or a connection." };
  const flowId = typeof b.flowId === "string" && /^[\w.-]{1,80}$/.test(b.flowId) ? b.flowId : undefined;
  if (target.kind !== "connection" && !flowId) return { error: "Open the flow to change first." };
  return { text: b.text, target, flowId, baseRevision: typeof b.baseRevision === "number" ? b.baseRevision : undefined };
}

async function loadFlow(cfg: StudioConfig, user: string, id: string, send: Send): Promise<Flow | null> {
  const r = await send(cfg, "GET", `/v1/flows/${encodeURIComponent(id)}`, undefined, user, 20_000);
  return r.status < 300 ? (parse(r.text) as Flow) : null;
}
async function fullConnections(cfg: StudioConfig, user: string, send: Send): Promise<FullConnection[]> {
  try {
    const r = await send(cfg, "GET", "/v1/connections", undefined, user, 20_000);
    const list = (parse(r.text) as { connections?: { id: string; name: string; type: string; config?: Record<string, unknown> }[] } | null)?.connections ?? [];
    return list.map((c) => ({ id: c.id, name: c.name, type: c.type, config: { ...(c.config ?? {}) } }));     // config holds no secrets (write-only)
  } catch { return []; }
}
async function validate(cfg: StudioConfig, user: string, flow: Flow, send: Send): Promise<ValidationIssue[] | null> {
  try { const r = await send(cfg, "POST", "/v1/flows/validate", { flow }, user, 30_000); const j = parse(r.text) as { issues?: ValidationIssue[] } | null; return r.status < 300 && Array.isArray(j?.issues) ? j!.issues! : null; } catch { return null; }
}
/** An empty flow stands in when only a connection is changed. */
const NO_FLOW: Flow = { id: "none", name: "none", slug: "none", nodes: [], edges: [], settings: { basePath: "/none/v1", gateway: { publish: false, security: "oauth2" } }, revision: 0, createdAt: "", updatedAt: "" };

/** Reads the change and checks it (nothing is saved). */
export async function editPreview(cfg: StudioConfig, user: string, input: { text: string; target: EditTarget; flowId?: string }, send: Send = runtimeRequest): Promise<EditPreview | { status: number; title: string }> {
  const flow = input.flowId ? await loadFlow(cfg, user, input.flowId, send) : NO_FLOW;
  if (!flow) return { status: 404, title: "This flow was not found. Reload the page." };
  if (flow.readOnly) return { status: 409, title: "This flow is read-only (a view of a migrated service). Make an editable copy first." };
  const conns = await fullConnections(cfg, user, send);
  if (input.target.kind === "connection" && !conns.some((c) => c.id === (input.target as { connectionId: string }).connectionId)) return { status: 404, title: "This connection was not found." };
  if (input.target.kind === "node" && !flow.nodes.some((n) => n.id === (input.target as { nodeId: string }).nodeId)) return { status: 409, title: "The selected step is no longer in the saved flow. Save the flow and select it again." };
  const { ctx } = await describeContext(cfg, user, input.text, undefined, null, "127.0.0.1", send);
  const r = editFlow(flow, input.target, input.text, { ...ctx, fullConnections: conns });
  // mapping words: the flow engine's interpreter first (with the Factory's rules as fallback); guesses are refused
  for (const ins of r.instructions) {
    const node = r.flow.nodes.find((n) => n.id === ins.nodeId);
    const spec = node?.config.mapping as { rules: { id: string; target: string; compiled?: unknown }[]; sampleSource?: unknown } | undefined;
    const rule = spec?.rules.find((x) => x.id === ins.ruleId);
    const line = r.lines.find((l) => l.line === ins.line);
    if (!rule || !line) continue;
    let a: Record<string, unknown> | null = null;
    try { const res = await compileWithFallback(cfg, { instruction: ins.instruction, target: rule.target, ...(spec?.sampleSource !== undefined ? { sampleSource: spec.sampleSource } : {}) }, user); a = res.status < 300 ? parse(res.text) as Record<string, unknown> : null; } catch { a = null; }
    const c = a?.compiled as { expr?: unknown; explanation?: unknown; confidence?: unknown } | null | undefined;
    if (c && typeof c.expr === "string" && c.expr.trim() && c.confidence !== "guessed") { rule.compiled = c; line.understood = `${rule.target} = ${String(c.explanation ?? c.expr)} (${c.expr})`; }
    else { line.status = "not-understood"; line.message = `"${ins.instruction}" was not understood by the mapping phrases${typeof a?.reason === "string" ? `: ${a.reason}` : ""}.`; line.suggestions = (Array.isArray(a?.suggestions) ? (a!.suggestions as string[]) : []).slice(0, 3).map((s) => ({ phrase: `map ${rule.target} from ${s}`, example: `map ${rule.target} from ${s}` })); r.ok = false; }
  }
  let issues: EditPreview["issues"] = null, validationError: string | undefined;
  if (input.target.kind !== "connection" || r.changes.some((c) => c.kind !== "connection")) {
    const [before, after] = await Promise.all([validate(cfg, user, flow, send), validate(cfg, user, r.flow, send)]);
    if (after) { const was = new Set((before ?? []).map((i) => `${i.level}|${i.nodeId ?? ""}|${i.message}`)); issues = after.map((i) => ({ ...i, new: !was.has(`${i.level}|${i.nodeId ?? ""}|${i.message}`) })); }
    else validationError = "The flow engine could not check the changed flow just now.";
  } else issues = [];
  const node = input.target.kind === "node" ? flow.nodes.find((n) => n.id === (input.target as { nodeId: string }).nodeId) : undefined;
  const conn = input.target.kind === "connection" ? conns.find((c) => c.id === (input.target as { connectionId: string }).connectionId) : undefined;
  return {
    engine: "rules", target: input.target, targetLabel: node ? node.name : conn ? `Connection ${conn.name}` : flow.name,
    ...(input.flowId ? { flowId: flow.id, baseRevision: flow.revision, deployedRevision: flow.deployment?.status === "deployed" ? flow.deployment.revision : null } : {}),
    lines: r.lines, changes: r.changes, diagnoses: r.diagnoses, lessonWarnings: r.lessonWarnings, missing: r.missing,
    ...(r.connection ? { connection: r.connection } : {}), ...(input.flowId ? { flow: r.flow } : {}),
    issues, ...(validationError ? { validationError } : {}),
    ok: r.ok && r.changes.length > 0 && (issues ?? []).every((i) => !(i.new && i.level === "error")),
  };
}

export function registerEdit(app: FastifyInstance, cfg: StudioConfig, userOf: (req: FastifyRequest) => Promise<string | null>, dc: DescribeConfig = loadDescribeConfig(), send: Send = runtimeRequest) {
  const problem = (reply: any, status: number, title: string, detail?: string) => reply.code(status).type("application/problem+json").send({ type: "about:blank", title, status, ...(detail ? { detail } : {}) });
  const begin = async (req: FastifyRequest, reply: any) => {
    const user = await userOf(req);
    if (!user) { problem(reply, 401, "Not signed in"); return null; }
    const b = checkBody(req.body);
    if ("error" in b) { problem(reply, 400, b.error); return null; }
    if (!cfg.runtimeUrl || !cfg.internalKey) { problem(reply, 503, "Weave runtime is not configured"); return null; }
    return { user, b };
  };

  app.get("/api/factory/describe/edit/phrases", async (req, reply) => {
    if (!(await userOf(req))) return problem(reply, 401, "Not signed in");
    return { phrases: EDIT_PHRASES, model: { enabled: dc.modelEnabled, configured: dc.modelEnabled && !!dc.modelUrl } };
  });

  app.post("/api/factory/describe/edit", async (req, reply) => {
    const s = await begin(req, reply); if (!s) return;
    const p = await editPreview(cfg, s.user, s.b, send);
    if ("status" in p) return problem(reply, p.status, p.title);
    return p;
  });

  app.post("/api/factory/describe/edit/apply", async (req, reply) => {
    const s = await begin(req, reply); if (!s) return;
    const p = await editPreview(cfg, s.user, s.b, send);
    if ("status" in p) return problem(reply, p.status, p.title);
    if (!p.ok) return problem(reply, 409, "The change cannot be applied yet", p.lines.some((l) => l.status === "not-understood") ? "Change or remove the lines marked Not understood." : p.changes.length ? "The changed flow has new problems that stop it; see the preview." : "Nothing would change.");
    if (s.b.flowId && s.b.baseRevision !== undefined && p.baseRevision !== s.b.baseRevision) return problem(reply, 409, "The flow was saved by someone else in the meantime", `It is now at revision ${p.baseRevision}. Read the change again.`);
    const note = `In your own words (${p.targetLabel}): ${s.b.text.trim().replace(/\s+/g, " ")}`.slice(0, 300);
    let connectionBefore: Record<string, unknown> | undefined;
    if (p.connection) {
      // only the settings that are not secret are sent; stored secrets are kept by the flow engine
      const r = await send(cfg, "PUT", `/v1/connections/${encodeURIComponent(p.connection.id)}`, { name: p.connection.name, type: "http", config: p.connection.after }, s.user, 20_000);
      if (r.status >= 300) return problem(reply, r.status, "The connection could not be changed", (parse(r.text) as { title?: string } | null)?.title);
      connectionBefore = p.connection.before;
    }
    let flow: Flow | undefined;
    if (s.b.flowId && p.flow && p.changes.some((c) => c.kind !== "connection")) {
      const r = await send(cfg, "PUT", `/v1/flows/${encodeURIComponent(s.b.flowId)}`, { ...p.flow, revision: p.baseRevision, changeNote: note }, s.user, 30_000);
      if (r.status >= 300) {
        if (p.connection && connectionBefore) await send(cfg, "PUT", `/v1/connections/${encodeURIComponent(p.connection.id)}`, { name: p.connection.name, type: "http", config: connectionBefore }, s.user, 20_000).catch(() => null);
        return problem(reply, r.status, "The flow could not be saved", (parse(r.text) as { title?: string; detail?: string } | null)?.detail ?? (parse(r.text) as { title?: string } | null)?.title);
      }
      flow = parse(r.text) as Flow;
    }
    return {
      applied: true, note, ...(flow ? { flow, previousRevision: p.baseRevision } : {}),
      ...(p.connection ? { connection: { id: p.connection.id, name: p.connection.name, before: connectionBefore } } : {}),
      deployedRevision: p.deployedRevision ?? null,
    };
  });

  app.post("/api/factory/describe/edit/undo", async (req, reply) => {
    const user = await userOf(req);
    if (!user) return problem(reply, 401, "Not signed in");
    const b = (req.body ?? {}) as { flowId?: unknown; revision?: unknown; connection?: { id?: unknown; name?: unknown; before?: unknown } };
    let flow: Flow | undefined;
    if (typeof b.flowId === "string" && typeof b.revision === "number") {
      const r = await send(cfg, "POST", `/v1/flows/${encodeURIComponent(b.flowId)}/versions/${b.revision}/restore`, {}, user, 30_000);
      if (r.status >= 300) return problem(reply, r.status, "The previous version could not be restored", (parse(r.text) as { title?: string } | null)?.title);
      flow = parse(r.text) as Flow;
    }
    if (b.connection && typeof b.connection.id === "string" && b.connection.before && typeof b.connection.before === "object") {
      const r = await send(cfg, "PUT", `/v1/connections/${encodeURIComponent(b.connection.id)}`, { name: String(b.connection.name ?? ""), type: "http", config: b.connection.before }, user, 20_000);
      if (r.status >= 300) return problem(reply, r.status, "The previous connection settings could not be restored");
    }
    return { undone: true, ...(flow ? { flow } : {}) };
  });

  app.post("/api/factory/describe/edit/model", async (req, reply) => {
    const s = await begin(req, reply); if (!s) return;
    if (!dc.modelEnabled) return problem(reply, 404, "Drafting with the local model is switched off on this server");
    if (!dc.modelUrl) return problem(reply, 503, "The local model is not configured", "Set CHANGE_MODEL_URL to the self-hosted model's address to use it.");
    if (!isLocalModelUrl(dc.modelUrl)) return problem(reply, 503, "The local model address is not on this network");
    const flow = s.b.flowId ? await loadFlow(cfg, s.user, s.b.flowId, send) : NO_FLOW;
    const node = s.b.target.kind === "node" ? flow?.nodes.find((n) => n.id === (s.b.target as { nodeId: string }).nodeId) : undefined;
    const scope = s.b.target.kind === "connection" ? "connection" : scopeOf(node);
    const phrases = EDIT_PHRASES.filter((p) => p.scope === scope || p.scope === "any" || p.scope === "issue").map((p) => `- ${p.phrase}   e.g. ${p.example}`).join("\n");
    const system = `You turn a change request for one item of an integration flow into change lines. The item is ${node ? `the step "${node.name}" (${node.type})` : scope === "connection" ? "a connection" : "the whole flow"}. Answer ONLY with change lines, one per line, no explanations, using these phrasings:\n${phrases}`;
    const m = await askModel(dc, s.b.text, {}, fetch, { system, user: s.b.text });
    if (!m.ok) return problem(reply, m.status, m.title, m.detail);
    const p = await editPreview(cfg, s.user, { ...s.b, text: m.lines }, send);
    if ("status" in p) return problem(reply, p.status, p.title);
    return { ...p, engine: "local-model", modelText: m.lines };
  });
}
