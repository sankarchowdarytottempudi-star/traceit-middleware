import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import type { Config } from "./config.js";
import type { SessionStore } from "./sessionStore.js";
import { authorizeUrl, exchangeCode, pkce, refreshToken, type TokenSet } from "./wso2.js";

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
interface Session { tokens: TokenSet; expiresAt: number; user: string; }

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

const SESSION_TTL = 86400;   // 1 day; refresh token kept server-side in the store
const PKCE_TTL = 600;
const SCOPE = "openid apim:admin apim:api_view apim:api_manage apim:tier_view apim:tier_manage apim:admin_settings apim:environment_manage " +
  "apim:environment_read apim:keymanagers_manage apim:workflow_approve apim:api_governance_view apim:api_governance_manage";

export function registerAuth(app: FastifyInstance, cfg: Config, creds: ClientCreds, store: SessionStore) {
  const redirectUri = `${cfg.PUBLIC_BASE_URL.replace(/\/+$/, "")}/api/auth/callback`;
  const base = basePath(cfg.PUBLIC_BASE_URL);
  const w = { baseUrl: cfg.APIM_BASE_URL, caPem: cfg.caPem }; // server-side (localhost; cert CN matches)
  const publicBase = cfg.APIM_PUBLIC_URL; // browser-facing only

  const devUser = process.env.HOST === "127.0.0.1" ? (process.env.DEV_AUTH_USER || "") : "";
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
  app.decorate("tokenFor", devUser ? async () => "dev-token" : tokenFor);
  /** Signed-in user name for a request, or null. Use this to guard every /api route. */
  app.decorate("userFor", async (req: import("fastify").FastifyRequest): Promise<string | null> => {
    if (devUser) return devUser;
    const sid = sidOf(req);
    if (!sid) return null;
    if (!(await tokenFor(sid))) return null;
    const s = await store.get<Session>(`sess:${sid}`);
    return s ? s.user : null;
  });

  /** Role of the signed-in user (null when not signed in). The dev instance can play a viewer with DEV_AUTH_ROLE=viewer. */
  app.decorate("roleFor", async (req: import("fastify").FastifyRequest): Promise<Role | null> => {
    if (devUser) return process.env.DEV_AUTH_ROLE === "viewer" ? "viewer" : "admin";
    const sid = sidOf(req);
    if (!sid || !(await tokenFor(sid))) return null;
    const s = await store.get<Session>(`sess:${sid}`);
    return s ? roleOfTokens(s.tokens) : null;
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
    reply.setCookie(SID_COOKIE, sid, { httpOnly: true, secure: true, sameSite: "lax", path: base || "/", signed: true });
    reply.redirect(`${base}/`);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const sid = sidOf(req);
    if (sid) await store.del(`sess:${sid}`);
    reply.clearCookie(SID_COOKIE, { path: base || "/" });
    reply.send({ ok: true });
  });

  app.get("/api/auth/me", async (req, reply) => {
    if (devUser) return { user: devUser, role: process.env.DEV_AUTH_ROLE === "viewer" ? "viewer" : "admin" };
    const sid = sidOf(req);
    const s = sid ? await store.get<Session>(`sess:${sid}`) : null;
    if (!s) return reply.code(401).send({ type: "about:blank", title: "Not signed in", status: 401 });
    return { user: s.user, role: roleOfTokens(s.tokens) };
  });
}
