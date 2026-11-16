import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fstatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { registerAuth, basePath, type ClientCreds } from "./auth.js";
import type { SessionStore } from "./sessionStore.js";
import { registerRoutes } from "./routes.js";
import { registerStudio } from "./studio.js";
import { registerEstate } from "./estate/routes.js";
import { registerMigrate } from "./migrate/routes.js";
import { registerParts } from "./migrate/parts.js";
import { registerServers } from "./servers/routes.js";
import { registerVersions, flowVersionRecorder } from "./versions/routes.js";
import { registerChanges } from "./changes/routes.js";

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
  // Served under a path of a shared address (PUBLIC_BASE_URL=https://host/factory), every request
  // arrives with that path in front. It is taken off here, so all routes stay written from "/",
  // and the same server still answers without it (health checks, the loopback test instance).
  const base = basePath(cfg.PUBLIC_BASE_URL);
  const app: FastifyInstance = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 20 * 1024 * 1024,
    rewriteUrl(req) {
      const u = req.url ?? "/";
      if (!base || (u !== base && !u.startsWith(`${base}/`) && !u.startsWith(`${base}?`))) return u;
      (req as { weaveBase?: string }).weaveBase = base;
      const rest = u.slice(base.length);
      return rest.startsWith("/") ? rest : `/${rest}`;
    },
  });
  await app.register(cookie, { secret: cfg.SESSION_SECRET });
  app.get("/healthz", async () => ({ status: "UP" }));
  registerAuth(app, cfg, creds, store);
  registerRoutes(app, cfg);
  registerMigrate(app, cfg);
  registerParts(app, cfg);
  registerServers(app, cfg);
  registerEstate(app, cfg, creds);
  const studioCfg = { runtimeUrl: cfg.RUNTIME_URL, internalKey: cfg.RUNTIME_INTERNAL_KEY || "" };
  registerStudio(app, studioCfg, (req) => app.userFor(req), flowVersionRecorder(cfg, studioCfg));
  registerVersions(app, cfg);
  registerChanges(app, cfg);
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as any).statusCode ?? 500;
    reply.code(status).type("application/problem+json").send({ type: "about:blank", title: err.message || "Error", status });
  });
  const spa = resolveSpaDir();
  if (spa) {
    // The page is built with addresses relative to itself ("./assets/..."). They are completed
    // here with the place this request was served from, which the page also carries for the app.
    const raw = readFileSync(join(spa, "index.html"), "utf8");
    const pages = new Map<string, string>();
    const page = (req: FastifyRequest): string => {
      const at = (req.raw as { weaveBase?: string }).weaveBase ?? "";
      let html = pages.get(at);
      if (html === undefined) {
        html = raw.replace(/(\s(?:src|href))="\.\//g, `$1="${at}/`).replace("<head>", `<head>\n    <meta name="weave-base" content="${at}" />`);
        pages.set(at, html);
      }
      return html;
    };
    const sendPage = (req: FastifyRequest, reply: FastifyReply) =>
      reply.header("cache-control", "no-cache, no-store, must-revalidate").type("text/html; charset=utf-8").send(page(req));
    app.get("/", sendPage);
    app.get("/index.html", sendPage);
    await app.register(fstatic, {
      root: spa,
      index: false,
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
      return sendPage(req, reply);
    });
  }
  return app;
}
