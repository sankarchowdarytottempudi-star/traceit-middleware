// Deterministic date helpers used by the $parseDate / $formatDate expression functions and by the
// mapping interpreter. No locale data, no time-zone database: wall-clock fields are kept as written.
export interface DateParts { y: number; M: number; d: number; h: number; m: number; s: number; ms: number; offsetMin: number | null; }

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
const monthIndex = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().slice(0, 3)));

function fromEpoch(ms: number): DateParts {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(), offsetMin: 0 };
}
function valid(p: DateParts): boolean {
  if (p.M < 1 || p.M > 12 || p.d < 1 || p.d > 31 || p.h > 23 || p.m > 59 || p.s > 59) return false;
  const t = new Date(Date.UTC(p.y, p.M - 1, p.d));
  return t.getUTCMonth() === p.M - 1 && t.getUTCDate() === p.d;
}
const mk = (y: number, M: number, d: number, h = 0, m = 0, s = 0, ms = 0, offsetMin: number | null = null): DateParts => ({ y, M, d, h, m, s, ms, offsetMin });
function yr(s: string) { const n = Number(s); return s.length <= 2 ? (n < 70 ? 2000 + n : 1900 + n) : n; }
function parseOffset(z?: string): number | null {
  if (!z) return null;
  if (z === "Z" || z === "z") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(z); if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Normalises user-written patterns: YYYY/DD accepted, and "mm" means month when no time part is present. */
export function normalizePattern(p: string): string {
  let out = p.replace(/Y/g, "y").replace(/D/g, "d");
  if (!/[Hhs]/.test(out)) out = out.replace(/m/g, "M");
  return out;
}
const TOKEN_RE = /yyyy|yy|MMMM|MMM|MM|M|dd|d|HH|H|hh|h|mm|m|ss|s|SSS|a|EEEE|EEE|Z|'[^']*'/g;

export function parseWithPattern(text: string, pattern: string): DateParts | null {
  const pat = normalizePattern(pattern);
  const names: string[] = [];
  let re = "", last = 0;
  for (const m of pat.matchAll(TOKEN_RE)) {
    re += pat.slice(last, m.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    last = m.index! + m[0].length;
    const t = m[0];
    if (t.startsWith("'")) { re += t.slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    names.push(t);
    re += t === "yyyy" ? "(\\d{4})" : t === "MMMM" || t === "MMM" || t === "EEEE" || t === "EEE" ? "([A-Za-z]+)" : t === "SSS" ? "(\\d{1,3})"
      : t === "a" ? "([AaPp][Mm])" : t === "Z" ? "(Z|[+-]\\d{2}:?\\d{2})" : t.length === 2 ? "(\\d{2})" : "(\\d{1,2})";
  }
  re += pat.slice(last).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp("^\\s*" + re + "\\s*$").exec(text);
  if (!m) return null;
  const p = mk(1970, 1, 1); let pm: boolean | null = null;
  names.forEach((t, i) => {
    const v = m[i + 1];
    switch (t) {
      case "yyyy": case "yy": p.y = yr(v); break;
      case "MMMM": case "MMM": p.M = monthIndex(v) + 1; break;
      case "MM": case "M": p.M = Number(v); break;
      case "dd": case "d": p.d = Number(v); break;
      case "HH": case "H": case "hh": case "h": p.h = Number(v); break;
      case "mm": case "m": p.m = Number(v); break;
      case "ss": case "s": p.s = Number(v); break;
      case "SSS": p.ms = Number(v.padEnd(3, "0")); break;
      case "a": pm = /p/i.test(v); break;
      case "Z": p.offsetMin = parseOffset(v); break;
      default: break;
    }
  });
  if (pm !== null) { if (pm && p.h < 12) p.h += 12; if (!pm && p.h === 12) p.h = 0; }
  return valid(p) ? p : null;
}

/** Parses the common ways a date arrives. Day-first is assumed for 05/03/2026 unless that is impossible. */
export function parseDateParts(value: unknown, pattern?: string): DateParts | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return fromEpoch(value.getTime());
  if (typeof value === "number") return fromEpoch(Math.abs(value) < 1e11 ? value * 1000 : value);
  const text = String(value).trim();
  if (pattern) return parseWithPattern(text, pattern);
  if (/^\d{10}$/.test(text)) return fromEpoch(Number(text) * 1000);
  if (/^\d{13}$/.test(text)) return fromEpoch(Number(text));
  let m: RegExpExecArray | null;
  const TIME = "(?:[T\\s]+(\\d{1,2}):(\\d{2})(?::(\\d{2})(?:[.,](\\d{1,9}))?)?\\s*([AaPp][Mm])?\\s*(Z|[+-]\\d{2}:?\\d{2})?)?";
  const time = (g: (string | undefined)[], p: DateParts) => {
    if (g[0] !== undefined) {
      p.h = Number(g[0]); p.m = Number(g[1]); p.s = Number(g[2] ?? 0); p.ms = g[3] ? Number(g[3].slice(0, 3).padEnd(3, "0")) : 0;
      if (g[4]) { const pm = /p/i.test(g[4]); if (pm && p.h < 12) p.h += 12; if (!pm && p.h === 12) p.h = 0; }
      p.offsetMin = parseOffset(g[5]);
    }
    return valid(p) ? p : null;
  };
  if ((m = new RegExp("^(\\d{4})-(\\d{1,2})-(\\d{1,2})" + TIME + "$").exec(text))) return time(m.slice(4), mk(Number(m[1]), Number(m[2]), Number(m[3])));
  if ((m = new RegExp("^(\\d{4})/(\\d{1,2})/(\\d{1,2})" + TIME + "$").exec(text))) return time(m.slice(4), mk(Number(m[1]), Number(m[2]), Number(m[3])));
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(text))) { const p = mk(Number(m[1]), Number(m[2]), Number(m[3])); return valid(p) ? p : null; }
  if ((m = new RegExp("^(\\d{1,2})[/.\\-](\\d{1,2})[/.\\-](\\d{2}|\\d{4})" + TIME + "$").exec(text))) {
    let d = Number(m[1]), M = Number(m[2]);
    if (M > 12 && d <= 12) { const t = d; d = M; M = t; }
    return time(m.slice(4), mk(yr(m[3]), M, d));
  }
  if ((m = new RegExp("^(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-]+([A-Za-z]{3,9})[\\s\\-,]+(\\d{2}|\\d{4})" + TIME + "$").exec(text))) {
    const M = monthIndex(m[2]) + 1; if (M < 1) return null;
    return time(m.slice(4), mk(yr(m[3]), M, Number(m[1])));
  }
  if ((m = new RegExp("^(?:[A-Za-z]{3,9},?\\s+)?([A-Za-z]{3,9})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})" + TIME + "$").exec(text))) {
    const M = monthIndex(m[1]) + 1; if (M < 1) return null;
    return time(m.slice(4), mk(Number(m[3]), M, Number(m[2])));
  }
  return null;
}

export function toEpochMs(p: DateParts): number { return Date.UTC(p.y, p.M - 1, p.d, p.h, p.m, p.s, p.ms) - (p.offsetMin ?? 0) * 60_000; }
export function toIso(p: DateParts): string { return new Date(toEpochMs(p)).toISOString(); }

export function formatParts(p: DateParts, pattern: string): string {
  const pat = normalizePattern(pattern);
  const dow = new Date(Date.UTC(p.y, p.M - 1, p.d)).getUTCDay();
  return pat.replace(TOKEN_RE, (t) => {
    switch (t) {
      case "yyyy": return pad(p.y, 4);
      case "yy": return pad(p.y % 100);
      case "MMMM": { const n = MONTHS[p.M - 1]; return n[0].toUpperCase() + n.slice(1); }
      case "MMM": { const n = MONTHS[p.M - 1].slice(0, 3); return n[0].toUpperCase() + n.slice(1); }
      case "MM": return pad(p.M); case "M": return String(p.M);
      case "dd": return pad(p.d); case "d": return String(p.d);
      case "HH": return pad(p.h); case "H": return String(p.h);
      case "hh": return pad(p.h % 12 === 0 ? 12 : p.h % 12); case "h": return String(p.h % 12 === 0 ? 12 : p.h % 12);
      case "mm": return pad(p.m); case "m": return String(p.m);
      case "ss": return pad(p.s); case "s": return String(p.s);
      case "SSS": return pad(p.ms, 3);
      case "a": return p.h < 12 ? "AM" : "PM";
      case "EEEE": return DAYS[dow]; case "EEE": return DAYS[dow].slice(0, 3);
      case "Z": { if (p.offsetMin === null || p.offsetMin === 0) return "Z"; const o = p.offsetMin; return (o < 0 ? "-" : "+") + pad(Math.floor(Math.abs(o) / 60)) + ":" + pad(Math.abs(o) % 60); }
      default: return t.startsWith("'") ? t.slice(1, -1) : t;
    }
  });
}

export function addToParts(p: DateParts, amount: number, unit: string): DateParts {
  const u = unit.toLowerCase().replace(/s$/, "");
  if (u === "month" || u === "year") {
    const total = p.y * 12 + (p.M - 1) + (u === "year" ? amount * 12 : amount);
    const y = Math.floor(total / 12), M = (total % 12 + 12) % 12 + 1;
    const dim = new Date(Date.UTC(y, M, 0)).getUTCDate();
    return { ...p, y, M, d: Math.min(p.d, dim) };
  }
  const mult = u === "day" ? 86400_000 : u === "week" ? 7 * 86400_000 : u === "hour" ? 3600_000 : u === "minute" ? 60_000 : u === "second" ? 1000 : 86400_000;
  const d = new Date(Date.UTC(p.y, p.M - 1, p.d, p.h, p.m, p.s, p.ms) + amount * mult);
  return { y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(), offsetMin: p.offsetMin };
}
