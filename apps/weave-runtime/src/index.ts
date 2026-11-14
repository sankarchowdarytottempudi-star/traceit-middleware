import { loadConfig } from "./config.js";
import { Runtime } from "./runtime.js";
import { startServer } from "./server.js";
import { createGateway } from "./gateway/apim.js";

async function main() {
  const cfg = loadConfig();
  if (!cfg.internalKey) throw new Error("RUNTIME_INTERNAL_KEY is not set; the management API would be unprotected");
  const rt = new Runtime(cfg);
  rt.gateway = createGateway(cfg, rt.http, rt.store);
  const server = await startServer(cfg, rt);
  console.log(`[weave-runtime] listening on ${server.addresses.join(", ")}; data in ${cfg.dataDir}; ${rt.flowsDeployed()} deployed flow(s); gateway ${rt.gateway.enabled ? "configured" : "not configured"}; in-estate model ${cfg.modelUrl ? "configured" : "off"}`);
  void rt.primeGateway();
  rt.startReconcile();
  let closing = false;
  const stop = (sig: string) => {
    if (closing) return; closing = true;
    console.log(`[weave-runtime] ${sig}: shutting down`);
    const t = setTimeout(() => process.exit(0), 8000); t.unref();
    server.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("unhandledRejection", (e) => console.error("[weave-runtime] unhandled rejection:", (e as Error)?.message ?? e));
}
main().catch((e) => { console.error(`[weave-runtime] failed to start: ${(e as Error).message}`); process.exit(1); });
