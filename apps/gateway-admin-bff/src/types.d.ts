import "fastify";
import type { FastifyRequest } from "fastify";
declare module "fastify" {
  interface FastifyInstance {
    tokenFor: (sid: string) => Promise<string | null>;
    /** Access token for the caller of this request (session cookie, or the dev-mode service token). */
    tokenForRequest: (req: FastifyRequest) => Promise<string | null>;
  }
}
