import "fastify";
declare module "fastify" {
  interface FastifyInstance {
    tokenFor: (sid: string) => Promise<string | null>;
    userFor: (req: import("fastify").FastifyRequest) => Promise<string | null>;
    /** "admin" may switch APIs on and off; null when not signed in. */
    roleFor: (req: import("fastify").FastifyRequest) => Promise<"admin" | "viewer" | null>;
  }
}
