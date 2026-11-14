// Pure data-mapping core for the by-example mapper. No network, no eval. The by-example INFERENCE
// runs in the BFF (in-estate); this file applies/diffs/compiles the resulting rules so the UI can
// show readable rules + a live preview, and compile to a WSO2 artifact.
export interface MappingRule { target: string; kind: "direct" | "expr" | "const"; source?: string; expr?: string; note?: string; }

export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}
function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split("."); const last = parts.pop()!;
  let cur = obj;
  for (const p of parts) { if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {}; cur = cur[p] as Record<string, unknown>; }
  cur[last] = value;
}
export function flattenPaths(obj: unknown, prefix = ""): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return prefix ? [prefix] : [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v) ? flattenPaths(v, p) : [p];
  });
}

function evalExpr(expr: string, source: unknown): unknown {
  const m = expr.match(/^(\w+)\((.+)\)$/);
  if (!m) return getPath(source, expr.trim());
  const [, fn, arg] = m;
  const v = getPath(source, arg.trim());
  const s = v == null ? "" : String(v);
  switch (fn) {
    case "firstWord": return s.split(/\s+/)[0];
    case "lower": return s.toLowerCase();
    case "upper": return s.toUpperCase();
    case "trim": return s.trim();
    default: return v;
  }
}

export function applyMapping(rules: MappingRule[], source: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rules) {
    if (r.kind === "direct" && r.source) setPath(out, r.target, getPath(source, r.source));
    else if (r.kind === "expr" && r.expr) setPath(out, r.target, evalExpr(r.expr, source));
    else if (r.kind === "const" && r.expr !== undefined) { try { setPath(out, r.target, JSON.parse(r.expr)); } catch { setPath(out, r.target, r.expr); } }
  }
  return out;
}

export interface Mismatch { path: string; produced: unknown; desired: unknown; }
export function diffMapping(produced: unknown, desired: unknown): Mismatch[] {
  const paths = new Set([...flattenPaths(produced), ...flattenPaths(desired)]);
  const out: Mismatch[] = [];
  for (const p of paths) {
    const a = getPath(produced, p); const b = getPath(desired, p);
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: p, produced: a, desired: b });
  }
  return out;
}

export function ruleLabel(r: MappingRule): string {
  if (r.kind === "direct") return `${r.target} ← ${r.source}`;
  if (r.kind === "expr") return `${r.target} ← ${r.expr}`;
  return `${r.target} = ${r.expr} (constant)`;
}

/** Compile rules to a WSO2 artifact (MI PayloadFactory-style). First pass: a readable mapping
 * snippet; the full connector/mediator catalog generation is the later phase (seam). */
export function compileToArtifact(rules: MappingRule[], opts: { name?: string } = {}): string {
  const lines = rules.map((r) => {
    if (r.kind === "direct") return `  "${r.target}": "$ctx:source.${r.source}"`;
    if (r.kind === "expr") return `  "${r.target}": "{{${r.expr}}}"`;
    return `  "${r.target}": ${r.expr}`;
  });
  return `<!-- Weave Factory generated mapping: ${opts.name ?? "transform"} (WSO2 MI payloadFactory). -->\n` +
    `<payloadFactory media-type="json">\n <format>{\n${lines.join(",\n")}\n }</format>\n</payloadFactory>`;
}
