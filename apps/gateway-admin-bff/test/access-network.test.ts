// Closed network: the identity provider reached only through a proxy, and short outages.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { proxyFor, createIdpFetch, type IdpFetch } from "../src/access/idpHttp";
import { OidcClient } from "../src/access/oidc";
import { startStandIn, type StandIn } from "./oidcStandIn";

let idp: StandIn;
beforeAll(async () => { idp = await startStandIn(); });
afterAll(async () => { await idp.close(); });

describe("proxy choice", () => {
  const L = "https://login.microsoftonline.com/t/v2.0/.well-known/openid-configuration";
  it("uses OIDC_HTTPS_PROXY, else HTTPS_PROXY, and honours NO_PROXY", () => {
    expect(proxyFor(L, {})).toBeNull();
    expect(proxyFor(L, { HTTPS_PROXY: "http://proxy.corp:3128" })).toBe("http://proxy.corp:3128");
    expect(proxyFor(L, { https_proxy: "http://p:1", OIDC_HTTPS_PROXY: "http://only-idp:8080" })).toBe("http://only-idp:8080");
    expect(proxyFor(L, { HTTPS_PROXY: "http://p:1", NO_PROXY: "localhost,.microsoftonline.com" })).toBeNull();
    expect(proxyFor("https://apim.internal/x", { HTTPS_PROXY: "http://p:1", NO_PROXY: "*.internal" })).toBeNull();
    expect(proxyFor(L, { HTTPS_PROXY: "http://p:1", NO_PROXY: "example.com" })).toBe("http://p:1");
  });

  it("sends the calls through the proxy when one is set", async () => {
    const seen: string[] = [];
    const proxy = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const target = new URL(req.url ?? "");
      const up = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
      req.pipe(up);
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    try {
      const f = createIdpFetch({ HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` });
      const r = await f(`${idp.issuer}/.well-known/openid-configuration`);
      expect(r.status).toBe(200);
      expect(JSON.parse(await r.text()).issuer).toBe(idp.issuer);
      expect(seen[0]).toBe(`GET ${idp.issuer}/.well-known/openid-configuration`);
    } finally { await new Promise((r) => proxy.close(r)); }
  });
});

describe("short outage of the identity provider", () => {
  it("keeps using the discovery document and keys in hand", async () => {
    let down = false;
    const real = createIdpFetch({});
    const f: IdpFetch = async (url, init) => { if (down) throw new Error("connect ETIMEDOUT"); return real(url, init); };
    const c = new OidcClient({ issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, redirectUri: "https://w/cb", scopes: "openid", groupsClaim: "groups", label: "" }, f);
    const now = Math.floor(Date.now() / 1000);
    const tok = () => idp.sign({ iss: idp.issuer, aud: idp.clientId, exp: now + 600, iat: now, nonce: "n", oid: "o", email: "a@b.cd" });
    expect((await c.validateIdToken(tok(), "n")).email).toBe("a@b.cd");
    down = true;
    (c as unknown as { meta: { at: number } }).meta.at = 0;        // discovery due again
    expect(await c.authorizeUrl({ state: "s", nonce: "n", challenge: "c" })).toContain(`${idp.issuer}/authorize`);
    (c as unknown as { keysAt: number }).keysAt = 0;
    expect((await c.validateIdToken(tok(), "n")).email).toBe("a@b.cd");
    // never reached before: a plain error, so the sign-in page can say so (Weave accounts still work)
    const fresh = new OidcClient({ issuer: idp.issuer, clientId: "x", clientSecret: "y", redirectUri: "https://w/cb", scopes: "openid", groupsClaim: "groups", label: "" }, f);
    await expect(fresh.metadata()).rejects.toThrow(/ETIMEDOUT/);
  });
});
