// Sign-in, sessions, role checks and the audit trail for one Weave app (Gateway or Factory).
// Providers: wso2 (API Manager OAuth, today's sign-in), oidc (Microsoft Entra ID or any OIDC
// provider) and local (accounts kept in the shared users file). Roles come from the shared users
// file and the group mapping on every request, so a change by an admin applies at once.
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createAuditLog, type AuditLog } from "./audit.js";
import { OidcClient, randomToken, type OidcIdentity } from "./oidc.js";
import { TokenError } from "./jwt.js";
import { noAccessPage, signInPage } from "./pages.js";
import { hashPassword, passwordProblem, verifyPassword } from "./passwords.js";
import { cleanRoles, ROLES, rolesFromGroups, unionRoles, type GroupRole, type Role } from "./roles.js";
import type { AuthSettings, ProviderId } from "./settings.js";
import { normEmail, publicUser, UserStore, type Provider, type UserRecord } from "./userStore.js";

export interface TokenSet { access_token: string; refresh_token?: string; expires_in: number; scope?: string }

/** How this app talks to API Manager (its own client registration). */
export interface Wso2Adapter {
  authorizeUrl(state: string, challenge: string): string;
  exchange(code: string, verifier: string): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  /** Token from the server's own service account (APIM_DCR user), cached. */
  serviceToken(): Promise<string>;
}

export interface SessionStoreLike {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** What a route needs: a role, any signed-in person, or nothing. */
export type Rule = Role | "signed-in" | "public";

export interface Session {
  /** Absent on sessions made before providers existed: those are API Manager sessions. */
  provider?: ProviderId;
  tokens?: TokenSet;
  expiresAt: number;
  user: string;
  userId?: string; email?: string; name?: string;
  groups?: string[]; groupsOverage?: boolean;
  until?: number;
}

export interface Principal {
  sid: string;
  user: string; name: string; email: string;
  provider: ProviderId;
  roles: Role[];
  userId?: string;
  /** API Manager is called with the server's own service account on this person's behalf. */
  serviceAccount: boolean;
  dev?: boolean;
  session?: Session;
}

export interface AccessOptions {
  app: "gateway" | "factory";
  /** Words for the sign-in page: "Gateway console", "Factory". */
  area: string;
  product: string;
  cookieName: string;
  /** "" or the path the app is served under ("/factory"). */
  basePath: string;
  store: SessionStoreLike;
  settings: AuthSettings;
  wso2: Wso2Adapter;
  rule(path: string): Rule;
  /** Serve /api/access/* (the users and access screen). */
  adminApi?: boolean;
  /** Loopback test instance: everyone is this user. */
  devUser?: string;
  devRoles?: Role[];
  devToken?: () => Promise<string>;
  /** Short role word kept for older screens ("admin"/"viewer"). */
  legacyRole?: (p: Principal) => string;
  oidcFetch?: import("./idpHttp.js").IdpFetch;
}

export interface Access {
  principal(req: FastifyRequest): Promise<Principal | null>;
  tokenFor(sid: string): Promise<string | null>;
  tokenForRequest(req: FastifyRequest): Promise<string | null>;
  audit: AuditLog;
  users: UserStore | null;
  oidc: OidcClient | null;
}

const WSO2_SESSION_TTL = 86400;
const PKCE_TTL = 600;
const FAIL_WINDOW = 15 * 60_000, FAIL_MAX = 5;
const AREA_WORDS: Record<Role, string> = { admin: "user management", migration: "Migration (Factory)", gateway: "the Gateway console" };
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function problem(reply: FastifyReply, status: number, title: string) {
  return reply.code(status).type("application/problem+json").send({ type: "about:blank", title, status });
}
function fail(status: number, title: string): Error { return Object.assign(new Error(title), { statusCode: status }); }
function pathOf(url: string | undefined): string { return (url ?? "/").split("?")[0]; }

export function registerAccess(app: FastifyInstance, o: AccessOptions): Access {
  const s = o.settings;
  const base = o.basePath;
  const users = s.usersFile ? new UserStore(s.usersFile) : null;
  const audit = createAuditLog(s.auditFile || undefined, o.app);
  const oidc = s.oidc ? new OidcClient(s.oidc, o.oidcFetch) : null;
  const cookieOpts = { httpOnly: true, secure: true, sameSite: "lax" as const, path: base || "/", signed: true };
  const stateCookie = `${o.cookieName}_st`;
  const cache = new WeakMap<FastifyRequest, Promise<Principal | null>>();
  const failures = new Map<string, { n: number; first: number }>();

  if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) {
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 },
      (_req, body, done) => { try { done(null, Object.fromEntries(new URLSearchParams(String(body)))); } catch (e) { done(e as Error, undefined); } });
  }

  const sidOf = (req: FastifyRequest): string => {
    const raw = (req.cookies as Record<string, string | undefined>)[o.cookieName];
    return raw ? req.unsignCookie(raw).value || "" : "";
  };

  async function refreshWso2(sid: string, sess: Session): Promise<string | null> {
    const t = sess.tokens;
    if (!t) return null;
    if (Date.now() < sess.expiresAt - 30_000 || !t.refresh_token) return t.access_token;
    try {
      const next = await o.wso2.refresh(t.refresh_token);
      await o.store.set(`sess:${sid}`, { ...sess, tokens: next, expiresAt: Date.now() + next.expires_in * 1000 }, WSO2_SESSION_TTL);
      return next.access_token;
    } catch { await o.store.del(`sess:${sid}`); return null; }
  }

  function recordFor(sess: Session, provider: ProviderId): UserRecord | undefined {
    if (!users) return undefined;
    if (sess.userId) { const r = users.findById(sess.userId); if (r) return r; }
    return provider === "oidc" ? undefined : users.match(provider as Provider, sess.user);
  }

  async function load(req: FastifyRequest): Promise<Principal | null> {
    if (o.devUser) return { sid: "", user: o.devUser, name: o.devUser, email: "", provider: "wso2", roles: o.devRoles ?? [...ROLES], serviceAccount: true, dev: true };
    const sid = sidOf(req);
    if (!sid) return null;
    const sess = await o.store.get<Session>(`sess:${sid}`);
    if (!sess) return null;
    const provider: ProviderId = sess.provider ?? "wso2";
    if (provider === "wso2") {
      if (!(await refreshWso2(sid, sess))) return null;
      const rec = recordFor(sess, "wso2");
      if (rec?.disabled) { await o.store.del(`sess:${sid}`); return null; }
      const fresh = (await o.store.get<Session>(`sess:${sid}`)) ?? sess;
      return { sid, user: sess.user, name: rec?.name || sess.user, email: rec?.email ?? "", provider, userId: rec?.id, roles: rec ? rec.roles : s.wso2DefaultRoles, serviceAccount: false, session: fresh };
    }
    if (!sess.until || Date.now() > sess.until) { await o.store.del(`sess:${sid}`); return null; }
    const rec = recordFor(sess, provider);
    if (!rec || rec.disabled) { await o.store.del(`sess:${sid}`); return null; }
    const roles = provider === "oidc" ? unionRoles(rec.roles, rolesFromGroups(sess.groups, users?.groupRoles() ?? [])) : rec.roles;
    return { sid, user: rec.email, name: rec.name || rec.email, email: rec.email, provider, userId: rec.id, roles, serviceAccount: true, session: sess };
  }

  function principal(req: FastifyRequest): Promise<Principal | null> {
    let p = cache.get(req);
    if (!p) { p = load(req); cache.set(req, p); }
    return p;
  }

  async function tokenFor(sid: string): Promise<string | null> {
    if (o.devUser) return (o.devToken ?? o.wso2.serviceToken)();
    if (!sid) return null;
    const sess = await o.store.get<Session>(`sess:${sid}`);
    if (!sess) return null;
    const provider = sess.provider ?? "wso2";
    if (provider === "wso2") {
      const rec = recordFor(sess, "wso2");
      if (rec?.disabled) return null;
      return refreshWso2(sid, sess);
    }
    if (!sess.until || Date.now() > sess.until) return null;
    const rec = recordFor(sess, provider);
    if (!rec || rec.disabled) return null;
    return o.wso2.serviceToken();
  }
  async function tokenForRequest(req: FastifyRequest): Promise<string | null> {
    if (o.devUser) return tokenFor("");
    return tokenFor(sidOf(req));
  }

  // ---- role checks on every /api route (unknown addresses still answer 404) ----
  app.addHook("onRoute", (route) => {
    const url = route.url;
    if (!url.startsWith("/api/")) return;
    const need = o.rule(url);
    if (need === "public") return;
    const guard = async (req: FastifyRequest, reply: FastifyReply) => {
      const p = await principal(req);
      if (!p) return problem(reply, 401, "Not signed in");
      if (need !== "signed-in" && !p.roles.includes(need)) return problem(reply, 403, `You do not have access to ${AREA_WORDS[need]}. Ask an administrator to grant it.`);
    };
    const r = route as unknown as { onRequest?: unknown };
    const prev = r.onRequest;
    r.onRequest = prev ? [guard, ...(Array.isArray(prev) ? prev : [prev])] : [guard];
  });

  // ---- who did what: every change made through this app ----
  app.addHook("onResponse", async (req, reply) => {
    if (!audit.enabled || !MUTATING.has(req.method)) return;
    const path = pathOf(req.url);
    if (!path.startsWith("/api/") || path.startsWith("/api/auth/") || path.startsWith("/api/access/") || path.startsWith("/api/review")) return;
    const p = await principal(req).catch(() => null);
    if (!p) return;
    audit.write({ user: p.user, provider: p.provider, action: `${req.method} ${req.routeOptions?.url ?? path}`, target: path,
      status: reply.statusCode, ...(p.serviceAccount ? { via: "service-account" } : {}), ip: req.ip });
  });

  // ---- sign-in ----
  const page = (reply: FastifyReply, message?: string, email?: string, status = 200) =>
    reply.code(status).header("cache-control", "no-store").type("text/html; charset=utf-8")
      .send(signInPage({ product: o.product, area: o.area, base, providers: s.providers, oidcLabel: s.oidc?.label, message, email }));
  const denied = (reply: FastifyReply, who: string, message: string) =>
    reply.code(403).header("cache-control", "no-store").type("text/html; charset=utf-8").send(noAccessPage({ product: o.product, base, who, message }));
  const toLogin = (reply: FastifyReply, error: string) => reply.redirect(`${base}/api/auth/login?error=${encodeURIComponent(error)}`);

  async function startSession(reply: FastifyReply, sess: Session, ttl: number) {
    const sid = crypto.randomBytes(24).toString("hex");
    await o.store.set(`sess:${sid}`, sess, ttl);
    reply.setCookie(o.cookieName, sid, cookieOpts);
  }
  function pkce() {
    const verifier = crypto.randomBytes(32).toString("base64url");
    return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
  }

  app.get("/api/auth/providers", async () => ({ providers: s.providers, oidcLabel: s.oidc?.label ?? null }));

  app.get("/api/auth/login", async (req, reply) => {
    const q = req.query as { provider?: string; error?: string; login_hint?: string };
    const only = s.providers.length === 1 ? s.providers[0] : undefined;
    const want = q.provider && s.providers.includes(q.provider as ProviderId) ? q.provider : (!q.error && only !== "local" ? only : undefined);
    if (want === "wso2" || want === "oidc") {
      const { verifier, challenge } = pkce();
      const state = crypto.randomBytes(16).toString("hex");
      reply.setCookie(stateCookie, state, { ...cookieOpts, maxAge: PKCE_TTL });
      if (want === "wso2") {
        await o.store.set(`pkce:${state}`, { verifier }, PKCE_TTL);
        return reply.redirect(o.wso2.authorizeUrl(state, challenge));
      }
      const nonce = randomToken();
      try {
        const url = await oidc!.authorizeUrl({ state, nonce, challenge, loginHint: typeof q.login_hint === "string" ? q.login_hint.slice(0, 200) : undefined });
        await o.store.set(`pkce:${state}`, { verifier, provider: "oidc", nonce }, PKCE_TTL);
        return reply.redirect(url);
      } catch (e) {
        req.log.warn({ reason: (e as Error).message }, "oidc sign-in could not start");
        return page(reply, "unreachable", undefined, 502);
      }
    }
    return page(reply, q.error);
  });

  app.get("/api/auth/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const p = q.state ? await o.store.get<{ verifier: string; provider?: string; nonce?: string }>(`pkce:${q.state}`) : null;
    if (q.state) await o.store.del(`pkce:${q.state}`);
    const st = (req.cookies as Record<string, string | undefined>)[stateCookie];
    const stOk = !!st && !!q.state && req.unsignCookie(st).value === q.state;
    reply.clearCookie(stateCookie, { path: base || "/" });
    if (q.error) return toLogin(reply, "cancelled");
    if (!q.code || !p || !stOk) return toLogin(reply, "expired");

    if (p.provider !== "oidc") {
      if (!s.providers.includes("wso2")) return toLogin(reply, "expired");
      let t: TokenSet;
      try { t = await o.wso2.exchange(q.code, p.verifier); } catch (e) { req.log.warn({ reason: (e as Error).message }, "wso2 code exchange failed"); return toLogin(reply, "provider"); }
      let user = "wso2-user";
      try { const [, body] = t.access_token.split("."); if (body) user = JSON.parse(Buffer.from(body, "base64url").toString()).sub ?? user; } catch { /* opaque token */ }
      const rec = users?.match("wso2", user);
      if (rec?.disabled) { audit.write({ user, provider: "wso2", action: "sign-in refused", detail: "account switched off", ip: req.ip }); return denied(reply, user, "disabled"); }
      if (!(rec ? rec.roles : s.wso2DefaultRoles).length) { audit.write({ user, provider: "wso2", action: "sign-in refused", detail: "no roles", ip: req.ip }); return denied(reply, user, "noaccess"); }
      if (rec) users!.update((d) => { const r = d.users.find((u) => u.id === rec.id); if (r) r.lastSignInAt = new Date().toISOString(); });
      await startSession(reply, { provider: "wso2", tokens: t, expiresAt: Date.now() + t.expires_in * 1000, user, ...(rec ? { userId: rec.id } : {}) }, WSO2_SESSION_TTL);
      audit.write({ user, provider: "wso2", action: "sign-in", ip: req.ip });
      return reply.redirect(`${base}/`);
    }

    if (!oidc || !users) return toLogin(reply, "expired");
    let id: OidcIdentity;
    try {
      const t = await oidc.exchange(q.code, p.verifier);
      id = await oidc.validateIdToken(t.id_token, p.nonce ?? "");
    } catch (e) {
      req.log.warn({ reason: (e as Error).message }, "oidc sign-in failed");
      const pe = (e as { providerError?: string }).providerError;
      return toLogin(reply, e instanceof TokenError ? "token" : pe ? "provider" : "unreachable");
    }
    const groupRoles = rolesFromGroups(id.groups, users.groupRoles());
    const now = new Date().toISOString();
    const outcome = users.update((d): { rec?: UserRecord; why?: string } => {
      let r = d.users.find((u) => u.provider === "oidc" && u.subject === id.subject)
        ?? d.users.find((u) => u.provider === "oidc" && !u.subject && normEmail(u.email) === id.email);
      if (r?.disabled) return { why: "disabled" };
      if (!r) {
        if (!groupRoles.length) return { why: "noaccess" };
        r = { id: UserStore.newId(), email: id.email, name: id.name, provider: "oidc", subject: id.subject, roles: [], disabled: false, source: "groups", createdAt: now, createdBy: "directory groups", updatedAt: now };
        d.users.push(r);
      }
      if (!unionRoles(r.roles, groupRoles).length) return { why: "noaccess" };
      r.subject = id.subject; r.name = id.name || r.name; r.email = id.email; r.lastSignInAt = now;
      return { rec: { ...r } };
    });
    if (!outcome.rec) {
      audit.write({ user: id.email, provider: "oidc", action: "sign-in refused", detail: outcome.why === "disabled" ? "account switched off" : `no roles${id.groupsOverage ? " (too many groups for the token)" : ""}`, ip: req.ip });
      return denied(reply, id.email, outcome.why ?? "noaccess");
    }
    const until = Date.now() + s.sessionSeconds * 1000;
    await startSession(reply, { provider: "oidc", expiresAt: until, until, user: id.email, userId: outcome.rec.id, email: id.email, name: id.name, groups: id.groups.slice(0, 500), groupsOverage: id.groupsOverage }, s.sessionSeconds);
    audit.write({ user: id.email, provider: "oidc", action: "sign-in", ip: req.ip, ...(groupRoles.length ? { detail: `roles from groups: ${groupRoles.join(", ")}` } : {}) });
    return reply.redirect(`${base}/`);
  });

  function sameOrigin(req: FastifyRequest): boolean {
    const origin = req.headers.origin;
    if (!origin || origin === "null") return !origin;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  app.post("/api/auth/local", async (req, reply) => {
    if (!s.providers.includes("local") || !users) return problem(reply, 404, "Not found");
    const json = String(req.headers["content-type"] ?? "").includes("application/json");
    const b = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof b.email === "string" ? normEmail(b.email).slice(0, 320) : "";
    const password = typeof b.password === "string" ? b.password.slice(0, 1024) : "";
    const answer = (code: string, status: number) => json ? problem(reply, status, code) : toLogin(reply, code);
    if (!sameOrigin(req)) return answer("expired", 403);
    const key = `${req.ip}|${email}`;
    const f = failures.get(key);
    if (f && Date.now() - f.first < FAIL_WINDOW && f.n >= FAIL_MAX) return answer("locked", 429);
    const rec = email ? users.match("local", email) : undefined;
    const ok = await verifyPassword(password, rec?.passwordHash);
    if (!ok || !rec) {
      const n = f && Date.now() - f.first < FAIL_WINDOW ? { n: f.n + 1, first: f.first } : { n: 1, first: Date.now() };
      failures.set(key, n);
      if (failures.size > 10_000) failures.clear();
      audit.write({ user: email || "(empty)", provider: "local", action: "sign-in failed", ip: req.ip });
      return answer("bad", 401);
    }
    failures.delete(key);
    if (rec.disabled) { audit.write({ user: email, provider: "local", action: "sign-in refused", detail: "account switched off", ip: req.ip }); return json ? problem(reply, 403, "disabled") : denied(reply, email, "disabled"); }
    if (!rec.roles.length) { audit.write({ user: email, provider: "local", action: "sign-in refused", detail: "no roles", ip: req.ip }); return json ? problem(reply, 403, "noaccess") : denied(reply, email, "noaccess"); }
    users.update((d) => { const r = d.users.find((u) => u.id === rec.id); if (r) r.lastSignInAt = new Date().toISOString(); });
    const until = Date.now() + s.sessionSeconds * 1000;
    await startSession(reply, { provider: "local", expiresAt: until, until, user: rec.email, userId: rec.id, email: rec.email, name: rec.name }, s.sessionSeconds);
    audit.write({ user: rec.email, provider: "local", action: "sign-in", ip: req.ip });
    return json ? reply.send({ ok: true }) : reply.redirect(`${base}/`);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const p = await principal(req).catch(() => null);
    const sid = sidOf(req);
    if (sid) await o.store.del(`sess:${sid}`);
    reply.clearCookie(o.cookieName, { path: base || "/" });
    if (p && !p.dev) audit.write({ user: p.user, provider: p.provider, action: "sign-out", ip: req.ip });
    return reply.send({ ok: true });
  });

  app.get("/api/auth/me", async (req, reply) => {
    const p = await principal(req);
    if (!p) return problem(reply, 401, "Not signed in");
    return {
      user: p.user, name: p.name, email: p.email, provider: p.provider, roles: p.roles,
      role: o.legacyRole ? o.legacyRole(p) : p.roles.includes("admin") ? "admin" : p.roles.join(", ") || "no access",
      canChangePassword: p.provider === "local",
    };
  });

  app.post("/api/auth/password", async (req, reply) => {
    const p = await principal(req);
    if (!p) return problem(reply, 401, "Not signed in");
    if (p.provider !== "local" || !users || !p.userId) return problem(reply, 400, "Only Weave accounts have a password here.");
    if (!sameOrigin(req)) return problem(reply, 403, "Refused");
    const b = (req.body ?? {}) as { current?: unknown; next?: unknown };
    const rec = users.findById(p.userId);
    if (!rec || !(await verifyPassword(String(b.current ?? ""), rec.passwordHash))) return problem(reply, 400, "The current password is not right.");
    const why = passwordProblem(b.next);
    if (why) return problem(reply, 400, why);
    const hash = await hashPassword(String(b.next));
    users.update((d) => { const r = d.users.find((u) => u.id === p.userId); if (r) { r.passwordHash = hash; r.updatedAt = new Date().toISOString(); } });
    audit.write({ user: p.user, provider: p.provider, action: "password.change", target: p.user, ip: req.ip });
    return { ok: true };
  });

  // ---- first admin from the environment (once; never a default password) ----
  app.addHook("onReady", async () => {
    if (!users || !process.env.WEAVE_BOOTSTRAP_ADMIN) return;
    try {
      const r = await bootstrapAdmin(users, {
        email: process.env.WEAVE_BOOTSTRAP_ADMIN, name: process.env.WEAVE_BOOTSTRAP_NAME,
        provider: (process.env.WEAVE_BOOTSTRAP_PROVIDER as Provider | undefined) ?? (process.env.WEAVE_BOOTSTRAP_PASSWORD_FILE ? "local" : "oidc"),
        passwordFile: process.env.WEAVE_BOOTSTRAP_PASSWORD_FILE,
      });
      if (r.created) { audit.write({ user: "bootstrap", action: "user.create", target: r.created.email, detail: `first admin (${r.created.provider})` }); app.log.info("first admin created from WEAVE_BOOTSTRAP_ADMIN"); }
    } catch (e) { app.log.error({ reason: (e as Error).message }, "WEAVE_BOOTSTRAP_ADMIN not applied"); }
  });

  if (o.adminApi) registerAdminApi(app, { users, audit, settings: s, principal, sameOrigin });

  return { principal, tokenFor, tokenForRequest, audit, users, oidc };
}

/** Creates the first admin when no active admin exists. Local accounts need a password from a file. */
export async function bootstrapAdmin(users: UserStore, a: { email?: string; name?: string; provider?: Provider; password?: string; passwordFile?: string }): Promise<{ created?: UserRecord; skipped?: string }> {
  const email = normEmail(a.email ?? "");
  const provider: Provider = a.provider ?? "local";
  if (!["local", "oidc", "wso2"].includes(provider)) throw new Error("provider must be local, oidc or wso2");
  if (provider !== "wso2" && !EMAIL_RE.test(email)) throw new Error("a valid e-mail address is needed");
  let hash: string | undefined;
  if (provider === "local") {
    let pw = a.password;
    if (pw === undefined && a.passwordFile) { const { readFileSync } = await import("node:fs"); pw = readFileSync(a.passwordFile, "utf8").replace(/\r?\n$/, ""); }
    const why = passwordProblem(pw);
    if (why) throw new Error(`password refused: ${why}`);
    hash = await hashPassword(pw!);
  }
  return users.update((d) => {
    if (d.users.some((u) => !u.disabled && u.roles.includes("admin"))) return { skipped: "an admin already exists" };
    const now = new Date().toISOString();
    const existing = d.users.find((u) => u.provider === provider && normEmail(u.email) === email);
    if (existing) { existing.roles = unionRoles(existing.roles, ROLES); existing.disabled = false; if (hash) existing.passwordHash = hash; existing.updatedAt = now; return { created: { ...existing } }; }
    const rec: UserRecord = { id: UserStore.newId(), email, name: a.name?.trim() || email, provider, roles: [...ROLES], disabled: false, ...(hash ? { passwordHash: hash } : {}), source: "bootstrap", createdAt: now, createdBy: "bootstrap", updatedAt: now };
    d.users.push(rec);
    return { created: { ...rec } };
  });
}

// ---- the users and access screen's API ----
function registerAdminApi(app: FastifyInstance, c: {
  users: UserStore | null; audit: AuditLog; settings: AuthSettings;
  principal(req: FastifyRequest): Promise<Principal | null>; sameOrigin(req: FastifyRequest): boolean;
}) {
  const { users, audit, settings } = c;
  async function who(req: FastifyRequest): Promise<Principal> {
    const p = await c.principal(req);
    if (!p) throw fail(401, "Not signed in");
    return p;
  }
  function store(): UserStore {
    if (!users) throw fail(409, "User management is off on this server: set WEAVE_USERS_FILE (see docs/CRUISE-SAUDI-SSO.md).");
    return users;
  }
  async function changer(req: FastifyRequest): Promise<Principal> {
    const p = await who(req);
    if (!c.sameOrigin(req)) throw fail(403, "Refused: the request did not come from this site.");
    return p;
  }
  const log = (p: Principal, req: FastifyRequest, action: string, target: string, detail?: string) =>
    audit.write({ user: p.user, provider: p.provider, action, target, ...(detail ? { detail } : {}), ip: req.ip });
  const activeAdmins = (list: UserRecord[]) => list.filter((u) => !u.disabled && u.roles.includes("admin")).length;

  app.get("/api/access/users", async (req) => {
    const p = await who(req);
    if (!users) return { configured: false, users: [], groupRoles: [], providers: settings.providers, groupsClaim: settings.oidc?.groupsClaim ?? null, auditEnabled: audit.enabled, me: null };
    const d = users.read();
    return { configured: true, users: d.users.map(publicUser), groupRoles: d.groupRoles, providers: settings.providers, groupsClaim: settings.oidc?.groupsClaim ?? null, auditEnabled: audit.enabled, me: p.userId ?? null };
  });

  app.post("/api/access/users", async (req, reply) => {
    const p = await changer(req);
    const st = store();
    const b = (req.body ?? {}) as { provider?: string; email?: string; name?: string; roles?: unknown; password?: string };
    const provider = (b.provider ?? "local") as Provider;
    if (!["local", "oidc", "wso2"].includes(provider)) throw fail(400, "Choose a Weave account, a Microsoft account or an API Manager account.");
    const email = provider === "wso2" ? String(b.email ?? "").trim() : normEmail(String(b.email ?? ""));
    if (provider === "wso2" ? !/^[\w.@+-]{1,200}$/.test(email) : !EMAIL_RE.test(email) || email.length > 320) throw fail(400, provider === "wso2" ? "Enter the API Manager user name." : "Enter a valid e-mail address.");
    const roles = cleanRoles(b.roles);
    let hash: string | undefined;
    if (provider === "local") {
      const why = passwordProblem(b.password);
      if (why) throw fail(400, `Password: ${why}`);
      hash = await hashPassword(String(b.password));
    }
    const now = new Date().toISOString();
    const rec = st.update((d) => {
      if (d.users.some((u) => u.provider === provider && normEmail(u.email) === normEmail(email))) throw fail(409, "That person is already on the list.");
      const r: UserRecord = { id: UserStore.newId(), email, name: String(b.name ?? "").trim().slice(0, 200) || email, provider, roles, disabled: false,
        ...(hash ? { passwordHash: hash } : {}), source: "invited", createdAt: now, createdBy: p.user, updatedAt: now };
      d.users.push(r);
      return r;
    });
    log(p, req, provider === "oidc" ? "user.invite" : "user.create", email, `${provider}; roles: ${roles.join(", ") || "none"}`);
    reply.code(201);
    return { user: publicUser(rec) };
  });

  app.patch("/api/access/users/:id", async (req) => {
    const p = await changer(req);
    const st = store();
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; roles?: unknown; disabled?: boolean };
    const changes: string[] = [];
    const rec = st.update((d) => {
      const r = d.users.find((u) => u.id === id);
      if (!r) throw fail(404, "No such user.");
      const self = r.id === p.userId;
      if (b.roles !== undefined) {
        const roles = cleanRoles(b.roles);
        if (self && r.roles.includes("admin") && !roles.includes("admin")) throw fail(409, "You cannot take away your own admin access.");
        if (roles.join() !== r.roles.join()) changes.push(`roles: ${r.roles.join(", ") || "none"} -> ${roles.join(", ") || "none"}`);
        r.roles = roles;
      }
      if (b.disabled !== undefined) {
        if (self && b.disabled) throw fail(409, "You cannot switch off your own account.");
        if (!!b.disabled !== r.disabled) changes.push(b.disabled ? "switched off" : "switched on");
        r.disabled = !!b.disabled;
      }
      if (typeof b.name === "string" && b.name.trim() && b.name.trim() !== r.name) { changes.push("name"); r.name = b.name.trim().slice(0, 200); }
      if (!activeAdmins(d.users)) throw fail(409, "At least one active admin must remain.");
      r.updatedAt = new Date().toISOString();
      return { ...r };
    });
    if (changes.length) log(p, req, "user.update", rec.email, changes.join("; "));
    return { user: publicUser(rec) };
  });

  app.post("/api/access/users/:id/password", async (req) => {
    const p = await changer(req);
    const st = store();
    const { id } = req.params as { id: string };
    const pw = (req.body as { password?: unknown } | undefined)?.password;
    const why = passwordProblem(pw);
    if (why) throw fail(400, `Password: ${why}`);
    const hash = await hashPassword(String(pw));
    const rec = st.update((d) => {
      const r = d.users.find((u) => u.id === id);
      if (!r) throw fail(404, "No such user.");
      if (r.provider !== "local") throw fail(400, "Only Weave accounts have a password here; Microsoft and API Manager accounts keep theirs.");
      r.passwordHash = hash; r.updatedAt = new Date().toISOString();
      return { ...r };
    });
    log(p, req, "user.password-reset", rec.email);
    return { ok: true };
  });

  app.delete("/api/access/users/:id", async (req) => {
    const p = await changer(req);
    const st = store();
    const { id } = req.params as { id: string };
    const gone = st.update((d) => {
      const i = d.users.findIndex((u) => u.id === id);
      if (i < 0) throw fail(404, "No such user.");
      if (d.users[i].id === p.userId) throw fail(409, "You cannot remove your own account.");
      const [r] = d.users.splice(i, 1);
      if (!activeAdmins(d.users)) throw fail(409, "At least one active admin must remain.");
      return r;
    });
    log(p, req, "user.remove", gone.email, gone.provider);
    return { ok: true };
  });

  app.put("/api/access/group-roles", async (req) => {
    const p = await changer(req);
    const st = store();
    const raw = (req.body as { mappings?: unknown } | undefined)?.mappings;
    if (!Array.isArray(raw) || raw.length > 200) throw fail(400, "Send up to 200 group mappings.");
    const seen = new Set<string>();
    const next: GroupRole[] = [];
    for (const m of raw as { group?: unknown; label?: unknown; roles?: unknown }[]) {
      const group = String(m?.group ?? "").trim();
      if (!group) continue;
      if (group.length > 200) throw fail(400, "A group id or name is at most 200 characters.");
      if (seen.has(group.toLowerCase())) throw fail(400, `Group ${group} is listed twice.`);
      seen.add(group.toLowerCase());
      const label = String(m?.label ?? "").trim().slice(0, 200);
      next.push({ group, ...(label ? { label } : {}), roles: cleanRoles(m?.roles) });
    }
    const before = st.groupRoles();
    st.update((d) => { d.groupRoles = next; });
    const fmt = (l: GroupRole[]) => l.map((g) => `${g.label || g.group}=${g.roles.join("+") || "none"}`).join(", ") || "none";
    log(p, req, "groups.update", "group mapping", `${fmt(before)} -> ${fmt(next)}`);
    return { groupRoles: next };
  });

  app.get("/api/access/audit", async (req) => {
    await who(req);
    const q = req.query as { limit?: string; q?: string };
    return { enabled: audit.enabled, entries: audit.read({ limit: Math.min(Number(q.limit) || 200, 2000), q: typeof q.q === "string" ? q.q.slice(0, 200) : undefined }) };
  });
}
