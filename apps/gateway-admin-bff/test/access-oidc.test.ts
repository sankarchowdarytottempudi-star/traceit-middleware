// Sign-in with an OpenID Connect provider (Entra ID shape), end to end against a stand-in provider.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import nock from "nock";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { startStandIn, type StandIn } from "./oidcStandIn";
import { makeGateway, Jar, tempDir, APIM, PUBLIC } from "./accessHelpers";
import { UserStore } from "../src/access/userStore";
import { createAuditLog } from "../src/access/audit";

let idp: StandIn;
beforeAll(async () => { idp = await startStandIn(); });
afterAll(async () => { await idp.close(); });
afterEach(() => nock.cleanAll());

function envFor(dir: string, extra: Record<string, string> = {}) {
  return { AUTH_PROVIDER: "oidc", OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: idp.clientId, OIDC_CLIENT_SECRET: idp.clientSecret, WEAVE_USERS_FILE: join(dir, "users.json"), ...extra };
}
function invite(dir: string, email: string, roles: ("admin" | "migration" | "gateway")[], more: Record<string, unknown> = {}) {
  new UserStore(join(dir, "users.json")).update((d) => { d.users.push({ id: `u-${email}`, email, name: email, provider: "oidc", roles, disabled: false, createdAt: "", updatedAt: "", ...more }); });
}

async function signIn(app: FastifyInstance, claims: Record<string, unknown>, o: { jar?: Jar; sign?: (c: Record<string, unknown>) => string; dropStateCookie?: boolean } = {}) {
  const jar = o.jar ?? new Jar();
  const start = jar.take(await app.inject({ url: "/api/auth/login?provider=oidc" }));
  expect(start.statusCode).toBe(302);
  const loc = new URL(String(start.headers.location));
  const q = Object.fromEntries(loc.searchParams);
  const code = idp.issueCode({ nonce: q.nonce, challenge: q.code_challenge, redirectUri: q.redirect_uri, claims, sign: o.sign });
  if (o.dropStateCookie) delete jar.c.sid_st;
  const back = jar.take(await app.inject({ url: `/api/auth/callback?code=${code}&state=${q.state}`, cookies: jar.c }));
  return { start, loc, q, back, jar };
}

describe("OIDC sign-in (Entra ID shape)", () => {
  it("sends the browser to the provider with PKCE (S256), state, nonce, scopes and the registered callback", async () => {
    const app = await makeGateway(envFor(tempDir()));
    const r = await app.inject({ url: "/api/auth/login" });           // only one provider: straight there
    const loc = new URL(String(r.headers.location));
    expect(loc.origin + loc.pathname).toBe(`${idp.issuer}/authorize`);
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({ response_type: "code", client_id: idp.clientId, redirect_uri: `${PUBLIC}/api/auth/callback`, scope: "openid profile email", code_challenge_method: "S256" });
    expect(loc.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
    expect(loc.searchParams.get("nonce")!.length).toBeGreaterThan(20);
    const st = r.cookies.find((c) => c.name === "sid_st")!;
    expect(st).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
  });

  it("an invited person signs in: token verified, directory id bound, real roles in /api/auth/me", async () => {
    const dir = tempDir(); invite(dir, "ana@cruisesaudi.com", ["migration"]);
    const app = await makeGateway(envFor(dir));
    const { back, jar } = await signIn(app, { oid: "oid-ana", sub: "pairwise", preferred_username: "Ana@CruiseSaudi.com", name: "Ana Q" });
    expect(back.statusCode).toBe(302); expect(back.headers.location).toBe("/");
    expect(back.cookies.find((c) => c.name === "sid")).toMatchObject({ httpOnly: true, secure: true, path: "/" });
    const me = await app.inject({ url: "/api/auth/me", cookies: jar.c });
    expect(me.json()).toMatchObject({ user: "ana@cruisesaudi.com", name: "Ana Q", provider: "oidc", roles: ["migration"] });
    expect(new UserStore(join(dir, "users.json")).read().users[0]).toMatchObject({ subject: "oid-ana", lastSignInAt: expect.any(String) });
    // Migration only: the Gateway console says no, plainly.
    const gw = await app.inject({ url: "/api/ratelimits/subscription", cookies: jar.c });
    expect(gw.statusCode).toBe(403);
    expect(gw.json().title).toBe("You do not have access to the Gateway console. Ask an administrator to grant it.");
  });

  it("directory groups give roles; the person is listed at first sign-in", async () => {
    const dir = tempDir();
    new UserStore(join(dir, "users.json")).update((d) => { d.groupRoles = [{ group: "1b2c-gw", label: "Weave Gateway", roles: ["gateway"] }]; });
    const app = await makeGateway(envFor(dir));
    const { back, jar } = await signIn(app, { oid: "oid-bo", email: "bo@cruisesaudi.com", groups: ["other", "1B2C-GW"] });
    expect(back.statusCode).toBe(302);
    expect((await app.inject({ url: "/api/auth/me", cookies: jar.c })).json().roles).toEqual(["gateway"]);
    const u = new UserStore(join(dir, "users.json")).read().users;
    expect(u).toHaveLength(1); expect(u[0]).toMatchObject({ email: "bo@cruisesaudi.com", source: "groups", roles: [] });
    // Taking the group mapping away takes the access away on the next request.
    new UserStore(join(dir, "users.json")).update((d) => { d.groupRoles = []; });
    expect((await app.inject({ url: "/api/ratelimits/x", cookies: jar.c })).statusCode).toBe(403);
  });

  it("API Manager calls for a Microsoft account use the service account, and the audit log names the person", async () => {
    const dir = tempDir(); invite(dir, "cy@cruisesaudi.com", ["gateway"]);
    const app = await makeGateway(envFor(dir));
    const { jar } = await signIn(app, { oid: "oid-cy", email: "cy@cruisesaudi.com" });
    const tok = nock(APIM).post("/oauth2/token", (b) => b.grant_type === "password" && b.username === "svc-user").reply(200, { access_token: "svc-token", expires_in: 3600 });
    expect((await app.inject({ url: "/api/ratelimits/x", cookies: jar.c })).json()).toEqual({ token: "svc-token" });
    expect((await app.inject({ url: "/api/ratelimits/y", cookies: jar.c })).json()).toEqual({ token: "svc-token" }); // cached
    expect(tok.isDone()).toBe(true);
    await app.inject({ method: "POST", url: "/api/ratelimits/subscription", cookies: jar.c, payload: {} });
    const log = createAuditLog(join(dir, "audit.jsonl"), "t").read();
    expect(log[0]).toMatchObject({ user: "cy@cruisesaudi.com", action: "POST /api/ratelimits/:type", target: "/api/ratelimits/subscription", via: "service-account", status: 200, app: "gateway", provider: "oidc" });
    expect(log.some((e) => e.action === "sign-in" && e.user === "cy@cruisesaudi.com")).toBe(true);
  });

  it("someone with no record and no mapped group is refused with a plain page", async () => {
    const dir = tempDir();
    const app = await makeGateway(envFor(dir));
    const { back } = await signIn(app, { oid: "oid-x", email: "stranger@cruisesaudi.com", groups: ["nothing"] });
    expect(back.statusCode).toBe(403);
    expect(back.body).toContain("not been given access");
    expect(back.cookies.find((c) => c.name === "sid")).toBeUndefined();
    expect(createAuditLog(join(dir, "audit.jsonl"), "t").read()[0]).toMatchObject({ action: "sign-in refused", user: "stranger@cruisesaudi.com" });
  });

  it("a switched-off account is refused", async () => {
    const dir = tempDir(); invite(dir, "off@cruisesaudi.com", ["admin"], { disabled: true });
    const app = await makeGateway(envFor(dir));
    const { back } = await signIn(app, { oid: "oid-off", email: "off@cruisesaudi.com" });
    expect(back.statusCode).toBe(403); expect(back.body).toContain("switched off");
  });

  it.each([
    ["another nonce", (c: Record<string, unknown>) => idp.sign({ ...c, nonce: "not-mine" })],
    ["another audience", (c: Record<string, unknown>) => idp.sign({ ...c, aud: "someone-else" })],
    ["another issuer", (c: Record<string, unknown>) => idp.sign({ ...c, iss: "https://login.microsoftonline.com/other/v2.0" })],
    ["an expired token", (c: Record<string, unknown>) => idp.sign({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 })],
    ["an unknown key", (c: Record<string, unknown>) => idp.sign(c, { kid: "who-knows" })],
    ["alg none", (c: Record<string, unknown>) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(c)).toString("base64url")}.`],
    ["a forged signature", (c: Record<string, unknown>) => { const [h, , s] = idp.sign(c).split("."); return `${h}.${Buffer.from(JSON.stringify({ ...c, email: "boss@cruisesaudi.com" })).toString("base64url")}.${s}`; }],
  ])("an ID token with %s is refused", async (_n, sign) => {
    const dir = tempDir(); invite(dir, "ana@cruisesaudi.com", ["admin"]);
    const app = await makeGateway(envFor(dir));
    const { back, jar } = await signIn(app, { oid: "oid-ana", email: "ana@cruisesaudi.com" }, { sign });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe("/api/auth/login?error=token");
    expect(jar.c.sid).toBeUndefined();
  });

  it("follows a key roll-over at the provider (JWKS read again once)", async () => {
    const dir = tempDir(); invite(dir, "ana@cruisesaudi.com", ["admin"]);
    const app = await makeGateway(envFor(dir));
    const before = idp.jwksHits;
    expect((await signIn(app, { oid: "o", email: "ana@cruisesaudi.com" })).back.headers.location).toBe("/");
    idp.rotate();
    // The JWKS is read again at most once a minute; pretend the last read was long ago.
    const oidc = app.access.oidc as unknown as { keysAt: number };
    oidc.keysAt = 0;
    expect((await signIn(app, { oid: "o", email: "ana@cruisesaudi.com" })).back.headers.location).toBe("/");
    expect(idp.jwksHits - before).toBe(2);
  });

  it("a callback without this browser's state cookie, or a replayed state, is refused", async () => {
    const dir = tempDir(); invite(dir, "ana@cruisesaudi.com", ["admin"]);
    const app = await makeGateway(envFor(dir));
    const a = await signIn(app, { oid: "o", email: "ana@cruisesaudi.com" }, { dropStateCookie: true });
    expect(a.back.headers.location).toBe("/api/auth/login?error=expired");
    const b = await signIn(app, { oid: "o", email: "ana@cruisesaudi.com" });
    expect(b.back.headers.location).toBe("/");
    const again = await app.inject({ url: `/api/auth/callback?code=x&state=${b.q.state}`, cookies: { sid_st: "whatever" } });
    expect(again.headers.location).toBe("/api/auth/login?error=expired");
    const denied = await app.inject({ url: "/api/auth/callback?error=access_denied&state=abc" });
    expect(denied.headers.location).toBe("/api/auth/login?error=cancelled");
  });

  it("signs out: the session is gone", async () => {
    const dir = tempDir(); invite(dir, "ana@cruisesaudi.com", ["gateway"]);
    const app = await makeGateway(envFor(dir));
    const { jar } = await signIn(app, { oid: "o", email: "ana@cruisesaudi.com" });
    const sid = jar.c.sid;
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", cookies: jar.c })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/auth/me", cookies: { sid } })).statusCode).toBe(401);
  });
});
