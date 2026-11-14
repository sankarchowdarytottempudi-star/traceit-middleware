// Minimal HTTP client on node:http/https with cluster DNS, timeouts, gzip and an abort signal.
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import type { ClusterDns } from "./dns.js";

export interface HttpCall {
  method: string; url: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  tlsVerify?: boolean;
  ca?: string;                 // PEM bundle to trust for this call (pinned)
  skipHostnameCheck?: boolean; // only together with a pinned ca
  signal?: AbortSignal;
  maxBytes?: number;
}
export interface HttpResult { status: number; headers: Record<string, string>; body: Buffer; ms: number; }

export class HttpClient {
  private agents = new Map<string, http.Agent | https.Agent>();
  constructor(private dns: ClusterDns) {}

  private agent(secure: boolean, c: HttpCall): http.Agent | https.Agent {
    const key = `${secure}|${c.tlsVerify === false}|${c.ca ? "ca" : ""}|${c.skipHostnameCheck ? "nh" : ""}`;
    let a = this.agents.get(key);
    if (!a) {
      const base = { keepAlive: true, maxSockets: 64, lookup: this.dns.lookup as never };
      a = secure
        ? new https.Agent({ ...base, rejectUnauthorized: c.tlsVerify !== false, ...(c.ca ? { ca: c.ca } : {}), ...(c.ca && c.skipHostnameCheck ? { checkServerIdentity: () => undefined } : {}) })
        : new http.Agent(base);
      this.agents.set(key, a);
    }
    return a;
  }

  request(c: HttpCall): Promise<HttpResult> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let u: URL;
      try { u = new URL(c.url); } catch { reject(new Error(`Not a valid URL: ${c.url}`)); return; }
      if (u.protocol !== "http:" && u.protocol !== "https:") { reject(new Error(`Unsupported URL scheme: ${u.protocol}`)); return; }
      const secure = u.protocol === "https:";
      const headers: Record<string, string> = { "accept-encoding": "gzip, deflate", ...(c.headers ?? {}) };
      const body = c.body === undefined ? undefined : Buffer.isBuffer(c.body) ? c.body : Buffer.from(c.body, "utf8");
      if (body) headers["content-length"] = String(body.length);
      const timeoutMs = c.timeoutMs && c.timeoutMs > 0 ? c.timeoutMs : 30_000;
      const max = c.maxBytes ?? 50 * 1024 * 1024;
      let done = false;
      const finish = (err: Error | null, res?: HttpResult) => { if (done) return; done = true; clearTimeout(timer); c.signal?.removeEventListener("abort", onAbort); if (err) reject(err); else resolve(res!); };
      const req = (secure ? https : http).request({
        method: c.method.toUpperCase(), protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || (secure ? 443 : 80),
        path: u.pathname + u.search, headers, agent: this.agent(secure, c),
      }, (res) => {
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (d: Buffer) => { size += d.length; if (size > max) { req.destroy(new Error("Response is larger than the allowed size")); return; } chunks.push(d); });
        res.on("error", (e) => finish(e));
        res.on("end", () => {
          let buf = Buffer.concat(chunks);
          const enc = String(res.headers["content-encoding"] || "").toLowerCase();
          try { if (enc === "gzip") buf = zlib.gunzipSync(buf); else if (enc === "deflate") buf = zlib.inflateSync(buf); else if (enc === "br") buf = zlib.brotliDecompressSync(buf); } catch { /* leave as received */ }
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k] = Array.isArray(v) ? v.join(", ") : String(v);
          finish(null, { status: res.statusCode ?? 0, headers: h, body: buf, ms: Date.now() - started });
        });
      });
      const timer = setTimeout(() => { const e = new Error(`Timed out after ${timeoutMs} ms`); (e as { code?: string }).code = "ETIMEDOUT"; req.destroy(e); finish(e); }, timeoutMs);
      const onAbort = () => { const e = new Error("Cancelled: the flow timed out"); (e as { code?: string }).code = "ETIMEDOUT"; req.destroy(e); finish(e); };
      if (c.signal) { if (c.signal.aborted) { onAbort(); return; } c.signal.addEventListener("abort", onAbort, { once: true }); }
      req.on("error", (e) => finish(e));
      if (body) req.write(body);
      req.end();
    });
  }
}

/** Decodes a response body. "auto" goes by content type. */
export function readBody(res: HttpResult, mode: string = "auto"): unknown {
  const ct = String(res.headers["content-type"] || "").toLowerCase();
  if (res.body.length === 0) return null;
  if (mode === "base64") return res.body.toString("base64");
  const text = res.body.toString("utf8");
  if (mode === "text") return text;
  if (mode === "json") { try { return JSON.parse(text); } catch { throw new Error("Response is not valid JSON"); } }
  if (ct.includes("json") || /^\s*[[{]/.test(text.slice(0, 64))) { try { return JSON.parse(text); } catch { return text; } }
  if (ct.startsWith("text/") || ct.includes("xml") || ct.includes("html") || ct.includes("urlencoded") || ct === "") return text;
  if (/^(image|audio|video)\//.test(ct) || ct.includes("octet-stream") || ct.includes("pdf") || ct.includes("zip")) return res.body.toString("base64");
  return text;
}
