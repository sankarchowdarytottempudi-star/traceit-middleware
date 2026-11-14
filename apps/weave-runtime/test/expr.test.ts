import { describe, expect, it } from "vitest";
import { checkExpr, checkTemplate, evalExpr, FUNCTION_DOCS, renderTemplate, truthy } from "../src/expr.js";

const scope = { payload: { name: "ada lovelace", total: 12.345, when: "2026-03-09T14:05:00Z", tags: ["a", "b"] }, vars: { limit: 5 }, request: { method: "GET", path: "/x", params: { id: "7" }, query: { q: "z" }, headers: { "x-corr": "c-1" }, body: null } } as never;
const ev = (e: string) => evalExpr(e, scope);

describe("expressions", () => {
  it("binds payload, vars and request", async () => {
    expect(await ev("name")).toBe("ada lovelace");
    expect(await ev("$payload.total")).toBe(12.345);
    expect(await ev("$vars.limit + 1")).toBe(6);
    expect(await ev("$request.params.id & '-' & $request.headers.`x-corr`")).toBe("7-c-1");
  });
  it("text helpers", async () => {
    expect(await ev("$titleCase(name)")).toBe("Ada Lovelace");
    expect(await ev("$capitalize(name)")).toBe("Ada lovelace");
    expect(await ev("$initials(name)")).toBe("AL");
    expect(await ev("$digits('+966 (50) 123')")).toBe("96650123");
    expect(await ev("$coalesce(missing, '', name)")).toBe("ada lovelace");
    expect(await ev("$isEmpty(missing)")).toBe(true);
    expect(await ev("$translate('M', {'M': 'Male', 'F': 'Female'})")).toBe("Male");
    expect(await ev("$translate('X', {'M': 'Male'}, 'Other')")).toBe("Other");
    expect(await ev("$yesNo(true)")).toBeTypeOf("string");
  });
  it("date helpers", async () => {
    expect(await ev("$formatDate(when, 'dd/MM/yyyy')")).toBe("09/03/2026");
    expect(await ev("$addTime('2026-04-01', 2, 'weeks')")).toBe("2026-04-15");
    expect(await ev("$dateDiff('2026-04-01', '2026-04-08', 'days')")).toBe(7);
    expect(await ev("$dateDiff('2026-01-31', '2026-03-30', 'months')")).toBe(1);
    expect(await ev("$dateDiff('2026-01-15', '2026-03-15', 'months')")).toBe(2);
    expect(await ev("$dateDiff('1990-05-17', '2026-05-16', 'years')")).toBe(35);
    expect(await ev("$dateDiff('1990-05-17', '2026-05-17', 'years')")).toBe(36);
  });
  it("number helpers", async () => {
    expect(await ev("$toMinorUnits(total)")).toBe(1235);
    expect(await ev("$fromMinorUnits(1250)")).toBe(12.5);
    expect(await ev("$round(12.346, 2)")).toBe(12.35);
  });
  it("xml and json helpers", async () => {
    expect(await ev("$xmlToJson('<a><b>1</b></a>').a.b")).toBeDefined();
    expect(await ev("$parseJson('{\"a\": 2}').a")).toBe(2);
    expect(String(await ev("$jsonToXml({'a': {'b': 'x'}})"))).toContain("<b>x</b>");
  });
  it("reports syntax problems instead of throwing", () => {
    expect(checkExpr("name & ")).toBeTypeOf("string");
    expect(checkExpr("$uppercase(name)")).toBeNull();
    expect(checkTemplate("Hello {{ name }}")).toBeNull();
    expect(checkTemplate("Hello {{ name & }}")).toBeTypeOf("string");
  });
  it("renders templates, keeping the type of a lone expression", async () => {
    expect(await renderTemplate("Hello {{ $titleCase(name) }}!", scope)).toBe("Hello Ada Lovelace!");
    expect(await renderTemplate("{{ tags }}", scope)).toEqual(["a", "b"]);
    expect(await renderTemplate("{{ total }}", scope)).toBe(12.345);
    expect(await renderTemplate("plain", scope)).toBe("plain");
  });
  it("truthiness follows what people expect", () => {
    expect(truthy("")).toBe(false); expect(truthy(0)).toBe(false); expect(truthy([])).toBe(false); expect(truthy("x")).toBe(true); expect(truthy({ a: 1 })).toBe(true);
  });
  it("documents every helper with an example that runs", async () => {
    expect(FUNCTION_DOCS.length).toBeGreaterThan(20);
    for (const d of FUNCTION_DOCS) { expect(d.name.startsWith("$")).toBe(true); if (d.example) expect(checkExpr(d.example.split(" => ")[0].split(" -> ")[0]), d.name).toBeNull(); }
  });
});
