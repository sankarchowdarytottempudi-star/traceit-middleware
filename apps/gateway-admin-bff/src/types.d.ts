import "fastify";
import type { FastifyRequest } from "fastify";
declare module "fastify" {
  interface FastifyInstance {
    tokenFor: (sid: string) => Promise<string | null>;
    /** Access token for the caller of this request (session cookie, or the dev-mode service token). */
    tokenForRequest: (req: FastifyRequest) => Promise<string | null>;
    /** Token from the service credentials (fallback when the person's token sees nothing). */
    serviceToken: () => Promise<string>;
    /** Signed-in person's name, or null. */
    userForRequest: (req: FastifyRequest) => Promise<string | null>;
    /** Native gateway analytics (set by the insight routes). */
    gwAnalytics?: import("./gwanalytics/index.js").GatewayAnalytics;
  }
}
