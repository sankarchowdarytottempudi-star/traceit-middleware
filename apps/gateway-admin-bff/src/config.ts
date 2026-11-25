import { z } from "zod";
import { readFileSync } from "node:fs";

const schema = z.object({
  APIM_BASE_URL: z.string().url(),
  APIM_PUBLIC_URL: z.string().url().optional().or(z.literal("")),
  APIM_CA_CERT_PATH: z.string().min(1),
  APIM_DCR_USERNAME: z.string().min(1),
  APIM_DCR_PASSWORD: z.string().min(1),
  SESSION_SECRET: z.string().min(16),
  PUBLIC_BASE_URL: z.string().url(),
  MIGRATION_TOOL_URL: z.string().url().optional().or(z.literal("")),
  REDIS_URL: z.string().optional().or(z.literal("")),
  PORT: z.coerce.number().int().positive().default(8787),
  // Where this process keeps its own state (client registration, sessions, analytics index).
  DATA_DIR: z.string().optional().or(z.literal("")),
  // Built console files. Empty = next to the compiled server (the production image layout).
  SPA_DIR: z.string().optional().or(z.literal("")),
  // Read-only Kubernetes access: service discovery, health and logs.
  K8S_API_URL: z.string().optional().or(z.literal("")),
  K8S_TOKEN_FILE: z.string().optional().or(z.literal("")),
  K8S_CA_FILE: z.string().optional().or(z.literal("")),
  K8S_NAMESPACE: z.string().optional().or(z.literal("")),          // services namespace, default "wso2"
  // The cluster the migrated APIs are installed on when it is not this server's (deployment target):
  // a kubeconfig file (+ context) or an API address + token file (+ CA file), and the namespace there.
  // Unset: the cluster above is used. Inventory and service logs then come from the target; the gateway stays here.
  TARGET_KUBECONFIG: z.string().optional().or(z.literal("")),
  TARGET_KUBE_CONTEXT: z.string().optional().or(z.literal("")),
  TARGET_K8S_API_URL: z.string().optional().or(z.literal("")),
  TARGET_K8S_TOKEN_FILE: z.string().optional().or(z.literal("")),
  TARGET_K8S_CA_FILE: z.string().optional().or(z.literal("")),
  TARGET_K8S_NAMESPACE: z.string().optional().or(z.literal("")),
  GATEWAY_NAMESPACE: z.string().optional().or(z.literal("")),      // gateway namespace, default "apim"
  GATEWAY_POD_PREFIX: z.string().optional().or(z.literal("")),     // gateway pod name prefix, default "wso2am"
  PROMETHEUS_URL: z.string().optional().or(z.literal("")),
  PROMETHEUS_JOB: z.string().optional().or(z.literal("")),         // scrape job of the services, default "wso2-apis"
  // Weave runtime (flows): stats and logs. Internal only.
  RUNTIME_URL: z.string().optional().or(z.literal("")),
  RUNTIME_INTERNAL_KEY: z.string().optional().or(z.literal("")),
  // Directory holding the gateway's apim_metrics.log (mounted read-only).
  APIM_LOG_DIR: z.string().optional().or(z.literal("")),
  // Directory with one folder per migrated service (names only are read).
  SERVICES_DIR: z.string().optional().or(z.literal("")),
  // Gateway rules: JSON-lines audit of every write made from this console.
  GATEWAY_AUDIT_FILE: z.string().optional().or(z.literal("")),
  // What this gateway serves: "production" (default, strictest warnings) or "uat".
  GATEWAY_STAGE: z.enum(["production", "uat"]).optional().or(z.literal("")),
  // Header the per-API address rules read the caller address from (set only when the gateway sits behind your proxy).
  GATEWAY_CLIENT_IP_HEADER: z.string().regex(/^[A-Za-z0-9-]{0,60}$/).optional().or(z.literal("")),
});

export type Config = Omit<z.infer<typeof schema>, "APIM_PUBLIC_URL" | "DATA_DIR"> & { APIM_PUBLIC_URL: string; DATA_DIR: string; caPem: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  let caPem = "";
  try { caPem = readFileSync(parsed.APIM_CA_CERT_PATH, "utf8"); } catch { caPem = ""; }
  // Browser-facing WSO2 URL (OAuth authorize). Defaults to the server-side base.
  const APIM_PUBLIC_URL = parsed.APIM_PUBLIC_URL && parsed.APIM_PUBLIC_URL.length ? parsed.APIM_PUBLIC_URL : parsed.APIM_BASE_URL;
  return { ...parsed, APIM_PUBLIC_URL, DATA_DIR: parsed.DATA_DIR || ".data", caPem };
}
