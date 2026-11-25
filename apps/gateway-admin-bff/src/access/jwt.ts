// Signed JWT checks with node:crypto only (no extra packages): the signature against a JWKS key,
// then issuer, audience, expiry, not-before and nonce. Only asymmetric algorithms are accepted;
// "none" and HMAC (HS*) are always refused.
import crypto, { type KeyObject } from "node:crypto";

export interface Jwk { kty: string; kid?: string; use?: string; alg?: string; n?: string; e?: string; crv?: string; x?: string; y?: string; [k: string]: unknown }
export interface JwtHeader { alg: string; kid?: string; typ?: string }
export type Claims = Record<string, unknown> & { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; iat?: number; nonce?: string; sub?: string };

const ALGS: Record<string, { hash: string; kty: string; pss?: boolean; ec?: boolean }> = {
  RS256: { hash: "sha256", kty: "RSA" }, RS384: { hash: "sha384", kty: "RSA" }, RS512: { hash: "sha512", kty: "RSA" },
  PS256: { hash: "sha256", kty: "RSA", pss: true }, PS384: { hash: "sha384", kty: "RSA", pss: true }, PS512: { hash: "sha512", kty: "RSA", pss: true },
  ES256: { hash: "sha256", kty: "EC", ec: true }, ES384: { hash: "sha384", kty: "EC", ec: true }, ES512: { hash: "sha512", kty: "EC", ec: true },
};
export const SUPPORTED_ALGS = Object.keys(ALGS);

export class TokenError extends Error {
  constructor(readonly reason: string) { super(`ID token refused: ${reason}`); }
}

function b64json<T>(part: string, what: string): T {
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T; } catch { throw new TokenError(`${what} is not readable`); }
}

export function decodeJwt(token: string): { header: JwtHeader; claims: Claims; signed: string; signature: Buffer } {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new TokenError("not a signed JWT");
  return { header: b64json<JwtHeader>(parts[0], "header"), claims: b64json<Claims>(parts[1], "payload"), signed: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], "base64url") };
}

export function keyFromJwk(jwk: Jwk): KeyObject {
  return crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
}

export function verifySignature(token: string, pickKey: (h: JwtHeader) => { key: KeyObject; jwk?: Jwk } | null, allowed = SUPPORTED_ALGS) {
  const d = decodeJwt(token);
  const spec = ALGS[d.header.alg];
  if (!spec || !allowed.includes(d.header.alg)) throw new TokenError(`algorithm ${String(d.header.alg)} is not allowed`);
  const k = pickKey(d.header);
  if (!k) throw new TokenError("signing key not found");
  if (k.jwk && k.jwk.kty !== spec.kty) throw new TokenError("key type does not match the algorithm");
  if (k.jwk?.alg && k.jwk.alg !== d.header.alg) throw new TokenError("key is for another algorithm");
  if (k.jwk?.use && k.jwk.use !== "sig") throw new TokenError("key is not a signing key");
  const ok = crypto.verify(spec.hash, Buffer.from(d.signed), {
    key: k.key,
    ...(spec.pss ? { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST } : {}),
    ...(spec.ec ? { dsaEncoding: "ieee-p1363" as const } : {}),
  }, d.signature);
  if (!ok) throw new TokenError("signature does not match");
  return d;
}

export interface ClaimRules { issuer: string; audience: string; nonce?: string; now?: number; skewSeconds?: number; maxAgeSeconds?: number }

export function checkClaims(c: Claims, r: ClaimRules): void {
  const now = Math.floor((r.now ?? Date.now()) / 1000);
  const skew = r.skewSeconds ?? 120;
  const trim = (s: string) => s.replace(/\/+$/, "");
  if (typeof c.iss !== "string" || trim(c.iss) !== trim(r.issuer)) throw new TokenError("issuer does not match");
  const aud = Array.isArray(c.aud) ? c.aud : typeof c.aud === "string" ? [c.aud] : [];
  if (!aud.includes(r.audience)) throw new TokenError("audience does not match");
  if (aud.length > 1 && c.azp !== undefined && c.azp !== r.audience) throw new TokenError("authorized party does not match");
  if (typeof c.exp !== "number") throw new TokenError("no expiry");
  if (now > c.exp + skew) throw new TokenError("expired");
  if (typeof c.nbf === "number" && now + skew < c.nbf) throw new TokenError("not valid yet");
  if (typeof c.iat === "number") {
    if (c.iat > now + skew) throw new TokenError("issued in the future");
    if (r.maxAgeSeconds && now - c.iat > r.maxAgeSeconds + skew) throw new TokenError("too old");
  }
  if (r.nonce !== undefined) {
    const a = Buffer.from(String(c.nonce ?? "")); const b = Buffer.from(r.nonce);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new TokenError("nonce does not match");
  }
}
