import type { FastifyInstance, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import type { Config } from "./config.js";
import type { SessionStore } from "./sessionStore.js";
import { authorizeUrl, exchangeCode, passwordGrant, pkce, refreshToken, type TokenSet } from "./wso2.js";

export interface ClientCreds { clientId: string; clientSecret: string; }
interface Session { tokens: TokenSet; expiresAt: number; user: string; }

const SESSION_TTL = 86400;   // 1 day; refresh token kept server-side in the store
const PKCE_TTL = 600;
const SCOPE = "openid apim:admin apim:api_view apim:api_manage apim:tier_view apim:tier_manage apim:admin_settings apim:environment_manage " +
  "apim:environment_read apim:keymanagers_manage apim:workflow_approve apim:api_governance_view apim:api_governance_manage " +
  // gateway rules: publish revisions, consumer applications/keys/subscriptions, blocking rules, API-specific policies
  "apim:api_create apim:api_publish apim:subscribe apim:app_manage apim:sub_manage apim:subscription_view apim:subscription_block " +
  "apim:bl_view apim:bl_manage apim:common_operation_policy_view apim:api_key " +
  // governance results, policies and rulesets (API Manager 4.5)
  "apim:gov_policy_read apim:gov_rule_read apim:gov_result_read apim:gov_policy_manage";

export function registerAuth(app: FastifyInstance, cfg: Config, creds: ClientCreds, store: SessionStore) {
  const redirectUri = `${cfg.PUBLIC_BASE_URL}/api/auth/callback`;
  const w = { baseUrl: cfg.APIM_BASE_URL, caPem: cfg.caPem }; // server-side (localhost; cert CN matches)
  const publicBase = cfg.APIM_PUBLIC_URL; // browser-facing only

  async function tokenFor(sid: string): Promise<string | null> {
    const s = await store.get<Session>(`sess:${sid}`);
    if (!s) return null;
    if (Date.now() < s.expiresAt - 30_000) return s.tokens.access_token;
    if (!s.tokens.refresh_token) return s.tokens.access_token;
    try {
      const t = await refreshToken(w, creds.clientId, creds.clientSecret, s.tokens.refresh_token);
      const next: Session = { tokens: t, expiresAt: Date.now() + t.expires_in * 1000, user: s.user };
      await store.set(`sess:${sid}`, next, SESSION_TTL);
      return t.access_token;
    } catch { await store.del(`sess:${sid}`); return null; }
  }
  app.decorate("tokenFor", tokenFor);

  // Loopback dev mode (automated UI tests): only when bound to 127.0.0.1 AND DEV_AUTH_USER is set.
  // index.ts refuses to start with DEV_AUTH_USER on any other host. No browser sign-in; the BFF
  // calls the gateway with a token obtained from the service credentials already in the env.
  const devUser = process.env.HOST === "127.0.0.1" ? (process.env.DEV_AUTH_USER || "") : "";
  // Asked for again every minute: the gateway hands back the same token while it is valid and a
  // new one when it has expired or been revoked, so a stale token never sticks for long.
  let devTok: { token: string; expiresAt: number } | null = null;
  let devPending: Promise<string> | null = null;
  async function devToken(): Promise<string> {
    if (devTok && Date.now() < devTok.expiresAt) return devTok.token;
    if (!devPending) {
      devPending = passwordGrant(w, creds.clientId, creds.clientSecret, cfg.APIM_DCR_USERNAME, cfg.APIM_DCR_PASSWORD, SCOPE)
        .then((t) => { devTok = { token: t.access_token, expiresAt: Date.now() + Math.max(5, Math.min(60, t.expires_in - 30)) * 1000 }; return t.access_token; })
        .finally(() => { devPending = null; });
    }
    return devPending;
  }
  // Service credentials token: the fallback the rules screens use when the signed-in person's own
  // token sees no APIs (visibility/identity mismatch). The person is still the actor in the audit.
  app.decorate("serviceToken", devToken);
  app.decorate("userForRequest", async (req: FastifyRequest) => {
    if (devUser) return devUser;
    const sid = req.unsignCookie(req.cookies.sid ?? "").value;
    const s = sid ? await store.get<Session>(`sess:${sid}`) : null;
    return s?.user ?? null;
  });
  app.decorate("tokenForRequest", async (req: FastifyRequest) => {
    if (devUser) return devToken();
    const sid = req.unsignCookie(req.cookies.sid ?? "").value;
    return sid ? tokenFor(sid) : null;
  });

  app.get("/api/auth/login", async (_req, reply) => {
    const { verifier, challenge } = pkce();
    const state = crypto.randomBytes(16).toString("hex");
    await store.set(`pkce:${state}`, { verifier }, PKCE_TTL);
    reply.redirect(authorizeUrl(publicBase, creds.clientId, redirectUri, challenge, state, SCOPE));
  });

  app.get("/api/auth/callback", async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const p = state ? await store.get<{ verifier: string }>(`pkce:${state}`) : null;
    if (!code || !p) return reply.code(400).send({ type: "about:blank", title: "Bad callback", status: 400 });
    await store.del(`pkce:${state}`);
    const t = await exchangeCode(w, creds.clientId, creds.clientSecret, code, redirectUri, p.verifier);
    const sid = crypto.randomBytes(24).toString("hex");
    let user = "wso2-user";
    try { const [, body] = t.access_token.split("."); if (body) user = JSON.parse(Buffer.from(body, "base64url").toString()).sub ?? user; } catch { /* opaque token */ }
    await store.set(`sess:${sid}`, { tokens: t, expiresAt: Date.now() + t.expires_in * 1000, user }, SESSION_TTL);
    reply.setCookie("sid", sid, { httpOnly: true, secure: true, sameSite: "lax", path: "/", signed: true });
    reply.redirect("/");
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const sid = req.unsignCookie(req.cookies.sid ?? "").value;
    if (sid) await store.del(`sess:${sid}`);
    reply.clearCookie("sid", { path: "/" });
    reply.send({ ok: true });
  });

  app.get("/api/auth/me", async (req, reply) => {
    if (devUser) return { user: devUser, role: "admin" };
    const sid = req.unsignCookie(req.cookies.sid ?? "").value;
    const s = sid ? await store.get<Session>(`sess:${sid}`) : null;
    if (!s) return reply.code(401).send({ type: "about:blank", title: "Not signed in", status: 401 });
    return { user: s.user, role: "admin" };
  });
}
