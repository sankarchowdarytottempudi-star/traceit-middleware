// Pure helpers for the mapper. No React, no network.
import type { Json, MappingRule, MappingSpec } from "@traceit/weave-flow";
import { newId, ruleProblem } from "./graph.ts";

export type RuleKind = MappingRule["kind"];
export const KIND_LABEL: Record<RuleKind, string> = { direct: "Copy a field", expr: "Expression", const: "Fixed value", instruction: "In your words" };

/** Leaf paths of a sample document ("customer.name", "items[0].sku"). Arrays contribute their first item. */
export function leafPaths(value: Json | undefined, base = "", out: string[] = [], depth = 0): string[] {
  if (value === undefined) return out;
  if (value === null || typeof value !== "object" || depth > 8) { if (base) out.push(base); return out; }
  if (Array.isArray(value)) {
    if (!value.length || value[0] === null || typeof value[0] !== "object") { if (base) out.push(base); return out; }
    return leafPaths(value[0], `${base}[0]`, out, depth + 1);
  }
  const keys = Object.keys(value);
  if (!keys.length && base) out.push(base);
  for (const k of keys) leafPaths(value[k], base ? `${base}.${seg(k)}` : seg(k), out, depth + 1);
  return out;
}
function seg(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : "`" + k + "`";
}
/** Reads a dot path from a sample (used for inline previews before the server answers). */
export function readPath(value: Json | undefined, path: string): Json | undefined {
  if (!path) return value;
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").map((p) => p.replace(/^`|`$/g, "")).filter(Boolean);
  let cur: unknown = value;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? cur[Number(p)] : (cur as Record<string, unknown>)[p];
  }
  return cur as Json | undefined;
}
/** A sensible output field name for an input path: "customer.first_name" -> "first_name". */
export function targetFromSource(path: string, taken: Iterable<string> = []): string {
  const last = path.replace(/\[\d+\]/g, "").split(".").pop()?.replace(/`/g, "") || "field";
  const set = new Set(taken);
  if (!set.has(last)) return last;
  const flat = path.replace(/\[\d+\]/g, "").replace(/`/g, "").split(".").join("_");
  if (!set.has(flat)) return flat;
  for (let i = 2; ; i++) if (!set.has(`${last}${i}`)) return `${last}${i}`;
}
export function newRule(kind: RuleKind, init: Partial<MappingRule> = {}): MappingRule {
  return { id: newId("r"), target: "", kind, ...init };
}
/** Whether text typed into an expression box reads like a sentence rather than an expression. */
export function looksLikeProse(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z'.,()_-]*$/.test(w));
  if (words.length < 3) return false;
  if (/^\s*[$({["']/.test(t) && !/\s[a-z]+\s[a-z]+\s/i.test(t)) return false;
  // real expressions are dense in operators and function calls
  const ops = (t.match(/\$[A-Za-z]+\(|[&|=<>*+?:]{1,2}|\bfunction\b/g) ?? []).length;
  return words.length >= 3 && ops <= 1;
}
/** Changing a rule's kind keeps what can be kept and drops what no longer applies. */
export function convertRule(r: MappingRule, kind: RuleKind): MappingRule {
  if (r.kind === kind) return r;
  const base: MappingRule = { id: r.id, target: r.target, kind, comment: r.comment, enabled: r.enabled };
  if (kind === "direct") return { ...base, source: r.source ?? "" };
  if (kind === "const") return { ...base, value: r.value ?? "" };
  if (kind === "expr") {
    const expr = r.kind === "instruction" ? r.compiled?.expr ?? "" : r.kind === "direct" ? r.source ?? "" : r.kind === "const" ? JSON.stringify(r.value ?? "") : "";
    return { ...base, expr };
  }
  return { ...base, instruction: r.kind === "expr" ? r.expr ?? "" : r.kind === "direct" && r.source ? `copy ${r.source}` : "", compiled: null };
}
export interface SpecStats { total: number; unresolved: number; incomplete: number; byKind: Record<RuleKind, number>; }
export function specStats(spec: MappingSpec): SpecStats {
  const s: SpecStats = { total: spec.rules.length, unresolved: 0, incomplete: 0, byKind: { direct: 0, expr: 0, const: 0, instruction: 0 } };
  for (const r of spec.rules) {
    s.byKind[r.kind] = (s.byKind[r.kind] ?? 0) + 1;
    if (r.enabled === false) continue;
    if (r.kind === "instruction" && !r.compiled?.expr) s.unresolved++;
    else if (ruleProblem(r, spec.shape?.kind)) s.incomplete++;
  }
  return s;
}
/** One-line description of what a rule does, for read-only lists. */
export function describeRule(r: MappingRule): string {
  if (r.kind === "direct") return r.source ? `copy of ${r.source}` : "(no input field chosen)";
  if (r.kind === "const") return `always ${JSON.stringify(r.value ?? "")}`;
  if (r.kind === "expr") return r.expr || "(no expression yet)";
  return r.compiled?.explanation || r.instruction || "(not described yet)";
}
export function showValue(v: unknown, max = 120): string {
  if (v === undefined) return "(nothing)";
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
  return s === undefined ? "(nothing)" : s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ---------------------------------------------------------------- the sample while it is being typed
/** Where JSON.parse gave up, as line and column (1-based), with the text of that line. */
export function jsonErrorAt(text: string, message: string): { line: number; column: number; lineText: string } | null {
  let pos = -1;
  const p = /position\s+(\d+)/i.exec(message);
  const lc = /line\s+(\d+)\s+column\s+(\d+)/i.exec(message);
  const lines = text.split("\n");
  if (lc) { const line = Number(lc[1]), column = Number(lc[2]); return { line, column, lineText: lines[line - 1] ?? "" }; }
  if (p) pos = Number(p[1]);
  else if (/unexpected end/i.test(message)) pos = text.length;
  if (pos < 0) return null;
  const before = text.slice(0, pos).split("\n");
  const line = before.length, column = before[before.length - 1].length + 1;
  return { line, column, lineText: lines[line - 1] ?? "" };
}
/** Repairs the slips people make when typing JSON by hand. Returns the corrected text and what was changed, or null
 *  when the text cannot be repaired this way (it is then left for the person to fix). */
export function fixJson(text: string): { text: string; changes: string[] } | null {
  try { JSON.parse(text); return null; } catch { /* repair below */ }
  const changes: string[] = [];
  let t = text;
  const smart = t.replace(/[“”„‟″]/g, '"').replace(/[‘’‚‛′]/g, "'");
  if (smart !== t) { changes.push("curly quotes replaced by straight ones"); t = smart; }
  // single-quoted keys and texts (outside double-quoted strings)
  const sq = t.replace(/"(?:[^"\\]|\\.)*"|'((?:[^'\\]|\\.)*)'/g, (m, inner: string | undefined) => (inner === undefined ? m : JSON.stringify(inner.replace(/\\'/g, "'"))));
  if (sq !== t) { changes.push("single quotes replaced by double quotes"); t = sq; }
  // a missing comma between two properties or two items: value at the end of a line, next line starts a key or a value
  const mc = t.replace(/("(?:[^"\\]|\\.)*"|\d|true|false|null|[}\]])(\s*\n\s*)(?=["{[\d-]|true|false|null)/g, (_m, a: string, gap: string) => `${a},${gap}`);
  if (mc !== t) { changes.push("missing comma added between two fields"); t = mc; }
  // a missing comma on one line: "a": "b" "c": ...
  const mc1 = t.replace(/("(?:[^"\\]|\\.)*"|\d|true|false|null|[}\]])(\s+)(?="(?:[^"\\]|\\.)*"\s*:)/g, (_m, a: string, gap: string) => `${a},${gap}`);
  if (mc1 !== t) { if (!changes.includes("missing comma added between two fields")) changes.push("missing comma added between two fields"); t = mc1; }
  const tc = t.replace(/,(\s*[}\]])/g, "$1");
  if (tc !== t) { changes.push("comma before a closing bracket removed"); t = tc; }
  try { JSON.parse(t); } catch { return null; }
  return changes.length ? { text: t, changes } : null;
}
/** Paths of the lists in a sample ("order.lines"), for "for each item of". */
export function arrayPaths(value: Json | undefined, base = "", out: string[] = [], depth = 0): string[] {
  if (value === null || value === undefined || typeof value !== "object" || depth > 8) return out;
  if (Array.isArray(value)) { if (base) out.push(base); const first = value.find((x) => x && typeof x === "object" && !Array.isArray(x)); if (first) arrayPaths(first as Json, base, out, depth + 1); return out; }
  for (const [k, v] of Object.entries(value)) arrayPaths(v as Json, base ? `${base}.${seg(k)}` : seg(k), out, depth + 1);
  return [...new Set(out)];
}
export type ShapeKind = NonNullable<MappingSpec["shape"]>["kind"];
export const SHAPE_LABEL: Record<ShapeKind, string> = { object: "One object", each: "A list of objects", values: "A list of values", value: "A single value" };
export const SHAPE_HINT: Record<ShapeKind, string> = {
  object: "Each rule fills one field of the output object.",
  each: "One object per item of a list in the input. Rules read the item as item.… (for example item.name), the whole input as parent.…, and the position as index.",
  values: "A list. With \"for each item of\", the first rule gives one value per item (read it as item.…); without it, every rule gives one value, in order.",
  value: "The output is the value of the first rule on its own (no field name needed).",
};
/** Rules of a list of values or a single value need no output field name. */
export const shapeNeedsTarget = (kind?: ShapeKind) => kind !== "values" && kind !== "value";
