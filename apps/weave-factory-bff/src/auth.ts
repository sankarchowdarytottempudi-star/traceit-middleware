import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import type { SessionStore } from "./sessionStore.js";
import { authorizeUrl, exchangeCode, passwordGrant, refreshToken, type TokenSet } from "./wso2.js";
import { registerAccess, type Access, type Principal, type Rule } from "./access/plugin.js";
import { productName, readAuthSettings, type AuthSettings } from "./access/settings.js";
import { cachedServiceToken } from "./access/serviceToken.js";
import { cleanRoles } from "./access/roles.js";

export interface ClientCreds { clientId: string; clientSecret: string; callbackUrl?: string; }

/** The path this app is served under, taken from its public address: "" or e.g. "/factory". */
export function basePath(publicBaseUrl: string): string {
  try { return new URL(publicBaseUrl).pathname.replace(/\/+$/, ""); } catch { return ""; }
}
// Its own name: under a shared address the Gateway keeps a cookie called "sid" for the whole host.
export const SID_COOKIE = "weave_factory_sid";
/** The session id a request carries, or "". */
export function sidOf(req: { cookies: Record<string, string | undefined>; unsignCookie(v: string): { value: string | null } }): string {
  return req.unsignCookie(req.cookies[SID_COOKIE] ?? "").value || "";
}

export type Role = "admin" | "viewer";
/** Admin when the sign-in granted `apim:admin`: WSO2 only grants a scope the user's roles allow.
 *  Read from the token answer, or from the access token itself when the answer had no scope. */
export function roleOfTokens(t: Pick<TokenSet, "scope" | "access_token"> | undefined): Role {
  if (!t) return "viewer";
  let scope = t.scope || "";
  if (!scope) {
    try { const [, body] = t.access_token.split("."); if (body) { const s = JSON.parse(Buffer.from(body, "base64url").toString()).scope; scope = Array.isArray(s) ? s.join(" ") : String(s || ""); } } catch { scope = ""; }
  }
  return scope.split(/\s+/).includes("apim:admin") ? "admin" : "viewer";
}

/** "admin" may switch APIs on and off on the gateway. API Manager sign-in: its apim:admin scope.
 *  Microsoft and Weave accounts: people who also have the Gateway console role. */
export function switchRoleOf(p: Principal): Role {
  if (p.dev) return process.env.DEV_AUTH_ROLE === "viewer" ? "viewer" : "admin";
  if (p.provider === "wso2") return roleOfTokens(p.session?.tokens);
  return p.roles.includes("gateway") ? "admin" : "viewer";
}

/** What each Factory address needs. The review workbench has its own Zoho sign-in. */
export function factoryRule(path: string): Rule {
  if (path.startsWith("/api/auth/") || path === "/api/review" || path.startsWith("/api/review/")) return "public";
  return "migration";
}

const SCOPE = "openid apim:admin apim:api_view apim:api_manage apim:tier_view apim:tier_manage apim:admin_settings apim:environment_manage " +
  "apim:environment_read apim:keymanagers_manage apim:workflow_approve apim:api_governance_view apim:api_governance_manage";

export function registerAuth(app: FastifyInstance, cfg: Config, creds: ClientCreds, store: SessionStore, settings?: AuthSettings): Access {
  const redirectUri = `${cfg.PUBLIC_BASE_URL.replace(/\/+$/, "")}/api/auth/callback`;
  const base = basePath(cfg.PUBLIC_BASE_URL);
  const w = { baseUrl: cfg.APIM_BASE_URL, caPem: cfg.caPem }; // server-side (localhost; cert CN matches)
  const publicBase = cfg.APIM_PUBLIC_URL; // browser-facing only
  const serviceToken = cachedServiceToken(() => passwordGrant(w, creds.clientId, creds.clientSecret, cfg.APIM_DCR_USERNAME, cfg.APIM_DCR_PASSWORD, SCOPE));

  const devUser = process.env.HOST === "127.0.0.1" ? (process.env.DEV_AUTH_USER || "") : "";
  const access = registerAccess(app, {
    app: "factory", area: "Factory", product: productName(process.env),
    cookieName: SID_COOKIE, basePath: base, store, settings: settings ?? readAuthSettings(process.env, cfg.PUBLIC_BASE_URL),
    wso2: {
      authorizeUrl: (state, challenge) => authorizeUrl(publicBase, creds.clientId, redirectUri, challenge, state, SCOPE),
      exchange: (code, verifier) => exchangeCode(w, creds.clientId, creds.clientSecret, code, redirectUri, verifier),
      refresh: (rt) => refreshToken(w, creds.clientId, creds.clientSecret, rt),
      serviceToken,
    },
    rule: factoryRule,
    devUser, devRoles: process.env.DEV_AUTH_ROLES !== undefined ? cleanRoles(process.env.DEV_AUTH_ROLES) : undefined,
    devToken: async () => "dev-token",
    legacyRole: switchRoleOf,
  });
  app.decorate("tokenFor", access.tokenFor);
  /** Signed-in user name for a request, or null. Use this to guard every /api route. */
  app.decorate("userFor", async (req: FastifyRequest): Promise<string | null> => (await access.principal(req))?.user ?? null);
  /** Role of the signed-in user (null when not signed in). The dev instance can play a viewer with DEV_AUTH_ROLE=viewer. */
  app.decorate("roleFor", async (req: FastifyRequest): Promise<Role | null> => {
    const p = await access.principal(req);
    return p ? switchRoleOf(p) : null;
  });
  app.decorate("access", access);
  return access;
}
