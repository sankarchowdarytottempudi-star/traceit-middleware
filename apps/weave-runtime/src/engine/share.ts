// L2 (production lessons): identical in-flight reads share one backend call, and answers may be
// kept for a few seconds. Rules that came from incidents:
//  - the in-flight mark always expires (a stuck mark hung callers): a waiter that waited longer
//    than the mark's limit makes its own call;
//  - the mark is released in `finally`, whatever happens;
//  - errors are never kept, and a waiter whose leader failed makes its own call;
//  - a kept answer is copied on the way out, so no caller can change what another one gets.
// Memory only: the runtime has no shared Redis of its own (a flow's Redis is a connection the
// flow chooses), so each runtime copy keeps its own answers.
import { createHash } from "node:crypto";

export interface Shared<T> { value: T; until: number; }
interface Flight<T> { promise: Promise<T>; started: number; }

export class ReadShare<T> {
  private kept = new Map<string, Shared<T>>();
  private flights = new Map<string, Flight<T>>();
  constructor(private readonly maxEntries = 2000, private readonly now: () => number = Date.now) {}

  /** Runs `call` once for identical concurrent keys; keeps the answer `keepMs` (0: not kept). */
  async run(key: string, opts: { keepMs: number; share: boolean; inflightMaxMs: number }, call: () => Promise<T>): Promise<{ value: T; via: "kept" | "shared" | "call" }> {
    const t = this.now();
    const hit = this.kept.get(key);
    if (hit && hit.until > t) return { value: copy(hit.value), via: "kept" };
    if (hit) this.kept.delete(key);
    const flight = opts.share || opts.keepMs > 0 ? this.flights.get(key) : undefined;
    if (flight && t - flight.started < opts.inflightMaxMs) {
      const left = Math.max(1, opts.inflightMaxMs - (t - flight.started));
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), left); });
      try {
        const r = await Promise.race([flight.promise.then((v) => ({ v }), () => "failed" as const), late]);
        if (r !== "late" && r !== "failed") return { value: copy(r.v), via: "shared" };
      } finally { clearTimeout(timer); }
      // the leader failed or took too long: this caller makes its own call (kept when it succeeds)
      const own = await call();
      this.keep(key, own, opts.keepMs);
      return { value: own, via: "call" };
    }
    if (!(opts.share || opts.keepMs > 0)) return { value: await call(), via: "call" };
    const promise = call();
    const mine: Flight<T> = { promise, started: t };
    this.flights.set(key, mine);
    try {
      const value = await promise;
      this.keep(key, value, opts.keepMs);
      return { value, via: "call" };
    } finally {
      if (this.flights.get(key) === mine) this.flights.delete(key);   // always released
    }
  }
  private keep(key: string, value: T, keepMs: number) {
    if (keepMs <= 0) return;
    if (this.kept.size >= this.maxEntries) { const first = this.kept.keys().next().value; if (first !== undefined) this.kept.delete(first); }
    this.kept.set(key, { value: copy(value), until: this.now() + keepMs });
  }
  /** Drops every kept answer whose key starts with `prefix` (e.g. a session the backend refused). */
  forget(prefix: string) { for (const k of [...this.kept.keys()]) if (k.startsWith(prefix)) this.kept.delete(k); }
  inFlight() { return this.flights.size; }
  size() { return this.kept.size; }
  clear() { this.kept.clear(); this.flights.clear(); }
}

function copy<T>(v: T): T { return v === undefined || v === null || typeof v !== "object" ? v : structuredClone(v); }

/** Key of one call: method, full URL, every header and the body (so a per-user header gives a per-user key). */
export function shareKey(method: string, url: string, headers: Record<string, string>, body?: string | Buffer): string {
  const h = createHash("sha256");
  h.update(method.toUpperCase()).update("\n").update(url).update("\n");
  for (const k of Object.keys(headers).sort()) h.update(k.toLowerCase()).update(":").update(String(headers[k])).update("\n");
  if (body !== undefined) h.update("\n").update(body);
  return `${new URL(url).origin}|${h.digest("hex")}`;
}

/** The runtime's one shared store of HTTP answers. */
export const httpShare = new ReadShare<{ status: number; headers: Record<string, string>; body: unknown }>();
