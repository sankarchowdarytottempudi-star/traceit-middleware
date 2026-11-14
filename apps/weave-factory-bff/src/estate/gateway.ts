// Which estate APIs are published on the WSO2 gateway (read-only calls to the Publisher API).
import https from "node:https";
import { URL } from "node:url";
import { api as wso2Api, type Wso2Opts } from "../wso2.js";

export interface GatewayEntry { id: string; name: string; context: string; version: string; published: boolean; status: string; endpoint?: string; }
export interface GatewayAuth { clientId: string; clientSecret: string; username: string; password: string; }

function post(opts: Wso2Opts, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  const u = new URL(opts.baseUrl + path);
  return new Promise((resolve, reject) => {
    const req = https.request({ method: "POST", hostname: u.hostname, port: u.port, path: u.pathname, headers, agent: new https.Agent(opts.caPem ? { ca: opts.caPem } : {}), timeout: 8000 }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("timeout", () => req.destroy(new Error("The gateway did not answer in time")));
    req.on("error", reject);
    req.end(body);
  });
}

export class GatewayCatalog {
  private cached?: { at: number; entries: GatewayEntry[] };
  private service?: { token: string; until: number };
  private lastError = "";
  constructor(private opts: Wso2Opts, private auth?: GatewayAuth) {}

  /** A server-side read-only token (scope apim:api_view), used when the signed-in user's token cannot list APIs. */
  private async serviceToken(): Promise<string | null> {
    if (this.service && this.service.until > Date.now()) return this.service.token;
    const a = this.auth;
    if (!a || !a.clientId || !a.username || !a.password) return null;
    const basic = Buffer.from(`${a.clientId}:${a.clientSecret}`).toString("base64");
    const r = await post(this.opts, "/oauth2/token", { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      new URLSearchParams({ grant_type: "password", username: a.username, password: a.password, scope: "apim:api_view" }).toString());
    if (r.status >= 400) return null;
    const j = JSON.parse(r.text) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    this.service = { token: j.access_token, until: Date.now() + Math.max(60, (j.expires_in || 300) - 60) * 1000 };
    return j.access_token;
  }

  private async load(token: string): Promise<GatewayEntry[] | null> {
    const r = await wso2Api(this.opts, token, "GET", "/api/am/publisher/v4/apis?limit=200");
    if (r.status >= 400 || !Array.isArray(r.json?.list)) return null;
    const entries: GatewayEntry[] = [];
    for (const a of r.json.list as any[]) {
      const e: GatewayEntry = { id: a.id, name: a.name, context: a.context, version: a.version, status: a.lifeCycleStatus || "", published: a.lifeCycleStatus === "PUBLISHED" };
      try {
        const d = await wso2Api(this.opts, token, "GET", `/api/am/publisher/v4/apis/${encodeURIComponent(a.id)}`);
        const ep = d.json?.endpointConfig;
        const url = ep?.production_endpoints?.url || ep?.sandbox_endpoints?.url;
        if (typeof url === "string") e.endpoint = url;
      } catch { /* keep the summary */ }
      entries.push(e);
    }
    return entries;
  }

  async entries(userToken?: string | null): Promise<{ entries: GatewayEntry[]; known: boolean; error?: string }> {
    if (this.cached && Date.now() - this.cached.at < 60_000) return { entries: this.cached.entries, known: true };
    try {
      let list: GatewayEntry[] | null = null;
      if (userToken && userToken !== "dev-token") list = await this.load(userToken);
      if (!list) { const t = await this.serviceToken(); if (t) list = await this.load(t); }
      if (list) { this.cached = { at: Date.now(), entries: list }; return { entries: list, known: true }; }
      this.lastError = "The gateway did not let the Factory list its APIs";
    } catch (e) { this.lastError = e instanceof Error ? e.message : "The gateway is not reachable"; }
    if (this.cached) return { entries: this.cached.entries, known: true };
    return { entries: [], known: false, error: this.lastError };
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The gateway entry that fronts a service: by endpoint host or NodePort first, then by name or context. */
export function matchGateway(entries: GatewayEntry[], api: string, nodePort?: number, basePath?: string): GatewayEntry | undefined {
  const scored = entries.map((e) => {
    let score = 0;
    const ep = (e.endpoint || "").toLowerCase();
    if (ep) {
      try {
        const u = new URL(ep);
        if (u.hostname.split(".")[0] === api.toLowerCase()) score = 5;
        else if (nodePort && u.port === String(nodePort)) score = 5;
        else if (u.pathname.split("/").includes(api.toLowerCase())) score = 4;
      } catch { /* not a URL */ }
    }
    if (!score && norm(e.name) === norm(api)) score = 3;
    if (!score && norm(e.context.split("/").filter(Boolean)[0] || "") === norm(api)) score = 2;
    if (!score && basePath && e.context.replace(/\/+$/, "") === basePath.replace(/\/+$/, "")) score = 1;
    return { e, score: score + (e.published ? 0.5 : 0) };
  }).filter((x) => x.score >= 1).sort((a, b) => b.score - a.score);
  return scored[0]?.e;
}
