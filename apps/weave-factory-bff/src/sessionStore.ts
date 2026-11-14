// Shared session/state store so more than one BFF replica works. Redis when REDIS_URL is set
// (the cluster runs intg-redis at intg-redis.wso2.svc:6379); in-memory only for local dev.
import { createClient, type RedisClientType } from "redis";

export interface SessionStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

class InMemoryStore implements SessionStore {
  private m = new Map<string, { v: unknown; exp: number }>();
  async get<T>(key: string): Promise<T | null> {
    const e = this.m.get(key);
    if (!e) return null;
    if (Date.now() > e.exp) { this.m.delete(key); return null; }
    return e.v as T;
  }
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.m.set(key, { v: value, exp: Date.now() + ttlSeconds * 1000 });
  }
  async del(key: string): Promise<void> { this.m.delete(key); }
}

class RedisStore implements SessionStore {
  constructor(private client: RedisClientType) {}
  async get<T>(key: string): Promise<T | null> {
    const v = await this.client.get(key);
    return v ? (JSON.parse(v) as T) : null;
  }
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), { EX: ttlSeconds });
  }
  async del(key: string): Promise<void> { await this.client.del(key); }
}

export async function createSessionStore(redisUrl?: string): Promise<SessionStore> {
  if (!redisUrl) return new InMemoryStore();
  const client: RedisClientType = createClient({ url: redisUrl });
  client.on("error", (e) => console.error("redis error", e));
  await client.connect();
  return new RedisStore(client);
}
