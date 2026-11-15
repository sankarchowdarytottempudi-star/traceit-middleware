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
  MT_BASE_URL: z.string().url().default("http://localhost:30900"),
  MT_ADMIN_TOKEN: z.string().min(1),
  REDIS_URL: z.string().optional().or(z.literal("")),
  DATA_DIR: z.string().default(".data"),
  RUNTIME_URL: z.string().url().default("http://127.0.0.1:8790"),
  RUNTIME_INTERNAL_KEY: z.string().optional().or(z.literal("")),
  PORT: z.coerce.number().int().positive().default(8788),
  // Estate (migrated services): all optional; a missing source only blanks its part of the screen.
  SERVICES_DIR: z.string().optional(),        // comma separated; "name=/a+/b" for an API made of several packages
  ESTATE_EXTRA_SOURCES: z.string().optional(), // more entries in the same syntax, added to SERVICES_DIR
  ESTATE_CONFIG_DIR: z.string().optional(),   // deployed Config.toml copies (non-secret)
  K8S_API_URL: z.string().optional(),
  K8S_TOKEN_FILE: z.string().optional(),
  K8S_CA_FILE: z.string().optional(),
  K8S_NAMESPACE: z.string().min(1).default("wso2"),
  PROMETHEUS_URL: z.string().optional(),
  APIM_METRICS_LOG: z.string().optional(),    // the gateway's request records (its analytics log file), readable on this server
  GATEWAY_PUBLIC_URL: z.string().optional(),  // e.g. https://host:8243 ; shown next to a published API
  ESTATE_NODE_HOST: z.string().min(1).default("127.0.0.1"), // how the flow runtime reaches a service's node port
  MT_UPLOAD_LIMIT_MB: z.coerce.number().int().positive().default(500),
  // The migration tool can only address these APIs (matched as part of the API name) when it compares
  // answers or measures response times; for any other API it silently picks another service of the
  // same layer. Mirrors its built-in table; comparing and optimising are refused for anything else.
  MT_COMPARE_APIS: z.string().default("reservation-mgr-exp,seaware-sys,seaware-cache-proc,zoho"),
});

export type Config = Omit<z.infer<typeof schema>, "APIM_PUBLIC_URL"> & { APIM_PUBLIC_URL: string; caPem: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  let caPem = "";
  try { caPem = readFileSync(parsed.APIM_CA_CERT_PATH, "utf8"); } catch { caPem = ""; }
  const APIM_PUBLIC_URL = parsed.APIM_PUBLIC_URL && parsed.APIM_PUBLIC_URL.length ? parsed.APIM_PUBLIC_URL : parsed.APIM_BASE_URL;
  return { ...parsed, APIM_PUBLIC_URL, caPem };
}
