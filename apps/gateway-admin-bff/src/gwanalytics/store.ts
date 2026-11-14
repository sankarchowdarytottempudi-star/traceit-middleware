// Crash-consistent persistence for the analytics index, under <dataDir>/gateway-analytics/.
//
//   index.snapshot.ndjson  full state. Line 1 is a header {format, v, gen, pos, counters}, then one
//                          line per bucket ["m"|"h", bucketStartMs, rows], then {"end":true,"buckets":N}.
//                          Always written to a temp file, fsynced and renamed into place.
//   index.journal.ndjson   appended between snapshots: one line per flush, holding the file
//                          position, the counters and the full contents of every bucket that
//                          changed since the previous flush. Each line names the snapshot
//                          generation it belongs to; lines of any other generation are ignored.
//
// The file position and the aggregates always travel in the same record, so whatever survives a
// crash (the snapshot plus every complete journal line) is a state the indexer really was in:
// resuming from the saved offset neither double counts nor leaves a gap. A torn last journal line
// is ignored. A snapshot that cannot be parsed is set aside (*.corrupt) and indexing starts over.
import { promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { type Bucket, type DimPool, bucketFromJson, bucketToJson } from "./rollup.js";

export const INDEX_DIR = "gateway-analytics";
export const SNAPSHOT_FILE = "index.snapshot.ndjson";
export const JOURNAL_FILE = "index.journal.ndjson";
export const SNAPSHOT_CORRUPT_FILE = "index.snapshot.corrupt.ndjson";
export const JOURNAL_CORRUPT_FILE = "index.journal.corrupt.ndjson";
export const FORMAT_NAME = "gw-analytics-index";
export const FORMAT_VERSION = 1;

/** Where the tailer is in the log file. `offset` always sits just after a newline (or at 0). */
export interface FilePos {
  path: string;      // file the position refers to
  ino: string;       // inode ("" = no file being followed)
  offset: number;    // bytes consumed
  skip: boolean;     // inside an over-long line: discard up to the next newline
  fp: string;        // hash of the first fpLen bytes, to detect a different file behind the same inode
  fpLen: number;
}
export interface Counters { events: number; skipped: number; lastEventAt: number | null; lastReadAt: number | null; }
export interface IndexData {
  pos: FilePos; counters: Counters;
  minutes: Map<number, Bucket>; hours: Map<number, Bucket>;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export function errCode(e: unknown): string {
  return isObj(e) && typeof e.code === "string" ? e.code : "";
}
export function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 200 ? msg.slice(0, 200) : msg;
}

function decodePos(v: unknown): FilePos {
  if (!isObj(v)) throw new Error("bad position");
  const { path: p, ino, offset, skip, fp, fpLen } = v;
  if (typeof p !== "string" || typeof ino !== "string" || typeof fp !== "string") throw new Error("bad position");
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("bad offset");
  if (typeof fpLen !== "number" || !Number.isSafeInteger(fpLen) || fpLen < 0 || fpLen > offset) throw new Error("bad fingerprint length");
  return { path: p, ino, offset, skip: skip === true, fp, fpLen };
}

function decodeCounters(v: unknown): Counters {
  if (!isObj(v)) throw new Error("bad counters");
  const count = (x: unknown): number => {
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0) throw new Error("bad counter");
    return x;
  };
  const time = (x: unknown): number | null => (x === null || x === undefined ? null : count(x));
  return { events: count(v.events), skipped: count(v.skipped), lastEventAt: time(v.lastEventAt), lastReadAt: time(v.lastReadAt) };
}

function decodeBucketStart(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error("bad bucket start");
  return v;
}

function decodeBucketList(v: unknown, pool: DimPool): [number, Bucket][] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error("bad bucket list");
  return v.map((item) => {
    if (!Array.isArray(item) || item.length !== 2) throw new Error("bad bucket entry");
    return [decodeBucketStart(item[0]), bucketFromJson(item[1], pool)] as [number, Bucket];
  });
}

async function writeAll(fh: FileHandle, text: string): Promise<number> {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off, null);
    off += bytesWritten;
  }
  return buf.length;
}

async function* readLines(file: string, chunkBytes = 1 << 20): AsyncGenerator<string> {
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.allocUnsafe(chunkBytes);
    let carry: Buffer | null = null;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead <= 0) break;
      const chunk = buf.subarray(0, bytesRead);
      const data: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
      let start = 0;
      for (;;) {
        const nl = data.indexOf(10, start);
        if (nl < 0) break;
        yield data.toString("utf8", start, nl);
        start = nl + 1;
      }
      carry = start < data.length ? Buffer.from(data.subarray(start)) : null;
    }
    if (carry && carry.length) yield carry.toString("utf8");
  } finally {
    await fh.close().catch(() => undefined);
  }
}

export class IndexStore {
  readonly dir: string;
  /** Generation of the snapshot on disk ("" = none). */
  gen = "";
  snapshotBytes = 0;
  journalBytes = 0;
  /** True when the next flush must write a full snapshot (no snapshot yet, or the journal is not trustworthy). */
  needsSnapshot = true;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, INDEX_DIR);
  }
  private file(name: string): string { return path.join(this.dir, name); }

  /**
   * Loads the saved index; row dimensions are interned in `pool`. Never throws: an unusable
   * index is set aside and null is returned.
   */
  async load(log: (msg: string) => void, pool: DimPool): Promise<IndexData | null> {
    this.gen = ""; this.snapshotBytes = 0; this.journalBytes = 0; this.needsSnapshot = true;
    let data: IndexData;
    let gen: string;
    try {
      ({ data, gen } = await this.readSnapshot(pool));
    } catch (e) {
      if (errCode(e) === "ENOENT") {
        await fsp.rm(this.file(JOURNAL_FILE), { force: true }).catch(() => undefined); // a journal without its snapshot is useless
        return null;
      }
      log(`gateway analytics: saved index is unusable (${errText(e)}); set aside, re-indexing the current log file`);
      await this.setAside();
      return null;
    }
    this.gen = gen;
    this.needsSnapshot = false;
    try {
      this.snapshotBytes = (await fsp.stat(this.file(SNAPSHOT_FILE))).size;
    } catch { /* size only steers compaction */ }

    let journal: Buffer | null = null;
    try {
      journal = await fsp.readFile(this.file(JOURNAL_FILE));
    } catch (e) {
      if (errCode(e) !== "ENOENT") this.needsSnapshot = true;
    }
    if (journal) {
      this.journalBytes = journal.length;
      let start = 0;
      let clean = true;
      let applied = 0;
      while (start < journal.length) {
        const nl = journal.indexOf(10, start);
        if (nl < 0) { clean = false; break; }               // torn last record
        try {
          const rec: unknown = JSON.parse(journal.toString("utf8", start, nl));
          if (!isObj(rec) || rec.v !== FORMAT_VERSION || typeof rec.gen !== "string") throw new Error("bad record");
          if (rec.gen === gen) {
            // Decode everything first so a damaged record is never half applied.
            const pos = decodePos(rec.pos);
            const counters = decodeCounters(rec.counters);
            const m = decodeBucketList(rec.m, pool);
            const h = decodeBucketList(rec.h, pool);
            data.pos = pos;
            data.counters = counters;
            for (const [t, b] of m) data.minutes.set(t, b);
            for (const [t, b] of h) data.hours.set(t, b);
            applied++;
          } else {
            clean = false;                                   // left over from an older snapshot
          }
        } catch {
          clean = false;                                     // everything from here on is unusable
          break;
        }
        start = nl + 1;
      }
      if (!clean) {
        this.needsSnapshot = true;                           // rewrite the snapshot instead of appending after junk
        log(`gateway analytics: index journal had unusable records; kept ${applied}, the rest is ignored`);
      }
    }
    return data;
  }

  private async readSnapshot(pool: DimPool): Promise<{ data: IndexData; gen: string }> {
    let header: { gen: string; pos: FilePos; counters: Counters } | null = null;
    const minutes = new Map<number, Bucket>();
    const hours = new Map<number, Bucket>();
    let buckets = 0;
    let ended = false;
    let first = true;
    for await (const line of readLines(this.file(SNAPSHOT_FILE))) {
      if (ended) {
        if (line.trim()) throw new Error("data after the end marker");
        continue;
      }
      const v: unknown = JSON.parse(line);
      if (first) {
        first = false;
        if (!isObj(v) || v.format !== FORMAT_NAME) throw new Error("not an index snapshot");
        if (v.v !== FORMAT_VERSION) throw new Error(`unsupported index version ${String(v.v)}`);
        if (typeof v.gen !== "string" || !v.gen) throw new Error("missing generation");
        header = { gen: v.gen, pos: decodePos(v.pos), counters: decodeCounters(v.counters) };
      } else if (Array.isArray(v)) {
        if (v.length !== 3 || (v[0] !== "m" && v[0] !== "h")) throw new Error("bad bucket line");
        (v[0] === "m" ? minutes : hours).set(decodeBucketStart(v[1]), bucketFromJson(v[2], pool));
        buckets++;
      } else if (isObj(v) && v.end === true) {
        if (v.buckets !== buckets) throw new Error("bucket count mismatch");
        ended = true;
      } else {
        throw new Error("unexpected line");
      }
    }
    if (!header || !ended) throw new Error("incomplete snapshot");
    return { data: { pos: header.pos, counters: header.counters, minutes, hours }, gen: header.gen };
  }

  private async setAside(): Promise<void> {
    for (const [from, to] of [[SNAPSHOT_FILE, SNAPSHOT_CORRUPT_FILE], [JOURNAL_FILE, JOURNAL_CORRUPT_FILE]] as const) {
      try {
        await fsp.rename(this.file(from), this.file(to));
      } catch (e) {
        if (errCode(e) !== "ENOENT") await fsp.rm(this.file(from), { force: true }).catch(() => undefined);
      }
    }
  }

  /** Writes the whole index: temp file, fsync, rename. The previous snapshot stays valid until the rename. */
  async writeSnapshot(data: IndexData): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const gen = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
    const tmp = this.file(`${SNAPSHOT_FILE}.tmp`);
    const fh = await fsp.open(tmp, "w");
    let bytes = 0;
    try {
      let parts: string[] = [];
      let pending = 0;
      const put = async (line: string, force = false): Promise<void> => {
        parts.push(line, "\n");
        pending += line.length + 1;
        if (force || pending >= 512 * 1024) {
          const text = parts.join("");
          parts = []; pending = 0;
          bytes += await writeAll(fh, text);                 // awaiting real I/O also lets the event loop breathe
        }
      };
      await put(JSON.stringify({ format: FORMAT_NAME, v: FORMAT_VERSION, gen, savedAt: Date.now(), pos: data.pos, counters: data.counters }));
      let buckets = 0;
      for (const [t, b] of data.minutes) { await put(JSON.stringify(["m", t, bucketToJson(b)])); buckets++; }
      for (const [t, b] of data.hours) { await put(JSON.stringify(["h", t, bucketToJson(b)])); buckets++; }
      await put(JSON.stringify({ end: true, buckets }), true);
      await fh.sync();
    } catch (e) {
      await fh.close().catch(() => undefined);
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    await fh.close();
    await fsp.rename(tmp, this.file(SNAPSHOT_FILE));
    this.gen = gen;
    this.snapshotBytes = bytes;
    this.needsSnapshot = false;
    // The journal belongs to the previous generation now. If it cannot be removed, its old lines
    // are skipped on load (generation mismatch), but keep snapshotting rather than append after them.
    try {
      await fsp.rm(this.file(JOURNAL_FILE), { force: true });
      this.journalBytes = 0;
    } catch {
      this.needsSnapshot = true;
    }
    try {                                                    // best effort: make the rename durable
      const dh = await fsp.open(this.dir, "r");
      try { await dh.sync(); } finally { await dh.close(); }
    } catch { /* not supported everywhere */ }
  }

  /** Appends one record with the position, the counters and the full contents of the changed buckets. */
  async appendJournal(data: IndexData, dirtyMinutes: Iterable<number>, dirtyHours: Iterable<number>): Promise<void> {
    const collect = (keys: Iterable<number>, from: Map<number, Bucket>): [number, unknown[]][] => {
      const out: [number, unknown[]][] = [];
      for (const t of keys) {
        const b = from.get(t);
        if (b) out.push([t, bucketToJson(b)]);              // pruned buckets need no record
      }
      return out;
    };
    const record = JSON.stringify({
      v: FORMAT_VERSION, gen: this.gen, savedAt: Date.now(), pos: data.pos, counters: data.counters,
      m: collect(dirtyMinutes, data.minutes), h: collect(dirtyHours, data.hours),
    }) + "\n";
    try {
      const fh = await fsp.open(this.file(JOURNAL_FILE), "a");
      try {
        this.journalBytes += await writeAll(fh, record);
        await fh.datasync();
      } finally {
        await fh.close();
      }
    } catch (e) {
      this.needsSnapshot = true;                             // the tail may be torn: never append after it
      throw e;
    }
  }
}
