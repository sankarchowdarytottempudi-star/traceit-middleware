// Regressions from the owner's flow fl_31501c1adfb0, in the flow engine: the code table read from a request
// header (and evaluated), and the preview warning for an answer that reads a name nothing produced.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Flow, FlowNode } from "@traceit/weave-flow";
import { compileLocal } from "../src/mapping/instruction.js";
import { bareNames } from "../src/validate.js";
import { loadConfig } from "../src/config.js";
import { Runtime } from "../src/runtime.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wr-regr-"));
let rt: Runtime;
beforeAll(() => { rt = new Runtime(loadConfig({ DATA_DIR: tmp, SECRET_KEY_FILE: path.join(tmp, "k"), RUNTIME_INTERNAL_KEY: "k", PORT: "0", GATEWAY_RECONCILE_SECONDS: "0" } as NodeJS.ProcessEnv)); });
afterAll(async () => { await rt.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const LINE = "WEB means Web, MOBILE means Mobile App, AGENT_BOOKING means Agent Booking, AGENCY means Agency (header x-channel)";

describe("the code table in the flow engine", () => {
  it("compiles the owner's line exactly, from the header, with every entry", async () => {
    const r = compileLocal({ instruction: LINE, target: "Submission_Channel", sampleSource: { mobile: "+966 512345678", channel: "" } });
    expect(r.compiled).toMatchObject({ confidence: "exact", expr: "( $v := $uppercase($string($request.headers.\"x-channel\")); $v = \"WEB\" ? \"Web\" : $v = \"MOBILE\" ? \"Mobile App\" : $v = \"AGENT_BOOKING\" ? \"Agent Booking\" : $v = \"AGENCY\" ? \"Agency\" : $request.headers.\"x-channel\" )" });
    const at = async (h: string) => (await rt.evalExpression({ expr: r.compiled!.expr, context: { payload: { mobile: "x" }, request: { method: "POST", path: "/", headers: { "x-channel": h } } } })).result;
    expect(await at("WEB")).toBe("Web");
    expect(await at("mobile")).toBe("Mobile App");
    expect(await at("Agent_Booking")).toBe("Agent Booking");
    expect(await at("AGENCY")).toBe("Agency");
    expect(await at("FACEBOOK")).toBe("FACEBOOK");
  });
  it("says it is not understood when the source is missing, instead of reading a code as a field", () => {
    const r = compileLocal({ instruction: "WEB means Web, MOBILE means Mobile App", target: "x", sampleSource: { mobile: "1" } });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Say where the codes come from/);
  });
  it("the phrase list example still works", () => {
    expect(compileLocal({ instruction: "M means Male, F means Female, anything else Unknown (customer.gender)", target: "g", sampleSource: { customer: { gender: "F" } } }).compiled?.confidence).toBe("exact");
  });
});

describe("preview warning: a name nothing produced", () => {
  const node = (id: string, type: string, config: Record<string, unknown>): FlowNode => ({ id, type, name: id, position: { x: 0, y: 0 }, config } as FlowNode);
  const flowOf = (nodes: FlowNode[]) => ({ id: "f", name: "f", slug: "f", nodes, edges: nodes.slice(1).map((n, i) => ({ id: `e${i}`, from: nodes[i].id, fromPort: "out", to: n.id })), settings: { basePath: "/f/v1", gateway: { publish: false, security: "oauth2" } }, revision: 1, createdAt: "", updatedAt: "" } as unknown as Flow);
  const trig = node("in", "trigger.http", { methods: ["POST"], path: "/s", sampleRequest: { method: "POST", path: "/s", body: { email: "a@example.invalid" } } });
  const call = (resultTarget: string) => node("call", "http.request", { method: "POST", url: "http://127.0.0.1:9/x", resultTarget, resultVar: "response" });
  it("the owner's case: the answer reads lead, which nothing made", async () => {
    const issues = await rt.validate(flowOf([trig, call("variable"), node("out", "respond", { status: "200", body: "{ \"lead\": lead }" })]));
    expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ level: "warning", nodeId: "out", message: expect.stringMatching(/"lead" is not in the sample request and no step before it produces it/) })]));
  });
  it("no warning for $vars, sample fields, or after a step that replaces the payload", async () => {
    for (const nodes of [
      [trig, call("variable"), node("out", "respond", { status: "200", body: "$vars.response" })],
      [trig, node("out", "respond", { status: "200", body: "{ \"email\": email }" })],
      [trig, call("payload"), node("out", "respond", { status: "200", body: "{ \"lead\": lead }" })],
    ]) expect((await rt.validate(flowOf(nodes))).filter((i) => /no step before it produces it/.test(i.message))).toEqual([]);
  });
  it("finds the bare names of an expression", () => {
    expect(bareNames("{ \"lead\": lead, \"x\": $vars.a, \"y\": data.b & \"c\" }")).toEqual(["lead", "data"]);
    expect(bareNames("$contains(email, /^a.b$/) ? \"x\" : name")).toEqual(["email", "name"]);
  });
});
