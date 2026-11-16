// Executes a MappingSpec. Every rule is evaluated on its own: one failing rule never hides the
// others, and a rule is never silently skipped (an instruction that was not understood is an error).
import type { CompiledInstruction, Json, MappingRule, MappingSpec } from "@traceit/weave-flow";
import { evalExpr, checkExpr, type ExprScope } from "../expr.js";

export interface RuleResult { id: string; ok: boolean; value?: Json; error?: string; warning?: string; missing?: string[]; compiled?: CompiledInstruction; suggestions?: string[]; }
export type InstructionCompiler = (rule: MappingRule, source: unknown) => Promise<{ compiled: CompiledInstruction | null; reason?: string; suggestions: string[] }>;

type Seg = string | number;
export function parsePath(path: string): Seg[] {
  const out: Seg[] = [];
  let s = path.trim().replace(/^\$\.?/, "");
  const re = /^\.?(?:\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|\['((?:[^'\\]|\\.)*)'\]|`([^`]+)`|"((?:[^"\\]|\\.)*)"|([^.[\]]+))/;
  while (s.length) {
    const m = re.exec(s);
    if (!m) throw new Error(`Cannot read the path "${path}"`);
    if (m[1] !== undefined) out.push(Number(m[1]));
    else out.push((m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6]).trim());
    s = s.slice(m[0].length);
  }
  return out;
}
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of parsePath(path)) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === "number") { cur = Array.isArray(cur) ? cur[seg] : seg === 0 ? cur : undefined; continue; }
    if (Array.isArray(cur)) {
      const mapped = cur.flatMap((x) => { const v = x && typeof x === "object" ? (x as Record<string, unknown>)[seg] : undefined; return v === undefined ? [] : [v]; });
      cur = mapped.length ? mapped : undefined; continue;
    }
    cur = typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined;
  }
  return cur;
}
export function setPath(root: Record<string, unknown>, path: string, value: unknown) {
  const segs = parsePath(path);
  if (!segs.length) throw new Error("Target field is empty");
  if (typeof segs[0] === "number") throw new Error(`Target "${path}" must start with a field name`);
  let cur: Record<string | number, unknown> = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i], next = segs[i + 1];
    let child = cur[seg];
    if (child === null || child === undefined || typeof child !== "object") { child = typeof next === "number" ? [] : {}; cur[seg] = child; }
    cur = child as Record<string | number, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
}

const WORDY = /^[A-Za-z][A-Za-z']*(\s+[A-Za-z(][\w'().,_-]*){2,}/;

/** Dotted field paths an expression reads ("data.channel"), outside quotes and $variables. */
export function exprRefs(expr: string): string[] {
  const bare = expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/g, "//");
  const out: string[] = [];
  for (const m of bare.matchAll(/(?<![\w$.`\]])([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)(?![\w(])/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
/** The fields an expression reads that are not in the input (only checked when the input is an object). */
function missingRefs(expr: string, source: unknown): string[] {
  if (!source || typeof source !== "object") return [];
  return exprRefs(expr).filter((p) => { try { return getPath(source, p) === undefined; } catch { return false; } });
}
const noTarget = (kind?: string) => kind === "values" || kind === "value";

async function runRules(rules: MappingRule[], source: unknown, scope: ExprScope, compiler: InstructionCompiler | undefined, passthrough: boolean, needTarget: boolean):
  Promise<{ output: Record<string, unknown>; values: unknown[]; rules: RuleResult[] }> {
  const out: Record<string, unknown> = passthrough && source && typeof source === "object" && !Array.isArray(source)
    ? JSON.parse(JSON.stringify(source)) : {};
  const values: unknown[] = [];
  const results: RuleResult[] = [];
  const ruleScope: ExprScope = { ...scope, input: source };
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    const res: RuleResult = { id: rule.id, ok: true };
    let usedExpr = "";
    try {
      if (needTarget && (!rule.target || !String(rule.target).trim())) throw new Error("This rule has no target field");
      let value: unknown;
      switch (rule.kind) {
        case "const": value = rule.value; break;
        case "direct": {
          if (!rule.source || !rule.source.trim()) throw new Error("Choose the source field to copy");
          value = getPath(source, rule.source);
          if (value === undefined) res.warning = `No value: "${rule.source}" is not in the input`;
          break;
        }
        case "expr": {
          if (!rule.expr || !rule.expr.trim()) throw new Error("The expression is empty");
          const bad = checkExpr(rule.expr);
          if (bad) {
            throw new Error(WORDY.test(rule.expr.trim())
              ? `This is not a valid expression. It reads like plain words: switch the rule to "In my own words" so it can be interpreted. (${bad})`
              : bad);
          }
          usedExpr = rule.expr;
          value = await evalExpr(rule.expr, ruleScope);
          break;
        }
        case "instruction": {
          let compiled = rule.compiled && typeof rule.compiled.expr === "string" && rule.compiled.expr.trim() ? rule.compiled : null;
          if (!compiled) {
            if (!rule.instruction || !rule.instruction.trim()) throw new Error("Describe in your own words what this field should contain");
            const r = compiler ? await compiler(rule, source) : { compiled: null, suggestions: [] as string[], reason: undefined };
            if (!r.compiled) {
              res.suggestions = r.suggestions;
              throw new Error(`Not understood yet: "${rule.instruction}". ${r.reason ?? "Rephrase it or write an expression."}`);
            }
            compiled = r.compiled; res.compiled = compiled;
          }
          usedExpr = compiled.expr;
          try { value = await evalExpr(compiled.expr, ruleScope); }
          catch (e) {
            // The stored reading of the words fails on this input. Read the words again: a newer interpreter may read them
            // better (a rule about each item of a list, for one). The same reading again means the failure is real.
            const stored = compiled;
            const again = stored === rule.compiled && compiler && rule.instruction?.trim() ? await compiler(rule, source).catch(() => null) : null;
            if (!again?.compiled?.expr || again.compiled.expr === stored.expr) throw e;
            usedExpr = again.compiled.expr;
            value = await evalExpr(again.compiled.expr, ruleScope);
            res.compiled = again.compiled;
          }
          break;
        }
        default: throw new Error(`Unknown rule kind "${String((rule as { kind?: unknown }).kind)}"`);
      }
      // a field the rule reads is not in the input: the value is computed without it, which is rarely what was meant
      const missing = usedExpr ? missingRefs(usedExpr, source) : [];
      if (missing.length && !res.warning) { res.warning = `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in the input, so the result was made without ${missing.length === 1 ? "it" : "them"}`; res.missing = missing; }
      if (value === undefined) { if (!res.warning) res.warning = "The rule produced no value for this input, so the field is left out"; }
      else {
        if (needTarget || (rule.target && String(rule.target).trim())) setPath(out, rule.target || "value", value);
        values.push(value); res.value = value as Json;
      }
    } catch (e) {
      res.ok = false; res.error = (e as Error).message;
    }
    results.push(res);
  }
  return { output: out, values, rules: results };
}

export async function applyMapping(spec: MappingSpec | undefined, source: unknown, scope: ExprScope, compiler?: InstructionCompiler):
  Promise<{ output: Json; rules: RuleResult[] }> {
  const rules = Array.isArray(spec?.rules) ? spec!.rules : [];
  const shape = spec?.shape;
  const kind = shape?.kind ?? "object";
  const wrap = (v: unknown): Json => {
    const key = shape?.wrap && String(shape.wrap).trim();
    if (!key) return v as Json;
    const o: Record<string, unknown> = {}; setPath(o, key, v); return o as Json;
  };
  if ((kind === "each" || kind === "values") && shape?.each && String(shape.each).trim()) {
    const list = getPath(source, shape.each);
    const items = list === undefined || list === null ? [] : Array.isArray(list) ? list : [list];
    const out: unknown[] = []; const merged = new Map<string, RuleResult>(); let i = 0;
    for (const item of items) {
      const ctx = { item, parent: source, index: i };
      const r = await runRules(rules, ctx, { ...scope, item, index: i }, compiler, kind === "each" && !!spec?.passthrough && false, kind === "each");
      if (kind === "each") {
        const base = spec?.passthrough && item && typeof item === "object" && !Array.isArray(item) ? JSON.parse(JSON.stringify(item)) : {};
        out.push(Object.assign(base, r.output));
      } else out.push(r.values[0]);
      for (const res of r.rules) {
        const prev = merged.get(res.id);
        if (!prev || (prev.ok && !res.ok) || (!prev.warning && res.warning && prev.ok === res.ok)) merged.set(res.id, i === 0 || !prev ? res : { ...res, value: prev.value ?? res.value });
      }
      i++;
    }
    const results = [...merged.values()];
    if (!items.length) results.push(...rules.filter((r) => r && r.enabled !== false).map((r) => ({ id: r.id, ok: true, warning: `"${shape.each}" has no items in the input, so the list is empty` } as RuleResult)));
    return { output: wrap(out), rules: results };
  }
  const r = await runRules(rules, source, scope, compiler, kind === "object" && !!spec?.passthrough, !noTarget(kind));
  if (kind === "values") return { output: wrap(r.values), rules: r.rules };
  if (kind === "value") return { output: wrap(r.values[0] ?? null), rules: r.rules };
  return { output: wrap(r.output), rules: r.rules };
}

/** Compares a mapping result with the desired sample. */
export function diffJson(got: unknown, want: unknown, path = ""): { path: string; got: Json | undefined; want: Json | undefined }[] {
  const out: { path: string; got: Json | undefined; want: Json | undefined }[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (isObj(got) && isObj(want)) {
    for (const k of new Set([...Object.keys(got), ...Object.keys(want)])) out.push(...diffJson(got[k], want[k], path ? `${path}.${k}` : k));
  } else if (Array.isArray(got) && Array.isArray(want)) {
    for (let i = 0; i < Math.max(got.length, want.length); i++) out.push(...diffJson(got[i], want[i], `${path}[${i}]`));
  } else if (JSON.stringify(got) !== JSON.stringify(want)) {
    out.push({ path: path || "$", got: got as Json | undefined, want: want as Json | undefined });
  }
  return out.slice(0, 500);
}
