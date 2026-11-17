// "WEB means Web, MOBILE means Mobile App, anything else Other (header x-channel)": a table of codes and the
// values they stand for, read by a strict rule shared by the flow engine's interpreter and the Factory's
// fallback rules. A value runs from "means" up to the next comma, "and" or the end, so values of several
// words are kept whole. The source must be named: "(header NAME)", "(the NAME header)", "(FIELD)",
// "FIELD:" or "translate FIELD". When any part cannot be read the sentence is NOT understood (with the
// reason and phrasings that work); it is never handed on to be guessed.

export type ValueTableOutcome =
  | { ok: true; expr: string; explanation: string; source: { kind: "header" | "field"; name: string }; entries: [string, string][]; ignoreCase: boolean }
  | { ok: false; reason: string; suggestions: string[] };

const ARROW = /\s+(?:means|mean|stands for|stand for|becomes|become|maps to|map to|is mapped to|translates to|turns into)\s+|\s*(?:->|=>|→)\s*/i;
const DEFAULT = /^(?:anything else|everything else|all others?|any other value|others?|otherwise|else|default)\b\s*(?:means|becomes|is|gives|use|=|->|=>|→|:)?\s*(.*)$/i;
const KEEP = /^(?:keep(?: it)?(?: as (?:it )?is| unchanged)?|as (?:it )?is|unchanged|itself|stays? the same)$/i;
const PATH = /^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*|\[\d+\])*$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const VALUE_TABLE_EXAMPLES = [
  "WEB means Web, MOBILE means Mobile App, anything else Other (header x-channel)",
  "M means Male, F means Female, anything else Unknown (customer.gender)",
  "\"A\" means \"Active\", \"I\" means \"Inactive\" (data.status) ignoring case",
];

const seg = (k: string) => (IDENT.test(k) ? k : "`" + k.replace(/`/g, "") + "`");
const pathExpr = (p: string) => p.split(".").map((s) => { const m = /^(.*?)((?:\[\d+\])*)$/.exec(s)!; return seg(m[1]) + m[2]; }).join(".");
const q = (s: string) => JSON.stringify(s);
const unq = (s: string) => { const t = s.trim(); return /^"[^"]*"$/.test(t) || /^'[^']*'$/.test(t) ? t.slice(1, -1) : null; };

function mask(s: string): string { let out = "", inQ = false; for (const ch of s) { if (ch === "\"") { inQ = !inQ; out += ch; } else out += inQ ? "\u0001" : ch; } return out; }
function splitOutside(s: string, re: RegExp): string[] {
  const m = mask(s); const parts: string[] = []; let last = 0;
  for (const x of m.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) { parts.push(s.slice(last, x.index)); last = (x.index ?? 0) + x[0].length; }
  parts.push(s.slice(last)); return parts;
}

/** null: the sentence is not a table of codes at all (other rules may read it). */
export function readValueTable(instruction: string): ValueTableOutcome | null {
  let t = String(instruction ?? "").replace(/\s+/g, " ").trim().replace(/[“”]/g, "\"");
  const arrows = splitOutside(t, ARROW).length - 1;
  if (arrows < 2) return null;
  let ignoreCase = false;
  const ci = /[\s,;]*\b(?:ignoring (?:the )?(?:letter )?case|ignore (?:the )?case|case[- ]insensitive(?:ly)?|in any (?:letter )?case|any letter case|whatever the case)\b[\s,;]*/i;
  if (ci.test(t)) { ignoreCase = true; t = t.replace(ci, " ").trim(); }
  // the source
  let source: { kind: "header" | "field"; name: string } | null = null;
  let m: RegExpExecArray | null;
  const tail = /\s*\(\s*(?:(?:from |in |of )?the\s+)?(?:(?:request\s+)?header\s+"?([\w-]+)"?|"?([\w-]+)"?\s+(?:request\s+)?header|(?:field\s+)?([A-Za-z_][\w.\-[\]]*))\s*\)\s*$/i;
  if ((m = tail.exec(t))) {
    source = m[1] || m[2] ? { kind: "header", name: (m[1] || m[2]).toLowerCase() } : PATH.test(m[3]) ? { kind: "field", name: m[3] } : null;
    t = t.slice(0, m.index).trim();
  } else if ((m = /\s*,?\s*(?:for|from|in|of) (?:the )?(?:(?:request )?header "?([\w-]+)"?|"?([\w-]+)"? header)\s*$/i.exec(t))) {
    source = { kind: "header", name: (m[1] || m[2]).toLowerCase() }; t = t.slice(0, m.index).trim();
  } else if ((m = /^(?:translate|map|decode|look ?up)\s+(?:the\s+)?(?:(?:request\s+)?header\s+"?([\w-]+)"?|"?([\w-]+)"?\s+header|([A-Za-z_][\w.\-[\]]*))\s*[:,]?\s+/i.exec(t)) && !ARROW.test(t.slice(0, m[0].length))) {
    source = m[1] || m[2] ? { kind: "header", name: (m[1] || m[2]).toLowerCase() } : PATH.test(m[3]) ? { kind: "field", name: m[3] } : null; t = t.slice(m[0].length).trim();
  } else if ((m = /^(?:(?:request\s+)?header\s+"?([\w-]+)"?|([A-Za-z_][\w.\-[\]]*))\s*:\s+/i.exec(t)) && !ARROW.test(m[0])) {
    source = m[1] ? { kind: "header", name: m[1].toLowerCase() } : PATH.test(m[2]) ? { kind: "field", name: m[2] } : null; t = t.slice(m[0].length).trim();
  }
  const fail = (reason: string): ValueTableOutcome => ({ ok: false, reason, suggestions: VALUE_TABLE_EXAMPLES });
  if (!source) return fail("Say where the codes come from, in brackets at the end: (header x-channel) for a request header, or (data.channel) for a field. The source is never guessed from the codes.");
  t = t.replace(/^(?:translate|map|decode)\s*:?\s*/i, "").replace(/[.;]\s*$/, "");
  const chunks = splitOutside(t, /\s*[;,]\s*(?:and\s+|or\s+)?|\s+and\s+(?=(?:"[^"]*"|[\w/.-]+)\s*(?:means|mean|stands for|becomes|maps to|->|=>|→|=)|anything else|everything else|otherwise|else|others?)/i).map((x) => x.trim()).filter(Boolean);
  const entries: [string, string][] = [];
  let dflt: string | null = null, keep = false;
  for (const c of chunks) {
    const d = DEFAULT.exec(c);
    if (d) {
      if (dflt !== null || keep) return fail(`"${c}": a second "anything else" was not expected.`);
      const v = d[1].trim();
      if (!v || KEEP.test(v)) { keep = true; continue; }
      dflt = unq(v) ?? v; continue;
    }
    const parts = splitOutside(c, ARROW);
    if (parts.length !== 2) return fail(`"${c}" is not read as CODE means VALUE. Write each pair as CODE means VALUE, separated by commas.`);
    const kRaw = parts[0].trim().replace(/^(?:and|or|if|when)\s+/i, "");
    const key = unq(kRaw) ?? (/^[\w/.+-]+$/.test(kRaw) ? kRaw : null);
    if (key === null || key === "") return fail(`"${kRaw}" is not one code. Put a code of several words in quotes.`);
    const vRaw = parts[1].trim();
    const val = unq(vRaw) ?? vRaw;
    if (!val || /[(){}[\]]/.test(val)) return fail(`The value for "${key}" was not read. Write it after "means", or put it in quotes.`);
    if (entries.some(([k]) => (ignoreCase ? k.toLowerCase() === key.toLowerCase() : k === key))) return fail(`"${key}" appears twice.`);
    entries.push([key, val]);
  }
  if (entries.length < 2) return fail("A table needs at least two pairs written as CODE means VALUE.");
  const upperCodes = entries.every(([k]) => k === k.toUpperCase() && /[A-Z]/.test(k));
  // a request header's codes are compared in any letter case when they are written in capitals
  if (source.kind === "header" && upperCodes) ignoreCase = true;
  const raw = source.kind === "header" ? `$request.headers.${q(source.name)}` : pathExpr(source.name);
  const norm = ignoreCase ? (upperCodes || !entries.every(([k]) => k === k.toLowerCase()) ? "$uppercase" : "$lowercase") : "";
  const keyOf = (k: string) => (norm === "$uppercase" ? k.toUpperCase() : norm === "$lowercase" ? k.toLowerCase() : k);
  const otherwise = dflt !== null ? q(dflt) : raw;   // anything else keeps the original value (and its type)
  const expr = `( $v := ${norm ? `${norm}($string(${raw}))` : `$string(${raw})`}; ${entries.map(([k, v]) => `$v = ${q(keyOf(k))} ? ${q(v)}`).join(" : ")} : ${otherwise} )`;
  const where = source.kind === "header" ? `the request header ${source.name}` : source.name;
  const explanation = `Translate ${where}${ignoreCase ? " (any letter case)" : ""}: ${entries.map(([k, v]) => `${k} becomes "${v}"`).join(", ")}; anything else ${dflt !== null ? `becomes "${dflt}"` : "is kept as it is"}`;
  return { ok: true, expr, explanation, source, entries, ignoreCase };
}
