import { describe, it, expect } from "vitest";
import type { Execution, Json, MappingRule, StepTrace } from "@traceit/weave-flow";
import { convertRule, describeRule, leafPaths, looksLikeProse, readPath, showValue, specStats, targetFromSource } from "../src/studio/mapping";
import { contextForNode, fillPath, joinUrl, kvToRecord, pathParams, recordToKv } from "../src/studio/runctx";
import { blankOperation, bracePlaceholders, operationProblem, syncParams } from "../src/studio/pages/Connectors";
import { triggerLabel } from "../src/studio/editor/RunViews";

describe("mapper helpers", () => {
  const sample: Json = { customer: { name: "John Smith", "first name": "John", tags: ["a", "b"] }, items: [{ sku: "A1", qty: 2 }], empty: {}, none: null };
  it("lists the fields of a sample, arrays by their first item", () => {
    expect(leafPaths(sample)).toEqual(["customer.name", "customer.`first name`", "customer.tags", "items[0].sku", "items[0].qty", "empty", "none"]);
    expect(leafPaths(undefined)).toEqual([]);
    expect(leafPaths("text")).toEqual([]);
  });
  it("reads a path from a sample", () => {
    expect(readPath(sample, "customer.name")).toBe("John Smith");
    expect(readPath(sample, "customer.`first name`")).toBe("John");
    expect(readPath(sample, "items[0].qty")).toBe(2);
    expect(readPath(sample, "items[3].qty")).toBeUndefined();
    expect(readPath(sample, "none.deeper")).toBeUndefined();
    expect(readPath(sample, "")).toBe(sample);
  });
  it("proposes an output field name that is not taken", () => {
    expect(targetFromSource("customer.first_name")).toBe("first_name");
    expect(targetFromSource("items[0].sku")).toBe("sku");
    expect(targetFromSource("customer.name", ["name"])).toBe("customer_name");
    expect(targetFromSource("customer.name", ["name", "customer_name"])).toBe("name2");
  });
  it("recognises a sentence typed where an expression is expected", () => {
    expect(looksLikeProse("add the _ inbetween if name came as two words(customer.name)")).toBe(true);
    expect(looksLikeProse("join first name and last name with a space")).toBe(true);
    expect(looksLikeProse("make it upper case")).toBe(true);
    expect(looksLikeProse('$replace(customer.name, " ", "_")')).toBe(false);
    expect(looksLikeProse('backend.status = "UP"')).toBe(false);
    expect(looksLikeProse("customer.name")).toBe(false);
    expect(looksLikeProse('first & " " & last')).toBe(false);
    expect(looksLikeProse('{ "customer": { "name": $request.query.name }, "backend": $vars.backend }')).toBe(false);
    expect(looksLikeProse("")).toBe(false);
  });
  it("converting a rule keeps what can be kept and never keeps a stale interpretation", () => {
    const expr: MappingRule = { id: "r", target: "name", kind: "expr", expr: "join the names", comment: "c", enabled: false };
    const words = convertRule(expr, "instruction");
    expect(words).toEqual({ id: "r", target: "name", kind: "instruction", instruction: "join the names", compiled: null, comment: "c", enabled: false });
    const understood: MappingRule = { ...words, compiled: { expr: 'a & " " & b', explanation: "joins a and b", confidence: 0.9, source: "builtin" } as never };
    expect(convertRule(understood, "expr")).toMatchObject({ kind: "expr", expr: 'a & " " & b' });
    expect(convertRule({ id: "r", target: "t", kind: "direct", source: "a.b" }, "expr")).toMatchObject({ kind: "expr", expr: "a.b" });
    expect(convertRule({ id: "r", target: "t", kind: "const", value: "web" }, "expr")).toMatchObject({ expr: '"web"' });
    expect(convertRule(expr, "expr")).toBe(expr);
  });
  it("counts rules that are not understood apart from incomplete ones, ignoring switched-off rules", () => {
    const stats = specStats({ rules: [
      { id: "1", target: "a", kind: "direct", source: "a" },
      { id: "2", target: "b", kind: "instruction", instruction: "frobnicate" },
      { id: "3", target: "c", kind: "instruction", instruction: "x", compiled: { expr: "a", explanation: "", confidence: 1, source: "builtin" } as never },
      { id: "4", target: "", kind: "expr", expr: "a" },
      { id: "5", target: "e", kind: "instruction", instruction: "off", enabled: false },
    ] });
    expect(stats).toMatchObject({ total: 5, unresolved: 1, incomplete: 1, byKind: { direct: 1, expr: 1, const: 0, instruction: 3 } });
  });
  it("describes rules and values for read-only lists", () => {
    expect(describeRule({ id: "1", target: "a", kind: "direct", source: "x.y" })).toBe("copy of x.y");
    expect(describeRule({ id: "1", target: "a", kind: "const", value: 3 })).toBe("always 3");
    expect(describeRule({ id: "1", target: "a", kind: "instruction", instruction: "say it" })).toBe("say it");
    expect(showValue(undefined)).toBe("(nothing)");
    expect(showValue("a")).toBe('"a"');
    expect(showValue("x".repeat(300)).length).toBe(120);
  });
});

describe("expression context from the last run", () => {
  const step = (seq: number, nodeId: string, nodeType: string, input: Json, output: Json | undefined, status = "success"): StepTrace => ({ seq, nodeId, nodeName: nodeId.toUpperCase(), nodeType, status, startedAt: "", durationMs: 1, input, output } as StepTrace);
  const run = { id: "ex", request: { method: "GET", path: "/check", query: { name: "John Smith" } }, steps: [
    step(1, "t", "trigger.http", null, null),
    step(2, "h", "http.request", null, { status: "UP" }),
    step(3, "v", "vars.set", null, { region: "eu", retries: 2 }),
    step(4, "bad", "http.request", null, { leaked: true }, "error"),
    step(5, "m", "transform.map", null, { ok: true }),
    step(6, "r", "respond", { ok: true }, { ok: true }),
  ] } as unknown as Execution;
  const traces = Object.fromEntries(run.steps.map((s) => [s.nodeId, [s]]));
  const graph = [
    { id: "h", data: { config: { resultTarget: "variable", resultVar: " backend " } } },
    { id: "bad", data: { config: { resultTarget: "variable", resultVar: "broken" } } },
    { id: "m", data: { config: { resultTarget: "payload" } } },
  ];
  it("rebuilds the variables set by earlier steps", () => {
    const ctx = contextForNode(run, traces, "m", null, graph)!;
    expect(ctx.vars).toEqual({ backend: { status: "UP" }, region: "eu", retries: 2 });
    expect(ctx.request).toMatchObject({ query: { name: "John Smith" } });
    expect(ctx.nodes).toMatchObject({ H: { status: "UP" } });
    expect(ctx.nodes).not.toHaveProperty("M");
    expect(ctx.nodes).not.toHaveProperty("R");
    expect(ctx.payload).toBeNull();
  });
  it("only sees what ran before the step", () => {
    expect(contextForNode(run, traces, "h", null, graph)!.vars).toEqual({});
    expect(contextForNode(run, traces, "r", null, graph)!.payload).toEqual({ ok: true });
  });
  it("without the graph only Set Variables steps are known", () => {
    expect(contextForNode(run, traces, "m")!.vars).toEqual({ region: "eu", retries: 2 });
  });
  it("falls back to the sample request before anything has run, and to nothing without one", () => {
    expect(contextForNode(null, {}, "m")).toBeNull();
    expect(contextForNode(null, {}, "m", { method: "POST", path: "/x", body: { a: 1 } } as never)).toMatchObject({ payload: { a: 1 }, vars: {}, request: { method: "POST" } });
  });
});

describe("request helpers", () => {
  it("finds and fills path parameters", () => {
    expect(pathParams("/voyages/:id/cabins/{cabin}")).toEqual(["id", "cabin"]);
    expect(fillPath("/voyages/:id/cabins/{cabin}", { id: "A 1" })).toBe("/voyages/A%201/cabins/:cabin");
  });
  it("converts name/value rows and joins addresses", () => {
    expect(kvToRecord([{ key: " a ", value: "1" }, { key: "", value: "x" }])).toEqual({ a: "1" });
    expect(recordToKv({ a: "1", b: 2 })).toEqual([{ key: "a", value: "1" }, { key: "b", value: "2" }]);
    expect(joinUrl("http://h/base/", "/v1", "check")).toBe("http://h/base/v1/check");
    expect(joinUrl(undefined, "")).toBe("");
  });
  it("says what started a run in words", () => {
    expect(triggerLabel({ type: "trigger.http", nodeId: "n", method: "GET", path: "/check" })).toBe("GET /check");
    expect(triggerLabel({ type: "trigger.schedule" })).toBe("Schedule");
    expect(triggerLabel({ type: "trigger.kafka" })).toBe("kafka");
    expect(triggerLabel(undefined)).toBe("");
  });
});

describe("custom connector helpers", () => {
  it("keeps one input per {placeholder} in the path", () => {
    expect(bracePlaceholders("/ships/{shipId}/cabins/{cabin}/{shipId}")).toEqual(["shipId", "cabin"]);
    expect(bracePlaceholders("/a/{{ not.this }}")).toEqual([]);
    const params = syncParams("/ships/{id}", "/ships/{shipId}", [{ key: "id", label: "Ship", kind: "template" }, { key: "limit", label: "Limit", kind: "text" }] as never);
    expect(params.map((p) => p.key)).toEqual(["limit", "shipId"]);
    expect(params[1]).toMatchObject({ required: true });
  });
  it("names new operations and explains what is wrong with one", () => {
    expect(blankOperation(["operation-1", "operation-3"]).id).toBe("operation-4");
    const op = { id: "a", name: "List", method: "GET", path: "/ships", params: [] as { key: string }[] };
    expect(operationProblem(op as never)).toBeNull();
    expect(operationProblem({ ...op, name: " " } as never)).toMatch(/name/);
    expect(operationProblem({ ...op, path: "ships" } as never)).toMatch(/start with/);
    expect(operationProblem({ ...op, params: [{ key: "a" }, { key: "a" }] } as never)).toMatch(/both called/);
    expect(operationProblem({ ...op, params: [{ key: "connection" }] } as never)).toMatch(/already uses/);
    expect(operationProblem({ ...op, params: [{ key: "ship-id" }] } as never)).toMatch(/letters, digits/);
  });
});
