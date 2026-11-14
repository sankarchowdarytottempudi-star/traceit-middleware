import { z } from "zod";
import { readFileSync } from "node:fs";

const schema = z.object({
  APIM_BASE_URL: z.string().url(),
  APIM_CA_CERT_PATH: z.string().min(1),
  APIM_DCR_USERNAME: z.string().min(1),
  APIM_DCR_PASSWORD: z.string().min(1),
  SESSION_SECRET: z.string().min(16),
  PUBLIC_BASE_URL: z.string().url(),
  MIGRATION_TOOL_URL: z.string().url().optional().or(z.literal("")),
  PORT: z.coerce.number().int().positive().default(8787),
});

export type Config = z.infer<typeof schema> & { caPem: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  let caPem = "";
  try { caPem = readFileSync(parsed.APIM_CA_CERT_PATH, "utf8"); } catch { caPem = ""; }
  return { ...parsed, caPem };
}
