// Proposes mapping rules from a sample input and the output the user wants. Deterministic and local:
// name similarity, equal values and a small set of simple derived transforms. Every proposal carries a
// confidence (0..1) and a comment saying why, so the canvas can show it for review. Nothing leaves the process.
import type { Json, MappingRule } from "@traceit/weave-flow";
import { titleCase } from "../expr.js";
import { formatParts, parseDateParts } from "../dates.js";

export type InferredRule = MappingRule & { confidence?: number };
interface Leaf { path: string; expr: string; name: string[]; ctx: string[]; value: unknown; }
interface Pick { kind: "direct" | "expr" | "const"; source?: string; expr?: string; value?: Json; confidence: number; comment: string; }

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SYN: string[][] = [
  ["id", "identifier", "key", "ref", "reference"], ["number", "no", "num", "nbr"], ["first", "given", "fname", "forename"], ["last", "family", "surname", "lname"],
  ["email", "mail", "emailaddress"], ["phone", "mobile", "tel", "telephone", "msisdn", "cell"], ["amount", "total", "price", "value", "sum"], ["qty", "quantity", "count", "units"],
  ["desc", "description", "details"], ["dob", "birthdate", "birthday", "birth"], ["addr", "address"], ["zip", "postal", "postcode", "zipcode"], ["country", "nation"],
  ["start", "from", "begin", "checkin", "arrival"], ["end", "to", "until", "checkout", "departure"], ["created", "creation"], ["updated", "modified"], ["currency", "ccy", "curr"],
  ["status", "state"], ["type", "kind", "category"], ["name", "title", "label"], ["customer", "client", "guest", "user", "passenger"], ["item", "line", "product", "entry"],
];
const CANON = new Map<string, string>(); for (const g of SYN) for (const w of g) CANON.set(w, g[0]);
const tokens = (s: string): string[] => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.\s]+/g, " ").toLowerCase().trim().split(" ").filter(Boolean)
  .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)).map((w) => CANON.get(w) ?? w);
const seg = (s: string) => (IDENT.test(s) ? s : "`" + s.replace(/`/g, "") + "`");
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const scalar = (v: unknown) => v === null || typeof v !== "object";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** A value that is unlikely to be equal by coincidence. */
const distinctive = (v: unknown): boolean => (typeof v === "string" ? v.trim().length >= 3 : typeof v === "number" ? Math.abs(v) > 1 && (!Number.isInteger(v) || Math.abs(v) >= 10) : Array.isArray(v) ? v.length > 0 : false);

function leaves(v: unknown, limit = 400): Leaf[] {
  const out: Leaf[] = [];
  const walk = (x: unknown, path: string, expr: string, names: string[]) => {
    if (out.length >= limit) return;
    if (isObj(x)) { for (const [k, val] of Object.entries(x)) walk(val, path ? `${path}.${k}` : k, expr ? `${expr}.${seg(k)}` : seg(k), [...names, k]); return; }
    if (Array.isArray(x) && x.length && x.every(isObj)) { walk(x[0], `${path}[0]`, `${expr}[0]`, names); return; }
    if (!names.length) return;
    out.push({ path, expr, name: tokens(names[names.length - 1]), ctx: names.slice(0, -1).flatMap(tokens), value: x });
  };
  walk(v, "", "", []);
  return out;
}
function nameScore(t: Leaf, s: Leaf): number {
  const a = new Set(t.name), b = new Set(s.name);
  const inter = [...a].filter((x) => b.has(x)).length; if (!inter) return t.name.join("") === s.name.join("") ? 1 : 0;
  const leaf = inter / new Set([...a, ...b]).size;
  const full = new Set([...s.ctx, ...s.name]); const ctxHit = t.ctx.length ? t.ctx.filter((x) => full.has(x)).length / t.ctx.length : 0;
  const tFull = new Set([...t.ctx, ...t.name]); const cover = [...b].filter((x) => tFull.has(x)).length / b.size;
  return Math.min(1, Math.max(leaf, 0.85 * cover * (inter / a.size)) * 0.85 + 0.15 * ctxHit + (leaf === 1 ? 0.15 : 0));
}
const DATE_FORMATS = ["yyyy-MM-dd", "dd/MM/yyyy", "MM/dd/yyyy", "dd-MM-yyyy", "dd.MM.yyyy", "dd-MMM-yyyy", "dd MMM yyyy", "d MMMM yyyy", "yyyyMMdd", "yyyy/MM/dd", "yyyy-MM-dd'T'HH:mm:ss", "dd/MM/yyyy HH:mm", "HH:mm"];
const SEPS: [string, string][] = [[" ", "a space"], ["", "nothing"], ["-", "a hyphen"], ["_", "an underscore"], [", ", "a comma"], ["/", "a slash"], [":", "a colon"], [".", "a dot"], [",", "a comma"]];
const q = (s: string) => JSON.stringify(s);

/** Simple transforms of one input value that produce exactly the wanted value. */
function derive(s: Leaf, want: unknown): { expr: string; how: string } | null {
  const v = s.value, p = s.expr;
  if (typeof v === "string" && typeof want === "string" && v !== want && v.trim()) {
    if (want === v.toUpperCase()) return { expr: `$uppercase(${p})`, how: "in upper case" };
    if (want === v.toLowerCase()) return { expr: `$lowercase(${p})`, how: "in lower case" };
    if (want === v.trim()) return { expr: `$trim(${p})`, how: "with the spaces around it removed" };
    if (want === titleCase(v)) return { expr: `$titleCase(${p})`, how: "with each word capitalised" };
    if (want === v.trim().toUpperCase()) return { expr: `$uppercase($trim(${p}))`, how: "trimmed and in upper case" };
    if (want === v.trim().toLowerCase()) return { expr: `$lowercase($trim(${p}))`, how: "trimmed and in lower case" };
    const words = v.trim().split(/\s+/);
    if (words.length > 1) {
      for (const [sep, label] of SEPS) if (sep !== " " && want === words.join(sep)) return { expr: `$join($split($trim(${p}), /\\s+/), ${q(sep)})`, how: `with its words joined by ${label}` };
      if (want === words[0]) return { expr: `$split($trim(${p}), /\\s+/)[0]`, how: "first word only" };
      if (want === words[words.length - 1]) return { expr: `$split($trim(${p}), /\\s+/)[-1]`, how: "last word only" };
    }
    const digits = v.replace(/\D/g, "");
    if (digits.length >= 3 && want === digits) return { expr: `$digits(${p})`, how: "digits only" };
    if (want.length >= 3 && distinctive(want)) {
      if (v.startsWith(want) && /\W/.test(v.charAt(want.length))) return { expr: `$substringBefore(${p}, ${q(v.charAt(want.length))})`, how: `the part before ${q(v.charAt(want.length))}` };
      if (v.endsWith(want) && /\W/.test(v.charAt(v.length - want.length - 1))) { const ch = v.charAt(v.length - want.length - 1); if (v.indexOf(ch) === v.length - want.length - 1) return { expr: `$substringAfter(${p}, ${q(ch)})`, how: `the part after ${q(ch)}` }; }
    }
    const parts = parseDateParts(v);
    if (parts && /\d/.test(want)) for (const f of DATE_FORMATS) { try { if (formatParts(parts, f) === want) return { expr: `$formatDate(${p}, ${q(f)})`, how: `written as ${f}` }; } catch { /* not this format */ } }
  }
  if (typeof v === "number" && typeof want === "string") {
    if (String(v) === want) return { expr: `$string(${p})`, how: "as text" };
    for (const d of [2, 1, 3]) if (v.toFixed(d) === want) return { expr: `$formatNumber(${p}, ${q("0." + "0".repeat(d))})`, how: `as text with ${d} decimals` };
    for (const n of [want.length]) if (/^0+\d+$/.test(want) && String(v).padStart(n, "0") === want) return { expr: `$pad($string(${p}), -${n}, "0")`, how: `padded with zeros to ${n} characters` };
  }
  if (typeof v === "string" && typeof want === "number" && v.trim() !== "" && Number(v) === want) return { expr: `$number(${p})`, how: "as a number" };
  if (typeof v === "number" && typeof want === "number" && v !== want && distinctive(v)) {
    if (Math.round(v * 100) === want) return { expr: `$toMinorUnits(${p})`, how: "in minor units (multiplied by 100)" };
    if (v / 100 === want) return { expr: `$fromMinorUnits(${p})`, how: "from minor units (divided by 100)" };
    if (Number(v.toFixed(2)) === want) return { expr: `$round(${p}, 2)`, how: "rounded to 2 decimals" };
    if (Math.round(v) === want) return { expr: `$round(${p})`, how: "rounded to a whole number" };
    if (Math.floor(v) === want) return { expr: `$floor(${p})`, how: "rounded down" };
  }
  if (typeof v === "boolean" && typeof want === "string") {
    for (const [y, n] of [["Y", "N"], ["Yes", "No"], ["yes", "no"], ["YES", "NO"], ["true", "false"], ["1", "0"], ["Active", "Inactive"]]) if (want === (v ? y : n)) return { expr: `${p} ? ${q(y)} : ${q(n)}`, how: `as ${y} or ${n}` };
  }
  if (typeof v === "boolean" && typeof want === "number" && want === (v ? 1 : 0)) return { expr: `${p} ? 1 : 0`, how: "as 1 or 0" };
  if (Array.isArray(v) && v.length > 1 && v.every(scalar)) {
    if (typeof want === "number" && want === v.length && v.length > 1) return { expr: `$count(${p})`, how: "counted" };
    if (typeof want === "string") for (const [sep] of SEPS) if (sep && want === v.join(sep)) return { expr: `$join(${p}, ${q(sep)})`, how: `joined with ${q(sep)}` };
  }
  return null;
}

function pick(t: Leaf, src: Leaf[]): Pick {
  const want = t.value;
  const scored = src.map((s) => ({ s, n: nameScore(t, s) })).sort((a, b) => b.n - a.n);
  const empty = want === null || want === "" || (Array.isArray(want) && !want.length);
  // 1. the same value
  const equal = empty ? [] : scored.filter((x) => same(x.s.value, want));
  if (equal.length) {
    const best = equal[0]; const strong = distinctive(want);
    const c = best.n >= 0.9 ? 0.99 : best.n >= 0.5 ? 0.95 : equal.length === 1 && strong ? 0.9 : strong ? 0.7 : 0.55;
    const why = best.n >= 0.5 ? "same value in the sample and a matching name" : equal.length === 1 ? "the only input with this value in the sample" : `same value in the sample (${equal.length} inputs have it; picked the closest name)`;
    return { kind: "direct", source: best.s.path, confidence: c, comment: `${best.s.path}: ${why}` };
  }
  // 2. one input, changed in a simple way
  if (!empty) for (const x of scored) {
    const d = derive(x.s, want); if (!d) continue;
    return { kind: "expr", expr: d.expr, confidence: x.n >= 0.5 ? 0.92 : 0.8, comment: `${x.s.path} ${d.how} gives the sample value` };
  }
  // 3. two inputs joined
  if (typeof want === "string" && want.length >= 3) {
    const strs = src.filter((s) => (typeof s.value === "string" && s.value.length > 0) || typeof s.value === "number").slice(0, 120);
    const txt = (s: Leaf) => String(s.value);
    for (const a of strs) {
      if (!want.startsWith(txt(a)) || want === txt(a)) continue;
      for (const b of strs) {
        if (a === b || !want.endsWith(txt(b))) continue;
        for (const [sep, label] of SEPS) {
          if (txt(a) + sep + txt(b) !== want) continue;
          const part = (s: Leaf) => (typeof s.value === "number" ? `$string(${s.expr})` : s.expr);
          return { kind: "expr", expr: sep ? `${part(a)} & ${q(sep)} & ${part(b)}` : `${part(a)} & ${part(b)}`, confidence: sep === "" && (txt(a).length < 2 || txt(b).length < 2) ? 0.6 : 0.88, comment: `${a.path} and ${b.path} joined with ${label} give the sample value` };
        }
      }
    }
  }
  // 4. only the name matches
  const named = scored[0];
  if (named && named.n >= 0.45 && typeof named.s.value !== "object") {
    const c = empty ? Math.min(0.75, 0.3 + named.n * 0.45) : Math.min(0.65, 0.2 + named.n * 0.45);
    return { kind: "direct", source: named.s.path, confidence: Number(c.toFixed(2)), comment: `${named.s.path}: the name matches${empty ? "" : ", but the sample values differ"}. Please check.` };
  }
  // 5. nothing in the input explains it: keep the wanted value so the field is not lost
  return { kind: "const", value: want as Json, confidence: 0.3, comment: "Nothing in the sample input matches this field, so the sample value is kept as a fixed value. Replace it with a rule if it should change." };
}

function objectExpr(entries: [string[], string][]): string {
  const tree = new Map<string, string | [string[], string][]>();
  for (const [segs, e] of entries) {
    if (segs.length === 1) { tree.set(segs[0], e); continue; }
    const cur = tree.get(segs[0]); const list = Array.isArray(cur) ? cur : []; list.push([segs.slice(1), e]); tree.set(segs[0], list);
  }
  return `{ ${[...tree].map(([k, v]) => `${q(k)}: ${typeof v === "string" ? v : objectExpr(v)}`).join(", ")} }`;
}
/** A list of objects in the output built from a list of objects in the input. */
function listRule(target: string, want: Record<string, unknown>[], source: unknown): Pick | null {
  const lists: { path: string; expr: string; items: Record<string, unknown>[] }[] = [];
  const walk = (x: unknown, path: string, expr: string, depth: number) => {
    if (depth > 6 || lists.length > 20) return;
    if (Array.isArray(x)) { if (x.length && x.every(isObj)) lists.push({ path, expr, items: x as Record<string, unknown>[] }); return; }
    if (isObj(x)) for (const [k, v] of Object.entries(x)) walk(v, path ? `${path}.${k}` : k, expr ? `${expr}.${seg(k)}` : seg(k), depth + 1);
  };
  walk(source, "", "", 0);
  const tl = leaves(want[0]); if (!tl.length) return null;
  let best: { score: number; pick: Pick } | null = null;
  for (const l of lists) {
    if (!l.expr) continue;
    const sl = leaves(l.items[0]); if (!sl.length) continue;
    const picks = tl.map((t) => ({ t, p: pick(t, sl) }));
    const good = picks.filter((x) => x.p.kind !== "const" && x.p.confidence >= 0.5 && !/\[\d+\]/.test(x.p.source ?? x.p.expr ?? ""));
    if (good.length * 2 < tl.length) continue;
    const score = good.reduce((n, x) => n + x.p.confidence, 0) / tl.length - (l.items.length === want.length ? 0 : 0.05);
    if (best && best.score >= score) continue;
    const entries: [string[], string][] = good.map((x) => [x.t.path.split("."), x.p.kind === "direct" ? x.p.source!.split(".").map(seg).join(".") : x.p.expr!]);
    const missed = picks.filter((x) => !good.includes(x)).map((x) => x.t.path);
    best = { score, pick: { kind: "expr", expr: `[${l.expr}.${objectExpr(entries)}]`, confidence: Number(Math.max(0.4, Math.min(0.95, score)).toFixed(2)), comment: `One ${target} entry for each item of ${l.path}${missed.length ? `. Not matched, add by hand: ${missed.join(", ")}` : ""}` } };
  }
  return best?.pick ?? null;
}

export function inferMapping(source: Json, desired: Json): InferredRule[] {
  if (!isObj(desired)) return [];
  const src = leaves(source);
  const rules: InferredRule[] = [];
  const add = (target: string, p: Pick) => rules.push({ id: `inf_${rules.length + 1}`, target, kind: p.kind, ...(p.source !== undefined ? { source: p.source } : {}), ...(p.expr !== undefined ? { expr: p.expr } : {}), ...(p.kind === "const" ? { value: p.value ?? null } : {}), comment: p.comment, enabled: true, confidence: p.confidence });
  const walk = (x: unknown, path: string, names: string[]) => {
    if (rules.length >= 300) return;
    if (isObj(x) && Object.keys(x).length) { for (const [k, v] of Object.entries(x)) walk(v, path ? `${path}.${k}` : k, [...names, k]); return; }
    if (Array.isArray(x) && x.length && x.every(isObj)) {
      const lr = listRule(path, x as Record<string, unknown>[], source);
      if (lr) { add(path, lr); return; }
      walk(x[0], `${path}[0]`, names); return;
    }
    if (!names.length) return;
    add(path, pick({ path, expr: "", name: tokens(names[names.length - 1]), ctx: names.slice(0, -1).flatMap(tokens), value: x }, src));
  };
  walk(desired, "", []);
  return rules;
}
