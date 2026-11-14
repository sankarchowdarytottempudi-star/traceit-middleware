import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGatewayAnalytics, type GatewayAnalyticsIndexer, type GwAnalyticsOptions, type GwTuning } from "../src/gwanalytics/index.js";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 14, 14, 29, 30); // 2026-11-14T14:29:30Z, mid-minute

interface Ev {
  ts: number; api?: string; version?: string; context?: string; app?: string; owner?: string; method?: string; resource?: string;
  status?: number; rl?: number; bl?: number; cacheHit?: boolean; corr?: string; user?: string; ip?: string; agent?: string;
  errorType?: string; errorCode?: number; errorMessage?: string;
}

function common(e: Ev): Record<string, unknown> {
  return {
    apiName: e.api ?? "cms-proc-api", apiVersion: e.version ?? "v1", apiMethod: e.method ?? "GET",
    apiResourceTemplate: e.resource ?? "/descriptions/{type}", applicationName: e.app ?? "aroya-connector",
    applicationOwner: e.owner ?? "admin", keyType: "PRODUCTION", platform: "Other", gatewayType: "SYNAPSE",
    correlationId: e.corr ?? "00a94b54-5579-4f7e-95ed-5d6ac3ac4ee3", requestTimestamp: new Date(e.ts).toISOString(),
    userAgent: e.agent ?? "curl", userIp: e.ip ?? "10.42.0.1", regionId: "default", apiType: "HTTP",
  };
}
function resp(e: Ev): string {
  const props = {
    ...common(e), proxyResponseCode: e.status ?? 200, targetResponseCode: e.status ?? 200,
    destination: "http://cms-proc-api.wso2.svc/cms-proc-api/v1", responseCacheHit: e.cacheHit ?? false,
    backendLatency: e.cacheHit ? 0 : e.bl ?? 41, responseLatency: e.rl ?? 46, requestMediationLatency: 3, responseMediationLatency: 2,
    userName: e.user ?? "admin@carbon.super", apiContext: e.context ?? "/cms/v1",
    properties: { commonName: "N/A", responseContentType: "application/json", apiContext: e.context ?? "/cms/v1", responseSize: "1820" },
  };
  return `14:29:14,402 [-] [PassThroughMessageProcessor-12]  INFO ELKCounterMetric apimMetrics: apim:response, properties :${JSON.stringify(props)}`;
}
function fault(e: Ev): string {
  const props = {
    ...common(e), proxyResponseCode: e.status ?? 401, targetResponseCode: -1, responseCacheHit: false,
    errorType: e.errorType ?? "AUTH", errorCode: e.errorCode ?? 900902, errorMessage: e.errorMessage ?? "AUTHENTICATION_FAILURE",
    properties: { commonName: "N/A", apiContext: e.context ?? "/cms/v1" },
  };
  return `14:29:15,010 [-] [PassThroughMessageProcessor-13]  INFO ELKCounterMetric apimMetrics: apim:faulty, properties :${JSON.stringify(props)}`;
}
const text = (lines: string[]): string => lines.map((l) => `${l}\n`).join("");

interface Env {
  root: string; logDir: string; dataDir: string; file: string; indexDir: string;
  now: number; logs: string[];
  make(extra?: Partial<GwAnalyticsOptions> & GwTuning): GatewayAnalyticsIndexer;
  write(lines: string[]): void;
  append(lines: string[]): void;
}

const roots: string[] = [];
const instances: GatewayAnalyticsIndexer[] = [];

function env(opts: { createLogDir?: boolean } = {}): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gwanalytics-"));
  roots.push(root);
  const logDir = path.join(root, "logs");
  const dataDir = path.join(root, "data");
  if (opts.createLogDir !== false) fs.mkdirSync(logDir);
  const e: Env = {
    root, logDir, dataDir, file: path.join(logDir, "apim_metrics.log"), indexDir: path.join(dataDir, "gateway-analytics"),
    now: T0, logs: [],
    make(extra = {}) {
      const a = createGatewayAnalytics({ logDir, dataDir, now: () => e.now, log: (m) => e.logs.push(m), ...extra });
      instances.push(a);
      return a;
    },
    write(lines) { fs.writeFileSync(e.file, text(lines)); },
    append(lines) { fs.appendFileSync(e.file, text(lines)); },
  };
  return e;
}

afterEach(async () => {
  for (const a of instances.splice(0)) await a.stop();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const requests = (a: GatewayAnalyticsIndexer, range: "15m" | "1h" | "6h" | "24h" | "7d" | "30d" = "1h"): number => a.summary({ range }).totals.requests;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await sleep(10);
  }
}

describe("gateway analytics: not configured", () => {
  it("returns empty results and never touches the disk", async () => {
    for (const logDir of [undefined, "", "   "]) {
      const e = env();
      const a = createGatewayAnalytics({ logDir, dataDir: e.dataDir, now: () => e.now });
      instances.push(a);
      a.start();
      await a.tick();
      expect(a.status()).toEqual({
        state: "not-configured", enabled: false, file: null, fileSize: 0, lastEventAt: null, lastReadAt: null,
        oldestAt: null, eventsIndexed: 0, linesSkipped: 0,
      });
      const s = a.summary({ range: "15m" });
      expect(s.range).toBe("15m");
      expect(s.stepSeconds).toBe(60);
      expect(s.series).toHaveLength(15);
      expect(s.series.every((p) => p.requests === 0 && p.p95Ms === 0)).toBe(true);
      expect(s.to).toBe(Math.floor(T0 / MIN) * MIN + MIN);
      expect(s.totals).toEqual({
        requests: 0, success: 0, clientErrors: 0, serverErrors: 0, faults: 0, throttled: 0, cacheHits: 0,
        avgResponseMs: 0, avgBackendMs: 0, avgMediationMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, backendP50Ms: 0, backendP95Ms: 0,
      });
      expect([s.byApi, s.byApp, s.byOperation, s.byStatus, s.byErrorType, s.apis, s.apps]).toEqual([[], [], [], [], [], [], []]);
      expect(s.latencyHistogram).toHaveLength(12);
      expect(a.recent({})).toEqual({ total: 0, kept: 0, rows: [] });
      expect(Object.keys(a.lastHourByApi())).toEqual([]);
      await a.stop();
      expect(fs.existsSync(e.dataDir)).toBe(false);
    }
  });
});

describe("gateway analytics: following the file", () => {
  it("waits for the directory and the file, then becomes active", async () => {
    const e = env({ createLogDir: false });
    const a = e.make();
    expect(a.status().state).toBe("waiting-for-file");
    await a.tick();
    expect(a.status()).toMatchObject({ state: "waiting-for-file", enabled: false, file: e.file, eventsIndexed: 0 });
    fs.mkdirSync(e.logDir);
    await a.tick();
    expect(a.status().state).toBe("waiting-for-file");
    e.write([resp({ ts: T0 - 1000 }), resp({ ts: T0 - 500 })]);
    await a.tick();
    const st = a.status();
    expect(st).toMatchObject({ state: "active", enabled: true, eventsIndexed: 2, linesSkipped: 0, fileSize: fs.statSync(e.file).size });
    expect(st.lastEventAt).toBe(new Date(T0 - 500).toISOString());
    expect(st.lastReadAt).toBe(new Date(T0).toISOString());
    expect(st.oldestAt).toBe(new Date(Math.floor((T0 - 1000) / HOUR) * HOUR).toISOString());
    expect(st.detail).toBeUndefined();
    expect(requests(a)).toBe(2);
  });

  it("reports an error when the path cannot be read as a file", async () => {
    const e = env();
    fs.mkdirSync(e.file);
    const a = e.make();
    await a.tick();
    expect(a.status()).toMatchObject({ state: "error", enabled: false, eventsIndexed: 0 });
    expect(a.status().detail).toBeTruthy();
    fs.rmdirSync(e.file);
    e.write([resp({ ts: T0 })]);
    await a.tick();
    expect(a.status()).toMatchObject({ state: "active", eventsIndexed: 1 });
    expect(a.status().detail).toBeUndefined();
  });

  it("indexes appends incrementally and waits for a half-written line to be completed", async () => {
    const e = env();
    const a = e.make();
    e.write([resp({ ts: T0 - 3000 }), fault({ ts: T0 - 2000 })]);
    await a.tick();
    expect(a.status().eventsIndexed).toBe(2);
    await a.tick();                                   // nothing new: nothing counted twice
    expect(a.status().eventsIndexed).toBe(2);

    const next = resp({ ts: T0 - 1000, status: 500 });
    fs.appendFileSync(e.file, next.slice(0, 200));    // half a line, no newline yet
    await a.tick();
    expect(a.status()).toMatchObject({ eventsIndexed: 2, linesSkipped: 0 });
    fs.appendFileSync(e.file, next.slice(200, 400));
    await a.tick();
    expect(a.status()).toMatchObject({ eventsIndexed: 2, linesSkipped: 0 });
    fs.appendFileSync(e.file, `${next.slice(400)}\n${resp({ ts: T0 - 900 })}\n`);
    await a.tick();
    expect(a.status()).toMatchObject({ eventsIndexed: 4, linesSkipped: 0 });
    const t = a.summary({ range: "15m" }).totals;
    expect(t).toMatchObject({ requests: 4, success: 2, clientErrors: 1, serverErrors: 1, faults: 1 });
  });

  it("counts noise, blank lines, stack traces and truncated events as skipped and carries on", async () => {
    const e = env();
    const a = e.make();
    const good = resp({ ts: T0 - 1000 });
    fs.writeFileSync(e.file, [
      "[2026-11-14 14:20:01,113]  INFO {StartupFinalizerServiceComponent} - WSO2 Carbon started in 42 sec",
      "",
      good,
      "java.lang.IllegalStateException: boom",
      "\tat org.wso2.am.analytics.publisher.reporter.elk.ELKCounterMetric.incrementCount(ELKCounterMetric.java:62)",
      good.slice(0, 300),                             // truncated JSON that did get its newline
      `${good}\r`,                                    // CRLF line ending
      "",
    ].join("\n"));
    await a.tick();
    expect(a.status()).toMatchObject({ state: "active", eventsIndexed: 2, linesSkipped: 5 });
  });

  it("reads a large backlog in small chunks, with lines spanning chunk boundaries", async () => {
    const e = env();
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) lines.push(i % 10 === 0 ? "noise ééé ☃ line" : resp({ ts: T0 - i * 100, user: `üser-${i}@carbon.super` }));
    e.write(lines);
    const a = e.make({ chunkBytes: 257 });
    await a.tick();
    expect(a.status()).toMatchObject({ eventsIndexed: 360, linesSkipped: 40 });
    expect(requests(a)).toBe(360);
    expect(a.recent({ search: "üser-399@" }).total).toBe(1);
  });

  it("skips absurdly long lines without consuming what follows", async () => {
    const e = env();
    const a = e.make({ maxLineBytes: 2000, chunkBytes: 512 });
    fs.writeFileSync(e.file, `${resp({ ts: T0 - 3000 })}\n${"x".repeat(10_000)}\n${resp({ ts: T0 - 2000 })}\n`);
    await a.tick();
    expect(a.status()).toMatchObject({ eventsIndexed: 2, linesSkipped: 1 });
    // an over-long line that is still being written: skipped once, and its tail is discarded when the newline arrives
    fs.appendFileSync(e.file, "y".repeat(5000));
    await a.tick();
    expect(a.status()).toMatchObject({ eventsIndexed: 2, linesSkipped: 2 });
    fs.appendFileSync(e.file, `${"y".repeat(3000)}${resp({ ts: T0 - 1500 })}\n${resp({ ts: T0 - 1000 })}\n`);
    await a.tick();
    expect(a.status()).toMatchObject({ eventsIndexed: 3, linesSkipped: 2 });
    // the skip state survives a restart
    fs.appendFileSync(e.file, "z".repeat(5000));
    await a.tick();
    await a.stop();
    const b = e.make({ maxLineBytes: 2000, chunkBytes: 512 });
    fs.appendFileSync(e.file, `zzz\n${resp({ ts: T0 - 500 })}\n`);
    await b.tick();
    expect(b.status()).toMatchObject({ eventsIndexed: 4, linesSkipped: 3 });
  });

  it("finishes the rotated file before starting the new one", async () => {
    const e = env();
    const a = e.make();
    e.write([resp({ ts: T0 - 9000 }), resp({ ts: T0 - 8000 }), resp({ ts: T0 - 7000 })]);
    await a.tick();
    expect(a.status().eventsIndexed).toBe(3);
    e.append([resp({ ts: T0 - 6000 }), fault({ ts: T0 - 5000 })]);          // written just before the rollover, not read yet
    fs.renameSync(e.file, path.join(e.logDir, "apim_metrics-11-14-2026-1.log"));
    e.write([resp({ ts: T0 - 4000, corr: "first-in-new-file" })]);
    await a.tick();
    expect(a.status()).toMatchObject({ state: "active", eventsIndexed: 6, linesSkipped: 0 });
    expect(requests(a)).toBe(6);
    expect(a.recent({}).rows[0].correlationId).toBe("first-in-new-file");
    e.append([resp({ ts: T0 - 3000 })]);
    await a.tick();
    expect(a.status().eventsIndexed).toBe(7);
    expect(e.logs.some((m) => m.includes("rotated"))).toBe(true);
  });

  it("handles a poll that lands between the rename and the creation of the new file", async () => {
    const e = env();
    const a = e.make();
    e.write([resp({ ts: T0 - 9000 })]);
    await a.tick();
    fs.appendFileSync(e.file, `${resp({ ts: T0 - 8000 })}\n${resp({ ts: T0 - 7000 })}`);   // last line never got its newline
    fs.renameSync(e.file, path.join(e.logDir, "apim_metrics-11-14-2026-1.log"));
    await a.tick();
    expect(a.status()).toMatchObject({ state: "waiting-for-file", eventsIndexed: 3 });
    await a.tick();
    expect(a.status().eventsIndexed).toBe(3);                               // the old file is not read twice
    e.write([resp({ ts: T0 - 6000 })]);
    await a.tick();
    expect(a.status()).toMatchObject({ state: "active", eventsIndexed: 4 });
  });

  it("carries on when the rotated file is already gone (compressed)", async () => {
    const e = env();
    const a = e.make();
    e.write([resp({ ts: T0 - 9000 })]);
    await a.tick();
    e.append([resp({ ts: T0 - 8000 })]);
    fs.renameSync(e.file, path.join(e.root, "moved-away.log"));             // not in the log directory any more
    fs.writeFileSync(path.join(e.logDir, "apim_metrics-11-14-2026-1.log.gz"), "not the same inode");
    e.write([resp({ ts: T0 - 7000 }), resp({ ts: T0 - 6000 })]);
    await a.tick();
    expect(a.status()).toMatchObject({ state: "active", eventsIndexed: 3 });
  });

  it("starts over after a truncation", async () => {
    const e = env();
    const a = e.make();
    e.write([resp({ ts: T0 - 9000 }), resp({ ts: T0 - 8000 }), resp({ ts: T0 - 7000 })]);
    await a.tick();
    fs.truncateSync(e.file, 0);
    e.append([resp({ ts: T0 - 6000 })]);
    await a.tick();
    expect(a.status()).toMatchObject({ state: "active", eventsIndexed: 4 });
    expect(e.logs.some((m) => m.includes("truncated"))).toBe(true);
  });

  it("starts over when the file is rewritten in place and is already longer than the saved offset", async () => {
    const e = env();
    const a = e.make();
    e.write([resp({ ts: T0 - 9000 })]);
    await a.tick();
    const ino = fs.statSync(e.file).ino;
    fs.writeFileSync(e.file, text([resp({ ts: T0 - 5000, corr: "n1" }), resp({ ts: T0 - 4000, corr: "n2" }), resp({ ts: T0 - 3000, corr: "n3" })]));
    expect(fs.statSync(e.file).ino).toBe(ino);
    await a.tick();
    expect(a.status().eventsIndexed).toBe(4);
  });
});

describe("gateway analytics: persistence", () => {
  it("resumes after a restart with no double counting and refills the recent ring", async () => {
    const e = env();
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) lines.push(i % 8 === 0 ? fault({ ts: T0 - (40 - i) * 1000, corr: `c-${i}` }) : resp({ ts: T0 - (40 - i) * 1000, corr: `c-${i}`, rl: 10 + i }));
    lines.splice(5, 0, "some noise");
    e.write(lines);
    const a = e.make();
    await a.tick();
    const before = { summary: a.summary({ range: "1h" }), week: a.summary({ range: "7d" }), status: a.status(), recent: a.recent({ limit: 1000 }) };
    expect(before.status).toMatchObject({ eventsIndexed: 40, linesSkipped: 1 });
    await a.stop();
    expect(fs.existsSync(path.join(e.indexDir, "index.snapshot.ndjson"))).toBe(true);
    expect(fs.existsSync(path.join(e.indexDir, "index.snapshot.ndjson.tmp"))).toBe(false);

    const b = e.make();
    expect(b.status().eventsIndexed).toBe(0);         // nothing is loaded before the first poll
    await b.tick();
    expect(b.status()).toEqual(before.status);
    expect(b.summary({ range: "1h" })).toEqual(before.summary);
    expect(b.summary({ range: "7d" })).toEqual(before.week);
    expect(b.recent({ limit: 1000 })).toEqual(before.recent);
    expect(b.recent({}).kept).toBe(40);

    e.append([resp({ ts: T0 - 100, corr: "after-restart" })]);
    await b.tick();
    expect(b.status()).toMatchObject({ eventsIndexed: 41, linesSkipped: 1 });
    expect(b.recent({}).rows[0].correlationId).toBe("after-restart");
    expect(b.recent({}).kept).toBe(41);
  });

  it("refills the ring from the tail only, bounded by recentMax", async () => {
    const e = env();
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) lines.push(resp({ ts: T0 - (50 - i) * 1000, corr: `c-${i}` }));
    e.write(lines);
    const a = e.make({ recentMax: 10 });
    await a.tick();
    expect(a.recent({}).kept).toBe(10);
    expect(a.recent({}).rows.map((r) => r.correlationId)).toEqual(["c-49", "c-48", "c-47", "c-46", "c-45", "c-44", "c-43", "c-42", "c-41", "c-40"]);
    await a.stop();
    const lineBytes = Buffer.byteLength(lines[0]) + 1;
    const b = e.make({ recentMax: 10, recentTailBytes: lineBytes * 4 + 10 });   // lands mid-line: 4 whole lines fit
    await b.tick();
    expect(b.status().eventsIndexed).toBe(50);
    expect(b.recent({}).rows.map((r) => r.correlationId)).toEqual(["c-49", "c-48", "c-47", "c-46"]);
  });

  it("re-reads what was indexed but not saved before a crash, exactly once", async () => {
    const e = env();
    const a = e.make();
    e.write([resp({ ts: T0 - 9000 }), resp({ ts: T0 - 8000 }), resp({ ts: T0 - 7000 })]);
    await a.tick();
    await a.flush();
    e.append([resp({ ts: T0 - 6000 }), fault({ ts: T0 - 5000 })]);
    await a.tick();
    expect(a.status().eventsIndexed).toBe(5);
    instances.splice(instances.indexOf(a), 1);        // "crash": this instance never gets to flush again

    const b = e.make();
    await b.tick();
    expect(b.status().eventsIndexed).toBe(5);
    expect(b.summary({ range: "1h" }).totals).toMatchObject({ requests: 5, faults: 1 });
    expect(b.summary({ range: "7d" }).totals).toMatchObject({ requests: 5, faults: 1 });
  });

  it("appends changed buckets to a journal between snapshots and replays it on load", async () => {
    const e = env();
    const snapshot = path.join(e.indexDir, "index.snapshot.ndjson");
    const journal = path.join(e.indexDir, "index.journal.ndjson");
    const a = e.make();
    e.write([resp({ ts: T0 - 9000 }), resp({ ts: T0 - 8000 })]);
    await a.tick();
    await a.flush();
    const snapshotBytes = fs.statSync(snapshot).size;
    expect(fs.existsSync(journal)).toBe(false);
    await a.flush();                                   // nothing changed: nothing written
    expect(fs.existsSync(journal)).toBe(false);

    e.append([resp({ ts: T0 - 7000 }), resp({ ts: T0 - 2 * HOUR })]);
    await a.tick();
    await a.flush();
    e.append([fault({ ts: T0 - 6000 })]);
    await a.tick();
    await a.flush();
    expect(fs.statSync(snapshot).size).toBe(snapshotBytes);                 // snapshot untouched
    expect(fs.readFileSync(journal, "utf8").trimEnd().split("\n")).toHaveLength(2);
    const expected = { status: a.status(), day: a.summary({ range: "24h" }), month: a.summary({ range: "30d" }) };
    expect(expected.status.eventsIndexed).toBe(5);
    instances.splice(instances.indexOf(a), 1);

    // a crash in the middle of the next journal write leaves a torn last line: it is ignored
    fs.appendFileSync(journal, '{"v":1,"gen":"');
    const b = e.make();
    await b.tick();
    expect(b.status()).toEqual(expected.status);
    expect(b.summary({ range: "24h" })).toEqual(expected.day);
    expect(b.summary({ range: "30d" })).toEqual(expected.month);

    // and the next save does not append after the torn line
    e.append([resp({ ts: T0 - 5000 })]);
    await b.tick();
    await b.stop();
    expect(fs.existsSync(journal)).toBe(false);
    const c = e.make();
    await c.tick();
    expect(c.status().eventsIndexed).toBe(6);
    expect(requests(c, "24h")).toBe(6);
  });

  it("ignores journal records that belong to an older snapshot", async () => {
    const e = env();
    const journal = path.join(e.indexDir, "index.journal.ndjson");
    const a = e.make();
    e.write([resp({ ts: T0 - 9000 })]);
    await a.tick();
    await a.flush();
    e.append([resp({ ts: T0 - 8000 })]);
    await a.tick();
    await a.flush();
    const stale = fs.readFileSync(journal);
    await a.stop();
    // new instance writes a fresh snapshot generation; then the old journal reappears (crash between rename and cleanup)
    const b = e.make();
    await b.tick();
    e.append([resp({ ts: T0 - 7000 })]);
    await b.tick();
    fs.rmSync(path.join(e.indexDir, "index.snapshot.ndjson"));
    fs.rmSync(journal, { force: true });
    await b.stop();                                    // no snapshot on disk any more => full snapshot, new generation
    fs.writeFileSync(journal, stale);
    const c = e.make();
    await c.tick();
    expect(c.status().eventsIndexed).toBe(3);
    expect(requests(c)).toBe(3);
  });

  it("sets a corrupt index aside and re-indexes the current file from the start", async () => {
    for (const damage of ["garbage", "truncated", "version", "empty"] as const) {
      const e = env();
      const snapshot = path.join(e.indexDir, "index.snapshot.ndjson");
      const a = e.make();
      e.write([resp({ ts: T0 - 9000 }), resp({ ts: T0 - 8000 }), fault({ ts: T0 - 7000 })]);
      await a.tick();
      await a.stop();
      const good = fs.readFileSync(snapshot, "utf8");
      if (damage === "garbage") fs.writeFileSync(snapshot, "{ this is not json\n\u0000\u0001");
      else if (damage === "truncated") fs.writeFileSync(snapshot, good.slice(0, Math.floor(good.length * 0.6)));
      else if (damage === "version") fs.writeFileSync(snapshot, good.replace('"v":1', '"v":99'));
      else fs.writeFileSync(snapshot, "");
      fs.writeFileSync(`${snapshot}.tmp`, "half written temp file from an interrupted save");

      const b = e.make();
      await b.tick();
      expect(b.status(), damage).toMatchObject({ state: "active", eventsIndexed: 3, linesSkipped: 0 });
      expect(requests(b), damage).toBe(3);
      expect(fs.existsSync(path.join(e.indexDir, "index.snapshot.corrupt.ndjson")), damage).toBe(true);
      expect(e.logs.some((m) => m.includes("unusable")), damage).toBe(true);
      await b.stop();

      const c = e.make();
      await c.tick();
      expect(c.status().eventsIndexed, damage).toBe(3);
      expect(requests(c), damage).toBe(3);
    }
  });

  it("keeps the previous good state when a save is interrupted before the rename", async () => {
    const e = env();
    const snapshot = path.join(e.indexDir, "index.snapshot.ndjson");
    const a = e.make();
    e.write([resp({ ts: T0 - 9000 }), resp({ ts: T0 - 8000 })]);
    await a.tick();
    await a.flush();
    const saved = fs.readFileSync(snapshot);
    e.append([resp({ ts: T0 - 7000 })]);
    await a.tick();
    instances.splice(instances.indexOf(a), 1);
    fs.writeFileSync(`${snapshot}.tmp`, saved.subarray(0, 120));             // the interrupted write
    expect(fs.readFileSync(snapshot).equals(saved)).toBe(true);
    const b = e.make();
    await b.tick();
    expect(b.status().eventsIndexed).toBe(3);
    expect(e.logs.some((m) => m.includes("unusable"))).toBe(false);
  });

  it("keeps indexing in memory when the index cannot be written, and saves once it can", async () => {
    const e = env();
    fs.writeFileSync(e.dataDir, "a file where the data directory should be");
    const a = e.make();
    e.write([resp({ ts: T0 - 9000 })]);
    await a.tick();
    await a.flush();
    expect(a.status()).toMatchObject({ state: "active", eventsIndexed: 1 });
    expect(a.status().detail).toMatch(/index not saved/);
    fs.rmSync(e.dataDir);
    e.append([resp({ ts: T0 - 8000 })]);
    await a.tick();
    await a.stop();
    expect(a.status().detail).toBeUndefined();
    const b = e.make();
    await b.tick();
    expect(b.status().eventsIndexed).toBe(2);
  });

  it("keeps the history when the configured file name changes", async () => {
    const e = env();
    const a = e.make();
    e.write([resp({ ts: T0 - 9000 }), resp({ ts: T0 - 8000 })]);
    await a.tick();
    await a.stop();
    fs.writeFileSync(path.join(e.logDir, "other_metrics.log"), text([resp({ ts: T0 - 7000 })]));
    const b = e.make({ fileName: "other_metrics.log" });
    await b.tick();
    expect(b.status()).toMatchObject({ eventsIndexed: 3, file: path.join(e.logDir, "other_metrics.log") });
  });

  it("polls and saves on its own timers, and stop() flushes", async () => {
    const e = env();
    const snapshot = path.join(e.indexDir, "index.snapshot.ndjson");
    const a = e.make({ pollMs: 10, flushMs: 30 });
    expect(() => a.start()).not.toThrow();
    a.start();                                         // idempotent
    await sleep(40);
    expect(a.status().state).toBe("waiting-for-file");
    e.write([resp({ ts: T0 - 9000 }), resp({ ts: T0 - 8000 })]);
    await until(() => a.status().eventsIndexed === 2);
    await until(() => fs.existsSync(snapshot));        // saved by the flush timer, not by stop()
    e.append([resp({ ts: T0 - 7000 })]);
    await until(() => a.status().eventsIndexed === 3);
    await a.stop();
    const b = e.make();
    await b.tick();
    expect(b.status().eventsIndexed).toBe(3);
    e.append([resp({ ts: T0 - 6000 })]);
    await sleep(60);
    expect(a.status().eventsIndexed).toBe(3);          // really stopped
    await a.stop();                                    // stopping twice is fine
  });
});

describe("gateway analytics: rollups and queries", () => {
  it("serves minute ranges and hour ranges, zero-filled and aligned to the step", async () => {
    const e = env();
    const a = e.make();
    e.write([
      resp({ ts: T0 - 10_000 }), resp({ ts: T0 - 9000 }), resp({ ts: T0 - 8000 }),      // current minute
      resp({ ts: T0 - 20 * MIN }), resp({ ts: T0 - 20 * MIN + 5 }),
      resp({ ts: T0 - 3 * HOUR }),
      resp({ ts: T0 - 2 * DAY }), resp({ ts: T0 - 2 * DAY }), resp({ ts: T0 - 2 * DAY }), resp({ ts: T0 - 2 * DAY }),  // hour buckets only
      resp({ ts: T0 - 10 * DAY }),
    ]);
    await a.tick();
    expect(a.status().eventsIndexed).toBe(11);

    const expectations: [("15m" | "1h" | "6h" | "24h" | "7d" | "30d"), number, number, number][] = [
      ["15m", 60, 15, 3], ["1h", 60, 60, 5], ["6h", 300, 72, 6], ["24h", 900, 96, 6], ["7d", 3600, 168, 10], ["30d", 21600, 120, 11],
    ];
    for (const [range, step, points, total] of expectations) {
      const s = a.summary({ range });
      const stepMs = step * 1000;
      expect(s.range).toBe(range);
      expect(s.stepSeconds, range).toBe(step);
      expect(s.series, range).toHaveLength(points);
      expect(s.from % stepMs, range).toBe(0);
      expect(s.to, range).toBe(Math.floor(T0 / stepMs) * stepMs + stepMs);
      expect(s.to - s.from, range).toBe(points * stepMs);
      expect(s.series[0].t, range).toBe(s.from);
      expect(s.series[points - 1].t, range).toBe(Math.floor(T0 / stepMs) * stepMs);       // the current, partial step
      s.series.forEach((p, i) => expect(p.t).toBe(s.from + i * stepMs));
      expect(s.totals.requests, range).toBe(total);
      expect(s.series.reduce((n, p) => n + p.requests, 0), range).toBe(total);
    }

    const hour = a.summary({ range: "1h" });
    expect(hour.series[59]).toMatchObject({ t: Math.floor(T0 / MIN) * MIN, requests: 3, s2xx: 3 });
    const twentyAgo = hour.series.find((p) => p.t === Math.floor((T0 - 20 * MIN) / MIN) * MIN);
    expect(twentyAgo?.requests).toBe(2);
    expect(hour.series.filter((p) => p.requests === 0)).toHaveLength(58);
    expect(hour.series.find((p) => p.requests === 0)).toEqual({
      t: hour.from, requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, faults: 0, throttled: 0, cacheHits: 0, avgResponseMs: 0, avgBackendMs: 0, p95Ms: 0,
    });
    const week = a.summary({ range: "7d" });
    expect(week.series.find((p) => p.t === Math.floor((T0 - 2 * DAY) / HOUR) * HOUR)?.requests).toBe(4);
    // an unknown range falls back to the last hour instead of throwing
    expect(a.summary({ range: "bogus" as never }).range).toBe("1h");
  });

  it("aggregates totals, breakdowns, statuses and error types", async () => {
    const e = env();
    const a = e.make();
    e.write([
      resp({ ts: T0 - 25_000, api: "cms", version: "v1", context: "/cms/v1", app: "portal", owner: "alice", resource: "/a", rl: 100, bl: 80 }),
      resp({ ts: T0 - 24_000, api: "cms", version: "v2", context: "/cms/v2", app: "portal", owner: "alice", resource: "/a", rl: 200, bl: 150 }),
      resp({ ts: T0 - 23_000, api: "cms", version: "v2", context: "/cms/v2", app: "mobile", owner: "bob", resource: "/b", method: "POST", status: 404, rl: 30, bl: 20 }),
      resp({ ts: T0 - 22_000, api: "cms", version: "v2", context: "/cms/v2", app: "mobile", owner: "bob", resource: "/b", method: "POST", status: 502, rl: 70, bl: 60 }),
      resp({ ts: T0 - 15_000, api: "cms", version: "v2", context: "/cms/v2", app: "portal", owner: "alice", resource: "/a", cacheHit: true, rl: 4 }),
      resp({ ts: T0 - 14_000, api: "billing", version: "v1", context: "/billing/v1", app: "portal", owner: "alice", resource: "/invoices", status: 302, rl: 10, bl: 5 }),
      fault({ ts: T0 - 13_000, api: "billing", version: "v1", context: "/billing/v1", app: "UNKNOWN", owner: "UNKNOWN", resource: "/invoices" }),
      fault({ ts: T0 - 12_000, api: "billing", version: "v1", context: "/billing/v1", app: "portal", owner: "alice", resource: "/invoices", status: 429, errorType: "THROTTLED", errorCode: 900802, errorMessage: "API_LIMIT_EXCEEDED" }),
      fault({ ts: T0 - 11_000, api: "billing", version: "v1", context: "/billing/v1", app: "portal", owner: "alice", resource: "/invoices", status: 503, errorType: "TARGET_CONNECTIVITY", errorCode: 101503, errorMessage: "CONNECTION_TIMEOUT" }),
      fault({ ts: T0 - 10_000, api: "billing", version: "v1", context: "/billing/v1", app: "portal", owner: "alice", resource: "/invoices", status: 429, errorType: "OTHER", errorCode: 900805 }),
    ]);
    await a.tick();
    const s = a.summary({ range: "15m" });
    expect(s.totals).toMatchObject({
      requests: 10, success: 4, clientErrors: 4, serverErrors: 2, faults: 4, throttled: 2, cacheHits: 1,
      avgResponseMs: 69,           // (100 + 200 + 30 + 70 + 4 + 10) / 6 responses; faults carry no latency
      avgBackendMs: 63,            // (80 + 150 + 20 + 60 + 5) / 5; the cache hit is excluded
      avgMediationMs: 5,
    });
    const point = s.series[14];
    expect(point).toMatchObject({ requests: 10, s2xx: 3, s3xx: 1, s4xx: 4, s5xx: 2, faults: 4, throttled: 2, cacheHits: 1, avgResponseMs: 69, avgBackendMs: 63 });

    expect(s.byApi.map((r) => [r.key, r.requests, r.errors])).toEqual([["billing", 5, 4], ["cms", 5, 2]]);
    const cms = s.byApi.find((r) => r.key === "cms");
    expect(cms).toMatchObject({ label: "cms", faults: 0, cacheHits: 1, share: 0.5, lastAt: T0 - 15_000, extra: { version: "v2", context: "/cms/v2" } });
    expect(cms?.avgResponseMs).toBeCloseTo((100 + 200 + 30 + 70 + 4) / 5, 1);
    expect(s.byApi.find((r) => r.key === "billing")).toMatchObject({ faults: 4, throttled: 2, lastAt: T0 - 10_000, extra: { version: "v1", context: "/billing/v1" } });

    expect(s.byApp.map((r) => [r.key, r.requests])).toEqual([["portal", 7], ["mobile", 2], ["UNKNOWN", 1]]);
    expect(s.byApp[0]).toMatchObject({ label: "portal", share: 0.7, extra: { owner: "alice" } });
    expect(s.byApp[2]).toMatchObject({ label: "UNKNOWN", errors: 1, faults: 1, extra: { owner: "UNKNOWN" } });

    expect(s.byOperation.map((r) => [r.key, r.requests])).toEqual([["billing GET /invoices", 5], ["cms GET /a", 3], ["cms POST /b", 2]]);
    expect(s.byOperation[2]).toMatchObject({ label: "POST /b", errors: 2, share: 0.2, extra: { api: "cms", method: "POST", resource: "/b" } });

    expect(s.byStatus).toEqual([
      { status: 200, requests: 3 }, { status: 429, requests: 2 }, { status: 302, requests: 1 }, { status: 401, requests: 1 },
      { status: 404, requests: 1 }, { status: 502, requests: 1 }, { status: 503, requests: 1 },
    ]);
    expect(s.byErrorType).toEqual([
      { errorType: "AUTH", requests: 1 }, { errorType: "OTHER", requests: 1 },
      { errorType: "TARGET_CONNECTIVITY", requests: 1 }, { errorType: "THROTTLED", requests: 1 },
    ]);
    expect(s.apis).toEqual(["billing", "cms"]);
    expect(s.apps).toEqual(["mobile", "portal", "UNKNOWN"]);
  });

  it("filters by API name and by application name, exactly", async () => {
    const e = env();
    const a = e.make();
    e.write([
      resp({ ts: T0 - 5000, api: "cms", app: "portal" }), resp({ ts: T0 - 4000, api: "cms", app: "mobile", status: 500 }),
      resp({ ts: T0 - 3000, api: "billing", app: "portal" }), resp({ ts: T0 - 2000, api: "cms-internal", app: "portal" }),
      fault({ ts: T0 - 1000, api: "billing", app: "mobile" }),
    ]);
    await a.tick();
    const cms = a.summary({ range: "1h", api: "cms" });
    expect(cms.totals).toMatchObject({ requests: 2, serverErrors: 1 });
    expect(cms.byApi.map((r) => r.key)).toEqual(["cms"]);
    expect(cms.byApi[0].share).toBe(1);
    expect(cms.byApp.map((r) => r.key).sort()).toEqual(["mobile", "portal"]);
    expect(cms.series.reduce((n, p) => n + p.requests, 0)).toBe(2);
    expect(cms.apis).toEqual(["billing", "cms", "cms-internal"]);          // the filter lists stay complete
    expect(cms.apps).toEqual(["mobile", "portal"]);

    expect(a.summary({ range: "1h", app: "portal" }).totals.requests).toBe(3);
    expect(a.summary({ range: "1h", api: "billing", app: "mobile" }).totals).toMatchObject({ requests: 1, faults: 1 });
    expect(a.summary({ range: "7d", api: "billing", app: "mobile" }).totals).toMatchObject({ requests: 1, faults: 1 });
    expect(a.summary({ range: "1h", api: "CMS" }).totals.requests).toBe(0);
    expect(a.summary({ range: "1h", api: "nope" }).byApi).toEqual([]);
    expect(a.summary({ range: "1h", api: "" }).totals.requests).toBe(5);   // empty filter = no filter
  });

  it("caps the rows of a bucket and folds the overflow into (other)", async () => {
    const e = env();
    const a = e.make({ maxRowsPerBucket: 3 });
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) lines.push(resp({ ts: T0 - 9000 + i, api: `api-${i}`, resource: `/r${i}`, app: `app-${i}` }));
    lines.push(resp({ ts: T0 - 5000, api: "api-0", resource: "/r0", app: "app-0" }));     // existing row still gets its own count
    lines.push(fault({ ts: T0 - 4000, api: "api-9", resource: "/r9", app: "app-9" }));
    e.write(lines);
    await a.tick();
    for (const range of ["1h", "7d"] as const) {
      const s = a.summary({ range });
      expect(s.totals).toMatchObject({ requests: 8, faults: 1 });
      expect(s.byApi.map((r) => [r.key, r.requests])).toEqual([["(other)", 4], ["api-0", 2], ["api-1", 1], ["api-2", 1]]);
      expect(s.byApp.map((r) => r.key)).toEqual(["(other)", "app-0", "app-1", "app-2"]);
      expect(s.byOperation[0]).toMatchObject({ key: "(other)", label: "(other)", requests: 4, faults: 1, extra: { api: "(other)", resource: "(other)" } });
      expect(s.byOperation).toHaveLength(4);
      expect(s.apis).toEqual(["api-0", "api-1", "api-2"]);
      expect(a.summary({ range, api: "(other)" }).totals.requests).toBe(4);
    }
    await a.stop();
    const b = e.make({ maxRowsPerBucket: 3 });
    await b.tick();
    expect(b.summary({ range: "1h" }).byApi.map((r) => [r.key, r.requests])).toEqual([["(other)", 4], ["api-0", 2], ["api-1", 1], ["api-2", 1]]);
  });

  it("prunes minute buckets after their retention and hour buckets after theirs", async () => {
    const e = env();
    const a = e.make();
    e.write([resp({ ts: T0 - 1000, api: "old-api", app: "old-app" }), resp({ ts: T0 - 500, api: "old-api", app: "old-app" })]);
    await a.tick();
    expect(requests(a, "24h")).toBe(2);
    expect(a.status().oldestAt).toBe(new Date(Math.floor(T0 / HOUR) * HOUR).toISOString());

    e.now = T0 + 25 * HOUR;
    await a.tick();
    expect(a.status().oldestAt).toBe(new Date(Math.floor(T0 / HOUR) * HOUR).toISOString());   // minute bucket still inside 26 h

    e.now = T0 + 27 * HOUR;
    e.append([resp({ ts: e.now - 1000, api: "new-api", app: "new-app" })]);
    await a.tick();
    expect(requests(a, "24h")).toBe(1);
    expect(requests(a, "7d")).toBe(3);
    expect(a.summary({ range: "7d" }).apis).toEqual(["new-api", "old-api"]);
    await a.stop();

    // pruning also applies to what is loaded from disk
    e.now = T0 + 93 * DAY;
    const b = e.make();
    await b.tick();
    expect(requests(b, "30d")).toBe(0);
    expect(b.status()).toMatchObject({ oldestAt: null, eventsIndexed: 3 });
    expect(b.summary({ range: "30d" }).apis).toEqual([]);
    expect(b.summary({ range: "30d" }).apps).toEqual([]);

    const c = e.make({ minuteRetentionHours: 1, hourRetentionDays: 1 });
    e.now = T0 + 93 * DAY + HOUR;
    e.append([resp({ ts: e.now - 30 * MIN }), resp({ ts: e.now - 90 * MIN }), resp({ ts: e.now - 30 * HOUR })]);
    await b.stop();
    await c.tick();
    expect(requests(c, "1h")).toBe(1);
    expect(requests(c, "24h")).toBe(1);               // the 90 minute old event only went to an hour bucket
    expect(requests(c, "7d")).toBe(2);
  });

  it("drops events older than everything retained and buckets far-future events at now", async () => {
    const e = env();
    const a = e.make();
    e.write([
      resp({ ts: T0 - 91 * DAY, corr: "ancient" }),
      resp({ ts: T0 - 30 * HOUR, corr: "yesterday" }),          // too old for minutes, fine for hours
      resp({ ts: T0 + 2 * MIN, corr: "slightly-ahead" }),       // clock skew: kept at its own time
      resp({ ts: T0 + 3 * HOUR, corr: "far-future" }),
      resp({ ts: T0 - 5 * MIN, corr: "late" }),                 // out of order
    ]);
    await a.tick();
    expect(a.status()).toMatchObject({ eventsIndexed: 4, linesSkipped: 1 });
    expect(a.status().lastEventAt).toBe(new Date(T0 + 2 * MIN).toISOString());
    expect(requests(a, "24h")).toBe(2);               // far-future (at now) + late; slightly-ahead is beyond the current step
    expect(requests(a, "7d")).toBe(4);
    const cur = a.summary({ range: "15m" }).series[14];
    expect(cur.requests).toBe(1);
    expect(a.recent({ correlationId: "far-future" }).rows[0].ts).toBe(T0);
    e.now = T0 + 3 * MIN;
    expect(requests(a, "15m")).toBe(3);
  });

  it("estimates percentiles from the histogram within the bucket that holds them", async () => {
    const e = env();
    const a = e.make();
    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) lines.push(resp({ ts: T0 - i * 100, rl: i, bl: Math.max(1, i - 1) }));
    e.write(lines);
    await a.tick();
    const s = a.summary({ range: "1h" });
    const t = s.totals;
    expect(t.avgResponseMs).toBe(50.5);
    expect(t.p50Ms).toBeGreaterThan(25);
    expect(t.p50Ms).toBeLessThanOrEqual(50);
    expect(t.p95Ms).toBeGreaterThan(50);
    expect(t.p95Ms).toBeLessThanOrEqual(100);
    expect(Math.abs(t.p95Ms - 95)).toBeLessThanOrEqual(5);
    expect(t.p99Ms).toBeGreaterThanOrEqual(t.p95Ms);
    expect(t.p99Ms).toBeLessThanOrEqual(100);         // never above the largest value seen
    expect(t.p50Ms).toBeLessThanOrEqual(t.p95Ms);
    expect(t.backendP50Ms).toBeGreaterThan(25);
    expect(t.backendP50Ms).toBeLessThanOrEqual(50);
    expect(t.backendP95Ms).toBeLessThanOrEqual(99);
    expect(s.byApi[0].p95Ms).toBe(t.p95Ms);
    expect(a.lastHourByApi()["cms-proc-api"].p95Ms).toBe(t.p95Ms);

    expect(s.latencyHistogram.map((h) => [h.leMs, h.label, h.response])).toEqual([
      [5, "≤ 5 ms", 5], [10, "≤ 10 ms", 5], [25, "≤ 25 ms", 15], [50, "≤ 50 ms", 25], [100, "≤ 100 ms", 50], [250, "≤ 250 ms", 0],
      [500, "≤ 500 ms", 0], [1000, "≤ 1 s", 0], [2500, "≤ 2.5 s", 0], [5000, "≤ 5 s", 0], [10000, "≤ 10 s", 0], [null, "> 10 s", 0],
    ]);
    expect(s.latencyHistogram.reduce((n, h) => n + h.backend, 0)).toBe(100);
    expect(s.latencyHistogram[0].backend).toBe(6);    // backend latencies 1,1,2,3,4,5

    // a single slow outlier lands in the open-ended bucket and is reported as itself
    e.append([resp({ ts: T0 - 50, api: "slow", rl: 42_000, bl: 41_000 }), resp({ ts: T0 - 40, api: "hit", cacheHit: true, rl: 3 }), fault({ ts: T0 - 30, api: "hit" })]);
    await a.tick();
    const slow = a.summary({ range: "1h", api: "slow" });
    expect(slow.totals.p50Ms).toBeGreaterThan(10_000);          // interpolated between the last bound and the largest value seen
    expect(slow.totals.p50Ms).toBeLessThanOrEqual(42_000);
    expect(slow.totals.p99Ms).toBeGreaterThan(slow.totals.p50Ms);
    expect(slow.totals.p99Ms).toBeLessThanOrEqual(42_000);
    expect(slow.totals.backendP95Ms).toBeLessThanOrEqual(41_000);
    expect(slow.totals.avgResponseMs).toBe(42_000);
    expect(slow.latencyHistogram[11]).toEqual({ leMs: null, label: "> 10 s", response: 1, backend: 1 });
    const hit = a.summary({ range: "1h", api: "hit" });
    expect(hit.totals).toMatchObject({ requests: 2, cacheHits: 1, faults: 1, avgResponseMs: 3, avgBackendMs: 0, backendP50Ms: 0, p95Ms: 3 });
    expect(hit.latencyHistogram.reduce((n, h) => n + h.response, 0)).toBe(1);   // the fault carries no latency
    expect(hit.latencyHistogram.reduce((n, h) => n + h.backend, 0)).toBe(0);
  });

  it("answers recent() with filters, search, limit and totals", async () => {
    const e = env();
    const a = e.make();
    e.write([
      resp({ ts: T0 - 9000, api: "cms", app: "portal", corr: "AAA-111", user: "alice@carbon.super", ip: "10.1.1.1", resource: "/descriptions/{type}" }),
      resp({ ts: T0 - 8000, api: "cms", app: "mobile", corr: "bbb-222", status: 404, user: "bob@carbon.super", ip: "10.2.2.2", agent: "okhttp/4.9" }),
      resp({ ts: T0 - 7000, api: "billing", app: "portal", corr: "ccc-333", status: 500, context: "/billing/v1", method: "POST" }),
      fault({ ts: T0 - 6000, api: "billing", app: "UNKNOWN", corr: "ddd-444" }),
      fault({ ts: T0 - 5000, api: "cms", app: "portal", corr: "eee-555", status: 429, errorType: "THROTTLED", errorCode: 900802, errorMessage: "API_LIMIT_EXCEEDED" }),
      resp({ ts: T0 - 9500, api: "cms", app: "portal", corr: "fff-666" }),                  // logged late: older than the first line
    ]);
    await a.tick();
    const ids = (q: Parameters<typeof a.recent>[0]): string[] => a.recent(q).rows.map((r) => r.correlationId);

    expect(a.recent({})).toMatchObject({ total: 6, kept: 6 });
    expect(ids({})).toEqual(["eee-555", "ddd-444", "ccc-333", "bbb-222", "AAA-111", "fff-666"]);   // newest first by event time
    expect(ids({ status: "all" })).toHaveLength(6);
    expect(a.recent({ limit: 2 })).toMatchObject({ total: 6, kept: 6 });
    expect(ids({ limit: 2 })).toEqual(["eee-555", "ddd-444"]);
    expect(ids({ limit: 0 })).toHaveLength(1);
    expect(ids({ limit: 99_999 })).toHaveLength(6);

    expect(ids({ api: "billing" })).toEqual(["ddd-444", "ccc-333"]);
    expect(ids({ app: "portal" })).toEqual(["eee-555", "ccc-333", "AAA-111", "fff-666"]);
    expect(ids({ api: "cms", app: "portal", status: "2xx" })).toEqual(["AAA-111", "fff-666"]);
    expect(ids({ status: "2xx" })).toEqual(["AAA-111", "fff-666"]);
    expect(ids({ status: "4xx" })).toEqual(["eee-555", "ddd-444", "bbb-222"]);
    expect(ids({ status: "5xx" })).toEqual(["ccc-333"]);
    expect(ids({ status: "fault" })).toEqual(["eee-555", "ddd-444"]);
    expect(ids({ status: "throttled" })).toEqual(["eee-555"]);

    expect(ids({ correlationId: "aaa-111" })).toEqual(["AAA-111"]);        // exact, case-insensitive
    expect(ids({ correlationId: "aaa" })).toEqual([]);
    expect(ids({ search: "AAA" })).toEqual(["AAA-111"]);
    expect(ids({ search: "bob@" })).toEqual(["bbb-222"]);
    expect(ids({ search: "10.1.1" })).toEqual(["AAA-111"]);
    expect(ids({ search: "OKHTTP" })).toEqual(["bbb-222"]);
    expect(ids({ search: "/billing/" })).toEqual(["ccc-333"]);
    expect(ids({ search: "post" })).toEqual(["ccc-333"]);
    expect(ids({ search: "404" })).toEqual(["bbb-222"]);
    expect(ids({ search: "throttled" })).toEqual(["eee-555"]);
    expect(ids({ search: "api_limit" })).toEqual(["eee-555"]);
    expect(ids({ search: "authentication_failure" })).toEqual(["ddd-444"]);
    expect(ids({ search: "unknown" })).toEqual(["ddd-444"]);
    expect(ids({ search: "{type}", api: "cms" })).toHaveLength(4);
    expect(ids({ search: "no such thing" })).toEqual([]);
    expect(a.recent({ search: "portal", limit: 1 })).toMatchObject({ total: 4, kept: 6 });
  });

  it("keeps only the newest recentMax events in memory", async () => {
    const e = env();
    const a = e.make({ recentMax: 5 });
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) lines.push(resp({ ts: T0 - (12 - i) * 1000, corr: `c-${i}` }));
    e.write(lines);
    await a.tick();
    expect(a.recent({})).toMatchObject({ total: 5, kept: 5 });
    expect(a.recent({}).rows.map((r) => r.correlationId)).toEqual(["c-11", "c-10", "c-9", "c-8", "c-7"]);
    expect(a.status().eventsIndexed).toBe(12);
  });

  it("summarises the last 60 minutes per API name", async () => {
    const e = env();
    const a = e.make();
    e.write([
      resp({ ts: T0 - 1000, api: "cms", version: "v1", rl: 10 }), resp({ ts: T0 - 30 * MIN, api: "cms", version: "v2", rl: 30, status: 500 }),
      fault({ ts: T0 - 59 * MIN, api: "cms" }),
      resp({ ts: T0 - 61 * MIN, api: "cms", rl: 1000 }),                                  // outside the window
      resp({ ts: T0 - 2 * HOUR, api: "stale" }),
      resp({ ts: T0 - 2000, api: "__proto__", rl: 7 }),
    ]);
    await a.tick();
    const h = a.lastHourByApi();
    expect(Object.keys(h).sort()).toEqual(["__proto__", "cms"]);
    expect(h.cms).toEqual({ requests: 3, errors: 2, avgMs: 20, p95Ms: h.cms.p95Ms, lastAt: T0 - 1000 });
    expect(h.cms.p95Ms).toBeGreaterThan(10);
    expect(h.cms.p95Ms).toBeLessThanOrEqual(30);
    expect(h["__proto__"]).toMatchObject({ requests: 1, errors: 0, avgMs: 7 });
    expect(JSON.parse(JSON.stringify(h)).cms.requests).toBe(3);
  });

  it("never passes event contents to the log callback", async () => {
    const e = env();
    const a = e.make();
    e.write([resp({ ts: T0 - 1000, user: "secret-user@carbon.super", ip: "203.0.113.77", corr: "corr-secret" })]);
    await a.tick();
    fs.renameSync(e.file, path.join(e.logDir, "apim_metrics-1.log"));
    e.write([fault({ ts: T0 - 500, user: "secret-user@carbon.super", ip: "203.0.113.77", corr: "corr-secret" })]);
    await a.tick();
    fs.truncateSync(e.file, 0);
    await a.tick();
    await a.stop();
    expect(e.logs.length).toBeGreaterThan(0);
    for (const m of e.logs) {
      expect(m).not.toMatch(/secret-user|203\.0\.113\.77|corr-secret/);
      expect(m.length).toBeLessThan(400);
    }
  });
});
