// Server-side validation and plain-words helpers for the gateway rules screens.
// Everything here is pure (no I/O) so it is unit-tested directly.
import { z } from "zod";

export class BadInput extends Error {
  statusCode = 400;
  constructor(message: string, public field?: string) { super(message); }
}
export const bad = (message: string, field?: string): never => { throw new BadInput(message, field); };

export const UNLIMITED = 2147483647;
// API Manager refuses dashes, dots and spaces in policy names
export const POLICY_NAME = /^[A-Za-z0-9][A-Za-z0-9_]{0,59}$/;
export const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,69}$/;
export const TIME_UNITS = ["sec", "min", "hour", "day"] as const;
export type TimeUnit = (typeof TIME_UNITS)[number];
const UNIT_WORD: Record<string, string> = { sec: "second", min: "minute", hour: "hour", day: "day", ms: "millisecond" };

export function unitWord(u: string): string { return UNIT_WORD[u] ?? u; }

/** "100 requests per minute" (unitTime 1) or "1,000 requests every 5 minutes". */
export function rateWords(limit: number, timeUnit: string, unitTime = 1): string {
  if (limit >= UNLIMITED || limit < 0) return "no limit";
  const n = limit.toLocaleString("en-US");
  const w = unitWord(timeUnit);
  return unitTime > 1 ? `${n} requests every ${unitTime} ${w}s` : `${n} ${limit === 1 ? "request" : "requests"} per ${w}`;
}

// ---------- traffic limits ----------
export const TrafficInput = z.object({
  tiers: z.array(z.string()).max(30),
  apiPolicy: z.string().nullable(),
  operations: z.array(z.object({ verb: z.string(), target: z.string(), policy: z.string().nullable() })).max(500),
  environments: z.array(z.string()).max(20).optional(),
});
export type TTrafficInput = z.infer<typeof TrafficInput>;

export interface KnownPolicies { subscription: string[]; advanced: string[]; }

/** Checks a traffic change against the API's operations and the policies that exist. Returns the normalised input. */
export function checkTraffic(raw: unknown, ops: { verb: string; target: string }[], known: KnownPolicies): TTrafficInput {
  const p = TrafficInput.safeParse(raw);
  if (!p.success) bad(`Traffic limits are not in the expected shape: ${p.error.issues[0]?.path.join(".") || "body"} ${p.error.issues[0]?.message ?? ""}`.trim());
  const v = p.data!;
  const tiers = [...new Set(v.tiers.map((t) => t.trim()).filter(Boolean))];
  if (!tiers.length) bad("Pick at least one plan consumers can subscribe with. Without a plan nobody can subscribe to this API.", "tiers");
  for (const t of tiers) if (!known.subscription.includes(t)) bad(`Plan "${t}" does not exist. Create it first, then assign it.`, "tiers");
  const apiPolicy = v.apiPolicy && v.apiPolicy.trim() ? v.apiPolicy.trim() : null;
  if (apiPolicy && !known.advanced.includes(apiPolicy)) bad(`Limit "${apiPolicy}" does not exist. Create it first, then assign it.`, "apiPolicy");
  const key = (o: { verb: string; target: string }) => `${o.verb.toUpperCase()} ${o.target}`;
  const existing = new Set(ops.map(key));
  const seen = new Set<string>();
  const operations = v.operations.map((o) => {
    const k = key(o);
    if (!existing.has(k)) bad(`Operation ${k} is not part of this API. Operations are changed in the API definition, not here.`, "operations");
    if (seen.has(k)) bad(`Operation ${k} is listed twice.`, "operations");
    seen.add(k);
    const policy = o.policy && o.policy.trim() ? o.policy.trim() : null;
    if (policy && policy !== "Unlimited" && !known.advanced.includes(policy)) bad(`Limit "${policy}" for ${k} does not exist. Create it first.`, "operations");
    return { verb: o.verb.toUpperCase(), target: o.target, policy };
  });
  if (apiPolicy && operations.some((o) => o.policy && o.policy !== "Unlimited"))
    bad("Choose either one limit for the whole API or limits per operation. API Manager ignores per-operation limits while a whole-API limit is set.", "operations");
  const environments = v.environments ? [...new Set(v.environments.map((e) => e.trim()).filter(Boolean))] : undefined;
  return { tiers, apiPolicy, operations, environments };
}

// ---------- access: security, CORS, address rules ----------
export const SECURITY = ["oauth2", "apikey", "both", "none"] as const;
export type Security = (typeof SECURITY)[number];
export const AccessInput = z.object({
  security: z.enum(SECURITY),
  cors: z.object({
    enabled: z.boolean(),
    origins: z.array(z.string()).max(50),
    headers: z.array(z.string()).max(50),
    methods: z.array(z.string()).max(10),
    credentials: z.boolean(),
  }),
  ipAllow: z.array(z.string()).max(50),
  ipDeny: z.array(z.string()).max(50),
  confirmNoSecurity: z.string().optional(),
  environments: z.array(z.string()).max(20).optional(),
});
export type TAccessInput = z.infer<typeof AccessInput>;

const ORIGIN = /^https?:\/\/(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:\d{1,5})?$/;
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"];

export function checkAccess(raw: unknown, ctx: { apiName: string; stage: "production" | "uat" }): TAccessInput {
  const p = AccessInput.safeParse(raw);
  if (!p.success) bad(`Access settings are not in the expected shape: ${p.error.issues[0]?.path.join(".") || "body"} ${p.error.issues[0]?.message ?? ""}`.trim());
  const v = p.data!;
  const origins = [...new Set(v.cors.origins.map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean))];
  for (const o of origins) if (o !== "*" && !ORIGIN.test(o)) bad(`"${o}" is not a web origin. Use the form https://app.example.com (no path), or * for any.`, "cors.origins");
  if (v.cors.enabled && !origins.length) bad("Add at least one allowed origin, or turn CORS off.", "cors.origins");
  if (v.cors.enabled && v.cors.credentials && origins.includes("*")) bad("Browsers refuse credentials with origin *. List the exact origins, or turn credentials off.", "cors.credentials");
  const headers = [...new Set(v.cors.headers.map((h) => h.trim()).filter(Boolean))];
  for (const h of headers) if (!HEADER.test(h)) bad(`"${h}" is not a valid header name.`, "cors.headers");
  const methods = [...new Set(v.cors.methods.map((m) => m.trim().toUpperCase()).filter(Boolean))];
  for (const m of methods) if (!METHODS.includes(m)) bad(`"${m}" is not an HTTP method CORS can allow.`, "cors.methods");
  const ipAllow = normaliseAddresses(v.ipAllow, "ipAllow");
  const ipDeny = normaliseAddresses(v.ipDeny, "ipDeny");
  for (const a of ipAllow) if (ipDeny.includes(a)) bad(`${a} is both allowed and blocked. Keep it in one list.`, "ipDeny");
  if (v.security === "none" && ctx.stage === "production" && (v.confirmNoSecurity ?? "") !== ctx.apiName)
    bad(`Turning sign-in off makes ${ctx.apiName} callable by anyone on the internet. Type the API name to confirm.`, "confirmNoSecurity");
  return { ...v, cors: { ...v.cors, origins, headers, methods }, ipAllow, ipDeny };
}

// ---------- addresses ----------
const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
const IPV6 = /^[0-9A-Fa-f:]+$/;

export function isIPv4(s: string): boolean { return IPV4.test(s); }
export function isIPv6(s: string): boolean { return s.includes(":") && IPV6.test(s) && s.split(":").length <= 8 && s.split("::").length <= 2; }
export function ipToInt(ip: string): number { return ip.split(".").reduce((n, o) => n * 256 + Number(o), 0); }
export function intToIp(n: number): string { return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join("."); }

/** 10.0.0.0/8 -> first/last address. Throws BadInput for anything malformed. */
export function cidrRange(cidr: string): { start: string; end: string } {
  const [ip, bitsS] = cidr.split("/");
  const bits = Number(bitsS);
  if (!isIPv4(ip) || !/^\d{1,2}$/.test(bitsS ?? "") || bits < 0 || bits > 32) bad(`"${cidr}" is not an IPv4 range like 10.20.0.0/16.`);
  const size = 2 ** (32 - bits);
  const start = Math.floor(ipToInt(ip) / size) * size;
  return { start: intToIp(start), end: intToIp(start + size - 1) };
}

export function normaliseAddresses(list: string[], field: string): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const a = raw.trim();
    if (!a) continue;
    if (a.includes("/")) {
      const { start } = cidrRange(a);
      const norm = `${start}/${a.split("/")[1]}`;
      if (norm !== a) bad(`${a} is not the start of its range. Did you mean ${norm}?`, field);
      if (a.endsWith("/0")) bad("A /0 range matches every address. Use the security settings instead.", field);
    } else if (!isIPv4(a) && !isIPv6(a)) bad(`"${a}" is not an IP address or IPv4 range.`, field);
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

function octetRange(lo: number, hi: number): string {
  if (lo === 0 && hi === 255) return OCTET;
  if (lo === hi) return String(lo);
  const nums: string[] = [];
  for (let i = hi; i >= lo; i--) nums.push(String(i));
  return `(${nums.join("|")})`;
}
/** Regex (whole string) for one IPv4 address, IPv4 CIDR range or exact IPv6 address. */
export function addressPattern(a: string): string {
  if (isIPv6(a)) return a.replace(/[.]/g, "\\.");
  if (!a.includes("/")) return a.replace(/\./g, "\\.");
  const { start, end } = cidrRange(a);
  const s = start.split(".").map(Number), e = end.split(".").map(Number);
  return s.map((o, i) => octetRange(o, e[i])).join("\\.");
}
/**
 * Regex that matches a caller address (or the first entry of a forwarded-for list) against any of the
 * given addresses. Empty string when the list is empty. Safe for an XML attribute (no < > & ").
 */
export function addressesRegex(list: string[]): string {
  if (!list.length) return "";
  // "::ffff:" covers gateways that report IPv4 callers as IPv4-mapped IPv6 addresses
  return `^\\s*(::ffff:)?(${list.map(addressPattern).join("|")})\\s*(,.*)?$`;
}

// ---------- blocking rules (admin deny policies) ----------
export const BLOCK_TYPES = ["IP", "IPRANGE", "APPLICATION", "USER", "API"] as const;
export const BlockInput = z.object({
  type: z.enum(BLOCK_TYPES),
  value: z.string().max(300),
  /** IPRANGE only, or the range written as a CIDR in value. */
  endIp: z.string().max(60).optional(),
  invert: z.boolean().optional(),
  enabled: z.boolean().default(true),
});
export type TBlockInput = z.infer<typeof BlockInput>;

/** Builds the API Manager deny-policy body from plain input. */
export function blockBody(raw: unknown, ctx: { apiContexts: string[]; appNames: string[] }): { conditionType: string; conditionValue: unknown; conditionStatus: boolean } {
  const p = BlockInput.safeParse(raw);
  if (!p.success) bad("Blocking rule is not in the expected shape.");
  const v = p.data!;
  const value = v.value.trim();
  if (!value) bad("Say what to block.", "value");
  switch (v.type) {
    case "IP":
      if (!isIPv4(value) && !isIPv6(value)) bad(`"${value}" is not an IP address.`, "value");
      return { conditionType: "IP", conditionValue: { fixedIp: value, invert: !!v.invert }, conditionStatus: v.enabled };
    case "IPRANGE": {
      let start = value, end = (v.endIp ?? "").trim();
      if (value.includes("/")) ({ start, end } = cidrRange(value));
      if (!isIPv4(start) || !isIPv4(end)) bad("Give the range as 10.0.0.0/24 or as a first and last IPv4 address.", "value");
      if (ipToInt(start) > ipToInt(end)) bad("The first address of the range comes after the last one.", "endIp");
      return { conditionType: "IPRANGE", conditionValue: { startingIp: start, endingIp: end, invert: !!v.invert }, conditionStatus: v.enabled };
    }
    case "APPLICATION": {
      // API Manager stores "<owner>:<application name>"
      if (!/^[^:\s][^:]{0,99}:[^:]{1,100}$/.test(value)) bad("Write the application as owner:application-name (for example admin:mobile-app).", "value");
      return { conditionType: "APPLICATION", conditionValue: value, conditionStatus: v.enabled };
    }
    case "USER":
      if (!/^[A-Za-z0-9._@+/-]{1,100}$/.test(value)) bad(`"${value}" is not a user name.`, "value");
      return { conditionType: "USER", conditionValue: value, conditionStatus: v.enabled };
    case "API": {
      const ctxV = value.startsWith("/") ? value : `/${value}`;
      if (!/^\/[A-Za-z0-9_.\-/{}]{1,200}$/.test(ctxV)) bad(`"${value}" is not an API path.`, "value");
      if (ctx.apiContexts.length && !ctx.apiContexts.includes(ctxV)) bad(`No API is published at ${ctxV}. Use the API's path with its version, for example /orders/v1.`, "value");
      return { conditionType: "API", conditionValue: ctxV, conditionStatus: v.enabled };
    }
  }
  return bad("Unknown rule type.");
}

export function blockWords(type: string, value: unknown): string {
  const v = value as any;
  switch (type) {
    case "IP": return `${v?.invert ? "Every address except" : "Address"} ${v?.fixedIp ?? v}`;
    case "IPRANGE": return `${v?.invert ? "Every address outside" : "Addresses"} ${v?.startingIp} to ${v?.endingIp}`;
    case "APPLICATION": return `Application ${String(v).split(":").slice(1).join(":")} (owner ${String(v).split(":")[0]})`;
    case "USER": return `User ${v}`;
    case "API": return `Every call to ${v}`;
    default: return `${type} ${JSON.stringify(v)}`;
  }
}

// ---------- new policies created inline ----------
export const NewPolicyInput = z.object({
  kind: z.enum(["subscription", "advanced", "application"]),
  name: z.string(),
  requests: z.number().int(),
  timeUnit: z.enum(TIME_UNITS),
  unitTime: z.number().int().min(1).max(1000).default(1),
  description: z.string().max(300).optional(),
});
export function newPolicyBody(raw: unknown, existing: string[]): { kind: "subscription" | "advanced" | "application"; body: Record<string, unknown>; name: string } {
  const p = NewPolicyInput.safeParse(raw);
  if (!p.success) bad(`Limit is not in the expected shape: ${p.error.issues[0]?.path.join(".") ?? ""} ${p.error.issues[0]?.message ?? ""}`.trim());
  const v = p.data!;
  const name = v.name.trim();
  if (!POLICY_NAME.test(name)) bad("Name the limit with letters, digits and underscores only (up to 60). API Manager refuses dashes, dots and spaces.", "name");
  if (existing.some((e) => e.toLowerCase() === name.toLowerCase())) bad(`A limit called ${name} already exists.`, "name");
  if (v.requests < 1 || v.requests > 1_000_000_000) bad("Requests must be between 1 and 1,000,000,000.", "requests");
  const words = rateWords(v.requests, v.timeUnit, v.unitTime);
  const body: Record<string, unknown> = {
    policyName: name, displayName: name, description: v.description ?? `${words} (created in the Weave console)`,
    defaultLimit: { type: "REQUESTCOUNTLIMIT", requestCount: { timeUnit: v.timeUnit, unitTime: v.unitTime, requestCount: v.requests } },
  };
  if (v.kind === "subscription") Object.assign(body, { billingPlan: "FREE", stopOnQuotaReach: true, rateLimitCount: 0, rateLimitTimeUnit: "sec" });
  return { kind: v.kind, body, name };
}

// ---------- applications ----------
export const AppInput = z.object({ name: z.string(), plan: z.string(), description: z.string().max(500).optional() });
export function checkApp(raw: unknown, plans: string[], names: string[]) {
  const p = AppInput.safeParse(raw);
  if (!p.success) bad("Application is not in the expected shape.");
  const v = p.data!;
  const name = v.name.trim();
  if (!APP_NAME.test(name)) bad("Name the application with letters, digits, space, dot, dash or underscore (up to 70).", "name");
  if (names.some((n) => n.toLowerCase() === name.toLowerCase())) bad(`An application called ${name} already exists.`, "name");
  if (!plans.includes(v.plan)) bad(`Application limit "${v.plan}" does not exist.`, "plan");
  return { name, plan: v.plan, description: (v.description ?? "").trim() };
}
export const KEY_TYPES = ["PRODUCTION", "SANDBOX"] as const;
export const SubscribeInput = z.object({ applicationId: z.string().regex(/^[0-9a-f-]{36}$/), apiId: z.string().regex(/^[0-9a-f-]{36}$/), plan: z.string() });
export const ID = /^[0-9a-fA-F-]{8,64}$/;
export function checkId(id: unknown, what = "id"): string {
  if (typeof id !== "string" || !ID.test(id)) bad(`That ${what} is not valid.`);
  return id as string;
}
