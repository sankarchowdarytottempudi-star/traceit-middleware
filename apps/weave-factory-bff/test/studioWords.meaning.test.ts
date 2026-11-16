// What a sentence MEANS, checked by running the produced expression on a made-up sample.
// Each row: the sentence, and the value it has to give. `null` = it must be refused
// ("not understood") rather than answered with a guess.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { compileWords } from "../src/studioWords.js";

const jsonata = createRequire(new URL("../../weave-runtime/package.json", import.meta.url))("jsonata") as (e: string) => { evaluate(d: unknown): Promise<unknown> };

const SAMPLE = {
  customer: { email: "john.smith@example.com", name: "John Michael Smith", phone: "+1 (555) 010-9999", nickname: "" },
  code: "ab-12-cd", path: "a/b/c.txt", ref: "000123", status: "ACTIVE",
  amount: 1234.567, qty: 3, price: 19.99, gross: 200, discount: 50,
};
type Row = [string, unknown] | [string, unknown, string];

const REMOVING: Row[] = [
  ["remove after the @ in email", "john.smith"],
  ["remove before the @ in email", "example.com"],
  ["remove everything after the @ from email", "john.smith"],
  ["remove everything before the @ from email", "example.com"],
  ["email, remove what comes after the @", "john.smith"],
  ["remove whatever is before the @ in email", "example.com"],
  ["remove the text after @ in (customer.email)", "john.smith"],
  ["delete the part before @ of email", "example.com"],
  ["drop everything following the @ in email", "john.smith"],
  ["strip everything up to the @ from email", "example.com"],
  ["email without the part after the @", "john.smith"],
  ["email without what is before the @", "example.com"],
  ["email except the part after the @", "john.smith"],
  ["everything except what comes after the @ in email", "john.smith"],
  ["remove from the @ onwards in email", "john.smith"],
  ["remove the @ and everything after it from email", "john.smith"],
  ["remove the @ and everything before it from email", "example.com"],
  ["remove everything after and including the @ in email", "john.smith"],
  ["everything after the @ should be removed from email", "john.smith"],
  ["in email everything before the @ must be removed", "example.com"],
  ["email with everything after @ removed", "john.smith"],
  ["the part after the @ is not needed in email", "john.smith"],
  ["after the @ remove everything in email", "john.smith"],
  ["before the @ remove everything in email", "example.com"],
  ["truncate email at the @", "john.smith"],
  ["cut email after the @", "john.smith"],
  ["do not keep what is after the @ in email", "john.smith"],
  ["email, cut off everything after the @ sign", "john.smith"],
  ["remove the domain from email", "john.smith"],
  ["remove after the @ in this field", "john.smith", "email"],
  ["remove before the @ in this field", "example.com", "email"],
  ["remove after the last - in code", "ab-12"],
  ["remove before the last - in code", "cd"],
  ["remove after the first - in code", "ab"],
  ["remove before the first dash in code", "12-cd"],
  ["remove everything before the last slash in path", "c.txt"],
  ["remove everything after the last / in path", "a/b"],
  ["remove the first word of (customer.name)", "Michael Smith"],
  ["remove the last word of (customer.name)", "John Michael"],
  ["(customer.name) without the first word", "Michael Smith"],
  ["(customer.name) without the last word", "John Michael"],
  ["remove the first 2 words of (customer.name)", "Smith"],
  ["remove the first 3 characters of code", "12-cd"],
  ["remove the last 3 characters of code", "ab-12"],
  ["code without the first 3 characters", "12-cd"],
  ["drop the last 2 characters from code", "ab-12-"],
  ["all but the last 2 characters of code", "ab-12-"],
  ["everything except the first 3 characters of code", "12-cd"],
  ["remove the first character of code", "b-12-cd"],
  ["remove the last character of code", "ab-12-c"],
  ["remove first two characters of code", "-12-cd"],
  ["the first 3 characters of code should be removed", "12-cd"],
  ["code with the last 3 characters removed", "ab-12"],
  ["remove digits from code", "ab--cd"],
  ["remove letters from code", "-12-"],
  ["remove special characters from phone", "1 555 0109999"],
  ["remove dashes from code", "ab12cd"],
  ["remove the first dash from code", "ab12-cd"],
  ["remove leading zeros from ref", "123"],
];
const KEEPING: Row[] = [
  ["remove everything except the part before the @ in email", "john.smith"],
  ["remove everything except what is after the @ in email", "example.com"],
  ["keep only the part before the @ of email", "john.smith"],
  ["keep the part after the @ of email", "example.com"],
  ["only the part of email before the @", "john.smith"],
  ["email before the @", "john.smith"],
  ["email after the @", "example.com"],
  ["keep what is before the @ in email and remove the rest", "john.smith"],
  ["keep the part before the @ of email and drop what comes after", "john.smith"],
  ["domain of email", "example.com"],
  ["code before the last -", "ab-12"],
  ["code after the last dash", "cd"],
  ["path after the last /", "c.txt"],
  ['text between "-" and "-" in code', "12"],
  ["first word of (customer.name)", "John"],
  ["last word of (customer.name)", "Smith"],
  ["first two words of (customer.name)", "John Michael"],
  ["last 2 words of (customer.name)", "Michael Smith"],
  ["first 3 characters of code", "ab-"],
  ["last 2 characters of code", "cd"],
  ["first character of code", "a"],
  ["last character of code", "d"],
  ["only digits of phone", "15550109999"],
  ["remove everything except digits from phone", "15550109999"],
  ["replace - with _ in code", "ab_12_cd"],
  ["change - to _ in code", "ab_12_cd"],
  ["use _ instead of - in code", "ab_12_cd"],
  ["code with dots instead of dashes", "ab.12.cd"],
  ["(customer.name) in capital letters", "JOHN MICHAEL SMITH"],
  ["lower case of status", "active"],
  ['add "X-" before code', "X-ab-12-cd"],
  ['add "-X" after code', "ab-12-cd-X"],
  ['prefix code with "ID"', "ID ab-12-cd"],
  ['prefix code with "ID" without a space', "IDab-12-cd"],
  ['prefix code with "ID-"', "ID-ab-12-cd"],
  ['append "!" to status', "ACTIVE!"],
];
const CONDITIONS: Row[] = [
  ['if amount is not greater than 100 then "low" otherwise "high"', "high"],
  ['if amount is not less than 100 then "big" otherwise "small"', "big"],
  ['if amount is no more than 100 then "low" otherwise "high"', "high"],
  ['if qty is not more than 3 then "ok" otherwise "many"', "ok"],
  ['if qty is no less than 3 then "ok" otherwise "few"', "ok"],
  ['if status does not contain "ACT" then "n" otherwise "y"', "y"],
  ['if status does not start with "AC" then "n" otherwise "y"', "y"],
  ['if status does not end with "VE" then "n" otherwise "y"', "y"],
  ['if status is not one of "ACTIVE", "PENDING" then "closed" otherwise "open"', "open"],
  ['if status is PENDING or ACTIVE then "open" otherwise "closed"', "open"],
  ['if status is not PENDING or CLOSED then "open" otherwise "shut"', "open"],
  ['if status is either "ACTIVE" or "NEW" then 1 otherwise 0', 1],
  ['if qty is between 1 and 5 then "few" otherwise "many"', "few"],
  ['if qty is not between 1 and 5 then "odd" otherwise "fine"', "fine"],
  ['"yes" unless status is "ACTIVE" then "no"', "no"],
  ['"Y" unless status is "CLOSED"', "Y"],
  ['if status is not "ACTIVE" then "off" otherwise "on"', "on"],
  ['if amount is greater than 100 then "high" otherwise "low"', "high"],
  ['if amount is at most 100 then "low" otherwise "high"', "high"],
  ['if qty is at least 3 then "ok" otherwise "no"', "ok"],
  ['if (customer.nickname) is empty use "N/A"', "N/A"],
];
const NUMBERS: Row[] = [
  ["subtract discount from gross", 150],
  ["from gross subtract discount", 150],
  ["gross minus discount", 150],
  ["discount subtracted from gross", 150],
  ["deduct discount from gross", 150],
  ["divide gross by discount", 4],
  ["gross divided by discount", 4],
  ["multiply qty by price", 59.97],
  ["subtract 5 from qty", -2],
  ["subtract qty from 10", 7],
  ["10 minus qty", 7],
  ["qty minus 1", 2],
  ["divide 12 by qty", 4],
  ["12 divided by qty", 4],
  ["divide qty by 3", 1],
  ["add 5 to qty", 8],
  ["qty times 2", 6],
  ["increase gross by 10%", 220],
  ["reduce gross by 10 percent", 180],
  ["10% of gross", 20],
  ["round amount up", 1235],
  ["round amount down", 1234],
  ["round up amount to 1 decimal", 1234.6],
  ["round amount down to 1 decimal", 1234.5],
  ["round amount to 2 decimals", 1234.57],
  ["round amount", 1235],
  ["drop the decimals of amount", 1234],
];
const REFUSED: Row[] = [
  ["remove the middle name from (customer.name)", null],
  ["(customer.name) not in capital letters", null],
  ["swap first and last word of (customer.name)", null],
  ["remove everything between the brackets in phone", null],
  ["gross as a percentage of discount", 400],
  ["reverse code", null],
];

const near = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : JSON.stringify(a) === JSON.stringify(b));
async function check(rows: Row[]): Promise<string[]> {
  const wrong: string[] = [];
  for (const [instruction, want, target] of rows) {
    const out = compileWords({ instruction, target: target ?? "out", sampleSource: SAMPLE });
    if (want === null) { if (out.ok) wrong.push(`${instruction}  ->  answered ${out.compiled?.expr} instead of refusing`); continue; }
    if (!out.ok || !out.compiled) { wrong.push(`${instruction}  ->  not understood (${out.reason})`); continue; }
    let got: unknown;
    try { got = await jsonata(out.compiled.expr).evaluate(SAMPLE); } catch (e) { got = `error: ${(e as Error).message}`; }
    if (!near(got, want)) wrong.push(`${instruction}  ->  ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}   [${out.compiled.expr}]`);
  }
  return wrong;
}

describe("plain words mean what they say", () => {
  it("taking a part away", async () => { expect(await check(REMOVING)).toEqual([]); });
  it("keeping a part, replacing, capitals, text in front or behind", async () => { expect(await check(KEEPING)).toEqual([]); });
  it("conditions, with and without \"not\"", async () => { expect(await check(CONDITIONS)).toEqual([]); });
  it("calculations and rounding, in the order they are said", async () => { expect(await check(NUMBERS)).toEqual([]); });
  it("refuses instead of guessing when a word that turns the meaning around is left over", async () => { expect(await check(REFUSED)).toEqual([]); });
});
