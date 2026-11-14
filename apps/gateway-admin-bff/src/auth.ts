import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import type { Config } from "./config.js";
import { authorizeUrl, exchangeCode, pkce, refreshToken, type TokenSet } from "./wso2.js";

export interface ClientCreds { clientId: string; clientSecret: string; }
interface Session { tokens: TokenSet; expiresAt: number; user: string; }
interface Pending { verifier: string; createdAt: number; }

const SCOPE = "openid apim:admin apim:tier_view apim:tier_manage apim:admin_settings apim:environment_manage " +
  "apim:environment_read apim:keymanagers_manage apim:workflow_approve apim:api_governance_view apim:api_governance_manage";

export function registerAuth(app: FastifyInstance, cfg: Config, creds: ClientCreds) {
  const sessions = new Map<string, Session>();
  const pending = new Map<string, Pending>();
  const redirectUri = `${cfg.PUBLIC_BASE_URL}/api/auth/callback`;
  const w = { baseUrl: cfg.APIM_BASE_URL, caPem: cfg.caPem };

  app.decorate("sessions", sessions);

  async function tokenFor(sid: string): Promise<string | null> {
    const s = sessions.get(sid);
    if (!s) return null;
    if (Date.now() < s.expiresAt - 30_000) return s.tokens.access_token;
    if (!s.tokens.refresh_token) return s.tokens.access_token;
    try {
      const t = await refreshToken(w, creds.clientId, creds.clientSecret, s.tokens.refresh_token);
      s.tokens = t; s.expiresAt = Date.now() + t.expires_in * 1000;
      return t.access_token;
    } catch { sessions.delete(sid); return null; }
  }
  app.decorate("tokenFor", tokenFor);

  app.get("/api/auth/login", async (_req, reply) => {
    const { verifier, challenge } = pkce();
    const state = crypto.randomBytes(16).toString("hex");
    pending.set(state, { verifier, createdAt: Date.now() });
    reply.redirect(authorizeUrl(w, creds.clientId, redirectUri, challenge, state, SCOPE));
  });

  app.get("/api/auth/callback", async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const p = state ? pending.get(state) : undefined;
    if (!code || !p) return reply.code(400).send({ type: "about:blank", title: "Bad callback", status: 400 });
    pending.delete(state!);
    const t = await exchangeCode(w, creds.clientId, creds.clientSecret, code, redirectUri, p.verifier);
    const sid = crypto.randomBytes(24).toString("hex");
    let user = "wso2-user";
    try { const [, body] = t.access_token.split("."); if (body) user = JSON.parse(Buffer.from(body, "base64url").toString()).sub ?? user; } catch { /* opaque token */ }
    sessions.set(sid, { tokens: t, expiresAt: Date.now() + t.expires_in * 1000, user });
    reply.setCookie("sid", sid, { httpOnly: true, secure: true, sameSite: "lax", path: "/", signed: true });
    reply.redirect("/");
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const sid = req.unsignCookie(req.cookies.sid ?? "").value;
    if (sid) sessions.delete(sid);
    reply.clearCookie("sid", { path: "/" });
    reply.send({ ok: true });
  });

  app.get("/api/auth/me", async (req, reply) => {
    const sid = req.unsignCookie(req.cookies.sid ?? "").value;
    const s = sid ? sessions.get(sid) : undefined;
    if (!s) return reply.code(401).send({ type: "about:blank", title: "Not signed in", status: 401 });
    return { user: s.user, role: "admin" };
  });
}
