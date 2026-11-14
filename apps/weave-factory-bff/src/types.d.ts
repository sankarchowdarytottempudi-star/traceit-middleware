import "fastify";
declare module "fastify" {
  interface FastifyInstance {
    tokenFor: (sid: string) => Promise<string | null>;
    userFor: (req: import("fastify").FastifyRequest) => Promise<string | null>;
  }
}
