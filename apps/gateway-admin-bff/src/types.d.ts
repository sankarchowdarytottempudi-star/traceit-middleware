import "fastify";
declare module "fastify" {
  interface FastifyInstance {
    sessions: Map<string, unknown>;
    tokenFor: (sid: string) => Promise<string | null>;
  }
}
