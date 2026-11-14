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
  if (data) headers["Content-Type"] = "application/json";
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
    if (data) req.write(data);
    req.end();
  });
}
