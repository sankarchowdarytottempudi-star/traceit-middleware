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
    try {
      const r = await runtimeRequest(cfg, method, "/v1" + rest, hasBody ? (req.body ?? {}) : undefined, user);
      reply.code(r.status).type(String(r.headers["content-type"] || "application/json"));
      return reply.send(r.text);
    } catch (e) {
      return reply.code(502).type("application/problem+json").send({ type: "about:blank", title: "Weave runtime unreachable", status: 502, detail: String((e as Error).message) });
    }
  });
}
