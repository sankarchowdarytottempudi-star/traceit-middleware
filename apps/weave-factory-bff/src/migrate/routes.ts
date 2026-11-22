// Everything the migration screens need beyond the plain pass-through routes in ../routes.ts:
// starting a migration (the file is streamed to the migration tool, not buffered here),
// documents, environments, workspaces. The engine stays in the migration tool.
import { sidOf } from "../auth.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { Readable } from "node:stream";
import { mtRaw, mtRequest, mtUpload, type MtClient } from "../mt.js";
import { INTEGRATION_FILE_EXTENSIONS, PASTE_LIMITS, PASTE_TECHNOLOGIES, SINGLE_FILE_EXTENSIONS, decodeText, isSingleFile, pastedOf, wrapToZip } from "./paste.js";
import { REQUIREMENT_DOC_MB, REQUIREMENT_EXTENSIONS, SOURCE_TECHNOLOGIES, TARGET_TECHNOLOGIES, UPLOAD_EXTENSIONS, decisionOf, headerSafe, mergeWorkspaces, runtimePropertiesOf, sourceUploadOf, repoImportOf, repoOf, repoRefreshOf, validateUpload, withoutSecrets } from "./options.js";

/** Largest corrected analysis workbook accepted (bytes). */
export const CORRECTIONS_MAX = 10 * 1024 * 1024;
/** Largest reviewed requirements workbook accepted (bytes). */
export const REQUIREMENTS_MAX = 10 * 1024 * 1024;

export function registerMigrate(app: FastifyInstance, cfg: Config) {
  const mt: MtClient = { base: cfg.MT_BASE_URL, token: cfg.MT_ADMIN_TOKEN };
  const limitMb = cfg.MT_UPLOAD_LIMIT_MB ?? 500;

  async function need(req: FastifyRequest): Promise<void> {
    const sid = sidOf(req);
    const t = await app.tokenFor(sid || "");
    if (!t) throw Object.assign(new Error("Not signed in"), { statusCode: 401 });
  }
  const pass = (reply: any, r: { status: number; json: unknown }) => { reply.code(r.status === 0 ? 502 : r.status); return withoutSecrets(r.json ?? { ok: r.status < 400 }); };
  const list = async (path: string, key: string): Promise<any[]> => {
    try { const r = await mtRequest(mt, "GET", path); const v = (r.json as Record<string, unknown> | null)?.[key]; return Array.isArray(v) ? v : []; } catch { return []; }
  };

  app.get("/api/factory/migrate/options", async (req) => {
    await need(req);
    return { technologies: SOURCE_TECHNOLOGIES, targets: TARGET_TECHNOLOGIES, extensions: UPLOAD_EXTENSIONS, maxUploadMb: limitMb,
      singleFileExtensions: SINGLE_FILE_EXTENSIONS, integrationFileExtensions: INTEGRATION_FILE_EXTENSIONS, singleFileMb: PASTE_LIMITS.singleFileMb,
      requirements: { extensions: REQUIREMENT_EXTENSIONS, maxMb: Math.min(limitMb, REQUIREMENT_DOC_MB) },
      paste: { technologies: PASTE_TECHNOLOGIES, maxSnippets: PASTE_LIMITS.maxSnippets, maxSnippetKb: PASTE_LIMITS.maxSnippetBytes / 1024, maxTotalKb: PASTE_LIMITS.maxTotalBytes / 1024 } };
  });

  // Read a whole (small) request body, refusing more than `max` bytes.
  const readAll = (stream: NodeJS.ReadableStream, max: number) => new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    stream.on("data", (c: Buffer) => { n += c.length; if (n > max) { reject(Object.assign(new Error("too large"), { statusCode: 413 })); return; } parts.push(c); });
    stream.on("end", () => resolve(Buffer.concat(parts)));
    stream.on("error", reject);
  });
  // A pasted or single-file source, wrapped into a project zip, goes to the tool like any upload.
  const uploadWrapped = async (reply: any, headers: Record<string, string>, wrapped: { zip: Buffer; filename: string }) => {
    try {
      const r = await mtUpload(mt, "/api/migrations", { ...headers, "X-Filename": wrapped.filename }, Readable.from([wrapped.zip]), wrapped.zip.length);
      return pass(reply, r);
    } catch (e) {
      reply.code(502);
      return { error: "The migration tool did not accept the upload", detail: e instanceof Error ? e.message : undefined };
    }
  };

  // "Paste code": snippets as JSON, checked, laid out as a minimal project of their technology with a PASTED.txt
  // manifest, zipped and uploaded through the tool. The factory marks the result "partial source".
  app.post("/api/factory/migrations/paste", { bodyLimit: PASTE_LIMITS.maxTotalBytes * 2 + 64 * 1024 }, async (req, reply) => {
    await need(req);
    const v = pastedOf(req.body, TARGET_TECHNOLOGIES.map((t) => t.id));
    if (!v.ok) { reply.code(400); return { error: v.error }; }
    const { name, workspace, target, technology, snippets } = v.value;
    const headers: Record<string, string> = { "X-Name": name, "X-Target-Tech": target };
    if (workspace) headers["X-Workspace"] = workspace;
    return uploadWrapped(reply, headers, wrapToZip(snippets, technology, name, "pasted"));
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
      // one source file: wrapped into a minimal project zip here (it is small), then uploaded like a zip
      // (a requirement document goes to the tool as it is: the factory reads it)
      if (v.headers["X-Source-Type"] !== "requirements" && isSingleFile(v.headers["X-Filename"])) {
        let buf: Buffer;
        try { buf = await readAll(req.raw, PASTE_LIMITS.singleFileMb * 1024 * 1024); } catch { reply.code(413); return { error: `One source file can be at most ${PASTE_LIMITS.singleFileMb} MB.` }; }
        if (!buf.length) { reply.code(400); return { error: "The file is empty" }; }
        const q = req.query as Record<string, string>;
        const tech = PASTE_TECHNOLOGIES.some((t) => t.id === q.sourceType) ? q.sourceType : "auto";
        return uploadWrapped(reply, v.headers, wrapToZip([{ name: v.headers["X-Filename"], text: decodeText(buf) }], tech, v.headers["X-Name"], "single-file"));
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

  // The old application's archive for an existing migration: checked by the tool and kept as the
  // reference of the parity map. Streamed as it arrives; never used to generate the service again.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
    scope.post("/api/factory/migrations/:id/source", { bodyLimit: (limitMb + 1) * 1024 * 1024 }, async (req, reply) => {
      await need(req);
      const len = req.headers["content-length"] ? Number(req.headers["content-length"]) : undefined;
      const v = sourceUploadOf(req.query as Record<string, string>, len, Math.min(limitMb, 200));
      if (!v.ok) {
        req.raw.resume();
        reply.code(v.status);
        return { error: v.error };
      }
      try {
        const r = await mtUpload(mt, `/api/migrations/${encodeURIComponent((req.params as { id: string }).id)}/source`, v.headers, req.raw, len);
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

  // the generated project as one zip: for another platform (webMethods, MuleSoft, ...) this is what the customer installs
  app.get("/api/factory/migrations/:id/project", async (req, reply) => {
    await need(req);
    const { id } = req.params as { id: string };
    const r = await mtRaw(mt, `/api/migrations/${encodeURIComponent(id)}/project`);
    if (r.status >= 400 || !r.contentType.includes("zip")) { reply.code(r.status >= 400 ? r.status : 502); return { error: r.status === 404 ? "The project has not been generated yet" : "The project is not available" }; }
    const name = (/filename="([^"]+)"/.exec(r.disposition ?? "") || [])[1] || `${id}-project.zip`;
    reply.type("application/zip").header("content-disposition", `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`);
    return reply.send(r.body);
  });

  // Corrections: the analysis of one API as an editable Excel workbook, and the corrected workbook
  // back. The migration tool has the factory check and keep the corrections, then writes the
  // documents and the project again with them. The workbook is small, so it is read whole here.
  app.get("/api/factory/migrations/:id/corrections.xlsx", async (req, reply) => {
    await need(req);
    const { id } = req.params as { id: string };
    const r = await mtRaw(mt, `/api/migrations/${encodeURIComponent(id)}/corrections.xlsx`);
    if (r.status >= 400 || r.status === 0) {
      let error = "The workbook is not available right now";
      try { const e = JSON.parse(r.body.toString("utf8")) as { error?: unknown }; if (typeof e?.error === "string" && e.error) error = e.error; } catch { /* not JSON */ }
      reply.code(r.status || 502);
      return { error };
    }
    if (!/spreadsheetml|octet-stream/.test(r.contentType)) { reply.code(502); return { error: "The migration tool did not send a workbook" }; }
    const name = (/filename="([^"]+)"/.exec(r.disposition ?? "") || [])[1] || `${id}-corrections.xlsx`;
    reply.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").header("content-disposition", `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`);
    return reply.send(r.body);
  });
  app.register(async (scope) => {
    scope.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
    scope.post("/api/factory/migrations/:id/corrections", { bodyLimit: CORRECTIONS_MAX + 64 * 1024 }, async (req, reply) => {
      await need(req);
      const len = req.headers["content-length"] ? Number(req.headers["content-length"]) : undefined;
      if (len !== undefined && len > CORRECTIONS_MAX) { req.raw.resume(); reply.code(413); return { ok: false, error: "The workbook is larger than 10 MB." }; }
      let buf: Buffer;
      try { buf = await readAll(req.raw, CORRECTIONS_MAX); } catch { reply.code(413); return { ok: false, error: "The workbook is larger than 10 MB." }; }
      if (!buf.length) { reply.code(400); return { ok: false, error: "No workbook was sent. Choose the corrected .xlsx file and upload it." }; }
      // an Excel workbook is a zip: anything else is refused here without bothering the tool
      if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) { reply.code(400); return { ok: false, error: "This is not an Excel workbook (.xlsx). Upload the workbook you downloaded, saved as .xlsx." }; }
      const headers: Record<string, string> = {};
      const who = typeof (app as any).userFor === "function" ? await (app as any).userFor(req) : null;
      if (who) headers["X-User"] = headerSafe(String(who)).slice(0, 80);
      try {
        const r = await mtUpload(mt, `/api/migrations/${encodeURIComponent((req.params as { id: string }).id)}/corrections`, headers, Readable.from([buf]), buf.length);
        return pass(reply, r);
      } catch (e) {
        reply.code(502);
        return { ok: false, error: "The migration tool did not accept the workbook", detail: e instanceof Error ? e.message : undefined };
      }
    });
  });

  // New from requirements: the review workbook and the blank template go down, the reviewed workbook goes up.
  // The factory reads and applies them in the migration tool, on this server. Workbooks are small: read whole.
  const workbook = async (reply: any, path: string, fallback: string) => {
    const r = await mtRaw(mt, path);
    if (r.status >= 400 || r.status === 0) {
      let error = "The workbook is not available right now";
      try { const e = JSON.parse(r.body.toString("utf8")) as { error?: unknown }; if (typeof e?.error === "string" && e.error) error = e.error; } catch { /* not JSON */ }
      reply.code(r.status || 502);
      return { error };
    }
    if (!/spreadsheetml|octet-stream/.test(r.contentType)) { reply.code(502); return { error: "The migration tool did not send a workbook" }; }
    const name = (/filename="([^"]+)"/.exec(r.disposition ?? "") || [])[1] || fallback;
    reply.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").header("content-disposition", `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`);
    return reply.send(r.body);
  };
  app.get("/api/factory/requirements/template.xlsx", async (req, reply) => {
    await need(req);
    return workbook(reply, "/api/requirements/template.xlsx", "requirements-template.xlsx");
  });
  app.get("/api/factory/migrations/:id/requirements.xlsx", async (req, reply) => {
    await need(req);
    const { id } = req.params as { id: string };
    return workbook(reply, `/api/migrations/${encodeURIComponent(id)}/requirements.xlsx`, `${id}-requirements-review.xlsx`);
  });
  app.get("/api/factory/migrations/:id/requirements-template.xlsx", async (req, reply) => {
    await need(req);
    const { id } = req.params as { id: string };
    return workbook(reply, `/api/migrations/${encodeURIComponent(id)}/requirements-template.xlsx`, "requirements-template.xlsx");
  });
  app.register(async (scope) => {
    scope.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
    scope.post("/api/factory/migrations/:id/requirements", { bodyLimit: REQUIREMENTS_MAX + 64 * 1024 }, async (req, reply) => {
      await need(req);
      const len = req.headers["content-length"] ? Number(req.headers["content-length"]) : undefined;
      if (len !== undefined && len > REQUIREMENTS_MAX) { req.raw.resume(); reply.code(413); return { ok: false, error: "The workbook is larger than 10 MB." }; }
      let buf: Buffer;
      try { buf = await readAll(req.raw, REQUIREMENTS_MAX); } catch { reply.code(413); return { ok: false, error: "The workbook is larger than 10 MB." }; }
      if (!buf.length) { reply.code(400); return { ok: false, error: "No workbook was sent. Choose the reviewed .xlsx file and upload it." }; }
      if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) { reply.code(400); return { ok: false, error: "This is not an Excel workbook (.xlsx). Upload the review workbook you downloaded, saved as .xlsx." }; }
      const headers: Record<string, string> = {};
      const who = typeof (app as any).userFor === "function" ? await (app as any).userFor(req) : null;
      if (who) headers["X-User"] = headerSafe(String(who)).slice(0, 80);
      try {
        const r = await mtUpload(mt, `/api/migrations/${encodeURIComponent((req.params as { id: string }).id)}/requirements`, headers, Readable.from([buf]), buf.length);
        return pass(reply, r);
      } catch (e) {
        reply.code(502);
        return { ok: false, error: "The migration tool did not accept the workbook", detail: e instanceof Error ? e.message : undefined };
      }
    });
  });

  // only the file the target platform imports (a Workato package, a webMethods IS package, ...): the project
  // zip above also holds documents, tests and settings, which such a platform refuses
  app.get("/api/factory/migrations/:id/package", async (req, reply) => {
    await need(req);
    const { id } = req.params as { id: string };
    const r = await mtRaw(mt, `/api/migrations/${encodeURIComponent(id)}/package`);
    if (r.status >= 400 || r.status === 0) {
      let error = "The package is not available right now";
      try { const e = JSON.parse(r.body.toString("utf8")) as { error?: unknown }; if (typeof e?.error === "string" && e.error) error = e.error; } catch { /* not JSON */ }
      reply.code(r.status || 502);
      return { error };
    }
    if (!r.contentType.includes("zip")) { reply.code(502); return { error: "The migration tool did not send a package" }; }
    const name = (/filename="([^"]+)"/.exec(r.disposition ?? "") || [])[1] || `${id}-package.zip`;
    reply.type("application/zip").header("content-disposition", `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`);
    return reply.send(r.body);
  });

  // "Finish this migration": what is left of the generated service, with what the old application
  // did at each point, and one decision of a person about one item (pass it on to an API, leave it
  // out, set a backend's address, keep a note). The work happens in the migration tool, on this server.
  app.get("/api/factory/migrations/:id/open-items", async (req, reply) => {
    await need(req);
    return pass(reply, await mtRequest(mt, "GET", `/api/migrations/${encodeURIComponent((req.params as { id: string }).id)}/open-items`));
  });
  // the old application, item by item, and where the new service does each item
  app.get("/api/factory/migrations/:id/parity", async (req, reply) => {
    await need(req);
    return pass(reply, await mtRequest(mt, "GET", `/api/migrations/${encodeURIComponent((req.params as { id: string }).id)}/parity`));
  });
  // runtime properties of the running old application: only the text goes on, and only names come back
  app.post("/api/factory/migrations/:id/runtime-properties", { bodyLimit: 512 * 1024 }, async (req, reply) => {
    await need(req);
    const d = runtimePropertiesOf(req.body);
    if (!d.ok) { reply.code(400); return { error: d.error }; }
    return pass(reply, await mtRequest(mt, "POST", `/api/migrations/${encodeURIComponent((req.params as { id: string }).id)}/runtime-properties`, { text: d.text }));
  });
  app.post("/api/factory/migrations/:id/resolve", async (req, reply) => {
    await need(req);
    const d = decisionOf(req.body);
    if (!d.ok) { reply.code(400); return { error: d.error }; }
    return pass(reply, await mtRequest(mt, "POST", `/api/migrations/${encodeURIComponent((req.params as { id: string }).id)}/resolve`, d.decision));
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

  // Projects taken straight from a git repository, without an upload. The repository is read by the
  // migration tool on its build server; this server only passes the request on. The access token is
  // write-only: it goes to the tool with the request that sets it and never comes back.
  const repoId = (req: FastifyRequest): string | null => { const id = (req.params as { id?: string }).id ?? ""; return /^[0-9a-f]{8,16}$/.test(id) ? id : null; };
  app.get("/api/factory/repos", async (req, reply) => { await need(req); return pass(reply, await mtRequest(mt, "GET", "/api/repos")); });
  // Tool health: the latest corpus run (every upload through the whole pipeline in a sandbox). Names and counts only.
  app.get("/api/factory/tool-health", async (req, reply) => { await need(req); return pass(reply, await mtRequest(mt, "GET", "/api/tool-health")); });
  app.post("/api/factory/repos", async (req, reply) => {
    await need(req);
    const v = repoOf(req.body);
    if (!v.ok) { reply.code(400); return { error: v.error }; }
    return pass(reply, await mtRequest(mt, "POST", "/api/repos", v.repo));
  });
  app.post("/api/factory/repos/:id/refresh", async (req, reply) => {
    await need(req);
    const id = repoId(req), v = repoRefreshOf(req.body);
    if (!id) { reply.code(404); return { error: "No such repository" }; }
    if (!v.ok) { reply.code(400); return { error: v.error }; }
    return pass(reply, await mtRequest(mt, "POST", `/api/repos/${id}/refresh`, v.change));
  });
  app.post("/api/factory/repos/:id/import", async (req, reply) => {
    await need(req);
    const id = repoId(req), v = repoImportOf(req.body);
    if (!id) { reply.code(404); return { error: "No such repository" }; }
    if (!v.ok) { reply.code(400); return { error: v.error }; }
    return pass(reply, await mtRequest(mt, "POST", `/api/repos/${id}/import`, v.pick));
  });
  app.delete("/api/factory/repos/:id", async (req, reply) => {
    await need(req);
    const id = repoId(req);
    if (!id) { reply.code(404); return { error: "No such repository" }; }
    return pass(reply, await mtRequest(mt, "DELETE", `/api/repos/${id}`));
  });
}
