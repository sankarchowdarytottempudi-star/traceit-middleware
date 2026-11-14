// Rollup rows: the per-(api, version, context, app, appOwner, method, resource) aggregate kept in
// every minute and hour bucket, the accumulator used to merge rows at query time, and the compact
// array encoding used on disk.
//
// Memory matters here (thousands of buckets, each with up to a few hundred rows), so the seven
// dimension strings of a row live once in a shared Dim object, and the per-status, per-error-type
// and histogram counts are small flat [key, count, key, count, ...] arrays instead of maps.
import type { GwEvent } from "./types.js";

/** Upper bounds (ms, inclusive) of the latency histogram; one more bucket above the last collects the rest. */
export const LATENCY_BOUNDS_MS: readonly number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
export const HIST_SIZE = LATENCY_BOUNDS_MS.length + 1;
/** Name used for the overflow row once a bucket holds the maximum number of distinct rows. */
export const OTHER = "(other)";

const SEP = "\u0001";
const MAX_STATUSES_PER_ROW = 32;
const MAX_ERROR_TYPES_PER_ROW = 16;

/** One combination of dimensions, shared by every row (in any bucket) that has it. */
export interface Dim {
  readonly key: string;
  readonly api: string; readonly version: string; readonly context: string;
  readonly app: string; readonly appOwner: string;
  readonly method: string; readonly resource: string;
  readonly op: string;                          // byOperation key: `${api} ${method} ${resource}`
  readonly other: boolean;                      // the overflow combination
}

export class DimPool {
  private map = new Map<string, Dim>();
  /** Changes whenever a combination is added or dropped (lets callers cache what they derive from the pool). */
  version = 0;
  readonly other: Dim = this.get(OTHER, "", "", OTHER, "", "", OTHER);

  get(api: string, version: string, context: string, app: string, appOwner: string, method: string, resource: string): Dim {
    const key = api + SEP + version + SEP + context + SEP + app + SEP + appOwner + SEP + method + SEP + resource;
    let d = this.map.get(key);
    if (!d) {
      const other = api === OTHER && app === OTHER && resource === OTHER && version === "" && context === "" && appOwner === "" && method === "";
      d = { key, api, version, context, app, appOwner, method, resource, op: other ? OTHER : `${api} ${method} ${resource}`, other };
      this.map.set(key, d);
      this.version++;
    }
    return d;
  }
  forEvent(ev: GwEvent): Dim {
    return this.get(ev.api, ev.version, ev.context, ev.app, ev.appOwner, ev.method, ev.resource);
  }
  values(): IterableIterator<Dim> { return this.map.values(); }
  get size(): number { return this.map.size; }
  /** Forgets one combination (used when a new one turned out to be folded into the overflow row everywhere). */
  discard(d: Dim): void {
    if (d !== this.other && this.map.delete(d.key)) this.version++;
  }
  /** Drops every combination that is not in `live` (the overflow combination always stays). */
  retain(live: Set<Dim>): void {
    let dropped = 0;
    for (const [key, d] of this.map) {
      if (d !== this.other && !live.has(d)) { this.map.delete(key); dropped++; }
    }
    if (dropped > 0) this.version++;
  }
}

export interface Row {
  d: Dim;
  n: number;                                    // requests
  c2: number; c3: number; c4: number; c5: number; // status classes (5 = 500 and above)
  f: number; th: number; ch: number;            // faults, throttled, cache hits
  ln: number; sr: number;                       // events carrying latency (responses), sum of responseLatency
  bn: number; sb: number;                       // responses that reached the backend (no cache hit), sum of backendLatency
  sm: number;                                   // sum of request + response mediation latency
  mx: number; mxb: number;                      // max responseLatency / backendLatency
  la: number;                                   // newest event time, epoch ms
  st: number[];                                 // exact per-status counts: [status, count, ...]
  et: (string | number)[] | null;               // per-errorType counts: [errorType, count, ...]
  hr: number[] | null; hb: number[] | null;     // latency histograms (response, backend): [bucketIndex, count, ...]
}
export type Bucket = Map<Dim, Row>;

export function histIndex(ms: number): number {
  for (let i = 0; i < LATENCY_BOUNDS_MS.length; i++) if (ms <= LATENCY_BOUNDS_MS[i]) return i;
  return LATENCY_BOUNDS_MS.length;
}

function newRow(d: Dim): Row {
  return { d, n: 0, c2: 0, c3: 0, c4: 0, c5: 0, f: 0, th: 0, ch: 0, ln: 0, sr: 0, bn: 0, sb: 0, sm: 0, mx: 0, mxb: 0, la: 0, st: [], et: null, hr: null, hb: null };
}

/** Increments `key` in a flat [key, count, ...] list; once `max` keys exist, new ones count under `overflow`. */
function bump<K extends string | number>(pairs: K[] | (string | number)[], key: K, max: number, overflow: K): void {
  const p = pairs as (string | number)[];
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] === key) { (p[i + 1] as number)++; return; }
  }
  if (p.length < max * 2 || key === overflow) { p.push(key, 1); return; }
  bump(p, overflow, max, overflow);
}

function apply(row: Row, ev: GwEvent, ts: number): void {
  row.n++;
  const s = ev.status;
  if (s >= 500) row.c5++;
  else if (s >= 400) row.c4++;
  else if (s >= 300) row.c3++;
  else if (s >= 200) row.c2++;
  bump(row.st, s, MAX_STATUSES_PER_ROW, 0);
  if (ev.type === "fault") {
    row.f++;
    if (ev.throttled) row.th++;
    bump((row.et ??= []), ev.errorType || "OTHER", MAX_ERROR_TYPES_PER_ROW, "OTHER");
  } else {
    if (ev.errorType) bump((row.et ??= []), ev.errorType, MAX_ERROR_TYPES_PER_ROW, "OTHER");
    row.ln++;
    row.sr += ev.responseLatency;
    row.sm += ev.requestMediationLatency + ev.responseMediationLatency;
    if (ev.responseLatency > row.mx) row.mx = ev.responseLatency;
    bump((row.hr ??= []), histIndex(ev.responseLatency), HIST_SIZE, HIST_SIZE - 1);
    if (ev.cacheHit) row.ch++;
    else {
      row.bn++;
      row.sb += ev.backendLatency;
      if (ev.backendLatency > row.mxb) row.mxb = ev.backendLatency;
      bump((row.hb ??= []), histIndex(ev.backendLatency), HIST_SIZE, HIST_SIZE - 1);
    }
  }
  if (ts > row.la) row.la = ts;
}

/**
 * Adds an event to a bucket and returns the row it landed in. Once the bucket holds `maxRows`
 * distinct rows, events for new combinations are folded into the "(other)" row.
 */
export function addToBucket(bucket: Bucket, dim: Dim, other: Dim, ev: GwEvent, ts: number, maxRows: number): Row {
  let row = bucket.get(dim);
  if (!row) {
    const overflow = bucket.get(other);
    if (dim !== other && bucket.size - (overflow ? 1 : 0) >= maxRows) {
      row = overflow;
      if (!row) {
        row = newRow(other);
        bucket.set(other, row);
      }
    } else {
      row = newRow(dim);
      bucket.set(dim, row);
    }
  }
  apply(row, ev, ts);
  return row;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Estimates a percentile (p in 0..1) from a fixed-boundary histogram by linear interpolation
 * inside the bucket that holds the rank. This is an estimate: it is only as precise as that
 * bucket is narrow, and it is clamped to the largest value actually observed.
 */
export function percentile(hist: readonly number[], p: number, maxSeen: number): number {
  let total = 0;
  for (const c of hist) total += c;
  if (total <= 0) return 0;
  const rank = p * total;
  let cum = 0;
  for (let i = 0; i < hist.length; i++) {
    const c = hist[i];
    if (!c) continue;
    if (cum + c >= rank) {
      const lo = i === 0 ? 0 : LATENCY_BOUNDS_MS[i - 1];
      const hi = i < LATENCY_BOUNDS_MS.length ? LATENCY_BOUNDS_MS[i] : Math.max(maxSeen, lo);
      const v = lo + (hi - lo) * Math.max(0, (rank - cum) / c);
      return round1(Math.min(v, maxSeen));
    }
    cum += c;
  }
  return round1(maxSeen);
}

/** Query-time accumulator: rows from any number of buckets merge into one of these. */
export class Agg {
  n = 0; c2 = 0; c3 = 0; c4 = 0; c5 = 0; f = 0; th = 0; ch = 0;
  ln = 0; sr = 0; bn = 0; sb = 0; sm = 0; mx = 0; mxb = 0; la = 0;
  hr: number[] = new Array<number>(HIST_SIZE).fill(0);
  hb: number[] = new Array<number>(HIST_SIZE).fill(0);

  add(r: Row): void {
    this.n += r.n; this.c2 += r.c2; this.c3 += r.c3; this.c4 += r.c4; this.c5 += r.c5;
    this.f += r.f; this.th += r.th; this.ch += r.ch;
    this.ln += r.ln; this.sr += r.sr; this.bn += r.bn; this.sb += r.sb; this.sm += r.sm;
    if (r.mx > this.mx) this.mx = r.mx;
    if (r.mxb > this.mxb) this.mxb = r.mxb;
    if (r.la > this.la) this.la = r.la;
    const hr = r.hr;
    if (hr) for (let i = 0; i < hr.length; i += 2) this.hr[hr[i]] += hr[i + 1];
    const hb = r.hb;
    if (hb) for (let i = 0; i < hb.length; i += 2) this.hb[hb[i]] += hb[i + 1];
  }
  get errors(): number { return this.c4 + this.c5; }
  get avgResponse(): number { return this.ln ? round1(this.sr / this.ln) : 0; }
  get avgBackend(): number { return this.bn ? round1(this.sb / this.bn) : 0; }
  get avgMediation(): number { return this.ln ? round1(this.sm / this.ln) : 0; }
  pResponse(p: number): number { return percentile(this.hr, p, this.mx); }
  pBackend(p: number): number { return percentile(this.hb, p, this.mxb); }
}

// ---------------------------------------------------------------------------------------------
// On-disk encoding. A row is a positional array of ROW_LEN items:
//   0-6   api, version, context, app, appOwner, method, resource
//   7-22  n, c2, c3, c4, c5, f, th, ch, ln, sr, bn, sb, sm, mx, mxb, la
//   23    [status, count, ...]            24  [errorType, count, ...] or 0
//   25    response histogram [bucketIndex, count, ...] or 0      26  backend histogram, same

const ROW_LEN = 27;

export function rowToJson(r: Row): unknown[] {
  const d = r.d;
  return [
    d.api, d.version, d.context, d.app, d.appOwner, d.method, d.resource,
    r.n, r.c2, r.c3, r.c4, r.c5, r.f, r.th, r.ch, r.ln, r.sr, r.bn, r.sb, r.sm, r.mx, r.mxb, r.la,
    r.st, r.et ?? 0, r.hr ?? 0, r.hb ?? 0,
  ];
}

function reqStr(v: unknown): string {
  if (typeof v !== "string") throw new Error("row: expected a string");
  return v;
}
function reqNum(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error("row: expected a non-negative number");
  return v;
}
function reqPairs(v: unknown, maxPairs: number): unknown[] | null {
  if (v === 0 || v === null) return null;
  if (!Array.isArray(v) || v.length % 2 !== 0 || v.length > maxPairs * 2) throw new Error("row: bad count list");
  for (let i = 1; i < v.length; i += 2) reqNum(v[i]);
  return v;
}
function reqHist(v: unknown): number[] | null {
  const p = reqPairs(v, HIST_SIZE);
  if (!p) return null;
  for (let i = 0; i < p.length; i += 2) {
    const idx = p[i];
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= HIST_SIZE) throw new Error("row: bad histogram bucket");
  }
  return p as number[];
}

export function rowFromJson(v: unknown, pool: DimPool): Row {
  if (!Array.isArray(v) || v.length < ROW_LEN) throw new Error("row: bad shape");
  const r = newRow(pool.get(reqStr(v[0]), reqStr(v[1]), reqStr(v[2]), reqStr(v[3]), reqStr(v[4]), reqStr(v[5]), reqStr(v[6])));
  r.n = reqNum(v[7]); r.c2 = reqNum(v[8]); r.c3 = reqNum(v[9]); r.c4 = reqNum(v[10]); r.c5 = reqNum(v[11]);
  r.f = reqNum(v[12]); r.th = reqNum(v[13]); r.ch = reqNum(v[14]);
  r.ln = reqNum(v[15]); r.sr = reqNum(v[16]); r.bn = reqNum(v[17]); r.sb = reqNum(v[18]); r.sm = reqNum(v[19]);
  r.mx = reqNum(v[20]); r.mxb = reqNum(v[21]); r.la = reqNum(v[22]);
  const st = reqPairs(v[23], MAX_STATUSES_PER_ROW + 1) ?? [];
  for (let i = 0; i < st.length; i += 2) if (typeof st[i] !== "number" || !Number.isFinite(st[i])) throw new Error("row: bad status");
  r.st = st as number[];
  const et = reqPairs(v[24], MAX_ERROR_TYPES_PER_ROW + 1);
  if (et) for (let i = 0; i < et.length; i += 2) reqStr(et[i]);
  r.et = et as (string | number)[] | null;
  r.hr = reqHist(v[25]);
  r.hb = reqHist(v[26]);
  return r;
}

export function bucketToJson(b: Bucket): unknown[] {
  const rows: unknown[] = [];
  for (const r of b.values()) rows.push(rowToJson(r));
  return rows;
}

export function bucketFromJson(v: unknown, pool: DimPool): Bucket {
  if (!Array.isArray(v)) throw new Error("bucket: bad shape");
  const b: Bucket = new Map();
  for (const item of v) {
    const r = rowFromJson(item, pool);
    b.set(r.d, r);
  }
  return b;
}
