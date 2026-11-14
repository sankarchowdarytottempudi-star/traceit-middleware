import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";
import { pkce, refreshToken, dcrRegister } from "../src/wso2";

const BASE = "https://wso2.test";
const opts = { baseUrl: BASE, caPem: "" };
afterEach(() => nock.cleanAll());

describe("pkce", () => {
  it("derives an S256 challenge from the verifier", () => {
    const { verifier, challenge } = pkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/); expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/); expect(challenge).not.toBe(verifier);
  });
});
describe("DCR + token refresh (WSO2 mocked)", () => {
  it("registers a client via DCR", async () => {
    nock(BASE).post("/client-registration/v0.17/register").reply(200, { clientId: "cid", clientSecret: "sec" });
    expect(await dcrRegister(opts, "admin", "admin")).toEqual({ clientId: "cid", clientSecret: "sec" });
  });
  it("refreshes an access token", async () => {
    nock(BASE).post("/oauth2/token").reply(200, { access_token: "new", refresh_token: "r2", expires_in: 3600 });
    const t = await refreshToken(opts, "cid", "sec", "r1");
    expect(t.access_token).toBe("new"); expect(t.expires_in).toBe(3600);
  });
});
