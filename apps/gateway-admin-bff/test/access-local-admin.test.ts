// Local accounts, role checks on every route, the users and access API, and the API Manager sign-in.
import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { makeGateway, localSignIn, Jar, tempDir, APIM } from "./accessHelpers";
import { UserStore } from "../src/access/userStore";
import { hashPassword } from "../src/access/passwords";
import { createAuditLog } from "../src/access/audit";
import { gatewayRule } from "../src/auth";

afterEach(() => nock.cleanAll());

async function seed(dir: string, list: { email: string; roles: ("admin" | "migration" | "gateway")[]; password?: string; disabled?: boolean }[]) {
  const hashes = await Promise.all(list.map((u) => hashPassword(u.password ?? "a good long password")));
  new UserStore(join(dir, "users.json")).update((d) => {
    list.forEach((u, i) => d.users.push({ id: `u${i}`, email: u.email, name: u.email.split("@")[0], provider: "local", roles: u.roles, disabled: !!u.disabled, passwordHash: hashes[i], createdAt: "", updatedAt: "" }));
  });
}
const env = (dir: string, extra: Record<string, string> = {}) => ({ AUTH_PROVIDER: "local", WEAVE_USERS_FILE: join(dir, "users.json"), ...extra });

describe("which role each Gateway address needs", () => {
  it.each([["/api/auth/me", "public"], ["/api/access/users", "admin"], ["/api/ratelimits/:type", "gateway"], ["/api/logs", "gateway"]])("%s -> %s", (p, r) => {
    expect(gatewayRule(p)).toBe(r);
  });
});

describe("local accounts", () => {
  it("sign in with e-mail and password; session cookie is httpOnly, secure, signed", async () => {
    const dir = tempDir(); await seed(dir, [{ email: "ops@cruisesaudi.com", roles: ["admin", "gateway"] }]);
    const app = await makeGateway(env(dir));
    const page = await app.inject({ url: "/api/auth/login" });
    expect(page.statusCode).toBe(200); expect(page.body).toContain('name="password"');
    const { r, jar } = await localSignIn(app, "OPS@cruisesaudi.com", "a good long password");
    expect(r.statusCode).toBe(302); expect(r.headers.location).toBe("/");
    expect(r.cookies.find((c) => c.name === "sid")).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
    expect((await app.inject({ url: "/api/auth/me", cookies: jar.c })).json()).toMatchObject({ user: "ops@cruisesaudi.com", provider: "local", roles: ["admin", "gateway"], canChangePassword: true });
  });

  it("a wrong password is refused the same way as an unknown account; five misses lock for a while", async () => {
    const dir = tempDir(); await seed(dir, [{ email: "ops@cruisesaudi.com", roles: ["gateway"] }]);
    const app = await makeGateway(env(dir));
    expect((await localSignIn(app, "nobody@cruisesaudi.com", "a good long password")).r.headers.location).toBe("/api/auth/login?error=bad");
    for (let i = 0; i < 5; i++) expect((await localSignIn(app, "ops@cruisesaudi.com", "wrong password!!")).r.headers.location).toBe("/api/auth/login?error=bad");
    expect((await localSignIn(app, "ops@cruisesaudi.com", "a good long password")).r.headers.location).toBe("/api/auth/login?error=locked");
  });

  it("a form posted from another site is refused", async () => {
    const dir = tempDir(); await seed(dir, [{ email: "ops@cruisesaudi.com", roles: ["gateway"] }]);
    const app = await makeGateway(env(dir));
    const r = await app.inject({ method: "POST", url: "/api/auth/local", headers: { origin: "https://evil.example", host: "weave.example.com", "content-type": "application/json" }, payload: { email: "ops@cruisesaudi.com", password: "a good long password" } });
    expect(r.statusCode).toBe(403);
  });

  it("switched off, or no role at all: refused at sign-in", async () => {
    const dir = tempDir(); await seed(dir, [{ email: "off@x.com", roles: ["gateway"], disabled: true }, { email: "none@x.com", roles: [] }]);
    const app = await makeGateway(env(dir));
    expect((await localSignIn(app, "off@x.com", "a good long password")).r.body).toContain("switched off");
    expect((await localSignIn(app, "none@x.com", "a good long password")).r.statusCode).toBe(403);
  });

  it("changes their own password", async () => {
    const dir = tempDir(); await seed(dir, [{ email: "ops@x.com", roles: ["gateway"] }]);
    const app = await makeGateway(env(dir));
    const { jar } = await localSignIn(app, "ops@x.com", "a good long password");
    expect((await app.inject({ method: "POST", url: "/api/auth/password", cookies: jar.c, payload: { current: "wrong", next: "another long password" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/auth/password", cookies: jar.c, payload: { current: "a good long password", next: "short" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/auth/password", cookies: jar.c, payload: { current: "a good long password", next: "another long password" } })).statusCode).toBe(200);
    expect((await localSignIn(app, "ops@x.com", "another long password")).r.headers.location).toBe("/");
  });
});

describe("role checks on every route", () => {
  it("401 when not signed in, 403 with a plain message without the role, unknown addresses still 404", async () => {
    const dir = tempDir(); await seed(dir, [{ email: "mig@x.com", roles: ["migration"] }]);
    const app = await makeGateway(env(dir));
    expect((await app.inject({ url: "/api/ratelimits/x" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/nothing-here" })).statusCode).toBe(404);
    const { jar } = await localSignIn(app, "mig@x.com", "a good long password");
    const r = await app.inject({ url: "/api/ratelimits/x", cookies: jar.c });
    expect(r.statusCode).toBe(403); expect(r.headers["content-type"]).toMatch(/problem\+json/);
    expect((await app.inject({ url: "/api/access/users", cookies: jar.c })).json().title).toMatch(/user management/);
    expect((await app.inject({ method: "POST", url: "/api/ratelimits/x", cookies: jar.c, payload: {} })).statusCode).toBe(403);
  });

  it("a role given or taken by an admin applies on the next request; switching off ends the session", async () => {
    const dir = tempDir(); await seed(dir, [{ email: "a@x.com", roles: ["migration"] }]);
    const app = await makeGateway(env(dir));
    const { jar } = await localSignIn(app, "a@x.com", "a good long password");
    nock(APIM).post("/oauth2/token").reply(200, { access_token: "svc", expires_in: 3600 });
    expect((await app.inject({ url: "/api/ratelimits/x", cookies: jar.c })).statusCode).toBe(403);
    const st = new UserStore(join(dir, "users.json"));
    st.update((d) => { d.users[0].roles = ["migration", "gateway"]; });
    expect((await app.inject({ url: "/api/ratelimits/x", cookies: jar.c })).json()).toEqual({ token: "svc" });
    st.update((d) => { d.users[0].disabled = true; });
    expect((await app.inject({ url: "/api/ratelimits/x", cookies: jar.c })).statusCode).toBe(401);
    expect(await app.tokenFor("anything")).toBeNull();
  });
});

describe("users and access API", () => {
  async function admin() {
    const dir = tempDir(); await seed(dir, [{ email: "boss@x.com", roles: ["admin"] }]);
    const app = await makeGateway(env(dir, { AUTH_PROVIDER: "oidc,local", OIDC_ISSUER: "https://login.microsoftonline.com/tid/v2.0", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s" }));
    const { jar } = await localSignIn(app, "boss@x.com", "a good long password");
    const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as "GET", url, cookies: jar.c, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { dir, app, jar, call };
  }

  it("lists people without password hashes", async () => {
    const { call } = await admin();
    const r = (await call("GET", "/api/access/users")).json();
    expect(r).toMatchObject({ configured: true, providers: ["oidc", "local"], groupsClaim: "groups", auditEnabled: true, me: "u0" });
    expect(r.users[0]).toMatchObject({ email: "boss@x.com", hasPassword: true });
    expect(JSON.stringify(r)).not.toContain("scrypt");
  });

  it("adds a local account and invites a Microsoft account; refuses duplicates and weak passwords", async () => {
    const { call, app } = await admin();
    expect((await call("POST", "/api/access/users", { provider: "local", email: "new@x.com", roles: ["migration"], password: "short" })).statusCode).toBe(400);
    const made = await call("POST", "/api/access/users", { provider: "local", email: "New@X.com", name: "New One", roles: ["migration", "bogus"], password: "a fine long password" });
    expect(made.statusCode).toBe(201); expect(made.json().user).toMatchObject({ email: "new@x.com", roles: ["migration"], hasPassword: true, source: "invited", createdBy: "boss@x.com" });
    expect((await call("POST", "/api/access/users", { provider: "local", email: "new@x.com", roles: [], password: "a fine long password" })).statusCode).toBe(409);
    const inv = await call("POST", "/api/access/users", { provider: "oidc", email: "ana@cruisesaudi.com", roles: ["gateway"] });
    expect(inv.json().user).toMatchObject({ provider: "oidc", hasPassword: false });
    expect((await call("POST", "/api/access/users", { provider: "oidc", email: "not-an-email", roles: [] })).statusCode).toBe(400);
    expect((await localSignIn(app, "new@x.com", "a fine long password")).r.headers.location).toBe("/");
  });

  it("sets roles, switches off and on, resets a password; keeps at least one admin and protects the admin's own access", async () => {
    const { call, app } = await admin();
    const id = (await call("POST", "/api/access/users", { provider: "local", email: "p@x.com", roles: ["migration"], password: "a fine long password" })).json().user.id;
    expect((await call("PATCH", `/api/access/users/${id}`, { roles: ["gateway", "admin"] })).json().user.roles).toEqual(["admin", "gateway"]);
    expect((await call("PATCH", `/api/access/users/${id}`, { disabled: true })).json().user.disabled).toBe(true);
    expect((await call("PATCH", `/api/access/users/${id}`, { disabled: false })).statusCode).toBe(200);
    expect((await call("POST", `/api/access/users/${id}/password`, { password: "the newest password" })).statusCode).toBe(200);
    expect((await localSignIn(app, "p@x.com", "the newest password")).r.headers.location).toBe("/");
    expect((await call("PATCH", "/api/access/users/u0", { roles: ["gateway"] })).json().title).toMatch(/own admin/);
    expect((await call("PATCH", "/api/access/users/u0", { disabled: true })).statusCode).toBe(409);
    expect((await call("DELETE", "/api/access/users/u0")).statusCode).toBe(409);
    // the other admin goes: fine (boss stays); then boss is the last admin
    expect((await call("DELETE", `/api/access/users/${id}`)).statusCode).toBe(200);
    expect((await call("PATCH", "/api/access/users/nope", { roles: [] })).statusCode).toBe(404);
    const inv = (await call("POST", "/api/access/users", { provider: "oidc", email: "ms@x.com", roles: [] })).json().user.id;
    expect((await call("POST", `/api/access/users/${inv}/password`, { password: "a fine long password" })).statusCode).toBe(400);
  });

  it("edits the group mapping and validates it", async () => {
    const { call, dir } = await admin();
    expect((await call("PUT", "/api/access/group-roles", { mappings: [{ group: "g1", roles: [] }, { group: "G1", roles: [] }] })).statusCode).toBe(400);
    const r = await call("PUT", "/api/access/group-roles", { mappings: [{ group: " 7f3e-admins ", label: "Weave Admins", roles: ["admin", "gateway"] }, { group: "", roles: ["admin"] }] });
    expect(r.json().groupRoles).toEqual([{ group: "7f3e-admins", label: "Weave Admins", roles: ["admin", "gateway"] }]);
    expect(JSON.parse(readFileSync(join(dir, "users.json"), "utf8")).groupRoles).toHaveLength(1);
  });

  it("every change is in the audit log, newest first", async () => {
    const { call } = await admin();
    await call("POST", "/api/access/users", { provider: "oidc", email: "ana@cruisesaudi.com", roles: ["gateway"] });
    await call("PUT", "/api/access/group-roles", { mappings: [{ group: "g", roles: ["migration"] }] });
    const log = (await call("GET", "/api/access/audit?limit=10")).json();
    expect(log.enabled).toBe(true);
    expect(log.entries.map((e: { action: string }) => e.action)).toEqual(["groups.update", "user.invite", "sign-in"]);
    expect(log.entries[1]).toMatchObject({ user: "boss@x.com", target: "ana@cruisesaudi.com", detail: "oidc; roles: gateway" });
    expect((await call("GET", "/api/access/audit?q=invite")).json().entries).toHaveLength(1);
  });
});

describe("API Manager sign-in (TraceIT default) still works", () => {
  const jwt = (sub: string) => `x.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.y`;
  async function wso2SignIn(app: Awaited<ReturnType<typeof makeGateway>>, sub: string) {
    const jar = new Jar();
    const start = jar.take(await app.inject({ url: "/api/auth/login?provider=wso2" }));
    expect(start.statusCode).toBe(302);
    const loc = new URL(String(start.headers.location));
    expect(loc.origin + loc.pathname).toBe(`${APIM}/oauth2/authorize`);
    nock(APIM).post("/oauth2/token", (b) => b.grant_type === "authorization_code" && b.code === "c1").reply(200, { access_token: jwt(sub), refresh_token: "r", expires_in: 3600, scope: "apim:admin" });
    const back = jar.take(await app.inject({ url: `/api/auth/callback?code=c1&state=${loc.searchParams.get("state")}`, cookies: jar.c }));
    return { back, jar };
  }
  it("signs in with the person's own API Manager token and every role, as before", async () => {
    const app = await makeGateway({});
    const { back, jar } = await wso2SignIn(app, "admin");
    expect(back.headers.location).toBe("/");
    expect((await app.inject({ url: "/api/auth/me", cookies: jar.c })).json()).toMatchObject({ user: "admin", provider: "wso2", roles: ["admin", "migration", "gateway"], role: "admin" });
    expect((await app.inject({ url: "/api/ratelimits/x", cookies: jar.c })).json()).toEqual({ token: jwt("admin") });
  });
  it("with WSO2_DEFAULT_ROLES empty, only API Manager users on the list get in, with their listed roles", async () => {
    const dir = tempDir();
    new UserStore(join(dir, "users.json")).update((d) => { d.users.push({ id: "w1", email: "apiops", name: "API Ops", provider: "wso2", roles: ["gateway"], disabled: false, createdAt: "", updatedAt: "" }); });
    const app = await makeGateway({ AUTH_PROVIDER: "wso2", WEAVE_USERS_FILE: join(dir, "users.json"), WSO2_DEFAULT_ROLES: "" });
    expect((await wso2SignIn(app, "stranger")).back.statusCode).toBe(403);
    const { jar } = await wso2SignIn(app, "apiops");
    expect((await app.inject({ url: "/api/auth/me", cookies: jar.c })).json().roles).toEqual(["gateway"]);
    expect((await app.inject({ url: "/api/access/users", cookies: jar.c })).statusCode).toBe(403);
    expect(createAuditLog(join(dir, "audit.jsonl"), "t").read().map((e) => e.action)).toEqual(["sign-in", "sign-in refused"]);
  });
  it("refuses to leave no active admin (an API Manager admin editing the only listed admin)", async () => {
    const dir = tempDir(); await seed(dir, [{ email: "only@x.com", roles: ["admin"] }]);
    const app = await makeGateway({ AUTH_PROVIDER: "wso2,local", WEAVE_USERS_FILE: join(dir, "users.json") });
    const { jar } = await wso2SignIn(app, "admin");
    const r = await app.inject({ method: "PATCH", url: "/api/access/users/u0", cookies: jar.c, payload: { roles: ["gateway"] } });
    expect(r.statusCode).toBe(409); expect(r.json().title).toBe("At least one active admin must remain.");
    expect((await app.inject({ method: "DELETE", url: "/api/access/users/u0", cookies: jar.c })).statusCode).toBe(409);
    expect(new UserStore(join(dir, "users.json")).read().users[0].roles).toEqual(["admin"]);
  });
  it("several providers: the sign-in page offers each", async () => {
    const dir = tempDir();
    const app = await makeGateway({ AUTH_PROVIDER: "wso2,local", WEAVE_USERS_FILE: join(dir, "users.json") });
    const page = await app.inject({ url: "/api/auth/login" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("/api/auth/login?provider=wso2"); expect(page.body).toContain('action="/api/auth/local"');
    expect((await app.inject({ url: "/api/auth/login?provider=wso2" })).statusCode).toBe(302);
    expect((await app.inject({ url: "/api/auth/providers" })).json()).toEqual({ providers: ["wso2", "local"], oidcLabel: null });
  });
  it("dev mode on loopback: the dev user, narrowed by DEV_AUTH_ROLES", async () => {
    const keep = { ...process.env };
    process.env.HOST = "127.0.0.1"; process.env.DEV_AUTH_USER = "tester"; process.env.DEV_AUTH_ROLES = "migration";
    try {
      const app = await makeGateway({});
      expect((await app.inject({ url: "/api/auth/me" })).json()).toMatchObject({ user: "tester", roles: ["migration"] });
      expect((await app.inject({ url: "/api/ratelimits/x" })).statusCode).toBe(403);
      process.env.DEV_AUTH_ROLES = "admin";
      const off = await makeGateway({});
      // No users file (the TraceIT default): the screen says user management is off.
      expect((await off.inject({ url: "/api/access/users" })).json()).toMatchObject({ configured: false, users: [] });
      const add = await off.inject({ method: "POST", url: "/api/access/users", payload: { provider: "local", email: "a@b.cd", password: "a good long password" } });
      expect(add.statusCode).toBe(409); expect(add.json().title).toMatch(/WEAVE_USERS_FILE/);
    } finally { process.env = keep; }
  });
});
