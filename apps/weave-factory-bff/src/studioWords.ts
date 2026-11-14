// Plain-words mapping rules ("In your words") and mapping suggestions, worked out on THIS
// server by fixed rules. Nothing in this file calls a model or any other service: a sentence
// is matched against a list of known phrasings and turned into an expression the flow engine
// runs. A sentence that is not recognised is reported as not understood, never guessed at
// silently. Used by studio.ts only when the flow engine has no answer of its own.
import { randomBytes } from "node:crypto";

export interface WordsRequest { instruction: string; target?: string; sampleSource?: unknown; desiredValue?: unknown; }
export interface CompiledWords { expr: string; explanation: string; confidence: "exact" | "guessed"; engine: "rules"; }
export interface WordsOutcome { ok: boolean; compiled: CompiledWords | null; understood: string[]; reason?: string; suggestions: string[]; fields: string[]; }
export interface SourceField { path: string; list: boolean; value: unknown; }
export interface InferredRule { id: string; target: string; kind: "direct" | "expr" | "const"; source?: string; expr?: string; value?: unknown; comment?: string; confidence?: number; }

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const str = (s: string) => JSON.stringify(s);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "customer.first-name" -> customer.`first-name` (the engine's path syntax). */
export function refOf(path: string): string {
  return path.split(".").map((seg) => {
    const m = /^(.*?)((?:\[\d+\])*)$/.exec(seg)!;
    return (IDENT.test(m[1]) ? m[1] : "`" + m[1].replace(/`/g, "") + "`") + m[2];
  }).join(".");
}

/** Every value in a sample, by path. Lists are walked through their first entry, without an index. */
export function sourceFields(sample: unknown, max = 500): SourceField[] {
  const out: SourceField[] = [];
  const seen = new Set<string>();
  const add = (path: string, list: boolean, value: unknown) => { if (path && !seen.has(path) && out.length < max) { seen.add(path); out.push({ path, list, value }); } };
  const walk = (v: unknown, path: string, inList: boolean, depth: number) => {
    if (depth > 8 || out.length >= max) return;
    if (Array.isArray(v)) {
      add(path, true, v);
      const first = v.find((x) => x !== null && x !== undefined);
      if (first && typeof first === "object" && !Array.isArray(first)) walk(first, path, true, depth + 1);
      return;
    }
    if (v && typeof v === "object") { for (const [k, c] of Object.entries(v)) walk(c, path ? `${path}.${k}` : k, inList, depth + 1); return; }
    add(path, inList, v);
  };
  walk(sample, "", false, 0);
  return out;
}

/** "firstName" / "first_name" / "FirstName" -> ["first", "name"] */
export const wordsOf = (name: string): string[] =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());

// Words that are part of the phrasings themselves: a field with such a one-word name has to be
// written in brackets, for example (first), so it is not mistaken for the wording.
const RESERVED = new Set(("a an the to in of is it if or and as by with then else otherwise use add put remove replace join copy same from for on at be all only each every when " +
  "first last number text string count total sum today now value length word words space spaces empty true false upper lower case round default average min max item " +
  "digits letters characters part before after between not are was has have") .split(" "));
const FILLER = new Set(("a an the to in of is it its if or and as by with then use from for on at be all each every when please should must will would want i we me my this that field fields value values " +
  "make take get give set show write return result output input so into them these those also just have has can it's there their which what where up out do does too very " +
  "convert change turn become becomes always only keep kept using via per any some one data content contents contain contains new same copy copied equal equals name part text whole entire full").split(" "));

const SEP_WORDS: [RegExp, string][] = [
  [/^underscores?$/i, "_"], [/^(?:dash(?:es)?|hyphens?|minus)$/i, "-"], [/^(?:dots?|periods?|full\s*stops?|points?)$/i, "."], [/^commas?$/i, ","],
  [/^(?:spaces?|blanks?)$/i, " "], [/^slash(?:es)?$/i, "/"], [/^pipes?$/i, "|"], [/^at$/i, "@"], [/^colons?$/i, ":"], [/^semicolons?$/i, ";"], [/^(?:nothing|none)$/i, ""],
];
const SEP = String.raw`(?:an?\s+|the\s+|one\s+|single\s+)*(#\d+#|(?!@\d+@)[_\-.,\/|:;+*~@]{1,3}|[a-z]+)(?:\s+(?:sign|character|symbol|char)s?)?`;
const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const VAL = String.raw`(#\d+#|@\d+@|-?\d+(?:\.\d+)?|[^\s,;@#]+(?:\s+[^\s,;@#]+){0,2})`;
const TITLE = (x: string) => `$join($map($split($trim($string(${x})), /\\s+/), function($w) { $uppercase($substring($w, 0, 1)) & $lowercase($substring($w, 1)) }), " ")`;

export function suggestionsFor(field?: string, second?: string): string[] {
  const f = `(${field || "field"})`;
  return [
    `put _ between the words of ${f}`,
    `${f} in capital letters`,
    `if ${f} is empty use "N/A"`,
    `first 3 characters of ${f}`,
    `join ${f} and (${second || "other"}) with a space`,
    `if ${f} is "A" then "Yes" otherwise "No"`,
  ];
}

export function compileWords(req: WordsRequest): WordsOutcome {
  const raw = String(req?.instruction ?? "").replace(/\s+/g, " ").trim();
  const fields = sourceFields(req?.sampleSource);
  const hasSample = fields.length > 0;
  const understood: string[] = [];
  const picked: { path: string; list: boolean; exact: boolean; value: unknown }[] = [];
  const firstText = fields.find((f) => !f.list && typeof f.value === "string")?.path ?? fields[0]?.path;
  const secondText = fields.find((f) => !f.list && typeof f.value === "string" && f.path !== firstText)?.path;
  const fail = (reason: string): WordsOutcome => ({ ok: false, compiled: null, understood, reason, suggestions: suggestionsFor(picked[0]?.path ?? firstText, picked[1]?.path ?? secondText), fields: picked.map((p) => p.path) });
  if (!raw) return fail("Describe what this field should contain.");
  if (raw.length > 600) return fail("This is too long to read as one rule. Describe one field in one or two short sentences.");

  // ---- quoted text is kept aside so it is never read as wording
  const quotes: string[] = [];
  let work = raw.replace(/"([^"]*)"|“([^”]*)”|(?<![A-Za-z0-9])'([^']*)'(?![A-Za-z0-9])|‘([^’]*)’|`([^`]*)`/g, (_m, a, b, c, d, e) => {
    if (e !== undefined && /^[A-Za-z_][\w.\-[\]]*$/.test(e)) return ` (${e}) `;
    quotes.push(a ?? b ?? c ?? d ?? e ?? "");
    return ` #${quotes.length - 1}# `;
  });

  // ---- "today", "now"
  let clock = null as "date" | "time" | null;
  work = work.replace(/\b(?:today'?s?\s+date|the\s+current\s+date(?!\s+and)|current\s+date(?!\s+and)|today)\b/i, () => { clock = "date"; return " "; });
  if (!clock) work = work.replace(/\b(?:current\s+date\s+and\s+time|current\s+time(?:stamp)?|right\s+now|time\s*stamp\s+of\s+now|the\s+time\s+now)\b|^\s*now\s*$/i, () => { clock = "time"; return " "; });

  // ---- which input fields are meant
  const pick = (path: string, list: boolean, exact: boolean, value: unknown) => { let i = picked.findIndex((p) => p.path === path); if (i < 0) { picked.push({ path, list, exact, value }); i = picked.length - 1; } return ` @${i}@ `; };
  const byLower = new Map(fields.map((f) => [f.path.toLowerCase(), f] as const));
  const rootKnown = (p: string) => fields.some((f) => f.path.toLowerCase().split(".")[0] === p.toLowerCase().split(/[.[]/)[0]);
  work = work.replace(/(?<![\w@#.])[A-Za-z_][\w-]*(?:\[\d+\])*(?:\.[A-Za-z_][\w-]*(?:\[\d+\])*)+(?![\w])/g, (m) => {
    if (/^(?:e\.g|i\.e|n\.a|a\.m|p\.m)$/i.test(m)) return m;
    const f = /\[\d+\]/.test(m) ? undefined : byLower.get(m.toLowerCase());
    if (f) return pick(f.path, f.list, true, f.value);
    if (hasSample && !rootKnown(m)) understood.push(`"${m}" is not in the sample input; it is read as a field name.`);
    return pick(m, false, !hasSample || rootKnown(m), undefined);
  });
  const leafOwners = (name: string) => fields.filter((f) => f.path.toLowerCase() === name.toLowerCase() || f.path.toLowerCase().endsWith("." + name.toLowerCase()));
  work = work.replace(/\(\s*([A-Za-z_][\w-]*(?:\[\d+\])*)\s*\)/g, (m, name: string) => {
    const owners = leafOwners(name).sort((a, b) => a.path.length - b.path.length);
    if (owners.length) { if (owners.length > 1) understood.push(`Several fields are called "${name}": ${owners[0].path} is used.`); return pick(owners[0].path, owners[0].list, owners.length === 1, owners[0].value); }
    if (/^\d/.test(name) || RESERVED.has(name.toLowerCase()) && hasSample) return m;
    return pick(name, false, !hasSample, undefined);
  });
  const phrases = new Map<string, { words: string[]; owners: SourceField[] }>();
  for (const f of fields) {
    const segs = f.path.split(".");
    const leaf = wordsOf(segs[segs.length - 1]);
    if (!leaf.length) continue;
    const forms = [leaf];
    if (segs.length > 1) forms.push([...wordsOf(segs[segs.length - 2]), ...leaf]);
    for (const w of forms) {
      if (w.length === 1 && (RESERVED.has(w[0]) || w[0].length < 2)) continue;
      const key = w.join(" ");
      const e = phrases.get(key) ?? { words: w, owners: [] };
      e.owners.push(f); phrases.set(key, e);
    }
  }
  for (const p of [...phrases.values()].sort((a, b) => b.words.join("").length - a.words.join("").length)) {
    const re = new RegExp(`(?<![A-Za-z0-9@#_])${p.words.map(esc).join("[\\s_-]*")}(?:'s)?(?![A-Za-z0-9@#_])`, "gi");
    work = work.replace(re, () => {
      const owners = [...p.owners].sort((a, b) => a.path.length - b.path.length);
      const already = owners.find((o) => picked.some((x) => x.path === o.path));
      const o = already ?? owners[0];
      if (!already && owners.length > 1) understood.push(`Several fields are called "${p.words.join(" ")}": ${o.path} is used. Write the full path in brackets to choose another.`);
      return pick(o.path, o.list, !!already || owners.length === 1, o.value);
    });
  }
  work = work.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  // number the fields in the order they are written in the sentence
  const order: number[] = [];
  for (const t of work.matchAll(/@(\d+)@/g)) if (!order.includes(Number(t[1]))) order.push(Number(t[1]));
  const sorted = order.map((i) => picked[i]);
  work = work.replace(/@(\d+)@/g, (_t, i: string) => `@${order.indexOf(Number(i))}@`);
  picked.splice(0, picked.length, ...sorted);

  // ---- small helpers over the remaining sentence
  const find = (source: string | RegExp) => (typeof source === "string" ? new RegExp(source, "i") : source).exec(work);
  const eat = (m: RegExpExecArray) => { work = (work.slice(0, m.index) + " " + work.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(); };
  const sepOf = (s: string | undefined): string | undefined => {
    if (s === undefined) return undefined;
    const q = /^#(\d+)#$/.exec(s);
    if (q) return quotes[Number(q[1])];
    if (/^[_\-.,\/|:;+*~@]{1,3}$/.test(s)) return s;
    return SEP_WORDS.find(([re]) => re.test(s))?.[1];
  };
  const showSep = (s: string) => (s === " " ? "a space" : s === "" ? "nothing" : str(s));
  const P = (i: number) => refOf(picked[i].path);
  const val = (s0: string): { expr: string; say: string } | null => {
    let s = s0.trim().replace(/^[=:]\s*/, "").replace(/[.;,]+$/, "").trim();
    s = s.replace(/^(?:the\s+)?(?:value|text|word|string|number)\s+(?:of\s+)?(?=[#@])/i, "");
    let m: RegExpExecArray | null;
    if ((m = /^#(\d+)#$/.exec(s))) return { expr: str(quotes[Number(m[1])]), say: str(quotes[Number(m[1])]) };
    if ((m = /^@(\d+)@$/.exec(s))) return { expr: P(Number(m[1])), say: picked[Number(m[1])].path };
    if (/^-?\d+(?:\.\d+)?$/.test(s)) return { expr: s, say: s };
    if (/^(?:true|false)$/i.test(s)) return { expr: s.toLowerCase(), say: s.toLowerCase() };
    if (/^null$/i.test(s)) return { expr: "null", say: "an empty value" };
    if (/^(?:nothing|empty|blank|an?\s+empty\s+(?:text|string|value))$/i.test(s)) return { expr: '""', say: "an empty text" };
    if (!s || /[@#]/.test(s) || s.split(/\s+/).length > 4) return null;
    return { expr: str(s), say: str(s) };
  };
  const done = (expr: string, steps: string[], guessed = false): WordsOutcome => {
    const left = work.replace(/[@#]\d+[@#]/g, " ").split(/[^A-Za-z]+/).filter((w) => w.length > 1 && !FILLER.has(w.toLowerCase()));
    const unsure = guessed || left.length > 0 || picked.some((p) => !p.exact);
    for (const s of steps) understood.push(s);
    if (left.length) understood.push(`Not used: "${left.join(" ")}". Check the result.`);
    return { ok: true, compiled: { expr, explanation: steps.join(" "), confidence: unsure ? "guessed" : "exact", engine: "rules" }, understood, suggestions: [], fields: picked.map((p) => p.path) };
  };
  let m: RegExpExecArray | null;

  // ---- "... if the name came as two words": a remark about the input, not a separate rule
  let wordGuard = false;
  if ((m = find(String.raw`\b(?:if|when|whenever|in\s+case)\b[^,.;]*?\b(?:two|2|multiple|several|many|more\s+than\s+(?:one|1))\s+words?\b`)) ||
      (m = find(String.raw`\b(?:if|when|whenever)\b\s+(?:it|there|@\d+@)\s+(?:has|have|contains?|is|are)\s+(?:a\s+|any\s+)?spaces?\b(?:\s+in\s+(?:it|between))?`))) { wordGuard = true; eat(m); }

  // ---- conditions
  const LHS = String.raw`(@\d+@|it|this|that|the\s+value)`;
  const lhs = (s: string): { expr: string; say: string } | null => {
    const t = /^@(\d+)@$/.exec(s.trim());
    if (t) return { expr: P(Number(t[1])), say: picked[Number(t[1])].path };
    return picked.length ? { expr: P(0), say: picked[0].path } : null;
  };
  const CMP: [string, string, string][] = [
    [String.raw`(?:is\s+not\s+equal\s+to|is\s+not|isn't|does\s+not\s+equal|doesn't\s+equal|not\s+equals?|!=|<>)`, "!=", "is not"],
    [String.raw`(?:is\s+)?(?:greater\s+than\s+or\s+equal\s+to|at\s+least|>=)`, ">=", "is at least"],
    [String.raw`(?:is\s+)?(?:less\s+than\s+or\s+equal\s+to|at\s+most|<=)`, "<=", "is at most"],
    [String.raw`(?:is\s+)?(?:greater\s+than|more\s+than|bigger\s+than|larger\s+than|higher\s+than|over|above|>)`, ">", "is greater than"],
    [String.raw`(?:is\s+)?(?:less\s+than|smaller\s+than|lower\s+than|below|under|<)`, "<", "is less than"],
    [String.raw`(?:contains|includes)`, "contains", "contains"],
    [String.raw`(?:starts|begins)\s+with`, "starts", "starts with"],
    [String.raw`ends\s+with`, "ends", "ends with"],
    [String.raw`(?:is\s+one\s+of|is\s+any\s+of|is\s+in)`, "in", "is one of"],
    [String.raw`(?:is\s+equal\s+to|is\s+exactly|equals?|is|are|was|==|=)`, "=", "is"],
  ];
  type Cond = { expr: string; say: string; emptyOf?: string };
  const simpleCond = (s0: string): Cond | null => {
    const s = s0.trim().replace(/^the\s+/i, "");
    let x: RegExpExecArray | null;
    if ((x = new RegExp(`^${LHS}\\s+(?:is\\s+not\\s+(?:empty|blank|missing|null)|is\\s+(?:present|given|set|filled|there|available|provided|known)|exists|has\\s+a\\s+value)$`, "i").exec(s))) {
      const l = lhs(x[1]); if (!l) return null;
      return { expr: `($exists(${l.expr}) and ${l.expr} != null and ${l.expr} != "")`, say: `${l.say} has a value` };
    }
    if ((x = new RegExp(`^${LHS}\\s+(?:is\\s+(?:empty|blank|missing|null|absent|not\\s+(?:present|given|set|filled|there|available|provided|known))|does\\s+not\\s+exist|doesn't\\s+exist|has\\s+no\\s+value)$`, "i").exec(s))) {
      const l = lhs(x[1]); if (!l) return null;
      return { expr: `($not($exists(${l.expr})) or ${l.expr} = null or ${l.expr} = "")`, say: `${l.say} is empty or missing`, emptyOf: l.expr };
    }
    for (const [re, op, say] of CMP) {
      x = new RegExp(`^${LHS}\\s*${re}\\s*(.+)$`, "i").exec(s);
      if (!x) continue;
      const l = lhs(x[1]); if (!l) return null;
      if (op === "in") {
        const items = x[2].split(/\s*,\s*|\s+or\s+|\s+and\s+/).map((p) => val(p)).filter(Boolean) as { expr: string; say: string }[];
        if (!items.length) return null;
        return { expr: `(${l.expr} in [${items.map((i) => i.expr).join(", ")}])`, say: `${l.say} is one of ${items.map((i) => i.say).join(", ")}` };
      }
      const r = val(x[2]); if (!r) return null;
      if (op === "contains") return { expr: `$contains($string(${l.expr}), ${r.expr})`, say: `${l.say} contains ${r.say}` };
      if (op === "starts") return { expr: `($substring($string(${l.expr}), 0, $length(${r.expr})) = ${r.expr})`, say: `${l.say} starts with ${r.say}` };
      if (op === "ends") return { expr: `($substring($string(${l.expr}), -$length(${r.expr})) = ${r.expr})`, say: `${l.say} ends with ${r.say}` };
      const numeric = /^-?\d/.test(r.expr) && [">", "<", ">=", "<="].includes(op);
      return { expr: `(${numeric ? `$number(${l.expr})` : l.expr} ${op} ${r.expr})`, say: `${l.say} ${say} ${r.say}` };
    }
    return null;
  };
  const cond = (s: string): Cond | null => {
    const whole = simpleCond(s);
    if (whole) return whole;
    const parts = s.split(/\s+(and|or)\s+/i);
    if (parts.length < 3) return null;
    let expr = "", say = "";
    for (let i = 0; i < parts.length; i += 2) {
      const c = simpleCond(parts[i]); if (!c) return null;
      const glue = i ? parts[i - 1].toLowerCase() : "";
      expr = i ? `(${expr} ${glue} ${c.expr})` : c.expr;
      say = i ? `${say} ${glue} ${c.say}` : c.say;
    }
    return { expr, say };
  };
  const LEAD = String.raw`(?:then\s+)?(?:use\s+|return\s+|put\s+|write\s+|show\s+|give\s+|set(?:\s+it)?\s+to\s+|it(?:'s|\s+is|\s+should\s+be)\s+)?`;
  const conditional = (text: string): { expr: string; say: string } | null => {
    let x = new RegExp(String.raw`^\s*(?:if|when|whenever|in\s+case)\s+(.+?)\s*(?:,|:|\bthen\b|\buse\b|\breturn\b|\bput\b|\bgive\b|\bwrite\b|\bshow\b|\bset(?:\s+it)?\s+to\b|\bit(?:'s|\s+is|\s+should\s+be)\b)\s*${LEAD}(.+?)(?:\s*[,;.]?\s*\b(?:otherwise|else|or\s+else|if\s+not)\b\s*[,:]?\s*(.+?))?\s*\.?\s*$`, "i").exec(text);
    let c: Cond | null = null, thenText = "", elseText: string | undefined;
    if (x && (c = cond(x[1]))) { thenText = x[2]; elseText = x[3]; }
    else {
      x = new RegExp(String.raw`^\s*${LEAD}(.+?)\s+(?:if|when|whenever)\s+(.+?)(?:\s*[,;.]?\s*\b(?:otherwise|else|or\s+else)\b\s*[,:]?\s*(.+?))?\s*\.?\s*$`, "i").exec(text);
      if (!x || !(c = cond(x[2]))) return null;
      thenText = x[1]; elseText = x[3];
    }
    const a = val(thenText); if (!a) return null;
    let b: { expr: string; say: string } | null = null;
    if (elseText !== undefined) {
      const t = elseText.replace(new RegExp(`^${LEAD}`, "i"), "");
      b = /^\s*(?:if|when)\b/i.test(elseText) ? conditional(elseText) : val(t);
      if (!b) return null;
    } else if (c.emptyOf) b = { expr: c.emptyOf, say: "the value as it came" };
    return b
      ? { expr: `${c.expr} ? ${a.expr} : ${b.expr}`, say: `when ${c.say} use ${a.say}, otherwise ${b.say}` }
      : { expr: `${c.expr} ? ${a.expr}`, say: `when ${c.say} use ${a.say}, otherwise leave the field out` };
  };
  if (/\b(?:if|when|whenever|in\s+case)\b/i.test(work)) {
    const c = conditional(work);
    if (c) { work = ""; return done(c.expr, [c.say.charAt(0).toUpperCase() + c.say.slice(1) + "."]); }
  }

  // ---- "M means Male, F means Female"
  const pairs: [string, string][] = [];
  const pairRe = new RegExp(String.raw`(#\d+#|[\w\/-]+)\s*(?:means|=>|->|→|becomes|stands\s+for)\s*(#\d+#|[\w\/-]+)`, "gi");
  let pm: RegExpExecArray | null;
  while ((pm = pairRe.exec(work))) pairs.push([pm[1], pm[2]]);
  if (!pairs.length && /^\s*(?:map|convert|translate|change)\b/i.test(work)) {
    const toRe = new RegExp(String.raw`(#\d+#|[\w\/-]+)\s+(?:to|into)\s+(#\d+#|[\w\/-]+)`, "gi");
    const got: [string, string][] = [];
    while ((pm = toRe.exec(work))) if (!/^@/.test(pm[1])) got.push([pm[1], pm[2]]);
    if (got.length >= 2) pairs.push(...got);
  }
  if (pairs.length) {
    if (!picked.length) return fail("Say which input field these values come from, in brackets, for example: (gender) M means Male, F means Female.");
    const table = pairs.map(([a, b]) => [val(a), val(b)] as const);
    if (table.every(([a, b]) => a && b)) {
      let other: { expr: string; say: string } | null = null;
      if ((m = find(String.raw`\b(?:otherwise|else|anything\s+else|everything\s+else|others?)\b\s*(?:use\s+|is\s+|means\s+|becomes\s+|=>\s*|->\s*)?${VAL}`))) other = val(m[1]);
      const chain = table.map(([a, b]) => `$v = ${/^"/.test(a!.expr) ? a!.expr : str(a!.say)} ? ${b!.expr} : `).join("");
      work = "";
      return done(`( $v := $string(${P(0)}); ${chain}${other ? other.expr : P(0)} )`, [`Look at ${picked[0].path}: ${table.map(([a, b]) => `${a!.say} becomes ${b!.say}`).join(", ")}.`, other ? `Anything else becomes ${other.say}.` : "Any other value is kept as it is."]);
    }
  }

  // ---- today / now, with no input field involved
  if (clock && !picked.length) {
    return clock === "date" ? done(`$substring($now(), 0, 10)`, ["Today's date, written like 2026-01-31."]) : done(`$now()`, ["The date and time at the moment the flow runs."]);
  }

  // ---- a fixed value
  if (!picked.length && (m = find(String.raw`^(?:always|fixed(?:\s+value)?|constant(?:\s+value)?|hard-?coded?(?:\s+as|\s+to)?|set(?:\s+it)?\s+to|use\s+the\s+value|the\s+value\s+is\s+always|always\s+use|always\s+the\s+value)\s*:?\s*(.+)$`))) {
    const v = val(m[1]);
    if (v) { work = ""; return done(v.expr, [`Always ${v.say}.`]); }
  }
  if (!picked.length && quotes.length === 1 && /^#0#$/.test(work)) { work = ""; return done(str(quotes[0]), [`Always ${str(quotes[0])}.`]); }

  if (!picked.length) {
    // the target's own name may say which input field is meant
    const want = wordsOf(String(req?.target ?? "").split(".").pop() ?? "").join("");
    const same = want ? fields.filter((f) => wordsOf(f.path.split(".").pop() ?? "").join("") === want) : [];
    if (same.length === 1) { pick(same[0].path, same[0].list, false, same[0].value); understood.push(`No input field was named: ${same[0].path} is used because it has the same name as the target.`); }
    else return fail(hasSample
      ? "It is not clear which input field this is about. Name the field as it appears in the input, in brackets, for example (customer.name)."
      : "It is not clear which input field this is about. Run the flow once so the input is known, or name the field in brackets, for example (customer.name).");
  }

  const steps: string[] = [];
  let cur = P(0);
  let label = picked[0].path;
  let guessed = false;
  let acted = false;

  // ---- lists: totals, counts, joining
  const numbersLike = (i: number) => picked[i] && (typeof picked[i].value === "number" || (typeof picked[i].value === "string" && picked[i].value !== "" && !Number.isNaN(Number(picked[i].value))));
  if ((m = find(String.raw`\b(?:length\s+of|number\s+of\s+(?:characters|letters|chars)|how\s+long|how\s+many\s+(?:characters|letters))\b`))) {
    eat(m); cur = `$length($string(${cur}))`; steps.push(`Count the characters of ${label}.`); acted = true;
  } else if (picked.length === 1 && (m = find(String.raw`\b(?:sum|total)\b(?:\s+of)?`))) {
    eat(m); cur = `$sum(${cur})`; steps.push(`Add up every ${label}.`); acted = true;
  } else if (picked.length === 1 && (m = find(String.raw`\b(?:count|number\s+of|how\s+many)\b(?:\s+of)?`))) {
    eat(m); cur = `$count(${cur})`; steps.push(`Count how many ${label} there are.`); acted = true;
  } else if (picked.length === 1 && (m = find(String.raw`\b(?:average|mean)\b(?:\s+of)?`))) {
    eat(m); cur = `$average(${cur})`; steps.push(`Take the average of ${label}.`); acted = true;
  } else if (picked.length === 1 && (m = find(String.raw`\b(?:maximum|max|highest|largest|biggest)\b(?:\s+of)?`))) {
    eat(m); cur = `$max(${cur})`; steps.push(`Take the highest ${label}.`); acted = true;
  } else if (picked.length === 1 && (m = find(String.raw`\b(?:minimum|min|lowest|smallest)\b(?:\s+of)?`))) {
    eat(m); cur = `$min(${cur})`; steps.push(`Take the lowest ${label}.`); acted = true;
  } else if (picked.length === 1 && (m = find(String.raw`\b(?:first|1st)\s+(?:item|element|entry|one|record|row)\b(?:\s+(?:of|in|from))?`))) {
    eat(m); cur = `(${cur})[0]`; steps.push(`Take the first entry of ${label}.`); acted = true;
  } else if (picked.length === 1 && (m = find(String.raw`\blast\s+(?:item|element|entry|one|record|row)\b(?:\s+(?:of|in|from))?`))) {
    eat(m); cur = `(${cur})[-1]`; steps.push(`Take the last entry of ${label}.`); acted = true;
  } else if (picked.length === 1 && picked[0].list && (m = find(String.raw`\b(?:join|combine|list|merge)\w*\b.*?\b(?:with|by|using|separated\s+by)\s+${SEP}`)) && sepOf(m[1]) !== undefined) {
    const s = sepOf(m[1])!; eat(m); cur = `$join(${cur}.$string(), ${str(s)})`; steps.push(`Write the entries of ${label} one after the other with ${showSep(s)} in between.`); acted = true;
  } else if (picked.length === 1 && picked[0].list && (m = find(String.raw`\bcomma[\s-]+separated\b`))) {
    eat(m); cur = `$join(${cur}.$string(), ",")`; steps.push(`Write the entries of ${label} one after the other with "," in between.`); acted = true;
  }

  // ---- two fields: arithmetic or joining
  if (picked.length >= 2 && !acted) {
    const A = P(0), B = P(1), a = picked[0].path, b = picked[1].path;
    const arith = (op: string, l: string, r: string, say: string) => { cur = `$number(${l}) ${op} $number(${r})`; steps.push(say); acted = true; label = "the result"; };
    if ((m = find(String.raw`\bsubtract\w*\s+@0@\s+from\s+@1@`))) { eat(m); arith("-", B, A, `Take ${b} minus ${a}.`); }
    else if ((m = find(String.raw`\b(?:divide\w*)\s+@0@\s+by\s+@1@|@0@\s*(?:\/|divided\s+by|over)\s*@1@`))) { eat(m); arith("/", A, B, `Divide ${a} by ${b}.`); }
    else if ((m = find(String.raw`\bmultipl\w+\s+@0@\s+(?:by|with|and)\s+@1@|@0@\s*(?:\*|x|times|multiplied\s+by)\s*@1@`))) { eat(m); arith("*", A, B, `Multiply ${a} by ${b}.`); }
    else if ((m = find(String.raw`@0@\s*(?:-|minus|less)\s*@1@|\bdifference\s+(?:between|of)\s+@0@\s+and\s+@1@`))) { eat(m); arith("-", A, B, `Take ${a} minus ${b}.`); }
    else if ((m = find(String.raw`\b(?:sum|total)\s+(?:of\s+)?@0@\s+(?:and|plus|\+)\s+@1@|@0@\s+plus\s+@1@|\badd\s+@0@\s+(?:and|to|with)\s+@1@`)) ||
             ((m = find(String.raw`@0@\s*\+\s*@1@`)) && numbersLike(0) && numbersLike(1))) {
      eat(m);
      if (picked.length > 2 && /\b(?:sum|total)\b/i.test(m[0])) { cur = `$sum([${picked.map((_p, i) => `$number(${P(i)})`).join(", ")}])`; steps.push(`Add up ${picked.map((p) => p.path).join(", ")}.`); acted = true; label = "the result"; }
      else arith("+", A, B, `Add ${a} and ${b}.`);
    } else if ((m = find(String.raw`@0@\s*,?\s*(?:or(?:\s+else)?|otherwise|else|and\s+if\s+(?:it\s+is\s+)?(?:empty|missing)(?:\s+then)?)\s+(?:use\s+)?@1@(?:\s+(?:if|when)\s+(?:it\s+is\s+|@0@\s+is\s+)?(?:empty|missing|blank|not\s+(?:there|given|set|present)))?`))) {
      eat(m); cur = `( $v := ${A}; ($exists($v) and $v != null and $v != "") ? $v : ${B} )`; steps.push(`Use ${a}. When it has no value, use ${b} instead.`); acted = true; label = "the result";
    } else {
      let s: string | undefined;
      const sm = find(String.raw`\b(?:with|separated\s+by|using|and\s+put|put)\s+${SEP}(?:\s+(?:in\s*-?\s*between|between(?:\s+them)?))?`) ?? find(String.raw`${SEP}\s+(?:in\s*-?\s*between|between)`);
      if (sm && sepOf(sm[1]) !== undefined) { s = sepOf(sm[1]); eat(sm); }
      if (s === undefined && (m = find(String.raw`\b(?:without|with\s+no|no)\s+(?:a\s+)?(?:space|gap|separator)s?\b|\bdirectly\b|\bstuck\s+together\b`))) { s = ""; eat(m); }
      const joinWord = find(String.raw`\b(?:join|combine|concat\w*|merge|append|glue)\w*\b|\bput\s+together\b|\bfollowed\s+by\b|\btogether\b|\bthen\b|\+|&`);
      if (joinWord) eat(joinWord);
      if (s === undefined) guessed = true;
      const sep = s ?? " ";
      cur = picked.map((_p, i) => P(i)).join(` & ${str(sep)} & `);
      if (sep === " ") cur = `$trim(${cur})`; else cur = `(${cur})`;
      steps.push(`Write ${picked.map((p) => p.path).join(", then ")} with ${showSep(sep)} in between.`);
      acted = true; label = "the result";
    }
  }
  if (!steps.length) steps.push(`Take ${label}.`);

  // ---- picking a part
  if ((m = find(String.raw`\b(?:first|1st)\s+word\b(?:\s+(?:of|from|in))?`))) {
    eat(m); cur = `$split($trim($string(${cur})), /\\s+/)[0]`; steps.push("Keep only the first word."); acted = true;
  } else if ((m = find(String.raw`\blast\s+word\b(?:\s+(?:of|from|in))?`))) {
    eat(m); cur = `$split($trim($string(${cur})), /\\s+/)[-1]`; steps.push("Keep only the last word."); acted = true;
  } else if ((m = find(String.raw`\b(?:first|1st|leading)\s+${NUM}\s+(?:letters?|characters?|chars?|digits?|numbers?|symbols?)\b(?:\s+(?:of|from|in))?`))) {
    eat(m); cur = `$substring($string(${cur}), 0, ${Number(m[1])})`; steps.push(`Keep the first ${m[1]} characters.`); acted = true;
  } else if ((m = find(String.raw`\b(?:last|final|trailing)\s+${NUM}\s+(?:letters?|characters?|chars?|digits?|numbers?|symbols?)\b(?:\s+(?:of|from|in))?`))) {
    eat(m); cur = `$substring($string(${cur}), -${Number(m[1])})`; steps.push(`Keep the last ${m[1]} characters.`); acted = true;
  } else if ((m = find(String.raw`\b(?:first|1st)\s+(?:letter|character|char)\b(?:\s+(?:of|from|in))?`)) && !/capital/i.test(work)) {
    eat(m); cur = `$substring($string(${cur}), 0, 1)`; steps.push("Keep the first character."); acted = true;
  } else if ((m = find(String.raw`\binitials\b(?:\s+(?:of|from))?`))) {
    eat(m); cur = `$join($map($split($trim($string(${cur})), /\\s+/), function($w) { $uppercase($substring($w, 0, 1)) }), "")`; steps.push("Keep the first letter of every word, in capitals."); acted = true;
  } else if ((m = find(String.raw`\b(?:the\s+)?(?:part|text|everything|anything|all)?\s*\b(?:before|up\s+to|until)\s+(?:the\s+)?(?:first\s+)?${SEP}`)) && sepOf(m[1]) !== undefined) {
    const s = sepOf(m[1])!; eat(m); cur = `$substringBefore($string(${cur}), ${str(s)})`; steps.push(`Keep what comes before ${showSep(s)}.`); acted = true;
  } else if ((m = find(String.raw`\b(?:the\s+)?(?:part|text|everything|anything|all)?\s*\b(?:after|following|behind)\s+(?:the\s+)?(?:first\s+)?${SEP}`)) && sepOf(m[1]) !== undefined) {
    const s = sepOf(m[1])!; eat(m); cur = `$substringAfter($string(${cur}), ${str(s)})`; steps.push(`Keep what comes after ${showSep(s)}.`); acted = true;
  } else if ((m = find(String.raw`\b(?:date\s+only|only\s+the\s+date|just\s+the\s+date|without\s+(?:the\s+)?time|date\s+part)\b`))) {
    eat(m); cur = `$substring($string(${cur}), 0, 10)`; steps.push("Keep the date and drop the time (the first 10 characters, like 2026-01-31)."); acted = true;
  } else if ((m = find(String.raw`\b(?:only\s+the\s+|just\s+the\s+)?year\b(?:\s+(?:of|from))?`))) {
    eat(m); cur = `$substring($string(${cur}), 0, 4)`; steps.push("Keep the year (the first 4 characters)."); acted = true;
  }

  // ---- characters between words, removing and replacing
  const wordJoin = (s: string, lower = false) => { cur = `$replace($trim($string(${lower ? `$lowercase(${cur})` : cur})), /\\s+/, ${str(s)})`; steps.push(`${lower ? "Write it in small letters and put" : "Put"} ${showSep(s)} between the words.`); steps.push("A single word stays as it is."); acted = true; };
  const joinForms = [
    String.raw`\b(?:add|put|insert|use|place|have|want|with)\s+${SEP}\s+(?:in\s*-?\s*between|between|in\s+the\s+middle)(?:\s+(?:of\s+)?(?:the\s+|its\s+|each\s+|every\s+|two\s+)*(?:words?|names?|parts?|them))?`,
    String.raw`\breplac\w*\s+(?:all\s+|the\s+|every\s+|each\s+|any\s+)*(?:white\s*)?(?:spaces?|blanks?|whitespace)\s+(?:with|by|to|into)\s+${SEP}`,
    String.raw`\b(?:join|separate|connect|delimit|split)\w*\s+(?:the\s+|its\s+|all\s+)*(?:words?|parts?)\s+(?:with|by|using)\s+${SEP}`,
    String.raw`${SEP}\s+instead\s+of\s+(?:a\s+|the\s+|any\s+)?(?:spaces?|blanks?)`,
    String.raw`\b(?:spaces?|blanks?)\s+(?:to|into|become|becomes|as|→|->)\s+${SEP}`,
    String.raw`\b(?:words?\s+)?${SEP}[\s-]+(?:separated|delimited)\b`,
  ];
  let joined = false;
  for (const f of joinForms) { if ((m = find(f)) && sepOf(m[1]) !== undefined) { const s = sepOf(m[1])!; eat(m); wordJoin(s); joined = true; break; } }
  if (!joined && (m = find(String.raw`\bsnake[\s_-]?case\b`))) { eat(m); wordJoin("_", true); joined = true; }
  if (!joined && (m = find(String.raw`\bkebab[\s_-]?case\b`))) { eat(m); wordJoin("-", true); joined = true; }
  if (wordGuard && !joined) return fail("The part about two words was read, but not what to do with them. For example: put _ between the words of (customer.name).");

  if ((m = find(String.raw`\b(?:remove|delete|strip|drop|without)\s+(?:all\s+|the\s+|any\s+|every\s+)*(?:white\s*)?(?:spaces?|blanks?|whitespace)\b`)) && !/\b(?:extra|leading|trailing|surrounding|outer)\b/i.test(work)) {
    eat(m); cur = `$replace($string(${cur}), /\\s+/, "")`; steps.push("Remove every space."); acted = true;
  }
  if ((m = find(String.raw`\b(?:only|just|keep)\s+(?:the\s+)?(?:digits|numbers)\b|\b(?:digits|numbers)\s+only\b|\bremove\s+(?:everything|anything|all)\s+(?:except|but)\s+(?:the\s+)?(?:digits|numbers)\b`))) {
    eat(m); cur = `$replace($string(${cur}), /[^0-9]/, "")`; steps.push("Keep only the digits."); acted = true;
  } else if ((m = find(String.raw`\b(?:only|just|keep)\s+(?:the\s+)?letters\b|\bletters\s+only\b`))) {
    eat(m); cur = `$replace($string(${cur}), /[^A-Za-z]/, "")`; steps.push("Keep only the letters."); acted = true;
  }
  if ((m = find(String.raw`\breplac\w*\s+(?:all\s+|every\s+|each\s+|the\s+)*${SEP}\s+(?:with|by|to|into)\s+${SEP}`)) && sepOf(m[1]) !== undefined && sepOf(m[2]) !== undefined) {
    const a = sepOf(m[1])!, b = sepOf(m[2])!; eat(m); cur = `$replace($string(${cur}), ${str(a)}, ${str(b)})`; steps.push(`Replace every ${showSep(a)} with ${showSep(b)}.`); acted = true;
  }
  if ((m = find(String.raw`\b(?:remove|delete|strip|drop|without)\s+(?:all\s+|the\s+|any\s+|every\s+)*${SEP}`)) && sepOf(m[1]) !== undefined && sepOf(m[1]) !== " ") {
    const a = sepOf(m[1])!; eat(m); cur = `$replace($string(${cur}), ${str(a)}, "")`; steps.push(`Remove every ${showSep(a)}.`); acted = true;
  }
  if ((m = find(String.raw`\btrim\w*\b|\b(?:remove|delete|strip|drop|without)\s+(?:the\s+|any\s+|all\s+)*(?:extra|leading|trailing|surrounding|outer)(?:\s+and\s+(?:leading|trailing))?\s+(?:white\s*)?(?:spaces?|blanks?|whitespace)\b`))) {
    eat(m); cur = `$trim($string(${cur}))`; steps.push("Remove spaces at the start and the end."); acted = true;
  }

  // ---- capitals
  if ((m = find(String.raw`\btitle[\s-]?case\b|\bproper[\s-]?case\b|\bcapitali[sz]e\w*\s+(?:the\s+first\s+letter\s+of\s+)?(?:each|every|all)\s+words?\b|\b(?:each|every)\s+word\s+(?:capitali[sz]ed|with\s+a\s+capital(?:\s+letter)?)\b|\bfirst\s+letter\s+of\s+(?:each|every)\s+word\s+(?:in\s+)?capitals?\b`))) {
    eat(m); cur = TITLE(cur); steps.push("Start every word with a capital letter."); acted = true;
  } else if ((m = find(String.raw`\b(?:upper[\s-]?case|capitals|capital\s+letters|all\s+caps|block\s+letters|uppercased?)\b`))) {
    eat(m); cur = `$uppercase($string(${cur}))`; steps.push("Write it in capital letters."); acted = true;
  } else if ((m = find(String.raw`\b(?:lower[\s-]?case|small\s+letters|lowercased?|no\s+capitals)\b`))) {
    eat(m); cur = `$lowercase($string(${cur}))`; steps.push("Write it in small letters."); acted = true;
  } else if ((m = find(String.raw`\bcapitali[sz]e\w*(?:\s+the\s+first\s+letter)?\b|\bfirst\s+letter\s+(?:in\s+)?capitals?\b|\bstart\w*\s+with\s+a\s+capital(?:\s+letter)?\b`))) {
    eat(m); cur = `( $s := $string(${cur}); $uppercase($substring($s, 0, 1)) & $substring($s, 1) )`; steps.push("Start it with a capital letter."); acted = true;
  }

  // ---- numbers
  if ((m = find(String.raw`\bround\w*\s+(?:it\s+)?(?:to\s+)?${NUM}\s+(?:decimals?|decimal\s+places?|digits?|places?)\b|\b(?:with\s+)?${NUM}\s+(?:decimals?|decimal\s+places?)\b`))) {
    eat(m); const n = Number(m[1] ?? m[2]); cur = `$round($number(${cur}), ${n})`; steps.push(`Round it to ${n} decimals.`); acted = true;
  } else if ((m = find(String.raw`\bround\w*(?:\s+(?:it|off))?(?:\s+to\s+(?:the\s+|a\s+)?(?:nearest\s+)?(?:whole(?:\s+number)?|integer|unit))?\b|\bwhole\s+number\b|\bno\s+decimals\b|\bwithout\s+decimals\b`))) {
    eat(m); cur = `$round($number(${cur}))`; steps.push("Round it to a whole number."); acted = true;
  }
  if ((m = find(String.raw`\b(?:multipl\w+\s+(?:it\s+|@\d+@\s+)?(?:by|with)|times)\s+${NUM}\b|\*\s*${NUM}`))) { eat(m); const n = m[1] ?? m[2]; cur = `$number(${cur}) * ${n}`; steps.push(`Multiply it by ${n}.`); acted = true; }
  else if ((m = find(String.raw`\b(?:divid\w+\s+(?:it\s+|@\d+@\s+)?by)\s+${NUM}\b|\/\s*${NUM}`))) { eat(m); const n = m[1] ?? m[2]; cur = `$number(${cur}) / ${n}`; steps.push(`Divide it by ${n}.`); acted = true; }
  else if ((m = find(String.raw`\b(?:add|plus|increase\s+(?:it\s+|@\d+@\s+)?by)\s+${NUM}\b(?!\s*(?:letters?|characters?|digits?))|\+\s*${NUM}`))) { eat(m); const n = m[1] ?? m[2]; cur = `$number(${cur}) + ${n}`; steps.push(`Add ${n}.`); acted = true; }
  else if ((m = find(String.raw`\b(?:subtract|minus|(?:decrease|reduce)\s+(?:it\s+|@\d+@\s+)?by)\s+${NUM}\b`))) { eat(m); cur = `$number(${cur}) - ${m[1]}`; steps.push(`Subtract ${m[1]}.`); acted = true; }
  else if ((m = find(String.raw`\b(?:as|to|into)\s+(?:a\s+|an\s+)?(?:number|numeric|integer|decimal)\b|\bnumeric\b|\bas\s+number\b`))) { eat(m); cur = `$number(${cur})`; steps.push("Turn it into a number."); acted = true; }
  else if ((m = find(String.raw`\b(?:as|to|into)\s+(?:a\s+)?(?:text|string|characters)\b`))) { eat(m); cur = `$string(${cur})`; steps.push("Turn it into text."); acted = true; }
  else if ((m = find(String.raw`\b(?:as|to|into)\s+(?:a\s+)?(?:boolean|true\s*(?:\/|or)\s*false|yes\s*(?:\/|or)\s*no\s+flag)\b|\btrue\s+(?:if|when)\s+(?:it\s+is\s+)?yes\b`))) {
    eat(m); cur = `($lowercase($string(${cur})) in ["true", "yes", "y", "1", "on"])`; steps.push('Give true when it says yes, y, true, 1 or on; otherwise false.'); acted = true;
  }

  // ---- text in front or behind
  if ((m = find(String.raw`\b(?:add|put|insert|place)\s+${VAL}\s+(?:in\s+front(?:\s+of\s+it)?|before(?:\s+it)?|at\s+the\s+(?:start|beginning|front)|as\s+(?:a\s+)?prefix)\b|\bprefix\w*\s+(?:it\s+)?(?:with|of|:)?\s*${VAL}|\b(?:start|begin)\w*\s+with\s+${VAL}`))) {
    const v = val(m[1] ?? m[2] ?? m[3] ?? "");
    if (v) { eat(m); cur = `${v.expr} & ${/[&?]/.test(cur) ? `(${cur})` : cur}`; steps.push(`Put ${v.say} in front.`); acted = true; }
  }
  if ((m = find(String.raw`\b(?:add|put|insert|place|append)\s+${VAL}\s+(?:at\s+the\s+end|after(?:\s+it)?|behind(?:\s+it)?|as\s+(?:a\s+)?suffix|to\s+the\s+end)\b|\bsuffix\w*\s+(?:it\s+)?(?:with|of|:)?\s*${VAL}|\bappend\s+${VAL}|\b(?:end|finish)\w*\s+with\s+${VAL}|\bfollowed\s+by\s+${VAL}`))) {
    const v = val(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "");
    if (v) { eat(m); cur = `${/[&?]/.test(cur) ? `(${cur})` : cur} & ${v.expr}`; steps.push(`Put ${v.say} at the end.`); acted = true; }
  }

  // ---- what to use when there is nothing
  if ((m = find(String.raw`\b(?:if|when)\s+(?:it\s+is\s+|it's\s+|that\s+is\s+|there\s+is\s+|@\d+@\s+is\s+)?(?:empty|missing|blank|null|nothing|none|not\s+(?:there|present|given|set|provided|available|known))\s*,?\s*(?:then\s+)?(?:use|put|default\s+to|set(?:\s+it)?\s+to|return|write|show|give)\s+${VAL}`)) ||
      (m = find(String.raw`\bdefault\w*\s*(?:to|is|of|value|=|:)?\s*(?:is\s+|of\s+)?${VAL}`)) ||
      (m = find(String.raw`\b(?:otherwise|else|or\s+else)\s+(?:use\s+)?${VAL}`)) ||
      (m = find(String.raw`\bor\s+${VAL}\s+(?:if|when)\s+(?:it\s+is\s+|it's\s+)?(?:empty|missing|blank|null|not\s+(?:there|present|given|set))`))) {
    const v = val(m[1]);
    if (v) { eat(m); cur = `( $v := ${cur}; ($exists($v) and $v != null and $v != "") ? $v : ${v.expr} )`; steps.push(`When there is no value, use ${v.say}.`); acted = true; }
  }

  // ---- a date kept with today / now mentioned next to a field is not something these rules cover
  if (clock) return fail("Dates can be read as \"today's date\" or \"current date and time\" on their own. Comparing or combining them with a field needs an expression.");

  if (!acted) {
    const left = work.replace(/[@#]\d+[@#]/g, " ").split(/[^A-Za-z]+/).filter((w) => w.length > 1 && !FILLER.has(w.toLowerCase()));
    if (left.length) return fail(`${picked.map((p) => p.path).join(" and ")} was recognised, but not what to do with it ("${left.join(" ")}"). Try one of the phrasings below, or write an expression.`);
    work = "";
    return done(cur, [`Copy ${label} as it is.`]);
  }
  return done(cur, steps, guessed);
}

// ---------------------------------------------------------------- suggestions from a wanted output
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const leafKey = (path: string) => wordsOf(path.replace(/\[\d+\]/g, "").split(".").pop() ?? "").join("");
function nameScore(a: string, b: string): number {
  const x = leafKey(a), y = leafKey(b);
  if (!x || !y) return 0;
  if (x === y) return 3;
  if (x.includes(y) || y.includes(x)) return 2;
  const wa = new Set(wordsOf(a.split(".").pop() ?? ""));
  return wordsOf(b.split(".").pop() ?? "").some((w) => wa.has(w)) ? 1 : 0;
}
function targets(v: unknown, path = "", out: { path: string; value: unknown }[] = [], depth = 0): { path: string; value: unknown }[] {
  if (v && typeof v === "object" && !Array.isArray(v) && depth < 8 && Object.keys(v).length) { for (const [k, c] of Object.entries(v)) targets(c, path ? `${path}.${k}` : k, out, depth + 1); }
  else if (path) out.push({ path, value: v });
  return out;
}

/** Works out one rule per wanted output field by comparing the two samples. Fixed rules only. */
export function inferRules(sampleSource: unknown, desiredOutput: unknown): InferredRule[] {
  const src = sourceFields(sampleSource);
  const scalars = src.filter((f) => !f.list && (f.value === null || typeof f.value !== "object"));
  const texts = scalars.filter((f) => typeof f.value === "string" && f.value !== "").slice(0, 40);
  const id = () => "r_" + randomBytes(4).toString("hex");
  const best = (t: string, list: SourceField[]) => [...list].sort((a, b) => nameScore(t, b.path) - nameScore(t, a.path) || a.path.length - b.path.length)[0];
  const rules: InferredRule[] = [];
  for (const t of targets(desiredOutput).slice(0, 300)) {
    const v = t.value;
    const equal = src.filter((f) => same(f.value, v) && v !== null && v !== "" && typeof v !== "boolean");
    const flags = src.filter((f) => same(f.value, v) && (typeof v === "boolean" || v === null || v === "") && nameScore(t.path, f.path) >= 2);
    if (equal.length || flags.length) { const f = best(t.path, equal.length ? equal : flags); rules.push({ id: id(), target: t.path, kind: "direct", source: f.path, confidence: equal.length === 1 || nameScore(t.path, f.path) >= 2 ? 0.95 : 0.7 }); continue; }
    let expr: string | undefined, why = "";
    if (typeof v === "string" && v) {
      const tries: [(s: string) => string, (r: string) => string, string][] = [
        [(s) => s.toUpperCase(), (r) => `$uppercase(${r})`, "in capital letters"],
        [(s) => s.toLowerCase(), (r) => `$lowercase(${r})`, "in small letters"],
        [(s) => s.trim(), (r) => `$trim(${r})`, "without spaces around it"],
        [(s) => s.trim().replace(/\s+/g, "_"), (r) => `$replace($trim(${r}), /\\s+/, "_")`, 'with "_" between the words'],
        [(s) => s.trim().replace(/\s+/g, "-"), (r) => `$replace($trim(${r}), /\\s+/, "-")`, 'with "-" between the words'],
        [(s) => s.replace(/\s+/g, ""), (r) => `$replace(${r}, /\\s+/, "")`, "without spaces"],
        [(s) => s.slice(0, 10), (r) => `$substring(${r}, 0, 10)`, "the first 10 characters (the date)"],
      ];
      outer: for (const [fn, mk, say] of tries) {
        const hits = texts.filter((f) => fn(f.value as string) === v && (say.startsWith("the first") ? /^\d{4}-\d\d-\d\d$/.test(v) : true));
        if (hits.length) { const f = best(t.path, hits); expr = mk(refOf(f.path)); why = `${f.path}, ${say}`; break outer; }
      }
      if (!expr) {
        const nums = scalars.filter((f) => typeof f.value === "number" && String(f.value) === v);
        if (nums.length) { const f = best(t.path, nums); expr = `$string(${refOf(f.path)})`; why = `${f.path} as text`; }
      }
      if (!expr) {
        find: for (const a of texts) for (const b of texts) {
          if (a === b) continue;
          for (const sep of [" ", "", ", ", "-", "_", "/", ","]) {
            if (`${a.value as string}${sep}${b.value as string}` === v) { expr = `${refOf(a.path)} & ${str(sep)} & ${refOf(b.path)}`; if (!sep) expr = `${refOf(a.path)} & ${refOf(b.path)}`; why = `${a.path} and ${b.path} joined${sep ? ` with ${sep === " " ? "a space" : str(sep)}` : ""}`; break find; }
          }
        }
      }
    } else if (typeof v === "number") {
      const nums = texts.filter((f) => (f.value as string).trim() !== "" && Number(f.value) === v);
      if (nums.length) { const f = best(t.path, nums); expr = `$number(${refOf(f.path)})`; why = `${f.path} as a number`; }
    }
    if (expr) { rules.push({ id: id(), target: t.path, kind: "expr", expr, comment: `Suggested: ${why}.`, confidence: 0.8 }); continue; }
    const named = src.filter((f) => nameScore(t.path, f.path) === 3);
    if (named.length) { const f = best(t.path, named); rules.push({ id: id(), target: t.path, kind: "direct", source: f.path, comment: "Suggested because the names match. The sample values differ, so check it.", confidence: 0.5 }); continue; }
    rules.push({ id: id(), target: t.path, kind: "const", value: v, comment: "No input field gives this value, so it is kept as a fixed value. Change it if it should come from the input.", confidence: 0.3 });
  }
  return rules;
}
