import "fastify";
import type { FastifyRequest } from "fastify";
import type { Access } from "./access/plugin.js";
declare module "fastify" {
  interface FastifyInstance {
    tokenFor: (sid: string) => Promise<string | null>;
    /** Access token for the caller of this request (own API Manager token, or the service token for Microsoft/Weave accounts and the dev mode). */
    tokenForRequest: (req: FastifyRequest) => Promise<string | null>;
    /** Sign-in, roles and audit log (src/access). */
    access: Access;
    /** Token from the service credentials (fallback when the person's token sees nothing). */
    serviceToken: () => Promise<string>;
    /** Signed-in person's name, or null. */
    userForRequest: (req: FastifyRequest) => Promise<string | null>;
    /** Native gateway analytics (set by the insight routes). */
    gwAnalytics?: import("./gwanalytics/index.js").GatewayAnalytics;
  }
}
