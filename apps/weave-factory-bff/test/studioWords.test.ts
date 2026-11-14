import { describe, expect, it } from "vitest";
import { compileWords, inferRules, refOf, sourceFields, suggestionsFor, wordsOf } from "../src/studioWords.js";

const SAMPLE = {
  customer: { name: "John Smith", firstName: "John", lastName: "Smith", gender: "M", nickname: "", "postal-code": "12345" },
  status: "ACTIVE", amount: "1234.567", qty: 3, price: 19.99, createdAt: "2026-01-31T10:20:30Z",
  items: [{ sku: "A1", price: 10 }, { sku: "B2", price: 5.5 }], tags: ["red", "blue"], code: "ab-12-cd",
};
const words = (instruction: string, sampleSource: unknown = SAMPLE, target = "out") => compileWords({ instruction, target, sampleSource });
const expr = (instruction: string, sample: unknown = SAMPLE) => words(instruction, sample).compiled?.expr;

describe("plain-words rules: reading the sample", () => {
  it("lists every value by path, walking lists through their first entry", () => {
    const f = sourceFields(SAMPLE);
    expect(f.find((x) => x.path === "customer.name")).toMatchObject({ list: false, value: "John Smith" });
    expect(f.find((x) => x.path === "items")?.list).toBe(true);
    expect(f.find((x) => x.path === "items.price")?.list).toBe(true);
    expect(f.find((x) => x.path === "tags")?.list).toBe(true);
    expect(sourceFields(undefined)).toEqual([]);
  });
  it("splits names into words and writes paths the way the engine reads them", () => {
    expect(wordsOf("firstName")).toEqual(["first", "name"]);
    expect(wordsOf("first_name")).toEqual(["first", "name"]);
    expect(wordsOf("customerID")).toEqual(["customer", "id"]);
    expect(refOf("customer.name")).toBe("customer.name");
    expect(refOf("customer.postal-code")).toBe("customer.`postal-code`");
    expect(refOf("items[0].sku")).toBe("items[0].sku");
  });
});

describe("plain-words rules: sentences that are understood", () => {
  it("understands the owner's own sentence", () => {
    const r = words("add the _ inbetween if name came as two words(customer.name)");
    expect(r.ok).toBe(true);
    expect(r.compiled).toMatchObject({ expr: '$replace($trim($string(customer.name)), /\\s+/, "_")', confidence: "exact", engine: "rules" });
    expect(r.compiled?.explanation).toContain('Put "_" between the words');
    expect(r.compiled?.explanation).toContain("A single word stays as it is");
    expect(r.fields).toEqual(["customer.name"]);
  });
  it("reads the same rule in other phrasings", () => {
    const want = '$replace($trim($string(customer.name)), /\\s+/, "_")';
    expect(expr("put _ between the words of (customer.name)")).toBe(want);
    expect(expr("replace spaces with an underscore in customer.name")).toBe(want);
    expect(expr("if name has two words put an underscore between them (customer.name)")).toBe(want);
    expect(expr("customer.name with underscore instead of spaces")).toBe(want);
    expect(expr("replace spaces with a dash in customer.name")).toBe('$replace($trim($string(customer.name)), /\\s+/, "-")');
  });
  it("finds a field by its name, by its path and in brackets", () => {
    expect(words("first name in capitals").fields).toEqual(["customer.firstName"]);
    expect(words("(status) in capitals").fields).toEqual(["status"]);
    expect(expr("`customer.postal-code` as a number")).toBe("$number(customer.`postal-code`)");
  });
  it("keeps fields in the order they were written", () => {
    expect(expr("multiply qty by price")).toBe("$number(qty) * $number(price)");
    expect(expr("subtract price from amount")).toBe("$number(amount) - $number(price)");
    expect(expr("customer.lastName, customer.firstName separated by comma")).toBe('(customer.lastName & "," & customer.firstName)');
    expect(expr("join first name and last name with a space")).toBe('$trim(customer.firstName & " " & customer.lastName)');
  });
  it("changes letters, picks parts and chains several steps", () => {
    expect(expr("customer.name in capital letters")).toBe("$uppercase($string(customer.name))");
    expect(expr("lower case of status")).toBe("$lowercase($string(status))");
    expect(expr("first 3 characters of (code)")).toBe("$substring($string(code), 0, 3)");
    expect(expr("last 4 digits of (code)")).toBe("$substring($string(code), -4)");
    expect(expr("remove dashes from code and upper case")).toBe('$uppercase($string($replace($string(code), "-", "")))');
    expect(expr("date only of createdAt")).toBe("$substring($string(createdAt), 0, 10)");
    expect(expr('prefix with "CS-" (code)')).toBe('"CS-" & code');
  });
  it("works with numbers and lists", () => {
    expect(expr("amount rounded to 2 decimals")).toBe("$round($number(amount), 2)");
    expect(expr("divide amount by 100")).toBe("$number(amount) / 100");
    expect(expr("sum of items.price")).toBe("$sum(items.price)");
    expect(expr("count of items")).toBe("$count(items)");
    expect(expr("join tags with comma")).toBe('$join(tags.$string(), ",")');
    expect(expr("first item of tags")).toBe("(tags)[0]");
  });
  it("reads conditions, defaults and look-up lists", () => {
    expect(expr("if status is ACTIVE then Y otherwise N")).toBe('(status = "ACTIVE") ? "Y" : "N"');
    expect(expr('if amount is greater than 1000 then "high" else "low"')).toBe('($number(amount) > 1000) ? "high" : "low"');
    expect(expr('"VIP" when qty is at least 3, otherwise "STD"')).toBe('($number(qty) >= 3) ? "VIP" : "STD"');
    expect(expr('if (customer.nickname) is empty use "N/A"')).toBe('($not($exists(customer.nickname)) or customer.nickname = null or customer.nickname = "") ? "N/A" : customer.nickname');
    expect(expr("status in lower case, default to unknown")).toContain('? $v : "unknown"');
    expect(expr("M means Male, F means Female (customer.gender)")).toBe('( $v := $string(customer.gender); $v = "M" ? "Male" : $v = "F" ? "Female" : customer.gender )');
  });
  it("reads fixed values, today's date and plain copies", () => {
    expect(expr('always "SA"')).toBe('"SA"');
    expect(expr("today's date")).toBe("$substring($now(), 0, 10)");
    expect(expr("current date and time")).toBe("$now()");
    expect(words("same as customer.name").compiled).toMatchObject({ expr: "customer.name", confidence: "exact" });
  });
  it("works without a sample when the field is written in brackets", () => {
    const r = compileWords({ instruction: "put _ between the words of (customer.name)" });
    expect(r.compiled).toMatchObject({ expr: '$replace($trim($string(customer.name)), /\\s+/, "_")', confidence: "exact" });
  });
  it("says so when it had to guess", () => {
    const r = words("customer.firstName customer.lastName");
    expect(r.compiled?.confidence).toBe("guessed");
    expect(words("customer.name in capital letters quickly").compiled?.confidence).toBe("guessed");
    expect(words("(shoeSize) in capital letters").compiled?.confidence).toBe("guessed");
  });
});

describe("plain-words rules: sentences that are not understood", () => {
  it("never invents a rule", () => {
    for (const text of ["make it fancy (customer.name)", "do something nice", "the sky is blue", "", "   "]) {
      const r = words(text);
      expect(r.ok, text).toBe(false);
      expect(r.compiled, text).toBeNull();
      expect(r.reason, text).toBeTruthy();
      expect(r.suggestions.length, text).toBeGreaterThan(0);
    }
  });
  it("offers phrasings that it understands itself", () => {
    const r = words("make it fancy (customer.name)");
    expect(r.suggestions[0]).toContain("(customer.name)");
    for (const s of r.suggestions) expect(words(s).ok, s).toBe(true);
    for (const s of suggestionsFor()) expect(compileWords({ instruction: s }).ok, s).toBe(true);
  });
  it("does not read quoted text as wording", () => {
    expect(expr('always "upper case"')).toBe('"upper case"');
  });
});

describe("mapping suggestions from a wanted output", () => {
  const rules = inferRules(SAMPLE, { fullName: "John Smith", name_code: "John_Smith", first: "John", state: "active", total: 1234.567, day: "2026-01-31", both: "John Smith", source: "web", customer: { gender: "F" } });
  const by = (t: string) => rules.find((r) => r.target === t)!;
  it("copies fields with the same value, preferring matching names", () => {
    expect(by("fullName")).toMatchObject({ kind: "direct", source: "customer.name" });
    expect(by("first")).toMatchObject({ kind: "direct", source: "customer.firstName" });
  });
  it("recognises simple changes", () => {
    expect(by("name_code")).toMatchObject({ kind: "expr", expr: '$replace($trim(customer.name), /\\s+/, "_")' });
    expect(by("state")).toMatchObject({ kind: "expr", expr: "$lowercase(status)" });
    expect(by("total")).toMatchObject({ kind: "expr", expr: "$number(amount)" });
    expect(by("day")).toMatchObject({ kind: "expr", expr: "$substring(createdAt, 0, 10)" });
  });
  it("falls back to the same name, then to a fixed value, and says why", () => {
    expect(by("customer.gender")).toMatchObject({ kind: "direct", source: "customer.gender" });
    expect(by("customer.gender").comment).toContain("names match");
    expect(by("source")).toMatchObject({ kind: "const", value: "web" });
    expect(by("source").comment).toContain("fixed value");
  });
  it("gives every rule its own id and one rule per wanted field", () => {
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
    expect(rules).toHaveLength(9);
    expect(inferRules(SAMPLE, {})).toEqual([]);
  });
  it("finds two fields joined together", () => {
    const r = inferRules({ a: "John", b: "Smith" }, { n: "Smith, John" });
    expect(r[0]).toMatchObject({ kind: "expr", expr: 'b & ", " & a' });
  });
});
