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
  if (/^\s*[$({\["']/.test(t) && !/\s[a-z]+\s[a-z]+\s/i.test(t)) return false;
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
    else if (ruleProblem(r)) s.incomplete++;
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
