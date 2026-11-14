// Tolerant parser for one line of WSO2 API Manager's apim_metrics.log (ELK reporter).
//
// The log4j2 prefix differs between installs (time only, full date, "TID: [-1234] [...]"), so it is
// ignored completely: we look for the marker `apimMetrics:`, then the event name (`apim:response`
// or `apim:faulty`), then `properties :` (any spacing) and a JSON object that runs to the end of
// the line. Anything else (startup noise, stack traces, truncated JSON) yields null.
import type { GwEvent } from "./types.js";

const MARKER = "apimMetrics:";
const HEAD = /^\s*apim:([A-Za-z_-]+)\s*,\s*properties\s*:\s*(?=\{)/;
const MAX_LATENCY_MS = 86_400_000; // a day; anything larger is garbage and would poison the sums

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, max = 256): string {
  let s: string;
  if (typeof v === "string") s = v;
  else if (typeof v === "number" || typeof v === "boolean") s = String(v);
  else return "";
  return s.length > max ? s.slice(0, max) : s;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function latency(v: unknown): number {
  const n = num(v);
  if (n === undefined || n <= 0) return 0;
  return n > MAX_LATENCY_MS ? MAX_LATENCY_MS : n;
}

function bool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  return v === 1;
}

function epochMs(n: number): number | undefined {
  if (n >= 1e11 && n < 1e14) return Math.trunc(n);          // epoch milliseconds
  if (n >= 1e9 && n < 1e11) return Math.trunc(n * 1000);    // epoch seconds
  return undefined;
}

function timestamp(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return epochMs(v) ?? fallback;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^\d{10,14}$/.test(t)) return epochMs(Number(t)) ?? fallback;
    const ms = Date.parse(t);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return fallback;
}

function parseObject(text: string): Json | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    // Tolerate junk after the closing brace; a truncated object has no usable closing brace and fails again.
    const last = text.lastIndexOf("}");
    if (last <= 0 || last === text.length - 1) return null;
    try {
      v = JSON.parse(text.slice(0, last + 1));
    } catch {
      return null;
    }
  }
  return isObj(v) ? v : null;
}

function parseAt(line: string, from: number, nowMs: number | undefined): GwEvent | null {
  const rest = line.slice(from);
  const m = HEAD.exec(rest);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const type: GwEvent["type"] | null = name === "response" ? "response" : name === "faulty" || name === "fault" ? "fault" : null;
  if (!type) return null;
  const o = parseObject(rest.slice(m[0].length).trimEnd());
  if (!o) return null;
  const nested: Json = isObj(o.properties) ? o.properties : {};

  const errorType = str(o.errorType, 64);
  const rawCode = num(o.errorCode);
  const errorCode = rawCode === undefined ? null : Math.trunc(rawCode);
  const rawStatus = num(o.proxyResponseCode);
  const status = rawStatus === undefined || rawStatus < 0 ? 0 : Math.trunc(rawStatus);
  const rawTarget = num(o.targetResponseCode);
  const targetStatus = rawTarget === undefined || rawTarget <= 0 ? null : Math.trunc(rawTarget);
  const throttled = type === "fault"
    && (errorType.toUpperCase() === "THROTTLED" || (errorCode !== null && errorCode >= 900800 && errorCode <= 900899));

  return {
    ts: timestamp(o.requestTimestamp, nowMs ?? Date.now()),
    type,
    api: str(o.apiName),
    version: str(o.apiVersion),
    context: str(o.apiContext) || str(nested.apiContext),
    method: str(o.apiMethod, 32),
    resource: str(o.apiResourceTemplate),
    app: str(o.applicationName),
    appOwner: str(o.applicationOwner),
    user: str(o.userName) || str(nested.userName),
    keyType: str(o.keyType, 32),
    status,
    targetStatus,
    responseLatency: latency(o.responseLatency),
    backendLatency: latency(o.backendLatency),
    requestMediationLatency: latency(o.requestMediationLatency),
    responseMediationLatency: latency(o.responseMediationLatency),
    cacheHit: type === "response" && bool(o.responseCacheHit),
    throttled,
    errorType,
    errorCode,
    errorMessage: str(o.errorMessage, 512),
    userAgent: str(o.userAgent, 512),
    userIp: str(o.userIp, 64),
    correlationId: str(o.correlationId, 128),
    gatewayType: str(o.gatewayType, 64),
    platform: str(o.platform, 64),
    destination: str(o.destination, 1024),
  };
}

/**
 * Parses one log line into a normalised event, or returns null when the line is not an analytics
 * event (or is damaged). Pure and never throws. `nowMs` is only used when the event carries no
 * usable requestTimestamp (defaults to Date.now()).
 */
export function parseMetricsLine(line: string, nowMs?: number): GwEvent | null {
  try {
    if (typeof line !== "string" || line.length < MARKER.length) return null;
    let at = line.indexOf(MARKER);
    while (at >= 0) {
      const ev = parseAt(line, at + MARKER.length, nowMs);
      if (ev) return ev;
      at = line.indexOf(MARKER, at + MARKER.length);
    }
    return null;
  } catch {
    return null;
  }
}
