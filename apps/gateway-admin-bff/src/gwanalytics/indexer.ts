// Incremental indexer for WSO2 API Manager's apim_metrics.log.
//
// Tails the file by (inode, byte offset), survives rotation by rename, truncation and restarts,
// rolls every event up into minute buckets (short retention) and hour buckets (long retention),
// keeps the newest events in a ring for the "recent requests" table, and persists the rollups
// together with the file position (see store.ts) so a restart resumes exactly where it stopped.
//
// Event contents (user names, IPs) are never logged; the log callback only gets short
// operational messages.
import { promises as fsp, statSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type {
  GatewayAnalytics, GwAnalyticsOptions, GwApiHour, GwBreakdownRow, GwEvent, GwQuery, GwRange,
  GwRecentQuery, GwRecentResult, GwSeriesPoint, GwStatus, GwSummary, GwTotals,
} from "./types.js";
import { parseMetricsLine } from "./parse.js";
import { Agg, type Bucket, type Dim, DimPool, HIST_SIZE, LATENCY_BOUNDS_MS, OTHER, type Row, addToBucket } from "./rollup.js";
import { type FilePos, IndexStore, errCode, errText } from "./store.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const FUTURE_SLACK_MS = 5 * MINUTE;       // events further ahead than this are bucketed at "now"
const FINGERPRINT_BYTES = 1024;
const SNAPSHOT_AFTER_DIRTY_BUCKETS = 256; // a flush touching more buckets than this writes a snapshot instead of a journal record
const JOURNAL_MIN_COMPACT_BYTES = 4 * 1024 * 1024;

/** Optional knobs, mostly for tests. Defaults suit production. */
export interface GwTuning {
  flushMs?: number;           // how often changed state is saved; default 20000
  maxRowsPerBucket?: number;  // distinct rows per bucket before folding into "(other)"; default 300
  chunkBytes?: number;        // read size; default 1 MiB
  maxLineBytes?: number;      // longer lines are skipped; default 256 KiB
  recentTailBytes?: number;   // how much of the file is re-parsed on restart to refill the recent ring; default 4 MiB
}

/** The public contract plus two hooks that make the indexer deterministic to drive (tests, tools). */
export interface GatewayAnalyticsIndexer extends GatewayAnalytics {
  /** Runs one poll pass now: follows the file to its end and indexes every complete line. Never rejects. */
  tick(): Promise<void>;
  /** Saves the index now if anything changed. Never rejects. */
  flush(): Promise<void>;
}

const RANGES: Record<GwRange, { src: "m" | "h"; stepMs: number; points: number }> = {
  "15m": { src: "m", stepMs: MINUTE, points: 15 },
  "1h": { src: "m", stepMs: MINUTE, points: 60 },
  "6h": { src: "m", stepMs: 5 * MINUTE, points: 72 },
  "24h": { src: "m", stepMs: 15 * MINUTE, points: 96 },
  "7d": { src: "h", stepMs: HOUR, points: 168 },
  "30d": { src: "h", stepMs: 6 * HOUR, points: 120 },
};

const positive = (v: number | undefined, dflt: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt);
const iso = (ms: number | null): string | null => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const byName = (a: string, b: string): number => a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${ms / 1000} s`;
}

/** One line of a breakdown while it is being summed; `newest` is the most recent row seen, used to describe the group. */
interface Group { agg: Agg; newest: Row; }

function addToGroup(groups: Map<string, Group>, key: string, row: Row): void {
  const g = groups.get(key);
  if (!g) {
    const agg = new Agg();
    agg.add(row);
    groups.set(key, { agg, newest: row });
    return;
  }
  g.agg.add(row);
  if (row.la > g.newest.la) g.newest = row;
}

function breakdown(groups: Map<string, Group>, totalRequests: number, describe: (d: Dim) => { label: string; extra: Record<string, string> }): GwBreakdownRow[] {
  const rows: GwBreakdownRow[] = [];
  for (const [key, g] of groups) {
    const a = g.agg;
    const { label, extra } = describe(g.newest.d);
    rows.push({
      key, label,
      requests: a.n, errors: a.errors, faults: a.f, throttled: a.th, cacheHits: a.ch,
      avgResponseMs: a.avgResponse, avgBackendMs: a.avgBackend, p95Ms: a.pResponse(0.95),
      share: totalRequests > 0 ? a.n / totalRequests : 0,
      lastAt: a.la > 0 ? a.la : null,
      extra,
    });
  }
  rows.sort((x, y) => y.requests - x.requests || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return rows;
}

class Indexer implements GatewayAnalyticsIndexer {
  private readonly configured: boolean;
  private readonly logDir: string;
  private readonly fileName: string;
  private readonly filePath: string;
  private readonly stem: string;
  private readonly clock: () => number;
  private readonly logFn: ((msg: string) => void) | undefined;
  private readonly pollMs: number;
  private readonly recentMax: number;
  private readonly minuteRetentionMs: number;
  private readonly hourRetentionMs: number;
  private readonly flushMs: number;
  private readonly maxRows: number;
  private readonly chunkBytes: number;
  private readonly maxLineBytes: number;
  private readonly recentTailBytes: number;
  private readonly store: IndexStore;

  private minutes = new Map<number, Bucket>();
  private hours = new Map<number, Bucket>();
  private pos: FilePos;
  private events = 0;
  private skipped = 0;
  private lastEventAt: number | null = null;
  private lastReadAt: number | null = null;

  private readonly dirtyM = new Set<number>();
  private readonly dirtyH = new Set<number>();
  private metaDirty = false;

  private readonly ring: (GwEvent | undefined)[];
  private ringHead = 0;   // next write position
  private ringSize = 0;

  private readonly dims = new DimPool();
  private dimsStale = false;                       // buckets were dropped: some combinations may no longer be referenced
  private names: { version: number; apis: string[]; apps: string[] } | null = null;
  private state: GwStatus["state"] = "not-configured";
  private detail: string | undefined;
  private persistError: string | undefined;
  private fileSize = 0;

  private loaded = false;
  private firstOpen = true;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private stopping = false;
  private lastFlushWall = Date.now();
  private lastMinuteCut = -1;
  private lastHourCut = -1;
  private lastSweepCut = -1;
  private chunkBuf: Buffer | null = null;

  constructor(opts: GwAnalyticsOptions & GwTuning) {
    const logDir = typeof opts.logDir === "string" ? opts.logDir.trim() : "";
    this.configured = logDir.length > 0;
    this.logDir = logDir;
    this.fileName = (opts.fileName && opts.fileName.trim()) || "apim_metrics.log";
    this.filePath = this.configured ? path.join(logDir, this.fileName) : "";
    const ext = path.extname(this.fileName);
    this.stem = ext ? this.fileName.slice(0, -ext.length) : this.fileName;
    this.clock = typeof opts.now === "function" ? opts.now : Date.now;
    this.logFn = opts.log;
    this.pollMs = positive(opts.pollMs, 2000);
    this.recentMax = Math.floor(positive(opts.recentMax, 5000));
    this.minuteRetentionMs = positive(opts.minuteRetentionHours, 26) * HOUR;
    this.hourRetentionMs = positive(opts.hourRetentionDays, 90) * DAY;
    this.flushMs = positive(opts.flushMs, 20_000);
    this.maxRows = Math.floor(positive(opts.maxRowsPerBucket, 300));
    this.chunkBytes = Math.max(16, Math.floor(positive(opts.chunkBytes, 1024 * 1024)));
    this.maxLineBytes = Math.floor(positive(opts.maxLineBytes, 256 * 1024));
    this.recentTailBytes = Math.floor(positive(opts.recentTailBytes, 4 * 1024 * 1024));
    this.store = new IndexStore(opts.dataDir);
    this.ring = new Array<GwEvent | undefined>(this.recentMax);
    this.pos = this.emptyPos();

    if (this.configured) {
      // Cheap first impression so status() is meaningful before the first poll.
      try {
        const st = statSync(this.filePath);
        this.fileSize = st.size;
        this.state = st.isFile() ? "active" : "error";
        if (!st.isFile()) this.detail = `${this.fileName} is not a regular file`;
      } catch (e) {
        const code = errCode(e);
        if (code === "ENOENT" || code === "ENOTDIR") this.setState("waiting-for-file", `waiting for ${this.fileName} to appear`);
        else this.setState("error", errText(e));
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // lifecycle

  start(): void {
    try {
      if (!this.configured || this.started) return;
      this.started = true;
      this.schedule(0);
    } catch (e) {
      this.note(`gateway analytics: could not start (${errText(e)})`);
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.stopping = true;                 // lets a long catch-up read stop at the next chunk
    try {
      await this.run(() => this.flushLocked());
    } finally {
      this.stopping = false;
    }
  }

  tick(): Promise<void> {
    return this.run(async () => {
      try {
        await this.tickLocked();
      } catch (e) {
        this.setState("error", errText(e));
      }
    });
  }

  flush(): Promise<void> {
    return this.run(() => this.flushLocked());
  }

  private schedule(ms: number): void {
    if (!this.started || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.loop();
    }, ms);
    this.timer.unref();
  }

  private async loop(): Promise<void> {
    await this.tick();
    if (this.isDirty() && Date.now() - this.lastFlushWall >= this.flushMs) await this.flush();
    this.schedule(this.pollMs);
  }

  /** Serialises everything that reads the log or writes the index. */
  private run(fn: () => Promise<void>): Promise<void> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private note(msg: string): void {
    if (!this.logFn) return;
    try { this.logFn(msg); } catch { /* a broken logger must not stop indexing */ }
  }

  private setState(state: GwStatus["state"], detail?: string): void {
    if (state === "error" && (this.state !== "error" || this.detail !== detail)) {
      this.note(`gateway analytics: cannot read ${this.fileName} (${detail ?? "unknown error"})`);
    } else if (state !== this.state) {
      this.note(`gateway analytics: ${state}`);
    }
    this.state = state;
    this.detail = detail;
  }

  private emptyPos(ino = ""): FilePos {
    return { path: this.filePath, ino, offset: 0, skip: false, fp: "", fpLen: 0 };
  }

  private isDirty(): boolean {
    return this.metaDirty || this.dirtyM.size > 0 || this.dirtyH.size > 0;
  }

  // ------------------------------------------------------------------------------------------
  // persistence

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await this.store.load((m) => this.note(m), this.dims);
      if (data) {
        this.minutes = data.minutes;
        this.hours = data.hours;
        this.events = data.counters.events;
        this.skipped = data.counters.skipped;
        this.lastEventAt = data.counters.lastEventAt;
        this.lastReadAt = data.counters.lastReadAt;
        if (data.pos.path === this.filePath) {
          this.pos = data.pos;
        } else {
          this.note("gateway analytics: the log path changed; history kept, following the new file from its start");
          this.pos = this.emptyPos();
          this.metaDirty = true;
        }
      }
    } catch (e) {
      this.note(`gateway analytics: could not load the saved index (${errText(e)})`);
    }
    this.dimsStale = true;                         // a rejected index may have left unused combinations behind
    this.loaded = true;
    this.lastFlushWall = Date.now();
  }

  private async flushLocked(): Promise<void> {
    if (!this.loaded || !this.isDirty()) return;
    this.lastFlushWall = Date.now();
    const data = {
      pos: this.pos,
      counters: { events: this.events, skipped: this.skipped, lastEventAt: this.lastEventAt, lastReadAt: this.lastReadAt },
      minutes: this.minutes, hours: this.hours,
    };
    try {
      const compactAt = Math.max(JOURNAL_MIN_COMPACT_BYTES, this.store.snapshotBytes / 2);
      if (this.store.needsSnapshot
        || this.dirtyM.size + this.dirtyH.size > SNAPSHOT_AFTER_DIRTY_BUCKETS
        || this.store.journalBytes > compactAt) {
        await this.store.writeSnapshot(data);
      } else {
        await this.store.appendJournal(data, this.dirtyM, this.dirtyH);
      }
      this.dirtyM.clear();
      this.dirtyH.clear();
      this.metaDirty = false;
      if (this.persistError) this.note("gateway analytics: index saved again");
      this.persistError = undefined;
    } catch (e) {
      // Nothing is lost: the changes stay marked and the next flush retries.
      const msg = `index not saved: ${errText(e)}`;
      if (msg !== this.persistError) this.note(`gateway analytics: ${msg}`);
      this.persistError = msg;
    }
  }

  // ------------------------------------------------------------------------------------------
  // tailing

  private async tickLocked(): Promise<void> {
    if (!this.configured) return;
    await this.ensureLoaded();
    this.prune(this.clock());

    let fh: FileHandle;
    try {
      fh = await fsp.open(this.filePath, "r");
    } catch (e) {
      const code = errCode(e);
      if (code === "ENOENT" || code === "ENOTDIR") {
        // Possibly mid-rotation: the old file was renamed and the new one is not there yet.
        // The position is only given up once the renamed file has been read to its end.
        if (this.pos.ino && (await this.finishRotated())) {
          this.pos = this.emptyPos();
          this.metaDirty = true;
        }
        this.fileSize = 0;
        this.setState("waiting-for-file", `waiting for ${this.fileName} to appear`);
      } else {
        this.setState("error", errText(e));
      }
      return;
    }
    try {
      const st = await fh.stat({ bigint: true });
      if (!st.isFile()) {
        this.setState("error", `${this.fileName} is not a regular file`);
        return;
      }
      const ino = st.ino.toString();
      const size = Number(st.size);
      let resumed = false;
      if (!this.pos.ino) {
        this.reset(ino);
      } else if (this.pos.ino !== ino) {
        const finished = await this.finishRotated();
        this.note(finished
          ? "gateway analytics: log rotated; finished the previous file, following the new one"
          : "gateway analytics: log rotated; the previous file was not found, following the new one");
        this.reset(ino);
      } else if (size < this.pos.offset) {
        this.note("gateway analytics: log truncated; reading it from the start");
        this.reset(ino);
      } else if ((this.firstOpen || size !== this.fileSize) && !(await this.fingerprintMatches(fh))) {
        this.note("gateway analytics: log replaced; reading it from the start");
        this.reset(ino);
      } else {
        resumed = true;
      }
      if (this.firstOpen) {
        this.firstOpen = false;
        if (resumed && this.pos.offset > 0) await this.refillRecent(fh);
      }
      this.fileSize = size;
      await this.readFrom(fh, false);
      await this.updateFingerprint(fh);
      this.lastReadAt = this.clock();
      this.setState("active");
    } catch (e) {
      this.setState("error", errText(e));
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  private reset(ino: string): void {
    this.pos = this.emptyPos(ino);
    this.metaDirty = true;
  }

  private async hashHead(fh: FileHandle, len: number): Promise<string> {
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await fh.read(buf, got, len - got, got);
      if (bytesRead <= 0) return "";
      got += bytesRead;
    }
    return createHash("sha1").update(buf).digest("hex").slice(0, 24);
  }

  private async fingerprintMatches(fh: FileHandle): Promise<boolean> {
    if (this.pos.fpLen <= 0) return true;
    return (await this.hashHead(fh, this.pos.fpLen)) === this.pos.fp;
  }

  /** The first bytes of an append-only log never change, so their hash identifies the file. */
  private async updateFingerprint(fh: FileHandle): Promise<void> {
    const want = Math.min(FINGERPRINT_BYTES, this.pos.offset);
    if (want <= this.pos.fpLen) return;
    const fp = await this.hashHead(fh, want);
    if (!fp) return;
    this.pos.fp = fp;
    this.pos.fpLen = want;
    this.metaDirty = true;
  }

  /**
   * After a rotation by rename the old file still exists under another name with the same inode.
   * Reads what was appended to it after our saved offset. Returns false when it cannot be found
   * (already compressed or deleted), in which case that remainder is lost.
   */
  private async finishRotated(): Promise<boolean> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.logDir);
    } catch {
      return false;
    }
    let checked = 0;
    for (const name of entries) {
      if (name === this.fileName || !name.startsWith(this.stem)) continue;
      if (++checked > 2000) break;
      const candidate = path.join(this.logDir, name);
      try {
        const st = await fsp.stat(candidate, { bigint: true });
        if (!st.isFile() || st.ino.toString() !== this.pos.ino) continue;
      } catch {
        continue;
      }
      let fh: FileHandle;
      try {
        fh = await fsp.open(candidate, "r");
      } catch {
        return false;
      }
      try {
        const st = await fh.stat({ bigint: true });
        if (st.ino.toString() !== this.pos.ino || Number(st.size) < this.pos.offset) return false;
        if (!(await this.fingerprintMatches(fh))) return false;
        await this.readFrom(fh, true);
        return true;
      } catch {
        return false;
      } finally {
        await fh.close().catch(() => undefined);
      }
    }
    return false;
  }

  /**
   * Reads from the saved offset to the end of the file in chunks, indexing every complete line.
   * The offset only ever advances past a newline, so a half-written last line is left for the next
   * pass. With `final` (a rotated file nobody appends to any more) a last line without a newline
   * is consumed too.
   */
  private async readFrom(fh: FileHandle, final: boolean): Promise<void> {
    const buf = (this.chunkBuf ??= Buffer.allocUnsafe(this.chunkBytes));
    let carry: Buffer | null = null;   // bytes after the last newline; they start at pos.offset
    let readAt = this.pos.offset;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, readAt);
      if (bytesRead <= 0) break;
      readAt += bytesRead;
      const chunk = buf.subarray(0, bytesRead);
      const data: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
      carry = null;
      const now = this.clock();
      let start = 0;
      if (this.pos.skip) {
        const nl = data.indexOf(10);
        if (nl < 0) start = data.length;           // still inside the over-long line
        else { start = nl + 1; this.pos.skip = false; }
      }
      while (start < data.length) {
        const nl = data.indexOf(10, start);
        if (nl < 0) break;
        this.handleLine(data, start, nl, now);
        start = nl + 1;
      }
      const rest = data.length - start;
      if (rest > this.maxLineBytes) {
        this.skipped++;
        this.pos.skip = true;
        this.pos.offset = readAt;
      } else {
        this.pos.offset = readAt - rest;
        if (rest > 0) carry = Buffer.from(data.subarray(start));   // copy: the chunk buffer is reused
      }
      this.metaDirty = true;
      await yieldToLoop();
      if (this.stopping && !final) return;
      if (this.isDirty() && Date.now() - this.lastFlushWall >= this.flushMs) await this.flushLocked();
    }
    if (final && carry && carry.length > 0) {
      this.handleLine(carry, 0, carry.length, this.clock());
      this.pos.offset += carry.length;
      this.metaDirty = true;
    }
  }

  private handleLine(data: Buffer, start: number, end: number, now: number): void {
    if (end > start && data[end - 1] === 13) end--;            // CRLF
    if (end <= start || end - start > this.maxLineBytes) {
      this.skipped++;
      return;
    }
    const ev = parseMetricsLine(data.toString("utf8", start, end), now);
    if (!ev) {
      this.skipped++;
      return;
    }
    this.ingest(ev, now);
  }

  private minuteCutoff(now: number): number {
    return Math.floor((now - this.minuteRetentionMs) / MINUTE) * MINUTE;
  }
  private hourCutoff(now: number): number {
    return Math.floor((now - this.hourRetentionMs) / HOUR) * HOUR;
  }

  private ingest(ev: GwEvent, now: number): void {
    if (ev.ts > now + FUTURE_SLACK_MS) ev.ts = now;
    const ts = ev.ts;
    this.pushRecent(ev);
    const mKey = Math.floor(ts / MINUTE) * MINUTE;
    const hKey = Math.floor(ts / HOUR) * HOUR;
    const inMinutes = mKey >= this.minuteCutoff(now);
    const inHours = hKey >= this.hourCutoff(now);
    if (!inMinutes && !inHours) {
      this.skipped++;                                           // older than everything we retain
      return;
    }
    const known = this.dims.version;
    const dim = this.dims.forEvent(ev);
    let used = false;
    if (inMinutes && this.addTo(this.minutes, this.dirtyM, mKey, dim, ev)) used = true;
    if (inHours && this.addTo(this.hours, this.dirtyH, hKey, dim, ev)) used = true;
    // A combination seen for the first time that was folded into "(other)" in every bucket has no
    // row of its own: do not keep it (it would show up in the name lists and never be released).
    if (!used && this.dims.version !== known) this.dims.discard(dim);
    this.events++;
    if (this.lastEventAt === null || ts > this.lastEventAt) this.lastEventAt = ts;
  }

  /** Adds the event to one bucket; false when it was folded into the overflow row instead of its own. */
  private addTo(map: Map<number, Bucket>, dirty: Set<number>, bucketStart: number, dim: Dim, ev: GwEvent): boolean {
    let bucket = map.get(bucketStart);
    if (!bucket) {
      bucket = new Map();
      map.set(bucketStart, bucket);
    }
    dirty.add(bucketStart);
    return addToBucket(bucket, dim, this.dims.other, ev, ev.ts, this.maxRows).d === dim;
  }

  /** Forgets dimension combinations that no retained row uses any more. */
  private sweepDims(): void {
    this.dimsStale = false;
    const live = new Set<Dim>();
    for (const map of [this.minutes, this.hours]) {
      for (const bucket of map.values()) for (const d of bucket.keys()) live.add(d);
    }
    this.dims.retain(live);
  }

  private pushRecent(ev: GwEvent): void {
    this.ring[this.ringHead] = ev;
    this.ringHead = (this.ringHead + 1) % this.recentMax;
    if (this.ringSize < this.recentMax) this.ringSize++;
  }

  /** After a restart: re-parse the tail of the file before the saved offset into the ring only (nothing is counted). */
  private async refillRecent(fh: FileHandle): Promise<void> {
    const end = this.pos.offset;
    const begin = Math.max(0, end - this.recentTailBytes);
    const buf = Buffer.allocUnsafe(end - begin);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, begin + got);
      if (bytesRead <= 0) break;
      got += bytesRead;
    }
    const data = buf.subarray(0, got);
    let start = 0;
    if (begin > 0) {
      const nl = data.indexOf(10);                              // drop the line we landed in the middle of
      if (nl < 0) return;
      start = nl + 1;
    }
    const now = this.clock();
    let lines = 0;
    while (start < data.length) {
      const nl = data.indexOf(10, start);
      if (nl < 0) break;
      let lineEnd = nl;
      if (lineEnd > start && data[lineEnd - 1] === 13) lineEnd--;
      if (lineEnd > start && lineEnd - start <= this.maxLineBytes) {
        const ev = parseMetricsLine(data.toString("utf8", start, lineEnd), now);
        if (ev) {
          if (ev.ts > now + FUTURE_SLACK_MS) ev.ts = now;
          this.pushRecent(ev);
        }
      }
      start = nl + 1;
      if (++lines % 1000 === 0) await yieldToLoop();
    }
  }

  private prune(now: number): void {
    const mCut = this.minuteCutoff(now);
    const hCut = this.hourCutoff(now);
    if (mCut === this.lastMinuteCut && hCut === this.lastHourCut) return;
    this.lastMinuteCut = mCut;
    this.lastHourCut = hCut;
    let removed = 0;
    for (const k of this.minutes.keys()) if (k < mCut) { this.minutes.delete(k); this.dirtyM.delete(k); removed++; }
    for (const k of this.hours.keys()) if (k < hCut) { this.hours.delete(k); this.dirtyH.delete(k); removed++; }
    if (removed > 0) this.dimsStale = true;
    if (this.dimsStale && hCut !== this.lastSweepCut) {          // at most hourly here; queries sweep on demand
      this.lastSweepCut = hCut;
      this.sweepDims();
    }
  }

  // ------------------------------------------------------------------------------------------
  // queries

  status(): GwStatus {
    let oldest: number | null = null;
    for (const k of this.minutes.keys()) if (oldest === null || k < oldest) oldest = k;
    for (const k of this.hours.keys()) if (oldest === null || k < oldest) oldest = k;
    const detail = this.detail ?? this.persistError;
    const s: GwStatus = {
      state: this.state,
      enabled: this.state === "active",
      file: this.configured ? this.filePath : null,
      fileSize: this.fileSize,
      lastEventAt: iso(this.lastEventAt),
      lastReadAt: iso(this.lastReadAt),
      oldestAt: iso(oldest),
      eventsIndexed: this.events,
      linesSkipped: this.skipped,
    };
    if (detail) s.detail = detail;
    return s;
  }

  /** Every API and application name in the retained history (the overflow name excluded), sorted. */
  private nameLists(): { apis: string[]; apps: string[] } {
    if (this.dimsStale) this.sweepDims();
    if (!this.names || this.names.version !== this.dims.version) {
      const apis = new Set<string>();
      const apps = new Set<string>();
      for (const d of this.dims.values()) {
        if (d.other) continue;
        apis.add(d.api);
        apps.add(d.app);
      }
      this.names = { version: this.dims.version, apis: [...apis].sort(byName), apps: [...apps].sort(byName) };
    }
    return { apis: this.names.apis.slice(), apps: this.names.apps.slice() };
  }

  summary(q: GwQuery): GwSummary {
    const range: GwRange = q && Object.prototype.hasOwnProperty.call(RANGES, q.range) ? q.range : "1h";
    const def = RANGES[range];
    const api = q && typeof q.api === "string" && q.api !== "" ? q.api : undefined;
    const app = q && typeof q.app === "string" && q.app !== "" ? q.app : undefined;
    const now = this.clock();
    const last = Math.floor(now / def.stepMs) * def.stepMs;     // start of the current, still partial, step
    const from = last - (def.points - 1) * def.stepMs;
    const to = last + def.stepMs;
    const src = def.src === "m" ? this.minutes : this.hours;
    const srcStep = def.src === "m" ? MINUTE : HOUR;

    const totals = new Agg();
    const points: (Agg | undefined)[] = new Array<Agg | undefined>(def.points);
    const apis = new Map<string, Group>();
    const apps = new Map<string, Group>();
    const ops = new Map<string, Group>();
    const statuses = new Map<number, number>();
    const errorTypes = new Map<string, number>();

    for (let t = from; t < to; t += srcStep) {
      const bucket = src.get(t);
      if (!bucket) continue;
      const idx = Math.floor((t - from) / def.stepMs);
      for (const row of bucket.values()) {
        const d = row.d;
        if (api !== undefined && d.api !== api) continue;
        if (app !== undefined && d.app !== app) continue;
        totals.add(row);
        (points[idx] ??= new Agg()).add(row);
        addToGroup(apis, d.api, row);
        addToGroup(apps, d.app, row);
        addToGroup(ops, d.op, row);
        const st = row.st;
        for (let i = 0; i < st.length; i += 2) statuses.set(st[i], (statuses.get(st[i]) ?? 0) + st[i + 1]);
        const et = row.et;
        if (et) for (let i = 0; i < et.length; i += 2) errorTypes.set(et[i] as string, (errorTypes.get(et[i] as string) ?? 0) + (et[i + 1] as number));
      }
    }

    const series: GwSeriesPoint[] = [];
    for (let i = 0; i < def.points; i++) {
      const a = points[i];
      const t = from + i * def.stepMs;
      series.push(a
        ? { t, requests: a.n, s2xx: a.c2, s3xx: a.c3, s4xx: a.c4, s5xx: a.c5, faults: a.f, throttled: a.th, cacheHits: a.ch,
            avgResponseMs: a.avgResponse, avgBackendMs: a.avgBackend, p95Ms: a.pResponse(0.95) }
        : { t, requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, faults: 0, throttled: 0, cacheHits: 0, avgResponseMs: 0, avgBackendMs: 0, p95Ms: 0 });
    }

    const t: GwTotals = {
      requests: totals.n, success: totals.n - totals.c4 - totals.c5, clientErrors: totals.c4, serverErrors: totals.c5,
      faults: totals.f, throttled: totals.th, cacheHits: totals.ch,
      avgResponseMs: totals.avgResponse, avgBackendMs: totals.avgBackend, avgMediationMs: totals.avgMediation,
      p50Ms: totals.pResponse(0.5), p95Ms: totals.pResponse(0.95), p99Ms: totals.pResponse(0.99),
      backendP50Ms: totals.pBackend(0.5), backendP95Ms: totals.pBackend(0.95),
    };

    const latencyHistogram: GwSummary["latencyHistogram"] = [];
    for (let i = 0; i < HIST_SIZE; i++) {
      const le = i < LATENCY_BOUNDS_MS.length ? LATENCY_BOUNDS_MS[i] : null;
      latencyHistogram.push({
        leMs: le,
        label: le === null ? `> ${fmtMs(LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1])}` : `≤ ${fmtMs(le)}`,
        response: totals.hr[i], backend: totals.hb[i],
      });
    }

    const names = this.nameLists();
    return {
      range, from, to, stepSeconds: def.stepMs / 1000,
      totals: t, series,
      byApi: breakdown(apis, totals.n, (d) => ({ label: d.api, extra: { version: d.version, context: d.context } })),
      byApp: breakdown(apps, totals.n, (d) => ({ label: d.app, extra: { owner: d.appOwner } })),
      byOperation: breakdown(ops, totals.n, (d) => ({
        label: d.other ? OTHER : `${d.method} ${d.resource}`.trim(),
        extra: { api: d.api, method: d.method, resource: d.resource },
      })),
      byStatus: [...statuses].map(([status, requests]) => ({ status, requests })).sort((a, b) => b.requests - a.requests || a.status - b.status),
      byErrorType: [...errorTypes].map(([errorType, requests]) => ({ errorType, requests }))
        .sort((a, b) => b.requests - a.requests || (a.errorType < b.errorType ? -1 : a.errorType > b.errorType ? 1 : 0)),
      latencyHistogram,
      apis: names.apis, apps: names.apps,
    };
  }

  recent(q: GwRecentQuery): GwRecentResult {
    const query: GwRecentQuery = q ?? {};
    const limitRaw = typeof query.limit === "number" && Number.isFinite(query.limit) ? Math.floor(query.limit) : 200;
    const limit = Math.min(1000, Math.max(1, limitRaw));
    const api = query.api || undefined;
    const app = query.app || undefined;
    const status = query.status && query.status !== "all" ? query.status : undefined;
    const corr = query.correlationId ? query.correlationId.trim().toLowerCase() : "";
    const search = query.search ? query.search.trim().toLowerCase() : "";

    const matches: GwEvent[] = [];
    for (let i = 1; i <= this.ringSize; i++) {                  // newest arrival first
      const ev = this.ring[(this.ringHead - i + this.recentMax * 2) % this.recentMax];
      if (!ev) continue;
      if (api !== undefined && ev.api !== api) continue;
      if (app !== undefined && ev.app !== app) continue;
      if (status === "2xx" && !(ev.status >= 200 && ev.status < 300)) continue;
      if (status === "4xx" && !(ev.status >= 400 && ev.status < 500)) continue;
      if (status === "5xx" && !(ev.status >= 500)) continue;
      if (status === "fault" && ev.type !== "fault") continue;
      if (status === "throttled" && !ev.throttled) continue;
      if (corr && ev.correlationId.toLowerCase() !== corr) continue;
      if (search) {
        const hay = `${ev.api}\n${ev.context}\n${ev.resource}\n${ev.method}\n${ev.app}\n${ev.user}\n${ev.userIp}\n${ev.correlationId}\n${ev.status}\n${ev.errorType}\n${ev.errorMessage}\n${ev.userAgent}`;
        if (!hay.toLowerCase().includes(search)) continue;
      }
      matches.push(ev);
    }
    // The log is written when a request completes, so arrival order is only roughly time order.
    matches.sort((a, b) => b.ts - a.ts);                        // stable: ties keep newest arrival first
    return { total: matches.length, kept: this.ringSize, rows: matches.length > limit ? matches.slice(0, limit) : matches };
  }

  lastHourByApi(): Record<string, GwApiHour> {
    const now = this.clock();
    const last = Math.floor(now / MINUTE) * MINUTE;
    const groups = new Map<string, Agg>();
    for (let t = last - 59 * MINUTE; t <= last; t += MINUTE) {
      const bucket = this.minutes.get(t);
      if (!bucket) continue;
      for (const row of bucket.values()) {
        let a = groups.get(row.d.api);
        if (!a) {
          a = new Agg();
          groups.set(row.d.api, a);
        }
        a.add(row);
      }
    }
    const out: Record<string, GwApiHour> = Object.create(null) as Record<string, GwApiHour>;
    for (const [name, a] of groups) {
      out[name] = { requests: a.n, errors: a.errors, avgMs: a.avgResponse, p95Ms: a.pResponse(0.95), lastAt: a.la > 0 ? a.la : null };
    }
    return out;
  }
}

/**
 * Creates the gateway analytics indexer. Nothing is read until start() (or tick()) is called;
 * with no log directory configured every query returns an empty result.
 */
export function createGatewayAnalytics(opts: GwAnalyticsOptions & GwTuning): GatewayAnalyticsIndexer {
  return new Indexer(opts);
}
