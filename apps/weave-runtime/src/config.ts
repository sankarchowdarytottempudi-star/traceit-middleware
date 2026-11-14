// Runtime configuration. Every value comes from the environment (see README.md for the names).
import fs from "node:fs";

export interface Config {
  port: number;
  binds: string[];
  internalKey: string;
  dataDir: string;
  secretKeyFile: string;
  clusterDns: string;
  gatewayBackendUrl: string;
  gatewayPublicUrl: string;
  apimBaseUrl: string;
  apimPublicUrl: string;
  apimCaPem: string;
  apimUser: string;
  apimPass: string;
  apimTestApp: string;
  apiNamePrefix: string;
  modelUrl: string;
  execHistoryPerFlow: number;
  reconcileSeconds: number;
  logLevel: string;
}

const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) ? n : d; };
const trimSlash = (s: string) => s.replace(/\/+$/, "");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const binds = (env.BIND || "127.0.0.1").split(",").map((s) => s.trim()).filter(Boolean);
  for (const b of binds) {
    if (b === "0.0.0.0" || b === "::" || b === "*") throw new Error("BIND must list specific addresses; the runtime is never exposed on every interface");
  }
  const dataDir = env.DATA_DIR || "./.data";
  let caPem = "";
  if (env.APIM_CA_CERT_PATH) { try { caPem = fs.readFileSync(env.APIM_CA_CERT_PATH, "utf8"); } catch { caPem = ""; } }
  return {
    port: num(env.PORT, 8790),
    binds,
    internalKey: env.RUNTIME_INTERNAL_KEY || "",
    dataDir,
    secretKeyFile: env.SECRET_KEY_FILE || `${dataDir}/secret.key`,
    clusterDns: env.CLUSTER_DNS || "",
    gatewayBackendUrl: trimSlash(env.GATEWAY_BACKEND_URL || ""),
    gatewayPublicUrl: trimSlash(env.GATEWAY_PUBLIC_URL || ""),
    apimBaseUrl: trimSlash(env.APIM_BASE_URL || ""),
    apimPublicUrl: trimSlash(env.APIM_PUBLIC_URL || env.APIM_BASE_URL || ""),
    apimCaPem: caPem,
    apimUser: env.APIM_DCR_USERNAME || "",
    apimPass: env.APIM_DCR_PASSWORD || "",
    apimTestApp: env.APIM_TEST_APP_NAME || "weave-studio-test",
    apiNamePrefix: env.APIM_API_NAME_PREFIX || "weave-",
    modelUrl: env.MODEL_URL || "",
    execHistoryPerFlow: num(env.EXEC_HISTORY_PER_FLOW, 200),
    reconcileSeconds: num(env.GATEWAY_RECONCILE_SECONDS, 120),
    logLevel: env.LOG_LEVEL || "info",
  };
}
