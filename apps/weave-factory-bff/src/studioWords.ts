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
  "everything anything convert change turn become becomes always only keep kept using via per any some one data content contents contain contains new same copy copied equal equals name part text whole entire full").split(" "));

const SEP_WORDS: [RegExp, string][] = [
  [/^underscores?$/i, "_"], [/^(?:dash(?:es)?|hyphens?|minus)$/i, "-"], [/^(?:dots?|periods?|full\s*stops?|points?)$/i, "."], [/^commas?$/i, ","],
  [/^(?:spaces?|blanks?)$/i, " "], [/^slash(?:es)?$/i, "/"], [/^pipes?$/i, "|"], [/^at$/i, "@"], [/^colons?$/i, ":"], [/^semicolons?$/i, ";"], [/^(?:nothing|none)$/i, ""],
];
const SEP = String.raw`(?:an?\s+|the\s+|one\s+|single\s+)*(#\d+#|(?!@\d+@)[_\-.,\/|:;+*~@]{1,3}|[a-z]+)(?:\s+(?:sign|character|symbol|char)s?)?`;
const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
// Words that take something away. A phrase such as "after the @" means "keep it" on its own and
// "remove it" behind one of these, so they are never allowed to be skipped over.
const RM = String.raw`(?:(?:remov\w*|delet\w*|drop\w*|strip\w*|eras\w*|omit\w*|exclud\w*|discard\w*|skip\w*|ignor\w*|cut(?:ting|s)?|chop\w*|truncat\w*|trim\w*)(?:\s+(?:off|out|away)\b)?|nothing|none\s+of|leav\w*\s+out|tak\w*\s+(?:out|away|off)|get(?:ting)?\s+rid\s+of|throw\w*\s+away|los[ei]\w*|without|except(?:\s+for)?|all\s+but|everything\s+but|but\s+not|not\s+(?:keep\w*|need\w*|want\w*|includ\w*|show\w*|us\w*|tak\w*)|(?:do\s+not|don't|dont|no\s+need\s+(?:to|for|of)|never)\s+(?:keep|need|want|include|show|use|take))`;
const STUFF = String.raw`(?:\s+(?:the|all|any|every|everything|anything|whatever|what|that|which|what's|whats|that's|its|their|text|part|parts|portion|bit|value|values|string|letters?|characters?|chars?|digits?|data|content|contents|rest|stuff|things?|comes?|coming|is|are|was|it|of|in|(?:of|in|from)\s+@\d+@|@\d+@)|\s*,)*`;
const GONE = String.raw`(?:(?:\s+(?:should|must|needs?\s+to|has\s+to|have\s+to|is\s+to|are\s+to|to|will|shall|can|is|are|gets?|got))?(?:\s+be)?\s+(?:removed|deleted|dropped|stripped|erased|omitted|excluded|discarded|skipped|ignored|cut(?:\s+(?:off|out|away))?|chopped(?:\s+off)?|truncated|trimmed(?:\s+off)?|left\s+out|taken\s+(?:out|away|off)|thrown\s+away|gone|not\s+(?:needed|required|wanted|kept|used|shown|included|necessary))|\s+(?:should|must|shall|will|can|need|does)\s*(?:\s+not|n't)\s+(?:be\s+)?(?:kept|included|shown|there|present|used|appear|come|stay))`;
const AFTER = String.raw`after|following|follows|behind|past|beyond`;
const BEFORE = String.raw`before|preceding|precedes|in\s+front\s+of|ahead\s+of|up\s+to|upto|until|till`;
const ORD = String.raw`(?:the\s+)?(?:(first|last|final)\s+)?`;
const TAIL = String.raw`(?:\s+(?:onwards?|forwards?|to\s+the\s+end|till\s+the\s+end|until\s+the\s+end|and\s+(?:the\s+)?rest))?`;
const UNIT = String.raw`(words?|letters?|characters?|chars?|digits?|numbers?|symbols?)`;
// Left over after every rule ran, one of these means the sentence was not understood: answering
// anyway would give the opposite of what was asked.
const MEANING = new Set(("not no never don dont doesn doesnt isn isnt aren arent won cannot without except excluding exclude excluded excludes " +
  "remove removed removes removing delete deleted deletes drop dropped drops strip stripped omit omitted skip skipped ignore ignored cut truncate " +
  "unless instead opposite reverse reversed swap swapped switch neither nor but minus less percent percentage ratio " +
  "nothing every each outside different other fewer half double twice erase erased discard discarded chop chopped rid lose").split(" "));
const NUMWORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const BEFORE_LAST = (x: string, s: string) => `( $p := $split(${x}, ${JSON.stringify(s)}); $count($p) < 2 ? $p[0] : $join($filter($p, function($v, $i) { $i < $count($p) - 1 }), ${JSON.stringify(s)}) )`;
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
  work = work.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?=\s+(?:letters?|characters?|chars?|digits?|symbols?|words|decimals?|decimal\s+places?)\b)/gi, (w) => String(NUMWORDS[w.toLowerCase()]));

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
    const turned = left.filter((w) => MEANING.has(w.toLowerCase()));
    if (turned.length) return fail(`The word "${turned[0]}" changes what this sentence means, and the rest of it was not understood well enough to be sure of the result. Say it another way, or write an expression.`);
    const stray = (work.replace(/@\d+@/g, " ").match(/#\d+#|\d+(?:\.\d+)?|[_\-\/|+*~@=<>%&]+/g) ?? []).map((s) => { const q = /^#(\d+)#$/.exec(s); return q ? str(quotes[Number(q[1])]) : s; });
    const unsure = guessed || left.length > 0 || stray.length > 0 || picked.some((p) => !p.exact);
    for (const s of steps) understood.push(s);
    if (left.length || stray.length) understood.push(`Not used: "${[...left, ...stray].join(" ")}". Check the result.`);
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
    [String.raw`(?:is\s+|are\s+)?fewer\s+than`, "<", "is less than"],
    [String.raw`(?:(?:is|are)\s+not\s+the\s+same\s+as|(?:is|are)\s+different\s+(?:from|than|to)|differs\s+from|(?:is|are)\s+other\s+than|(?:is|are)\s+anything\s+(?:but|other\s+than|except))`, "!=", "is not"],
    [String.raw`(?:(?:is\s+not|isn't|are\s+not|not|is\s+no|no)\s+(?:greater|more|bigger|larger|higher)\s+than|(?:is\s+)?not\s+(?:over|above))`, "<=", "is at most"],
    [String.raw`(?:(?:is\s+not|isn't|are\s+not|not|is\s+no|no)\s+(?:less|smaller|lower|fewer)\s+than|(?:is\s+)?not\s+(?:below|under))`, ">=", "is at least"],
    [String.raw`(?:is\s+)?not\s+at\s+least`, "<", "is less than"],
    [String.raw`(?:is\s+)?not\s+at\s+most`, ">", "is greater than"],
    [String.raw`(?:(?:does\s+not|doesn't|do\s+not|don't)\s+(?:contain|include)|(?:is\s+)?not\s+containing)`, "ncontains", "does not contain"],
    [String.raw`(?:does\s+not|doesn't|do\s+not|don't)\s+(?:start|begin)\s+with`, "nstarts", "does not start with"],
    [String.raw`(?:does\s+not|doesn't|do\s+not|don't)\s+end\s+with`, "nends", "does not end with"],
    [String.raw`(?:is\s+not\s+(?:one|any)\s+of|is\s+none\s+of|is\s+not\s+in|is\s+not\s+among|is\s+neither)`, "nin", "is not one of"],
    [String.raw`(?:is\s+not\s+equal\s+to|is\s+not|isn't|does\s+not\s+equal|doesn't\s+equal|not\s+equals?|!=|<>)`, "!=", "is not"],
    [String.raw`(?:is\s+)?(?:greater\s+than\s+or\s+equal\s+to|at\s+least|>=)`, ">=", "is at least"],
    [String.raw`(?:is\s+)?(?:less\s+than\s+or\s+equal\s+to|at\s+most|<=)`, "<=", "is at most"],
    [String.raw`(?:is\s+)?(?:greater\s+than|more\s+than|bigger\s+than|larger\s+than|higher\s+than|over|above|>)`, ">", "is greater than"],
    [String.raw`(?:is\s+)?(?:less\s+than|smaller\s+than|lower\s+than|below|under|<)`, "<", "is less than"],
    [String.raw`(?:contains|includes)`, "contains", "contains"],
    [String.raw`(?:starts|begins)\s+with`, "starts", "starts with"],
    [String.raw`ends\s+with`, "ends", "ends with"],
    [String.raw`(?:is\s+one\s+of|is\s+any\s+of|is\s+in|is\s+either|is\s+among)`, "in", "is one of"],
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
    if ((x = new RegExp(`^${LHS}\\s+(?:(?:is|are|was)\\s+)?((?:not\\s+)?(?:between|in\\s+the\\s+range(?:\\s+of)?|within)|outside(?:\\s+of)?(?:\\s+the\\s+range(?:\\s+of)?)?)\\s+(.+?)\\s+(?:and|to)\\s+(.+)$`, "i").exec(s))) {
      const l = lhs(x[1]), a = val(x[3]), b = val(x[4]);
      if (!l || !a || !b || !/^-?\d/.test(a.expr) || !/^-?\d/.test(b.expr)) return null;
      const e = `($number(${l.expr}) >= ${a.expr} and $number(${l.expr}) <= ${b.expr})`;
      return /^(?:not|outside)/i.test(x[2]) ? { expr: `$not${e}`, say: `${l.say} is not between ${a.say} and ${b.say}` } : { expr: e, say: `${l.say} is between ${a.say} and ${b.say}` };
    }
    for (const [re, op, say] of CMP) {
      x = new RegExp(`^${LHS}\\s*${re}\\s*(.+)$`, "i").exec(s);
      if (!x) continue;
      const l = lhs(x[1]); if (!l) return null;
      if (op === "in" || op === "nin") {
        const items = x[2].split(/\s*,\s*|\s+or\s+|\s+nor\s+|\s+and\s+/).map((p) => val(p)).filter(Boolean) as { expr: string; say: string }[];
        if (!items.length) return null;
        const e = `(${l.expr} in [${items.map((i) => i.expr).join(", ")}])`;
        return op === "in" ? { expr: e, say: `${l.say} is one of ${items.map((i) => i.say).join(", ")}` } : { expr: `$not${e}`, say: `${l.say} is not one of ${items.map((i) => i.say).join(", ")}` };
      }
      if (op === "=" || op === "!=") {
        const rhs = x[2].trim();
        // "is greater than 5" and the like are comparisons, never a text to compare with
        if (/^(?:not|no|anything|different|other\s+than|outside|same|greater|less|more|fewer|bigger|smaller|larger|higher|lower|between|at\s+(?:least|most)|one\s+of|any\s+of|either|neither|like|unlike|longer|shorter|before|after|earlier|later|older|newer|in\s+the\s+range|within|outside)\b/i.test(rhs)) return null;
        const many = rhs.split(/\s*,\s*|\s+or\s+|\s+nor\s+/).filter(Boolean);
        if (many.length > 1) {
          const items = many.map((p) => val(p));
          if (items.every(Boolean)) {
            const e = `(${l.expr} in [${items.map((i) => i!.expr).join(", ")}])`;
            return op === "=" ? { expr: e, say: `${l.say} is one of ${items.map((i) => i!.say).join(", ")}` } : { expr: `$not${e}`, say: `${l.say} is not one of ${items.map((i) => i!.say).join(", ")}` };
          }
        }
      }
      const r = val(x[2]); if (!r) return null;
      if (op === "ncontains") return { expr: `$not($contains($string(${l.expr}), ${r.expr}))`, say: `${l.say} does not contain ${r.say}` };
      if (op === "nstarts") return { expr: `($substring($string(${l.expr}), 0, $length(${r.expr})) != ${r.expr})`, say: `${l.say} does not start with ${r.say}` };
      if (op === "nends") return { expr: `($substring($string(${l.expr}), -$length(${r.expr})) != ${r.expr})`, say: `${l.say} does not end with ${r.say}` };
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
    if (/\bthen\b/i.test(text)) {
      // a list in the condition has commas of its own ("is one of A, B then ..."): split at "then" first
      const y = new RegExp(String.raw`^\s*(?:if|when|whenever|in\s+case)\s+(.+?)\s*,?\s*\bthen\b\s*[,:]?\s*${LEAD}(.+?)(?:\s*[,;.]?\s*\b(?:otherwise|else|or\s+else)\b\s*[,:]?\s*(.+?))?\s*\.?\s*$`, "i").exec(text);
      if (y && cond(y[1])) x = y;
    }
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
  if (/\bunless\b/i.test(work)) {
    const x = new RegExp(String.raw`^\s*${LEAD}(.+?)\s*,?\s+unless\s+(.+?)(?:\s*[,;.]?\s*\b(?:then|in\s+which\s+case|in\s+that\s+case)\b\s*[,:]?\s*${LEAD}(.+?))?\s*\.?\s*$`, "i").exec(work);
    const c = x ? cond(x[2]) : null, a = x ? val(x[1]) : null, b = x && x[3] !== undefined ? val(x[3]) : null;
    if (!x || !c || !a || (x[3] !== undefined && !b)) return fail('"unless" was not understood here. Say it with "if", for example: if (status) is "A" then "Yes" otherwise "No".');
    work = "";
    return b
      ? done(`${c.expr} ? ${b.expr} : ${a.expr}`, [`When ${c.say} use ${b.say}, otherwise ${a.say}.`])
      : done(`$not(${c.expr}) ? ${a.expr}`, [`Use ${a.say}, except when ${c.say}: then leave the field out.`]);
  }
  if (/\b(?:if|when|whenever|in\s+case)\b/i.test(work)) {
    const c = conditional(work);
    if (c) { work = ""; return done(c.expr, [c.say.charAt(0).toUpperCase() + c.say.slice(1) + "."]); }
    return fail('The condition in this sentence was not understood. For example: if (status) is "A" then "Yes" otherwise "No"; if (amount) is greater than 100 then "high" otherwise "low".');
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
    if ((m = find(String.raw`\b(?:subtract|deduct|take\s+away|take\s+off)\w*\s+@0@\s+from\s+@1@|\btak\w*\s+@0@\s+(?:away|off)\s+from\s+@1@|@0@\s+(?:subtracted|deducted|taken\s+away|taken\s+off)\s+from\s+@1@`))) { eat(m); arith("-", B, A, `Take ${b} minus ${a}.`); }
    else if ((m = find(String.raw`\bfrom\s+@0@\s*,?\s+(?:subtract|deduct|take\s+away|take\s+off)\w*\s+@1@`))) { eat(m); arith("-", A, B, `Take ${a} minus ${b}.`); }
    else if ((m = find(String.raw`@0@\s+(?:reduced|decreased|lowered)\s+by\s+@1@`))) { eat(m); arith("-", A, B, `Take ${a} minus ${b}.`); }
    else if ((m = find(String.raw`@0@\s+(?:increased|raised)\s+by\s+@1@`))) { eat(m); arith("+", A, B, `Add ${a} and ${b}.`); }
    else if ((m = find(String.raw`@0@\s+as\s+(?:an?\s+)?(?:percentage|percent|%)\s+of\s+@1@`))) { eat(m); cur = `$number(${A}) / $number(${B}) * 100`; steps.push(`Divide ${a} by ${b} and multiply by 100.`); acted = true; label = "the result"; }
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
      if (/\b(?:subtract\w*|minus|deduct\w*|divid\w*|multipl\w*|difference|percent\w*|ratio|times|product|quotient|away|reduc\w*|decreas\w*|increas\w*|lower\w*|rais\w*|half|halve\w*|doubl\w*|twice|average)\b|%/i.test(work)) {
        return fail(`The calculation with ${a} and ${b} was not understood. For example: (${a}) minus (${b}), subtract (${a}) from (${b}), (${a}) divided by (${b}).`);
      }
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

  // ---- taking a part away. Each phrase below also exists further down as "picking a part",
  // where it means the opposite, so the sentences that take something away are read first.
  let took = false;
  work = work.replace(/\bwith\s+no\b/gi, "without").replace(/\btak\w*\s+((?:(?:all|the|any|every)\s+)*(?:[a-z]+|[_\-.,\/|:;@]))\s+(?:out|away)\s+(?:of|from)\b/i, "remove $1 from");
  work = work.replace(/\b(?:remov\w*|delet\w*|drop\w*|strip\w*|eras\w*|discard\w*|ignor\w*|cut\w*|trim\w*)\s+(?:everything|every\s+thing|anything|all|the\s+rest|all\s+the\s+rest)\s+(?:except|but|other\s+than|apart\s+from|besides)(?:\s+for)?\b/i, " only ").replace(/\s+/g, " ").trim();
  {
    // "... and remove the rest", "... and drop what comes after": they repeat what is kept
    const rest = new RegExp(String.raw`[,;]?\s*\b(?:and\s+|then\s+|but\s+)?${RM}\s+(?:the\s+rest|all\s+the\s+rest|everything\s+else|anything\s+else|all\s+else|the\s+other\s+part|the\s+others?|the\s+remaining(?:\s+(?:part|text|characters|letters))?|whatever\s+is\s+left|what\s+is\s+left)\b(?!\s+(?:${AFTER}|${BEFORE}|from)\b)`, "i");
    if (rest.test(work) && new RegExp(String.raw`\b(?:${AFTER}|${BEFORE}|first|last|only|keep)\b`, "i").test(work.replace(rest, " "))) work = work.replace(rest, " ").replace(/\s+/g, " ").trim();
    const dangling = new RegExp(String.raw`[,;]?\s*\b(?:and\s+|then\s+|but\s+)?${RM}${STUFF}\s+(?:${AFTER}|${BEFORE})(?:\s+(?:it|that|this))?(?=\s*(?:$|[.,;]))`, "i");
    const keeps = new RegExp(String.raw`\b(?:${AFTER}|${BEFORE})\s+${ORD}${SEP}`, "i").exec(work.replace(dangling, " "));
    if (dangling.test(work) && keeps && sepOf(keeps[2]) !== undefined) work = work.replace(dangling, " ").replace(/\s+/g, " ").trim();
  }
  const sepAt = (i: number): string | undefined => { const s = m ? sepOf(m[i]) : undefined; return s === undefined || s === "" ? undefined : s; };
  const sideOf = (w: string): "after" | "before" => (new RegExp(`^(?:${AFTER})$`, "i").test(w.trim()) ? "after" : "before");
  const cutAt = (side: "after" | "before", which: string | undefined, s: string) => {
    const last = /^(?:last|final)$/i.test(which ?? "");
    const x = `$string(${cur})`;
    if (side === "after") {
      cur = last ? BEFORE_LAST(x, s) : `$substringBefore(${x}, ${str(s)})`;
      steps.push(`Remove ${last ? "the last " : ""}${showSep(s)} and everything after it.`);
    } else {
      cur = last ? `$split(${x}, ${str(s)})[-1]` : `$substringAfter(${x}, ${str(s)})`;
      steps.push(`Remove everything before ${last ? "the last " : ""}${showSep(s)}, and ${showSep(s)} itself.`);
    }
    took = true; acted = true;
  };
  const dropPart = (which: string, n: number, unit: string) => {
    const first = /^(?:first|1st|leading|starting)$/i.test(which);
    const x = `$string(${cur})`;
    if (/^word/i.test(unit)) {
      cur = first
        ? `$join($append([], $filter($split($trim(${x}), /\\s+/), function($v, $i) { $i >= ${n} })), " ")`
        : `( $w := $split($trim(${x}), /\\s+/); $join($append([], $filter($w, function($v, $i) { $i < $count($w) - ${n} })), " ") )`;
      steps.push(`Remove the ${first ? "first" : "last"} ${n === 1 ? "word" : `${n} words`}.`);
    } else {
      cur = first ? `$substring(${x}, ${n})` : `( $s := ${x}; $substring($s, 0, $max([$length($s) - ${n}, 0])) )`;
      steps.push(`Remove the ${first ? "first" : "last"} ${n === 1 ? "character" : `${n} characters`}.`);
    }
    took = true; acted = true;
  };
  const HEAD = String.raw`\b(?:(?:but|and|then)\s+)?(?:(?:everything|anything|all)\s+)?${RM}${STUFF}`;
  const WHICH = String.raw`(first|1st|leading|starting|last|final|trailing|ending)`;
  if ((m = find(String.raw`${HEAD}\s+${WHICH}\s+(?:${NUM}\s+)?${UNIT}\b(?:\s+(?:of|from|in)(?=\s+@\d+@))?`)) ||
      (m = find(String.raw`\b(?:the\s+)?${WHICH}\s+(?:${NUM}\s+)?${UNIT}\b(?:\s+(?:of|from|in)\s+@\d+@)?${GONE}`))) {
    eat(m); dropPart(m[1], m[2] === undefined ? 1 : Math.abs(Math.trunc(Number(m[2]))), m[3]);
  } else if ((m = find(String.raw`${HEAD}\s+(${AFTER}|${BEFORE})(?:\s+and\s+including|\s+including)?\s+${ORD}${SEP}${TAIL}`)) && sepAt(3) !== undefined) {
    const s = sepAt(3)!, side = sideOf(m[1]), which = m[2]; eat(m); cutAt(side, which, s);
  } else if ((m = find(String.raw`${HEAD}\s+(?:starting\s+)?(?:from|at)\s+${ORD}${SEP}${TAIL}`)) && sepAt(2) !== undefined) {
    const s = sepAt(2)!, which = m[1]; eat(m); cutAt("after", which, s);
  } else if ((m = find(String.raw`${HEAD}\s+${SEP}\s+(?:and|plus|along\s+with|together\s+with|with)${STUFF}\s+(${AFTER}|${BEFORE})(?:\s+(?:it|that|this|them))?${TAIL}`)) && sepAt(1) !== undefined) {
    const s = sepAt(1)!, side = sideOf(m[2]); eat(m); cutAt(side, undefined, s);
  } else if ((m = find(String.raw`\b(?:(?:the|all|any|everything|anything|whatever|what|text|part|value|string|letters|characters|data|content|rest|comes|is|with)\s+)*(${AFTER}|${BEFORE})\s+${ORD}${SEP}${TAIL}(?:\s+(?:of|from|in)\s+@\d+@)?${GONE}`)) && sepAt(3) !== undefined) {
    const s = sepAt(3)!, side = sideOf(m[1]), which = m[2]; eat(m); cutAt(side, which, s);
  } else if ((m = find(String.raw`\b(${AFTER}|${BEFORE})\s+${ORD}${SEP}\s*,?\s+${RM}(?:\s+(?:everything|anything|all|it|that|(?:all\s+)?the\s+(?:text|part|value|string|characters|letters)))?(?=\s*(?:$|[.;]|(?:in|from|of)\s+@\d+@|@\d+@))`)) && sepAt(3) !== undefined) {
    const s = sepAt(3)!, side = sideOf(m[1]), which = m[2]; eat(m); cutAt(side, which, s);
  } else if ((m = find(String.raw`\b(?:with\s+)?${SEP}\s+and\s+(?:the\s+rest|(?:everything|anything|all|what(?:ever)?)(?:\s+(?:that\s+)?(?:comes|is))?\s+(${AFTER}|${BEFORE})(?:\s+it)?)${GONE}`)) && sepAt(1) !== undefined) {
    const s = sepAt(1)!, side = m[2] ? sideOf(m[2]) : "after"; eat(m); cutAt(side, undefined, s);
  } else if ((m = find(String.raw`(?:${HEAD}\s+|\bminus\s+(?:the\s+|its\s+)?)domain(?:\s+(?:name|part))?\b(?:\s+(?:of|from|in)(?=\s+@\d+@))?`))) {
    eat(m); cutAt("after", undefined, "@");
  } else if ((m = find(String.raw`${HEAD}\s+(?:file\s+)?extension\b(?:\s+(?:of|from|in)(?=\s+@\d+@))?`))) {
    eat(m); cutAt("after", "last", ".");
  } else if ((m = find(String.raw`\b${RM}\s+(?:the\s+|all\s+|any\s+)*(?:leading\s+(?:zeros|zeroes|0s?)\b|(?:zeros|zeroes|0s?)\s+(?:in\s+front|at\s+the\s+(?:start|beginning|front))\b(?:\s+of(?=\s+@\d+@))?)`))) {
    eat(m); cur = `$replace($string(${cur}), /^0+/, "")`; steps.push("Remove the zeros at the start."); took = true; acted = true;
  } else if ((m = find(String.raw`\b${RM}\s+(?:the\s+)?(?:first|1st)\s+${SEP}`)) && sepAt(1) !== undefined && sepAt(1) !== " ") {
    const s = sepAt(1)!; eat(m); cur = `$replace($string(${cur}), ${str(s)}, "", 1)`; steps.push(`Remove the first ${showSep(s)}.`); took = true; acted = true;
  }
  if (took) {
    // "keep what is before the @ and remove what is after the @" says the same thing twice
    const again = find(String.raw`\b(?:keep\w*\s+|only\s+|just\s+)*(?:the\s+)?(?:part|text|everything|anything|all|what\s+(?:is|comes))?\s*\b(?:${AFTER}|${BEFORE})\s+${ORD}${SEP}`);
    if (again && sepOf(again[2]) !== undefined) eat(again);
  }

  // ---- picking a part
  if (took) {
    // a part was taken away above; the same words are not read again as "keep"
  } else if ((m = find(String.raw`\b(?:the\s+)?(?:first|1st)\s+(?:letter|character)\s+of\s+(?:each|every)\s+word\b(?:\s+(?:of|from|in))?`))) {
    eat(m); cur = `$join($map($split($trim($string(${cur})), /\\s+/), function($w) { $uppercase($substring($w, 0, 1)) }), "")`; steps.push("Keep the first letter of each word."); acted = true;
  } else if ((m = find(String.raw`\b(?:the\s+)?(second|third|fourth|fifth|2nd|3rd|4th|5th)\s+word\b(?:\s+(?:of|from|in))?`))) {
    const n = ({ second: 2, third: 3, fourth: 4, fifth: 5 } as Record<string, number>)[m[1].toLowerCase()] ?? Number(m[1].charAt(0)); eat(m);
    cur = `$split($trim($string(${cur})), /\\s+/)[${n - 1}]`; steps.push(`Keep word number ${n}.`); acted = true;
  } else if ((m = find(String.raw`\b(?:only\s+|just\s+)?(?:the\s+)?(?:file\s+)?extension\b(?:\s+(?:of|from))?`))) {
    eat(m); cur = `$split($string(${cur}), ".")[-1]`; steps.push('Keep what comes after the last ".".'); acted = true;
  } else if ((m = find(String.raw`\b(?:first|1st|leading)\s+${NUM}\s+words\b(?:\s+(?:of|from|in))?`))) {
    const n = Math.abs(Math.trunc(Number(m[1]))); eat(m);
    cur = `$join($append([], $filter($split($trim($string(${cur})), /\\s+/), function($v, $i) { $i < ${n} })), " ")`; steps.push(`Keep the first ${n} words.`); acted = true;
  } else if ((m = find(String.raw`\b(?:last|final|trailing)\s+${NUM}\s+words\b(?:\s+(?:of|from|in))?`))) {
    const n = Math.abs(Math.trunc(Number(m[1]))); eat(m);
    cur = `( $w := $split($trim($string(${cur})), /\\s+/); $join($append([], $filter($w, function($v, $i) { $i >= $count($w) - ${n} })), " ") )`; steps.push(`Keep the last ${n} words.`); acted = true;
  } else if ((m = find(String.raw`\b(?:last|final)\s+(?:letter|character|char|digit)\b(?:\s+(?:of|from|in))?`)) && !/capital/i.test(work)) {
    eat(m); cur = `$substring($string(${cur}), -1)`; steps.push("Keep the last character."); acted = true;
  } else if ((m = find(String.raw`\b(?:the\s+)?(?:part|text|everything|anything|all)?\s*\bbetween\s+${SEP}\s+and\s+${SEP}`)) && sepAt(1) !== undefined && sepAt(2) !== undefined) {
    const a = sepAt(1)!, b = sepAt(2)!; eat(m);
    cur = `$substringBefore($substringAfter($string(${cur}), ${str(a)}), ${str(b)})`; steps.push(`Keep what stands between ${showSep(a)} and the next ${showSep(b)}.`); acted = true;
  } else if ((m = find(String.raw`\b(?:the\s+)?(?:part|text|everything|anything|all)?\s*\b(?:before|up\s+to|until)\s+(?:the\s+)?(?:last|final)\s+${SEP}`)) && sepAt(1) !== undefined) {
    const s = sepAt(1)!; eat(m); cur = BEFORE_LAST(`$string(${cur})`, s); steps.push(`Keep what comes before the last ${showSep(s)}.`); acted = true;
  } else if ((m = find(String.raw`\b(?:the\s+)?(?:part|text|everything|anything|all)?\s*\b(?:after|following|behind)\s+(?:the\s+)?(?:last|final)\s+${SEP}`)) && sepAt(1) !== undefined) {
    const s = sepAt(1)!; eat(m); cur = `$split($string(${cur}), ${str(s)})[-1]`; steps.push(`Keep what comes after the last ${showSep(s)}.`); acted = true;
  } else if ((m = find(String.raw`\b(?:only\s+|just\s+)?(?:the\s+)?domain(?:\s+(?:name|part))?\b(?:\s+(?:of|from))?`))) {
    eat(m); cur = `$substringAfter($string(${cur}), "@")`; steps.push('Keep what comes after "@".'); acted = true;
  } else if ((m = find(String.raw`\b(?:first|1st)\s+word\b(?:\s+(?:of|from|in))?`))) {
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
  if ((m = find(String.raw`\b(?:remov\w*|delet\w*|strip\w*|drop\w*|without)\s+(?:all\s+|the\s+|any\s+|every\s+)*(digits|numbers|numerals|letters|alphabets?|special\s+(?:characters|chars|symbols)|symbols|punctuation(?:\s+marks?)?|non[\s-]?alphanumeric(?:\s+(?:characters|chars))?)\b`))) {
    const kind = m[1].toLowerCase(); eat(m);
    if (/^(?:digits|numbers|numerals)/.test(kind)) { cur = `$replace($string(${cur}), /[0-9]/, "")`; steps.push("Remove every digit."); }
    else if (/^(?:letters|alphabet)/.test(kind)) { cur = `$replace($string(${cur}), /[A-Za-z]/, "")`; steps.push("Remove every letter."); }
    else { cur = `$replace($string(${cur}), /[^A-Za-z0-9\\s]/, "")`; steps.push("Remove everything that is not a letter, a digit or a space."); }
    acted = true;
  }
  if ((m = find(String.raw`\b(?:use\s+|put\s+|write\s+|want\s+|have\s+)?${SEP}\s+instead\s+of\s+${SEP}`)) && sepOf(m[1]) !== undefined && sepOf(m[2]) !== undefined && sepOf(m[2]) !== "") {
    const a = sepOf(m[2])!, b = sepOf(m[1])!; eat(m); cur = `$replace($string(${cur}), ${str(a)}, ${str(b)})`; steps.push(`Replace every ${showSep(a)} with ${showSep(b)}.`); acted = true;
  } else if ((m = find(String.raw`\b(?:chang|convert|turn|swap|switch|substitut|translat)\w*\s+(?:all\s+|every\s+|each\s+|the\s+|any\s+)*${SEP}\s+(?:to|into|with|for|by)\s+${SEP}`)) && sepOf(m[1]) !== undefined && sepOf(m[1]) !== "" && sepOf(m[2]) !== undefined) {
    const a = sepOf(m[1])!, b = sepOf(m[2])!; eat(m); cur = `$replace($string(${cur}), ${str(a)}, ${str(b)})`; steps.push(`Replace every ${showSep(a)} with ${showSep(b)}.`); acted = true;
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
  const PLACES = String.raw`(?:\s+to\s+${NUM}\s+(?:decimals?|decimal\s+places?|digits?|places?))?`;
  if ((m = find(String.raw`\bround\w*\s+(?:it\s+|@\d+@\s+)?up\b(?:\s+@\d+@)?${PLACES}|\bceil(?:ing)?\b`))) {
    eat(m); const n = m[1] ? Number(m[1]) : 0;
    cur = n ? `$ceil($number(${cur}) * ${10 ** n}) / ${10 ** n}` : `$ceil($number(${cur}))`; steps.push(n ? `Round it up to ${n} decimals.` : "Round it up to the next whole number."); acted = true;
  } else if ((m = find(String.raw`\bround\w*\s+(?:it\s+|@\d+@\s+)?down\b(?:\s+@\d+@)?${PLACES}|\bfloor\b`))) {
    eat(m); const n = m[1] ? Number(m[1]) : 0;
    cur = n ? `$floor($number(${cur}) * ${10 ** n}) / ${10 ** n}` : `$floor($number(${cur}))`; steps.push(n ? `Round it down to ${n} decimals.` : "Round it down to a whole number."); acted = true;
  } else if ((m = find(String.raw`\b(?:drop|cut|chop|remov\w*|strip|truncat\w*|delet\w*)\s+(?:off\s+)?(?:the\s+|all\s+)*(?:decimals?|decimal\s+places?|fractions?|digits\s+after\s+the\s+(?:point|dot|comma))\b`))) {
    eat(m); cur = `( $n := $number(${cur}); $n < 0 ? $ceil($n) : $floor($n) )`; steps.push("Cut the decimals off, without rounding."); acted = true;
  } else if ((m = find(String.raw`\bround\w*\s+(?:it\s+|@\d+@\s+)?(?:to\s+)?${NUM}\s+(?:decimals?|decimal\s+places?|digits?|places?)\b|\b(?:with\s+)?${NUM}\s+(?:decimals?|decimal\s+places?)\b`))) {
    eat(m); const n = Number(m[1] ?? m[2]); cur = `$round($number(${cur}), ${n})`; steps.push(`Round it to ${n} decimals.`); acted = true;
  } else if ((m = find(String.raw`\bround\w*(?:\s+(?:it|off))?(?:\s+to\s+(?:the\s+|a\s+)?(?:nearest\s+)?(?:whole(?:\s+number)?|integer|unit))?\b|\bwhole\s+number\b|\bno\s+decimals\b|\bwithout\s+decimals\b`))) {
    eat(m); cur = `$round($number(${cur}))`; steps.push("Round it to a whole number."); acted = true;
  }
  const PCT = String.raw`\s*(?:%|percent|per\s+cent)`;
  const IT = String.raw`(?:it\b|@\d+@)`;
  if ((m = find(String.raw`\b(?:increas\w*|rais\w*|add|plus)\s+(?:${IT}\s+)?(?:by\s+)?${NUM}${PCT}`))) { eat(m); cur = `$number(${cur}) * ${100 + Number(m[1])} / 100`; steps.push(`Increase it by ${m[1]} percent.`); acted = true; }
  else if ((m = find(String.raw`\b(?:decreas\w*|reduc\w*|lower\w*|discount\w*|subtract|minus|less)\s+(?:${IT}\s+)?(?:by\s+|of\s+)?${NUM}${PCT}`))) { eat(m); cur = `$number(${cur}) * ${100 - Number(m[1])} / 100`; steps.push(`Reduce it by ${m[1]} percent.`); acted = true; }
  else if ((m = find(String.raw`${NUM}${PCT}\s+of\b`))) { eat(m); cur = `$number(${cur}) * ${m[1]} / 100`; steps.push(`Take ${m[1]} percent of it.`); acted = true; }
  else if (picked.length === 1 && (m = find(String.raw`\b(?:half|halve\w*)\b(?:\s+of)?`))) { eat(m); cur = `$number(${cur}) / 2`; steps.push("Divide it by 2."); acted = true; }
  else if (picked.length === 1 && (m = find(String.raw`\b(?:doubl\w*|twice|two\s+times)\b(?:\s+of)?`))) { eat(m); cur = `$number(${cur}) * 2`; steps.push("Multiply it by 2."); acted = true; }
  else if (picked.length === 1 && (m = find(String.raw`\bsubtract\w*\s+${IT}\s+from\s+${NUM}\b|${NUM}\s*minus\s*${IT}|${NUM}\s+-\s+${IT}`))) { eat(m); const n = m[1] ?? m[2] ?? m[3]; cur = `${n} - $number(${cur})`; steps.push(`Take ${n} minus it.`); acted = true; }
  else if (picked.length === 1 && (m = find(String.raw`\bdivid\w*\s+${NUM}\s+by\s+${IT}|${NUM}\s*(?:\/|divided\s+by|over)\s*${IT}`))) { eat(m); const n = m[1] ?? m[2]; cur = `${n} / $number(${cur})`; steps.push(`Divide ${n} by it.`); acted = true; }
  else if ((m = find(String.raw`\b(?:multipl\w+\s+(?:it\s+|@\d+@\s+)?(?:by|with)|times)\s+${NUM}\b|\*\s*${NUM}`))) { eat(m); const n = m[1] ?? m[2]; cur = `$number(${cur}) * ${n}`; steps.push(`Multiply it by ${n}.`); acted = true; }
  else if ((m = find(String.raw`\b(?:divid\w+\s+(?:it\s+|@\d+@\s+)?by)\s+${NUM}\b|\/\s*${NUM}`))) { eat(m); const n = m[1] ?? m[2]; cur = `$number(${cur}) / ${n}`; steps.push(`Divide it by ${n}.`); acted = true; }
  else if ((m = find(String.raw`\b(?:add|plus|increase\s+(?:it\s+|@\d+@\s+)?by)\s+${NUM}\b(?!\s*(?:letters?|characters?|digits?))|\+\s*${NUM}`))) { eat(m); const n = m[1] ?? m[2]; cur = `$number(${cur}) + ${n}`; steps.push(`Add ${n}.`); acted = true; }
  else if ((m = find(String.raw`\b(?:subtract|minus|(?:decrease|reduce)\s+(?:it\s+|@\d+@\s+)?by)\s+${NUM}\b`))) { eat(m); cur = `$number(${cur}) - ${m[1]}`; steps.push(`Subtract ${m[1]}.`); acted = true; }
  else if ((m = find(String.raw`\b(?:as|to|into)\s+(?:a\s+|an\s+)?(?:number|numeric|integer|decimal)\b|\bnumeric\b|\bas\s+number\b`))) { eat(m); cur = `$number(${cur})`; steps.push("Turn it into a number."); acted = true; }
  else if ((m = find(String.raw`\b(?:as|to|into)\s+(?:a\s+)?(?:text|string|characters)\b`))) { eat(m); cur = `$string(${cur})`; steps.push("Turn it into text."); acted = true; }
  else if ((m = find(String.raw`\b(?:as|to|into)\s+(?:a\s+)?(?:boolean|true\s*(?:\/|or)\s*false|yes\s*(?:\/|or)\s*no\s+flag)\b|\btrue\s+(?:if|when)\s+(?:it\s+is\s+)?yes\b`))) {
    eat(m); cur = `($lowercase($string(${cur})) in ["true", "yes", "y", "1", "on"])`; steps.push('Give true when it says yes, y, true, 1 or on; otherwise false.'); acted = true;
  }

  // ---- text in front or behind. A word is separated by one space ("New" before web -> "New web"); text that already
  // ends (or starts) with a separator such as - / _ : . is joined directly, and so is everything said "without a space" or with +.
  const plainJoin = /\b(?:without|with\s+no|no)\s+(?:a\s+|any\s+)?(?:space|spaces|gap|separator)\b|\bdirectly\b|\+/i.test(raw);
  if (plainJoin) work = work.replace(/\b(?:without|with\s+no|no)\s+(?:a\s+|any\s+)?(?:space|spaces|gap|separator)\b|\bdirectly\b/i, " ").replace(/\s+/g, " ").trim();
  const gapped = (expr: string, pre: boolean): string => {
    if (plainJoin) return expr;
    let text: unknown; try { text = JSON.parse(expr); } catch { return pre ? `${expr} & " "` : `" " & ${expr}`; }
    if (typeof text !== "string") return expr;
    const edge = pre ? text.slice(-1) : text.charAt(0);
    return text && /[\p{L}\p{N}]/u.test(edge) ? str(pre ? `${text} ` : ` ${text}`) : expr;
  };
  if ((m = find(String.raw`\b(?:add|put|insert|place)\s+${VAL}\s+(?:in\s+front(?:\s+of\s+it)?|before(?:\s+it)?|at\s+the\s+(?:start|beginning|front)|as\s+(?:a\s+)?prefix)\b(?:\s+(?:without|with\s+no|no)\s+(?:a\s+)?(?:space|gap))?|\bprefix\w*\s+(?:it\s+|@\d+@\s+)?(?:with|of|:)?\s*${VAL}|\b(?:start|begin)\w*\s+with\s+${VAL}`))) {
    const v = val(m[1] ?? m[2] ?? m[3] ?? "");
    if (v) { eat(m); cur = `${gapped(v.expr, true)} & ${/[&?]/.test(cur) ? `(${cur})` : cur}`; steps.push(`Put ${v.say} in front.`); acted = true; }
  }
  if ((m = find(String.raw`\b(?:add|put|insert|place|append)\s+${VAL}\s+(?:at\s+the\s+end|after(?:\s+it)?|behind(?:\s+it)?|as\s+(?:a\s+)?suffix|to\s+the\s+end)\b|\bsuffix\w*\s+(?:it\s+|@\d+@\s+)?(?:with|of|:)?\s*${VAL}|\bappend\s+${VAL}|\b(?:end|finish)\w*\s+with\s+${VAL}|\bfollowed\s+by\s+${VAL}`))) {
    const v = val(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "");
    if (v) { eat(m); cur = `${/[&?]/.test(cur) ? `(${cur})` : cur} & ${gapped(v.expr, false)}`; steps.push(`Put ${v.say} at the end.`); acted = true; }
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
    const loose = work.replace(/@\d+@/g, " ");
    if (/#\d+#|\d|[_\-\/|+*~@=<>%&]/.test(loose)) {
      const shown = loose.replace(/#(\d+)#/g, (_t, i: string) => str(quotes[Number(i)])).replace(/\s+/g, " ").trim();
      return fail(`${picked.map((p) => p.path).join(" and ")} was recognised, but not what to do with it ("${shown}"). Try one of the phrasings below, or write an expression.`);
    }
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
