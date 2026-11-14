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
    await app.register(fstatic, { root: spa });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith("/api")) {
        reply.code(404).type("application/problem+json").send({ type: "about:blank", title: "Not found", status: 404 });
      } else {
        reply.sendFile("index.html");
      }
    });
  }
  return app;
}
