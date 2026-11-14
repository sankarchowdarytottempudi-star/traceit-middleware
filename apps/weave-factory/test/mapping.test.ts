import { describe, it, expect } from "vitest";
import { applyMapping, diffMapping, flattenPaths, compileToArtifact, ruleLabel, type MappingRule } from "../src/lib/mapping";

describe("applyMapping", () => {
  it("applies direct, expr and const rules", () => {
    const rules: MappingRule[] = [
      { target: "ref", kind: "direct", source: "customer.ref" },
      { target: "first", kind: "expr", expr: "firstWord(customer.name)" },
      { target: "channel", kind: "const", expr: '"web"' },
    ];
    const out = applyMapping(rules, { customer: { ref: "C1", name: "Jane Doe" } });
    expect(out).toEqual({ ref: "C1", first: "Jane", channel: "web" });
  });
});
describe("diffMapping", () => {
  it("flags mismatched fields only", () => {
    const d = diffMapping({ a: 1, b: 2 }, { a: 1, b: 3 });
    expect(d).toEqual([{ path: "b", produced: 2, desired: 3 }]);
  });
});
describe("flattenPaths + ruleLabel + compile", () => {
  it("flattens nested paths", () => { expect(flattenPaths({ a: { b: 1 } })).toEqual(["a.b"]); });
  it("labels rules readably", () => { expect(ruleLabel({ target: "x", kind: "direct", source: "y" })).toBe("x ← y"); });
  it("compiles to a WSO2 payloadFactory artifact", () => {
    const art = compileToArtifact([{ target: "ref", kind: "direct", source: "customer.ref" }], { name: "t" });
    expect(art).toContain("payloadFactory"); expect(art).toContain("ref");
  });
});
