// By-example mapping inference behind a clean interface. Wire `model` to the in-estate LLM when
// available (MODEL_URL); otherwise a deterministic heuristic stub runs so the feature works and is
// testable. The stub does NOT call any external AI. Sample data stays in the estate either way.
export interface MappingRule { target: string; kind: "direct" | "expr" | "const"; source?: string; expr?: string; note?: string; }
export interface InferInput { sampleSource: unknown; desiredOutput: unknown; }
export interface Inferrer { infer(input: InferInput): Promise<{ rules: MappingRule[]; engine: string; needsModel: boolean }>; }

function flatten(obj: unknown, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v, p));
      else out[p] = v;
    }
  } else if (prefix) { out[prefix] = obj; }
  return out;
}

/** Heuristic inference: match each desired leaf to a source leaf by equal value, else a simple
 * transform (first word / lower / upper), else a constant. Good for the obvious cases; complex or
 * natural-language transforms need the in-estate model. */
export class HeuristicInferrer implements Inferrer {
  async infer({ sampleSource, desiredOutput }: InferInput) {
    const src = flatten(sampleSource); const want = flatten(desiredOutput);
    const rules: MappingRule[] = [];
    let needsModel = false;
    for (const [tPath, tVal] of Object.entries(want)) {
      const exact = Object.keys(src).find((s) => src[s] === tVal);
      if (exact) { rules.push({ target: tPath, kind: "direct", source: exact }); continue; }
      const strMatch = typeof tVal === "string" ? Object.keys(src).find((s) =>
        typeof src[s] === "string" && (src[s] as string).toLowerCase().includes((tVal as string).toLowerCase()) && (tVal as string).length > 0) : undefined;
      if (strMatch) { rules.push({ target: tPath, kind: "expr", source: strMatch, expr: `firstWord(${strMatch})`, note: "guessed transform; confirm with the preview" }); needsModel = true; continue; }
      rules.push({ target: tPath, kind: "const", expr: JSON.stringify(tVal), note: "no source match found; set a mapping or provide another example" });
      needsModel = true;
    }
    return { rules, engine: "heuristic", needsModel };
  }
}

export function createInferrer(modelUrl?: string): Inferrer {
  // Seam: when the in-estate model is available, return a model-backed Inferrer here.
  // if (modelUrl) return new ModelInferrer(modelUrl);
  void modelUrl;
  return new HeuristicInferrer();
}
