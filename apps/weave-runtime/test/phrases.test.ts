import { describe, expect, it } from "vitest";
import { MAPPING_PHRASES, MAPPING_PHRASE_SAMPLE } from "@traceit/weave-flow";
import { compileLocal } from "../src/mapping/instruction.js";
import { applyMapping, exprRefs } from "../src/mapping/apply.js";
import { evalExpr } from "../src/expr.js";

const run = (expr: string, input: unknown = MAPPING_PHRASE_SAMPLE) => evalExpr(expr, { payload: input, input } as never);

describe("'What you can write': every listed phrase compiles to the listed expression and result", () => {
  it.each(MAPPING_PHRASES.map((p) => [p.example, p] as const))("%s", async (_e, p) => {
    const r = compileLocal({ instruction: p.example, target: "out", sampleSource: MAPPING_PHRASE_SAMPLE });
    expect(r.ok, r.reason).toBe(true);
    expect(r.compiled!.expr).toBe(p.expr);
    expect(r.compiled!.confidence).toBe("exact");
    expect((await run(p.expr)) ?? null).toEqual(p.value);
  });
  it("covers every group the owner asked for", () => {
    const groups = new Set(MAPPING_PHRASES.map((p) => p.group));
    for (const g of ["Text in front or behind", "Conditions", "When there is no value", "Lists", "Text", "Dates", "Numbers", "Types", "Lookup", "Objects"]) expect(groups.has(g)).toBe(true);
  });
});

describe("text in front or behind: one space for a word, none for separators, + or 'without a space'", () => {
  const S = { data: { email: "a@example.invalid", channel: "web" } };
  it("the owner's sentence gives \"New web\"", async () => {
    const r = compileLocal({ instruction: 'add "New" before data.channel value', target: "channel", sampleSource: S });
    expect(r.compiled?.expr).toBe('"New " & data.channel');
    expect(r.compiled?.confidence).toBe("exact");
    expect(await run(r.compiled!.expr, S)).toBe("New web");
  });
  it.each([
    ['add "New" after data.channel', "web New"],
    ['put "New" in front of data.channel', "New web"],
    ['prefix data.channel with "New"', "New web"],
    ['suffix data.channel with "Online"', "web Online"],
    ['prefix data.channel with "CH-"', "CH-web"],
    ['suffix data.channel with "/x"', "web/x"],
    ['add "New" before data.channel without a space', "Newweb"],
    ['add "x" after data.channel directly', "webx"],
    ['"New" + data.channel', "Newweb"],
  ])("%s -> %s", async (instruction, want) => {
    const r = compileLocal({ instruction, target: "channel", sampleSource: S });
    expect(r.ok, r.reason).toBe(true);
    expect(await run(r.compiled!.expr, S)).toBe(want);
  });
  it("is the same without a sample", () => {
    expect(compileLocal({ instruction: 'add "New" before data.channel value' }).compiled?.expr).toBe('"New " & data.channel');
  });
});

describe("conditions that were wrong or not understood before", () => {
  const S = { data: { qty: 3, status: "A" } };
  it("'less than or equal to' is <=", async () => {
    const r = compileLocal({ instruction: 'if data.qty is less than or equal to 3 then "small" otherwise "large"', sampleSource: S });
    expect(r.compiled?.expr).toBe('data.qty <= 3 ? "small" : "large"');
    expect(await run(r.compiled!.expr, { data: { qty: 4 } })).toBe("large");
  });
  it.each(['if data.status is one of "A", "B" then "y" otherwise "n"', 'if data.status is in "A" or "B" then "y" otherwise "n"'])("%s", (instruction) => {
    expect(compileLocal({ instruction, sampleSource: S }).compiled?.expr).toBe('data.status in ["A", "B"] ? "y" : "n"');
  });
  it("text that is not understood says so with phrasings to try, never a guess", () => {
    const r = compileLocal({ instruction: "do the usual thing with it (data.status)", sampleSource: S });
    expect(r.ok).toBe(false);
    expect(r.suggestions.length).toBeGreaterThan(0);
  });
});

describe("output shapes", () => {
  const src = { order: { id: "o1", lines: [{ sku: "A", qty: 2 }, { sku: "B", qty: 1 }] } };
  const rules = [
    { id: "r1", target: "code", kind: "direct" as const, source: "item.sku" },
    { id: "r2", target: "order", kind: "expr" as const, expr: "parent.order.id" },
    { id: "r3", target: "n", kind: "expr" as const, expr: "index + 1" },
  ];
  it("object is the default (older mappings)", async () => {
    const r = await applyMapping({ rules: [{ id: "a", target: "id", kind: "direct", source: "order.id" }] }, src, { payload: src });
    expect(r.output).toEqual({ id: "o1" });
  });
  it("each: one object per item, with the item, the parent and the index", async () => {
    const r = await applyMapping({ rules, shape: { kind: "each", each: "order.lines" } }, src, { payload: src });
    expect(r.output).toEqual([{ code: "A", order: "o1", n: 1 }, { code: "B", order: "o1", n: 2 }]);
  });
  it("values per item, values of the rules, a single value, and wrap", async () => {
    expect((await applyMapping({ rules: [rules[0]], shape: { kind: "values", each: "order.lines" } }, src, { payload: src })).output).toEqual(["A", "B"]);
    expect((await applyMapping({ rules: [{ id: "x", target: "", kind: "expr", expr: "order.id" }, { id: "y", target: "", kind: "const", value: 5 }], shape: { kind: "values" } }, src, { payload: src })).output).toEqual(["o1", 5]);
    expect((await applyMapping({ rules: [{ id: "x", target: "", kind: "expr", expr: "$count(order.lines)" }], shape: { kind: "value" } }, src, { payload: src })).output).toBe(2);
    expect((await applyMapping({ rules, shape: { kind: "each", each: "order.lines", wrap: "result.lines" } }, src, { payload: src })).output).toEqual({ result: { lines: [{ code: "A", order: "o1", n: 1 }, { code: "B", order: "o1", n: 2 }] } });
  });
  it("each over a missing list gives an empty list and says why", async () => {
    const r = await applyMapping({ rules, shape: { kind: "each", each: "order.nothing" } }, src, { payload: src });
    expect(r.output).toEqual([]);
    expect(r.rules[0].warning).toMatch(/has no items/);
  });
});

describe("a field the rule reads is not in the sample", () => {
  it("is reported instead of looking fine", async () => {
    const spec = { rules: [{ id: "c", target: "channel", kind: "instruction" as const, instruction: 'add "New" before data.channel', compiled: { expr: '"New " & data.channel', explanation: "", confidence: "exact" as const, engine: "rules" as const } }] };
    const r = await applyMapping(spec, { data: { email: "a@example.invalid" } }, { payload: {} });
    expect(r.rules[0].missing).toEqual(["data.channel"]);
    expect(r.rules[0].warning).toMatch(/data\.channel is not in the input/);
  });
  it("reads field paths but not text, variables or functions", () => {
    expect(exprRefs('"a.b" & data.channel & $x.y & $substring(customer.name, 0, 1)')).toEqual(["data.channel", "customer.name"]);
  });
});
