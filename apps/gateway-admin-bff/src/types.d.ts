import "fastify";
declare module "fastify" {
  interface FastifyInstance {
    tokenFor: (sid: string) => Promise<string | null>;
  }
}
