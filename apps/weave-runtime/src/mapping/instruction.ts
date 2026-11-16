// Plain-words mapping instructions -> JSONata. Deterministic and local: a rule-based interpreter,
// no network call. (Only when MODEL_URL is configured, an in-estate model may be asked after the
// rules fail; there is no default endpoint.)
//
// How it reads an instruction:
//   1. quoted text and date patterns are set aside so they are never interpreted;
//   2. field references are found: "(customer.name)", dotted paths, and names that match the
//      sample input ("first name" -> customer.firstName), tolerating small typos;
//   3. the sentence is parsed: lookup tables, if / otherwise, combinations of several fields,
//      then a pipeline of single steps ("trim and uppercase");
//   4. every word must be accounted for. If something is left over the answer is "not understood",
//      with what was understood and concrete rephrasings. It never guesses silently.
import type { CompileInstructionRequest, CompiledInstruction } from "@traceit/weave-flow";
import type { HttpClient } from "../clients/http.js";
import { checkExpr, FUNCTION_DOCS } from "../expr.js";

export interface CompileOutcome { ok: boolean; compiled: CompiledInstruction | null; understood: string[]; reason?: string; suggestions: string[]; fields: string[]; }
export interface ModelHook { modelUrl: string; http: HttpClient; }

// ------------------------------------------------------------------------------------------ expressions
type T = "string" | "number" | "boolean" | "array" | "object" | undefined;
interface X {
  e: string;            // JSONata
  np: string;           // noun phrase: what the value is
  p: number;            // precedence: 0 atom, 1 * /, 2 + -, 3 &, 4 comparison, 5 and/or, 6 ?:
  t?: T;                // type hint from the sample
  g?: boolean;          // contains a guess
  sent?: string;        // a full sentence, when the value is best explained that way
  vps?: string[];       // imperative steps applied to `base` ("convert it to upper case")
  base?: X;             // the field the steps apply to
  field?: string;       // set when this is a plain field
  lit?: boolean;        // a constant
  kind?: string;        // "words" for word-count conditions, "empty" for emptiness checks
  elemT?: T;            // element type when t is "array"
}
const q = (s: string) => JSON.stringify(s);
const w = (x: X, max: number) => (x.p > max ? `(${x.e})` : x.e);
const lit = (v: string | number | boolean | null): X => ({ e: typeof v === "string" ? q(v) : String(v), np: typeof v === "string" ? (v === "" ? "an empty text" : `"${v}"`) : String(v), p: 0, lit: true, t: v === null ? undefined : (typeof v as T) });
const show = (s: string) => (s === " " ? "a space" : s === "" ? "nothing" : s === "\t" ? "a tab" : s === "\n" ? "a line break" : s);
function step(s: X, e: string, np: string, vp: string, t?: T, p = 0): X {
  const base = s.base ?? (s.field ? s : undefined);
  return { e, np, p, t, g: s.g, base, vps: base ? [...(s.vps ?? []), vp] : undefined, sent: s.sent ? `${s.sent}. Then ${vp}` : undefined };
}
const str = (s: X) => (s.t === "number" || s.t === "boolean" ? `$string(${s.e})` : s.e);
const num = (s: X) => (s.t === "number" ? w(s, 0) : `$number(${s.e})`);
const WORDS = (s: X) => `$split($trim(${str(s)}), /\\s+/)`;

// ------------------------------------------------------------------------------------------ small vocabularies
const NUM_WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, a: 1, an: 1, single: 1, couple: 2, both: 2, double: 2, triple: 3 };
const NUM_NAMES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const N = "(\\d+(?:\\.\\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an|single)";
const toNum = (s: string): number => { const k = s.toLowerCase(); return k in NUM_WORDS ? NUM_WORDS[k] : Number(k.replace(/,/g, "")); };
const nWord = (n: number) => (Number.isInteger(n) && n >= 0 && n <= 12 ? NUM_NAMES[n] : String(n));
const ORDS: Record<string, number> = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, fifth: 4, "5th": 4, sixth: 5, "6th": 5, seventh: 6, "7th": 6, eighth: 7, "8th": 7, ninth: 8, "9th": 8, tenth: 9, "10th": 9, last: -1, final: -1, penultimate: -2, "second last": -2, "second to last": -2, "last but one": -2, "next to last": -2 };
const ORD = "(second to last|second last|last but one|next to last|penultimate|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final|\\d+(?:st|nd|rd|th))";
const toOrd = (s: string): number => { const k = s.toLowerCase(); if (k in ORDS) return ORDS[k]; return parseInt(k, 10) - 1; };
const ordName = (i: number) => (i === -1 ? "last" : i === -2 ? "second to last" : ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"][i] ?? `${i + 1}th`);
const CHARS: Record<string, string> = {
  space: " ", spaces: " ", blank: " ", whitespace: " ", underscore: "_", underscores: "_", "under score": "_", underline: "_", dash: "-", dashes: "-", hyphen: "-", hyphens: "-", minus: "-",
  comma: ",", commas: ",", dot: ".", dots: ".", period: ".", periods: ".", "full stop": ".", point: ".", slash: "/", slashes: "/", "forward slash": "/", backslash: "\\", pipe: "|", pipes: "|", "vertical bar": "|",
  colon: ":", colons: ":", semicolon: ";", semicolons: ";", tab: "\t", tabs: "\t", newline: "\n", "new line": "\n", "line break": "\n", plus: "+", "plus sign": "+", hash: "#", "at sign": "@", at: "@", ampersand: "&",
  asterisk: "*", star: "*", "comma and space": ", ", "comma space": ", ", "comma followed by space": ", ", "comma and a space": ", ", apostrophe: "'", apostrophes: "'", quote: '"', quotes: '"', "double quote": '"', "double quotes": '"', "single quote": "'", "single quotes": "'",
  bracket: "(", brackets: "()", parenthesis: "(", parentheses: "()", percent: "%", "percent sign": "%", dollar: "$", "dollar sign": "$", tilde: "~", "equals sign": "=", "equal sign": "=", nothing: "", "empty string": "", "no space": "", zero: "0", zeros: "0", zeroes: "0",
};
const EMPTY = "(?:empty|blank|missing|null|nil|none|absent|undefined|unset|unavailable|not\\s+(?:set|present|provided|there|given|available|specified|supplied|filled(?:\\s+in)?|populated|defined|sent|passed|known|found|existing))";
const CH = "(?:characters?|chars?|letters?|digits?|symbols?)";
const UNIT = "(days?|weeks?|months?|years?|hours?|minutes?|mins?|seconds?|secs?|nights?)";
const unitOf = (u: string) => { const k = u.toLowerCase().replace(/s$/, ""); return k === "min" ? "minutes" : k === "sec" ? "seconds" : k === "night" ? "days" : k + "s"; };
// leading filler: politeness, a generic verb, "it", "should be", "to/in/as"
const V = "(?:(?:please|kindly|just|simply|always|then|also|and|so|finally|next|now)\\s+)*(?:(?:convert|change|make|turn|transform|set|put|show|write|return|give|output|display|get|take|use|keep|leave|have|do|apply|perform|want|need|extract|pick|select|grab|fetch|calculate|compute|find|format|reformat|express|represent)\\s+)?(?:(?:it|this|that|them|value|result|field|text|string|output|input|one)\\s+)?(?:(?:should|must|needs?\\s+to|has\\s+to|have\\s+to|will|shall|to)\\s+)?(?:(?:be|is|are|become|becomes)\\s+)?(?:(?:converted|changed|made|turned|transformed|shown|written|returned|displayed|formatted|expressed)\\s+)?(?:(?:to|into|in|as|with|using|by)\\s+)?(?:(?:all|a|an)\\s+)?";
const TL = "(?:\\s+(?:always|only|too|as\\s+well|it|them|this|value|result|field|text|string|format|formatted|form|style|version|please|instead|also|here|of it|from it))*";
const rxCache = new Map<string, RegExp>();
function rx(src: string): RegExp {
  let r = rxCache.get(src);
  if (!r) {
    r = new RegExp("^" + src.replace(/\{V\}/g, V).replace(/\{T\}/g, TL).replace(/\{N\}/g, N).replace(/\{ORD\}/g, ORD).replace(/\{X\}/g, "(.+?)").replace(/\{F\}/g, "⟦f(\\d+)⟧").replace(/\{Q\}/g, "⟦q(\\d+)⟧").replace(/\{CH\}/g, CH).replace(/\{EMPTY\}/g, EMPTY).replace(/\{UNIT\}/g, UNIT).replace(/ /g, "\\s+") + "$", "i");
    rxCache.set(src, r);
  }
  return r;
}

// ------------------------------------------------------------------------------------------ context
interface FieldRef { path: string; t: T; elemT?: T; arr: boolean; how: "explicit" | "name" | "fuzzy" | "default" | "ambiguous"; said: string; root?: string; guess?: boolean; }
interface Lit { text: string; pattern: boolean; }
interface Ctx {
  fields: FieldRef[];             // placeholder ⟦fN⟧ -> field
  lits: Lit[];                    // placeholder ⟦qN⟧ -> quoted text or date pattern
  notes: string[];                // things worth telling the user ("read 'quantty' as 'quantity'")
  memo: Map<string, X | null>;
  budget: number;
  defaultSubject?: X;             // the field the sentence is about when it does not name one
  pool?: PathInfo[];              // every known path (sample + explicitly named)
  rel?: string;                   // inside "items where ...": paths are relative to this array
  needSubject?: boolean;          // parsing stopped because no field could be identified
  each?: { path: string; x: X };  // inside a rule decided item by item: this list field reads as one of its values
}
const L = "⟦", R = "⟧";
const ph = (i: number) => `${L}f${i}${R}`;
const fieldIds = (t: string): number[] => { const out: number[] = []; for (const m of t.matchAll(/⟦f(\d+)⟧/g)) if (!out.includes(+m[1])) out.push(+m[1]); return out; };
function fieldX(c: Ctx, i: number): X {
  const f = c.fields[i];
  if (c.each && f.path === c.each.path) return c.each.x;
  if (c.rel && (f.root ?? f.path).startsWith(c.rel + ".")) return { e: f.path.slice(c.rel.length + 1), np: f.path.slice(c.rel.length + 1), p: 0, t: f.elemT, field: f.path };
  return { e: f.path, np: f.root ? f.said : f.path, p: 0, t: f.t, elemT: f.elemT, field: f.path, g: f.guess };
}
function addField(c: Ctx, f: FieldRef): number {
  const i = c.fields.findIndex((x) => x.path === f.path);
  if (i >= 0) { if (f.how === "explicit") c.fields[i].how = "explicit"; return i; }
  c.fields.push(f); return c.fields.length - 1;
}

// ------------------------------------------------------------------------------------------ sample paths
interface PathInfo { path: string; segs: string[]; t: T; elemT?: T; arr: boolean; keys: string[]; }
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const seg = (s: string) => (IDENT.test(s) ? s : "`" + s.replace(/`/g, "") + "`");
const typeOf = (v: unknown): T => (Array.isArray(v) ? "array" : v === null || v === undefined ? undefined : typeof v === "object" ? "object" : (typeof v as T));
const splitWords = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").toLowerCase().trim().split(/\s+/).filter(Boolean);
const singular = (s: string) => (s.length > 3 && s.endsWith("ies") ? s.slice(0, -3) + "y" : s.length > 3 && s.endsWith("s") && !s.endsWith("ss") ? s.slice(0, -1) : s);
const norm = (words: string[]) => words.map(singular).join("");
export function samplePaths(sample: unknown): PathInfo[] {
  const out: PathInfo[] = []; const seen = new Set<string>();
  const walk = (v: unknown, segs: string[], underArray: boolean, depth: number) => {
    if (depth > 8 || out.length > 800) return;
    let node = v; let arr = underArray; let t = typeOf(v); let elemT: T;
    if (Array.isArray(v)) { arr = true; const first = v.find((x) => x !== null && x !== undefined); elemT = typeOf(first); node = first; }
    if (segs.length) {
      const path = segs.map(seg).join(".");
      if (!seen.has(path)) {
        seen.add(path);
        const ws = segs.map(splitWords);
        const keys = new Set<string>([norm(ws[ws.length - 1])]);
        if (ws.length > 1) keys.add(norm([...ws[ws.length - 2], ...ws[ws.length - 1]]));
        keys.add(norm(ws.flat()));
        if (underArray && !Array.isArray(v)) { elemT = t; t = "array"; }
        out.push({ path, segs, t, elemT, arr, keys: [...keys] });
      }
    }
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const merged: Record<string, unknown> = {};
      if (Array.isArray(v)) for (const item of v.slice(0, 5)) { if (item && typeof item === "object" && !Array.isArray(item)) for (const [k, val] of Object.entries(item)) if (merged[k] === undefined || merged[k] === null) merged[k] = val; }
      else Object.assign(merged, node);
      for (const [k, val] of Object.entries(merged)) walk(val, [...segs, k], arr, depth + 1);
    }
  };
  walk(sample, [], false, 0);
  return out;
}

// ------------------------------------------------------------------------------------------ typos
const VOCAB = new Set(("upper lower case uppercase lowercase capital capitals capitalize capitalise capitalized letters letter title proper trim trimmed strip spaces space whitespace remove delete drop replace swap substitute with by between "
  + "words word join joined split separated separator separate concatenate concat combine merge append prepend prefix suffix first last second third character characters chars digits digit numbers number numeric pad padded padding leading trailing zeros zeroes "
  + "left right default otherwise else unless when whenever then empty blank missing null equals equal contains contain starts start ends end greater less than more least most lookup translate means mean becomes stands "
  + "round rounded decimals decimal places nearest multiply multiplied divide divided subtract minus plus times percent percentage currency minor units cents amount format formatted reformat date dates time parse iso "
  + "year month day days weeks months years hours minutes seconds boolean true false yes count sum total average minimum maximum items item elements element list array unique distinct sort sorted reverse reversed "
  + "text string integer length truncate shorten limit maximum underscore hyphen dash comma dot slash pipe colon exactly only keep take everything before after part convert change make turn always constant value field "
  + "from into copy same unchanged initials absolute negative positive present available exists exist provided longer shorter").split(/\s+/));
const FIXES: [RegExp, string][] = [
  [/\bin[- ]?b[ei]twe+n\b/gi, "in between"], [/\bbetwen\b/gi, "between"], [/\bin-between\b/gi, "in between"], [/\bupper[- ]case/gi, "uppercase"], [/\blower[- ]case/gi, "lowercase"], [/\btitle[- ]case/gi, "titlecase"], [/\bproper[- ]case/gi, "titlecase"],
  [/\bcaps lock\b/gi, "uppercase"], [/\bisn'?t\b/gi, "is not"], [/\baren'?t\b/gi, "are not"], [/\bdoesn'?t\b/gi, "does not"], [/\bdon'?t\b/gi, "do not"], [/\bwasn'?t\b/gi, "was not"], [/\bhasn'?t\b/gi, "has not"], [/\bit'?s\b/gi, "it is"],
  [/\bthere'?s\b/gi, "there is"], [/\bw\/o\b/gi, "without"], [/\bw\/\s/gi, "with "], [/\bb\/w\b/gi, "between"], [/\bchar\b/gi, "character"], [/\bnos?\.\s*of\b/gi, "number of"], [/\b#\s*of\b/gi, "number of"], [/\bseperat/gi, "separat"], [/\bconcatinat/gi, "concatenat"],
  [/\bcapitol/gi, "capital"], [/\blenght\b/gi, "length"], [/\bfrist\b/gi, "first"], [/\bfisrt\b/gi, "first"], [/\bundescore\b/gi, "underscore"], [/\bunderscor\b/gi, "underscore"], [/\bcharecters?\b/gi, "characters"], [/\bcharcters?\b/gi, "characters"],
  [/\botherwize\b/gi, "otherwise"], [/\bothrwise\b/gi, "otherwise"], [/\bdefualt\b/gi, "default"], [/\bformate\b/gi, "format"], [/\bwhitespaces\b/gi, "whitespace"], [/\bcame in\b/gi, "came"], [/\bcomes in\b/gi, "comes"], [/\be\.g\.\s*/gi, ""], [/\bi\.e\.\s*/gi, ""],
];
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; for (let j = 1; j <= b.length; j++) d[i][j] = i === 0 ? j : 0; }
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
function nearest(word: string, pool: Iterable<string>): string | undefined {
  const lw = word.toLowerCase(); if (lw.length < 4) return undefined;
  const max = lw.length >= 8 ? 2 : 1; let best: string | undefined; let bestD = max + 1; let tie = false;
  for (const v of pool) { if (v.length < 4) continue; const dist = editDistance(lw, v, max); if (dist < bestD) { best = v; bestD = dist; tie = false; } else if (dist === bestD && v !== best) tie = true; }
  return best && bestD <= max && !tie ? best : undefined;
}

// ------------------------------------------------------------------------------------------ reading: quoted text and date patterns
const STOP = new Set(("a an the of to in on at by for with from as is are was were be been it its this that these those then than and or not no if when unless else otherwise do does did has have had "
  + "will shall should must can could would may i we you they them he she my our your their so but also only just all any each every some into onto out up down off over under again more most less least very too which what who whose where there here").split(" "));
// Words that belong to the instruction vocabulary but are also everyday field names. They are read as
// vocabulary first; if that leads nowhere they are tried as fields.
const INTENT = new Set(("first last second third fourth fifth date time count sum total number text string value length title upper lower case word words character characters space spaces day days month months year years "
  + "week hour minute default format prefix suffix separator list array item items element elements part parts average minimum maximum min max size position index age initials domain percent percentage boolean flag "
  + "integer decimal decimals digits digit letters letter name names start end result output input source target field type amount key code status empty blank true false yes").split(" "));
const SOFT_INTENT = new Set("name names amount key code status type start end result".split(" ")); // field first, vocabulary second
const DATE_TOKENS = "(?:[yY]{2,4}|M{1,4}|m{1,2}|[dD]{1,2}|[hH]{1,2}|[sS]{1,3}|E{3,4})";
const BARE_PATTERN = new RegExp(`(?<![\\w${L}'"])${DATE_TOKENS}(?:[\\/\\-.: T]?(?:${DATE_TOKENS}|a\\b|Z\\b))+(?![\\w])`, "g");
const PATTERN_CHARS = new RegExp(`^(?:${DATE_TOKENS}|a|Z|T|'[^']*'|[\\/\\-.: ,])+$`);
function isDatePattern(s: string, quoted: boolean): boolean {
  if (!PATTERN_CHARS.test(s) || !/[yY]{2}|M{2}|[dD]{2}|E{3}|H{2}|h{2}/.test(s)) return false;
  if (quoted) return true;
  const groups = s.split(/[\/\-.: ,T]+/).filter(Boolean).length;
  if (!/[yY]{2}|[dD]{2}/.test(s)) return /^[Hh]{1,2}:mm(?::ss)?(?: a)?$/.test(s);
  return (/[\/\-.:]/.test(s) && groups >= 2) || (groups >= 3 && /[yY]{2}/.test(s)) || (groups === 1 && s.length >= 6);
}
function readLiterals(raw: string): { text: string; lits: Lit[] } {
  const lits: Lit[] = [];
  const put = (text: string, pattern: boolean) => { lits.push({ text, pattern }); return `${L}q${lits.length - 1}${R}`; };
  let t = raw.replace(/[“”„«»]/g, '"').replace(/[‘’´]/g, "'").replace(/→|⇒/g, "->").replace(/[–—]/g, "-").replace(/ /g, " ").replace(/[⟦⟧]/g, " ").replace(/\s*\r?\n+\s*/g, ", ");
  t = t.replace(/"([^"]*)"/g, (_m, s: string) => put(s, isDatePattern(s, true)));
  t = t.replace(/(^|[^A-Za-z0-9])'([^']*)'(?![A-Za-z0-9])/g, (_m, pre: string, s: string) => pre + put(s, isDatePattern(s, true)));
  t = t.replace(BARE_PATTERN, (m) => (isDatePattern(m, false) ? put(m, true) : m));
  for (const [re, to] of FIXES) t = t.replace(re, to);
  t = t.replace(/(\d)\s*%/g, "$1 percent").replace(/\b(?:the|please|kindly|basically|actually|pls|plz)\b\s*/gi, "").replace(/\s+/g, " ").trim();
  return { text: t, lits };
}

// ------------------------------------------------------------------------------------------ reading: which fields are meant
interface Cand { start: number; end: number; said: string; info: PathInfo; intent: boolean; soft: boolean; alts: string[]; }
function pickPath(infos: PathInfo[], preferred: Set<string>, target?: string): { best: PathInfo; alts: string[] } {
  const tw = new Set(target ? target.split(/[.\[\]]+/).filter(Boolean).slice(0, -1).flatMap(splitWords).map(singular) : []);
  const score = (p: PathInfo) => (preferred.has(p.path) ? 1000 : 0) + (p.t !== "object" ? 20 : 0) + (p.segs.slice(0, -1).flatMap(splitWords).some((x) => tw.has(singular(x))) ? 5 : 0) + (p.arr ? 0 : 2) - p.segs.length;
  const uniq = [...new Map(infos.map((p) => [p.path, p])).values()].sort((a, b) => score(b) - score(a));
  const top = score(uniq[0]);
  return { best: uniq[0], alts: uniq.slice(1).filter((p) => score(p) === top).map((p) => p.path) };
}
function findCandidates(text: string, pool: PathInfo[], preferred: Set<string>, target?: string): Cand[] {
  const words: { w: string; i: number; j: number }[] = [];
  const re = /[A-Za-z][A-Za-z0-9_]*/g; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) { if (text[m.index - 1] === L) continue; words.push({ w: m[0], i: m.index, j: m.index + m[0].length }); }
  const byKey = new Map<string, PathInfo[]>();
  for (const p of pool) for (const k of p.keys) { const a = byKey.get(k); if (a) a.push(p); else byKey.set(k, [p]); }
  const out: Cand[] = [];
  for (let a = 0; a < words.length;) {
    let hit: Cand | undefined; let used = 1;
    for (let n = Math.min(4, words.length - a); n >= 1 && !hit; n--) {
      const ws = words.slice(a, a + n);
      let contiguous = true;
      for (let k = 1; k < n; k++) if (!/^(?:'s)?[\s-]+$/.test(text.slice(ws[k - 1].j, ws[k].i))) contiguous = false;
      if (!contiguous) continue;
      const lows = ws.map((x) => x.w.toLowerCase());
      if (lows.every((x) => STOP.has(x))) continue;
      if (n > 1 && (STOP.has(lows[0]) || (STOP.has(lows[n - 1]) && !/^(?:in|out|on|off|up|down|by|at|from|to)$/.test(lows[n - 1])))) continue;
      const keys = [norm(ws.flatMap((x) => splitWords(x.w)))];
      if (n === 3 && lows[1] === "of") keys.push(norm([...splitWords(ws[2].w), ...splitWords(ws[0].w)]));
      const infos = keys.flatMap((k) => byKey.get(k) ?? []);
      if (!infos.length) continue;
      const { best, alts } = pickPath(infos, preferred, target);
      const intent = lows.every((x) => STOP.has(x) || INTENT.has(x));
      let end = ws[n - 1].j; used = n;
      const nx = words[a + n];
      if (nx && best.t !== "object" && /^(?:number|no|date|code|id)$/i.test(nx.w) && /^\s+$/.test(text.slice(end, nx.i)) && !/^\s+of\b/i.test(text.slice(nx.j))) { end = nx.j; used = n + 1; }
      hit = { start: ws[0].i, end, said: text.slice(ws[0].i, end), info: best, intent, soft: intent && lows.some((x) => SOFT_INTENT.has(x)), alts };
    }
    if (hit) out.push(hit);
    a += used;
  }
  return out;
}
/** Explicit references: `name`, dotted.paths, "(name)" and the "(path)" suffix that says what the sentence is about. */
function readExplicit(c: Ctx, text: string, paths: PathInfo[]): string {
  const byPath = new Map(paths.map((p) => [p.path, p]));
  const fromInfo = (info: PathInfo, said: string, how: FieldRef["how"] = "explicit"): FieldRef => ({ path: info.path, t: info.t, elemT: info.elemT, arr: info.arr, how, said });
  const lookup = (said: string): FieldRef => {
    const p = said.replace(/^\$\.?/, "").replace(/\.$/, "");
    let info = byPath.get(p);
    if (!info && paths.length) {
      const key = norm(p.split(/[.[\]]+/).filter(Boolean).flatMap(splitWords));
      info = paths.find((x) => x.path.toLowerCase() === p.toLowerCase()) ?? paths.find((x) => norm(x.segs.flatMap(splitWords)) === key);
      if (!info) { const m = /^(?:payload|input|source|body|data|request)\.(.+)$/i.exec(p); if (m) info = byPath.get(m[1]); }
      if (!info && !/\[\d+\]/.test(p)) {
        const near = nearest(p.toLowerCase(), paths.map((x) => x.path.toLowerCase()));
        const hit = near ? paths.find((x) => x.path.toLowerCase() === near) : undefined;
        if (hit) { c.notes.push(`"${said}" is not in the sample input; read it as ${hit.path}`); return fromInfo(hit, said, "fuzzy"); }
      }
    }
    if (info) return fromInfo(info, said);
    if (paths.length && !/\[\d+\]/.test(p)) c.notes.push(`"${said}" is not in the sample input`);
    return { path: p, t: undefined, arr: false, how: "explicit", said };
  };
  let t = text.replace(/`([^`]+)`/g, (_m, s: string) => ph(addField(c, lookup(s.trim()))));
  t = t.replace(/(?<![\w⟧.$])\$?\.?[A-Za-z_]\w*(?:\[\d+\])?(?:\.[A-Za-z_]\w*(?:\[\d+\])?)+(?![\w(])/g, (m) => ph(addField(c, lookup(m))));
  t = t.replace(/\(\s*([A-Za-z_]\w*)\s*\)/g, (m, wd: string) => {
    const key = norm(splitWords(wd)); const hit = paths.filter((p) => p.keys.includes(key));
    if (hit.length) return `(${ph(addField(c, fromInfo(pickPath(hit, new Set()).best, wd)))})`;
    const lw = wd.toLowerCase();
    if (!paths.length && !VOCAB.has(lw) && !STOP.has(lw) && !INTENT.has(lw)) return `(${ph(addField(c, { path: wd, t: undefined, arr: false, how: "explicit", said: wd }))})`;
    return m;
  });
  const declared: number[] = [];
  t = t.replace(/\(\s*(⟦f\d+⟧(?:\s*(?:,|and|&)\s*⟦f\d+⟧)*)\s*\)/g, (_m, inner: string) => { for (const id of fieldIds(inner)) if (!declared.includes(id)) declared.push(id); return " "; });
  if (declared.length === 1) c.defaultSubject = fieldX(c, declared[0]);
  else if (declared.length > 1) { const missing = declared.filter((id) => !t.includes(ph(id))); if (missing.length) t += " " + missing.map(ph).join(" and "); }
  return t.replace(/\s+/g, " ").trim();
}
function applyCandidates(c: Ctx, text: string, cands: Cand[], allow: (cd: Cand, i: number) => boolean): string {
  let t = text;
  for (let i = cands.length - 1; i >= 0; i--) {
    const cd = cands[i]; if (!allow(cd, i)) continue;
    const id = addField(c, { path: cd.info.path, t: cd.info.t, elemT: cd.info.elemT, arr: cd.info.arr, how: cd.alts.length ? "ambiguous" : "name", said: cd.said });
    if (cd.alts.length) c.notes.push(`"${cd.said}" could be ${[cd.info.path, ...cd.alts].join(" or ")}; used ${cd.info.path}. Add the one you mean in brackets, for example (${cd.alts[0]})`);
    t = t.slice(0, cd.start) + ph(id) + t.slice(cd.end);
  }
  return t;
}
// Ordinary words that sit one letter away from common field names ("came" / "name", "data" / "date").
// They are never treated as misspellings.
const EVERYDAY = new Set(("came come comes coming same some none done gone goes went sent send made make makes take takes taken took keep kept keeps like liked give gives given gave show shows shown want wants need needs "
  + "data here there their them they both such also much many must into onto from have having been being were will well only once even ever back down away long short good best real full line lines side site note notes "
  + "came call calls called used uses user users item mine fine find found kind king hand land band sand rate late gate mate fate dates named names timed times coded codes typed types cost costs case cases").split(" "));
function fixTypos(text: string, pool: PathInfo[], notes: string[]): string {
  const leaf = new Set<string>();
  for (const p of pool) for (const wd of splitWords(p.segs[p.segs.length - 1])) if (wd.length >= 4) leaf.add(wd);
  return text.replace(/[A-Za-z][A-Za-z']*/g, (wd: string, off: number) => {
    if (text[off - 1] === L) return wd;
    const lw = wd.toLowerCase();
    if (lw.length < 4 || EVERYDAY.has(lw) || STOP.has(lw) || VOCAB.has(lw) || INTENT.has(lw) || lw in NUM_WORDS || lw in CHARS || lw in ORDS || leaf.has(lw) || leaf.has(singular(lw)) || VOCAB.has(singular(lw))) return wd;
    const fixed = nearest(lw, leaf) ?? nearest(lw, VOCAB);
    if (!fixed) return wd;
    notes.push(`read "${wd}" as "${fixed}"`);
    return fixed;
  });
}

// ------------------------------------------------------------------------------------------ arguments: literals, values, numbers
const BARE_STOP = new Set("and or if then else otherwise when unless is are was were not with without to of in on by for from as it them this that be should must than use keep make set return send times plus minus divided multiplied".split(" "));
function clean(t: string): string {
  return t.replace(/\s+/g, " ").trim().replace(/(?<=[\w⟧"')])[.!?]+$/, "").replace(/^[,;:\s]+/, "").replace(/[,;:\s]+$/, "").trim();
}
/** A separator / character / piece of text: "x", underscore, a space, _ */
function litText(c: Ctx, raw: string): string | null {
  const t = raw.trim().replace(/^(?:an?|single|one|each|every|just)\s+/i, "").replace(/\s+(?:characters?|chars?|signs?|symbols?|marks?)$/i, "").trim();
  const m = /^⟦q(\d+)⟧$/.exec(t); if (m) return c.lits[+m[1]].text;
  const k = t.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CHARS, k)) return CHARS[k];
  if (/^[^\sA-Za-z0-9⟦⟧]{1,3}$/.test(t)) return t;
  return null;
}
/** A value written in the sentence: "text", 12, true, a field, and (when `bare`) an unquoted word such as Unknown or N/A. */
function valArg(c: Ctx, raw: string, bare: boolean): X | null {
  const t = raw.trim().replace(/^(?:value|text|word|string|literal|constant|fixed value|number)\s+(?=⟦q|-?\d)/i, "").replace(/^(?:an?)\s+(?=⟦q)/i, "");
  let m = /^⟦q(\d+)⟧$/.exec(t); if (m) return lit(c.lits[+m[1]].text);
  m = /^(?:(?:value of|value in|contents? of|field|value from)\s+)?⟦f(\d+)⟧(?:\s+(?:field|value))?$/i.exec(t); if (m) return fieldX(c, +m[1]);
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return lit(Number(t));
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) return lit(Number(t.replace(/,/g, "")));
  if (t === "true" || t === "false" || t === "TRUE" || t === "FALSE" || t === "True" || t === "False") return lit(t.toLowerCase() === "true");
  if (t === "null" || t === "NULL") return { e: "null", np: "null", p: 0, lit: true };
  if (/^(?:(?:an?\s+)?(?:empty|blank)(?:\s+(?:string|text|value))?|nothing|none)$/.test(t)) return lit("");
  if (/^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/.test(t)) return lit(NUM_WORDS[t]);
  if (!bare) return null;
  if (!/^[A-Za-z0-9+#@$][\w.\/#&+'-]*(?:\s+[A-Za-z0-9][\w.\/#&+'-]*){0,2}$/.test(t)) return null;
  const ws = t.split(/\s+/);
  if (ws.some((x) => BARE_STOP.has(x))) return null;
  const x = lit(t);
  if (ws.length > 1 && ws.every((y) => y === y.toLowerCase())) x.g = true;
  return x;
}
/** A numeric operand: a number, or a field / value read as a number. */
function numArg(c: Ctx, raw: string, subj?: X): X | null {
  const t = raw.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return lit(Number(t));
  if (/^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/i.test(t)) return lit(NUM_WORDS[t.toLowerCase()]);
  const m = /^(hundred|thousand|million)$/i.exec(t); if (m) return lit(m[1].toLowerCase() === "hundred" ? 100 : m[1].toLowerCase() === "thousand" ? 1000 : 1000000);
  const v = parseValue(c, t, subj);
  if (!v || (v.lit && v.t !== "number")) return null;
  return v.t === "number" ? v : { ...v, e: `$number(${v.e})`, p: 0, t: "number" };
}
const G = (...xs: (X | null | undefined)[]): boolean | undefined => (xs.some((x) => x?.g) ? true : undefined);
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
const fieldOf = (x?: X | null): X | undefined => { let y = x ?? undefined; while (y?.base) y = y.base; return y; };
const at = (s: X, i: number) => (s.p > 0 || /[.\s]/.test(s.e) ? `(${s.e})[${i}]` : `${s.e}[${i}]`);
const fmt = (n: number) => String(Number(n.toFixed(6)));
const NOW: X = { e: "$now()", np: "the current date and time", p: 0, t: "string" };
const TODAY: X = { e: '$formatDate($now(), "yyyy-MM-dd")', np: "today's date", p: 0, t: "string" };
/** Any value: a literal, a field (possibly with steps: "uppercase first name"), now / today, "it". */
function parseValue(c: Ctx, raw: string, subj?: X): X | null {
  const t = clean(raw); if (!t) return null;
  const v = valArg(c, t, false); if (v) return v;
  if (/^(?:now|right now|current (?:time|date ?time|timestamp|date and time))$/i.test(t)) return NOW;
  if (/^(?:today|todays date|today's date|current date)$/i.test(t)) return TODAY;
  if (/^(?:it|this|that|itself|same|same value|original|original value|its value|as is|as it is)$/i.test(t)) return subj ?? c.defaultSubject ?? null;
  if (fieldIds(t).length) return parseSingle(c, t, subj);
  return null;
}
/** Quoted text, a character name, a field, or one bare token: something to put next to a value. */
function textArg(c: Ctx, raw: string): X | null {
  const v = valArg(c, raw, false); if (v) return v;
  const l = litText(c, raw); if (l !== null) return lit(l);
  return /\s/.test(raw.trim()) ? null : valArg(c, raw, true);
}

// ------------------------------------------------------------------------------------------ conditions
const cxCache = new Map<string, RegExp>();
function cx(src: string): RegExp {
  let r = cxCache.get(src);
  if (!r) {
    r = new RegExp("^" + src.replace(/\{S\}/g, "(?<s>.*?)").replace(/\{N\}/g, "(?<n>" + N.slice(1)).replace(/\{X\}/g, "(?<x>.+?)").replace(/\{Y\}/g, "(?<y>.+?)").replace(/\{CH\}/g, CH).replace(/\{EMPTY\}/g, EMPTY).replace(/\{QTY\}/g, QTY).replace(/ /g, "\\s+") + "$", "i");
    cxCache.set(src, r);
  }
  return r;
}
const QTY = "(?<mod> exactly| only| just| more than| over| at least| a minimum of| minimum| fewer than| less than| under| at most| up to| no more than| a maximum of| maximum| not)?";
function qop(mod?: string, tail?: string): [string, string] {
  const k = (mod ?? "").trim().toLowerCase(); const tl = (tail ?? "").trim().toLowerCase();
  if (/^or (?:more|longer|above|over|higher|greater|later)$|^\+$|^and (?:above|over|more)$/.test(tl)) return [">=", "at least"];
  if (/^or (?:fewer|less|shorter|below|under|lower|earlier)$|^and (?:below|under|less)$/.test(tl)) return ["<=", "at most"];
  if (k === "more than" || k === "over") return [">", "more than"];
  if (k === "at least" || k === "a minimum of" || k === "minimum") return [">=", "at least"];
  if (k === "fewer than" || k === "less than" || k === "under") return ["<", "fewer than"];
  if (k === "at most" || k === "up to" || k === "no more than" || k === "a maximum of" || k === "maximum") return ["<=", "at most"];
  if (k === "not") return ["!=", "not"];
  return ["=", "exactly"];
}
const cond = (s: X, e: string, np: string, kind?: string, p = 4, g?: boolean): X => ({ e, np, p, t: "boolean", base: s, kind, g: g || s.g });
const LIST_KINDS = new Set(["empty", "nonempty", "list"]);   // conditions about a list as a whole, not about each of its values
const negate = (x: X, np: string): X => ({ ...x, e: `$not(${x.e})`, np, p: 0, kind: x.kind === "empty" ? "nonempty" : x.kind === "nonempty" ? "empty" : x.kind === "list" ? "list" : undefined });
function subjOf(c: Ctx, raw: string | undefined, subj?: X): X | null {
  const t = clean(raw ?? "").replace(/\s+(?:value|field)$/i, "").replace(/^(?:value (?:of|in)|field)\s+/i, "");
  if (!t || /^(?:it|this|that|value|they|there|input|field|its value|one|result|text|string)$/i.test(t)) { const s = subj ?? c.defaultSubject; if (!s) c.needSubject = true; return s ?? null; }
  if (/(?:^|\s)(?:is|are|was|were|not|has|have|does|do|no|if|when|and|or)$/i.test(t)) return null;
  const m = /^⟦f(\d+)⟧$/.exec(t); if (m) return fieldX(c, +m[1]);
  if (fieldIds(t).length) return parseSingle(c, t, subj);
  const s = subj ?? c.defaultSubject; if (!s) return null;
  const r = oneStep(c, t, s);
  return r && r.e !== s.e ? r : null;
}
function classRe(raw: string): [string, string] | null {
  const k = raw.trim().toLowerCase().replace(/^(?:an?|any|some)\s+/, "");
  if (/^(?:digits?|numbers?|numeric characters?)$/.test(k)) return ["/[0-9]/", "a digit"];
  if (/^(?:letters?|alphabets?|alphabetic characters?)$/.test(k)) return ["/[A-Za-z]/", "a letter"];
  if (/^(?:spaces?|whitespaces?|blanks?)$/.test(k)) return ["/\\s/", "a space"];
  if (/^(?:special characters?|symbols?|punctuation)$/.test(k)) return ["/[^A-Za-z0-9\\s]/", "a special character"];
  if (/^(?:uppercase|capital|upper case) letters?$/.test(k)) return ["/[A-Z]/", "an upper-case letter"];
  if (/^(?:lowercase|small|lower case) letters?$/.test(k)) return ["/[a-z]/", "a lower-case letter"];
  return null;
}
type CondFn = (g: Record<string, string | undefined>, sub: (raw?: string) => X | null, c: Ctx, subj?: X) => X | null;
const numL = (s: X) => (s.t === "number" ? w(s, 3) : `$number(${s.e})`);
const CONDS: [string, CondFn][] = [
  // "came as two words", "has more than one word", "is a single word"
  ["{S}(?: (?:is|are|was|has|have|had|came|comes|come|contains|contain|consists of|holds|includes|arrives|arrived|is made of|is made up of|having|with|got))?(?: (?:as|in|of|only|just|a|an))*{QTY} (?<n>" + N.slice(1, -1) + "|multiple|several|many|two or more|more than one)(?<tail> or more| or fewer| or less|\\+)? (?:separate |distinct |different )?words?(?<tail2> or more| or fewer| or less| long| only| exactly| in it)?", (g, sub) => {
    const s = sub(g.s); if (!s) return null;
    const k = g.n!.toLowerCase().replace(/\s+/g, " ");
    let [op, words] = qop(g.mod, g.tail ?? g.tail2); let n: number;
    if (k === "multiple" || k === "several" || k === "many" || k === "more than one") { op = ">"; words = "more than"; n = 1; } else if (k === "two or more") { op = ">="; words = "at least"; n = 2; } else n = toNum(k);
    return cond(s, `$count(${WORDS(s)}) ${op} ${n}`, `${s.np} ${op === "!=" ? "does not have exactly" : "has " + words} ${nWord(n)} word${n === 1 ? "" : "s"}`, "words");
  }],
  // present / not empty
  ["{S}(?: (?:is|are|was|were|has been|have been|does|do|did))?(?: (?:actually|really|also))? (?:not (?:empty|blank|missing|null|nil|none|absent|undefined|unset)|present|available|provided|given|set|there|populated|filled|filled in|specified|supplied|defined|known|non-?empty|nonempty|exists|exist|existing|sent|passed|found|has a value|has value|has any value|has some value|has data|has content|has text|has something|contains a value|contains something|contains data|not nothing)", (g, sub) => {
    const s = sub(g.s); return s ? cond(s, `$not($isEmpty(${s.e}))`, `${s.np} has a value`, "nonempty", 0) : null;
  }],
  ["(?: there (?:is|are|was)| we have| we got)(?: (?:a|an|any|some))? (?<x>.+?)", (g, sub) => { if (!fieldIds(g.x!).length) return null; const s = sub(g.x); return s ? cond(s, `$not($isEmpty(${s.e}))`, `${s.np} has a value`, "nonempty", 0) : null; }],
  // empty / missing
  ["{S}(?: (?:is|are|was|were|comes|came|arrives|seems|looks|be|has been|have been))?(?: (?:left|still|completely|totally))? {EMPTY}", (g, sub) => { const s = sub(g.s); return s ? cond(s, `$isEmpty(${s.e})`, `${s.np} is empty or missing`, "empty", 0) : null; }],
  ["{S} (?:(?:does not|do not|did not) (?:exist|have a value|have any value|have value|contain anything|contain a value|have data|have anything|come|arrive)|(?:has|have|had|with|contains|got) (?:no|not any|not a) (?:value|data|content|text|values|items|entries|elements|characters))", (g, sub) => { const s = sub(g.s); return s ? cond(s, `$isEmpty(${s.e})`, `${s.np} is empty or missing`, "empty", 0) : null; }],
  ["(?: there (?:is|are|was))? no (?<x>.+?)(?: (?:at all|given|provided|present|available|set))?", (g, sub) => { if (!fieldIds(g.x!).length) return null; const s = sub(g.x); return s ? cond(s, `$isEmpty(${s.e})`, `${s.np} is empty or missing`, "empty", 0) : null; }],
  // length
  ["{S}(?: (?:is|has|are|have|contains))?(?: (?:a )?length(?: of| is)?)?{QTY} {N} {CH}(?<tail> long| or more| or longer| or less| or fewer| or shorter| in length)?", (g, sub) => {
    const s = sub(g.s); if (!s) return null; const [op, words] = qop(g.mod, g.tail); const n = toNum(g.n!);
    return cond(s, `$length(${str(s)}) ${op} ${n}`, `${s.np} is ${words} ${n} character${n === 1 ? "" : "s"} long`);
  }],
  ["{S}(?: (?:is|are))? (?<w>longer|shorter) than {N}(?: {CH})?", (g, sub) => { const s = sub(g.s); if (!s) return null; const n = toNum(g.n!); return cond(s, `$length(${str(s)}) ${g.w!.toLowerCase() === "longer" ? ">" : "<"} ${n}`, `${s.np} is ${g.w!.toLowerCase()} than ${n} characters`); }],
  // number of items
  ["{S} (?:has|have|contains|contain|holds|with|having){QTY} (?<n>" + N.slice(1, -1) + "|multiple|several|many|any|no)(?<tail> or more| or fewer)? (?:items?|elements?|entries|records|rows|values|members|lines)", (g, sub) => {
    const s = sub(g.s); if (!s) return null; const k = g.n!.toLowerCase();
    let [op, words] = qop(g.mod, g.tail); let n: number;
    if (k === "multiple" || k === "several" || k === "many") { op = ">"; words = "more than"; n = 1; } else if (k === "any") { op = ">"; words = "more than"; n = 0; } else if (k === "no") { op = "="; words = "exactly"; n = 0; } else n = toNum(k);
    return cond(s, `$count(${s.e}) ${op} ${n}`, `${s.np} has ${words} ${nWord(n)} item${n === 1 ? "" : "s"}`, "list");
  }],
  ["{S}(?: (?:is|are|was|lies|falls|value))? (?:between|in range|within range|in range of|within) {X} (?:and|to|-) {Y}(?: inclusive)?", (g, sub, c, subj) => {
    const s = sub(g.s); if (!s) return null; const a = numArg(c, g.x!, subj), b = numArg(c, g.y!, subj); if (!a || !b) return null;
    return cond(s, `${numL(s)} >= ${w(a, 3)} and ${numL(s)} <= ${w(b, 3)}`, `${s.np} is between ${a.np} and ${b.np}`, undefined, 5.1, G(a, b));
  }],
  ["{S}(?: (?:is|are|was))?(?: (?:in|already))? (?<w>past|future|passed|expired|overdue|upcoming|before today|before now|after today|after now|earlier than today|later than today)", (g, sub) => {
    const s = sub(g.s); if (!s) return null; const past = /past|passed|expired|overdue|before|earlier/i.test(g.w!);
    return cond(s, `$epochMillis(${s.e}) ${past ? "<" : ">"} $millis()`, `${s.np} is in the ${past ? "past" : "future"}`);
  }],
  ["{S}(?: (?:is|are|was))?(?: (?:a|an))? (?<w>positive|negative|zero|non-?zero|nonzero|even|odd)(?: (?:number|value))?", (g, sub) => {
    const s = sub(g.s); if (!s) return null; const k = g.w!.toLowerCase(); const n = numL(s);
    const e = k === "positive" ? `${n} > 0` : k === "negative" ? `${n} < 0` : k === "zero" ? `${n} = 0` : k === "even" ? `${n} % 2 = 0` : k === "odd" ? `${n} % 2 = 1` : `${n} != 0`;
    return cond(s, e, `${s.np} is ${k === "nonzero" || k === "non-zero" || k === "non zero" ? "not zero" : k}`);
  }],
  // comparisons (numbers and dates)
  ["{S}(?: (?:is|are|was|were|has|value|comes|falls))?(?<not> not)? (?<op>greater than or equal to|more than or equal to|equal to or greater than|equal to or more than|at least|no less than|not less than|minimum|>=|=>|greater than|more than|bigger than|larger than|higher than|above|over|exceeds|exceeding|beyond|>|less than or equal to|equal to or less than|at most|no more than|not more than|maximum|up to|<=|=<|less than|smaller than|lower than|below|under|fewer than|<|on or after|after|later than|since|on or before|before|earlier than|prior to|until) {X}", (g, sub, c, subj) => {
    const s = sub(g.s); if (!s) return null; const k = g.op!.toLowerCase().replace(/\s+/g, " ");
    const date = /after|later|since|before|earlier|prior|until/.test(k);
    const op = /(?:less|smaller|lower|fewer) than or equal|equal to or (?:less|smaller|lower)|at most|no more|not more|maximum|up to|<=|=<|on or before|until/.test(k) ? "<=" : /or equal|equal to or|at least|no less|not less|minimum|>=|=>|on or after|since/.test(k) ? ">=" : /greater|more|bigger|larger|higher|above|over|exceed|beyond|>|after|later/.test(k) ? ">" : "<";
    const words = op === ">=" ? "at least" : op === "<=" ? "at most" : op === ">" ? (date ? "after" : "greater than") : (date ? "before" : "less than");
    let r: X | null = null;
    if (date) {
      const v = parseValue(c, g.x!, subj); if (!v) return null;
      const rhs = v === NOW || v === TODAY ? "$millis()" : `$epochMillis(${v.e})`;
      r = cond(s, `$epochMillis(${s.e}) ${op} ${rhs}`, `${s.np} is ${op === ">=" ? "on or after" : op === "<=" ? "on or before" : words} ${v.np}`, undefined, 4, G(v));
    } else {
      const v = numArg(c, g.x!, subj); if (!v) return null;
      r = cond(s, `${numL(s)} ${op} ${w(v, 3)}`, `${s.np} is ${words} ${v.np}`, undefined, 4, G(v));
    }
    return g.not ? negate(r, `it is not true that ${r.np}`) : r;
  }],
  ["{S}(?: (?:is|are|was|were|=|equals))? {X}(?<tail> or more| or above| or over| or higher| or greater| or less| or below| or under| or lower| and above| and over| and below| and under|\\+)", (g, sub, c, subj) => {
    const s = sub(g.s); if (!s) return null; const v = numArg(c, g.x!, subj); if (!v) return null; const [op, words] = qop(undefined, g.tail!.replace(/and /i, "or ").replace(/or (?:above|over|higher|greater)/i, "or more").replace(/or (?:below|under|lower)/i, "or less"));
    return cond(s, `${numL(s)} ${op} ${w(v, 3)}`, `${s.np} is ${words} ${v.np}`, undefined, 4, G(v));
  }],
  // contains / starts with / ends with
  ["{S}(?: (?:is|are))?(?<not> does not| do not| did not| doesnt| never| not)? (?:contains?|includes?|containing|including|mentions?|has substring|has text|has word|has letter|has character) {X}", (g, sub, c, subj) => {
    const s = sub(g.s); if (!s) return null; let r: X | null = null; const cls = classRe(g.x!);
    if (cls) r = cond(s, `$contains(${str(s)}, ${cls[0]})`, `${s.np} contains ${cls[1]}`, undefined, 0);
    else {
      const v = valArg(c, g.x!, true) ?? (litText(c, g.x!) !== null ? lit(litText(c, g.x!)!) : parseValue(c, g.x!, subj)); if (!v) return null;
      r = s.t === "array" ? cond(s, `${w(v, 3)} in ${w(s, 3)}`, `${s.np} includes ${v.np}`, "list", 4, G(v)) : cond(s, `$contains(${str(s)}, ${str(v)})`, `${s.np} contains ${v.np}`, undefined, 0, G(v));
    }
    return g.not ? negate(r, r.np.replace(/ contains | includes /, " does not contain ")) : r;
  }],
  ["{S} (?:has|have|having|with)(?<not> no| not)? {X}", (g, sub, c) => {
    const cls = classRe(g.x!); const l = cls ? null : litText(c, g.x!);
    if (!cls && (l === null || l === "")) return null;
    const s = sub(g.s); if (!s) return null;
    const r = cls ? cond(s, `$contains(${str(s)}, ${cls[0]})`, `${s.np} contains ${cls[1]}`, undefined, 0) : cond(s, `$contains(${str(s)}, ${q(l!)})`, `${s.np} contains ${show(l!)}`, undefined, 0);
    return g.not ? negate(r, r.np.replace(" contains ", " does not contain ")) : r;
  }],
  ["{S}(?<not> does not| do not| did not| doesnt)? (?<w>starts?|begins?|starting|beginning|ends?|ending|finishes|finish)(?: (?:with|in))? {X}", (g, sub, c, subj) => {
    const s = sub(g.s); if (!s) return null; const start = /^(?:start|begin)/i.test(g.w!);
    const v = valArg(c, g.x!, true) ?? (litText(c, g.x!) !== null ? lit(litText(c, g.x!)!) : parseValue(c, g.x!, subj)); if (!v) return null;
    const len = v.lit ? String(JSON.parse(v.e) as string | number).length : undefined; const ve = v.lit ? q(String(JSON.parse(v.e))) : str(v);
    const e = start ? `$substring(${str(s)}, 0, ${len ?? `$length(${ve})`}) = ${ve}` : `$substring(${str(s)}, ${len !== undefined ? -len : `-$length(${ve})`}) = ${ve}`;
    const r = cond(s, e, `${s.np} ${start ? "starts" : "ends"} with ${v.np}`, undefined, 4, G(v));
    return g.not ? negate(r, `${s.np} does not ${start ? "start" : "end"} with ${v.np}`) : r;
  }],
  ["{S}(?<not> does not| do not)? (?:matches|match|matching)(?: (?:pattern|regex|regular expression))? (?<x>⟦q\\d+⟧)", (g, sub, c) => {
    const s = sub(g.s); if (!s) return null; const l = litText(c, g.x!); if (!l) return null;
    const r = cond(s, `$contains(${str(s)}, /${l.replace(/\//g, "\\/")}/)`, `${s.np} matches the pattern ${l}`, undefined, 0);
    return g.not ? negate(r, `${s.np} does not match the pattern ${l}`) : r;
  }],
  // what kind of value it is
  ["{S} (?:is|are|was|looks like|contains only|has only|consists of)(?<not> not)?(?: (?:a|an|in|all|only|fully|entirely|purely|valid|just))* (?<w>numeric|number|numbers|digits|integer|whole number|text|string|alphabetic|letters|alphanumeric|uppercase|lowercase|email|email address|date|boolean|array|list|object|url|link)", (g, sub) => {
    const s = sub(g.s); if (!s) return null; const k = g.w!.toLowerCase(); const S = s.t === "string" ? s.e : `$string(${s.e})`;
    const re = (r: string, np: string) => cond(s, `$contains(${S}, ${r})`, `${s.np} ${np}`, undefined, 0);
    const r = k === "numeric" || k === "number" ? re("/^-?[0-9]+(\\.[0-9]+)?$/", "is a number") : k === "digits" || k === "numbers" ? re("/^[0-9]+$/", "has only digits") : k === "integer" || k === "whole number" ? re("/^-?[0-9]+$/", "is a whole number")
      : k === "text" || k === "string" ? cond(s, `$type(${s.e}) = "string"`, `${s.np} is text`) : k === "alphabetic" || k === "letters" ? re("/^[A-Za-z\\s]+$/", "has only letters") : k === "alphanumeric" ? re("/^[A-Za-z0-9]+$/", "has only letters and digits")
      : k === "uppercase" ? cond(s, `${s.e} = $uppercase(${S})`, `${s.np} is all upper case`) : k === "lowercase" ? cond(s, `${s.e} = $lowercase(${S})`, `${s.np} is all lower case`) : k.startsWith("email") ? re("/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/", "looks like an email address")
      : k === "date" ? re("/^[0-9]{4}-[0-9]{2}-[0-9]{2}/", "looks like a date (yyyy-MM-dd...)") : k === "boolean" ? cond(s, `$type(${s.e}) = "boolean"`, `${s.np} is true or false`) : k === "array" || k === "list" ? cond(s, `$type(${s.e}) = "array"`, `${s.np} is a list`)
      : k === "object" ? cond(s, `$type(${s.e}) = "object"`, `${s.np} is an object`) : re("/^https?:\\/\\//", "looks like a web address");
    return g.not ? negate(r, `it is not true that ${r.np}`) : r;
  }],
  // true / false
  ["{S}(?: (?:is|are|was|=|equals|set to|is set to|equal to))?(?<not> not)? (?<w>true|false|yes|no|on|off|checked|unchecked|enabled|disabled|active|inactive|ticked|selected|truthy|falsy|y|n)", (g, sub) => {
    const s = sub(g.s); if (!s) return null; const k = g.w!.toLowerCase();
    if (s.t === "string" && !/^(?:true|false|yes|no|y|n)$/.test(k)) return null;
    let want = /^(?:true|yes|on|checked|enabled|active|ticked|selected|truthy|y)$/.test(k); if (g.not) want = !want;
    return cond(s, s.t === "boolean" ? `${s.e} = ${want}` : `$toBool(${s.e}) = ${want}`, `${s.np} is ${want ? "true" : "false"}${s.t === "boolean" ? "" : want ? " (yes, 1, on...)" : " (no, 0, off...)"}`, "bool");
  }],
  // one of several values
  ["{S}(?: (?:is|are|was|equals|=|value is))?(?<not> not| neither)?(?: (?:one of|any of|either|in|among|any one of|in list|part of))? {X}", (g, sub, c) => {
    const parts = g.x!.split(/\s*,\s*(?:or\s+|nor\s+)?|\s+or\s+|\s+nor\s+|\s*\|\s*/).map((p) => p.trim()).filter(Boolean); if (parts.length < 2) return null;
    const vals: X[] = []; for (const p of parts) { const v = valArg(c, p, true); if (!v || !v.lit) return null; vals.push(v); }
    const s = sub(g.s); if (!s) return null;
    const loose = vals.every((v) => v.t === "string" && !/⟦q/.test(g.x!) && v.e === v.e.toLowerCase());
    const e = `${loose ? `$lowercase(${str(s)})` : s.t === "string" || vals.some((v) => v.t !== "string") ? s.e : `$string(${s.e})`} in [${vals.map((v) => v.e).join(", ")}]`;
    const np = `${s.np} is ${vals.slice(0, -1).map((v) => v.np).join(", ")} or ${vals[vals.length - 1].np}`;
    return g.not ? { ...cond(s, `$not(${e})`, `${s.np} is not ${vals.slice(0, -1).map((v) => v.np).join(", ")} or ${vals[vals.length - 1].np}`, undefined, 0), g: G(...vals) } : { ...cond(s, e, np), g: G(...vals) || s.g };
  }],
  ["{S} (?:is not|are not|was not|!=|<>|not equal to|is not equal to|not equals|does not equal|is different from|differs from|is other than|other than|is anything but|is not same as|not) {X}", (g, sub, c, subj) => eq(c, sub(g.s), g.x!, subj, true)],
  ["{S} (?:is|are|was|=|==|equals|equal to|is equal to|is exactly|is same as|matches|same as|is set to|has value|has the value|exactly) {X}", (g, sub, c, subj) => eq(c, sub(g.s), g.x!, subj, false)],
];
function eq(c: Ctx, s: X | null, raw: string, subj: X | undefined, not: boolean): X | null {
  if (!s) return null;
  const quoted = /^⟦q\d+⟧$/.test(raw.trim());
  let v = valArg(c, raw, true) ?? parseValue(c, raw, subj); if (!v || s.t === "object") return null;
  // "status is active" where the sample also has a field called active of another type: the word is a value, not that field
  const vf = v.field ? c.fields.find((f) => f.path === v!.field) : undefined;
  if (vf && vf.how === "name" && /^[A-Za-z]+$/.test(vf.said) && v.e === vf.path && s.t === "string" && v.t && v.t !== "string") v = lit(vf.said);
  if (v.t === "object") return null;
  const op = not ? "!=" : "="; const verb = not ? "is not" : "is";
  if (v.lit && v.t === "string" && !quoted && v.e === v.e.toLowerCase() && /[a-z]/.test(v.e)) return cond(s, `$lowercase(${str(s)}) ${op} ${v.e}`, `${s.np} ${verb} ${v.np} (upper or lower case)`, undefined, 4, G(v));
  if (v.lit && v.t === "number" && s.t !== "number") return s.t === "string" ? cond(s, `${s.e} ${op} ${q(v.e)}`, `${s.np} ${verb} ${v.np}`) : cond(s, `$string(${s.e}) ${op} ${q(v.e)}`, `${s.np} ${verb} ${v.np}`);
  if (v.lit && v.t === "string" && s.t === "number") return cond(s, `$string(${s.e}) ${op} ${v.e}`, `${s.np} ${verb} ${v.np}`, undefined, 4, G(v));
  return cond(s, `${w(s, 3)} ${op} ${w(v, 3)}`, `${s.np} ${verb} ${v.np}`, undefined, 4, G(v));
}
function condAtom(c: Ctx, t: string, subj?: X): X | null {
  const sub = (raw?: string) => subjOf(c, raw, subj);
  const text = " " + t;
  for (const [src, fn] of CONDS) {
    const m = cx(src).exec(text); if (!m) continue;
    const r = fn(m.groups as Record<string, string | undefined>, sub, c, subj); if (r) return r;
  }
  const s = fieldIds(t).length || /^(?:it|this|that)$/i.test(t) ? subjOf(c, t, subj) : null;
  if (s && s.field) return s.t === "boolean" ? cond(s, `${s.e} = true`, `${s.np} is true`, "bool") : cond(s, `$not($isEmpty(${s.e}))`, `${s.np} has a value`, "nonempty", 0, true);
  return null;
}
function parseCond(c: Ctx, raw: string, subj?: X): X | null {
  const t = clean(raw).replace(/^(?:(?:that|in case|whenever|when|if|where|and|but|also)\s+)+/i, "");
  if (!t) return null;
  const key = `C|${c.rel ?? ""}|${subj?.e ?? ""}|${t}`; const hit = c.memo.get(key); if (hit !== undefined) return hit;
  if (c.budget-- <= 0) return null;
  let r: X | null = null;
  const nm = /^(?:not|it is not (?:true|the case) that)\s+(.+)$/i.exec(t);
  r = condAtom(c, t, subj);
  if (!r && nm) { const inner = parseCond(c, nm[1], subj); if (inner) r = negate(inner, `it is not true that ${inner.np}`); }
  if (!r) for (const [re, word, p] of [[/\s+or\s+|\s*\|\|\s*/gi, "or", 5.2], [/\s+and\s+|\s*&&\s*|\s+but\s+/gi, "and", 5.1]] as [RegExp, string, number][]) {
    for (const m of t.matchAll(re)) {
      const left = parseCond(c, t.slice(0, m.index), subj); if (!left) continue;
      const right = parseCond(c, t.slice(m.index! + m[0].length), left.base ?? subj); if (!right) continue;
      r = { e: `${w(left, p)} ${word} ${w(right, p)}`, np: `${left.np} ${word} ${right.np}`, p, t: "boolean", base: left.base, g: G(left, right), kind: LIST_KINDS.has(left.kind ?? "") && LIST_KINDS.has(right.kind ?? "") ? "list" : undefined };
      break;
    }
    if (r) break;
  }
  c.memo.set(key, r);
  return r;
}

// ------------------------------------------------------------------------------------------ single steps on one value
type StepFn = (m: RegExpExecArray, s: X, c: Ctx) => X | null;
const STEPS: [string, StepFn][] = [];
const ARR_STEPS: [string, StepFn][] = [];
const st = (src: string, fn: StepFn) => { STEPS.push(["{V}" + src + "{T}", fn]); };
const ar = (src: string, fn: StepFn) => { ARR_STEPS.push(["{V}" + src + "{T}", fn]); };
const S1 = (s: X) => (s.t === "string" ? s.e : `$string(${s.e})`);
const call = (fn: string, np: string, vp: string, t: T = "string"): StepFn => (_m, s) => step(s, `${fn}(${str(s)})`, `${s.np} ${np}`, vp, t);
const IDENTITY = "{V}(?:filter|filtered|select|selected|pick|picked|only|only the|keep only|the items of|items of|entries of|records of|rows of|elements of|as is|as it is|as-is|unchanged|untouched|same|same as|as it comes|as it came|as received|as given|as such|directly|copy|copied|copy of|copy from|copied from|no changes?|without (?:any )?changes?|straight through|pass through|passthrough|mapped from|map from|comes from|equals|equal to|=|is|from|map|mapped|exactly|keep|leave|use|take|get|return|set|leave unchanged|do nothing|value|field|original|original value|as before|direct|straight|same value|nothing else|no transformation|no conversion)?{T}";

st("(?:uppercase|uppercased|upper|capitals|caps|capital letters|uppercase letters|block letters|block capitals)", call("$uppercase", "in upper case", "convert it to upper case"));
st("(?:titlecase|titlecased|title|(?:capitalize|capitalise) (?:each|every|all) words?|(?:capitalize|capitalise) first letter of (?:each|every) word|first letter of (?:each|every) word (?:in )?(?:capital|uppercase|capitalized)|start case|capitalized words|each word capitalized|initial caps|initial capitals)", call("$titleCase", "in title case", "write it in title case"));
st("(?:capitalize|capitalise|capitalized|capitalised|(?:capitalize|capitalise|uppercase) (?:first|initial) (?:letter|character)|first (?:letter|character) (?:in )?(?:capital|uppercase|capitalized|upper)|sentence case|capital first letter)", call("$capitalize", "starting with a capital letter", "start it with a capital letter"));
st("(?:lowercase|lowercased|lower|small letters|lowercase letters|small case|downcase)", call("$lowercase", "in lower case", "convert it to lower case"));
st("(?:initials|initials of (?:each )?words?|first letters? of (?:each|every|all) words?|acronym)", call("$initials", "as initials", "take its initials"));
st("(?:snake case|snake_case)", (_m, s) => step(s, `$lowercase($join(${WORDS(s)}, "_"))`, `${s.np} in snake case`, "write it in lower case with _ between the words", "string"));
st("(?:kebab case|kebab-case|slug|slugified|url slug)", (_m, s) => step(s, `$lowercase($join(${WORDS(s)}, "-"))`, `${s.np} as a slug`, "write it in lower case with - between the words", "string"));
st("(?:trim|trimmed|strip|stripped|trim (?:spaces|whitespace)|cleaned up|clean up|(?:trim|strip|remove|delete|drop|without) (?:any |all )?(?:leading|trailing|extra|surrounding|outer|leading and trailing|leading or trailing|trailing and leading|start and end|beginning and end) (?:spaces|whitespace|blanks)|(?:trim|strip|remove) (?:spaces|whitespace) (?:from|at|on) (?:both (?:ends|sides)|start and end|beginning and end|ends|edges)|(?:collapse|squeeze|normalize|normalise|reduce) (?:multiple |repeated |extra |double )?(?:spaces|whitespace)(?: (?:in)?to (?:one|a single|single)(?: space)?)?)", call("$trim", "without extra spaces", "remove the spaces around it"));
// pad: read loosely, then pick out width, character and side
STEPS.push(["(.*(?:pad|padded|padding|leading zeros?|leading zeroes|zero-?fill|zerofill|fill up|filled up).*)", (m, s, c) => padStep(c, m[1], s)]);
function padStep(c: Ctx, t: string, s: X): X | null {
  if (/\b(?:remove|strip|drop|delete|without|no)\b/i.test(t)) return null;
  const nums = [...t.matchAll(/(?<![\w⟦])(\d+)(?![\w⟧])(\s*(?:digits?|characters?|chars?|long|wide|places?|positions?|length|width))?/gi)];
  const unit = nums.find((m) => m[2]); const to = /(?:to|of|length|width|size|total)\s+(?:a\s+)?(?:length\s+|width\s+|total\s+)?(?:of\s+)?(\d+)/i.exec(t);
  const width = unit ? +unit[1] : to ? +to[1] : nums.length ? Math.max(...nums.map((m) => +m[1])) : 0;
  if (!width || width > 500) return null;
  let ch: string | null = null;
  const wm = /(?:with|using|by)\s+(?:an?\s+)?(?:leading\s+|trailing\s+)?(⟦q\d+⟧|[^\s⟦⟧]+)/i.exec(t);
  if (wm) ch = /^(?:zeros?|zeroes|0s?)$/i.test(wm[1]) ? "0" : litText(c, wm[1]);
  if (ch === null || ch === "") ch = /zero|\b0s?\b/i.test(t) ? "0" : /space|blank/i.test(t) ? " " : s.t === "number" || /digit/i.test(t) ? "0" : " ";
  const right = /\b(?:right|end|trailing|after|suffix)\b/i.test(t) ? !/\bright[- ]align/i.test(t) : ch !== "0" && !/\b(?:left|leading|start|front|before)\b/i.test(t);
  return step(s, `$pad(${S1(s)}, ${right ? width : -width}, ${q(ch)})`, `${s.np} padded to ${width} characters`, `pad it on the ${right ? "right" : "left"} with ${ch === "0" ? "zeros" : show(ch)} to ${width} characters`, "string");
}
// join the words with a separator
const joinWords: StepFn = (m, s, c) => { const sep = litText(c, m[1]); return sep === null ? null : { ...step(s, `$join(${WORDS(s)}, ${q(sep)})`, `${s.np} with ${show(sep)} between its words`, `join its words with ${show(sep)}`, "string"), kind: "joinwords" }; };
st("(?:add|put|insert|place|use|include|have) {X} (?:in between|between|in middle|in the middle)(?: (?:of )?(?:its |both |two |each |all )?(?:words|names|parts|them|it|word))?", joinWords);
st("(?:join|combine|connect|merge|concatenate|link|glue|separate)(?: (?:its|both|two|all|each))? (?:words|parts|names)(?: together)? (?:with|using|by) {X}(?: (?:in between|between(?: them)?|in middle))?", joinWords);
st("(?:join|combine|connect|merge|concatenate|link|glue|separate)(?: (?:them|it))?(?: together)? (?:with|using|by) {X}(?: (?:in between|between(?: them)?|in middle))?", (m, s, c) => (s.t === "string" ? joinWords(m, s, c) : null));
st("(?:replace|change|swap|convert|turn) (?:space|spaces|whitespace|gap|gaps|blank|blanks)(?: (?:in between|between)(?: (?:words|names|parts))?)? (?:with|by|to|into) {X}", joinWords);
st("{X} (?:in between|between) (?:its |two |both |each |all )?(?:words|names|parts)", joinWords);
st("words (?:separated|joined|delimited|connected) (?:by|with) {X}", joinWords);
st("{X}(?:-| )(?:separated|delimited|joined) words?", joinWords);
// remove ...
st("(?:only |just )?(?:digits|numbers|numeric characters|numeric part)(?: only)?", (_m, s) => step(s, `$digits(${str(s)})`, `the digits of ${s.np}`, "keep only its digits", "string"));
st("(?:only |just )?(?:letters|alphabets|alphabetic characters)(?: only)?", (_m, s) => step(s, `$replace(${str(s)}, /[^A-Za-z]/, "")`, `the letters of ${s.np}`, "keep only its letters", "string"));
st("(?:only |just )?(?:alphanumeric|alphanumerics|letters and (?:digits|numbers)|alphanumeric characters)(?: only)?", (_m, s) => step(s, `$replace(${str(s)}, /[^A-Za-z0-9]/, "")`, `the letters and digits of ${s.np}`, "keep only letters and digits", "string"));
st("(?:remove|delete|strip|drop|without|no|get rid of|take out|exclude|omit|skip|ignore|cut|chop|trim|erase|eliminate|clear) {X}", (m, s, c) => removeWhat(c, m[1], s));
function removeWhat(c: Ctx, raw: string, s: X): X | null {
  const one = removeOne(c, raw, s); if (one) return one;
  const parts = raw.trim().split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s+or\s+/i).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  let cur: X | null = s;
  for (const part of parts) { cur = cur ? removeOne(c, part, cur) : null; if (!cur) return null; }
  return cur;
}
function removeOne(c: Ctx, raw: string, s: X): X | null {
  const x = raw.trim().replace(/^(?:any|all|every|each|off)\s+/i, "").replace(/\s+(?:from|in|out of)\s+(?:it|them|text|string|value)$/i, "");
  const S = str(s); let m: RegExpExecArray | null;
  const R = (re: string, to: string, what: string) => step(s, `$replace(${S}, ${re}, ${q(to)})`, `${s.np} without ${what}`, `remove ${what}`, "string");
  if (/^(?:spaces?|whitespaces?|blanks?|white spaces?)(?:\s+(?:in between|inside|between words|in it))?$/i.test(x)) return R("/\\s+/", "", "all spaces");
  if (/^(?:digits?|numbers?|numeric characters?|numerals?)$/i.test(x)) return R("/[0-9]/", "", "digits");
  if (/^(?:non-?\s?digits?|non-?\s?numeric(?: characters?)?|non-?\s?numbers|(?:everything|anything|all) (?:except|but) (?:digits|numbers)|anything that is not a (?:digit|number))$/i.test(x)) return step(s, `$digits(${S})`, `the digits of ${s.np}`, "keep only its digits", "string");
  if (/^(?:letters?|alphabets?|alphabetic characters?)$/i.test(x)) return R("/[A-Za-z]/", "", "letters");
  if (/^(?:special characters?|specials?|symbols?|punctuations?|punctuation marks?|non-?\s?alphanumeric(?: characters?)?|special chars?)$/i.test(x)) return R("/[^A-Za-z0-9\\s]/", "", "special characters");
  if (/^(?:line ?breaks?|new ?lines?|carriage returns?)$/i.test(x)) return R("/[\\r\\n]+/", " ", "line breaks");
  if (/^(?:html )?tags$/i.test(x)) return R("/<[^>]*>/", "", "tags");
  if ((m = new RegExp(`^(first|last|leading|trailing)\\s+${N}\\s+${CH}$`, "i").exec(x))) { const n = toNum(m[2]); const first = /first|leading/i.test(m[1]); return step(s, first ? `$substring(${S}, ${n})` : `$substring(${S}, 0, $length(${S}) - ${n})`, `${s.np} without its ${first ? "first" : "last"} ${n} characters`, `remove its ${first ? "first" : "last"} ${nWord(n)} character${n === 1 ? "" : "s"}`, "string"); }
  if ((m = /^(first|last|leading|trailing)\s+(?:character|char|letter|digit)$/i.exec(x))) { const first = /first|leading/i.test(m[1]); return step(s, first ? `$substring(${S}, 1)` : `$substring(${S}, 0, $length(${S}) - 1)`, `${s.np} without its ${first ? "first" : "last"} character`, `remove its ${first ? "first" : "last"} character`, "string"); }
  if (/^first\s+word$/i.test(x)) return step(s, `$replace($trim(${S}), /^\\S+\\s*/, "")`, `${s.np} without its first word`, "remove its first word", "string");
  if (/^last\s+word$/i.test(x)) return step(s, `$replace($trim(${S}), /\\s*\\S+$/, "")`, `${s.np} without its last word`, "remove its last word", "string");
  if (/^(?:leading|preceding|starting|initial)\s+(?:zeros?|zeroes|0s?)$/i.test(x)) return step(s, `$replace(${S}, /^0+(?=.)/, "")`, `${s.np} without leading zeros`, "remove leading zeros", "string");
  if (/^(?:decimals?|decimal part|decimal places?|fractions?|fractional part|digits after (?:decimal )?point)$/i.test(x)) return step(s, `$floor(${num(s)})`, `${s.np} without decimals`, "drop the decimals", "number");
  if (/^(?:duplicates?|duplicate (?:values|items|entries)|repeated (?:values|items)|repeats)$/i.test(x)) return step(s, `$distinct(${s.e})`, `the distinct values of ${s.np}`, "remove duplicates", "array");
  if (/^(?:empty|blank|null)\s+(?:values|items|entries|elements|strings|ones)$/i.test(x)) return step(s, `$filter(${s.e}, function($v) { $not($isEmpty($v)) })[]`, `the non-empty values of ${s.np}`, "remove empty values", "array");
  if ((m = /^(?:(?:everything|anything|all|text|part|characters)\s+)?(after|from|following|before|up to|until|preceding)\s+(?:(?:first)\s+)?(.+)$/i.exec(x))) { const l = litText(c, m[2]); if (l) { const after = /after|from|following/i.test(m[1]); return step(s, `${after ? "$substringBefore" : "$substringAfter"}(${S}, ${q(l)})`, `the part of ${s.np} ${after ? "before" : "after"} ${show(l)}`, `remove everything ${after ? "after" : "before"} ${show(l)}`, "string"); } }
  if ((m = /^(.+?)\s+(prefix|suffix)$/i.exec(x))) { const l = litText(c, m[1]) ?? bareWord(m[1]); if (l) { const pre = /prefix/i.test(m[2]); return R(pre ? `/^${reEsc(l)}/` : `/${reEsc(l)}$/`, "", `${show(l)} at the ${pre ? "start" : "end"}`); } }
  if ((m = /^(prefix|suffix|leading|trailing)\s+(.+)$/i.exec(x))) { const l = litText(c, m[2]) ?? bareWord(m[2]); if (l) { const pre = /prefix|leading/i.test(m[1]); return R(pre ? `/^${reEsc(l)}/` : `/${reEsc(l)}$/`, "", `${show(l)} at the ${pre ? "start" : "end"}`); } }
  if ((m = /^(.+?)\s+(?:(?:from|at|in|on)\s+)?(start|beginning|front|end|back)$/i.exec(x))) { const l = litText(c, m[1]) ?? bareWord(m[1]); if (l) { const pre = /start|beginning|front/i.test(m[2]); return R(pre ? `/^${reEsc(l)}/` : `/${reEsc(l)}$/`, "", `${show(l)} at the ${pre ? "start" : "end"}`); } }
  const l = litText(c, x.replace(/^(?:text|word|character|string|substring|letter)\s+/i, ""));
  if (l !== null && l !== "") return step(s, `$replace(${S}, ${q(l)}, "")`, `${s.np} without ${show(l)}`, `remove every ${show(l)}`, "string");
  return null;
}
const bareWord = (raw: string): string | null => (/^[A-Za-z0-9][\w.#+-]*$/.test(raw.trim()) && !BARE_STOP.has(raw.trim().toLowerCase()) ? raw.trim() : null);
// replace A with B
const replaceFn = (a: number, b: number): StepFn => (m, s, c) => { const from = litText(c, m[a]), to = litText(c, m[b]); return from === null || from === "" || to === null ? null : step(s, `$replace(${str(s)}, ${q(from)}, ${q(to)})`, `${s.np} with ${show(from)} replaced by ${show(to)}`, `replace every ${show(from)} with ${show(to)}`, "string"); };
st("(?:replace|swap|substitute|change|convert|turn) (?:all |every |each |any )?{X} (?:with|by|to|into|for) {X}", replaceFn(1, 2));
st("(?:use )?{X} instead of {X}", replaceFn(2, 1));
// words
const word = (i: number): StepFn => (_m, s) => step(s, `${WORDS(s)}[${i}]`, `the ${ordName(i)} word of ${s.np}`, `take its ${ordName(i)} word`, "string");
st("(?:first name|given name|forename)", word(0));
st("(?:last name|surname|family name)", word(-1));
st("(?:middle name|middle names|middle word|middle words)", (_m, s) => step(s, `$join($filter(${WORDS(s)}, function($v, $i, $a) { $i > 0 and $i < $count($a) - 1 }), " ")`, `the middle words of ${s.np}`, "take the words between the first and the last", "string"));
st("{ORD} (?:word|name|token)", (m, s) => word(toOrd(m[1]))(m, s, {} as Ctx));
st("(first|last) {N} (?:words|names|tokens)", (m, s) => { const n = toNum(m[2]); const first = m[1].toLowerCase() === "first"; return step(s, `$join($filter(${WORDS(s)}, function($v, $i, $a) { ${first ? `$i < ${n}` : `$i >= $count($a) - ${n}`} }), " ")`, `the ${m[1].toLowerCase()} ${nWord(n)} words of ${s.np}`, `take its ${m[1].toLowerCase()} ${nWord(n)} words`, "string"); });
st("(?:all|everything|every word) (?:but|except|except for|apart from|other than) (first|last) (?:word|name)", (m, s, c) => removeWhat(c, `${m[1]} word`, s));
st("(?:number of words|word count|count (?:of )?words|how many words|words count)", (_m, s) => step(s, `$count(${WORDS(s)})`, `the number of words in ${s.np}`, "count its words", "number"));
st("(?:email )?(?:domain|domain name|domain part)(?: of (?:email|address|email address))?", (_m, s) => step(s, `$substringAfter(${str(s)}, "@")`, `the domain of ${s.np}`, "take the part after @", "string"));
st("(?:user ?name|local part|mailbox|user part)(?: of (?:email|address|email address))?", (_m, s) => step(s, `$substringBefore(${str(s)}, "@")`, `the user name of ${s.np}`, "take the part before @", "string"));
st("split(?: it)? (?:on|by|at|with|using) {X}(?:,)? (?:and )?(?:then )?(?:take|use|keep|get|pick|return|select) {ORD}(?: (?:part|piece|one|item|element|token|value|segment))?", (m, s, c) => { const l = litText(c, m[1]); const i = toOrd(m[2]); return l ? step(s, `$split(${str(s)}, ${q(l)})[${i}]`, `the ${ordName(i)} part of ${s.np} split at ${show(l)}`, `split it at ${show(l)} and take the ${ordName(i)} part`, "string") : null; });
st("{ORD} (?:part|piece|token|segment|item|element|value)(?: (?:when|after|once|if))? (?:split|splitting|separated|delimited|divided)(?: (?:on|by|at|with))? {X}", (m, s, c) => { const l = litText(c, m[2]); const i = toOrd(m[1]); return l ? step(s, `$split(${str(s)}, ${q(l)})[${i}]`, `the ${ordName(i)} part of ${s.np} split at ${show(l)}`, `split it at ${show(l)} and take the ${ordName(i)} part`, "string") : null; });
st("split(?: it)?(?: (?:in)?to (?:a )?(?:list|array|parts|pieces|items))? (?:on|by|at|with|using|on every|at every|at each) {X}(?: (?:in)?to (?:a )?(?:list|array|parts|pieces|items))?", (m, s, c) => { const l = litText(c, m[1]); return l ? step(s, `$split(${str(s)}, ${q(l)})`, `${s.np} split at ${show(l)}`, `split it at every ${show(l)} into a list`, "array") : null; });
st("split(?: it)? (?:in)?to (?:a )?(?:words|list of words|array of words)|list of words|words as (?:a )?list", (_m, s) => step(s, WORDS(s), `the words of ${s.np}`, "split it into words", "array"));
st("(?:(?:everything|anything|text|part|portion|all|characters|whatever(?: is| comes)?) )?(?:before|until|up to|preceding|left of) (?:(first|last) )?{X}", (m, s, c) => { const l = litText(c, m[2]); if (!l) return null; const last = (m[1] ?? "").toLowerCase() === "last"; return step(s, last ? `$join($filter($split(${str(s)}, ${q(l)}), function($v, $i, $a) { $i < $count($a) - 1 }), ${q(l)})` : `$substringBefore(${str(s)}, ${q(l)})`, `the part of ${s.np} before the ${last ? "last" : "first"} ${show(l)}`, `take the part before the ${last ? "last" : "first"} ${show(l)}`, "string"); });
st("(?:(?:everything|anything|text|part|portion|all|characters|whatever(?: is| comes)?) )?(?:after|following|past|right of) (?:(first|last) )?{X}", (m, s, c) => { const l = litText(c, m[2]); if (!l) return null; const last = (m[1] ?? "").toLowerCase() === "last"; return step(s, last ? `$split(${str(s)}, ${q(l)})[-1]` : `$substringAfter(${str(s)}, ${q(l)})`, `the part of ${s.np} after the ${last ? "last" : "first"} ${show(l)}`, `take the part after the ${last ? "last" : "first"} ${show(l)}`, "string"); });
st("(?:(?:everything|text|part|portion|characters) )?between {X} and {X}", (m, s, c) => { const a = litText(c, m[1]), b = litText(c, m[2]); return a && b ? step(s, `$substringBefore($substringAfter(${str(s)}, ${q(a)}), ${q(b)})`, `the part of ${s.np} between ${show(a)} and ${show(b)}`, `take the part between ${show(a)} and ${show(b)}`, "string") : null; });
// characters
const firstN = (n: number): StepFn => (_m, s) => step(s, `$substring(${S1(s)}, 0, ${n})`, `the first ${nWord(n)} character${n === 1 ? "" : "s"} of ${s.np}`, n === 1 ? "take its first character" : `take its first ${nWord(n)} characters`, "string");
const lastN = (n: number): StepFn => (_m, s) => step(s, `$substring(${S1(s)}, -${n})`, `the last ${nWord(n)} character${n === 1 ? "" : "s"} of ${s.np}`, `take its last ${nWord(n)} character${n === 1 ? "" : "s"}`, "string");
st("(?:only )?(?:first|leading|starting|initial|beginning) {N} {CH}(?: only)?", (m, s, c) => firstN(toNum(m[1]))(m, s, c));
st("(?:only )?(?:last|final|trailing|ending) {N} {CH}(?: only)?", (m, s, c) => lastN(toNum(m[1]))(m, s, c));
st("(first|last) {N}", (m, s, c) => (s.t === "string" ? (m[1].toLowerCase() === "first" ? firstN : lastN)(toNum(m[2]))(m, s, c) : null));
st("{ORD} {CH}", (m, s, c) => { const i = toOrd(m[1]); return i === 0 ? firstN(1)(m, s, c) : i === -1 ? lastN(1)(m, s, c) : i < 0 ? null : step(s, `$substring(${S1(s)}, ${i}, 1)`, `the ${ordName(i)} character of ${s.np}`, `take its ${ordName(i)} character`, "string"); });
st("(?:initial|first initial)", (m, s, c) => firstN(1)(m, s, c));
st("{CH} {N} (?:to|through|thru|-|until|till) {N}", (m, s) => { const a = toNum(m[1]), b = toNum(m[2]); return b >= a && a >= 1 ? step(s, `$substring(${S1(s)}, ${a - 1}, ${b - a + 1})`, `characters ${a} to ${b} of ${s.np}`, `take characters ${a} to ${b}`, "string") : null; });
st("(?:substring|part|portion|characters|chars|letters|text|slice)(?: of)?(?: it)? (?:from|between)(?: (?:position|character|index|char|letter))? {N} (?:to|and|through|thru|-|until|till)(?: (?:position|character|index|char|letter))? {N}", (m, s) => { const a = toNum(m[1]), b = toNum(m[2]); return b >= a && a >= 1 ? step(s, `$substring(${S1(s)}, ${a - 1}, ${b - a + 1})`, `characters ${a} to ${b} of ${s.np}`, `take characters ${a} to ${b}`, "string") : null; });
st("(?:(?:everything|text|part|characters) )?(?:from|starting at|starting from|after) (?:position|character|index|char|letter) {N}(?: onwards?| on| to end| until end)?", (m, s) => { const n = toNum(m[1]); return n >= 1 ? step(s, `$substring(${S1(s)}, ${n - 1})`, `${s.np} from character ${n}`, `take everything from character ${n}`, "string") : null; });
st("(?:truncate|truncated|shorten|shortened|limit|limited|cap|capped|restrict|restricted|crop|clip|cut off|cut)(?: it)?(?: (?:to|at|after))?(?: (?:a )?(?:max|maximum|at most|only)(?: of)?)? {N}(?: {CH})?(?: long| max| maximum| at most)?", (m, s, c) => firstN(toNum(m[1]))(m, s, c));
st("(?:max|maximum|at most|no more than|up to|not more than|maximum of|max of|max length|maximum length|max length of|maximum length of) {N}(?: {CH})?(?: long)?", (m, s, c) => firstN(toNum(m[1]))(m, s, c));
st("(?:length|size|number of {CH}|character count|count of {CH}|how long|how many {CH}|text length|string length)", (_m, s) => (s.t === "array" ? null : step(s, `$length(${S1(s)})`, `the length of ${s.np}`, "count its characters", "number")));
st("(?:reverse|reversed|backwards|backward|in reverse)", (_m, s) => (s.t === "array" ? null : step(s, `$join($reverse($split(${S1(s)}, "")), "")`, `${s.np} reversed`, "reverse its characters", "string")));
// prefix / suffix / wrap
// Text put in front of (or after) a value: a word is separated by one space ("New" + "web" -> "New web"); text that
// already ends (or starts) with a separator such as - / _ : . is joined directly, and so is everything when the sentence
// says "without a space"/"directly" or uses "+". Fields put next to a value are joined with a space, like words.
const NOSPACE = /\b(?:without|with\s+no|no)\s+(?:a\s+|any\s+)?(?:space|spaces|gap|separator)\b|\bdirectly\b|\battached\b|\bno\s+gap\b|\+/i;
const NOSP = "(?: (?:without|with no|no) (?:a |any )?(?:space|spaces|gap|separator)| directly| attached)?";
function gapped(v: X, pre: boolean, plain: boolean): { e: string; np: string; gap: boolean } {
  if (plain) return { e: w({ ...v, e: str(v) }, 3), np: v.np, gap: false };
  if (v.lit && v.t === "string") {
    let text = ""; try { text = JSON.parse(v.e) as string; } catch { return { e: w({ ...v, e: str(v) }, 3), np: v.np, gap: false }; }
    const edge = pre ? text.slice(-1) : text.charAt(0);
    if (!text || !/[\p{L}\p{N}]/u.test(edge)) return { e: q(text), np: v.np, gap: false };
    return { e: q(pre ? text + " " : " " + text), np: v.np, gap: true };
  }
  return { e: pre ? `${w({ ...v, e: str(v) }, 3)} & " "` : `" " & ${w({ ...v, e: str(v) }, 3)}`, np: v.np, gap: true };
}
const addFix = (pre: boolean, i = 1, plainForce = false): StepFn => (m, s, c) => {
  const v = textArg(c, m[i]); if (!v) return null;
  const g = gapped(v, pre, plainForce || NOSPACE.test(m[0]));
  const sub = w({ ...s, e: str(s) }, 3);
  const how = g.gap ? ` and a space` : "";
  return step(s, pre ? `${g.e} & ${sub}` : `${sub} & ${g.e}`, `${s.np} with ${v.np}${how} ${pre ? "in front" : "at the end"}`, `put ${v.np}${how} ${pre ? "in front of it" : "after it"}`, "string", 3);
};
st("(?:prefix|prepend|start|begin|precede)(?: it)? (?:with|by) {X}" + NOSP, addFix(true));
st("(?:add|put|insert|prepend|place|attach) {X} (?:at|to|in|on|as|before) (?:start|beginning|front|a prefix|prefix|its start|it)(?: of it)?" + NOSP, addFix(true));
st("(?:add|put|insert|place) {X} (?:in front|before)(?: of it)?" + NOSP, addFix(true));
st("(?:add (?:a )?prefix(?: of)?|with prefix|prefix|prefixed with|prefixed by|prepend|starting with|preceded by) {X}" + NOSP, addFix(true));
st("(?:suffix|append|end|finish|follow)(?: it)? (?:with|by) {X}" + NOSP, addFix(false));
st("(?:add|put|insert|append|place|attach) {X} (?:at|to|in|on|as|after) (?:end|back|a suffix|suffix|tail|its end|it)(?: of it)?" + NOSP, addFix(false));
st("(?:add|put|insert|append|place|attach) {X} (?:after|behind)(?: it)?" + NOSP, addFix(false));
st("(?:add (?:a )?suffix(?: of)?|with suffix|suffix|suffixed with|suffixed by|append|ending with|followed by) {X}" + NOSP, addFix(false));
st("(⟦q\\d+⟧) ?\\+", addFix(true, 1, true));
st("\\+ ?(⟦q\\d+⟧)", addFix(false, 1, true));
st("(?:wrap|wrapped|surround|surrounded|enclose|enclosed)(?: it)?(?: (?:in|with|by|inside))? (double quotes|single quotes|quotes|square brackets|curly braces|curly brackets|brackets|parentheses|round brackets|angle brackets)", (m, s) => { const k = m[1].toLowerCase(); const [a, b] = k === "single quotes" ? ["'", "'"] : k.includes("quote") ? ['"', '"'] : k.startsWith("square") ? ["[", "]"] : k.startsWith("curly") ? ["{", "}"] : k.startsWith("angle") ? ["<", ">"] : ["(", ")"]; return step(s, `${q(a)} & ${w({ ...s, e: str(s) }, 3)} & ${q(b)}`, `${s.np} in ${k}`, `wrap it in ${k}`, "string", 3); });
st("(?:wrap|wrapped|surround|surrounded|enclose|enclosed)(?: it)? (?:in|with|by) {X}", (m, s, c) => { const l = litText(c, m[1]); return l ? step(s, `${q(l)} & ${w({ ...s, e: str(s) }, 3)} & ${q(l)}`, `${s.np} wrapped in ${show(l)}`, `put ${show(l)} before and after it`, "string", 3) : null; });
// default when empty
const dflt: StepFn = (m, s, c) => { const v = valArg(c, m[1], true) ?? parseValue(c, m[1], s); return v ? { ...step(s, `$coalesce(${s.e}, ${v.e})`, `${s.np}, or ${v.np} when it is empty`, `use ${v.np} when it is empty or missing`, s.t ?? v.t), kind: "default", g: G(s, v) } : null; };
st("(?:default|defaults|defaulting|default value|fallback|fall back|falls back|falling back)(?: it)?(?: (?:to|as|is|of|on|=|:|being|value))? {X}(?: (?:if|when) (?:it is |its )?{EMPTY})?", dflt);
st("(?:with )?{X} (?:as|is|for|by) (?:a )?(?:default|fallback)(?: value)?", dflt);
st("(?:or|or else|otherwise|else|if {EMPTY}(?: then)?(?: use| return| put| set)?|when {EMPTY}(?: then)?(?: use| return| put| set)?|if not (?:present|available|provided|set|given|there)(?: then)?(?: use| return)?) {X}", dflt);
st("(?:empty|blank|empty string|empty text)", () => lit(""));
st("null", () => ({ e: "null", np: "null", p: 0, lit: true }));
// dates
const dfmt = (pat: string, np: string, numeric = false): StepFn => (_m, s) => step(s, numeric ? `$number($formatDate(${s.e}, ${q(pat)}))` : `$formatDate(${s.e}, ${q(pat)})`, `${np} of ${s.np}`, numeric ? `take its ${np}` : `write it as ${np}`, numeric ? "number" : "string");
st("(?:(?:reformat|format|parse|date|dates|change|convert) )?(?:(?:it|date) )?from {Q}(?: (?:format|pattern))? (?:to|into|->|as) {Q}(?: (?:format|pattern))?", (m, s, c) => { const a = c.lits[+m[1]], b = c.lits[+m[2]]; return a.pattern && b.pattern ? step(s, `$formatDate(${s.e}, ${q(b.text)}, ${q(a.text)})`, `${s.np} as ${b.text}`, `read it as ${a.text} and write it as ${b.text}`, "string") : null; });
st("(?:it )?(?:is|comes|arrives|came|given|written) (?:in|as) {Q}(?: (?:format|pattern))?(?:,| and| then|;)*(?: (?:convert|change|reformat|format|make|turn|output|return|write|show))?(?: it)?(?: (?:to|into|as|in))? {Q}(?: (?:format|pattern))?", (m, s, c) => { const a = c.lits[+m[1]], b = c.lits[+m[2]]; return a.pattern && b.pattern ? step(s, `$formatDate(${s.e}, ${q(b.text)}, ${q(a.text)})`, `${s.np} as ${b.text}`, `read it as ${a.text} and write it as ${b.text}`, "string") : null; });
st("(?:parse|read|interpret)(?: it)?(?: (?:as|using|with|from))?(?: (?:date|format|pattern))* {Q}(?: (?:format|pattern))?", (m, s, c) => { const a = c.lits[+m[1]]; return a.pattern ? step(s, `$parseDate(${s.e}, ${q(a.text)})`, `${s.np} read as ${a.text}`, `read it as a date written ${a.text}`, "string") : null; });
st("(?:(?:reformat|reformatted|format|formatted|date format|pattern|date) )?(?:(?:it|date|dates) )?(?:(?:as|to|in|into|like|with|using|of) )?(?:(?:format|pattern|date format|picture|mask) )?{Q}(?: (?:format|pattern))?", (m, s, c) => { const a = c.lits[+m[1]]; if (a.pattern) return step(s, `$formatDate(${s.e}, ${q(a.text)})`, `${s.np} as ${a.text}`, `write it as ${a.text}`, "string"); return /^[#0,.\s%-]+$/.test(a.text) && /[#0]/.test(a.text) ? step(s, `$formatNumber(${num(s)}, ${q(a.text)})`, `${s.np} formatted as ${a.text}`, `format it as ${a.text}`, "string") : null; });
st("(?:parse|parsed|read|interpret)(?: it)?(?: (?:as|into) (?:a )?(?:date|date and time|datetime|timestamp))?", (_m, s) => step(s, `$parseDate(${s.e})`, `${s.np} read as a date`, "read it as a date (written as an ISO timestamp)", "string"));
st("(?:format|formatted|show|shown|write|written|display|displayed)(?: it)?(?: as)?(?: (?:a )?(?:number|amount|money))? with {N} (?:decimals?|decimal places?|digits after the (?:point|dot|comma))(?<th> and (?:a )?(?:thousands? separators?|commas|grouping))?", (m, s) => { const n = toNum(m[1]); if (n > 10) return null; const th = /thousand|comma|grouping/i.test(m[0]); const pat = (th ? "#,##0" : "0") + (n ? "." + "0".repeat(n) : ""); return step(s, `$formatNumber(${num(s)}, ${q(pat)})`, `${s.np} written with ${n} decimals${th ? " and thousands separators" : ""}`, `write it as a number with ${n} decimals${th ? " and thousands separators" : ""}`, "string"); });
st("(?:with )?(?:thousands? separators?|thousands? commas|grouping commas)", (_m, s) => step(s, `$formatNumber(${num(s)}, "#,##0.##")`, `${s.np} with thousands separators`, "write it with thousands separators", "string"));
st("(?:iso|iso ?8601|iso date ?time|iso timestamp|iso format|iso date and time|utc timestamp|utc|timestamp|date ?time|date and time)(?: format)?", (_m, s) => step(s, `$parseDate(${s.e})`, `${s.np} as an ISO timestamp`, "write it as an ISO date and time", "string"));
st("(?:date only|only date|just date|date part|date portion|date without time|iso date|date|drop time|remove time|strip time|without time|no time)", dfmt("yyyy-MM-dd", "a date (yyyy-MM-dd)"));
st("(?:time only|only time|just time|time part|time portion|time|time of day)", dfmt("HH:mm:ss", "a time (HH:mm:ss)"));
st("(?:year|year number|year part)", dfmt("yyyy", "year", true));
st("(?:month|month number|month part)", dfmt("M", "month number", true));
st("(?:day|day of month|day number|day part)", dfmt("d", "day of the month", true));
st("(?:hour|hours|hour part)", dfmt("H", "hour", true));
st("(?:month name|name of month|full month name)", dfmt("MMMM", "the month name"));
st("(?:short month|short month name|month abbreviation|abbreviated month)", dfmt("MMM", "the short month name"));
st("(?:weekday|day of week|day name|week day|name of day|weekday name)", dfmt("EEEE", "the day of the week"));
st("quarter", (_m, s) => step(s, `$ceil($number($formatDate(${s.e}, "M")) / 3)`, `the quarter of ${s.np}`, "take its quarter (1 to 4)", "number"));
st("(?:european|uk|british|indian|day first)(?: date)?(?: format)?", dfmt("dd/MM/yyyy", "dd/MM/yyyy"));
st("(?:us|american|usa|month first)(?: date)?(?: format)?", dfmt("MM/dd/yyyy", "MM/dd/yyyy"));
st("(?:long|full|readable|human readable|friendly|pretty)(?: date)?(?: format)?", dfmt("d MMMM yyyy", "a long date (d MMMM yyyy)"));
st("short date(?: format)?", dfmt("dd MMM yyyy", "a short date (dd MMM yyyy)"));
st("(?:(?:epoch|unix)(?: time(?:stamp)?)?(?: in)? (?:millis|milliseconds|ms)|milliseconds since epoch|epoch|epoch millis|timestamp in milliseconds|milliseconds)", (_m, s) => step(s, `$epochMillis(${s.e})`, `${s.np} as epoch milliseconds`, "convert it to milliseconds since 1970", "number"));
st("(?:(?:epoch|unix)(?: time(?:stamp)?)?(?: in)? (?:seconds|secs)|unix time(?:stamp)?|seconds since epoch|timestamp in seconds)", (_m, s) => step(s, `$floor($epochMillis(${s.e}) / 1000)`, `${s.np} as epoch seconds`, "convert it to seconds since 1970", "number"));
const addT = (sign: number, ni: number, ui: number): StepFn => (m, s) => { const n = toNum(m[ni]) * sign; const u = unitOf(m[ui]); const un = Math.abs(n) === 1 ? u.replace(/s$/, "") : u; return step(s, `$addTime(${s.e}, ${n}, ${q(u)})`, `${s.np} ${sign > 0 ? "plus" : "minus"} ${Math.abs(n)} ${un}`, `${sign > 0 ? "add" : "subtract"} ${Math.abs(n)} ${un}`, "string"); };
st("(?:add|plus|\\+)(?: it)? {N} {UNIT}(?: (?:to it|later|after|more))?", addT(1, 1, 2));
st("{N} {UNIT} (?:later|after|after it|from it|ahead|added|more)", addT(1, 1, 2));
st("(?:subtract|minus|less|-|take away|remove|deduct) {N} {UNIT}(?: (?:from it|earlier|before))?", addT(-1, 1, 2));
st("{N} {UNIT} (?:earlier|before|before it|ago|prior|less)", addT(-1, 1, 2));
st("(?:next day|tomorrow|day after|following day)", (_m, s) => step(s, `$addTime(${s.e}, 1, "days")`, `the day after ${s.np}`, "add 1 day", "string"));
st("(?:previous day|day before|prior day)", (_m, s) => step(s, `$addTime(${s.e}, -1, "days")`, `the day before ${s.np}`, "subtract 1 day", "string"));
st("(?:age|age in years|years old|how old|calculate age|age from)", (_m, s) => step(s, `$dateDiff(${s.e}, $now(), "years")`, `the age from ${s.np}`, "count the whole years from it until today", "number"));
st("(?:(?:number of |count of |how many )?){UNIT} (?:since|ago|elapsed|passed|from then|from)(?: (?:then|it|that|now|today))?", (m, s) => { const u = unitOf(m[1]); return step(s, `$dateDiff(${s.e}, $now(), ${q(u)})`, `the ${u} since ${s.np}`, `count the ${u} from it until now`, "number"); });
st("(?:(?:number of |count of |how many )?){UNIT} (?:until|till|to|left|remaining|to go|before)(?: (?:then|it|that|now|today))?", (m, s) => { const u = unitOf(m[1]); return step(s, `$dateDiff($now(), ${s.e}, ${q(u)})`, `the ${u} until ${s.np}`, `count the ${u} from now until it`, "number"); });
// booleans
st("(?:yes or no|yes\\/no|yes no|yes and no)", (_m, s) => step(s, `$yesNo(${s.e})`, `${s.np} as Yes or No`, "write Yes when it is true and No when it is false", "string"));
st("(?:y or n|y\\/n|y n|y and n)", (_m, s) => step(s, `$yesNo(${s.e}, "Y", "N")`, `${s.np} as Y or N`, "write Y when it is true and N when it is false", "string"));
st("(?:true or false|boolean|bool|true\\/false|flag)", (_m, s) => step(s, `$toBool(${s.e})`, `${s.np} as true or false`, "read it as true or false (yes, 1, on, active count as true)", "boolean"));
st("(?:1 or 0|1\\/0|one or zero|0 or 1|0\\/1|bit)", (_m, s) => step(s, `$toBool(${s.e}) ? 1 : 0`, `${s.np} as 1 or 0`, "write 1 when it is true and 0 when it is false", "number", 6));
st("(?:negate|negated|invert|inverted|flip|flipped|opposite|toggle|inverse)", (_m, s) => (s.t === "boolean" ? step(s, `$not(${s.e})`, `the opposite of ${s.np}`, "flip true and false", "boolean") : s.t === "number" ? step(s, `0 - ${num(s)}`, `${s.np} with the opposite sign`, "flip its sign", "number", 2) : null));
// numbers
const ar1 = (op: string, vp: string, np: string, p: number, i = 1): StepFn => (m, s, c) => { const v = numArg(c, m[i], s); return v ? { ...step(s, `${num(s)} ${op} ${w(v, p - (op === "-" || op === "/" ? 0.5 : 0))}`, `${s.np} ${np} ${v.np}`, `${vp} ${v.np}`, "number", p), g: G(s, v) } : null; };
const pct = (sign: number): StepFn => (m, s) => { const n = toNum(m[1]); return step(s, `${num(s)} * ${fmt(1 + (sign * n) / 100)}`, `${s.np} ${sign > 0 ? "plus" : "minus"} ${n} percent`, `${sign > 0 ? "add" : "take off"} ${n} percent`, "number", 1); };
st("(?:add|plus|increase(?: it)? by|raise(?: it)? by|mark(?: it)? up by|uplift(?: it)? by|with|including|include) {N} percent(?: (?:tax|vat|gst|markup|fee|added|more|extra|on top|surcharge|increase|commission|tip|to it))*", pct(1));
st("(?:subtract|minus|less|reduce(?: it)? by|decrease(?: it)? by|discount(?: it)? (?:by|of)|lower(?: it)? by|take off|deduct|apply|with) {N} percent(?: (?:discount|off|less|reduction|deducted|from it))*", pct(-1));
st("{N} percent (?:discount|off|less|reduction)", pct(-1));
st("{N} percent (?:more|extra|added|increase|markup|tax|vat)", pct(1));
st("{N} percent(?: of(?: it)?)?", (m, s) => { const n = toNum(m[1]); return step(s, `${num(s)} * ${fmt(n / 100)}`, `${n} percent of ${s.np}`, `take ${n} percent of it`, "number", 1); });
st("(?:multiply|multiplied|times)(?: it)?(?: by| with)? {X}", ar1("*", "multiply it by", "times", 1));
st("(?:x|\\*) {X}", ar1("*", "multiply it by", "times", 1));
st("(?:divide|divided)(?: it)?(?: by)? {X}", ar1("/", "divide it by", "divided by", 1));
st("(?:\\/|over) {X}", ar1("/", "divide it by", "divided by", 1));
st("(?:add|plus|increase(?: it)? by|increment(?: it)? by|raise(?: it)? by|\\+) {X}(?: to it)?", ar1("+", "add", "plus", 2));
st("{X} (?:added|more)", ar1("+", "add", "plus", 2));
st("(?:subtract|minus|less|reduce(?: it)? by|decrease(?: it)? by|decrement(?: it)? by|lower(?: it)? by|deduct|take away|take off|-) {X}(?: from it)?", ar1("-", "subtract", "minus", 2));
st("(?:double|doubled|twice|times two)", (_m, s) => step(s, `${num(s)} * 2`, `twice ${s.np}`, "double it", "number", 1));
st("(?:triple|tripled|times three)", (_m, s) => step(s, `${num(s)} * 3`, `three times ${s.np}`, "triple it", "number", 1));
st("(?:half|halve|halved)(?: of)?", (_m, s) => step(s, `${num(s)} / 2`, `half of ${s.np}`, "halve it", "number", 1));
st("(?:square root|sqrt)(?: of)?", (_m, s) => step(s, `$sqrt(${num(s)})`, `the square root of ${s.np}`, "take its square root", "number"));
st("(?:square|squared)", (_m, s) => step(s, `$power(${num(s)}, 2)`, `${s.np} squared`, "square it", "number"));
st("(?:(?:raise(?: it)? )?to )?(?:power|power of) {N}", (m, s) => step(s, `$power(${num(s)}, ${toNum(m[1])})`, `${s.np} to the power of ${toNum(m[1])}`, `raise it to the power of ${toNum(m[1])}`, "number"));
st("(?:modulo|mod|remainder (?:when|after) (?:divided|dividing|division) by|remainder of division by|remainder after) {N}", (m, s) => step(s, `${num(s)} % ${toNum(m[1])}`, `the remainder of ${s.np} divided by ${toNum(m[1])}`, `take the remainder after dividing by ${toNum(m[1])}`, "number", 1));
st("round(?:ed)?(?: it)? up(?: to(?: nearest)? (?:integer|whole number|whole|int))?|ceil|ceiling", (_m, s) => step(s, `$ceil(${num(s)})`, `${s.np} rounded up`, "round it up to a whole number", "number"));
st("round(?:ed)?(?: it)? down(?: to(?: nearest)? (?:integer|whole number|whole|int))?|floor|truncate decimals", (_m, s) => step(s, `$floor(${num(s)})`, `${s.np} rounded down`, "round it down to a whole number", "number"));
st("round(?:ed)?(?: it)?(?: off)? to(?: (?:nearest|closest))? (\\d+|ten|hundred|thousand|integer|whole number|whole|int|tenth|hundredth|cent|unit)", (m, s) => {
  const k = m[1].toLowerCase(); const n = k === "ten" ? 10 : k === "hundred" ? 100 : k === "thousand" ? 1000 : /^\d+$/.test(k) ? Number(k) : 0;
  if (k === "tenth") return step(s, `$round(${num(s)}, 1)`, `${s.np} rounded to 1 decimal`, "round it to 1 decimal", "number");
  if (k === "hundredth" || k === "cent") return step(s, `$round(${num(s)}, 2)`, `${s.np} rounded to 2 decimals`, "round it to 2 decimals", "number");
  return n > 1 ? step(s, `$round(${num(s)} / ${n}) * ${n}`, `${s.np} rounded to the nearest ${n}`, `round it to the nearest ${n}`, "number", 1) : step(s, `$round(${num(s)})`, `${s.np} rounded`, "round it to a whole number", "number");
});
st("round(?:ed)?(?: it)?(?: off)? (?:to|at|with|upto|up to) {N}(?: (?:decimals?|decimal places?|places?|dp|decimal digits?|digits after (?:decimal )?point|decimal points?))?", (m, s) => step(s, `$round(${num(s)}, ${toNum(m[1])})`, `${s.np} rounded to ${toNum(m[1])} decimals`, `round it to ${toNum(m[1])} decimal${toNum(m[1]) === 1 ? "" : "s"}`, "number"));
st("(?:with |use |using )?(?:thousands?|comma) separators?(?: and {N} (?:decimals?|decimal places?))?|commas? (?:as|for) thousands?(?: separators?)?|thousands? separated", (m, s) => { const d = m[1] ? toNum(m[1]) : -1; const pic = d > 0 ? "#,##0." + "0".repeat(d) : d === 0 ? "#,##0" : "#,##0.##"; return step(s, `$formatNumber(${num(s)}, ${q(pic)})`, `${s.np} with thousands separators`, "write it with thousands separators", "string"); });
st("(?:format|formatted|show|display|print|fixed|keep|always|exactly|with)(?: (?:it|with|to|as|at|in|using|exactly|always|fixed|having))* {N} (?:decimals?|decimal places?|places?|dp|decimal digits?|digits after (?:decimal )?point|decimal points?)", (m, s) => { const d = toNum(m[1]); return step(s, `$formatNumber(${num(s)}, ${q(d > 0 ? "0." + "0".repeat(d) : "0")})`, `${s.np} with ${d} decimals`, `always show ${d} decimal${d === 1 ? "" : "s"}`, "string"); });
st("{N} (?:decimals?|decimal places?|dp|decimal digits?|decimal points?)", (m, s) => step(s, `$round(${num(s)}, ${toNum(m[1])})`, `${s.np} rounded to ${toNum(m[1])} decimals`, `round it to ${toNum(m[1])} decimal${toNum(m[1]) === 1 ? "" : "s"}`, "number"));
st("round(?:ed)?(?: it)?(?: off)?(?: to(?: nearest)? (?:integer|whole number|whole|int))?", (_m, s) => step(s, `$round(${num(s)})`, `${s.np} rounded`, "round it to a whole number", "number"));
st("(?:integer|int|whole number|long)", (_m, s) => step(s, `$round(${num(s)})`, `${s.np} as a whole number`, "convert it to a whole number", "number"));
st("(?:number|numeric|numeric value|float|decimal|decimal number|double precision)", (_m, s) => step(s, `$number(${s.e})`, `${s.np} as a number`, "convert it to a number", "number"));
st("(?:absolute|absolute value|abs|positive|always positive|unsigned|without (?:sign|minus sign))(?: of)?", (_m, s) => step(s, `$abs(${num(s)})`, `the absolute value of ${s.np}`, "drop the minus sign", "number"));
st("(?:negative|flip sign|invert sign|opposite sign|reverse sign|change sign)", (_m, s) => step(s, `0 - ${num(s)}`, `${s.np} with the opposite sign`, "flip its sign", "number", 2));
st("(?:percentage|percent)", (_m, s) => step(s, `$formatNumber(${num(s)}, "0.##%")`, `${s.np} as a percentage`, "write it as a percentage", "string"));
st("(?:from (?:minor units?|cents|pence|paise|halalas?|fils)(?: to (?:major(?: units?)?|decimal|amount|currency))?|major units?|(?:cents|pence|paise|halalas?|fils|minor units?) to (?:dollars|pounds|riyals|amount|decimal|major units?|currency))", (_m, s) => step(s, `$fromMinorUnits(${num(s)})`, `${s.np} in major currency units`, "convert it from minor units (cents) to a decimal amount", "number"));
st("(?:minor units?|minor currency units?|smallest (?:currency )?units?|subunits?|cents|pence|paise|halalas?|fils|integer cents)(?: (?:with|using|of|for) {N} decimals?(?: places?)?)?", (m, s) => step(s, m[1] ? `$toMinorUnits(${num(s)}, ${toNum(m[1])})` : `$toMinorUnits(${num(s)})`, `${s.np} in minor currency units`, "convert it to minor units (cents)", "number"));
// other conversions
st("(?:json|json string|json text|stringify|stringified|serialize|serialized|serialise|serialised)(?: (?:as json|to json))?", (_m, s) => step(s, `$string(${s.e})`, `${s.np} as JSON text`, "write it as JSON text", "string"));
st("(?:(?:parse|parsed|read)(?: (?:as|from))? json|json parse|from json|json object|object)", (_m, s) => step(s, `$parseJson(${s.e})`, `${s.np} read as JSON`, "read it as JSON", "object"));
st("(?:from xml|parse xml|xml to json|xml as json)", (_m, s) => step(s, `$xmlToJson(${s.e})`, `${s.np} read as XML`, "read it as XML", "object"));
st("xml", (_m, s) => step(s, `$jsonToXml(${s.e})`, `${s.np} as XML`, "write it as XML", "string"));
st("(?:string|text|plain text|str)", (_m, s) => step(s, `$string(${s.e})`, `${s.np} as text`, "convert it to text", "string"));
st("(?:list|array|wrap(?: it)? in (?:a )?(?:list|array)|single item list|list of one)", (_m, s) => (s.t === "array" ? s : step(s, `[${s.e}]`, `a list holding ${s.np}`, "put it in a list", "array")));
st("(md5|sha-?1|sha-?256|sha-?512)?(?: )?(?:hash|hashed|checksum|digest)|(md5|sha-?1|sha-?256|sha-?512)", (m, s) => { const a = (m[1] ?? m[2] ?? "").toLowerCase().replace("-", ""); return step(s, a && a !== "sha256" ? `$hash(${str(s)}, ${q(a)})` : `$hash(${str(s)})`, `a hash of ${s.np}`, `hash it${a ? " with " + a : ""}`, "string"); });
st("(?:mask|hide|obscure|redact|star out|x out)(?: (?:it|all|everything))? (?:but|except|apart from|other than|leaving|keeping|showing only)(?: for)? (?:last|final) {N}(?: {CH})?", (m, s) => { const n = toNum(m[1]); return step(s, `$pad("", $max([$length(${S1(s)}) - ${n}, 0]), "*") & $substring(${S1(s)}, -${n})`, `${s.np} masked except its last ${n} characters`, `replace everything except its last ${nWord(n)} characters with *`, "string", 3); });
st("(?:show|keep|display) only (?:last|final) {N}(?: {CH})?(?:,)?(?: (?:and )?(?:mask|hide|star)(?:ing)?(?: (?:rest|others|remaining))?)?", (m, s) => { const n = toNum(m[1]); return step(s, `$pad("", $max([$length(${S1(s)}) - ${n}, 0]), "*") & $substring(${S1(s)}, -${n})`, `${s.np} masked except its last ${n} characters`, `replace everything except its last ${nWord(n)} characters with *`, "string", 3); });
st("(?:mask|masked|hide|redact|redacted)", (_m, s) => step(s, `$replace(${S1(s)}, /./, "*")`, `${s.np} masked`, "replace every character with *", "string"));

// lists
const elems = (s: X) => (s.elemT === "string" ? s.e : `$map(${s.e}, $string)`);
ar("(?:count|number|total number|how many|quantity|size|length)(?: of)?(?: (?:items|elements|entries|records|rows|them|values))?|item count|count them", (_m, s) => step(s, `$count(${s.e})`, `the number of ${s.np}`, "count the items", "number"));
ar("(?:sum|total|add up|add all|sum up|sum total|summed|totalled|totaled|add them(?: up)?|grand total|add together)(?: of)?(?: (?:all|them|values|items|up))*", (_m, s) => step(s, `$sum(${s.e})`, `the total of ${s.np}`, "add up all the values", "number"));
ar("(?:average|mean|avg)(?: of)?(?: (?:all|them|values|items))*", (_m, s) => step(s, `$average(${s.e})`, `the average of ${s.np}`, "take the average", "number"));
ar("(?:min|minimum|smallest|lowest|least|cheapest)(?: of)?(?: (?:value|one|item|them|values))?", (_m, s) => step(s, `$min(${s.e})`, `the smallest of ${s.np}`, "take the smallest value", "number"));
ar("(?:max|maximum|largest|highest|biggest|greatest)(?: of)?(?: (?:value|one|item|them|values))?", (_m, s) => step(s, `$max(${s.e})`, `the largest of ${s.np}`, "take the largest value", "number"));
ar("(?:earliest|oldest)(?: of)?(?: (?:value|one|item|date))?", (_m, s) => step(s, `$sort(${s.e})[0]`, `the earliest of ${s.np}`, "take the earliest value", s.elemT));
ar("(?:latest|newest|most recent)(?: of)?(?: (?:value|one|item|date))?", (_m, s) => step(s, `$sort(${s.e})[-1]`, `the latest of ${s.np}`, "take the latest value", s.elemT));
ar("(?:(?:item|element|entry|value) (?:number |no |# ?)?){N}", (m, s) => { const n = toNum(m[1]); return n >= 1 ? step(s, at(s, n - 1), `item ${n} of ${s.np}`, `take item number ${n}`, s.elemT) : null; });
ar("(first|top|last|bottom) {N}(?: (?:items|elements|entries|ones|values|records|rows))?", (m, s) => { const n = toNum(m[2]); const first = /first|top/i.test(m[1]); return step(s, `$filter(${s.e}, function($v, $i, $a) { ${first ? `$i < ${n}` : `$i >= $count($a) - ${n}`} })[]`, `the ${first ? "first" : "last"} ${nWord(n)} of ${s.np}`, `keep the ${first ? "first" : "last"} ${nWord(n)} items`, "array"); });
ar("{ORD}(?: (?:item|element|entry|one|value|record|row))?(?: of)?", (m, s) => { const i = toOrd(m[1]); return step(s, at(s, i), `the ${ordName(i)} of ${s.np}`, `take the ${ordName(i)} item`, s.elemT); });
const joinArr = (sep: string): StepFn => (_m, s) => step(s, `$join(${elems(s)}, ${q(sep)})`, `${s.np} joined with ${show(sep)}`, `join the items with ${show(sep === ", " ? "a comma and a space" : sep)}`, "string");
ar("(?:join|joined|concatenate|concatenated|combine|combined|merge|merged|list|listed|separated|delimited|separate|glue|string)(?: (?:them|all|items|values|together|into text|into string|into one string|as text))*(?: (?:with|by|using|on))? {X}(?: (?:in between|between(?: them)?|separated|delimited|as separator))?", (m, s, c) => { const l = litText(c, m[1]); return l === null ? null : joinArr(l)(m, s, c); });
ar("{X}(?:-| )(?:separated|delimited|joined)(?: (?:list|string|text|values))?", (m, s, c) => { const l = litText(c, m[1]); return l === null ? null : joinArr(l === "," ? ", " : l)(m, s, c); });
ar("csv", joinArr(","));
ar("(?:join|joined|concatenate|concatenated|combine|combined|single string|one string|join together|comma separated list)(?: (?:them|all|items|values|together|into text|into string|into one string|as text))*", joinArr(", "));
ar("(?:unique|distinct|deduplicate|deduplicated|dedupe|dedup|unique values|distinct values|remove duplicates|without duplicates|no duplicates|drop duplicates)(?: (?:values|items|only))?", (_m, s) => step(s, `$distinct(${s.e})`, `the distinct values of ${s.np}`, "remove duplicates", "array"));
ar("(?:sort|sorted|order|ordered)(?: (?:them|by value))?(?: (?:in|by))?(?: (asc|ascending|desc|descending|alphabetically|alphabetical|a to z|z to a|reverse|low to high|high to low|smallest first|largest first|oldest first|newest first|increasing|decreasing))?(?: order)?", (m, s) => { const k = (m[1] ?? "").toLowerCase(); const desc = /desc|z to a|reverse|high to low|largest first|newest first|decreasing/.test(k); return step(s, desc ? `$reverse($sort(${s.e}))` : `$sort(${s.e})`, `${s.np} sorted${desc ? " in descending order" : ""}`, `sort the items${desc ? " in descending order" : ""}`, "array"); });
// "sort data.items by price (descending)", "group data.items by type": the key is a field of each item
const itemKey = (c: Ctx, s: X, raw: string): string | null => {
  const t = raw.trim(); const fm = /^⟦f(\d+)⟧$/.exec(t);
  let path = fm ? (fieldX(c, +fm[1])?.e ?? "") : t;
  path = path.replace(/^\$\.?/, "");
  const base = s.e.replace(/^\$\.?/, "");
  if (base && path.startsWith(base + ".")) path = path.slice(base.length + 1);
  return /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(path) ? path : null;
};
ar("(?:sort|sorted|order|ordered|arrange|arranged|rank|ranked)(?: (?:them|the items|items|it))? (?:by|on|using) (⟦f\\d+⟧|[A-Za-z_][\\w.]*)(?: (?:in|from))?(?: (asc|ascending|desc|descending|low to high|high to low|smallest first|largest first|highest first|lowest first|increasing|decreasing|a to z|z to a|reverse))?(?: order)?", (m, s, c) => {
  const k = itemKey(c, s, m[1]); if (!k) return null; const desc = /desc|high to low|largest first|highest first|decreasing|z to a|reverse/i.test(m[2] ?? "");
  return step(s, `$sort(${s.e}, function($l, $r) { $l.${k} ${desc ? "<" : ">"} $r.${k} })`, `${s.np} sorted by ${k}${desc ? " from high to low" : ""}`, `sort the items by ${k}${desc ? " in descending order" : ""}`, "array");
});
ar("(?:group|grouped|groups|bucket|bucketed)(?: (?:them|the items|items|it))? (?:by|on|per) (⟦f\\d+⟧|[A-Za-z_][\\w.]*)", (m, s, c) => {
  const k = itemKey(c, s, m[1]); if (!k) return null;
  return step(s, `${w(s, 1)}{${k}: [$]}`, `${s.np} grouped by ${k}`, `group the items by ${k} (one list per ${k})`, "object");
});
ar("(?:reverse|reversed|backwards|reverse order|in reverse|in reverse order)", (_m, s) => step(s, `$reverse(${s.e})`, `${s.np} in reverse order`, "reverse the order", "array"));

function oneStep(c: Ctx, raw: string, s: X): X | null {
  let t = clean(raw);
  if (!t || rx(IDENTITY).test(t)) return s;
  if (c.budget-- <= 0) return null;
  const arr = s.t === "array"; const scalar = s.t === "string" || s.t === "number" || s.t === "boolean";
  if (s.t === "string") t = t.replace(/\b(first|last|second|third) one$/i, "$1 word");
  if (arr && /^(?:(?:as|a|an|the|in|into|to)\s+)*(?:list|array)(?:\s+of)?(?:\s+all)?$/i.test(t)) return s;
  const lists = arr ? [ARR_STEPS, STEPS] : scalar ? [STEPS] : [STEPS, ARR_STEPS];
  for (const list of lists) for (const [src, fn] of list) {
    const m = rx(src).exec(t); if (!m) continue;
    if (arr && list === STEPS) {
      const el: X = { e: "$v", np: "each item", p: 0, t: s.elemT === "object" ? undefined : s.elemT, field: "$v" };
      const r = fn(m, el, c); if (!r || r.lit) continue;
      return step(s, `$map(${s.e}, function($v) { ${r.e} })[]`, `${s.np}, each one changed`, `for each item: ${r.vps?.[r.vps.length - 1] ?? "change it"}`, "array");
    }
    const r = fn(m, s, c); if (r) return r;
  }
  return null;
}

// ------------------------------------------------------------------------------------------ constants, one field and its steps
function constOf(c: Ctx, raw: string): X | null {
  const t = clean(raw).replace(/^(?:(?:always|constant|constantly|fixed|hard-?coded|static|literal|just|simply|set(?: it)? to|use|put|return|write|output|value|text|string|be|is|=|:|should be|must be|as|to|of)\s+)+/i, "").replace(/\s+(?:always|every time|each time|for all|in all cases|as (?:a )?(?:constant|fixed value)|constant|fixed)$/i, "");
  const marked = /^(?:always|constant|constantly|fixed|hard-?coded|static|literal|text|string|word)\s/i.test(clean(raw)) && t.split(/\s+/).some((x) => !VOCAB.has(x.toLowerCase()) && !INTENT.has(x.toLowerCase()) && !STOP.has(x.toLowerCase()));
  const v = valArg(c, t, false) ?? (marked ? valArg(c, t, true) : null);
  if (v && v.lit) return { ...v, sent: `Always ${v.np}` };
  if (/^(?:(?:a|an|new|random|generated?|unique|fresh)\s+)*(?:uuid|guid|unique id|unique identifier|random id|random identifier)$/i.test(t)) return { e: "$uuid()", np: "a new unique id", p: 0, t: "string", sent: "Generate a new unique id (UUID)" };
  if (/^(?:now|right now|current (?:date ?time|time|timestamp|date and time)|timestamp|time ?stamp|date and time now|time now)$/i.test(t)) return { ...NOW, sent: "Use the current date and time" };
  if (/^(?:today|todays date|today's date|current date|date today|date of today)$/i.test(t)) return { ...TODAY, sent: "Use today's date (yyyy-MM-dd)" };
  return null;
}
const GLUE = /(?:^|\s)(?:of|from|in|on|for|to|field|value|values|input|source|its|this|that|a|an|inside|within|called|named|using|take|use)\s*$/i;
function removeField(t: string, id: number, last: boolean): string {
  const p = ph(id); const i = last ? t.lastIndexOf(p) : t.indexOf(p); if (i < 0) return t;
  let before = t.slice(0, i);
  const after = t.slice(i + p.length).replace(/^'s(?![A-Za-z])/, "").replace(/^\s+(?:field|values?)(?![A-Za-z])/i, "").replace(/^\s*(?:,|:|->|=>|=)\s*/, " ");
  for (let m = GLUE.exec(before); m; m = GLUE.exec(before)) before = before.slice(0, m.index);
  return clean(before + " " + after);
}
function parseSingle(c: Ctx, raw: string, subj?: X): X | null {
  const t = clean(raw); if (!t) return null;
  const all = [...t.matchAll(/⟦f(\d+)⟧/g)];
  if (!all.length) {
    const k = constOf(c, t); if (k) return k;
    const s = subj ?? c.defaultSubject;
    if (!s) { c.needSubject = true; return null; }
    return parseSteps(c, t, s);
  }
  const first = +all[0][1];
  let r = parseSteps(c, removeField(t, first, false), fieldX(c, first));
  if (!r && all.length > 1) { const lastId = +all[all.length - 1][1]; r = parseSteps(c, removeField(t, lastId, true), fieldX(c, lastId)); }
  return r;
}
const CONNECT = /\s*(?:,\s*and\s+then|,\s*then|,\s*and|;|,|->|=>)\s*|\s+(?:and\s+then|then|and\s+also|and|after\s+that|afterwards|finally|also|next)\s+/gi;
const WEAK_CONNECT = /\s+(?:in|as|to|into)\s+/gi;
function parseSteps(c: Ctx, raw: string, s: X): X | null {
  const t = clean(raw); if (!t) return s;
  const key = `S|${c.rel ?? ""}|${s.e}|${t}`; const hit = c.memo.get(key); if (hit !== undefined) return hit;
  if (c.budget-- <= 0) return null;
  c.memo.set(key, null);
  let r = oneStep(c, t, s);
  for (const re of [CONNECT, WEAK_CONNECT]) {
    if (r) break;
    const ms = [...t.matchAll(re)];
    for (let i = ms.length - 1; i >= 0 && !r; i--) {
      const rt = t.slice(ms[i].index! + ms[i][0].length); if (!clean(rt) || !clean(t.slice(0, ms[i].index))) continue;
      const left = parseSteps(c, t.slice(0, ms[i].index), s); if (!left) continue;
      r = oneStep(c, rt, left) ?? (re === CONNECT ? parseConditional(c, rt, left) : null);
    }
  }
  c.memo.set(key, r);
  return r;
}

// ------------------------------------------------------------------------------------------ lookup tables: "M means Male, F means Female"
const T_STRONG = /\s+(?:means|mean|stands for|stand for|becomes|become|maps to|map to|is mapped to|translates to|translate to|represents|corresponds to|turns into|goes to|is for|should be|should become|will be|must be|gives|returns|converts to|changes to)\s+|\s*(?:->|=>|=)\s*/i;
const T_WEAK = /\s+(?:to|is|as|for|then)\s+|\s*:\s*/i;
const T_DEFAULT = /^(?:(?:and|or|for|in|if|when)\s+)?(?:anything else|everything else|all others?|all other values|any other value|any other|others?|other values|otherwise|else|default|by default|rest|all else|in all other cases|in other cases|unknown values?|not found|no match|if none match|if nothing matches)(?![A-Za-z])(?:\s+(?:means|is|as|to|becomes|use|then|should be|will be|returns?|gives|value|it is|map to|maps to|goes to|put|set|write))*\s*(?:->|=>|=|:|,)?\s*(.+)$/i;
const T_KEEP = /^(?:keep(?: it)?(?: as is| as it is| unchanged)?|as is|as it is|unchanged|same|leave(?: it)?(?: as is| unchanged| alone)?|itself|it|no change|original(?: value)?|pass(?: it)? through|stays?(?: as is| same)?)$/i;
const NOT_KEYS = new Set("add set map use put get cut pad sum max min up go do be it if or and not no all any each".split(" "));
function parseTable(c: Ctx, raw: string, subj?: X): X | null {
  let t = clean(raw);
  const occ = [...t.matchAll(/⟦f(\d+)⟧/g)];
  if (occ.length > 1) return null;
  let s: X | undefined;
  if (occ.length === 1) {
    let m = /^(?:(?:translate|map|look ?up|convert|decode|recode|replace|change|transform|for|when|if|where|based on|depending on|using|switch on|by|from|in|check)\s+)?(?:(?:values?|codes?)\s+(?:of|in|from)\s+)?⟦f(\d+)⟧(?:\s+(?:values?|codes?|field))?(?:\s*(?:is|are|=|as follows|like this|using|with|where|so that|such that|as|by|:|,|-)(?![A-Za-z]))*\s*(.*)$/i.exec(t);
    if (m) { s = fieldX(c, +m[1]); t = m[2]; }
    else if ((m = /^(.*?)[\s,;:]+(?:(?:for|in|of|on|from|using|based on|depending on)\s+)?⟦f(\d+)⟧$/i.exec(t))) { s = fieldX(c, +m[2]); t = m[1]; }
    else return null;
  } else t = t.replace(/^(?:translate|map|look ?up|decode|recode|convert)(?:\s+(?:it|value|values|codes?|this|them))?(?:\s+(?:as follows|like this|using|with|as|where|so that))?\s*[:,]?\s+/i, "");
  const parts = t.split(/\s*[;|]\s*|\s*,\s*(?:and\s+|or\s+)?|\s+and\s+/).map(clean).filter(Boolean);
  if (!parts.length) return null;
  const entries: [X, X][] = []; let dflt: X | undefined; let keep = false; let weak = 0; let g = false;
  const val = (rawV: string): X | "keep" | null => {
    const v = clean(rawV).replace(/^(?:(?:use|return|put|write|set|show|output|value|text|then|it is|to)\s+)+/i, "");
    if (T_KEEP.test(v)) return "keep";
    const x = valArg(c, v, true); return x && x.lit ? x : null;
  };
  for (const p of parts) {
    const dm = T_DEFAULT.exec(p);
    if (dm) { if (dflt || keep) return null; const v = val(dm[1]); if (v === null) return null; if (v === "keep") keep = true; else dflt = v; continue; }
    let m = T_STRONG.exec(p); let isWeak = false;
    if (!m) { m = T_WEAK.exec(p); isWeak = true; }
    if (!m) return null;
    const kRaw = clean(p.slice(0, m.index)).replace(/^(?:(?:if|when|where|for|and|or|case|value|code|it is|it|is|equals|=|whenever|translate|map|convert|change|replace|decode|recode|turn|make)\s+)+/i, "");
    if (!kRaw || new RegExp(`^${EMPTY}$`, "i").test(kRaw)) return null;
    const quoted = /^⟦q\d+⟧$/.test(kRaw);
    const k = valArg(c, kRaw, true); if (!k || !k.lit || k.e === '""' || k.e === "null") return null;
    if (!quoted && (NOT_KEYS.has(kRaw.toLowerCase()) || STOP.has(kRaw.toLowerCase()))) return null;
    if (isWeak) {
      if (!quoted && !(/^-?\d+(?:\.\d+)?$/.test(kRaw) || kRaw.length <= 3 || /[A-Z0-9]/.test(kRaw))) return null;
      if (!quoted && (VOCAB.has(kRaw.toLowerCase()) || INTENT.has(kRaw.toLowerCase()))) return null;
      weak++;
    }
    const v = val(p.slice(m.index + m[0].length)); if (v === null || v === "keep") return null;
    entries.push([k, v]); g = g || !!k.g || !!v.g;
  }
  if (!entries.length || (weak > 0 && entries.length < 2)) return null;
  s = s ?? subj ?? c.defaultSubject;
  if (!s) { c.needSubject = true; return null; }
  const base = s.base ?? (s.field ? s : undefined);
  const types = new Set(entries.map(([, v]) => v.t)); const t1: T = types.size === 1 ? [...types][0] : undefined;
  if (entries.every(([k]) => k.t === "boolean") && entries.length === 2 && entries[0][0].e !== entries[1][0].e && !dflt) {
    const yes = entries.find(([k]) => k.e === "true")![1], no = entries.find(([k]) => k.e === "false")![1];
    return { e: `$yesNo(${s.e}, ${yes.e}, ${no.e})`, np: `${s.np} as ${yes.np} or ${no.np}`, p: 0, t: t1, base, g: G(s) || g || undefined, sent: `Write ${yes.np} when ${s.np} is true and ${no.np} when it is false` };
  }
  const obj = "{" + entries.map(([k, v]) => `${q(String(JSON.parse(k.e)))}: ${v.e}`).join(", ") + "}";
  return {
    e: `$translate(${s.e}, ${obj}${dflt ? ", " + dflt.e : ""})`, np: `${s.np} translated`, p: 0, t: t1, base, g: G(s) || g || undefined,
    sent: `Translate ${s.np}: ${entries.map(([k, v]) => `${k.np} becomes ${v.np}`).join(", ")}; anything else ${dflt ? `becomes ${dflt.np}` : "is kept as it is"}`,
  };
}

// ------------------------------------------------------------------------------------------ if / otherwise
const IF_HEAD = /^(?:(?:and|but|then|also|so)\s+)*(?:only\s+)?(if|when|whenever|in case|incase|where|once|provided that|provided|as long as|unless|given that|assuming)\s+/i;
const IF_MID = /\s+(?:only\s+)?(if|when|whenever|in case|incase|provided that|provided|as long as|unless|only when|given that)\s+/gi;
const ELSE_RE = /\s*[,;.]?\s*(?<![\w⟧])(?:or else|otherwise|else|if not(?: then)?|in other cases|in all other cases|for everything else|for all others|for anything else|in any other case)(?![\w⟦])\s*[,:]?\s*/gi;
const THEN_RE = /\s*,\s*then\s+|\s+then\s+|\s*(?:->|=>)\s*|\s*[,:]\s*/gi;
const STRONG_VERBS = new Set("uppercase lowercase upper lower trim trimmed capitalize capitalise capitalized titlecase capitals caps reverse reversed round rounded initials strip stripped hash mask masked negate invert stringify".split(" "));
const flip = (x: X): X => (x.kind === "empty" && x.base ? cond(x.base, `$not($isEmpty(${x.base.e}))`, `${x.base.np} has a value`, "nonempty", 0, x.g)
  : x.kind === "nonempty" && x.base ? cond(x.base, `$isEmpty(${x.base.e})`, `${x.base.np} is empty or missing`, "empty", 0, x.g)
  : negate(x, / is (?:true|false)(?: \(.*\))?$/.test(x.np) ? x.np.replace(/ is (true|false)/, " is not $1") : `it is not true that ${x.np}`));
function parseAction(c: Ctx, raw: string, subj?: X): X | null {
  const t = clean(raw).replace(/^(?:(?:then|and then|so|just|simply|we|i|you|should|must|need to|have to|want to|send back|send|pass on|pass)\s+)+/i, "");
  if (!t) return null;
  if (/^(?:leave (?:it )?out|skip(?: it)?|omit(?: it)?|drop (?:it|field)|do not (?:map|set|send|include|output|return)(?: it| anything)?|no value|not mapped|nothing at all|exclude(?: it)?|ignore(?: it)?)$/i.test(t)) return { e: "", np: "nothing", p: 0, kind: "omit" };
  if (/^(?:leave (?:it )?(?:empty|blank)|(?:set|make|keep|return|use)(?: it)?(?: to| as)? (?:empty|blank|an empty (?:string|text|value))|empty|blank)$/i.test(t)) return lit("");
  const v = parseAny(c, t, subj);
  if (v && /^[a-z]+$/.test(t) && !v.lit && v.e !== subj?.e && !STRONG_VERBS.has(t)) return { ...lit(t), g: true };
  if (v) return v;
  const bare = t.replace(/^(?:(?:use|return|set(?: it)? to|set|put|write|output|show|give|make it|it is|it should be|it will be|should be|be|say|display|print|then|just|value|text|word|map(?: it)? to|=|to|as|is)\s+)+/i, "");
  if (c.pool && bare.split(/\s+/).some((x) => /^[a-z]+$/.test(x) && c.pool!.some((pi) => pi.keys.includes(singular(x))))) return null;
  return valArg(c, bare, true);
}
/**
 * A rule about the values of a list ("if name came as two words" where name is a list of names) is decided
 * for each item on its own; the condition cannot be asked of the list as a whole.
 */
function perItem(c: Ctx, root: X, build: (el: X) => X | null): X | null {
  const el: X = { e: "$v", np: "it", p: 0, t: root.elemT, field: "$v" };
  const keep = { each: c.each, memo: c.memo, ds: c.defaultSubject };
  c.each = { path: root.field!, x: el }; c.memo = new Map();
  if (keep.ds && keep.ds.e === root.e) c.defaultSubject = el;
  let r: X | null = null;
  try { r = build(el); } finally { c.each = keep.each; c.memo = keep.memo; c.defaultSubject = keep.ds; }
  if (!r || !r.e || r.kind === "omit" || !r.sent) return null;
  // another list in the same rule cannot be read item by item alongside this one
  if (c.fields.some((f) => f.path !== root.field && f.t === "array" && r!.e.includes(f.path))) return null;
  return { e: `$map(${root.e}, function($v) { ${r.e} })[]`, np: `${root.np}, each item decided on its own`, p: 0, t: "array", elemT: r.t, g: G(r, root), kind: "if",
    sent: `For each item of ${root.np}: ${r.sent.charAt(0).toLowerCase()}${r.sent.slice(1)}` };
}
function buildCond(c: Ctx, condRaw: string, actRaw: string, neg: boolean, elseRaw: string | null, subj?: X): X | null {
  if (!clean(condRaw) || !clean(actRaw)) return null;
  let cnd = parseCond(c, condRaw, subj);
  let act: X | null = null;
  if (!cnd) {
    if (subj || c.defaultSubject) return null;
    act = parseAction(c, actRaw, undefined); const f = fieldOf(act);
    if (!act || !f || !f.field) return null;
    cnd = parseCond(c, condRaw, f); if (!cnd) return null;
  }
  const root = fieldOf(cnd.base);
  if (!c.each && !c.rel && root?.field && root.e === root.field && root.t === "array" && (root.elemT === "string" || root.elemT === "number" || root.elemT === "boolean")
    && !LIST_KINDS.has(cnd.kind ?? "") && (!subj || subj.e === root.e || fieldOf(subj)?.e !== root.e)) {
    const r = perItem(c, root, (el) => buildCond(c, condRaw, actRaw, neg, elseRaw, subj && subj.e === root.e ? el : subj));
    if (r) return r;
  }
  const asubj = subj ?? c.defaultSubject ?? root;
  act = act ?? parseAction(c, actRaw, asubj); if (!act) return null;
  let els: X | null = null;
  if (elseRaw !== null) { els = parseAction(c, elseRaw, asubj); if (!els) return null; }
  if (neg) cnd = flip(cnd);
  const g = G(cnd, act, els);
  const S = cnd.base;
  const af = fieldOf(act);
  // emptiness reads better as "the first one that has a value"
  if (S && cnd.kind === "empty" && act.kind !== "omit" && (act.lit || !af || af.e !== root?.e) && (!els || els.e === S.e))
    return { e: `$coalesce(${S.e}, ${act.e})`, np: `${S.np}, or ${act.np} when it is empty`, p: 0, t: S.t ?? act.t, g, kind: "default", sent: `Use ${S.np}; when it is empty or missing use ${act.np}` };
  if (S && cnd.kind === "nonempty" && els && els.kind !== "omit" && act.e === S.e)
    return { e: `$coalesce(${S.e}, ${els.e})`, np: `${S.np}, or ${els.np} when it is empty`, p: 0, t: S.t ?? els.t, g, kind: "default", sent: `Use ${S.np}; when it is empty or missing use ${els.np}` };
  if (act.kind === "omit") { if (els && els.kind === "omit") return null; if (!els) { if (!root) return null; els = root; } cnd = flip(cnd); act = els; els = null; }
  else if (els && els.kind === "omit") els = null;
  else if (!els && !act.lit && af && act.e !== af.e && asubj && (af.e === root?.e || af.e === fieldOf(asubj)?.e)) els = af;   // a change to the value itself: otherwise keep it
  const say = (x: X): string => {
    if (root && x.e === root.e) return "keep it as is";
    if (x.lit || x.field) return `use ${x.np}`;
    const xf = fieldOf(x);
    if (!x.sent && root && xf && xf.e === root.e && x.vps?.length) { const v = x.vps.join(", then "); return cnd!.kind === "words" ? v.replace(/^join its words with /, "join them with ") : v; }
    if (x.sent) return x.sent.charAt(0).toLowerCase() + x.sent.slice(1);
    return `use ${x.np}`;
  };
  const e = els ? `${w(cnd, 5.2)} ? ${w(act, 5.5)} : ${w(els, 6)}` : `${w(cnd, 5.2)} ? ${w(act, 5.5)}`;
  return { e, np: "the result", p: 6, t: !els || els.t === act.t ? act.t : undefined, g, kind: "if", sent: `If ${cnd.np}, ${say(act)}, otherwise ${els ? say(els) : "leave it out"}` };
}
function condMain(c: Ctx, mainRaw: string, elseRaw: string | null, subj?: X): X | null {
  const main = clean(mainRaw);
  const pairs: [string, string, boolean][] = [];
  const head = IF_HEAD.exec(main);
  if (head) {
    const rest = main.slice(head[0].length); const neg = /unless/i.test(head[1]); const seen = new Set<number>();
    for (const m of rest.matchAll(THEN_RE)) { seen.add(m.index!); pairs.push([rest.slice(0, m.index), rest.slice(m.index! + m[0].length), neg]); }
    for (const m of rest.matchAll(/\s+/g)) if (!seen.has(m.index!)) pairs.push([rest.slice(0, m.index), rest.slice(m.index! + m[0].length), neg]);
  } else for (const m of main.matchAll(IF_MID)) pairs.push([main.slice(m.index! + m[0].length), main.slice(0, m.index), /unless/i.test(m[1])]);
  let guess: X | null = null;
  for (const [ct, at_, neg] of pairs) {
    if (c.budget <= 0) break;
    const r = buildCond(c, ct, at_, neg, elseRaw, subj);
    if (r && !r.g) return r;
    guess = guess ?? r;
  }
  return guess;
}
function parseConditional(c: Ctx, raw: string, subj?: X): X | null {
  const t = clean(raw);
  if (!IF_HEAD.test(t) && !/\s(?:if|when|whenever|in case|incase|provided|as long as|unless|only when|given that)\s/i.test(t)) return null;
  const tries: [string, string | null][] = [];
  for (const m of t.matchAll(ELSE_RE)) if (m.index! > 0) tries.push([t.slice(0, m.index), t.slice(m.index! + m[0].length)]);
  if (IF_HEAD.test(t)) for (const m of t.matchAll(/\s*[,;]\s*(?:and\s+|but\s+|or\s+)?(?=(?:if|when)\s)/gi)) if (m.index! > 0) tries.push([t.slice(0, m.index), t.slice(m.index! + m[0].length)]);
  const tm = /^(.*),\s*(.+?)\s+otherwise$/i.exec(t); if (tm) tries.push([tm[1], tm[2]]);
  tries.push([t, null]);
  let guess: X | null = null;
  for (const [main, elseRaw] of tries) {
    if (elseRaw !== null && !clean(elseRaw)) continue;
    const r = condMain(c, main, elseRaw, subj);
    if (r && !r.g) return r;
    guess = guess ?? r;
  }
  return guess;
}

// ------------------------------------------------------------------------------------------ several fields: join, arithmetic, first that has a value
const LIST_SPLIT = "\\s*,\\s*(?:and\\s+|then\\s+)?|\\s+and\\s+|\\s+then\\s+|\\s+followed\\s+by\\s+|\\s*&\\s*|\\s+\\+\\s+|\\s+plus\\s+|\\s+along\\s+with\\s+|\\s+together\\s+with\\s+";
function listOf(c: Ctx, raw: string, subj: X | undefined, loose = false): X[] | null {
  const parts = clean(raw).split(new RegExp(loose ? LIST_SPLIT + "|\\s+with\\s+|\\s+to\\s+" : LIST_SPLIT, "i")).map(clean).filter(Boolean);
  if (parts.length < 2) return null;
  const out: X[] = [];
  for (const p of parts) { const l = litText(c, p); const v = parseValue(c, p, subj) ?? (l !== null ? lit(l) : null); if (!v) return null; out.push(v); }
  return out;
}
const names = (xs: X[]) => (xs.length <= 2 ? xs.map((x) => x.np).join(" and ") : `${xs.slice(0, -1).map((x) => x.np).join(", ")} and ${xs[xs.length - 1].np}`);
function concat(xs: X[], sep: string, guessed: boolean): X {
  const parts: string[] = [];
  xs.forEach((x, i) => { if (i && sep !== "") parts.push(q(sep)); parts.push(x.t === "number" || x.t === "boolean" ? `$string(${x.e})` : w(x, 3)); });
  return { e: parts.join(" & "), np: `${names(xs)} joined${sep === "" ? "" : " with " + show(sep)}`, p: 3, t: "string", g: G(...xs) || guessed || undefined, sent: sep === "" ? `Join ${names(xs)} together` : `Join ${names(xs)} with ${show(sep)}` };
}
function rowWise(c: Ctx, a: X, b: X): { parent: string; a: string; b: string } | null {
  if (!a.field || !b.field) return null;
  const fa = c.fields.find((f) => f.path === a.field), fb = c.fields.find((f) => f.path === b.field);
  if (!fa?.arr || !fb?.arr || fa.root || fb.root) return null;
  const pa = a.field.slice(0, Math.max(0, a.field.lastIndexOf("."))), pb = b.field.slice(0, Math.max(0, b.field.lastIndexOf(".")));
  if (!pa || pa !== pb) return null;
  const leaf = (f: FieldRef) => (f.elemT === "number" ? f.path.slice(pa.length + 1) : `$number(${f.path.slice(pa.length + 1)})`);
  return { parent: pa, a: leaf(fa), b: leaf(fb) };
}
function binary(c: Ctx, a: X, op: string, b: X): X {
  if (op === "*") { const rw = rowWise(c, a, b); if (rw) return { e: `${rw.parent}.(${rw.a} * ${rw.b})`, np: `${a.np} times ${b.np} for each of ${rw.parent}`, p: 0, t: "array", elemT: "number", g: G(a, b), sent: `For each of ${rw.parent}, multiply ${a.np} by ${b.np}` }; }
  const p = op === "*" || op === "/" ? 1 : 2;
  const word = op === "*" ? "times" : op === "/" ? "divided by" : op === "+" ? "plus" : "minus";
  const np = `${a.np} ${word} ${b.np}`;
  return { e: `${w(a, p)} ${op} ${w(b, p - 0.5)}`, np, p, t: "number", g: G(a, b), sent: `Calculate ${np}` };
}
const ADD_RE = /\s+(plus|minus|less|added to)\s+|\s+(\+|-)\s+/gi;
const MUL_RE = /\s+(times|multiplied by|multiplied with|divided by|over|x)\s+|\s*(\*|\/)\s*/gi;
function arith(c: Ctx, t: string, subj: X | undefined, level: 1 | 2): X | null {
  const ms = [...t.matchAll(level === 2 ? ADD_RE : MUL_RE)];
  for (let i = ms.length - 1; i >= 0; i--) {
    if (c.budget-- <= 0) return null;
    const l = t.slice(0, ms[i].index), r = t.slice(ms[i].index! + ms[i][0].length);
    const k = (ms[i][1] ?? ms[i][2]).toLowerCase().replace(/\s+/g, " ");
    const op = level === 2 ? (k === "plus" || k === "+" || k === "added to" ? "+" : "-") : (k === "times" || k.startsWith("multiplied") || k === "x" || k === "*" ? "*" : "/");
    const right = (level === 2 ? arith(c, r, subj, 1) : null) ?? numArg(c, r, subj); if (!right) continue;
    const left = arith(c, l, subj, level) ?? (level === 2 ? arith(c, l, subj, 1) : null) ?? numArg(c, l, subj); if (!left) continue;
    return binary(c, left, op, right);
  }
  return level === 2 ? arith(c, t, subj, 1) : null;
}
function parseCombo(c: Ctx, raw: string, subj?: X): X | null {
  const t = clean(raw).replace(/^(?:(?:please|just|simply|always|calculate|compute|get|take|return|give|show|find|output|use|it is|it should be|should be|equals|=|is|value of|result of)\s+)+/i, "");
  if (!fieldIds(t).length) return null;
  const val = (r: string) => parseValue(c, r, subj);
  const real = (xs: X[]) => xs.filter((x) => !x.lit).length;
  let m: RegExpExecArray | null;
  // dates: "days between A and B"
  const dd = (unit: string, a: X | null, b: X | null): X | null => (a && b ? { e: `$dateDiff(${a.e}, ${b.e}, ${q(unit)})`, np: `the ${unit} between ${a.np} and ${b.np}`, p: 0, t: "number", g: G(a, b), sent: `Count the whole ${unit} from ${a.np} to ${b.np}` } : null);
  if ((m = rx("(?:number of |count of |how many |count |total )?{UNIT} (?:between|from) {X} (?:and|to|until|till|up to) {X}").exec(t))) { const r = dd(unitOf(m[1]), val(m[2]), val(m[3])); if (r) return r; }
  if ((m = rx("(?:difference|diff|gap|duration|time|period|interval|length of stay)(?: in {UNIT})? (?:between|from|of) {X} (?:and|to|until|till) {X}(?: in {UNIT})?").exec(t)) && (m[1] || m[4])) {
    const r = dd(unitOf(m[1] ?? m[4]), val(m[2]), val(m[3]));
    if (r && /^(?:difference|diff|gap)\b/i.test(t) && /\sbetween\s/i.test(t)) return { ...r, e: `$abs(${r.e})`, sent: r.sent!.replace(/ from (.*) to /, " between $1 and ") };
    if (r) return r;
  }
  if ((m = rx("{X} (?:minus|-) {X} in {UNIT}").exec(t))) { const r = dd(unitOf(m[3]), val(m[2]), val(m[1])); if (r) return r; }
  // joining text
  const CAT = "(?:concatenate|concat|join|combine|merge|put together|glue|string together|stitch|chain|concatenation of|combination of)";
  const SEP_TAIL = "(?: (?:in between|between(?: them)?|as (?:a )?separator|as (?:a )?delimiter|in middle|as glue))?";
  if ((m = rx("(?:(?:add|put|insert|place|use|with|have|keep) )?{X} (?:in )?between {X}").exec(t))) {
    const sep = litText(c, m[1]); const xs = sep === null ? null : listOf(c, m[2], subj);
    if (xs && real(xs) >= 2) return concat(xs, sep!, false);
  }
  for (const src of [`${CAT}(?: together)? {X} (?:with|using|separated by|delimited by|separated with|by|and put|putting|adding|and add|and insert|inserting) {X}${SEP_TAIL}`, "{X} (?:joined|separated|delimited|concatenated|combined|merged)(?: together)? (?:with|by|using) {X}", "{X} with {X} (?:in between|between(?: them)?|in middle|as (?:a )?separator)"]) {
    if (!(m = rx(src).exec(t))) continue;
    const sep = litText(c, m[2]); const xs = sep === null ? null : listOf(c, m[1], subj);
    if (xs && real(xs) >= 2) return concat(xs, sep!, false);
  }
  if ((m = rx("(append|prepend) {X} to {X}").exec(t))) { const a = val(m[2]) ?? textArg(c, m[2]), b = val(m[3]); if (a && b && real([a, b]) >= 1) return concat(m[1].toLowerCase() === "append" ? [b, a] : [a, b], "", false); }
  if ((m = rx(`(${CAT})(?: together)? {X}`).exec(t))) {
    const xs = listOf(c, m[2], subj, true); const loose = /^(?:join|combine|merge|put together)/i.test(m[1]);
    if (xs && (real(xs) >= 2 || (real(xs) === 1 && !loose))) return concat(xs, loose && real(xs) === xs.length ? " " : "", loose && real(xs) === xs.length);
  }
  if ((m = rx("{X} (?:together|combined|joined|concatenated|merged|joined together|put together)").exec(t))) { const xs = listOf(c, m[1], subj); if (xs && real(xs) >= 2) return concat(xs, real(xs) === xs.length ? " " : "", real(xs) === xs.length); }
  if (/\sfollowed\s+by\s|\s&\s/i.test(t)) { const xs = listOf(c, t, subj); if (xs && real(xs) >= 1) return concat(xs, "", false); }
  // numbers
  const n = (r: string) => numArg(c, r, subj);
  const two = (a: X | null, op: string, b: X | null, sent: (a: X, b: X) => string): X | null => { if (!a || !b || (a.lit && b.lit)) return null; const r = binary(c, a, op, b); return r.t === "array" ? r : { ...r, sent: sent(a, b) }; };
  if ((m = rx("(?:sum|total|sum up|add up)(?: of)? {X} (?:times|x|\\*|multiplied by) {X}(?: (?:for|of|across|over|in) (?:each|all|every) (?:items?|lines?|rows?|entry|entries|one))?").exec(t))) {
    const a = n(m[1]), b = n(m[2]); const rw = a && b ? rowWise(c, a, b) : null;
    if (rw) return { e: `$sum(${rw.parent}.(${rw.a} * ${rw.b}))`, np: `the total of ${a!.np} times ${b!.np}`, p: 0, t: "number", g: G(a, b), sent: `For each of ${rw.parent}, multiply ${a!.np} by ${b!.np}, then add up the results` };
  }
  if ((m = rx("(?:multiply|product of) {X} (?:by|with|and|times) {X}").exec(t))) { const r = two(n(m[1]), "*", n(m[2]), (a, b) => `Multiply ${a.np} by ${b.np}`); if (r) return r; }
  if ((m = rx("(?:divide {X} by {X}|ratio of {X} to {X}|quotient of {X} (?:and|by) {X})").exec(t))) { const r = two(n(m[1] ?? m[3] ?? m[5]), "/", n(m[2] ?? m[4] ?? m[6]), (a, b) => `Divide ${a.np} by ${b.np}`); if (r) return r; }
  if ((m = rx("subtract {X} from {X}").exec(t))) { const r = two(n(m[2]), "-", n(m[1]), (a, b) => `Subtract ${b.np} from ${a.np}`); if (r) return r; }
  if ((m = rx("(?:difference|diff) (?:between|of) {X} and {X}").exec(t))) { const r = two(n(m[1]), "-", n(m[2]), (a, b) => `Subtract ${b.np} from ${a.np}`); if (r) return r; }
  if ((m = rx("add {X} (?:to|and|with) {X}").exec(t)) && !/\s(?:and|,)\s/.test(m[2])) { const r = two(n(m[2]), "+", n(m[1]), (a, b) => `Add ${a.np} and ${b.np}`); if (r) return r; }
  if ((m = rx("(?:{X} as (?:a )?(?:percentage|percent) of {X}|(?:percentage|percent) of {X} (?:in|of|over|out of|relative to|compared to) {X})").exec(t))) {
    const a = n(m[1] ?? m[3]), b = n(m[2] ?? m[4]);
    if (a && b && !(a.lit && b.lit)) return { e: `${w(a, 1)} / ${w(b, 0.5)} * 100`, np: `${a.np} as a percentage of ${b.np}`, p: 1, t: "number", g: G(a, b), sent: `Calculate ${a.np} as a percentage of ${b.np}` };
  }
  if ((m = rx("(sum|total|addition|sum up|add up|add|average|mean|avg|larger|greater|bigger|higher|maximum|max|largest|highest|greatest|smaller|lower|lesser|minimum|min|smallest|lowest|least)(?: (?:of|between|among|from))?(?: all)? {X}").exec(t))) {
    const xs = listOf(c, m[2], subj)?.map((x) => (x.t === "number" ? x : x.lit ? null : { ...x, e: `$number(${x.e})`, p: 0, t: "number" as T }));
    if (xs && xs.every(Boolean) && real(xs as X[]) >= 1) {
      const ys = xs as X[]; const k = m[1].toLowerCase();
      if (/^(?:sum|total|addition|sum up|add up|add)$/.test(k)) return { e: ys.map((x) => w(x, 2)).join(" + "), np: `the sum of ${names(ys)}`, p: 2, t: "number", g: G(...ys), sent: `Add ${names(ys)}` };
      const fn = /^(?:average|mean|avg)$/.test(k) ? ["$average", "the average"] : /^(?:larger|greater|bigger|higher|maximum|max|largest|highest|greatest)$/.test(k) ? ["$max", "the largest"] : ["$min", "the smallest"];
      return { e: `${fn[0]}([${ys.map((x) => x.e).join(", ")}])`, np: `${fn[1]} of ${names(ys)}`, p: 0, t: "number", g: G(...ys), sent: `Take ${fn[1]} of ${names(ys)}` };
    }
  }
  if (/\s(?:plus|\+)\s/i.test(t) && !/\s(?:minus|less|times|multiplied|divided by|over|x)\s|[*\/]|\s-\s/i.test(t)) {
    const xs = listOf(c, t, subj);
    if (xs && real(xs) >= 2 && xs.every((x) => x.t === "string" && (x.field || x.lit))) { const plainList = real(xs) === xs.length; return concat(xs, plainList ? " " : "", plainList); }
  }
  if (/\s(?:plus|minus|less|added to|times|multiplied|divided by|over|x)\s|[*\/+]|\s-\s/i.test(t)) {
    for (const sm of t.matchAll(/\s*,\s*(?:and\s+|then\s+)?|\s+(?:and\s+then|then|and)\s+|\s+(?=(?:rounded|round|formatted|truncated|to|with|as|in)\s)/gi)) {
      const rest = t.slice(sm.index! + sm[0].length); if (!clean(rest) || fieldIds(rest).length || /^\d/.test(rest)) continue;
      const left = arith(c, t.slice(0, sm.index), subj, 2); if (!left || left.lit) continue;
      const r = oneStep(c, rest, left); if (r) return r;
    }
    const r = arith(c, t, subj, 2); if (r && !r.lit) return r;
  }
  // the first one that has a value
  const first = (xs: (X | null)[]): X | null => {
    if (xs.length < 2 || xs.some((x) => !x) || xs[0]!.lit) return null; const ys = xs as X[];
    return { e: `$coalesce(${ys.map((x) => x.e).join(", ")})`, np: `the first of ${names(ys)} that has a value`, p: 0, t: ys[0].t, g: G(...ys), kind: "default", sent: ys.length === 2 ? `Use ${ys[0].np}; when it is empty or missing use ${ys[1].np}` : `Use the first of ${names(ys)} that has a value` };
  };
  const orVal = (r: string) => val(r) ?? valArg(c, clean(r), true);
  if ((m = rx("(?:first|1st) (?:non-?empty|available|present|non-?null|non-?blank|filled|populated|existing|defined)(?: value| one)?(?: (?:of|from|among|out of|between|in))? {X}").exec(t)) || (m = rx("(?:whichever|which ever)(?: of)? {X} (?:is|has)(?: (?:a|not))? (?:present|available|empty|filled|value|set|there)").exec(t))) {
    const r = first(clean(m[1]).split(new RegExp(LIST_SPLIT + "|\\s+or\\s+", "i")).map(clean).filter(Boolean).map(orVal)); if (r) return r;
  }
  if (/\s(?:or|otherwise|else)\s/i.test(t)) { const r = first(t.split(/\s*,?\s+(?:or else|or if not|or|otherwise|else)\s+/i).map(clean).filter(Boolean).map(orVal)); if (r) return r; }
  {
    // several fields, each with its own change: "first name in caps and last name in small letters", "INV- plus the number padded to 6 digits"
    const parts = t.split(new RegExp(LIST_SPLIT, "i")).map(clean).filter(Boolean);
    const withField = parts.filter((x) => fieldIds(x).length === 1);
    if (parts.length >= 2 && parts.every((x) => fieldIds(x).length <= 1) && withField.length >= 1 && withField.some((x) => !/^⟦f\d+⟧$/.test(x)) && (withField.length >= 2 || withField.length < parts.length) && !/(?:^|\s)(?:without|remove|removing|removed|strip|stripping|delete|deleting|drop|dropping|replace|replacing|except|excluding|no)\s/i.test(t)) {
      const xs: X[] = [];
      for (const part of parts) {
        if (fieldIds(part).length) { const v = parseSingle(c, part, undefined); if (!v || v.lit) { xs.length = 0; break; } xs.push(v); continue; }
        const l = litText(c, part) ?? (/^[A-Z0-9][A-Z0-9_\-#\/:.]*$/.test(part) ? part : null);
        if (l === null || (withField.length < 2 && /^(?:an?\s+)?[a-z ]+$/i.test(part) && !/^[A-Z0-9]+$/.test(part))) { xs.length = 0; break; }
        xs.push(lit(l));
      }
      if (xs.length) { const plainList = real(xs) === xs.length; return concat(xs, plainList ? " " : "", plainList); }
    }
  }
  { const xs = listOf(c, t, subj); if (xs && xs.every((x) => x.field || x.lit) && real(xs) >= 2) { const plainList = real(xs) === xs.length; return concat(xs, plainList ? " " : "", plainList); } }
  if ((m = rx("{X}(?:,)? (?:falling back to|fall back to|fallback to|with fallback(?: to| of)?|with default(?: of)?|defaulting to|(?:or |and |but )?(?:if|when) (?:it is |that is |it's )?{EMPTY}(?: then)?(?: use| take)?) {X}").exec(t))) { const r = first([val(m[1]), orVal(m[2])]); if (r) return r; }
  return null;
}

// ------------------------------------------------------------------------------------------ fields inside lists: "price of the first item", "items where status is active"
function rewrite(c: Ctx, text: string): string {
  let t = text;
  const under = (a: FieldRef, b: FieldRef) => !a.root && !b.root && a.path.startsWith(b.path + ".");
  const rest = (a: FieldRef, b: FieldRef) => a.path.slice(b.path.length + 1);
  const pool = c.pool ?? [];
  // the real list a field lives in ("order.lines" for order.lines.sku)
  const arrayRoot = (f: FieldRef): string | undefined => {
    if (f.root) return undefined;
    const segs = f.path.split(".");
    for (let i = 1; i <= segs.length; i++) { const p = segs.slice(0, i).join("."); if (pool.find((x) => x.path === p)?.arr) return p; }
    return undefined;
  };
  // the same words read as a field under B ("status" inside "lines where status is ...")
  const reres = (id: number, B: FieldRef): number => {
    const f = c.fields[id]; if (under(f, B)) return id;
    if (f.how === "explicit" || f.root) return -1;
    const key = norm(splitWords(f.said)); if (!key) return -1;
    const hit = pool.filter((p) => p.path.startsWith(B.path + ".") && p.keys.includes(key)).sort((x, y) => x.segs.length - y.segs.length)[0];
    return hit ? addField(c, { path: hit.path, t: hit.t, elemT: hit.elemT, arr: hit.arr, how: f.how === "ambiguous" ? "name" : f.how, said: f.said }) : -1;
  };
  for (let guard = 0; guard < 6; guard++) {
    const before = t;
    const fm = /(?:⟦f(\d+)⟧\s+(?:of|from|in|for|on)\s+(?:all\s+|each\s+|every\s+|those\s+)?)?⟦f(\d+)⟧\s+(where|whose|that have|that has|which have|which has|having|with|for which|that are|which are|that is|which is)\s+(.+)$/i.exec(t);
    if (fm) {
      let A = fm[1] !== undefined ? c.fields[+fm[1]] : undefined; let B = c.fields[+fm[2]]; let ok = true;
      const ar = arrayRoot(B);
      if (!A && ar && ar !== B.path) { const parent = pool.find((x) => x.path === ar)!; A = B; B = { path: parent.path, t: parent.t, elemT: parent.elemT, arr: true, how: B.how, said: parent.path }; }
      else if (A && !under(A, B)) { const id = reres(+fm[1], B); if (id >= 0) A = c.fields[id]; else ok = false; }
      if (ok && B.arr && !B.root && arrayRoot(B) === B.path) {
        const tail = fm[4]; const cuts = [tail.length, ...[...tail.matchAll(CONNECT)].map((x) => x.index!).reverse()];
        for (const cut of cuts) {
          let ct = tail.slice(0, cut); let fine = true;
          for (const id of fieldIds(ct)) {
            if (under(c.fields[id], B)) continue;
            const nid = reres(id, B);
            if (nid < 0 && c.fields[id].how === "explicit") { fine = false; break; }
            ct = ct.split(ph(id)).join(nid >= 0 ? ph(nid) : c.fields[id].said);
          }
          if (!fine || !fieldIds(ct).length) continue;
          c.rel = B.path; let cd: X | null = null;
          try { cd = parseCond(c, ct); if (!cd && /^(?:whose|having|with)$/i.test(fm[3])) cd = parseCond(c, ct.replace(/^(\s*⟦f\d+⟧)\s+/, "$1 is ")); } finally { c.rel = undefined; }
          if (!cd) continue;
          const id = addField(c, { path: `${B.path}[${cd.e}]${A ? "." + rest(A, B) : ""}`, t: "array", elemT: A ? A.elemT : B.elemT, arr: true, how: A && A.how !== "explicit" && A.how !== "name" ? A.how : B.how === "ambiguous" ? "name" : B.how, said: `${A ? rest(A, B) + " of " : ""}${B.path} where ${cd.np}`, root: B.path, guess: cd.g });
          t = t.slice(0, fm.index) + ph(id) + tail.slice(cut);
          break;
        }
      }
    }
    // "customer is active": a yes/no field of that object
    t = t.replace(/⟦f(\d+)⟧\s+(is|are)(\s+not)?\s+⟦f(\d+)⟧/gi, (whole, a: string, _v: string, not: string | undefined, b: string) => {
      const A = c.fields[+a]; if (A.t !== "object" || A.root) return whole;
      const id = reres(+b, A); return id >= 0 ? `${ph(id)} is${not ? " not" : ""} true` : whole;
    });
    const pick = (aId: string, ord: string, bId: string, whole: string): string => {
      const B = c.fields[+bId]; if (B.root || arrayRoot(B) !== B.path) return whole;
      const rid = reres(+aId, B); if (rid < 0) return whole;
      const A = c.fields[rid]; const i = toOrd(ord);
      return ph(addField(c, { path: `${B.path}[${i}].${rest(A, B)}`, t: A.elemT, arr: false, how: A.how, said: `the ${rest(A, B)} of the ${ordName(i)} item of ${B.path}`, root: B.path }));
    };
    t = t.replace(new RegExp(`⟦f(\\d+)⟧\\s+(?:of|from|in|for|on)\\s+${ORD}\\s+⟦f(\\d+)⟧`, "gi"), (whole, a: string, ord: string, b: string) => pick(a, ord, b, whole));
    t = t.replace(new RegExp(`${ORD}\\s+⟦f(\\d+)⟧(?:'s)?\\s+⟦f(\\d+)⟧`, "gi"), (whole, ord: string, b: string, a: string) => pick(a, ord, b, whole));
    t = t.replace(/⟦f(\d+)⟧\s+(?:of|from|in|for|on|inside|within)\s+(?:all\s+|each\s+|every\s+)?⟦f(\d+)⟧/gi, (whole, a: string, b: string) => {
      const B = c.fields[+b]; if (B.root) return whole;
      const id = B.t === "object" || arrayRoot(B) === B.path ? reres(+a, B) : under(c.fields[+a], B) ? +a : -1;
      return id >= 0 ? ph(id) : whole;
    });
    t = t.replace(/⟦f(\d+)⟧(?:'s)?\s+⟦f(\d+)⟧/gi, (whole, b: string, a: string) => (under(c.fields[+a], c.fields[+b]) ? ph(+a) : whole));
    if (t === before) break;
  }
  return t;
}

// ------------------------------------------------------------------------------------------ the whole sentence
function parseAny(c: Ctx, raw: string, subj?: X): X | null {
  const t = clean(raw); if (!t) return null;
  const key = `A|${c.rel ?? ""}|${subj?.e ?? ""}|${t}`; const hit = c.memo.get(key); if (hit !== undefined) return hit;
  if (c.budget-- <= 0) return null;
  c.memo.set(key, null);
  let r: X | null = null;
  const wm = /^(?:whether|check (?:if|whether|that)|(?:true|yes) (?:if|when|whenever)|flag (?:if|when|whether)|is it true that|true only (?:if|when))\s+(.+?)(?:,?\s+(?:otherwise|else)\s+(?:false|no)|,?\s+(?:and\s+)?false\s+otherwise)?$/i.exec(t);
  if (wm) { const cd = parseCond(c, wm[1], subj); if (cd) r = { e: cd.e, np: `whether ${cd.np}`, p: cd.p, t: "boolean", g: cd.g, sent: `True when ${cd.np}, otherwise false` }; }
  r = r ?? parseTable(c, t, subj) ?? parseConditional(c, t, subj) ?? parseCombo(c, t, subj) ?? parseSingle(c, t, subj);
  if (!r && fieldIds(t).length) {
    // something about several fields, then steps on the result: "join A and B with a space, then uppercase"
    const ms = [...t.matchAll(CONNECT)];
    for (let i = ms.length - 1; i >= 0 && !r; i--) {
      const rt = t.slice(ms[i].index! + ms[i][0].length); if (!clean(rt) || fieldIds(rt).length) continue;
      const left = parseAny(c, t.slice(0, ms[i].index), subj); if (!left || left.lit) continue;
      r = oneStep(c, rt, left);
    }
    if (!r && /(?:^|\s)(?:is|are|was|were|has|have|does|do|contains?|includes?|equals?|starts?|ends?|begins?|matches|exists?)(?:\s|$)|[<>=]/i.test(t)) { const cd = parseCond(c, t, subj); if (cd && !cd.g) r = { e: cd.e, np: `whether ${cd.np}`, p: cd.p, t: "boolean", g: true, sent: `True when ${cd.np}, otherwise false` }; }
  }
  c.memo.set(key, r);
  return r;
}
function explain(x: X): string {
  if (x.sent) return x.sent;
  if (x.lit) return `Always ${x.np}`;
  if (x.field) return /^the /.test(x.np) || / where /.test(x.np) ? `Use ${x.np}` : `Copy ${x.np} as it is`;
  if (x.base && x.vps?.length) return x.vps.length === 1 ? `Take ${x.base.np} and ${x.vps[0]}` : `Take ${x.base.np}, ${x.vps.slice(0, -1).join(", ")}, then ${x.vps[x.vps.length - 1]}`;
  return `Use ${x.np}`;
}

// ------------------------------------------------------------------------------------------ compile
const newCtx = (lits: Lit[]): Ctx => ({ fields: [], lits, notes: [], memo: new Map(), budget: 2500 });
function infoOf(f: FieldRef): PathInfo {
  const segs = f.path.replace(/\[\d+\]/g, "").split(".").map((s) => s.replace(/`/g, "")).filter(Boolean);
  const ws = segs.map(splitWords); const keys = new Set<string>([norm(ws[ws.length - 1] ?? [])]);
  if (ws.length > 1) keys.add(norm([...ws[ws.length - 2], ...ws[ws.length - 1]]));
  keys.add(norm(ws.flat()));
  return { path: f.path, segs, t: f.t, elemT: f.elemT, arr: f.arr, keys: [...keys].filter(Boolean) };
}
const restore = (c: Ctx, t: string) => t.replace(/⟦f(\d+)⟧/g, (_m, i: string) => c.fields[+i]?.said ?? "?").replace(/⟦q(\d+)⟧/g, (_m, i: string) => `"${c.lits[+i]?.text ?? ""}"`).replace(/\s+/g, " ").trim();
const PROTECT = /(`[^`]*`|\(\s*[\w.]+\s*\)|[\w$]*[._\d][\w.$[\]]*|[a-z]+[A-Z]\w*)/;
const looksLikeExpr = (s: string) => /\$[A-Za-z]\w*\s*\(/.test(s) || /\s&\s/.test(s) || /\?[^?]*:/.test(s) || /:=/.test(s) || /^\s*[{[]/.test(s);
interface Found { x: X; c: Ctx; text: string; guessed: boolean; typoNotes: string[]; }
interface Probe { c: Ctx; text: string; }

function tryVariant(vtext: string, lits: Lit[], paths: PathInfo[], req: CompileInstructionRequest, scalar: X | undefined, typoNotes: string[], probes: Probe[]): Found | null {
  const probe = newCtx(lits);
  const ptext = readExplicit(probe, vtext, paths);
  const pool = [...paths, ...probe.fields.filter((f) => !paths.some((p) => p.path === f.path)).map(infoOf)];
  const preferred = new Set(probe.fields.map((f) => f.path));
  const cands = findCandidates(ptext, pool, preferred, req.target);
  const plain = cands.map((cd, i) => (cd.intent ? -1 : i)).filter((i) => i >= 0);
  const allows: ((cd: Cand, i: number) => boolean)[] = [(cd) => !cd.intent || cd.soft, () => true, (cd) => !cd.intent];
  cands.forEach((cd, i) => { if (cd.intent) allows.push((x, j) => !x.intent || j === i); });
  allows.push(() => false);
  for (const i of plain.slice(0, 4)) allows.push((x, j) => !x.intent && j !== i);
  const seen = new Set<string>();
  for (const allow of allows.slice(0, 14)) {
    const c = newCtx(lits); c.pool = pool;
    let t = applyCandidates(c, readExplicit(c, vtext, paths), cands, allow);
    if (seen.has(t)) continue; seen.add(t);
    if (!c.fields.length && !c.defaultSubject) {
      if (scalar) c.defaultSubject = scalar;
      else {
        const leaf = req.target ? norm(splitWords(req.target.split(/[.[\]]+/).filter(Boolean).pop() ?? "")) : "";
        const scalars = paths.filter((p) => p.t !== "object" && p.t !== "array");
        const same = leaf ? paths.filter((p) => p.t !== "object" && p.keys[0] === leaf) : [];
        const pick = same.length === 1 ? same[0] : scalars.length === 1 && paths.length <= 3 ? scalars[0] : undefined;
        if (pick) {
          const id = addField(c, { path: pick.path, t: pick.t, elemT: pick.elemT, arr: pick.arr, how: "default", said: pick.path, guess: true });
          c.defaultSubject = fieldX(c, id);
          c.notes.push(`no input field was named, so ${pick.path} was assumed because ${same.length === 1 ? "it has the same name as the target" : "it is the only value in the sample"}`);
        }
      }
    }
    t = rewrite(c, t);
    if (probes.length < 2 || (!probes[probes.length - 1].c.fields.length && c.fields.length)) probes.push({ c, text: t });
    const x = parseAny(c, t);
    if (!x || x.kind === "omit" || !x.e || checkExpr(x.e)) continue;
    const used = c.fields.filter((f) => x.e.includes(f.path));
    const guessed = !!x.g || typoNotes.length > 0 || used.some((f) => f.how === "fuzzy" || f.how === "default" || f.how === "ambiguous" || f.guess);
    return { x, c, text: t, guessed, typoNotes };
  }
  return null;
}

/** Everyday sentence shapes rewritten into the shapes the parser knows. */
function normalize(t: string): string {
  return t
    .replace(/\?+$/, "")
    .replace(/^(?:(?:i|we)\s+(?:want|need|would like|wish)(?:\s+to\s+(?:have|get|see|show))?|give me|show me)\s+(?!⟦q)/i, "")
    .replace(/^does\s+(.+?)\s+(contain|include|start with|end with|begin with|have|exist|equal|match)(?![A-Za-z])/i, (_m, a: string, v: string) => `${a} ${v === "have" ? "has" : v === "match" ? "matches" : v.replace(/^([a-z]+)/i, "$1s")}`)
    .replace(/^(?:are|is)\s+there\s+(?:any|some)\s+(.+)$/i, "$1 is not empty")
    .replace(/\s+among(?:st)?\s+(?:all\s+)?(?:the\s+)?/gi, " of ")
    // "uppercase the first two characters of X" -> "first two characters of X in uppercase"
    .replace(/^(upper ?case|lower ?case|title ?case|capitali[sz]e|capitals|caps)\s+(?:of\s+)?(?:the\s+)?(?!first\s+(?:letter|character|char)\b)((?:first|last|second|third)\s+(?:(?!\s(?:and|then)\s).)+)$/i,
      (_m, w: string, rest: string) => `${rest} in ${/^upper|^cap(?:ital)?s/i.test(w) ? "uppercase" : /^lower/i.test(w) ? "lowercase" : "titlecase"}`)
    .replace(/\s+with\s+(⟦q\d+⟧|[^\s⟦]+)\s+removed(?![A-Za-z])/gi, ", remove $1")
    .trim();
}

/** The rule-based compiler. Synchronous and local; never calls anything. */
// "is one of "A", "B" or "C"": the commas belong to the list, not to the sentence
const ONE_OF_LIST = /\b(one of|any of|either|among|none of)\s+((?:"[^"]*"|'[^']*'|[\w.-]+)(?:\s*,\s*(?:or\s+|and\s+)?(?:"[^"]*"|'[^']*'|[\w.-]+))+(?:\s+(?:or|and)\s+(?:"[^"]*"|'[^']*'|[\w.-]+))?)/gi;
function listCommas(raw: string): string {
  // a plain path right before "is one of" is read as that field (the same as writing it in brackets)
  raw = raw.replace(/(?<![(\w.⟦])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)(?=\s+(?:is|are|was)\s+(?:not\s+)?(?:one of|any of|in|among|either|none of)\s)/g, "($1)");
  return raw.replace(ONE_OF_LIST, (_m, head: string, list: string) => `${head} ${list.split(/\s*,\s*(?:or\s+|and\s+)?|\s+(?:or|and)\s+/).filter(Boolean).join(" or ")}`);
}
/** "build an object with name from customer.name and mail from customer.email": one key per part. */
function buildObject(req: CompileInstructionRequest, raw: string): CompileOutcome | null {
  const m = /^(?:build|make|create|return|output|give|put together)\s+(?:an?\s+|the\s+)?(?:object|record|structure|json object)\s+(?:with|of|containing|having|that has)\s+(.+)$/i.exec(raw);
  if (!m) return null;
  const parts = m[1].split(/\s*[,;]\s*(?:and\s+)?|\s+and\s+(?=[A-Za-z_][\w-]*\s+(?:from|=|as|:|is|set to|taken from|copied from)\s)/i).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const keys: string[] = []; const exprs: string[] = []; const says: string[] = []; const fields: string[] = []; let guessed = false;
  for (const part of parts) {
    const pm = /^([A-Za-z_][\w-]*)\s+(?:from|=|as|:|is|set to|taken from|copied from)\s+(.+)$/i.exec(part);
    if (!pm) return { ok: false, compiled: null, understood: [], reason: `In "${part}" the key and its value were not recognised. Write each part as: key from field (for example: name from customer.name).`, suggestions: [], fields: [] };
    const sub = compileLocal({ ...req, instruction: pm[2], target: pm[1] }, { suggest: false });
    if (!sub.ok || !sub.compiled) return { ok: false, compiled: null, understood: [], reason: `The value of "${pm[1]}" (${pm[2]}) was not understood: ${sub.reason ?? "say it another way"}`, suggestions: [], fields: [] };
    keys.push(pm[1]); exprs.push(sub.compiled.expr); says.push(`${pm[1]} = ${sub.compiled.explanation.replace(/^./, (x) => x.toLowerCase())}`); fields.push(...sub.fields);
    if (sub.compiled.confidence !== "exact") guessed = true;
  }
  const expr = `{${keys.map((k, i) => `${JSON.stringify(k)}: ${exprs[i]}`).join(", ")}}`;
  return { ok: true, compiled: { expr, explanation: `An object with ${says.join("; ")}`, confidence: guessed ? "guessed" : "exact", engine: "rules" }, understood: [], suggestions: [], fields: fields.filter((f, i, a) => a.indexOf(f) === i) };
}

export function compileLocal(req: CompileInstructionRequest, opts: { suggest?: boolean } = {}): CompileOutcome {
  const raw = listCommas((req.instruction ?? "").replace(/\s+/g, " ").trim());
  const built = raw.length <= 600 ? buildObject(req, raw) : null;
  if (built) return built;
  const sample = req.sampleSource as unknown;
  const paths = sample !== null && typeof sample === "object" ? samplePaths(sample) : [];
  const wantSuggestions = opts.suggest !== false;
  if (!raw) return { ok: false, compiled: null, understood: [], reason: "The instruction is empty. Say in your own words what should go into this field.", suggestions: wantSuggestions ? suggest("", paths, [], req) : [], fields: [] };
  if (raw.length > 600) return { ok: false, compiled: null, understood: [], reason: "This instruction is very long. Describe one field at a time in a sentence or two; longer logic is easier to maintain as separate rules or as an expression.", suggestions: [], fields: [] };
  if (looksLikeExpr(raw) && !checkExpr(raw)) {
    const fields = paths.filter((p) => new RegExp(`(?<![\\w.$])${p.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`).test(raw)).map((p) => p.path);
    return { ok: true, compiled: { expr: raw, explanation: "Used as written (this is already an expression)", confidence: "exact", engine: "rules" }, understood: [], suggestions: [], fields };
  }
  const scalar: X | undefined = sample !== null && sample !== undefined && typeof sample !== "object" ? { e: "$", np: "the input", p: 0, t: typeOf(sample), field: "$" } : undefined;
  const { text: text0, lits } = readLiterals(raw);
  const text = normalize(text0);
  const variants = [text];
  const leaf = req.target ? (req.target.split(/[.[\]]+/).filter(Boolean).pop() ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
  const lead = new RegExp(`^(?:${leaf ? leaf + "|" : ""}target|it|output|result|this|value|field|this field|target field)\\s*(?:should be|must be|will be|shall be|needs to be|has to be|is|=|:)\\s+`, "i");
  if (lead.test(text)) variants.push(text.replace(lead, ""));
  const probes: Probe[] = [];
  let best: Found | null = null;
  for (const v of variants) { best = tryVariant(v, lits, paths, req, scalar, [], probes); if (best) break; }
  if (!best) {
    for (const v of variants) {
      const notes: string[] = [];
      let fixed = v.split(PROTECT).map((part, i) => (i % 2 ? part : fixTypos(part, paths, notes))).join("");
      if (fixed === v) continue;
      for (const [re, to] of FIXES) fixed = fixed.replace(re, to);
      const f = tryVariant(fixed, lits, paths, req, scalar, notes, probes);
      if (f) { best = f; break; }
    }
  }
  if (best) {
    const { x, c, guessed, typoNotes } = best;
    const used = c.fields.filter((f) => x.e.includes(f.path));
    const notes = [...typoNotes, ...c.notes];
    let explanation = explain(x); explanation = explanation.charAt(0).toUpperCase() + explanation.slice(1);
    if (guessed && notes.length) explanation += ` (${notes.join("; ")})`;
    const understood = [...used.filter((f) => f.how !== "explicit" && f.said !== f.path).map((f) => `"${f.said}" is the field ${f.path}`), ...notes];
    return { ok: true, compiled: { expr: x.e, explanation, confidence: guessed ? "guessed" : "exact", engine: "rules" }, understood, suggestions: [], fields: used.map((f) => f.root ?? f.path).filter((p, i, a) => a.indexOf(p) === i) };
  }
  return explainFailure(raw, probes, paths, req, wantSuggestions);
}

// ------------------------------------------------------------------------------------------ when it is not understood
function explainFailure(raw: string, probes: Probe[], paths: PathInfo[], req: CompileInstructionRequest, wantSuggestions: boolean): CompileOutcome {
  const probe = probes.find((p) => p.c.fields.length) ?? probes[0];
  const understood: string[] = []; const fields: string[] = [];
  let reason = `I could not work out what "${raw}" means.`;
  if (probe) {
    const c = probe.c;
    for (const f of c.fields) { const p = f.root ?? f.path; if (!fields.includes(p)) fields.push(p); understood.push(f.said === f.path ? `the field ${f.path}` : `"${f.said}" is the field ${f.path}`); }
    for (const n of c.notes) if (!understood.includes(n)) understood.push(n);
    const subject = c.defaultSubject ?? (c.fields.length ? fieldX(c, 0) : undefined);
    const clauses = probe.text.split(/\s*(?:;|,|->|=>)\s*|\s+(?:and then|then|and|otherwise|or else|else|if|when|unless|but)\s+/i).map(clean).filter(Boolean);
    const unclear: string[] = [];
    for (const cl of clauses) {
      if (/^⟦f\d+⟧$/.test(cl)) continue;
      const cc: Ctx = { ...newCtx(c.lits), fields: c.fields, defaultSubject: c.defaultSubject };
      const x = parseAny(cc, cl, subject) ?? parseCond(cc, cl, subject);
      if (x && clauses.length > 1) understood.push(`"${restore(c, cl)}": ${x.t === "boolean" && !x.sent && !x.vps ? x.np : explain(x).replace(/^./, (ch) => ch.toLowerCase())}`);
      else if (!x) unclear.push(restore(c, cl));
    }
    const noField = !c.fields.length && !c.defaultSubject;
    if (noField) {
      const eg = paths.find((p) => p.t !== "object" && p.t !== "array")?.path ?? "customer.name";
      reason = `It is not clear which input field this is about. Add it in brackets at the end, for example: ${raw} (${eg})`;
    } else if (unclear.length && clauses.length > 1) reason = `I could not work out what "${unclear[0]}" means${unclear.length > 1 ? ` (nor "${unclear.slice(1, 3).join('", "')}")` : ""}.`;
    else if (!unclear.length && clauses.length > 1) reason = "Each part makes sense on its own, but I could not combine them into one rule. Try one of the suggested wordings.";
    else reason = `I could not work out what "${restore(c, probe.text)}" means.`;
  }
  const out: CompileOutcome = { ok: false, compiled: null, understood, reason, suggestions: [], fields };
  if (wantSuggestions) out.suggestions = suggest(raw, paths, fields, req);
  return out;
}

const CATALOGUE: [RegExp, string[]][] = [
  [/upper|lower|capital|caps|\bcase\b|title/i, ["convert to upper case ({f})", "convert to lower case ({f})", "capitalize each word ({f})"]],
  [/word|join|split|between|underscore|hyphen|dash|space|separat|_/i, ["add _ in between if {f} has two words", "replace spaces with _ in {f}", "take the first word of {f}", "join the words with - ({f})"]],
  [/empty|blank|missing|null|default|fallback|fall back|not (?:present|available|there|given|set)|absent/i, ['if {f} is empty use "N/A"', "use {f} or {g}", 'default to "N/A" ({f})']],
  [/date|time|\bday|month|year|week|hour|iso\b/i, ['format {f} as "dd/MM/yyyy"', "add 7 days to {f}", "days between {f} and {g}", "year of {f}"]],
  [/round|decimal|number|amount|price|total|percent|%|multipl|divid|subtract|minus|plus|times|currency|cents|minor/i, ["round {f} to 2 decimals", "multiply {f} by 100", "add 15 percent to {f}", "convert {f} to minor units"]],
  [/means|stands for|translate|look ?up|\bmap\b|\bcodes?\b|becomes/i, ['"M" means "Male", "F" means "Female", anything else "Unknown" ({f})']],
  [/\bif\b|when|unless|otherwise|\belse\b|greater|less|more than|equal|contains|starts|ends/i, ['if {f} is greater than 100 then "high" otherwise "low"', 'if {f} equals "A" then "Active" otherwise "Inactive"', 'if {f} contains "@" then {f} otherwise "invalid"']],
  [/concat|combine|merge|together|append|prepend|prefix|suffix|\band\b|\+/i, ["join {f} and {g} with a space", 'add prefix "ID-" ({f})']],
  [/list|array|items|\beach\b|every|count|\bsum\b|average|\ball\b/i, ["count the items in {a}", "join {a} with a comma", "first item of {a}"]],
  [/character|\bchars?\b|digit|letter|\bpad|length|truncate|shorten|substring|first \d|last \d|zero/i, ["first 3 characters of {f}", "last 4 characters of {f}", "pad with zeros to 8 digits ({f})"]],
  [/\byes\b|\bno\b|true|false|boolean|flag/i, ["yes or no ({f})", 'if {f} is true then "Y" otherwise "N"']],
  [/remove|delete|strip|replace|swap|clean|trim/i, ["remove spaces from {f}", 'replace "-" with "/" in {f}', "trim {f}"]],
];
const FALLBACKS = ["convert to upper case ({f})", 'if {f} is empty use "N/A"', "trim and capitalize each word ({f})"];
/** Templates behind the suggestions (exported so the tests can check every one of them compiles). */
export const SUGGESTION_TEMPLATES: string[] = [...CATALOGUE.flatMap(([, ts]) => ts), ...FALLBACKS];
function suggest(raw: string, paths: PathInfo[], fields: string[], req: CompileInstructionRequest): string[] {
  const scalars = paths.filter((p) => p.t !== "object" && p.t !== "array").map((p) => p.path);
  const leaf = req.target ? norm(splitWords(req.target.split(/[.[\]]+/).filter(Boolean).pop() ?? "")) : "";
  const byName = leaf ? paths.find((p) => p.t !== "object" && p.keys[0] === leaf)?.path : undefined;
  const simple = fields.filter((p) => !/[[\]()]/.test(p) && paths.find((x) => x.path === p)?.t !== "object");
  const f = simple[0] ?? byName ?? scalars[0] ?? "customer.name";
  const g = simple.find((p) => p !== f) ?? scalars.find((p) => p !== f) ?? (f === "customer.lastName" ? "customer.firstName" : "customer.lastName");
  const a = simple.find((p) => paths.find((x) => x.path === p)?.t === "array") ?? paths.find((p) => p.t === "array" && !p.segs.slice(0, -1).some((_s, i) => paths.find((x) => x.path === p.segs.slice(0, i + 1).map(seg).join("."))?.t === "array"))?.path ?? "order.lines";
  const fill = (tpl: string) => tpl.replace(/\{f\}/g, f).replace(/\{g\}/g, g).replace(/\{a\}/g, a);
  const out: string[] = [];
  const add = (s: string) => { if (out.length < 4 && !out.includes(s) && s.toLowerCase() !== raw.toLowerCase() && compileLocal({ ...req, instruction: s }, { suggest: false }).ok) out.push(s); };
  if (raw && !fields.length && raw.length < 160 && !/[()]/.test(raw)) add(`${raw} (${f})`);
  const groups = CATALOGUE.filter(([re]) => re.test(raw)).map(([, ts]) => ts);
  for (let i = 0; i < 4; i++) for (const ts of groups) if (ts[i]) add(fill(ts[i]));
  for (const tpl of FALLBACKS) add(fill(tpl));
  return out;
}

/** Shown in the designer as "things you can say". Each one compiles without a sample (checked by the tests). */
export const INSTRUCTION_EXAMPLES: string[] = [
  "add the _ in between if name came as two words (customer.name)",
  "convert to upper case (customer.name)",
  "trim and capitalize each word (customer.name)",
  "take the first word of customer.name",
  "initials of customer.name",
  "join customer.firstName and customer.lastName with a space",
  'if customer.email is empty use "unknown@example.com"',
  'default to "N/A" (customer.middleName)',
  "use customer.nickname or customer.firstName",
  "M means Male, F means Female, anything else Unknown (customer.gender)",
  'if order.total is greater than 1000 then "high" otherwise "normal"',
  'if customer.country equals "SA" then "domestic" otherwise "international"',
  "round order.total to 2 decimals",
  "convert order.total to minor units",
  "multiply order.quantity by order.unitPrice",
  "add 15 percent to order.total",
  'format order.date as "dd/MM/yyyy"',
  "add 7 days to order.date",
  "days between booking.checkIn and booking.checkOut",
  "yes or no (customer.active)",
  "count the items in order.lines",
  "sum of order.lines.amount",
  "join order.tags with a comma",
  "last 4 characters of card.number",
  "pad with zeros to 8 digits (invoice.number)",
  'replace "-" with "/" in order.reference',
  "remove spaces from customer.phone",
  'everything before "@" in customer.email',
  'always "ONLINE"',
  "today's date",
];

/**
 * Compile an instruction. The rules run first and locally. Only when they fail AND an in-estate model
 * is configured (MODEL_URL) is that model asked; it receives the instruction, the target name, the
 * field names and the function names, never sample values. Its answer is checked and marked "guessed".
 */
export async function compileInstruction(req: CompileInstructionRequest, hook?: ModelHook): Promise<CompileOutcome> {
  const local = compileLocal(req);
  if (local.ok || !hook?.modelUrl || !(req.instruction ?? "").trim()) return local;
  try {
    const sample = req.sampleSource as unknown;
    const fields = sample !== null && typeof sample === "object" ? samplePaths(sample).slice(0, 300).map((p) => ({ path: p.path, type: p.t ?? "unknown" })) : [];
    const res = await hook.http.request({
      method: "POST", url: hook.modelUrl, timeoutMs: 8000, maxBytes: 200_000,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ task: "compile-mapping-instruction", language: "jsonata", instruction: req.instruction, target: req.target ?? null, fields, functions: FUNCTION_DOCS.map((f) => f.signature) }),
    });
    if (res.status >= 200 && res.status < 300) {
      const j = JSON.parse(res.body.toString("utf8")) as { expr?: unknown; explanation?: unknown };
      const expr = typeof j.expr === "string" ? j.expr.trim() : "";
      if (expr && expr.length < 4000 && !checkExpr(expr)) {
        const explanation = typeof j.explanation === "string" && j.explanation.trim() ? j.explanation.trim().slice(0, 400) : "Proposed by the in-estate model. Check the preview before relying on it";
        return { ok: true, compiled: { expr, explanation, confidence: "guessed", engine: "in-estate-model" }, understood: local.understood, suggestions: local.suggestions, fields: local.fields };
      }
    }
  } catch { /* the rule outcome stands */ }
  return local;
}
