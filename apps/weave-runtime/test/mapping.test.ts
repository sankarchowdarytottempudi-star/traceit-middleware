import { describe, expect, it } from "vitest";
import type { MappingSpec, ValidationIssue } from "@traceit/weave-flow";
import { applyMapping, getPath, parsePath, setPath } from "../src/mapping/apply.js";
import { inferMapping } from "../src/mapping/infer.js";
import { compileLocal } from "../src/mapping/instruction.js";
import { validateMapping } from "../src/validate.js";
import { checkExpr, evalExpr } from "../src/expr.js";

const source = { customer: { name: "John Smith", email: "J@X.io" }, order: { id: "o-1", total: 10.5, lines: [{ sku: "A", qty: 2 }, { sku: "B", qty: 1 }] } };
const scope = { payload: source } as never;

describe("mapping paths", () => {
  it("reads and writes nested paths and indexes", () => {
    expect(parsePath("a.b[0].c")).toEqual(["a", "b", 0, "c"]);
    expect(getPath(source, "order.lines[1].sku")).toBe("B");
    const out: Record<string, unknown> = {}; setPath(out, "a.items[0].sku", "X"); setPath(out, "a.n", 1);
    expect(out).toEqual({ a: { items: [{ sku: "X" }], n: 1 } });
  });
});

describe("transform.map", () => {
  it("applies direct, expression, constant and compiled instruction rules", async () => {
    const compiled = compileLocal({ instruction: "add the _ inbetween if name came as two words(customer.name)", sampleSource: source as never }).compiled!;
    const spec: MappingSpec = { rules: [
      { id: "r1", target: "id", kind: "direct", source: "order.id" },
      { id: "r2", target: "contact.email", kind: "expr", expr: "$lowercase(customer.email)" },
      { id: "r3", target: "channel", kind: "const", value: "WEB" },
      { id: "r4", target: "first", kind: "instruction", instruction: "add the _ inbetween if name came as two words(customer.name)", compiled },
      { id: "r5", target: "off", kind: "const", value: 1, enabled: false },
    ] };
    const r = await applyMapping(spec, source, scope);
    expect(r.output).toEqual({ id: "o-1", contact: { email: "j@x.io" }, channel: "WEB", first: "John_Smith" });
    expect(r.rules.filter((x) => x.ok).map((x) => x.id)).toEqual(["r1", "r2", "r3", "r4"]);
  });
  it("reports a rule it cannot run by id and still evaluates the others (the field is never silently dropped)", async () => {
    const spec: MappingSpec = { rules: [
      { id: "ok1", target: "id", kind: "direct", source: "order.id" },
      { id: "words", target: "first", kind: "instruction", instruction: "make it nice" },
      { id: "broken", target: "x", kind: "expr", expr: "$number('abc')" },
      { id: "ok2", target: "total", kind: "expr", expr: "order.total * 2" },
    ] };
    const r = await applyMapping(spec, source, scope, async (rule) => { const o = compileLocal({ instruction: rule.instruction ?? "", sampleSource: source as never }); return { compiled: o.compiled, reason: o.reason, suggestions: o.suggestions }; });
    expect(r.output).toMatchObject({ id: "o-1", total: 21 });
    const words = r.rules.find((x) => x.id === "words")!; const broken = r.rules.find((x) => x.id === "broken")!;
    expect(words.ok).toBe(false); expect(words.error).toBeTruthy(); expect((words.suggestions ?? []).length).toBeGreaterThan(0);
    expect(broken.ok).toBe(false); expect(broken.error).toBeTruthy();
    expect(r.rules.find((x) => x.id === "ok2")!.ok).toBe(true);
  });
  it("an instruction with no compiled expression is a validation error on the flow", () => {
    const issues: ValidationIssue[] = [];
    validateMapping({ rules: [{ id: "r1", target: "first", kind: "instruction", instruction: "make it nice" }, { id: "r2", target: "ok", kind: "const", value: 1 }] }, "n1", issues);
    expect(issues.some((i) => i.level === "error" && /r1|first|instruction/i.test(JSON.stringify(i)))).toBe(true);
    expect(issues.filter((i) => i.level === "error").length).toBe(1);
  });
  it("passthrough starts from the input", async () => {
    const r = await applyMapping({ passthrough: true, rules: [{ id: "a", target: "extra", kind: "const", value: true }] }, { a: 1 }, { payload: { a: 1 } } as never);
    expect(r.output).toEqual({ a: 1, extra: true });
  });
});

describe("mapping inference", () => {
  const src = { customer: { firstName: "john", lastName: "smith", email: "John.Smith@Example.com", phone: "+966 50 123 4567", active: true, birthDate: "1990-05-17" },
    order: { id: "ord-7781", total: 1234.5, currency: "SAR", quantity: 3, lines: [{ sku: "A1", qty: 2, amount: 10.5 }, { sku: "B2", qty: 1, amount: 20 }] } };
  const want = { orderId: "ord-7781", guest: { fullName: "john smith", email: "john.smith@example.com", first: "JOHN", mobile: "966501234567", dob: "17/05/1990", active: "Y" },
    amountMinor: 123450, qty: "3", currencyCode: "SAR", channel: "WEB", items: [{ code: "A1", quantity: 2, amount: 10.5 }, { code: "B2", quantity: 1, amount: 20 }] };
  const rules = inferMapping(src as never, want as never);
  const by = (t: string) => rules.find((r) => r.target === t)!;
  it("proposes a rule for every target field, each with a confidence and a comment", () => {
    expect(rules.map((r) => r.target).sort()).toEqual(["amountMinor", "channel", "currencyCode", "guest.active", "guest.dob", "guest.email", "guest.first", "guest.fullName", "guest.mobile", "items", "orderId", "qty"]);
    for (const r of rules) { expect(r.confidence).toBeGreaterThan(0); expect(r.confidence).toBeLessThanOrEqual(1); expect(r.comment && r.comment.length > 5).toBe(true); if (r.kind === "expr") expect(checkExpr(r.expr!), r.target).toBeNull(); }
  });
  it("matches equal values and names", () => {
    expect(by("orderId")).toMatchObject({ kind: "direct", source: "order.id" });
    expect(by("currencyCode")).toMatchObject({ kind: "direct", source: "order.currency" });
    expect(by("orderId").confidence!).toBeGreaterThanOrEqual(0.9);
  });
  it("finds simple derived transforms", () => {
    expect(by("guest.email").expr).toBe("$lowercase(customer.email)");
    expect(by("guest.first").expr).toBe("$uppercase(customer.firstName)");
    expect(by("guest.fullName").expr).toBe('customer.firstName & " " & customer.lastName');
    expect(by("guest.mobile").expr).toBe("$digits(customer.phone)");
    expect(by("guest.dob").expr).toBe('$formatDate(customer.birthDate, "dd/MM/yyyy")');
    expect(by("guest.active").expr).toBe('customer.active ? "Y" : "N"');
    expect(by("amountMinor").expr).toBe("$toMinorUnits(order.total)");
    expect(by("qty").expr).toBe("$string(order.quantity)");
  });
  it("keeps a value it cannot explain as a low-confidence constant instead of losing the field", () => {
    expect(by("channel")).toMatchObject({ kind: "const", value: "WEB" });
    expect(by("channel").confidence!).toBeLessThan(0.5);
  });
  it("maps a list of objects item by item", async () => {
    expect(by("items").kind).toBe("expr");
    expect(await evalExpr(by("items").expr!, { payload: src } as never)).toEqual(want.items);
  });
  it("the proposed rules reproduce the wanted output", async () => {
    const r = await applyMapping({ rules }, src, { payload: src } as never);
    expect(r.output).toEqual(want);
  });
  it("returns nothing for a non-object target", () => { expect(inferMapping(src as never, "x" as never)).toEqual([]); });
  it("reads the words again when the stored reading fails, and reports the new reading", async () => {
    const src = { items: [{ name: "Canadian Dollar" }, { name: "Riyal" }] };
    const stale = { expr: '$count($split($trim(items.name), /\\s+/)) = 2 ? items.name : items.name', explanation: "old", confidence: "exact", engine: "rules" };
    const rules = [{ id: "r1", target: "names", kind: "instruction", instruction: "add the _ in between if name came as two words (items.name)", compiled: stale }];
    const compiler = async (rule: { instruction?: string }) => { const o = compileLocal({ instruction: rule.instruction ?? "", sampleSource: src as never }); return { compiled: o.compiled, reason: o.reason, suggestions: o.suggestions }; };
    const r = await applyMapping({ rules } as never, src, { payload: src } as never, compiler as never);
    expect(r.output).toEqual({ names: ["Canadian_Dollar", "Riyal"] });
    expect(r.rules[0].ok).toBe(true);
    expect(r.rules[0].compiled?.explanation).toMatch(/^For each item of items.name/);
    // without the words to read again, the failure is reported as before
    const plain = await applyMapping({ rules: [{ ...rules[0], instruction: "" }] } as never, src, { payload: src } as never, compiler as never);
    expect(plain.rules[0].ok).toBe(false);
  });
});
