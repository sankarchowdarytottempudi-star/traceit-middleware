// /api/studio/* -> Weave runtime /v1/*. The browser never talks to the runtime directly and
// never sees the internal key. Paths, bodies and status codes pass through unchanged
// (contract: packages/weave-flow/src/api.ts).
import type { FastifyInstance, FastifyRequest } from "fastify";
import http from "node:http";
import { URL } from "node:url";

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
      const r = await runtimeRequest(cfg, method, "/v1" + rest, body, user);
      reply.code(r.status).type(String(r.headers["content-type"] || "application/json"));
      return reply.send(r.text);
    } catch (e) {
      return reply.code(502).type("application/problem+json").send({ type: "about:blank", title: "Weave runtime unreachable", status: 502, detail: String((e as Error).message) });
    }
  });
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
