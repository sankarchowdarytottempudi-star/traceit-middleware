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
  // Robust against flat (dist/index.js) or nested (dist/src/index.js) builds.
  for (const rel of ["../../weave-factory/dist", "../../../weave-factory/dist", "../weave-factory/dist"]) {
    const p = join(here, rel);
    if (existsSync(p)) return p;
  }
  return null;
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
    await app.register(fstatic, { root: spa });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith("/api")) reply.code(404).type("application/problem+json").send({ type: "about:blank", title: "Not found", status: 404 });
      else reply.sendFile("index.html");
    });
  }
  return app;
}
