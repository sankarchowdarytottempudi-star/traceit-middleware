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
});

export type Config = Omit<z.infer<typeof schema>, "APIM_PUBLIC_URL"> & { APIM_PUBLIC_URL: string; caPem: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  let caPem = "";
  try { caPem = readFileSync(parsed.APIM_CA_CERT_PATH, "utf8"); } catch { caPem = ""; }
  // Browser-facing WSO2 URL (OAuth authorize). Defaults to the server-side base.
  const APIM_PUBLIC_URL = parsed.APIM_PUBLIC_URL && parsed.APIM_PUBLIC_URL.length ? parsed.APIM_PUBLIC_URL : parsed.APIM_BASE_URL;
  return { ...parsed, APIM_PUBLIC_URL, caPem };
}
