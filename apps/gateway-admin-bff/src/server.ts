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
import { registerInsightRoutes } from "./insightRoutes.js";
import { classifyUnmatched } from "./spaFallback.js";
import { registerRuleRoutes } from "./rules/routes.js";
import { createAudit } from "./rules/audit.js";

export async function buildServer(cfg: Config, creds: ClientCreds, store: SessionStore): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cookie, { secret: cfg.SESSION_SECRET });

  app.get("/healthz", async () => ({ status: "UP" }));

  registerAuth(app, cfg, creds, store);
  const audit = createAudit(cfg.GATEWAY_AUDIT_FILE || join(cfg.DATA_DIR || ".data", "gateway-audit.jsonl"));
  registerRoutes(app, cfg, audit);
  registerInsightRoutes(app, cfg);
  registerRuleRoutes(app, cfg, { audit });

  app.setErrorHandler((error, _req, reply) => {
    const err = error as { statusCode?: number; message?: string };
    const status = err.statusCode ?? 500;
    reply.code(status).type("application/problem+json").send({
      type: "about:blank", title: err.message || "Error", status,
    });
  });

  const spa = cfg.SPA_DIR || join(dirname(fileURLToPath(import.meta.url)), "../../gateway-admin/dist");
  if (existsSync(spa)) {
    await app.register(fstatic, {
      root: spa,
      cacheControl: false, // we set cache-control ourselves in setHeaders (@fastify/static >=9 passes the Fastify reply)
      setHeaders(reply, p) {
        if (p.endsWith("index.html")) reply.header("cache-control", "no-cache, no-store, must-revalidate");
        else if (p.includes("/assets/")) reply.header("cache-control", "public, max-age=31536000, immutable");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const kind = classifyUnmatched(req.raw.url || "/");
      if (kind !== "page") {
        // concrete file or api: never serve HTML (stale asset must 404, not parse as JS)
        reply.code(404).type(kind === "api" ? "application/problem+json" : "text/plain")
          .send(kind === "api" ? { type: "about:blank", title: "Not found", status: 404 } : "Not found");
        return;
      }
      reply.header("cache-control", "no-cache, no-store, must-revalidate").sendFile("index.html");
    });
  }
  return app;
}
