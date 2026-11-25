// A stand-in OpenID Connect provider for tests: discovery, JWKS and a token endpoint that checks
// the client secret, the redirect address and PKCE, then hands out an ID token it signs itself.
// It only listens on 127.0.0.1; nothing is registered with any real identity provider.
import http from "node:http";
import crypto, { type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface StandIn {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Prepare the answer to the next code exchange: the claims go into the ID token. */
  issueCode(p: { nonce: string; challenge: string; redirectUri: string; claims?: Record<string, unknown>; sign?: (claims: Record<string, unknown>) => string }): string;
  sign(claims: Record<string, unknown>, o?: { kid?: string; key?: KeyObject; alg?: string }): string;
  /** New signing key with a new kid; the old one leaves the JWKS. */
  rotate(): void;
  jwksHits: number;
  close(): Promise<void>;
}

export async function startStandIn(clientId = "weave-client", clientSecret = "stand-in-secret"): Promise<StandIn> {
  let key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  let kid = "key-1";
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; claims: Record<string, unknown>; sign?: (c: Record<string, unknown>) => string }>();
  let issuer = "";
  const self: StandIn = {
    issuer: "", clientId, clientSecret, jwksHits: 0,
    issueCode(p) {
      const code = crypto.randomBytes(12).toString("hex");
      codes.set(code, { ...p, claims: p.claims ?? {} });
      return code;
    },
    sign(claims, o = {}) {
      const alg = o.alg ?? "RS256";
      const header = Buffer.from(JSON.stringify({ alg, kid: o.kid ?? kid, typ: "JWT" })).toString("base64url");
      const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const sig = crypto.sign("sha256", Buffer.from(`${header}.${body}`), o.key ?? key.privateKey).toString("base64url");
      return `${header}.${body}.${sig}`;
    },
    rotate() { key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }); kid = `key-${Date.now()}`; },
    close: () => new Promise((r) => server.close(() => r())),
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, j: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (url.pathname === "/tenant/v2.0/.well-known/openid-configuration") {
      return send(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys`, id_token_signing_alg_values_supported: ["RS256"] });
    }
    if (url.pathname === "/tenant/v2.0/keys") {
      self.jwksHits++;
      return send(200, { keys: [{ ...(key.publicKey.export({ format: "jwk" }) as object), kid, use: "sig", alg: "RS256" }] });
    }
    if (url.pathname === "/tenant/v2.0/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const f = new URLSearchParams(raw);
        if (f.get("client_id") !== clientId || f.get("client_secret") !== clientSecret) return send(401, { error: "invalid_client" });
        const c = codes.get(f.get("code") ?? "");
        if (!c || f.get("grant_type") !== "authorization_code") return send(400, { error: "invalid_grant" });
        codes.delete(f.get("code")!);
        if (f.get("redirect_uri") !== c.redirectUri) return send(400, { error: "invalid_grant" });
        const want = crypto.createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
        if (want !== c.challenge) return send(400, { error: "invalid_grant" });
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: issuer, aud: clientId, iat: now, nbf: now, exp: now + 3600, nonce: c.nonce, ver: "2.0", ...c.claims };
        return send(200, { token_type: "Bearer", expires_in: 3600, access_token: "opaque-graph-token", id_token: c.sign ? c.sign(claims) : self.sign(claims) });
      });
      return;
    }
    send(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tenant/v2.0`;
  self.issuer = issuer;
  return self;
}
