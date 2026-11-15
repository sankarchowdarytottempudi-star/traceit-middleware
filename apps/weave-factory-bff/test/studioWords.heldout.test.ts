import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { compileWords } from "../src/studioWords";

// Sentences that were written after the rules, to see whether the rules hold for wording they were
// not made for. Each row: [sentence, target field, wanted value, or null when it must be refused].
const jsonata = createRequire(new URL("../../weave-runtime/package.json", import.meta.url))("jsonata");
const SAMPLE = { customer: { email: "john.smith@example.com", name: "John Michael Smith", phone: "+1 (555) 010-9999", nickname: "" }, code: "ab-12-cd", path: "a/b/c.txt", ref: "000123", status: "ACTIVE", amount: 1234.567, qty: 3, price: 19.99, gross: 200, discount: 50 };
const ROWS = JSON.parse(readFileSync(new URL("./studioWords.heldout.json", import.meta.url), "utf8")) as [string, string, unknown][];

describe("plain words: sentences the rules were not written against", () => {
  it(`gives the wanted value, or refuses (${ROWS.length} sentences)`, async () => {
    const wrong: string[] = [];
    for (const [s, target, want] of ROWS) {
      const r = compileWords({ instruction: s, target, sampleSource: SAMPLE });
      if (!r.ok || !r.compiled) { if (want !== null) wrong.push(`${s}  ->  refused`); continue; }
      let got: unknown;
      try { got = await jsonata(r.compiled.expr).evaluate(SAMPLE); } catch (e) { got = "ERR " + (e as Error).message; }
      if (want === null) wrong.push(`${s}  ->  ${JSON.stringify(got)} (must be refused)`);
      else if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${s}  ->  ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
    }
    expect(wrong).toEqual([]);
  });
});
