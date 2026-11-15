import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { dcrRegister } from "./wso2.js";
import { buildServer } from "./server.js";
import { createSessionStore } from "./sessionStore.js";
import { basePath, type ClientCreds } from "./auth.js";

async function ensureCreds(cfg: ReturnType<typeof loadConfig>): Promise<ClientCreds> {
  const dir = cfg.DATA_DIR; const file = join(dir, "creds.json");          // configurable data dir (deploy lesson)
  const callbackUrl = `${cfg.PUBLIC_BASE_URL.replace(/\/+$/, "")}/api/auth/callback`;   // REAL callback (deploy lesson)
  const base = basePath(cfg.PUBLIC_BASE_URL);
  if (existsSync(file)) {
    const kept: ClientCreds = JSON.parse(readFileSync(file, "utf8"));
    // A registration is good for one callback address. One made before the address was recorded
    // can only belong to an address without a path (no other kind worked then).
    const same = kept.callbackUrl ? kept.callbackUrl === callbackUrl : !base;
    // The loopback test instance never signs anyone in, so it keeps what it was given.
    if (same || process.env.DEV_AUTH_USER) return kept;
    copyFileSync(file, join(dir, `creds.before-${Date.now()}.json`));
  }
  // A name of its own under a path: asking again for an existing name hands back the old registration, old callback included.
  const clientName = base ? `weave-factory-${createHash("sha256").update(callbackUrl).digest("hex").slice(0, 8)}` : "weave-factory";
  const made = await dcrRegister({ baseUrl: cfg.APIM_BASE_URL, caPem: cfg.caPem }, cfg.APIM_DCR_USERNAME, cfg.APIM_DCR_PASSWORD, callbackUrl, clientName);
  const creds: ClientCreds = { ...made, callbackUrl };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(creds), { mode: 0o600 });
  return creds;
}

async function main() {
  const cfg = loadConfig();
  const creds = await ensureCreds(cfg);
  const store = await createSessionStore(cfg.REDIS_URL || undefined, cfg.DATA_DIR);
  const app = await buildServer(cfg, creds, store);
  const host = process.env.HOST || "0.0.0.0";
  // DEV_AUTH_USER skips sign-in for automated UI tests. It is honoured ONLY on a loopback-bound
  // instance, so it can never be reached through the public proxy.
  if (process.env.DEV_AUTH_USER && host !== "127.0.0.1") {
    throw new Error("DEV_AUTH_USER is only allowed with HOST=127.0.0.1");
  }
  await app.listen({ port: cfg.PORT, host });
}
main().catch((e) => { console.error(e); process.exit(1); });
