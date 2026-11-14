import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fstatic from "@fastify/static";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { registerAuth, type ClientCreds } from "./auth.js";
import type { SessionStore } from "./sessionStore.js";
import { registerRoutes } from "./routes.js";

function resolveSpaDir(): string | null {
  if (process.env.SPA_DIR && existsSync(process.env.SPA_DIR)) return process.env.SPA_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../../weave-factory/dist", "../../../weave-factory/dist", "../weave-factory/dist"]) {
    const p = join(here, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

// A request for a concrete file (last path segment has an extension) must never be
// answered with index.html: a stale /assets/<oldhash>.js would arrive as HTML and the
// browser would fail to parse it as a module -> white screen. Return a real 404 instead.
function looksLikeFile(url: string): boolean {
  const path = url.split("?")[0];
  const last = path.substring(path.lastIndexOf("/") + 1);
  return last.includes(".");
}

export async function buildServer(cfg: Config, creds: ClientCreds, store: SessionStore): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cookie, { secret: cfg.SESSION_SECRET });
  app.get("/healthz", async () => ({ status: "UP" }));
  registerAuth(app, cfg, creds, store);
  registerRoutes(app, cfg);
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as any).statusCode ?? 500;
    reply.code(status).type("application/problem+json").send({ type: "about:blank", title: err.message || "Error", status });
  });
  const spa = resolveSpaDir();
  if (spa) {
    await app.register(fstatic, {
      root: spa,
      cacheControl: false, // we set cache-control ourselves in setHeaders
      setHeaders(res, p) {
        if (p.endsWith("index.html")) res.setHeader("cache-control", "no-cache, no-store, must-revalidate");
        else if (p.includes("/assets/")) res.setHeader("cache-control", "public, max-age=31536000, immutable");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const url = req.raw.url || "/";
      if (url.startsWith("/api") || looksLikeFile(url)) {
        reply.code(404).type(url.startsWith("/api") ? "application/problem+json" : "text/plain")
          .send(url.startsWith("/api") ? { type: "about:blank", title: "Not found", status: 404 } : "Not found");
        return;
      }
      reply.header("cache-control", "no-cache, no-store, must-revalidate").sendFile("index.html");
    });
  }
  return app;
}
