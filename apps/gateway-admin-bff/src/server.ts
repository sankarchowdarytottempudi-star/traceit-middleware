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

export async function buildServer(cfg: Config, creds: ClientCreds, store: SessionStore): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cookie, { secret: cfg.SESSION_SECRET });

  app.get("/healthz", async () => ({ status: "UP" }));

  registerAuth(app, cfg, creds, store);
  registerRoutes(app, cfg);

  app.setErrorHandler((err, _req, reply) => {
    const status = (err as any).statusCode ?? 500;
    reply.code(status).type("application/problem+json").send({
      type: "about:blank", title: err.message || "Error", status,
    });
  });

  const spa = join(dirname(fileURLToPath(import.meta.url)), "../../gateway-admin/dist");
  if (existsSync(spa)) {
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
      const seg = url.split("?")[0]; const last = seg.substring(seg.lastIndexOf("/") + 1);
      if (url.startsWith("/api") || last.includes(".")) {
        // concrete file or api: never serve HTML (stale asset must 404, not parse as JS)
        reply.code(404).type(url.startsWith("/api") ? "application/problem+json" : "text/plain")
          .send(url.startsWith("/api") ? { type: "about:blank", title: "Not found", status: 404 } : "Not found");
        return;
      }
      reply.header("cache-control", "no-cache, no-store, must-revalidate").sendFile("index.html");
    });
  }
  return app;
}
