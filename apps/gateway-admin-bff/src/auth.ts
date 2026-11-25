import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import type { SessionStore } from "./sessionStore.js";
import { authorizeUrl, exchangeCode, passwordGrant, refreshToken } from "./wso2.js";
import { registerAccess, type Access, type Rule } from "./access/plugin.js";
import { productName, readAuthSettings, type AuthSettings } from "./access/settings.js";
import { cachedServiceToken } from "./access/serviceToken.js";
import { cleanRoles } from "./access/roles.js";

export interface ClientCreds { clientId: string; clientSecret: string; }

const SCOPE = "openid apim:admin apim:api_view apim:api_manage apim:tier_view apim:tier_manage apim:admin_settings apim:environment_manage " +
  "apim:environment_read apim:keymanagers_manage apim:workflow_approve apim:api_governance_view apim:api_governance_manage " +
  // gateway rules: publish revisions, consumer applications/keys/subscriptions, blocking rules, API-specific policies
  "apim:api_create apim:api_publish apim:subscribe apim:app_manage apim:sub_manage apim:subscription_view apim:subscription_block " +
  "apim:bl_view apim:bl_manage apim:common_operation_policy_view apim:api_key " +
  // governance results, policies and rulesets (API Manager 4.5)
  "apim:gov_policy_read apim:gov_rule_read apim:gov_result_read apim:gov_policy_manage";

/** What each Gateway address needs. Users and access: admin; everything else under /api: gateway. */
export function gatewayRule(path: string): Rule {
  if (path.startsWith("/api/auth/")) return "public";
  if (path.startsWith("/api/access/")) return "admin";
  return "gateway";
}

export function registerAuth(app: FastifyInstance, cfg: Config, creds: ClientCreds, store: SessionStore, settings?: AuthSettings): Access {
  const redirectUri = `${cfg.PUBLIC_BASE_URL}/api/auth/callback`;
  const w = { baseUrl: cfg.APIM_BASE_URL, caPem: cfg.caPem }; // server-side (localhost; cert CN matches)
  const publicBase = cfg.APIM_PUBLIC_URL; // browser-facing only

  // Service-account token (APIM_DCR user, password grant): used by the loopback dev mode and for
  // people who sign in with Microsoft or a Weave account (they are not API Manager users).
  const serviceToken = cachedServiceToken(() => passwordGrant(w, creds.clientId, creds.clientSecret, cfg.APIM_DCR_USERNAME, cfg.APIM_DCR_PASSWORD, SCOPE));

  // Loopback dev mode (automated UI tests): only when bound to 127.0.0.1 AND DEV_AUTH_USER is set.
  // index.ts refuses to start with DEV_AUTH_USER on any other host. DEV_AUTH_ROLES narrows the roles.
  const devUser = process.env.HOST === "127.0.0.1" ? (process.env.DEV_AUTH_USER || "") : "";
  const access = registerAccess(app, {
    app: "gateway", area: "Gateway console", product: productName(process.env),
    cookieName: "sid", basePath: "", store, settings: settings ?? readAuthSettings(process.env, cfg.PUBLIC_BASE_URL),
    wso2: {
      authorizeUrl: (state, challenge) => authorizeUrl(publicBase, creds.clientId, redirectUri, challenge, state, SCOPE),
      exchange: (code, verifier) => exchangeCode(w, creds.clientId, creds.clientSecret, code, redirectUri, verifier),
      refresh: (rt) => refreshToken(w, creds.clientId, creds.clientSecret, rt),
      serviceToken,
    },
    rule: gatewayRule, adminApi: true,
    devUser, devRoles: process.env.DEV_AUTH_ROLES !== undefined ? cleanRoles(process.env.DEV_AUTH_ROLES) : undefined,
  });
  app.decorate("tokenFor", access.tokenFor);
  app.decorate("tokenForRequest", access.tokenForRequest);
  app.decorate("access", access);
  // Gateway rules screens: the service-credential token (fallback when the person's own token sees no
  // APIs) and the signed-in person's name for the audit log.
  app.decorate("serviceToken", serviceToken);
  app.decorate("userForRequest", async (req: FastifyRequest) => {
    const p = await access.principal(req);
    return p ? (p.email || p.name || p.user || null) : null;
  });
  return access;
}
