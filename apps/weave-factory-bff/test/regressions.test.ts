// Regressions from the owner's flow fl_31501c1adfb0: a table of codes from a request header, values of several
// words, and an answer that names the result of the call above it.
import { describe, expect, it } from "vitest";
import { describeFlow, readValueTable } from "@traceit/weave-flow";
import { compileWords } from "../src/studioWords.js";

const LINE = "WEB means Web, MOBILE means Mobile App, AGENT_BOOKING means Agent Booking, AGENCY means Agency (header x-channel)";
const EXPECTED = "( $v := $uppercase($string($request.headers.\"x-channel\")); $v = \"WEB\" ? \"Web\" : $v = \"MOBILE\" ? \"Mobile App\" : $v = \"AGENT_BOOKING\" ? \"Agent Booking\" : $v = \"AGENCY\" ? \"Agency\" : $request.headers.\"x-channel\" )";

describe("a table of codes (X means A, Y means B)", () => {
  it("the owner's line: header source, every entry, values of several words, exact only when all is read", () => {
    const sample = { data: {}, channel: "", email: "", firstName: "", lastName: "", mobile: "+966 512345678", lead: {} };
    const r = compileWords({ instruction: LINE, target: "Submission_Channel", sampleSource: sample });
    expect(r.compiled).toEqual({ expr: EXPECTED, explanation: expect.stringMatching(/^Translate the request header x-channel \(any letter case\): WEB becomes "Web", MOBILE becomes "Mobile App", AGENT_BOOKING becomes "Agent Booking", AGENCY becomes "Agency"/), confidence: "exact", engine: "rules" });
    expect(r.compiled!.expr).not.toMatch(/\bmobile\b(?!")/);
  });
  it("reads the header source written in other ways", () => {
    for (const ins of [
      "WEB means Web, MOBILE means Mobile App (the x-channel header)",
      "WEB means Web, MOBILE means Mobile App for the header X-Channel",
      "header x-channel: WEB means Web, MOBILE means Mobile App",
      "translate header X-Channel: WEB means Web, MOBILE means Mobile App",
    ]) expect(readValueTable(ins), ins).toMatchObject({ ok: true, source: { kind: "header", name: "x-channel" }, entries: [["WEB", "Web"], ["MOBILE", "Mobile App"]], ignoreCase: true });
  });
  it("fields, quotes, a default, and letter case only when asked", () => {
    expect(readValueTable("A means Active Member, I means Inactive Member, anything else Unknown Status (data.status)")).toMatchObject({ ok: true, ignoreCase: false, expr: "( $v := $string(data.status); $v = \"A\" ? \"Active Member\" : $v = \"I\" ? \"Inactive Member\" : \"Unknown Status\" )" });
    expect(readValueTable("\"a\" means \"Active\", \"i\" means \"Inactive\" (status) ignoring case")).toMatchObject({ ok: true, ignoreCase: true, expr: "( $v := $lowercase($string(status)); $v = \"a\" ? \"Active\" : $v = \"i\" ? \"Inactive\" : status )" });
    expect(readValueTable("WEB -> Web, MOBILE => Mobile App and AGENCY becomes Agency (channel)")).toMatchObject({ ok: true, entries: [["WEB", "Web"], ["MOBILE", "Mobile App"], ["AGENCY", "Agency"]] });
    expect(readValueTable("WEB means Web, APP means Mobile App, anything else keep it (channel)")).toMatchObject({ ok: true, expr: expect.stringMatching(/: channel \)$/) });
  });
  it("is not understood (never guessed) when the source is not named or a pair cannot be read", () => {
    const noSource = compileWords({ instruction: "WEB means Web, MOBILE means Mobile App", target: "x", sampleSource: { mobile: "1", web: "x" } });
    expect(noSource.ok).toBe(false);
    expect(noSource.compiled).toBeNull();
    expect(noSource.reason).toMatch(/Say where the codes come from/);
    expect(noSource.suggestions[0]).toMatch(/\(header x-channel\)/);
    const broken = readValueTable("WEB means Web, MOBILE Mobile App, AGENCY means Agency (header x-channel)");
    expect(broken).toMatchObject({ ok: false, reason: expect.stringMatching(/"MOBILE Mobile App" is not read as CODE means VALUE/) });
    expect(readValueTable("Mobile App Store means Apps, WEB means Web (channel)")).toMatchObject({ ok: false, reason: expect.stringMatching(/not one code/) });
    expect(readValueTable("join first and last with a space")).toBeNull();
  });
  it("other phrasings: a default value longer than three words is refused, not cut short", () => {
    const r = compileWords({ instruction: "default Not Given By Guest (channel)", target: "x", sampleSource: { channel: "web" } });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/more than three words. Put it in quotes/);
    expect(compileWords({ instruction: "default \"Not given by the guest\" (channel)", target: "x", sampleSource: { channel: "web" } }).compiled?.expr).toContain("\"Not given by the guest\"");
    expect(compileWords({ instruction: "if status is A then Very Active Gold Member otherwise Former Member", target: "x", sampleSource: { status: "A" } }).compiled?.expr).toBe("(status = \"A\") ? \"Very Active Gold Member\" : \"Former Member\"");
  });
});

describe("an answer that names the result of the call above", () => {
  const TWO = "When POST /newsletter/subscribe arrives\nCall POST /crm/v8/Leads/upsert on Zoho with email, first name, last name\nAnswer 200 with the lead";
  it("the owner's two lines: the call keeps its result as lead and the answer returns it", () => {
    for (const ctx of [{}, { connections: [{ id: "cx_z", name: "Zoho", type: "http" }] }]) {
      const r = describeFlow(TWO, ctx);
      const call = r.flow.nodes.find((n) => n.type === "http.request")!;
      const answer = r.flow.nodes.find((n) => n.type === "respond")!;
      expect(call.config.resultVar).toBe("lead");
      expect(answer.config.body).toBe("$vars.lead");
      expect(r.lines[1].understood).toMatch(/kept as lead/);
      expect(r.lines[2]).toMatchObject({ status: "ok", understood: expect.stringMatching(/"the lead" is the answer of/) });
    }
  });
  it("when the call already named its result, an unknown name is flagged, never silent", () => {
    const r = describeFlow("When POST /x arrives\nLook up the contact in Zoho by email\nAnswer 200 with the lead", { connections: [{ id: "cx_z", name: "Zoho", type: "http" }] });
    expect(r.lines[2].status).toBe("warning");
    expect(r.lines[2].message).toMatch(/Nothing earlier produces "lead"/);
    const ok = describeFlow("When POST /x arrives\nLook up the contact in Zoho by email\nAnswer 200 with the contact", {});
    expect(ok.flow.nodes.at(-1)!.config.body).toBe("$vars.contact");
    expect(ok.lines[2].status).toBe("ok");
    const input = describeFlow("When POST /x arrives\nRequire email\nAnswer 200 with the email", {});
    expect(input.lines[2].status).toBe("ok");
  });
});
