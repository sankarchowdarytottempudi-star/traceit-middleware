// Publishes deployed flows on WSO2 API Manager (Publisher REST v4 + DevPortal REST v3).
//
// The gateway can lose everything it knows (it may run without a persistent database), so
// nothing here trusts a stored id: APIs, the test application, subscriptions and keys are
// looked up by name on every operation and recreated when they are missing. No gateway
// credential or key is written to disk; the OAuth client and tokens live in memory only.
//
// Ownership: every API the runtime creates carries the additional property
// managedBy=weave-runtime. An API without that marker is never updated or deleted, and its
// context is never reused.
import type { Flow, FlowDeployment, HttpRequestSample, InvokeResponse, Json } from "@traceit/weave-flow";
import type { Config } from "../config.js";
import { type HttpClient, type HttpResult, readBody } from "../clients/http.js";
import type { Store } from "../store.js";
import { redact } from "../redact.js";
import { lowerKeys } from "../engine/engine.js";
import { NullGateway, type Gateway, type GatewayPublished } from "./types.js";

const MARK = "managedBy", MARK_VALUE = "weave-runtime", MARK_FLOW = "weaveFlowId";
const SCOPES = "apim:api_view apim:api_create apim:api_publish apim:api_manage apim:api_delete apim:subscription_view apim:subscribe apim:app_manage apim:sub_manage apim:api_key";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ApiInfo { id: string; name: string; context: string; version: string; lifeCycleStatus: string; additionalProperties?: unknown; additionalPropertiesMap?: unknown; }
interface ApiDetail extends ApiInfo { [k: string]: unknown; }
class ApimError extends Error { constructor(message: string, readonly status: number, readonly body?: unknown) { super(message); } }

export function toGatewayPath(p: string): string {
  const parts = ("/" + String(p || "/").replace(/^\/+|\/+$/g, "")).split("/").map((seg) => {
    const m = /^:([A-Za-z_][\w-]*)$/.exec(seg);
    if (m) return `{${m[1]}}`;
    if (seg === "**") return "*";
    return seg;
  });
  return parts.join("/") || "/";
}
export function gatewayOperations(flow: Flow, authType: string): { target: string; verb: string; authType: string; throttlingPolicy: string }[] {
  const seen = new Set<string>(); const out: { target: string; verb: string; authType: string; throttlingPolicy: string }[] = [];
  for (const n of flow.nodes) {
    if (n.type !== "trigger.http" || n.disabled) continue;
    const target = toGatewayPath(String(n.config?.path ?? "/"));
    for (const m of Array.isArray(n.config?.methods) && (n.config.methods as unknown[]).length ? (n.config.methods as unknown[]) : ["GET"]) {
      const verb = String(m).toUpperCase(); const k = `${verb} ${target}`;
      if (seen.has(k)) continue; seen.add(k);
      out.push({ target, verb, authType, throttlingPolicy: "Unlimited" });
    }
  }
  return out;
}
function isMine(a: { additionalProperties?: unknown; additionalPropertiesMap?: unknown }): boolean {
  const ap = a.additionalProperties;
  if (Array.isArray(ap) && ap.some((p) => p && (p as { name?: string }).name === MARK && (p as { value?: string }).value === MARK_VALUE)) return true;
  if (ap && typeof ap === "object" && !Array.isArray(ap)) { const v = (ap as Record<string, unknown>)[MARK]; if (v === MARK_VALUE || (v && typeof v === "object" && (v as { value?: string }).value === MARK_VALUE)) return true; }
  const map = a.additionalPropertiesMap as Record<string, { value?: string }> | undefined;
  return !!map && typeof map === "object" && map[MARK]?.value === MARK_VALUE;
}
const stripVersion = (context: string, version: string) => { const c = "/" + String(context || "").replace(/^\/+|\/+$/g, ""); return version && c.toLowerCase().endsWith("/" + version.toLowerCase()) ? c.slice(0, -(version.length + 1)) : c; };

export class ApimGateway implements Gateway {
  readonly enabled = true;
  private client?: { id: string; secret: string };
  private tok?: { value: string; until: number };
  private appTok?: { value: string; until: number; key: string };
  private foreign = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private cfg: Config, private http: HttpClient, private store: Store) {}

  apiName(flow: Flow) { return `${this.cfg.apiNamePrefix}${flow.slug}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 60); }
  private context(flow: Flow) { return "/" + String(flow.settings?.gateway?.context || "/" + flow.slug).replace(/^\/+|\/+$/g, ""); }
  private version(flow: Flow) { return String(flow.settings?.gateway?.version || "v1"); }
  reservedContexts() { return [...this.foreign]; }

  // ------------------------------------------------------------------ HTTP plumbing
  private tls() { return this.cfg.apimCaPem ? { tlsVerify: true, ca: this.cfg.apimCaPem, skipHostnameCheck: true } : { tlsVerify: true }; }
  private async raw(method: string, url: string, headers: Record<string, string>, body?: string, timeoutMs = 45_000): Promise<HttpResult> {
    return this.http.request({ method, url, headers, body, timeoutMs, ...this.tls() });
  }
  private parse(r: HttpResult): unknown { try { return readBody(r); } catch { return r.body.toString("utf8"); } }
  private fail(what: string, r: HttpResult): never {
    const b = this.parse(r) as { description?: string; message?: string; error_description?: string } | string | null;
    const why = b && typeof b === "object" ? b.description || b.message || b.error_description || "" : typeof b === "string" ? b.slice(0, 300) : "";
    throw new ApimError(`${what}: the gateway answered ${r.status}${why ? ` (${String(redact(why))})` : ""}`, r.status, b);
  }
  private async register(): Promise<{ id: string; secret: string }> {
    if (this.client) return this.client;
    const r = await this.raw("POST", `${this.cfg.apimBaseUrl}/client-registration/v0.17/register`, {
      authorization: "Basic " + Buffer.from(`${this.cfg.apimUser}:${this.cfg.apimPass}`).toString("base64"), "content-type": "application/json",
    }, JSON.stringify({ clientName: "weave-runtime", owner: this.cfg.apimUser, grantType: "password refresh_token", saasApp: true, callbackUrl: "https://localhost" }));
    if (r.status >= 300) this.fail("Registering the runtime with the gateway failed", r);
    const j = this.parse(r) as { clientId?: string; clientSecret?: string };
    if (!j?.clientId || !j.clientSecret) throw new ApimError("Registering the runtime with the gateway returned no client", r.status);
    this.client = { id: j.clientId, secret: j.clientSecret };
    return this.client;
  }
  private async token(): Promise<string> {
    if (this.tok && this.tok.until > Date.now()) return this.tok.value;
    const c = await this.register();
    const form = new URLSearchParams({ grant_type: "password", username: this.cfg.apimUser, password: this.cfg.apimPass, scope: SCOPES });
    const r = await this.raw("POST", `${this.cfg.apimBaseUrl}/oauth2/token`, { authorization: "Basic " + Buffer.from(`${c.id}:${c.secret}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" }, form.toString());
    if (r.status >= 300) { this.client = undefined; this.fail("Signing in to the gateway failed", r); }
    const j = this.parse(r) as { access_token?: string; expires_in?: number };
    if (!j?.access_token) throw new ApimError("Signing in to the gateway returned no token", r.status);
    this.tok = { value: j.access_token, until: Date.now() + Math.max(30, (j.expires_in ?? 3600) - 60) * 1000 };
    return this.tok.value;
  }
  private async call<T = unknown>(what: string, method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const at = await this.token();
      const r = await this.raw(method, `${this.cfg.apimBaseUrl}${path}`, { authorization: `Bearer ${at}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body !== undefined ? JSON.stringify(body) : undefined);
      if (r.status === 401 && attempt === 0) { this.tok = undefined; this.client = undefined; continue; }   // the gateway forgot our client or token
      if (r.status < 300 || okStatuses.includes(r.status)) return this.parse(r) as T;
      this.fail(what, r);
    }
  }
  private pub<T = unknown>(what: string, method: string, path: string, body?: unknown, ok: number[] = []) { return this.call<T>(what, method, `/api/am/publisher/v4${path}`, body, ok); }
  private dev<T = unknown>(what: string, method: string, path: string, body?: unknown, ok: number[] = []) { return this.call<T>(what, method, `/api/am/devportal/v3${path}`, body, ok); }
  /** Gateway changes run one at a time: two publishes at once would race on the shared test application. */
  private serial<T>(fn: () => Promise<T>): Promise<T> { const p = this.chain.then(fn, fn); this.chain = p.catch(() => undefined); return p; }

  // ------------------------------------------------------------------ lookups
  async reachable(): Promise<boolean> {
    try { const r = await this.raw("GET", `${this.cfg.apimBaseUrl}/api/am/devportal/v3/apis?limit=1`, { accept: "application/json" }, undefined, 6000); return r.status < 500; } catch { return false; }
  }
  private async listApis(): Promise<ApiInfo[]> {
    const out: ApiInfo[] = [];
    for (let offset = 0; offset < 5000; offset += 200) {
      const j = await this.pub<{ list?: ApiInfo[]; pagination?: { total?: number } }>("Listing the APIs on the gateway failed", "GET", `/apis?limit=200&offset=${offset}`);
      const list = j?.list ?? [];
      out.push(...list);
      if (list.length < 200) break;
    }
    return out;
  }
  /** One list call; also refreshes the set of contexts that belong to APIs we did not create. */
  private async survey(): Promise<{ all: ApiInfo[]; mine: ApiInfo[] }> {
    const all = await this.listApis();
    const prefix = this.cfg.apiNamePrefix;
    // The list view may not carry additional properties, so "mine" is by name here and confirmed
    // against the full API (marker) before anything is changed or deleted.
    const mine = all.filter((a) => isMine(a) || a.name.startsWith(prefix));
    this.foreign = new Set(all.filter((a) => !mine.includes(a)).map((a) => stripVersion(a.context, a.version)));
    return { all, mine };
  }
  async present() {
    const { mine } = await this.survey();
    const m = new Map<string, { id: string; context: string; version: string; lifeCycleStatus: string }>();
    for (const a of mine) m.set(a.name, { id: a.id, context: stripVersion(a.context, a.version), version: a.version, lifeCycleStatus: a.lifeCycleStatus });
    return m;
  }
  private async detail(id: string): Promise<ApiDetail> { return this.pub<ApiDetail>("Reading the API from the gateway failed", "GET", `/apis/${id}`); }

  // ------------------------------------------------------------------ publish
  publish(flow: Flow): Promise<GatewayPublished> { return this.serial(() => this.doPublish(flow)); }
  private async doPublish(flow: Flow): Promise<GatewayPublished> {
    const name = this.apiName(flow), context = this.context(flow), version = this.version(flow);
    const secured = flow.settings?.gateway?.security !== "none";
    const operations = gatewayOperations(flow, secured ? "Application & Application User" : "None");
    if (!operations.length) throw new Error("The flow has no HTTP Listener to publish");
    if (!this.cfg.gatewayBackendUrl) throw new Error("GATEWAY_BACKEND_URL is not set, so the gateway would have no way to reach the runtime");
    const backend = `${this.cfg.gatewayBackendUrl}/run${"/" + String(flow.settings.basePath).replace(/^\/+|\/+$/g, "")}`.replace(/\/$/, "");
    const { all } = await this.survey();
    const clash = all.find((a) => a.name !== name && stripVersion(a.context, a.version).toLowerCase() === context.toLowerCase());
    if (clash) throw new Error(`The gateway context ${context} is already used by the API "${clash.name}"; choose another context in the flow settings`);
    const policy = String(flow.settings?.gateway?.throttlingPolicy || "Unlimited");
    const desired: Record<string, unknown> = {
      name, context, version, type: "HTTP", transport: ["http", "https"],
      description: `Weave flow "${flow.name}". Managed by the Weave runtime: changes made here are overwritten on the next deploy.`,
      endpointConfig: { endpoint_type: "http", production_endpoints: { url: backend }, sandbox_endpoints: { url: backend } },
      policies: ["Unlimited"], operations, securityScheme: ["oauth2", "oauth_basic_auth_api_key_mandatory"],
      apiThrottlingPolicy: policy === "Unlimited" ? null : policy,
      additionalProperties: [{ name: MARK, value: MARK_VALUE, display: false }, { name: MARK_FLOW, value: flow.id, display: false }],
    };
    let existing = all.find((a) => a.name === name);
    let api: ApiDetail | undefined;
    if (existing) {
      const d = await this.detail(existing.id);
      if (!isMine(d)) throw new Error(`An API called "${name}" already exists on the gateway and was not created by Weave; it is left untouched. Rename the flow's slug or change APIM_API_NAME_PREFIX.`);
      if (stripVersion(String(d.context), String(d.version)).toLowerCase() !== context.toLowerCase() || String(d.version) !== version) {
        await this.deleteApi(d.id);      // context and version cannot be changed in place
        existing = undefined;
      } else {
        api = await this.pub<ApiDetail>("Updating the API on the gateway failed", "PUT", `/apis/${d.id}`, { ...d, ...desired, context: d.context });
      }
    }
    if (!existing) api = await this.pub<ApiDetail>("Creating the API on the gateway failed", "POST", "/apis", desired);
    const apiId = api!.id;

    // A revision is what actually reaches the gateway. At most 5 are kept per API.
    const revs = await this.pub<{ list?: { id: string; createdTime?: number | string; deploymentInfo?: unknown[] }[] }>("Listing API revisions failed", "GET", `/apis/${apiId}/revisions`);
    const list = [...(revs?.list ?? [])].sort((a, b) => Number(new Date(a.createdTime ?? 0)) - Number(new Date(b.createdTime ?? 0)));
    const removable = list.filter((r) => !(Array.isArray(r.deploymentInfo) && r.deploymentInfo.length));
    for (let n = list.length; n >= 4 && removable.length; n--) { const r = removable.shift()!; await this.pub("Removing an old API revision failed", "DELETE", `/apis/${apiId}/revisions/${r.id}`, undefined, [404]); }
    const rev = await this.pub<{ id: string }>("Creating an API revision failed", "POST", `/apis/${apiId}/revisions`, { description: `Weave flow revision ${flow.revision}` });
    await this.pub("Deploying the API revision failed", "POST", `/apis/${apiId}/deploy-revision?revisionId=${rev.id}`, [{ name: "Default", vhost: "localhost", displayOnDevportal: true }]);
    const now = await this.detail(apiId);
    if (now.lifeCycleStatus !== "PUBLISHED") await this.pub("Publishing the API failed", "POST", `/apis/change-lifecycle?apiId=${apiId}&action=Publish`);

    const appId = await this.ensureApp();
    await this.ensureSubscription(appId, apiId);
    await this.ensureKeys(appId);
    this.store.setState("gateway", { lastPublishAt: new Date().toISOString(), lastApi: name });
    return { apiId, name, context, version, url: `${this.cfg.gatewayPublicUrl}${context}/${version}` };
  }
  private async ensureApp(): Promise<string> {
    const name = this.cfg.apimTestApp;
    const found = await this.dev<{ list?: { applicationId: string; name: string }[] }>("Looking up the test application failed", "GET", `/applications?query=${encodeURIComponent(name)}&limit=100`);
    const hit = (found?.list ?? []).find((a) => a.name === name);
    if (hit) return hit.applicationId;
    const made = await this.dev<{ applicationId: string }>("Creating the test application failed", "POST", "/applications", { name, throttlingPolicy: "Unlimited", description: "Used by Weave Studio to call published flows through the gateway", tokenType: "JWT" });
    return made.applicationId;
  }
  private async ensureSubscription(appId: string, apiId: string): Promise<void> {
    const subs = await this.dev<{ list?: { subscriptionId: string; apiId: string }[] }>("Listing subscriptions failed", "GET", `/subscriptions?applicationId=${appId}&limit=500`);
    if ((subs?.list ?? []).some((s) => s.apiId === apiId)) return;
    // The API becomes visible to the developer portal a moment after it is published.
    for (let i = 0; ; i++) {
      try { await this.dev("Subscribing the test application failed", "POST", "/subscriptions", { apiId, applicationId: appId, throttlingPolicy: "Unlimited" }); return; }
      catch (e) { if (i >= 5 || !(e instanceof ApimError) || ![400, 404, 409, 500].includes(e.status)) throw e; if (e.status === 409) return; await sleep(1500); }
    }
  }
  private async ensureKeys(appId: string): Promise<{ key: string; secret: string }> {
    const read = async () => {
      const keys = await this.dev<{ list?: { keyType: string; consumerKey?: string; consumerSecret?: string }[] }>("Reading the test application keys failed", "GET", `/applications/${appId}/oauth-keys`);
      const k = (keys?.list ?? []).find((x) => x.keyType === "PRODUCTION" && x.consumerKey && x.consumerSecret);
      return k ? { key: k.consumerKey!, secret: k.consumerSecret! } : undefined;
    };
    const have = await read();
    if (have) return have;
    const made = await this.dev<{ consumerKey?: string; consumerSecret?: string }>("Generating keys for the test application failed", "POST", `/applications/${appId}/generate-keys`,
      { keyType: "PRODUCTION", keyManager: "Resident Key Manager", grantTypesToBeSupported: ["client_credentials"], callbackUrl: "", validityTime: 3600, scopes: ["default"] });
    if (made?.consumerKey && made.consumerSecret) return { key: made.consumerKey, secret: made.consumerSecret };
    const again = await read();
    if (!again) throw new Error("The gateway did not return keys for the test application");
    return again;
  }

  // ------------------------------------------------------------------ remove
  remove(flow: Flow): Promise<void> { return this.serial(() => this.doRemove(flow)); }
  private async doRemove(flow: Flow): Promise<void> {
    const name = this.apiName(flow);
    const { all } = await this.survey();
    const hit = all.find((a) => a.name === name);
    if (!hit) return;
    const d = await this.detail(hit.id);
    if (!isMine(d)) return;               // not ours: never touched
    await this.deleteApi(d.id);
  }
  private async deleteApi(apiId: string): Promise<void> {
    const subs = await this.dev<{ list?: { subscriptionId: string }[] }>("Listing subscriptions failed", "GET", `/subscriptions?apiId=${apiId}&limit=500`, undefined, [404]);
    for (const s of subs?.list ?? []) await this.dev("Removing a subscription failed", "DELETE", `/subscriptions/${s.subscriptionId}`, undefined, [404]);
    const revs = await this.pub<{ list?: { id: string; deploymentInfo?: { name: string; vhost: string }[] }[] }>("Listing API revisions failed", "GET", `/apis/${apiId}/revisions`, undefined, [404]);
    for (const r of revs?.list ?? []) {
      if (Array.isArray(r.deploymentInfo) && r.deploymentInfo.length) await this.pub("Undeploying the API revision failed", "POST", `/apis/${apiId}/undeploy-revision?revisionId=${r.id}`, r.deploymentInfo.map((x) => ({ name: x.name, vhost: x.vhost, displayOnDevportal: false })), [404]);
    }
    await this.pub("Deleting the API from the gateway failed", "DELETE", `/apis/${apiId}`, undefined, [404]);
  }

  // ------------------------------------------------------------------ invoke
  private async appToken(force = false): Promise<string> {
    const appId = await this.ensureApp();
    const keys = await this.ensureKeys(appId);
    if (!force && this.appTok && this.appTok.key === keys.key && this.appTok.until > Date.now()) return this.appTok.value;
    const r = await this.raw("POST", `${this.cfg.apimBaseUrl}/oauth2/token`, { authorization: "Basic " + Buffer.from(`${keys.key}:${keys.secret}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" }, "grant_type=client_credentials");
    if (r.status >= 300) this.fail("Getting a token for the test application failed", r);
    const j = this.parse(r) as { access_token?: string; expires_in?: number };
    if (!j?.access_token) throw new Error("The gateway returned no token for the test application");
    this.appTok = { value: j.access_token, key: keys.key, until: Date.now() + Math.max(20, (j.expires_in ?? 3600) - 60) * 1000 };
    return this.appTok.value;
  }
  async invoke(flow: Flow, dep: FlowDeployment, rq: HttpRequestSample): Promise<InvokeResponse> {
    if (!this.cfg.gatewayPublicUrl) throw new Error("GATEWAY_PUBLIC_URL is not set");
    const context = dep.gateway?.context || this.context(flow), version = dep.gateway?.version || this.version(flow);
    const rawPath = String(rq.path || "/");
    const url = new URL(`${this.cfg.gatewayPublicUrl}${context}/${version}${("/" + rawPath.split("?")[0].replace(/^\/+/, "")).replace(/\/$/, "")}`);
    if (rawPath.includes("?")) for (const [k, v] of new URLSearchParams(rawPath.slice(rawPath.indexOf("?") + 1))) url.searchParams.append(k, v);
    for (const [k, v] of Object.entries(rq.query ?? {})) url.searchParams.set(k, String(v));
    const method = String(rq.method || "GET").toUpperCase();
    const headers = lowerKeys(rq.headers ?? {});
    let body: string | undefined;
    if (rq.body !== undefined && rq.body !== null && !["GET", "HEAD"].includes(method)) {
      body = typeof rq.body === "string" ? rq.body : JSON.stringify(rq.body);
      if (!headers["content-type"]) headers["content-type"] = typeof rq.body === "string" ? "text/plain" : "application/json";
    }
    const secured = flow.settings?.gateway?.security !== "none";
    let res: HttpResult | undefined; const started = Date.now();
    // A fresh API, subscription or token takes a few seconds to reach the gateway; answers that did
    // not come from the runtime (no execution id) are retried briefly.
    for (let attempt = 0; attempt < 6; attempt++) {
      if (secured) headers.authorization = `Bearer ${await this.appToken(attempt === 3)}`;
      res = await this.raw(method, url.toString(), headers, body, (flow.settings.timeoutMs ?? 60000) + 10_000);
      if (res.headers["x-weave-execution-id"] || ![401, 403, 404, 503].includes(res.status)) break;
      await sleep(1500);
    }
    const r = res!;
    const shown = { ...headers }; if (shown.authorization) shown.authorization = "Bearer <token>";
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const curl = ["curl", "-sS", "-k", "-X", method, q(url.toString()), ...Object.entries(redact(shown) as Record<string, string>).flatMap(([k, v]) => ["-H", q(`${k}: ${k === "authorization" ? "Bearer <token>" : v}`)]), ...(body !== undefined ? ["--data", q(body.length > 2000 ? body.slice(0, 2000) + "..." : body)] : [])].join(" ");
    return { status: r.status, headers: redact(r.headers) as Record<string, string>, body: this.parse(r) as Json, ms: Date.now() - started, url: url.toString(), executionId: r.headers["x-weave-execution-id"], curl };
  }
}

export function createGateway(cfg: Config, http: HttpClient, store: Store): Gateway {
  if (!cfg.apimBaseUrl || !cfg.apimUser || !cfg.apimPass) return new NullGateway();
  return new ApimGateway(cfg, http, store);
}
