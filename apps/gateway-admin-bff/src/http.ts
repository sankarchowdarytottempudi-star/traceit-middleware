// Small outbound HTTP helper for the internal, read-only data sources (Kubernetes API,
// Prometheus, Weave runtime). All of them live on this server or its cluster network.
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export interface HttpResult { status: number; text: string; truncated: boolean; }
export interface HttpOpts {
  method?: string; headers?: Record<string, string>; body?: string;
  ca?: string; timeoutMs?: number; maxBytes?: number;
  /** Client certificate and key (PEM) and certificate checking, for a kubeconfig user (kubeconfig.ts). */
  cert?: string; key?: string; rejectUnauthorized?: boolean;
}

export function httpRequest(url: string, o: HttpOpts = {}): Promise<HttpResult> {
  const u = new URL(url);
  const secure = u.protocol === "https:";
  const lib = secure ? https : http;
  const maxBytes = o.maxBytes ?? 32 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method: o.method ?? "GET", hostname: u.hostname, port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search, headers: o.headers,
      ...(secure && o.ca ? { ca: o.ca } : {}),
      ...(secure && o.cert && o.key ? { cert: o.cert, key: o.key } : {}),
      ...(secure && o.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      const chunks: Buffer[] = []; let size = 0; let truncated = false;
      res.on("data", (c: Buffer) => {
        if (truncated) return;
        size += c.length;
        if (size > maxBytes) { truncated = true; chunks.push(c.subarray(0, c.length - (size - maxBytes))); res.destroy(); finish(); return; }
        chunks.push(c);
      });
      let done = false;
      function finish() { if (done) return; done = true; resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), truncated }); }
      res.on("end", finish);
      res.on("close", finish);
      res.on("error", (e) => { if (!done) { done = true; reject(e); } });
    });
    req.setTimeout(o.timeoutMs ?? 10_000, () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

export async function httpJson<T = any>(url: string, o: HttpOpts = {}): Promise<T> {
  const r = await httpRequest(url, o);
  if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return JSON.parse(r.text) as T;
}

/** Short, safe reason for a failed call (never includes URLs with credentials or response bodies). */
export function reason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/ECONNREFUSED/.test(m)) return "connection refused";
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return "host not found";
  if (/timed out|ETIMEDOUT/.test(m)) return "timed out";
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return "not reachable";
  if (/^HTTP \d+$/.test(m)) return m;
  if (/certificate|self.signed|CERT_/i.test(m)) return "TLS certificate not trusted";
  return "request failed";
}
