// Shared set-up for the sign-in tests: a Gateway BFF with only its auth part and two stand-in routes.
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import cookie from "@fastify/cookie";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAuth } from "../src/auth";
import { readAuthSettings } from "../src/access/settings";
import { createSessionStore } from "../src/sessionStore";
import type { Config } from "../src/config";

export const PUBLIC = "https://weave.example.com";
export const APIM = "https://apim.test";
export const cfg = {
  APIM_BASE_URL: APIM, APIM_PUBLIC_URL: APIM, caPem: "", APIM_DCR_USERNAME: "svc-user", APIM_DCR_PASSWORD: "svc-pass",
  PUBLIC_BASE_URL: PUBLIC, SESSION_SECRET: "s".repeat(32),
} as unknown as Config;

export function tempDir(): string { return mkdtempSync(join(tmpdir(), "weave-access-")); }

export async function makeGateway(env: Record<string, string | undefined>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: cfg.SESSION_SECRET });
  const store = await createSessionStore();
  registerAuth(app, cfg, { clientId: "apim-client", clientSecret: "apim-secret" }, store, readAuthSettings(env, PUBLIC));
  app.get("/api/ratelimits/:type", async (req) => ({ token: await app.tokenForRequest(req) }));
  app.post("/api/ratelimits/:type", async () => ({ ok: true }));
  app.setErrorHandler((error, _req, reply) => {
    const err = error as { statusCode?: number; message?: string };
    reply.code(err.statusCode ?? 500).type("application/problem+json").send({ type: "about:blank", title: err.message, status: err.statusCode ?? 500 });
  });
  await app.ready();
  return app;
}

/** A tiny cookie jar for inject(). */
export class Jar {
  c: Record<string, string> = {};
  take(r: LightMyRequestResponse): LightMyRequestResponse {
    for (const k of r.cookies as { name: string; value: string; expires?: Date; maxAge?: number }[]) {
      if (!k.value || (k.expires && k.expires.getTime() < Date.now()) || k.maxAge === 0) delete this.c[k.name];
      else this.c[k.name] = k.value;
    }
    return r;
  }
}

export async function localSignIn(app: FastifyInstance, email: string, password: string, jar = new Jar()) {
  const r = jar.take(await app.inject({ method: "POST", url: "/api/auth/local", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ email, password }).toString() }));
  return { r, jar };
}
