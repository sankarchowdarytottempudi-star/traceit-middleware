import { describe, it, expect } from "vitest";
import { HeuristicInferrer } from "../src/inference";

const inf = new HeuristicInferrer();
describe("by-example mapping inference (stub, in-estate)", () => {
  it("maps exact value matches to direct rules", async () => {
    const { rules } = await inf.infer({ sampleSource: { customer: { ref: "C1", email: "a@x.com" } }, desiredOutput: { ref: "C1", email: "a@x.com" } });
    expect(rules).toEqual(expect.arrayContaining([
      { target: "ref", kind: "direct", source: "customer.ref" },
      { target: "email", kind: "direct", source: "customer.email" },
    ]));
  });
  it("flags fields with no source match as needing the model", async () => {
    const { rules, needsModel } = await inf.infer({ sampleSource: { a: 1 }, desiredOutput: { total: 999 } });
    expect(needsModel).toBe(true);
    expect(rules[0]).toMatchObject({ target: "total", kind: "const" });
  });
  it("reports the engine so the UI can note when the in-estate model is needed", async () => {
    const r = await inf.infer({ sampleSource: {}, desiredOutput: {} });
    expect(r.engine).toBe("heuristic");
  });
});
