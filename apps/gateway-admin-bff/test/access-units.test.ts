import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanRoles, rolesFromGroups, unionRoles } from "../src/access/roles";
import { hashPassword, verifyPassword, passwordProblem } from "../src/access/passwords";
import { checkClaims, verifySignature, keyFromJwk, TokenError, type Jwk } from "../src/access/jwt";
import { identityOf } from "../src/access/oidc";
import { readAuthSettings } from "../src/access/settings";
import { UserStore } from "../src/access/userStore";
import { createAuditLog } from "../src/access/audit";
import { bootstrapAdmin } from "../src/access/plugin";
import { signInPage } from "../src/access/pages";
import { tempDir } from "./accessHelpers";

describe("roles", () => {
  it("keeps known roles only, once, in a fixed order", () => {
    expect(cleanRoles(["Gateway", "admin", "x", "admin"])).toEqual(["admin", "gateway"]);
    expect(cleanRoles("migration, gateway")).toEqual(["migration", "gateway"]);
    expect(cleanRoles(undefined)).toEqual([]);
  });
  it("maps directory groups to roles by id or name, ignoring case", () => {
    const map = [{ group: "AAAA-1111", roles: ["migration" as const] }, { group: "Weave Admins", roles: ["admin" as const, "gateway" as const] }];
    expect(rolesFromGroups(["aaaa-1111"], map)).toEqual(["migration"]);
    expect(rolesFromGroups(["weave admins", "other"], map)).toEqual(["admin", "gateway"]);
    expect(rolesFromGroups([], map)).toEqual([]);
    expect(unionRoles(["gateway"], ["admin"])).toEqual(["admin", "gateway"]);
  });
});

describe("passwords (scrypt)", () => {
  it("hashes with a random salt and verifies", async () => {
    const a = await hashPassword("correct horse battery"); const b = await hashPassword("correct horse battery");
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$/); expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("correct horse batterY", a)).toBe(false);
    expect(await verifyPassword("anything", undefined)).toBe(false);
    expect(await verifyPassword("anything", "plain-text")).toBe(false);
  });
  it("refuses short or trivial passwords", () => {
    expect(passwordProblem("short")).toMatch(/12/);
    expect(passwordProblem("aaaaaaaaaaaaaaa")).toMatch(/repeat/);
    expect(passwordProblem("a long enough one")).toBeNull();
  });
});

describe("JWT checks", () => {
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...(rsa.publicKey.export({ format: "jwk" }) as Jwk), kid: "r1", use: "sig" };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  function make(alg: string, claims: object, key: crypto.KeyObject = rsa.privateKey, kid = "r1") {
    const h = b64({ alg, kid }); const p = b64(claims);
    const opts = alg.startsWith("PS") ? { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : alg.startsWith("ES") ? { key, dsaEncoding: "ieee-p1363" as const } : key;
    return `${h}.${p}.${crypto.sign("sha256", Buffer.from(`${h}.${p}`), opts).toString("base64url")}`;
  }
  const pick = () => ({ key: keyFromJwk(jwk), jwk });
  it("accepts RS256, PS256 and ES256 signatures", () => {
    expect(verifySignature(make("RS256", { a: 1 }), pick).claims.a).toBe(1);
    expect(verifySignature(make("PS256", { a: 2 }), pick).claims.a).toBe(2);
    const ecJwk = { ...(ec.publicKey.export({ format: "jwk" }) as Jwk), kid: "e1" };
    expect(verifySignature(make("ES256", { a: 3 }, ec.privateKey, "e1"), () => ({ key: keyFromJwk(ecJwk), jwk: ecJwk })).claims.a).toBe(3);
  });
  it("refuses alg none, HMAC, a tampered payload, another key and a key of the wrong type", () => {
    const none = `${b64({ alg: "none" })}.${b64({ a: 1 })}.x`;
    expect(() => verifySignature(none, pick)).toThrow(/algorithm/);
    const hs = `${b64({ alg: "HS256", kid: "r1" })}.${b64({ a: 1 })}.${crypto.createHmac("sha256", "k").update("x").digest("base64url")}`;
    expect(() => verifySignature(hs, pick)).toThrow(/algorithm/);
    const good = make("RS256", { a: 1 }).split(".");
    expect(() => verifySignature(`${good[0]}.${b64({ a: 2 })}.${good[2]}`, pick)).toThrow(/signature/);
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => verifySignature(make("RS256", { a: 1 }, other.privateKey), pick)).toThrow(/signature/);
    expect(() => verifySignature(make("ES256", { a: 1 }, ec.privateKey), pick)).toThrow(/key type/);
    expect(() => verifySignature("not.a", pick)).toThrow(TokenError);
  });
  it("checks issuer, audience, expiry, not-before and nonce", () => {
    const now = Date.now(); const s = Math.floor(now / 1000);
    const ok = { iss: "https://login.example/t/v2.0", aud: "cid", exp: s + 600, iat: s, nbf: s, nonce: "n1" };
    const rules = { issuer: "https://login.example/t/v2.0", audience: "cid", nonce: "n1", now };
    expect(() => checkClaims(ok, rules)).not.toThrow();
    expect(() => checkClaims({ ...ok, iss: "https://evil/t/v2.0" }, rules)).toThrow(/issuer/);
    expect(() => checkClaims({ ...ok, aud: "other" }, rules)).toThrow(/audience/);
    expect(() => checkClaims({ ...ok, aud: ["cid", "x"], azp: "x" }, rules)).toThrow(/authorized party/);
    expect(() => checkClaims({ ...ok, exp: s - 600 }, rules)).toThrow(/expired/);
    expect(() => checkClaims({ ...ok, exp: undefined }, rules)).toThrow(/expiry/);
    expect(() => checkClaims({ ...ok, nbf: s + 600 }, rules)).toThrow(/not valid yet/);
    expect(() => checkClaims({ ...ok, nonce: "n2" }, rules)).toThrow(/nonce/);
    expect(() => checkClaims({ ...ok, nonce: undefined }, rules)).toThrow(/nonce/);
  });
  it("reads an Entra identity: oid, e-mail or user name, groups, overage", () => {
    const id = identityOf({ oid: "o1", sub: "s1", preferred_username: "Ana@CruiseSaudi.com", name: "Ana", groups: ["g1", "g2"] }, "groups");
    expect(id).toMatchObject({ subject: "o1", email: "ana@cruisesaudi.com", name: "Ana", groups: ["g1", "g2"], groupsOverage: false });
    expect(identityOf({ sub: "s1", email: "a@b.c", _claim_names: { groups: "src1" } }, "groups").groupsOverage).toBe(true);
    expect(identityOf({ sub: "s1", email: "a@b.c", roles: ["Weave.Admin"] }, "roles").groups).toEqual(["Weave.Admin"]);
    expect(() => identityOf({ sub: "s1" }, "groups")).toThrow(/e-mail/);
  });
});

describe("settings", () => {
  const P = "https://weave.aroya.com";
  it("defaults to the API Manager sign-in with all roles (TraceIT behaviour)", () => {
    const s = readAuthSettings({}, P);
    expect(s.providers).toEqual(["wso2"]); expect(s.wso2DefaultRoles).toEqual(["admin", "migration", "gateway"]); expect(s.auditFile).toBe("");
  });
  it("reads the Entra settings and fills the defaults", () => {
    const s = readAuthSettings({ AUTH_PROVIDER: "oidc,local", WEAVE_USERS_FILE: "/data/access/users.json", OIDC_ISSUER: "https://login.microsoftonline.com/tid/v2.0/", OIDC_CLIENT_ID: "cid", OIDC_CLIENT_SECRET: "sec" }, `${P}/factory`);
    expect(s.providers).toEqual(["oidc", "local"]);
    expect(s.oidc).toMatchObject({ issuer: "https://login.microsoftonline.com/tid/v2.0", redirectUri: `${P}/factory/api/auth/callback`, scopes: "openid profile email", groupsClaim: "groups" });
    expect(s.auditFile).toBe("/data/access/audit.jsonl");
  });
  it("refuses incomplete or unsafe settings", () => {
    expect(() => readAuthSettings({ AUTH_PROVIDER: "ldap" }, P)).toThrow(/unknown provider/);
    expect(() => readAuthSettings({ AUTH_PROVIDER: "local" }, P)).toThrow(/WEAVE_USERS_FILE/);
    expect(() => readAuthSettings({ AUTH_PROVIDER: "oidc", WEAVE_USERS_FILE: "/x" }, P)).toThrow(/OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET/);
    expect(() => readAuthSettings({ AUTH_PROVIDER: "oidc", WEAVE_USERS_FILE: "/x", OIDC_ISSUER: "http://idp.example", OIDC_CLIENT_ID: "a", OIDC_CLIENT_SECRET: "b" }, P)).toThrow(/https/);
    expect(readAuthSettings({ WSO2_DEFAULT_ROLES: "" }, P).wso2DefaultRoles).toEqual([]);
  });
});

describe("users file", () => {
  it("saves atomically, keeps the hash out of reads for the screen, and matches identities", () => {
    const dir = tempDir(); const st = new UserStore(join(dir, "users.json"));
    expect(st.read().users).toEqual([]);
    st.update((d) => { d.users.push({ id: "u1", email: "ana@x.com", name: "Ana", provider: "oidc", roles: ["migration"], disabled: false, createdAt: "", updatedAt: "" }); });
    expect(existsSync(join(dir, "users.json.lock"))).toBe(false);
    expect(st.match("oidc", "ANA@x.com", "oid-1")?.id).toBe("u1");          // invitation, not yet bound
    st.update((d) => { d.users[0].subject = "oid-1"; });
    expect(st.match("oidc", "ana@x.com", "oid-2")).toBeUndefined();          // bound to someone else
    expect(st.match("oidc", "other@x.com", "oid-1")?.id).toBe("u1");
    expect(st.match("local", "ana@x.com")).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "users.json"), "utf8")).version).toBe(1);
  });
  it("takes over a stale lock left by a crashed process", () => {
    const dir = tempDir(); const file = join(dir, "users.json"); const st = new UserStore(file);
    writeFileSync(`${file}.lock`, "999999"); const old = new Date(Date.now() - 60_000); utimesSync(`${file}.lock`, old, old);
    st.update((d) => { d.groupRoles.push({ group: "g", roles: ["admin"] }); });
    expect(st.groupRoles()).toEqual([{ group: "g", roles: ["admin"] }]);
  });
  it("loses no change when several processes write at the same time", async () => {
    const dir = tempDir(); const file = join(dir, "users.json");
    const mod = resolve(__dirname, "../src/access/userStore.ts");
    const script = join(dir, "writer.ts");
    writeFileSync(script, `import { UserStore } from ${JSON.stringify(mod)};
const st = new UserStore(${JSON.stringify(file)});
for (let i = 0; i < 25; i++) st.update((d) => { d.users.push({ id: process.argv[2] + "-" + i, email: process.argv[2] + i + "@x.com", name: "", provider: "local", roles: [], disabled: false, createdAt: "", updatedAt: "" }); });
`);
    const run = (tag: string) => new Promise<number>((res) => { const p = spawn(process.execPath, ["--import", "tsx", script, tag], { cwd: resolve(__dirname, ".."), stdio: "inherit" }); p.on("exit", (c) => res(c ?? 1)); });
    const codes = await Promise.all(["a", "b", "c", "d"].map(run));
    expect(codes).toEqual([0, 0, 0, 0]);
    const users = new UserStore(file).read().users;
    expect(users).toHaveLength(100);
    expect(new Set(users.map((u) => u.id)).size).toBe(100);
  }, 60_000);
  it("first admin: created once, password from the bootstrap only, never a default", async () => {
    const st = new UserStore(join(tempDir(), "users.json"));
    await expect(bootstrapAdmin(st, { email: "ops@cruisesaudi.com", provider: "local" })).rejects.toThrow(/password/);
    await expect(bootstrapAdmin(st, { email: "nope", provider: "oidc" })).rejects.toThrow(/e-mail/);
    const r = await bootstrapAdmin(st, { email: "Ops@CruiseSaudi.com", provider: "local", password: "a good long password" });
    expect(r.created).toMatchObject({ email: "ops@cruisesaudi.com", roles: ["admin", "migration", "gateway"] });
    expect(await verifyPassword("a good long password", st.read().users[0].passwordHash)).toBe(true);
    expect((await bootstrapAdmin(st, { email: "second@cruisesaudi.com", provider: "oidc" })).skipped).toMatch(/already/);
  });
});

describe("audit log", () => {
  it("appends JSON lines and reads newest first, with a search", () => {
    const file = join(tempDir(), "audit.jsonl"); const a = createAuditLog(file, "gateway");
    a.write({ user: "ana@x.com", action: "sign-in" });
    a.write({ user: "bo@x.com", action: "POST /api/ratelimits/:type", target: "/api/ratelimits/subscription", via: "service-account", status: 201 });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ user: "bo@x.com", app: "gateway", via: "service-account", status: 201 });
    expect(a.read().map((e) => e.user)).toEqual(["bo@x.com", "ana@x.com"]);
    expect(a.read({ q: "sign-in" })).toHaveLength(1);
    expect(createAuditLog(undefined, "x").enabled).toBe(false);
  });
});

describe("sign-in page", () => {
  it("lists the providers and escapes what it shows", () => {
    const html = signInPage({ product: "Cruise Saudi Weave", area: "Gateway console", base: "", providers: ["oidc", "local"], oidcLabel: "Sign in with <Microsoft>", message: "bad", email: '"><script>' });
    expect(html).toContain("/api/auth/login?provider=oidc");
    expect(html).toContain("Sign in with &lt;Microsoft&gt;");
    expect(html).toContain('action="/api/auth/local"');
    expect(html).not.toContain("<script>");
    expect(html).toContain("do not match");
    expect(signInPage({ product: "W", area: "a", base: "/factory", providers: ["wso2"], message: "<b>" })).not.toContain("<b>");
  });
});
