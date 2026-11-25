// Outbound calls to the identity provider (discovery, JWKS, token endpoint) only. On a closed
// network the server may reach login.microsoftonline.com only through an HTTPS proxy:
// OIDC_HTTPS_PROXY, else HTTPS_PROXY / https_proxy (NO_PROXY / no_proxy honoured). The proxy is
// used with CONNECT, so TLS runs end to end between this server and Microsoft and the certificate
// is checked as usual. Nothing else in the apps uses this proxy (API Manager calls stay direct).
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

export interface IdpResponse { status: number; ok: boolean; text(): Promise<string> }
export type IdpFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) => Promise<IdpResponse>;

export function proxyFor(target: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const u = new URL(target);
  const proxy = env.OIDC_HTTPS_PROXY || (u.protocol === "https:" ? env.HTTPS_PROXY || env.https_proxy : env.HTTP_PROXY || env.http_proxy) || "";
  if (!proxy) return null;
  const host = u.hostname.toLowerCase();
  const no = (env.NO_PROXY || env.no_proxy || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const n of no) {
    if (n === "*") return null;
    const bare = n.replace(/^\*?\./, "").replace(/:\d+$/, "");
    if (host === bare || host.endsWith(`.${bare}`)) return null;
  }
  return proxy;
}

function tunnel(proxy: string, host: string, port: number, timeoutMs: number): Promise<import("node:net").Socket> {
  const p = new URL(proxy);
  const headers: Record<string, string> = { Host: `${host}:${port}` };
  if (p.username) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64")}`;
  const lib = p.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({ host: p.hostname, port: p.port || (p.protocol === "https:" ? 443 : 80), method: "CONNECT", path: `${host}:${port}`, headers });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("proxy timed out")));
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`proxy refused the connection (HTTP ${res.statusCode})`)); return; }
      resolve(socket);
    });
    req.on("error", reject);
    req.end();
  });
}

export function createIdpFetch(env: NodeJS.ProcessEnv = process.env): IdpFetch {
  return async (url, init = {}) => {
    const u = new URL(url);
    const secure = u.protocol === "https:";
    const port = Number(u.port || (secure ? 443 : 80));
    const timeoutMs = init.timeoutMs ?? 10_000;
    const proxy = proxyFor(url, env);
    let createConnection: (() => import("node:net").Socket) | undefined;
    if (proxy && secure) {
      const raw = await tunnel(proxy, u.hostname, port, timeoutMs);
      createConnection = () => tls.connect({ socket: raw, servername: u.hostname });
    }
    const lib = secure ? https : http;
    const body = init.body;
    return new Promise<IdpResponse>((resolve, reject) => {
      const opts: https.RequestOptions = {
        method: init.method ?? "GET", hostname: u.hostname, port, path: u.pathname + u.search,
        headers: { ...(init.headers ?? {}), ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}) },
        ...(createConnection ? { createConnection: createConnection as never, agent: false } : {}),
      };
      // Plain-http proxy for an http address (tests / lab only): absolute URL to the proxy.
      if (proxy && !secure) { const p = new URL(proxy); Object.assign(opts, { hostname: p.hostname, port: p.port || 80, path: url }); }
      const req = lib.request(opts, (res) => {
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (c: Buffer) => { size += c.length; if (size > 2 * 1024 * 1024) { req.destroy(new Error("answer too large")); return; } chunks.push(c); });
        res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); const status = res.statusCode ?? 0; resolve({ status, ok: status >= 200 && status < 300, text: async () => text }); });
        res.on("error", reject);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error("timed out")));
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  };
}
