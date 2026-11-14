import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { dcrRegister } from "./wso2.js";
import { buildServer } from "./server.js";
import { createSessionStore } from "./sessionStore.js";
import type { ClientCreds } from "./auth.js";

async function ensureCreds(cfg: ReturnType<typeof loadConfig>): Promise<ClientCreds> {
  const dir = cfg.DATA_DIR; const file = join(dir, "creds.json");          // configurable data dir (deploy lesson)
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const callbackUrl = `${cfg.PUBLIC_BASE_URL}/api/auth/callback`;          // REAL callback (deploy lesson)
  const creds = await dcrRegister({ baseUrl: cfg.APIM_BASE_URL, caPem: cfg.caPem }, cfg.APIM_DCR_USERNAME, cfg.APIM_DCR_PASSWORD, callbackUrl);
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
