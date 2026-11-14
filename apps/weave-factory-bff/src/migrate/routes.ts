// Everything the migration screens need beyond the plain pass-through routes in ../routes.ts:
// starting a migration (the file is streamed to the migration tool, not buffered here),
// documents, environments, workspaces. The engine stays in the migration tool.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { mtRaw, mtRequest, mtUpload, type MtClient } from "../mt.js";
import { SOURCE_TECHNOLOGIES, TARGET_TECHNOLOGIES, UPLOAD_EXTENSIONS, mergeWorkspaces, validateUpload, withoutSecrets } from "./options.js";

export function registerMigrate(app: FastifyInstance, cfg: Config) {
  const mt: MtClient = { base: cfg.MT_BASE_URL, token: cfg.MT_ADMIN_TOKEN };
  const limitMb = cfg.MT_UPLOAD_LIMIT_MB ?? 500;

  async function need(req: FastifyRequest): Promise<void> {
    const sid = req.unsignCookie(req.cookies.sid ?? "").value;
    const t = await app.tokenFor(sid || "");
    if (!t) throw Object.assign(new Error("Not signed in"), { statusCode: 401 });
  }
  const pass = (reply: any, r: { status: number; json: unknown }) => { reply.code(r.status === 0 ? 502 : r.status); return withoutSecrets(r.json ?? { ok: r.status < 400 }); };
  const list = async (path: string, key: string): Promise<any[]> => {
    try { const r = await mtRequest(mt, "GET", path); const v = (r.json as Record<string, unknown> | null)?.[key]; return Array.isArray(v) ? v : []; } catch { return []; }
  };

  app.get("/api/factory/migrate/options", async (req) => {
    await need(req);
    return { technologies: SOURCE_TECHNOLOGIES, targets: TARGET_TECHNOLOGIES, extensions: UPLOAD_EXTENSIONS, maxUploadMb: limitMb };
  });

  // Upload: the body is the file itself. Scoped so the raw-stream parser applies to this route only.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
    scope.post("/api/factory/migrations", { bodyLimit: (limitMb + 1) * 1024 * 1024 }, async (req, reply) => {
      await need(req);
      const len = req.headers["content-length"] ? Number(req.headers["content-length"]) : undefined;
      const v = validateUpload(req.query as Record<string, string>, len, limitMb);
      if (!v.ok) {
        req.raw.resume();
        reply.code(v.status);
        return { error: v.error };
      }
      try {
        const r = await mtUpload(mt, "/api/migrations", v.headers, req.raw, len);
        return pass(reply, r);
      } catch (e) {
        reply.code(502);
        return { error: "The migration tool did not accept the upload", detail: e instanceof Error ? e.message : undefined };
      }
    });
  });

  app.delete("/api/factory/migrations/:id", async (req, reply) => {
    await need(req);
    const { id } = req.params as { id: string };
    const cur = await mtRequest(mt, "GET", `/api/migrations/${encodeURIComponent(id)}`);
    if (cur.status === 404) { reply.code(404); return { error: "No such migration" }; }
    const m = (cur.json || {}) as { busy?: boolean; progress?: { outcome?: string } };
    if (m.busy) { reply.code(409); return { error: "A step is running for this migration. Wait for it to finish, then delete." }; }
    if (m.progress?.outcome === "Deployed") { reply.code(409); return { error: "This migration produced a deployed API, so its record is kept." }; }
    return pass(reply, await mtRequest(mt, "DELETE", `/api/migrations/${encodeURIComponent(id)}`));
  });

  app.get("/api/factory/migrations/:id/docs/:name", async (req, reply) => {
    await need(req);
    const { id, name } = req.params as { id: string; name: string };
    const q = req.query as { download?: string };
    const r = await mtRaw(mt, `/api/migrations/${encodeURIComponent(id)}/docs/${encodeURIComponent(name)}`);
    if (r.status >= 400) { reply.code(r.status); return { error: r.status === 404 ? "This document has not been produced yet" : "The document is not available" }; }
    reply.type(r.contentType.includes("json") ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8");
    if (q.download) reply.header("content-disposition", `attachment; filename="${id}-${name.replace(/[^\w.-]/g, "_")}"`);
    return reply.send(r.body);
  });

  // Environments a migrated API is verified against (the token is write-only).
  app.get("/api/factory/environments", async (req, reply) => { await need(req); return pass(reply, await mtRequest(mt, "GET", "/api/environments")); });
  app.post("/api/factory/environments", async (req, reply) => {
    await need(req);
    const b = (req.body ?? {}) as { name?: string; baseUrl?: string; workspace?: string; token?: string };
    if (!b.name?.trim() || !/^https?:\/\/\S+$/i.test(b.baseUrl || "")) { reply.code(400); return { error: "An environment needs a name and an address that starts with http:// or https://" }; }
    return pass(reply, await mtRequest(mt, "POST", "/api/environments", { name: b.name.trim(), baseUrl: b.baseUrl, workspace: b.workspace || undefined, token: b.token || "" }));
  });
  app.delete("/api/factory/environments/:id", async (req, reply) => {
    await need(req);
    return pass(reply, await mtRequest(mt, "DELETE", `/api/environments/${encodeURIComponent((req.params as { id: string }).id)}`));
  });

  // Workspaces: the migration tool groups migrations by workspace name; target servers and
  // environments are kept separately. One merged view, without any stored password or token.
  app.get("/api/factory/workspaces", async (req) => {
    await need(req);
    const [groups, configs, envs, migrations] = await Promise.all([
      list("/api/workspaces", "workspaces"), list("/api/workspace-configs", "workspaces"), list("/api/environments", "environments"), list("/api/migrations", "migrations"),
    ]);
    return { workspaces: mergeWorkspaces(groups, configs, envs, migrations) };
  });
  app.post("/api/factory/workspace-configs", async (req, reply) => {
    await need(req);
    return pass(reply, await mtRequest(mt, "POST", "/api/workspace-configs", req.body ?? {}));
  });
  app.delete("/api/factory/workspace-configs/:id", async (req, reply) => {
    await need(req);
    return pass(reply, await mtRequest(mt, "DELETE", `/api/workspace-configs/${encodeURIComponent((req.params as { id: string }).id)}`));
  });
  // Connection check only (the migration tool's preflight). The install itself clears the target
  // server, so it is deliberately not offered from here.
  app.post("/api/factory/workspace-configs/:id/check/:tier", async (req, reply) => {
    await need(req);
    const { id, tier } = req.params as { id: string; tier: string };
    if (!["dev", "qa", "uat", "prod"].includes(tier)) { reply.code(400); return { error: "Unknown server" }; }
    return pass(reply, await mtRequest(mt, "POST", `/api/workspace-configs/${encodeURIComponent(id)}/provision/${tier}`));
  });
}
