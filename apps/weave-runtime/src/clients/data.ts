// Redis and Postgres clients, one per connection (rebuilt when the connection is edited).
// Cluster service names are resolved through the cluster DNS before connecting.
import { createClient } from "redis";
import pg from "pg";
import type { ClusterDns } from "./dns.js";

export interface ResolvedConnection {
  id: string; name: string; type: string; updatedAt: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;     // decrypted, in memory only
}
type RedisClient = ReturnType<typeof createClient>;

export class DataClients {
  private redis = new Map<string, { stamp: string; client: Promise<RedisClient> }>();
  private pools = new Map<string, { stamp: string; pool: Promise<pg.Pool> }>();
  constructor(private dns: ClusterDns) {}

  async redisFor(c: ResolvedConnection): Promise<RedisClient> {
    const hit = this.redis.get(c.id);
    if (hit && hit.stamp === c.updatedAt) return hit.client;
    if (hit) void hit.client.then((x) => x.quit()).catch(() => undefined);
    const p = this.openRedis(c);
    this.redis.set(c.id, { stamp: c.updatedAt, client: p });
    p.catch(() => { if (this.redis.get(c.id)?.client === p) this.redis.delete(c.id); });
    return p;
  }
  async openRedis(c: ResolvedConnection, connectTimeout = 5000): Promise<RedisClient> {
    const host = String(c.config.host || "");
    if (!host) throw new Error("Redis connection has no host");
    const ip = await this.dns.resolve(host);
    const client = createClient({
      socket: { host: ip, port: Number(c.config.port || 6379), connectTimeout, ...(c.config.tls ? { tls: true as const, servername: host } : {}), reconnectStrategy: (n: number) => (n > 20 ? new Error("Redis is unreachable") : Math.min(200 * n, 3000)) } as never,
      password: c.secrets.password || undefined,
      database: Number(c.config.db || 0),
    });
    client.on("error", () => undefined);
    await client.connect();
    return client as RedisClient;
  }
  async pgFor(c: ResolvedConnection): Promise<pg.Pool> {
    const hit = this.pools.get(c.id);
    if (hit && hit.stamp === c.updatedAt) return hit.pool;
    if (hit) void hit.pool.then((x) => x.end()).catch(() => undefined);
    const p = this.openPg(c);
    this.pools.set(c.id, { stamp: c.updatedAt, pool: p });
    p.catch(() => { if (this.pools.get(c.id)?.pool === p) this.pools.delete(c.id); });
    return p;
  }
  async openPg(c: ResolvedConnection, max = 5): Promise<pg.Pool> {
    const host = String(c.config.host || "");
    if (!host) throw new Error("Postgres connection has no host");
    const ip = await this.dns.resolve(host);
    const pool = new pg.Pool({
      host: ip, port: Number(c.config.port || 5432), database: String(c.config.database || ""), user: String(c.config.user || ""),
      password: c.secrets.password || undefined, ssl: c.config.ssl ? { rejectUnauthorized: false, servername: host } : undefined,
      max, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, statement_timeout: 60_000,
    });
    pool.on("error", () => undefined);
    return pool;
  }
  async closeAll() {
    for (const r of this.redis.values()) await r.client.then((x) => x.quit()).catch(() => undefined);
    for (const p of this.pools.values()) await p.pool.then((x) => x.end()).catch(() => undefined);
    this.redis.clear(); this.pools.clear();
  }
}
