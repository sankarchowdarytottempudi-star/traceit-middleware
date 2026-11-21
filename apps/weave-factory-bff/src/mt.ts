// Client for the EXISTING migration-tool control-plane backend. The BFF holds the admin token
// (X-Admin-Token from MT_ADMIN_TOKEN); the browser never sees it. We do NOT reimplement the engine.
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export interface MtClient { base: string; token: string; }

export function mtRequest(c: MtClient, method: string, path: string, body?: unknown):
  Promise<{ status: number; json: unknown }> {
  const u = new URL(path.startsWith("http") ? path : c.base + path);
  const data = body === undefined ? undefined : JSON.stringify(body);
  const lib = u.protocol === "https:" ? https : http;
  const headers: Record<string, string> = { "X-Admin-Token": c.token, Accept: "application/json" };
  // The migration tool reads exactly Content-Length bytes and does not understand chunked bodies,
  // so the length must always be stated; without it every JSON body arrives there empty.
  if (data !== undefined) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(data)); }
  return new Promise((resolve, reject) => {
    const req = lib.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      let text = "";
      res.on("data", (ch) => (text += ch));
      res.on("end", () => {
        let json: unknown = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

/** Send a file to the migration tool as it arrives (never buffered here). */
export function mtUpload(c: MtClient, path: string, headers: Record<string, string>, body: NodeJS.ReadableStream, length?: number):
  Promise<{ status: number; json: unknown }> {
  const u = new URL(c.base + path);
  const lib = u.protocol === "https:" ? https : http;
  const h: Record<string, string> = { ...headers, "X-Admin-Token": c.token, Accept: "application/json", "Content-Type": "application/octet-stream" };
  if (length !== undefined) h["Content-Length"] = String(length);
  return new Promise((resolve, reject) => {
    const req = lib.request({ method: "POST", hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h }, (res) => {
      let text = "";
      res.on("data", (ch) => (text += ch));
      res.on("end", () => {
        let json: unknown = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    body.on("error", (e) => req.destroy(e as Error));
    body.pipe(req);
  });
}

/** Fetch a document exactly as the migration tool serves it. */
export function mtRaw(c: MtClient, path: string): Promise<{ status: number; contentType: string; body: Buffer; disposition?: string }> {
  const u = new URL(c.base + path);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({ method: "GET", hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { "X-Admin-Token": c.token } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (ch: Buffer) => chunks.push(ch));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers["content-type"] || "text/plain"), body: Buffer.concat(chunks), disposition: String(res.headers["content-disposition"] || "") }));
    });
    req.on("error", reject);
    req.end();
  });
}
