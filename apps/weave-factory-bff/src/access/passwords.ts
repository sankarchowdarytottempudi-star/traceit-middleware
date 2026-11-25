// Local account passwords: scrypt (node:crypto), random salt, constant-time compare.
// Stored as "scrypt$N$r$p$<salt b64url>$<hash b64url>" so the cost can be raised later.
import crypto from "node:crypto";

const N = 16384, R = 8, P = 1, KEYLEN = 64;
export const MIN_PASSWORD = 12;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password.normalize("NFKC"), salt, len, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string | undefined | null): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    // Spend the same time as a real check, so a missing account cannot be told apart by timing.
    await scrypt(password, Buffer.alloc(16), N, R, P, KEYLEN);
    return false;
  }
  const [, n, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, "base64url");
  const got = await scrypt(password, Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p), want.length);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** Plain reason a new password is refused, or null when it is acceptable. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > 256) return "Use at most 256 characters.";
  if (/^(.)\1+$/.test(password)) return "Do not repeat one character.";
  return null;
}
