import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compileInstruction, compileLocal, INSTRUCTION_EXAMPLES, SUGGESTION_TEMPLATES } from "../src/mapping/instruction.js";
import { checkExpr, evalExpr } from "../src/expr.js";
import type { HttpClient } from "../src/clients/http.js";

interface Case { instruction: string; target?: string; expr: string; confidence: string; value?: unknown }
const fx = JSON.parse(readFileSync(new URL("./fixtures/instructions.json", import.meta.url), "utf8")) as { sample: Record<string, unknown>; cases: Case[]; rejected: string[] };
const SAMPLE = fx.sample as never;
const run = (expr: string, input: unknown = fx.sample) => evalExpr(expr, { payload: input, input } as never);
const OWNER = "add the _ inbetween if name came as two words(customer.name)";
const OWNER_EXPR = '$count($split($trim(customer.name), /\\s+/)) = 2 ? $join($split($trim(customer.name), /\\s+/), "_") : customer.name';

describe("instruction compiler: the owner's rule", () => {
  it("compiles the sentence exactly as it was typed", async () => {
    const r = compileLocal({ instruction: OWNER, target: "first", sampleSource: SAMPLE });
    expect(r.ok).toBe(true);
    expect(r.compiled).toEqual({ expr: OWNER_EXPR, explanation: "If customer.name has exactly two words, join them with _, otherwise keep it as is", confidence: "exact", engine: "rules" });
    expect(await run(r.compiled!.expr)).toBe("John_Smith");
    expect(await run(r.compiled!.expr, { customer: { name: "Mary" } })).toBe("Mary");
    expect(await run(r.compiled!.expr, { customer: { name: "Anna Maria Lopez" } })).toBe("Anna Maria Lopez");
    expect(await run(r.compiled!.expr, { customer: { name: "  John   Smith " } })).toBe("John_Smith");
  });
  it("needs neither a sample nor a target", () => {
    expect(compileLocal({ instruction: OWNER }).compiled?.expr).toBe(OWNER_EXPR);
  });
  it.each([
    "if name came as two words add _ in between",
    "put an underscore between the words if the name has two words (customer.name)",
    "when the name is two words join them with an underscore, otherwise leave it",
    "replace space with _ only if the name has exactly 2 words (customer.name)",
    "add the _ inbetween if name came as two wrods (customer.name)",
    "add the _ inbetwen if nmae came as two words (customer.name)",
  ])("understands the same rule said another way: %s", (instruction) => {
    expect(compileLocal({ instruction, target: "first", sampleSource: SAMPLE }).compiled?.expr).toBe(OWNER_EXPR);
  });
});

describe("instruction compiler: library of phrasings", () => {
  it("has a broad set of reviewed phrasings", () => { expect(fx.cases.length).toBeGreaterThan(200); });
  it.each(fx.cases.map((c) => [c.instruction, c] as const))("%s", async (_name, c) => {
    const r = compileLocal({ instruction: c.instruction, target: c.target, sampleSource: SAMPLE });
    expect(r.ok).toBe(true);
    expect(r.compiled!.expr).toBe(c.expr);
    expect(r.compiled!.confidence).toBe(c.confidence);
    expect(r.compiled!.engine).toBe("rules");
    expect(r.compiled!.explanation.length).toBeGreaterThan(5);
    expect(checkExpr(r.compiled!.expr)).toBeNull();
    if ("value" in c) expect(await run(c.expr)).toEqual(c.value);
  });
  it("gives the expected values for everyday rules", async () => {
    const want: [string, unknown][] = [
      ["convert to upper case (customer.name)", "JOHN SMITH"],
      ["uppercase the first two characters of customer.name", "JO"],
      ["upper case of the first two characters (customer.name)", "JO"],
      ["lowercase the last word of customer.name", "smith"],
      ["first name and last name joined with a space", "john smith"],
      ["add a hyphen between first name and last name", "john-smith"],
      ["the phone number without spaces and dashes", "+966501234567"],
      ["if status is not CANCELLED then total otherwise 0", 1234.567],
      ["when the status is CONFIRMED send 1 else send 0", 1],
      ["INV- plus invoice number padded to 6 digits", "INV-000421"],
      ["difference between check out and check in in days", 7],
      ["for gender, M becomes Male and F becomes Female", "Male"],
      ["if the email is not provided put \"no-email@example.com\"", "John.Smith@Example.com"],
      ["count the lines whose status is cancelled", 1],
      ["unit price multiplied by the quantity, to 2 decimals", 59.97],
      ["order date formatted as \"dd-MMM-yyyy\"", "09-Mar-2026"],
    ];
    for (const [instruction, value] of want) {
      const r = compileLocal({ instruction, sampleSource: SAMPLE });
      expect(r.ok, instruction).toBe(true);
      expect(await run(r.compiled!.expr), instruction).toEqual(value);
    }
  });
});

describe("instruction compiler: never a silent guess", () => {
  it.each(fx.rejected)("does not pretend to understand: %s", (instruction) => {
    const r = compileLocal({ instruction, sampleSource: SAMPLE });
    expect(r.ok).toBe(false);
    expect(r.compiled).toBeNull();
    expect(r.reason && r.reason.length > 10).toBe(true);
    expect(Array.isArray(r.understood)).toBe(true);
    expect(r.suggestions.length).toBeGreaterThan(0);
    for (const s of r.suggestions) expect(compileLocal({ instruction: s, sampleSource: SAMPLE }, { suggest: false }).ok, s).toBe(true);
  });
  it("says which field it found and what it could not read", () => {
    const r = compileLocal({ instruction: "fix the name", sampleSource: SAMPLE });
    expect(r.ok).toBe(false);
    expect(r.understood.join(" ")).toContain("customer.name");
    expect(r.reason).toContain("fix");
  });
  it("asks for the field when none is named", () => {
    const r = compileLocal({ instruction: "convert to upper case" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/which input field/);
  });
  it("marks corrected typos as a guess and says what it read", () => {
    const r = compileLocal({ instruction: "convert to uper case (customer.name)", sampleSource: SAMPLE });
    expect(r.compiled).toMatchObject({ expr: "$uppercase(customer.name)", confidence: "guessed" });
    expect(r.compiled!.explanation).toMatch(/uper/);
  });
  it("rejects empty and over-long text", () => {
    expect(compileLocal({ instruction: "   " }).ok).toBe(false);
    expect(compileLocal({ instruction: "x ".repeat(400) }).ok).toBe(false);
  });
  it("accepts text that is already an expression as written", () => {
    const r = compileLocal({ instruction: "$uppercase(customer.name) & '-' & order.id", sampleSource: SAMPLE });
    expect(r.compiled).toMatchObject({ expr: "$uppercase(customer.name) & '-' & order.id", confidence: "exact" });
  });
});

describe("instruction compiler: examples and suggestions", () => {
  it("every catalogue example compiles without a sample", () => {
    expect(INSTRUCTION_EXAMPLES.length).toBeGreaterThanOrEqual(20);
    for (const ex of INSTRUCTION_EXAMPLES) { const r = compileLocal({ instruction: ex }); expect(r.ok, ex).toBe(true); expect(checkExpr(r.compiled!.expr), ex).toBeNull(); }
  });
  it("every suggestion template compiles once its fields are filled in", () => {
    for (const t of SUGGESTION_TEMPLATES) {
      const s = t.replace(/\{f\}/g, "customer.name").replace(/\{a\}/g, "order.lines").replace(/\{g\}/g, "customer.email");
      expect(compileLocal({ instruction: s }, { suggest: false }).ok, s).toBe(true);
    }
  });
  it("examples carry no customer or estate names", () => {
    expect(INSTRUCTION_EXAMPLES.join(" ")).not.toMatch(/aroya|cruise|saudi|seaware|wso2/i);
  });
});

describe("instruction compiler: optional in-estate model", () => {
  const fake = (reply: unknown, calls: { url: string; body: string }[] = []) => ({
    calls,
    http: { request: async (c: { url: string; body?: string | Buffer }) => { calls.push({ url: c.url, body: String(c.body) }); return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(reply)), ms: 1 }; } } as unknown as HttpClient,
  });
  it("is not consulted when the rules understand the sentence", async () => {
    const f = fake({ expr: "1" });
    const r = await compileInstruction({ instruction: OWNER, sampleSource: SAMPLE }, { modelUrl: "http://model.internal/compile", http: f.http });
    expect(r.compiled?.engine).toBe("rules"); expect(f.calls.length).toBe(0);
  });
  it("is never called when MODEL_URL is unset", async () => {
    const f = fake({ expr: "1" });
    const r = await compileInstruction({ instruction: "make it nice", sampleSource: SAMPLE }, { modelUrl: "", http: f.http });
    expect(r.ok).toBe(false); expect(f.calls.length).toBe(0);
  });
  it("answers after the rules fail, labelled as a guess, and receives no sample values", async () => {
    const f = fake({ expr: "$uppercase(customer.name)", explanation: "Upper-case the name" });
    const r = await compileInstruction({ instruction: "make it nice", target: "first", sampleSource: SAMPLE }, { modelUrl: "http://model.internal/compile", http: f.http });
    expect(r.compiled).toEqual({ expr: "$uppercase(customer.name)", explanation: "Upper-case the name", confidence: "guessed", engine: "in-estate-model" });
    expect(f.calls[0].url).toBe("http://model.internal/compile");
    const sent = JSON.parse(f.calls[0].body) as { fields: { path: string }[]; instruction: string };
    expect(sent.fields.some((x) => x.path === "customer.name")).toBe(true);
    for (const secretish of ["John Smith", "4111111111111111", "John.Smith@Example.com", "+966"]) expect(f.calls[0].body).not.toContain(secretish);
  });
  it("falls back to the rule outcome when the model returns something unusable", async () => {
    for (const reply of [{ expr: "$uppercase((" }, { nope: true }, "text"]) {
      const r = await compileInstruction({ instruction: "make it nice", sampleSource: SAMPLE }, { modelUrl: "http://model.internal/compile", http: fake(reply).http });
      expect(r.ok).toBe(false); expect(r.suggestions.length).toBeGreaterThan(0);
    }
    const broken = { request: async () => { throw new Error("down"); } } as unknown as HttpClient;
    expect((await compileInstruction({ instruction: "make it nice", sampleSource: SAMPLE }, { modelUrl: "http://model.internal/compile", http: broken })).ok).toBe(false);
  });
});
