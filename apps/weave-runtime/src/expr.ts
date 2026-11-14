// JSONata evaluation, {{ }} templates and the extra helper functions listed in GET /v1/catalog.
// Everything runs in-process; nothing is ever sent anywhere.
import jsonata from "jsonata";
import crypto from "node:crypto";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import type { FunctionDoc } from "@traceit/weave-flow";
import { addToParts, formatParts, parseDateParts, toEpochMs, toIso } from "./dates.js";

export interface ExprScope {
  payload: unknown;
  input?: unknown;                 // when set, `$` is this value instead of the payload (mapping rules)
  vars?: Record<string, unknown>;
  request?: unknown;
  nodes?: Record<string, unknown>;
  item?: unknown;
  index?: number;
  error?: unknown;
  env?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

// ---------------------------------------------------------------- helpers
export const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
const str = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));
export const titleCase = (v: unknown) => str(v).toLowerCase().replace(/(^|[\s\-_'/])([a-zà-ÿ])/g, (_m, a: string, b: string) => a + b.toUpperCase());
export function toBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (["true", "yes", "y", "1", "on", "t", "active", "enabled"].includes(s)) return true;
  if (["false", "no", "n", "0", "off", "f", "", "inactive", "disabled", "null", "none"].includes(s)) return false;
  return undefined;
}
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text", parseTagValue: false, parseAttributeValue: false, trimValues: true });
const xmlBuilder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text", format: false, suppressEmptyNode: true });
export const xmlToJson = (xml: unknown): unknown => { if (isEmpty(xml)) return undefined; return xmlParser.parse(str(xml)); };
export const jsonToXml = (v: unknown): string => (v === undefined || v === null ? "" : String(xmlBuilder.build(v)));

type Fn = (...args: unknown[]) => unknown;
const HELPERS: Record<string, { fn: Fn; doc: Omit<FunctionDoc, "name"> }> = {
  titleCase: { fn: (v) => (v === undefined ? undefined : titleCase(v)), doc: { signature: "$titleCase(text)", description: "Capitalises the first letter of every word.", example: '$titleCase("john o\'neil") = "John O\'Neil"' } },
  capitalize: { fn: (v) => { if (v === undefined) return undefined; const s = str(v); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }, doc: { signature: "$capitalize(text)", description: "First letter upper case, the rest lower case.", example: '$capitalize("hELLO") = "Hello"' } },
  initials: { fn: (v) => (v === undefined ? undefined : str(v).trim().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join("")), doc: { signature: "$initials(text)", description: "First letter of every word, upper case.", example: '$initials("john smith") = "JS"' } },
  words: { fn: (v) => (v === undefined ? undefined : str(v).trim().split(/\s+/).filter(Boolean)), doc: { signature: "$words(text)", description: "Splits text into words.", example: '$words("a  b c") = ["a","b","c"]' } },
  digits: { fn: (v) => (v === undefined ? undefined : str(v).replace(/\D/g, "")), doc: { signature: "$digits(text)", description: "Keeps only the digits.", example: '$digits("+966 (50) 123") = "96650123"' } },
  isEmpty: { fn: (v) => isEmpty(v), doc: { signature: "$isEmpty(value)", description: "True when the value is missing, null, blank text, or an empty list/object.", example: '$isEmpty("  ") = true' } },
  coalesce: { fn: (...a) => a.find((x) => !isEmpty(x)), doc: { signature: "$coalesce(a, b, ...)", description: "The first value that is not empty.", example: '$coalesce(nickname, firstName, "Guest")' } },
  translate: { fn: (v, table, dflt) => {
      if (v === undefined || v === null) return dflt === undefined ? v : dflt;
      const t = (table ?? {}) as Record<string, unknown>; const k = str(v);
      if (k in t) return t[k];
      const hit = Object.keys(t).find((x) => x.toLowerCase() === k.trim().toLowerCase());
      return hit !== undefined ? t[hit] : dflt === undefined ? v : dflt;
    }, doc: { signature: "$translate(value, table [, default])", description: "Looks the value up in a table (case-insensitive). Without a default an unknown value is kept as it is.", example: '$translate(gender, {"M":"Male","F":"Female"}, "Unknown")' } },
  toBool: { fn: (v) => toBool(v), doc: { signature: "$toBool(value)", description: "Reads yes/no, Y/N, true/false, 1/0, on/off as a boolean.", example: '$toBool("Y") = true' } },
  yesNo: { fn: (v, yes, no) => { const b = toBool(v); if (b === undefined) return undefined; return b ? (yes === undefined ? "Yes" : yes) : (no === undefined ? "No" : no); }, doc: { signature: "$yesNo(value [, yesText, noText])", description: "Turns a boolean-like value into Yes / No (or your own words).", example: '$yesNo(true, "Y", "N") = "Y"' } },
  parseDate: { fn: (v, pattern) => { const p = parseDateParts(v, pattern === undefined ? undefined : str(pattern)); return p ? toIso(p) : undefined; }, doc: { signature: "$parseDate(value [, pattern])", description: "Reads a date in the common formats (ISO, 31/12/2026, 31-Dec-2026, epoch) and returns ISO 8601. Give a pattern such as \"dd/MM/yyyy\" when the format is unusual.", example: '$parseDate("31/12/2026") = "2026-12-31T00:00:00.000Z"' } },
  formatDate: { fn: (v, pattern, inPattern) => { const p = parseDateParts(v, inPattern === undefined ? undefined : str(inPattern)); return p ? formatParts(p, str(pattern ?? "yyyy-MM-dd")) : undefined; }, doc: { signature: "$formatDate(value, pattern [, inputPattern])", description: "Re-writes a date using a pattern: yyyy MM dd HH mm ss, MMM (Jan), MMMM (January), EEE (Mon), a (AM/PM).", example: '$formatDate("2026-12-31T10:15:00Z", "dd/MM/yyyy") = "31/12/2026"' } },
  addTime: { fn: (v, amount, unit) => { const p = parseDateParts(v); if (!p) return undefined; const q = addToParts(p, Number(amount), str(unit ?? "days")); const dateOnly = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()); return dateOnly ? formatParts(q, "yyyy-MM-dd") : toIso(q); }, doc: { signature: "$addTime(value, amount, unit)", description: "Adds days, weeks, months, years, hours, minutes or seconds to a date (negative to subtract).", example: '$addTime("2026-01-31", 1, "month") = "2026-02-28"' } },
  dateDiff: { fn: (a, b, unit) => { const pa = parseDateParts(a), pb = parseDateParts(b); if (!pa || !pb) return undefined; const ms = toEpochMs(pb) - toEpochMs(pa); const u = str(unit ?? "days").toLowerCase().replace(/s$/, ""); if (u === "month" || u === "year") { const months = (pb.y - pa.y) * 12 + (pb.M - pa.M) - (pb.d < pa.d ? 1 : 0); return u === "month" ? months : Math.trunc(months / 12); } const div = u === "hour" ? 3600_000 : u === "minute" ? 60_000 : u === "second" ? 1000 : u === "week" ? 7 * 86400_000 : u === "year" ? 365.25 * 86400_000 : 86400_000; return Math.floor(ms / div); }, doc: { signature: "$dateDiff(from, to [, unit])", description: "Whole days (or weeks, months, years, hours, minutes, seconds) between two dates.", example: '$dateDiff("2026-01-01", "2026-01-08") = 7' } },
  epochMillis: { fn: (v) => { const p = parseDateParts(v); return p ? toEpochMs(p) : undefined; }, doc: { signature: "$epochMillis(value)", description: "A date as milliseconds since 1970.", example: '$epochMillis("2026-01-01") = 1767225600000' } },
  toMinorUnits: { fn: (v, decimals) => { if (isEmpty(v)) return undefined; const n = Number(v); if (!Number.isFinite(n)) return undefined; return Math.round(n * 10 ** Number(decimals ?? 2)); }, doc: { signature: "$toMinorUnits(amount [, decimals])", description: "Money to its smallest unit (cents, halalas): 12.5 becomes 1250.", example: "$toMinorUnits(12.5) = 1250" } },
  fromMinorUnits: { fn: (v, decimals) => { if (isEmpty(v)) return undefined; const n = Number(v); if (!Number.isFinite(n)) return undefined; return n / 10 ** Number(decimals ?? 2); }, doc: { signature: "$fromMinorUnits(amount [, decimals])", description: "Smallest unit back to money: 1250 becomes 12.5.", example: "$fromMinorUnits(1250) = 12.5" } },
  uuid: { fn: () => crypto.randomUUID(), doc: { signature: "$uuid()", description: "A new random identifier.", example: "$uuid()" } },
  hash: { fn: (v, algo) => crypto.createHash(str(algo ?? "sha256")).update(str(v)).digest("hex"), doc: { signature: "$hash(text [, algorithm])", description: "Hex digest (sha256 by default).", example: '$hash("abc")' } },
  parseJson: { fn: (v) => { if (isEmpty(v)) return undefined; return JSON.parse(str(v)); }, doc: { signature: "$parseJson(text)", description: "Parses JSON text into a value.", example: '$parseJson("{\\"a\\":1}").a = 1' } },
  xmlToJson: { fn: (v) => xmlToJson(v), doc: { signature: "$xmlToJson(xmlText)", description: "Parses XML text. Attributes are prefixed with @, element text is #text.", example: '$xmlToJson("<a id=\\"1\\">x</a>")' } },
  jsonToXml: { fn: (v) => jsonToXml(v), doc: { signature: "$jsonToXml(value)", description: "Builds XML text from an object.", example: '$jsonToXml({"a": {"@id": "1", "#text": "x"}})' } },
};
export const FUNCTION_DOCS: FunctionDoc[] = [
  ...Object.entries(HELPERS).map(([name, h]) => ({ name: "$" + name, ...h.doc })),
  { name: "$uppercase", signature: "$uppercase(text)", description: "Upper case (built in).", example: '$uppercase("ab") = "AB"' },
  { name: "$lowercase", signature: "$lowercase(text)", description: "Lower case (built in).", example: '$lowercase("AB") = "ab"' },
  { name: "$trim", signature: "$trim(text)", description: "Removes leading, trailing and repeated spaces (built in).", example: '$trim("  a   b ") = "a b"' },
  { name: "$substring", signature: "$substring(text, start [, length])", description: "Part of a text; a negative start counts from the end (built in).", example: '$substring("abcdef", -2) = "ef"' },
  { name: "$split", signature: "$split(text, separator)", description: "Splits text into a list (built in).", example: '$split("a,b", ",") = ["a","b"]' },
  { name: "$join", signature: "$join(list [, separator])", description: "Joins a list of texts (built in).", example: '$join(["a","b"], "-") = "a-b"' },
  { name: "$replace", signature: "$replace(text, pattern, replacement)", description: "Replaces text or a /regex/ (built in).", example: '$replace("a b", " ", "_") = "a_b"' },
  { name: "$pad", signature: "$pad(text, width [, char])", description: "Pads to a width; negative width pads on the left (built in).", example: '$pad("7", -3, "0") = "007"' },
  { name: "$number", signature: "$number(value)", description: "Converts to a number (built in).", example: '$number("12.5") = 12.5' },
  { name: "$string", signature: "$string(value)", description: "Converts to text (built in).", example: '$string(5) = "5"' },
  { name: "$round", signature: "$round(number [, decimals])", description: "Rounds a number (built in).", example: "$round(2.345, 2) = 2.35" },
  { name: "$formatNumber", signature: "$formatNumber(number, picture)", description: "Formats a number (built in).", example: '$formatNumber(1234.5, "#,##0.00") = "1,234.50"' },
  { name: "$sum", signature: "$sum(list)", description: "Adds up a list of numbers (built in).", example: "$sum(items.price)" },
  { name: "$count", signature: "$count(list)", description: "Number of items (built in).", example: "$count(items)" },
  { name: "$exists", signature: "$exists(value)", description: "True when the field is present (built in).", example: "$exists(customer.email)" },
  { name: "$now", signature: "$now()", description: "Current time, ISO 8601 (built in).", example: "$now()" },
];

// ---------------------------------------------------------------- compile cache
type Compiled = ReturnType<typeof jsonata>;
const cache = new Map<string, Compiled>();
function describe(e: unknown): string {
  const x = e as { message?: string; position?: number; token?: string; code?: string };
  const pos = typeof x?.position === "number" ? ` (at character ${x.position})` : "";
  return (x?.message || String(e)) + pos;
}
export class ExprError extends Error { constructor(message: string, readonly expr: string) { super(message); } }

export function compile(expr: string): Compiled {
  let c = cache.get(expr);
  if (c) return c;
  try { c = jsonata(expr); } catch (e) { throw new ExprError(`Expression is not valid: ${describe(e)}`, expr); }
  for (const [name, h] of Object.entries(HELPERS)) c.registerFunction(name, h.fn as never);
  if (cache.size > 5000) cache.clear();
  cache.set(expr, c);
  return c;
}
/** Returns a message when the expression does not parse, otherwise null. */
export function checkExpr(expr: string): string | null {
  if (typeof expr !== "string" || expr.trim() === "") return "Expression is empty";
  try { compile(expr); return null; } catch (e) { return (e as Error).message; }
}

/** Plain JSON-safe copy of a JSONata result (sequences become arrays, functions disappear). */
export function plain(v: unknown): unknown {
  if (v === undefined || v === null) return v;
  if (typeof v === "function") return undefined;
  if (typeof v !== "object") return typeof v === "number" && !Number.isFinite(v) ? null : v;
  if (Array.isArray(v)) return v.map((x) => { const p = plain(x); return p === undefined ? null : p; });
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) { const p = plain(x); if (p !== undefined) out[k] = p; }
  return out;
}

function bindings(s: ExprScope): Record<string, unknown> {
  return { payload: s.payload, vars: s.vars ?? {}, request: s.request, nodes: s.nodes ?? {}, item: s.item, index: s.index, error: s.error, env: s.env ?? {}, params: s.params };
}
export async function evalExpr(expr: string, scope: ExprScope): Promise<unknown> {
  if (typeof expr !== "string") return expr;
  if (expr.trim() === "") return undefined;
  const c = compile(expr);
  try {
    const input = "input" in scope ? scope.input : scope.payload;
    return plain(await c.evaluate(input === undefined ? null : input, bindings(scope)));
  } catch (e) {
    if (e instanceof ExprError) throw e;
    throw new ExprError(`Expression failed: ${describe(e)}`, expr);
  }
}

// ---------------------------------------------------------------- templates
type Segment = { text: string } | { expr: string };
const tplCache = new Map<string, Segment[]>();
export function parseTemplate(tpl: string): Segment[] {
  const hit = tplCache.get(tpl); if (hit) return hit;
  const out: Segment[] = [];
  let i = 0;
  for (;;) {
    const j = tpl.indexOf("{{", i);
    if (j < 0) { if (i < tpl.length) out.push({ text: tpl.slice(i) }); break; }
    if (j > i) out.push({ text: tpl.slice(i, j) });
    let k = tpl.indexOf("}}", j + 2);
    if (k < 0) throw new ExprError("Template has {{ without a closing }}", tpl);
    const first = k; let found = -1;
    while (k >= 0) {
      const cand = tpl.slice(j + 2, k).trim();
      if (cand && checkExpr(cand) === null) { found = k; break; }
      k = tpl.indexOf("}}", k + 1);
    }
    if (found < 0) {
      const cand = tpl.slice(j + 2, first).trim();
      throw new ExprError(`Template expression {{ ${cand} }} is not valid: ${checkExpr(cand) ?? ""}`, cand);
    }
    out.push({ expr: tpl.slice(j + 2, found).trim() });
    i = found + 2;
  }
  if (tplCache.size > 5000) tplCache.clear();
  tplCache.set(tpl, out);
  return out;
}
export function checkTemplate(tpl: string): string | null {
  if (typeof tpl !== "string" || !tpl.includes("{{")) return null;
  try { parseTemplate(tpl); return null; } catch (e) { return (e as Error).message; }
}
/** Interpolates {{ }}. A string that is exactly one {{ expression }} yields the raw value. */
export async function renderTemplate(tpl: unknown, scope: ExprScope): Promise<unknown> {
  if (typeof tpl !== "string" || !tpl.includes("{{")) return tpl;
  const segs = parseTemplate(tpl);
  if (segs.length === 1 && "expr" in segs[0]) return evalExpr(segs[0].expr, scope);
  let out = "";
  for (const s of segs) out += "text" in s ? s.text : str(await evalExpr(s.expr, scope));
  return out;
}
export async function renderString(tpl: unknown, scope: ExprScope): Promise<string> { return str(await renderTemplate(tpl, scope)); }
/** Renders every string inside a JSON value. */
export async function renderDeep(value: unknown, scope: ExprScope): Promise<unknown> {
  if (typeof value === "string") return renderTemplate(value, scope);
  if (Array.isArray(value)) { const out = []; for (const v of value) { const r = await renderDeep(v, scope); out.push(r === undefined ? null : r); } return out; }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) { const r = await renderDeep(v, scope); if (r !== undefined) out[k] = r; }
    return out;
  }
  return value;
}
export function checkDeep(value: unknown): string | null {
  if (typeof value === "string") return checkTemplate(value);
  if (Array.isArray(value)) { for (const v of value) { const e = checkDeep(v); if (e) return e; } return null; }
  if (value && typeof value === "object") { for (const v of Object.values(value)) { const e = checkDeep(v); if (e) return e; } }
  return null;
}
/** Truthiness as JSONata's $boolean sees it. */
export function truthy(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.some(truthy);
  if (typeof v === "object") return Object.keys(v).length > 0;
  return false;
}
