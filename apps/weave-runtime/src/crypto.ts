// Secrets at rest: AES-256-GCM with the key held in a file on the server (SECRET_KEY_FILE).
// Format of an encrypted value: "v1:<iv b64>:<tag b64>:<ciphertext b64>".
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class SecretBox {
  private key: Buffer;
  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("secret key must be 32 bytes");
    this.key = key;
  }
  /** Loads the key file (64 hex chars, base64 of 32 bytes, or 32 raw bytes). Creates one (0600) when missing. */
  static fromFile(file: string): SecretBox {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    }
    const raw = fs.readFileSync(file);
    const text = raw.toString("utf8").trim();
    let key: Buffer;
    if (/^[0-9a-fA-F]{64}$/.test(text)) key = Buffer.from(text, "hex");
    else if (/^[A-Za-z0-9+/]{43}=?$/.test(text)) key = Buffer.from(text, "base64");
    else if (raw.length === 32) key = raw;
    else key = crypto.createHash("sha256").update(raw).digest();
    return new SecretBox(key);
  }
  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
  }
  decrypt(enc: string): string {
    const parts = enc.split(":");
    if (parts.length !== 4 || parts[0] !== "v1") throw new Error("unsupported secret format");
    const d = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(parts[1], "base64"));
    d.setAuthTag(Buffer.from(parts[2], "base64"));
    return Buffer.concat([d.update(Buffer.from(parts[3], "base64")), d.final()]).toString("utf8");
  }
}
