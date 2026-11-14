// /api/studio/* -> Weave runtime /v1/*. The browser never talks to the runtime directly and
// never sees the internal key. Paths, bodies and status codes pass through unchanged
// (contract: packages/weave-flow/src/api.ts).
import type { FastifyInstance, FastifyRequest } from "fastify";
import http from "node:http";
import { URL } from "node:url";
import { compileWords, inferRules, type WordsRequest } from "./studioWords.js";

export interface StudioConfig { runtimeUrl: string; internalKey: string; }

export function runtimeRequest(cfg: StudioConfig, method: string, path: string, body: unknown, user: string, timeoutMs = 120_000):
  Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  const u = new URL(cfg.runtimeUrl + path);
  const data = body === undefined || body === null ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { "x-weave-key": cfg.internalKey, "x-weave-user": user, accept: "application/json" };
  if (data) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(data)); }
  return new Promise((resolve, reject) => {
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 502, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("runtime timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** A read that fails because the connection was refused or dropped (the runtime restarting, a
 *  stale socket) is tried once more after a short pause. Anything that changes data is never
 *  repeated, and a timeout is not retried. */
export async function readWithRetry(cfg: StudioConfig, method: string, path: string, body: unknown, user: string,
  send: typeof runtimeRequest = runtimeRequest, pauseMs = 250): ReturnType<typeof runtimeRequest> {
  try { return await send(cfg, method, path, body, user); }
  catch (e) {
    const readOnly = method === "GET" || method === "HEAD";
    if (!readOnly || /timeout/i.test(String((e as Error).message))) throw e;
    await new Promise((r) => setTimeout(r, pauseMs));
    return send(cfg, method, path, body, user);
  }
}

export function registerStudio(app: FastifyInstance, cfg: StudioConfig, userOf: (req: FastifyRequest) => Promise<string | null>) {
  app.all("/api/studio/*", async (req, reply) => {
    const user = await userOf(req);
    if (!user) return reply.code(401).type("application/problem+json").send({ type: "about:blank", title: "Not signed in", status: 401 });
    if (!cfg.runtimeUrl || !cfg.internalKey) {
      return reply.code(503).type("application/problem+json").send({ type: "about:blank", title: "Weave runtime is not configured", status: 503 });
    }
    const raw = req.raw.url || "";
    const rest = raw.substring("/api/studio".length); // keeps the query string
    const method = req.method.toUpperCase();
    const hasBody = !["GET", "HEAD", "DELETE"].includes(method) || (req.body !== undefined && req.body !== null);
    let body: unknown = hasBody ? (req.body ?? {}) : undefined;
    // "Import from an address": the description is fetched here, on this server, and handed to
    // the runtime as text. It is never sent anywhere else.
    if (method === "POST" && rest.split("?")[0] === "/connectors/import-openapi" && body && typeof body === "object") {
      const b = body as { name?: unknown; spec?: unknown; url?: unknown };
      if (typeof b.url === "string" && b.url.trim() && (b.spec === undefined || b.spec === null || b.spec === "")) {
        try { body = { name: b.name, spec: await fetchDescription(b.url.trim()) }; }
        catch (e) { return reply.code(400).type("application/problem+json").send({ type: "about:blank", title: "Cannot read this API description", status: 400, detail: String((e as Error).message) }); }
      }
    }
    try {
      const route = rest.split("?")[0];
      if (method === "POST" && (route === "/mapping/compile-instruction" || route === "/mapping/infer")) {
        const r = route === "/mapping/infer" ? await inferWithFallback(cfg, body, user) : await compileWithFallback(cfg, body, user);
        return reply.code(r.status).type(r.type).send(r.text);
      }
      const r = await readWithRetry(cfg, method, "/v1" + rest, body, user);
      reply.code(r.status).type(String(r.headers["content-type"] || "application/json"));
      return reply.send(r.text);
    } catch (e) {
      return reply.code(502).type("application/problem+json").send({ type: "about:blank", title: "Weave runtime unreachable", status: 502, detail: String((e as Error).message) });
    }
  });
}

type Answer = { status: number; type: string; text: string };
const answerOf = (r: { status: number; headers: http.IncomingHttpHeaders; text: string }): Answer => ({ status: r.status, type: String(r.headers["content-type"] || "application/json"), text: r.text });
const jsonAnswer = (body: unknown): Answer => ({ status: 200, type: "application/json", text: JSON.stringify(body) });
const parse = (text: string): Record<string, unknown> | null => { try { const v = JSON.parse(text); return v && typeof v === "object" ? v as Record<string, unknown> : null; } catch { return null; } };

/** "In your words": the flow engine reads the sentence first. When it has no answer, the fixed
 *  rules in studioWords.ts are tried here, on this server. Nothing is sent anywhere else. */
export async function compileWithFallback(cfg: StudioConfig, body: unknown, user: string): Promise<Answer> {
  let upstream: Awaited<ReturnType<typeof runtimeRequest>> | null = null;
  try { upstream = await runtimeRequest(cfg, "POST", "/v1/mapping/compile-instruction", body, user); } catch { upstream = null; }
  const theirs = upstream && upstream.status < 300 ? parse(upstream.text) : null;
  if (theirs && theirs.compiled && typeof (theirs.compiled as { expr?: unknown }).expr === "string") return answerOf(upstream!);
  const b = (body ?? {}) as WordsRequest;
  const notOffered = !upstream || upstream.status === 404 || upstream.status === 501 || upstream.status >= 502;
  if (typeof b.instruction !== "string" || !b.instruction.trim() || (upstream && !theirs && !notOffered)) {
    return upstream ? answerOf(upstream) : { status: 502, type: "application/problem+json", text: JSON.stringify({ type: "about:blank", title: "Weave runtime unreachable", status: 502 }) };
  }
  const mine = compileWords(b);
  if (!mine.ok || !mine.compiled) {
    const placeholder = !theirs || /being installed/i.test(String(theirs.reason ?? ""));
    if (placeholder) return jsonAnswer(mine);
    const theirSuggestions = Array.isArray(theirs.suggestions) ? theirs.suggestions : [];
    return jsonAnswer({ ...theirs, suggestions: theirSuggestions.length ? theirSuggestions : mine.suggestions });
  }
  const out: Record<string, unknown> = { ...mine };
  if (b.sampleSource !== undefined) {
    try {
      const r = await runtimeRequest(cfg, "POST", "/v1/expr/eval", { expr: mine.compiled.expr, context: { payload: b.sampleSource } }, user, 20_000);
      const res = r.status < 300 ? parse(r.text) : null;
      if (res && res.ok === true) {
        out.preview = res.result === undefined ? null : res.result;
        if (b.desiredValue !== undefined) out.matchesDesired = JSON.stringify(out.preview) === JSON.stringify(b.desiredValue);
      } else if (res && typeof res.error === "string") out.previewError = res.error;
    } catch { /* the rule is still returned; the mapper shows its own live preview */ }
  }
  return jsonAnswer(out);
}

/** "Suggest mappings": the flow engine's answer when it has one, otherwise fixed rules on this server. */
export async function inferWithFallback(cfg: StudioConfig, body: unknown, user: string): Promise<Answer> {
  let upstream: Awaited<ReturnType<typeof runtimeRequest>> | null = null;
  try { upstream = await runtimeRequest(cfg, "POST", "/v1/mapping/infer", body, user); } catch { upstream = null; }
  const theirs = upstream && upstream.status < 300 ? parse(upstream.text) : null;
  if (theirs && Array.isArray(theirs.rules) && theirs.rules.length) return answerOf(upstream!);
  const b = (body ?? {}) as { sampleSource?: unknown; desiredOutput?: unknown };
  const notOffered = !upstream || upstream.status === 404 || upstream.status === 501 || upstream.status >= 502;
  if (b.sampleSource === undefined || b.desiredOutput === undefined || (upstream && !theirs && !notOffered)) {
    return upstream ? answerOf(upstream) : { status: 502, type: "application/problem+json", text: JSON.stringify({ type: "about:blank", title: "Weave runtime unreachable", status: 502 }) };
  }
  return jsonAnswer({ rules: inferRules(b.sampleSource, b.desiredOutput), engine: "rules" });
}

const MAX_DESCRIPTION_BYTES = 5 * 1024 * 1024;
/** Fetches an OpenAPI/Swagger document from an address the signed-in user typed. http(s) only, bounded in time and size. */
export async function fetchDescription(address: string): Promise<string> {
  let u: URL;
  try { u = new URL(address); } catch { throw new Error("That is not a complete address. It should start with http:// or https://"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http:// and https:// addresses can be read");
  let res: Response;
  try { res = await fetch(u, { headers: { accept: "application/json, application/yaml, text/yaml, text/plain, */*" }, redirect: "follow", signal: AbortSignal.timeout(15_000) }); }
  catch (e) { throw new Error(`The address did not answer (${(e as Error).name === "TimeoutError" ? "timed out after 15 seconds" : (e as Error).message})`); }
  if (!res.ok) throw new Error(`The address answered with HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_DESCRIPTION_BYTES) throw new Error("The document is larger than 5 MB");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_DESCRIPTION_BYTES) throw new Error("The document is larger than 5 MB");
  const text = buf.toString("utf8").trim();
  if (!text) throw new Error("The address returned an empty document");
  if (/^<(!doctype|html)/i.test(text)) throw new Error("The address returned a web page, not an API description. Use the link to the raw JSON or YAML document");
  return text;
}
