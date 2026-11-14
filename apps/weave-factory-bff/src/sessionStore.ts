// Shared session/state store so more than one BFF replica works. Redis when REDIS_URL is set
// (the cluster runs intg-redis at intg-redis.wso2.svc:6379); in-memory only for local dev.
import { createClient, type RedisClientType } from "redis";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

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


/** File-backed store: sessions survive a container restart/redeploy (single replica).
 *  The file lives in the mounted DATA_DIR, mode 0600; nothing leaves the server. */
class FileStore implements SessionStore {
  private m = new Map<string, { v: unknown; exp: number }>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, { v: unknown; exp: number }>;
      const now = Date.now();
      for (const [k, e] of Object.entries(raw)) if (e && e.exp > now) this.m.set(k, e);
    } catch { /* first run or unreadable: start empty */ }
  }
  private flush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        const now = Date.now(); const out: Record<string, unknown> = {};
        for (const [k, e] of this.m) if (e.exp > now && !k.startsWith("pkce:")) out[k] = e;
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = this.file + ".tmp";
        writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
        renameSync(tmp, this.file);
      } catch (e) { console.error("session store flush failed", e); }
    }, 250);
  }
  async get<T>(key: string): Promise<T | null> {
    const e = this.m.get(key);
    if (!e) return null;
    if (Date.now() > e.exp) { this.m.delete(key); this.flush(); return null; }
    return e.v as T;
  }
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.m.set(key, { v: value, exp: Date.now() + ttlSeconds * 1000 }); this.flush();
  }
  async del(key: string): Promise<void> { this.m.delete(key); this.flush(); }
}

export async function createSessionStore(redisUrl?: string, dataDir?: string): Promise<SessionStore> {
  if (!redisUrl) return dataDir ? new FileStore(join(dataDir, "sessions.json")) : new InMemoryStore();
  const client: RedisClientType = createClient({ url: redisUrl });
  client.on("error", (e) => console.error("redis error", e));
  await client.connect();
  return new RedisStore(client);
}
