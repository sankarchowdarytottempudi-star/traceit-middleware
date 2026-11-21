// "Describe the flow": /api/factory/describe/*. The text is read on THIS server by the fixed rules in
// @traceit/weave-flow (describeFlow); mapping words go to the flow engine's own interpreter (with the
// rules in studioWords.ts as the fallback); the draft is checked by the flow engine's validator. Nothing
// is saved here: the browser creates the flow (as a draft, never deployed) only after the user accepts.
// The optional "Draft with the local model" asks the SELF-HOSTED model (CHANGE_MODEL_URL) to rewrite free
// text as the same step lines, which then go through the very same reader, validator and preview. It is
// off unless DESCRIBE_MODEL_ENABLED is set, and it never calls anything outside this server.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { describeFlow, looksLikeDocument, readDocument, MAPPING_PHRASES, STEP_PHRASES, type DocumentInfo, type DescribeApi, type DescribeContext, type DescribeResult, type ConnectorDef, type ValidationIssue } from "@traceit/weave-flow";
import { compileWithFallback, runtimeRequest, type StudioConfig } from "../studio.js";
import { compileWords } from "../studioWords.js";
import { sidOf } from "../auth.js";

export const MAX_TEXT = 20_000;
export const MAX_LINES = 400;
/** A whole requirement document (sections, tables, samples) may be much longer. */
export const MAX_DOC_TEXT = 300_000;
export const MAX_DOC_LINES = 3000;

export interface DescribeConfig { modelEnabled: boolean; modelUrl: string; modelTimeoutMs: number; nodeHost: string; }
export function loadDescribeConfig(env: NodeJS.ProcessEnv = process.env): DescribeConfig {
  return {
    modelEnabled: /^(1|true|yes|on)$/i.test(env.DESCRIBE_MODEL_ENABLED ?? ""),
    modelUrl: (env.CHANGE_MODEL_URL ?? "").trim().replace(/\/+$/, ""),
    modelTimeoutMs: Math.min(300_000, Math.max(5_000, Number(env.DESCRIBE_MODEL_TIMEOUT_MS) || 90_000)),
    nodeHost: (env.ESTATE_NODE_HOST ?? "127.0.0.1").trim() || "127.0.0.1",
  };
}

/** The migrated services the description names (only those are read in detail). */
export interface EstateLike {
  overview(token?: string | null): Promise<{ apis: { name: string; nodePort?: number; basePath?: string; internalUrl?: string }[] }>;
  detail(name: string, token?: string | null): Promise<{ name: string; basePath?: string; operations?: { id: string; method: string; path: string; summary?: string }[] } | null>;
}

export interface DescribePreview {
  engine: "rules" | "local-model";
  flow: DescribeResult["flow"];
  lines: DescribeResult["lines"];
  missing: DescribeResult["missing"];
  notes: string[];
  ok: boolean;
  entry: string[];                      // "add" mode: the first steps, to connect after a step on the canvas
  issues: ValidationIssue[] | null;     // the flow engine's validator; null when it could not be reached
  mode?: "steps" | "document";          // document: a whole requirement document was read
  doc?: DocumentInfo;                   // document mode: what was taken from it, decisions, conflicts, ...
  validationError?: string;
  modelText?: string;                   // the lines the local model wrote (local-model only)
}

type Send = typeof runtimeRequest;
const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };
const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "described-flow";

/** A condition the step reader does not know, tried with the mapping phrase rules: "if WORDS then true otherwise false". */
export function conditionByWords(words: string): { expr: string; explanation: string } | null {
  const r = compileWords({ instruction: `if ${words} then true otherwise false` });
  const m = r.compiled && /^(.*\S)\s*\?\s*true\s*:\s*false$/s.exec(r.compiled.expr.trim());
  return m ? { expr: m[1].trim(), explanation: r.compiled!.explanation.replace(/,?\s*(?:then|use)?\s*true.*$/i, "").trim() || words } : null;
}
export function valueByWords(words: string): { expr: string; explanation: string } | null {
  const r = compileWords({ instruction: words });
  return r.ok && r.compiled ? { expr: r.compiled.expr, explanation: r.compiled.explanation } : null;
}

export async function describeContext(cfg: StudioConfig, user: string, text: string, estate?: EstateLike, token?: string | null, nodeHost = "127.0.0.1", send: Send = runtimeRequest): Promise<{ ctx: DescribeContext; notes: string[] }> {
  const notes: string[] = [];
  const get = async <T>(path: string, key: string): Promise<T[]> => {
    try {
      const r = await send(cfg, "GET", path, undefined, user, 20_000);
      const j = r.status < 300 ? parse(r.text) as Record<string, unknown> | null : null;
      const list = j?.[key];
      return Array.isArray(list) ? (list as T[]) : [];
    } catch { return []; }
  };
  const [connections, connectors, flows] = await Promise.all([
    get<{ id: string; name: string; type: string; config?: Record<string, unknown> }>("/v1/connections", "connections"),
    get<ConnectorDef>("/v1/connectors", "connectors"),
    get<{ id: string; name: string; slug?: string }>("/v1/flows", "flows"),
  ]);
  const apis: DescribeApi[] = [];
  if (estate) {
    try {
      const o = await estate.overview(token);
      const lower = text.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const named = (o.apis ?? []).filter((a) => a.name && lower.includes(a.name.toLowerCase().replace(/[^a-z0-9]+/g, ""))).slice(0, 5);
      for (const a of named) {
        const d = await estate.detail(a.name, token).catch(() => null);
        apis.push({
          name: a.name, basePath: d?.basePath ?? a.basePath,
          baseUrl: a.nodePort ? `http://${nodeHost}:${a.nodePort}` : a.internalUrl,
          operations: (d?.operations ?? []).map((op) => ({ id: op.id, method: op.method, path: op.path, summary: op.summary })),
        });
      }
    } catch { notes.push("The migrated services could not be read just now, so they are not offered as systems to call."); }
  }
  return {
    ctx: {
      connections: connections.map((c) => ({ id: c.id, name: c.name, type: c.type, ...(typeof c.config?.authType === "string" ? { authType: c.config.authType } : {}), ...(typeof c.config?.baseUrl === "string" ? { baseUrl: c.config.baseUrl } : {}) })),
      connectors, apis, flows: flows.map((f) => ({ id: f.id, name: f.name, slug: f.slug })),
    },
    notes,
  };
}

/** The 3 mapper phrasings closest to some words (by shared words). */
export function closestMapping(words: string): { phrase: string; example: string }[] {
  const tok = (x: string) => new Set(x.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const mine = tok(words);
  return MAPPING_PHRASES.map((p) => { const t = tok(`${p.phrase} ${p.example}`); let n = 0; for (const w of mine) if (t.has(w)) n++; return { p, n }; })
    .sort((a, b) => b.n - a.n).slice(0, 3).map(({ p }) => ({ phrase: p.phrase, example: p.example }));
}

/** Reads the text, checks the mapping words with the full interpreter, and validates the draft. */
export async function preview(cfg: StudioConfig, user: string, text: string, ctx: DescribeContext, send: Send = runtimeRequest, attach = false): Promise<Omit<DescribePreview, "engine">> {
  if (looksLikeDocument(text)) return previewDocument(cfg, user, text, ctx, send);
  const result = describeFlow(text, ctx, { compileCondition: conditionByWords, compileValue: valueByWords, attach });
  // mapping words: the flow engine's interpreter first, then the fixed rules here (same as the Mapper)
  for (const ins of result.instructions) {
    const node = result.flow.nodes.find((n) => n.id === ins.nodeId);
    const spec = node?.config.mapping as { rules: { id: string; target: string; compiled?: unknown }[]; sampleSource?: unknown } | undefined;
    const rule = spec?.rules.find((r) => r.id === ins.ruleId);
    const line = result.lines.find((l) => l.line === ins.line);
    if (!rule || !line) continue;
    let answer: Record<string, unknown> | null = null;
    try {
      const r = await compileWithFallback(cfg, { instruction: ins.instruction, target: rule.target, ...(spec?.sampleSource !== undefined ? { sampleSource: spec.sampleSource } : {}) }, user);
      answer = r.status < 300 ? parse(r.text) as Record<string, unknown> | null : null;
    } catch { answer = null; }
    const compiled = answer?.compiled as { expr?: unknown; explanation?: unknown; confidence?: unknown } | null | undefined;
    if (compiled && compiled.confidence === "guessed") {
      // a guess is not an answer: say so, like any line that is not understood
      line.status = "not-understood";
      line.message = `The mapping phrases could only guess what "${ins.instruction}" means (${String(compiled.explanation ?? compiled.expr)}), so nothing was made for it. Write it with one of the mapper's phrasings.`;
      line.suggestions = closestMapping(ins.instruction).map((x) => ({ phrase: `Map: ${rule.target} from ${x.phrase}`, example: `Map: ${rule.target} from ${x.example}` }));
      rule.compiled = null;
      result.ok = false;
    } else if (compiled && typeof compiled.expr === "string" && compiled.expr.trim()) {
      rule.compiled = compiled;
      line.understood = `${rule.target} = ${String(compiled.explanation ?? compiled.expr)} (${compiled.expr})`;
    } else {
      line.status = "not-understood";
      line.message = `"${ins.instruction}" was not understood by the mapping phrases${typeof answer?.reason === "string" ? `: ${answer.reason}` : ""}.`;
      const s = Array.isArray(answer?.suggestions) ? (answer!.suggestions as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 3) : [];
      line.suggestions = s.map((x) => ({ phrase: `Map: ${rule.target} from ${x}`, example: `Map: ${rule.target} from ${x}` }));
      result.ok = false;
    }
  }
  const slug = slugOf(result.flow.name);
  const draft = {
    id: "draft-described", name: result.flow.name, slug, description: result.flow.description, tags: [], nodes: result.flow.nodes, edges: result.flow.edges,
    settings: { basePath: `/${slug}/v1`, timeoutMs: 60000, logPayloads: true, gateway: { publish: true, security: "oauth2", version: "v1" } },
    revision: 1, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
  let issues: ValidationIssue[] | null = null, validationError: string | undefined;
  try {
    const r = await send(cfg, "POST", "/v1/flows/validate", { flow: draft }, user, 30_000);
    const j = parse(r.text) as { issues?: ValidationIssue[]; title?: string } | null;
    if (r.status < 300 && Array.isArray(j?.issues)) issues = j!.issues!;
    else validationError = j?.title ?? `The flow engine answered ${r.status}`;
  } catch (e) { validationError = `The flow engine could not be reached (${(e as Error).message}), so the draft was not checked yet.`; }
  return { mode: "steps", flow: result.flow, lines: result.lines, missing: result.missing, notes: result.notes, ok: result.ok, entry: result.entry, issues, ...(validationError ? { validationError } : {}) };
}

async function validateDraft(cfg: StudioConfig, user: string, flow: { name: string; description?: string; nodes: unknown[]; edges: unknown[]; settings?: Record<string, unknown> }, send: Send): Promise<{ issues: ValidationIssue[] | null; validationError?: string }> {
  const slug = slugOf(flow.name);
  const given = flow.settings ?? {};
  const draft = {
    id: "draft-described", name: flow.name, slug, description: flow.description, tags: [], nodes: flow.nodes, edges: flow.edges,
    settings: { basePath: `/${slug}/v1`, timeoutMs: 60000, logPayloads: true, ...given, gateway: { publish: true, security: "oauth2", version: "v1", ...((given.gateway as object | undefined) ?? {}) } },
    revision: 1, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
  try {
    const r = await send(cfg, "POST", "/v1/flows/validate", { flow: draft }, user, 30_000);
    const j = parse(r.text) as { issues?: ValidationIssue[]; title?: string } | null;
    if (r.status < 300 && Array.isArray(j?.issues)) return { issues: j!.issues! };
    return { issues: null, validationError: j?.title ?? `The flow engine answered ${r.status}` };
  } catch (e) { return { issues: null, validationError: `The flow engine could not be reached (${(e as Error).message}), so the draft was not checked yet.` }; }
}

/** A whole requirement document: read by the document rules, then checked by the flow engine. Unread prose
 *  never blocks; only real problems (doc.blocking, e.g. no endpoint) do. */
export async function previewDocument(cfg: StudioConfig, user: string, text: string, ctx: DescribeContext, send: Send = runtimeRequest): Promise<Omit<DescribePreview, "engine">> {
  const r = readDocument(text, ctx);
  const v = await validateDraft(cfg, user, r.flow as never, send);
  return { mode: "document", flow: r.flow, lines: [], missing: r.missing, notes: r.notes, ok: r.ok, entry: [], doc: r.doc, issues: v.issues, ...(v.validationError ? { validationError: v.validationError } : {}) };
}

/** What the local model is asked: rewrite the requirement as the step lines this server reads. */
export function modelPrompt(text: string, ctx: DescribeContext): { system: string; user: string } {
  const phrases = STEP_PHRASES.filter((p) => p.group !== "Other").map((p) => `- ${p.phrase}   e.g. ${p.example.split("\n")[0]}`).join("\n");
  const systems = [...(ctx.connectors ?? []).map((c) => `${c.name} (connector: ${(c.operations ?? []).map((o) => o.id).slice(0, 12).join(", ")})`),
    ...(ctx.connections ?? []).map((c) => `${c.name} (${c.type} connection)`), ...(ctx.apis ?? []).map((a) => `${a.name} (migrated API)`)].slice(0, 60);
  return {
    system: "You turn an integration requirement into flow steps for the Weave canvas. Answer ONLY with step lines, one per line, no numbering, no explanations, no code fences. "
      + "Every line must use one of these phrasings (CAPITAL words are placeholders; indent steps that belong to an If, Otherwise or For each by two spaces):\n" + phrases
      + (systems.length ? `\nSystems that exist (use these names exactly): ${systems.join("; ")}` : ""),
    user: text,
  };
}

/** Only a model on this machine or the private network: loopback, private ranges, or a one-word host name (a container). */
export function isLocalModelUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^[a-z0-9-]+$/i.test(h);
}

export async function askModel(dc: DescribeConfig, text: string, ctx: DescribeContext, fetchImpl: typeof fetch = fetch, prompt?: { system: string; user: string }): Promise<{ ok: true; lines: string } | { ok: false; status: number; title: string; detail?: string }> {
  if (!dc.modelEnabled) return { ok: false, status: 404, title: "Drafting with the local model is switched off on this server" };
  if (!dc.modelUrl) return { ok: false, status: 503, title: "The local model is not configured", detail: "Set CHANGE_MODEL_URL to the self-hosted model's address to use it. The step reader works without it." };
  if (!isLocalModelUrl(dc.modelUrl)) return { ok: false, status: 503, title: "The local model address is not on this network", detail: "Only a self-hosted model reached over the local network may be used." };
  const p = prompt ?? modelPrompt(text, ctx);
  let res: Response;
  try {
    res = await fetchImpl(`${dc.modelUrl}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(dc.modelTimeoutMs),
      body: JSON.stringify({ model: "local", temperature: 0, max_tokens: 900, messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }] }),
    });
  } catch (e) {
    const slow = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
    return slow
      ? { ok: false, status: 504, title: `The local model did not answer within ${Math.round(dc.modelTimeoutMs / 1000)} seconds`, detail: "It may be busy with another request. Try again later, or write the steps yourself." }
      : { ok: false, status: 502, title: "The local model cannot be reached", detail: (e as Error).message };
  }
  if (!res.ok) return { ok: false, status: 502, title: `The local model answered with HTTP ${res.status}` };
  const j = await res.json().catch(() => null) as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = j?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) return { ok: false, status: 502, title: "The local model gave no answer" };
  const lines = content.replace(/```[a-z]*\n?|```/gi, "").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim()).slice(0, MAX_LINES).join("\n");
  return { ok: true, lines };
}

function checkText(body: unknown): { text: string } | { error: string } {
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || !text.trim()) return { error: "Write the steps first, one per line." };
  const doc = text.length <= MAX_DOC_TEXT && looksLikeDocument(text);
  if (doc) {
    if (text.split("\n").length > MAX_DOC_LINES) return { error: `The document has more than ${MAX_DOC_LINES} lines. Paste the part that describes one API (its sections, tables and samples).` };
    return { text };
  }
  if (text.length > MAX_DOC_TEXT) return { error: `The text is longer than ${Math.round(MAX_DOC_TEXT / 1000)} KB. Paste the part that describes one API.` };
  if (text.length > MAX_TEXT) return { error: `The description is longer than ${MAX_TEXT} characters and does not read like a requirement document (numbered sections, tables, samples). Split the steps into several flows.` };
  if (text.split("\n").length > MAX_LINES) return { error: `The description has more than ${MAX_LINES} step lines and does not read like a requirement document (numbered sections, tables, samples). Split the steps into several flows.` };
  return { text };
}

export function registerDescribe(app: FastifyInstance, cfg: StudioConfig, userOf: (req: FastifyRequest) => Promise<string | null>, estate?: EstateLike, dc: DescribeConfig = loadDescribeConfig()) {
  const problem = (reply: any, status: number, title: string, detail?: string) => reply.code(status).type("application/problem+json").send({ type: "about:blank", title, status, ...(detail ? { detail } : {}) });
  const tokenOf = async (req: FastifyRequest) => { try { return await (app as unknown as { tokenFor(s: string): Promise<string | null> }).tokenFor(sidOf(req) || ""); } catch { return null; } };

  app.get("/api/factory/describe", async (req, reply) => {
    if (!(await userOf(req))) return problem(reply, 401, "Not signed in");
    return { phrases: STEP_PHRASES, model: { enabled: dc.modelEnabled, configured: dc.modelEnabled && !!dc.modelUrl } };
  });

  app.post("/api/factory/describe/preview", async (req, reply) => {
    const user = await userOf(req);
    if (!user) return problem(reply, 401, "Not signed in");
    const t = checkText(req.body);
    if ("error" in t) return problem(reply, 400, t.error);
    if (!cfg.runtimeUrl || !cfg.internalKey) return problem(reply, 503, "Weave runtime is not configured");
    const { ctx, notes } = await describeContext(cfg, user, t.text, estate, await tokenOf(req), dc.nodeHost);
    const p = await preview(cfg, user, t.text, ctx, runtimeRequest, (req.body as { mode?: unknown }).mode === "add");
    return { engine: "rules", ...p, notes: [...notes, ...p.notes] } satisfies DescribePreview;
  });

  app.post("/api/factory/describe/model", async (req, reply) => {
    const user = await userOf(req);
    if (!user) return problem(reply, 401, "Not signed in");
    const t = checkText(req.body);
    if ("error" in t) return problem(reply, 400, t.error);
    if (!dc.modelEnabled) return problem(reply, 404, "Drafting with the local model is switched off on this server");
    if (!cfg.runtimeUrl || !cfg.internalKey) return problem(reply, 503, "Weave runtime is not configured");
    const { ctx, notes } = await describeContext(cfg, user, t.text, estate, await tokenOf(req), dc.nodeHost);
    const m = await askModel(dc, t.text, ctx);
    if (!m.ok) return problem(reply, m.status, m.title, m.detail);
    const p = await preview(cfg, user, m.lines, ctx, runtimeRequest, (req.body as { mode?: unknown }).mode === "add");
    return { engine: "local-model", ...p, notes: [...notes, "Drafted by the local model and then read by the same fixed rules. Check every line before accepting; nothing is saved yet.", ...p.notes], modelText: m.lines } satisfies DescribePreview;
  });
}
