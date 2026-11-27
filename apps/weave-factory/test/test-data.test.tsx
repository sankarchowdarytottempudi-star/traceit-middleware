// "Test data" panel (server calls are stand-ins): examples per operation, the fields learned from them,
// and suggestions for TODO steps that are only used when a person accepts them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestData, showTestData, examplesFromFile, operationExample, removedWords, requestTemplate, stepExample, typeWords, fieldRows } from "../src/migrate/TestData.tsx";
import { CheckCorrect } from "../src/migrate/CheckCorrect.tsx";
import type { ExamplesView, Migration, SuggestionsView } from "../src/api.ts";

const mig = (over: Partial<Migration> = {}): Migration => ({ id: "m1", name: "orders", apiName: "orders-api", serviceDir: "services/orders-api",
  phases: [{ key: "document", title: "Document", mode: "auto", status: "done", percent: 100, steps: [] }],
  progress: { overallPercent: 40, majorPhase: "Generate", done: false, outcome: "In progress" }, ...over });
const OP = { operation: "GET /orders/{orderId}", method: "GET", path: "/orders/{orderId}", pathParams: ["orderId"], examples: 1 };
const OP2 = { operation: "POST /orders", method: "POST", path: "/orders", pathParams: [], examples: 0 };
const VIEW: ExamplesView = {
  api: "orders-api", target: "wso2", operations: [OP, OP2],
  todoSteps: [{ id: "T-aaaa1111", where: "ProcessOrder · step 6", summary: "Works out the price", kind: "java", status: "open" }, { id: "T-bbbb2222", where: "Nightly · step 1", summary: "Calls a service", kind: "dynamic-call", status: "open" }],
  examples: [{ id: "E-11111111", kind: "operation", operation: OP.operation, name: "order found", note: "the usual case",
    request: { method: "GET", path: "/orders/7", pathParams: { orderId: "7" }, query: {}, headers: {}, body: null }, response: { status: 200, body: { id: 7 } },
    removed: ["request header Authorization removed (secret)"], by: "anna", at: "2026-11-26T10:00:00Z" }],
  contract: { [OP.operation]: { request: { pathParams: { orderId: { t: "integer" } }, query: {}, headers: {}, body: null },
    responses: { "200": { t: "object", props: { id: { t: "integer" }, placed: { t: "datetime" }, paid: { t: "boolean" }, lines: { t: "array", items: { t: "object", props: { sku: { t: "string" } }, always: ["sku"] } }, coupon: { t: "string", nullable: true } }, always: ["id", "placed", "paid", "lines"] } }, examples: 1 } },
  counts: { examples: 1, operations: 2, steps: 2 },
};
const SUGG: SuggestionsView = { api: "orders-api", suggestions: [
  { id: "T-aaaa1111", where: "ProcessOrder · step 6", summary: "Works out the price", status: "suggested", basis: ["E-22222222"],
    rules: [{ field: "total", rule: "number", from: ["amount"], plain: "total is amount as a number" }, { field: "currency", rule: "constant", from: [], plain: "currency is always \"SAR\"" }],
    unresolved: [], answer: { type: "code", language: "javascript", text: "return { total: Number(input.amount), currency: 'SAR' };" }, note: "Suggested from your test data (E-22222222)" },
  { id: "T-bbbb2222", where: "Nightly · step 1", summary: "Calls a service", status: "nothing", basis: [], rules: [], unresolved: [], why: "There is no example for this step yet." },
] };

type Call = { url: string; method: string; body?: any };
function stub(onPost: (url: string, body: any) => Response = () => json({ ok: true, applied: 1, rerun: true, message: "1 example kept." }, 202)) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (method === "POST") return onPost(url, body);
    if (url.endsWith("/examples/suggestions")) return json(SUGG);
    if (url.endsWith("/examples")) return json(VIEW);
    return json({}, 404);
  }));
  return calls;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
function mount(m: Migration) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TestData m={m} /></QueryClientProvider>);
}
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("plain words", () => {
  it("says each type of field in plain words", () => {
    expect(typeWords({ t: "string" })).toBe("text");
    expect(typeWords({ t: "integer" })).toBe("whole number");
    expect(typeWords({ t: "number" })).toBe("number");
    expect(typeWords({ t: "boolean" })).toBe("yes/no");
    expect(typeWords({ t: "date" })).toBe("date");
    expect(typeWords({ t: "datetime" })).toBe("date and time");
    expect(typeWords({ t: "object" })).toBe("group");
    expect(typeWords({ t: "null" })).toBe("empty");
    expect(typeWords({ t: "array", items: { t: "string" } })).toBe("list of text");
    expect(typeWords({ t: "array", items: { t: "object" } })).toBe("list of groups");
    expect(typeWords({ t: "string", nullable: true })).toBe("text, can be empty");
    expect(fieldRows({ t: "object", props: { a: { t: "object", props: { b: { t: "date" } }, always: ["b"] }, c: { t: "array", items: { t: "object", props: { d: { t: "number" } } } } }, always: ["a"] }))
      .toEqual([{ name: "a", type: "group", always: true }, { name: "a.b", type: "date", always: true }, { name: "c", type: "list of groups", always: false }, { name: "c[].d", type: "number", always: false }]);
  });
  it("says what was removed for being a secret", () => {
    expect(removedWords("request header Authorization removed (secret)")).toBe("We removed the Authorization header; secrets are never kept.");
    expect(removedWords("body field password removed (secret)")).toBe("We removed password; secrets are never kept.");
  });
});

describe("checking what a person typed", () => {
  it("prefills the request from the operation", () => {
    expect(JSON.parse(requestTemplate(OP))).toEqual({ method: "GET", path: "/orders/{orderId}", pathValues: { orderId: "" }, query: {}, headers: {}, body: null });
    expect(JSON.parse(requestTemplate(OP2)).body).toEqual({});
  });
  it("turns a request and an answer into an example, and names what is wrong", () => {
    const req = JSON.stringify({ method: "get", path: "/orders/7", pathValues: { orderId: 7 }, headers: { "X-Trace": "1" } });
    expect(operationExample(OP, req, '{"status":200,"body":{"id":7}}', " found ", "")).toEqual({ example: { kind: "operation", operation: OP.operation, name: "found",
      request: { method: "GET", path: "/orders/7", pathParams: { orderId: "7" }, query: {}, headers: { "X-Trace": "1" }, body: null }, response: { status: 200, body: { id: 7 } } } });
    expect(operationExample(undefined, req, "{}", "", "")).toMatchObject({ on: "operation" });
    expect(operationExample(OP, "{method: GET", "{}", "", "")).toMatchObject({ on: "request", problem: expect.stringMatching(/not written correctly/) });
    expect(operationExample(OP, JSON.stringify({ method: "GET", path: "/orders/7", pathValues: { orderId: "" } }), '{"status":200}', "", "")).toMatchObject({ problem: "Give a value for orderId in pathValues." });
    expect(operationExample(OP, req, '{"status":"ok"}', "", "")).toMatchObject({ on: "response", problem: expect.stringMatching(/between 100 and 599/) });
    expect(stepExample(VIEW.todoSteps![0], '{"amount":"5"}', '{"total":5}', "", "")).toEqual({ example: { kind: "step", step: "T-aaaa1111", input: { amount: "5" }, output: { total: 5 } } });
    expect(stepExample(VIEW.todoSteps![0], "", "{}", "", "")).toMatchObject({ on: "input", problem: "Write the input." });
  });
  it("reads a file of examples", () => {
    const r = examplesFromFile(JSON.stringify({ examples: [{ operation: OP.operation, request: { method: "GET", path: "/orders/1", pathValues: { orderId: "1" } }, response: { status: 404 } }] }));
    expect(r).toEqual({ examples: [{ kind: "operation", operation: OP.operation, request: { method: "GET", path: "/orders/1", pathParams: { orderId: "1" } }, response: { status: 404 } }] });
    expect(examplesFromFile("[]")).toEqual({ problem: "The file has no examples." });
    expect(examplesFromFile("nope")).toMatchObject({ problem: expect.stringMatching(/not written correctly/) });
    expect(examplesFromFile('[{"operation":"GET /x"}]')).toMatchObject({ problem: "Example 1 needs operation, request and response." });
  });
});

describe("test data panel", () => {
  it("lists the examples of each operation, what was removed, the fields and the suggestions", async () => {
    stub();
    mount(mig());
    const ops = await screen.findAllByTestId("td-operation");
    expect(ops.map((o) => o.getAttribute("data-operation"))).toEqual([OP.operation, OP2.operation]);
    expect(within(ops[0]).getByTestId("td-example").textContent).toMatch(/order found · answer 200/);
    expect(within(ops[0]).getByTestId("td-example-removed").textContent).toBe("We removed the Authorization header; secrets are never kept.");
    expect(ops[1].textContent).toMatch(/No examples yet/);
    const fields = screen.getByTestId("td-fields").textContent!;
    expect(fields).toMatch(/orderId: whole number/);
    expect(fields).toMatch(/placed: date and time/);
    expect(fields).toMatch(/paid: yes\/no/);
    expect(fields).toMatch(/lines: list of groups/);
    expect(fields).toMatch(/lines\[\]\.sku: text/);
    expect(fields).toMatch(/coupon: text, can be empty \(not in every example\)/);
    const sugg = await screen.findAllByTestId("td-suggestion");
    expect(sugg[0].textContent).toMatch(/Suggested from your test data/);
    expect(within(sugg[0]).getByTestId("td-suggestion-rules").textContent).toMatch(/total is amount as a number/);
    expect(within(sugg[0]).getByTestId("td-suggestion-code").textContent).toMatch(/Number\(input\.amount\)/);
    // no technical words on the screen
    expect(screen.getByTestId("test-data").textContent).not.toMatch(/schema|payload|contract/i);
  });

  it("adds an example from the prefilled request and says the documents are generated again", async () => {
    const calls = stub();
    mount(mig());
    await screen.findAllByTestId("td-operation");
    fireEvent.change(screen.getByTestId("td-operation-pick"), { target: { value: OP.operation } });
    const req = screen.getByTestId("td-request") as HTMLTextAreaElement;
    expect(JSON.parse(req.value).pathValues).toEqual({ orderId: "" });
    fireEvent.click(screen.getByTestId("td-save"));
    expect(screen.getByTestId("td-problem").textContent).toBe("Give a value for orderId in pathValues.");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    fireEvent.change(req, { target: { value: JSON.stringify({ method: "GET", path: "/orders/9", pathValues: { orderId: "9" }, query: {}, headers: { Authorization: "Bearer x" }, body: null }) } });
    fireEvent.change(screen.getByTestId("td-response"), { target: { value: '{"status":404,"body":{"error":"not found"}}' } });
    fireEvent.change(screen.getByTestId("td-name"), { target: { value: "unknown order" } });
    fireEvent.click(screen.getByTestId("td-save"));
    await screen.findByTestId("td-done");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toMatch(/\/api\/factory\/migrations\/m1\/examples$/);
    expect(post.body).toEqual({ examples: [{ kind: "operation", operation: OP.operation, name: "unknown order",
      request: { method: "GET", path: "/orders/9", pathParams: { orderId: "9" }, query: {}, headers: { Authorization: "Bearer x" }, body: null }, response: { status: 404, body: { error: "not found" } } }] });
    expect(screen.getByTestId("td-done").textContent).toMatch(/1 example kept\./);
    expect(screen.getByTestId("td-rerun").textContent).toMatch(/documents and the project are being generated again/);
  });

  it("says in plain words when the request is not written correctly", async () => {
    const calls = stub();
    mount(mig());
    await screen.findAllByTestId("td-operation");
    fireEvent.change(screen.getByTestId("td-operation-pick"), { target: { value: OP2.operation } });
    fireEvent.change(screen.getByTestId("td-request"), { target: { value: "{ method: POST" } });
    fireEvent.click(screen.getByTestId("td-save"));
    expect(screen.getByTestId("td-problem").textContent).toMatch(/The request is not written correctly.*quotes, commas and brackets/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("adds an example for one TODO step", async () => {
    const calls = stub();
    mount(mig());
    await screen.findAllByTestId("td-operation");
    fireEvent.click(screen.getByTestId("td-mode-step"));
    fireEvent.change(screen.getByTestId("td-step-pick"), { target: { value: "T-aaaa1111" } });
    fireEvent.change(screen.getByTestId("td-input"), { target: { value: '{"amount":"12.5"}' } });
    fireEvent.change(screen.getByTestId("td-output"), { target: { value: '{"total":12.5,"currency":"SAR"}' } });
    fireEvent.click(screen.getByTestId("td-save"));
    await screen.findByTestId("td-done");
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ examples: [{ kind: "step", step: "T-aaaa1111", input: { amount: "12.5" }, output: { total: 12.5, currency: "SAR" } }] });
  });

  it("removes an example", async () => {
    const calls = stub(() => json({ ok: true, applied: 1, rerun: true, changes: [{ id: "E-11111111", action: "removed", kind: "operation", summary: "order found" }] }, 202));
    mount(mig());
    const ex = await screen.findByTestId("td-example");
    fireEvent.click(within(ex).getByTestId("td-remove"));
    await screen.findByTestId("td-done");
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ examples: [{ kind: "operation", id: "E-11111111", delete: true }] });
    expect(screen.getByTestId("td-done").textContent).toMatch(/removed: order found/);
  });

  it("shows the rows the tool did not accept", async () => {
    stub(() => json({ ok: false, error: "1 example was not accepted.", errors: [{ id: "E-new", problem: "No such operation." }] }, 422));
    mount(mig());
    await screen.findAllByTestId("td-operation");
    fireEvent.change(screen.getByTestId("td-operation-pick"), { target: { value: OP2.operation } });
    fireEvent.click(screen.getByTestId("td-save"));
    await screen.findByTestId("td-error");
    expect(screen.getByTestId("td-error").textContent).toMatch(/One example was not accepted\. Nothing was saved/);
    expect(screen.getByTestId("td-row-errors").textContent).toMatch(/No such operation\./);
  });

  it("accepts a suggestion through the decisions answers, never by itself", async () => {
    const calls = stub((url) => (url.endsWith("/decisions") ? json({ ok: true, applied: 1 }) : json({ ok: true }, 202)));
    mount(mig());
    const sugg = await screen.findAllByTestId("td-suggestion");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    fireEvent.click(within(sugg[0]).getByTestId("td-accept"));
    await screen.findByTestId("td-accept-done");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toMatch(/\/api\/factory\/migrations\/m1\/decisions$/);
    expect(posts[0].body).toEqual({ answers: [{ id: "T-aaaa1111", answer: { type: "code", language: "javascript", text: "return { total: Number(input.amount), currency: 'SAR' };" }, scope: "api", note: "Suggested from your test data (E-22222222)" }] });
    await waitFor(() => expect(within(screen.getAllByTestId("td-suggestion")[0]).getByTestId("td-accept")).toBeDisabled());
  });

  it("says plainly when nothing could be worked out for a step", async () => {
    stub();
    mount(mig());
    const sugg = await screen.findAllByTestId("td-suggestion");
    expect(sugg[1].getAttribute("data-status")).toBe("nothing");
    expect(within(sugg[1]).getByTestId("td-suggestion-why").textContent).toBe("We could not work out this step from your test data. There is no example for this step yet.");
    expect(within(sugg[1]).queryByTestId("td-accept")).toBeNull();
  });

  it("says the tool's refusal in its words, and stays away before the documents exist", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "A step of this migration is running." }, 409)));
    mount(mig());
    expect((await screen.findByTestId("td-load-error")).textContent).toBe("A step of this migration is running.");
    cleanup();
    stub();
    mount(mig({ phases: [] }));
    expect(screen.queryByTestId("test-data")).toBeNull();
  });
});

describe("check and correct", () => {
  it("links to the test data next to the other ways of correcting", () => {
    const open = vi.fn();
    render(<CheckCorrect m={mig({ decisionsCounts: { open: 2, answered: 0 } })} open={open} />);
    const box = screen.getByTestId("check-correct");
    expect(within(box).getByTestId("cc-mapping")).toBeTruthy();
    expect(within(box).getByTestId("cc-workbook")).toBeTruthy();
    expect(within(box).getByTestId("cc-decisions").textContent).toBe("Answer the open decisions (2)");
    expect(within(box).getByTestId("cc-documents")).toBeTruthy();
    const link = within(box).getByTestId("cc-testdata");
    expect(link.textContent).toBe("Give test data (requests and the answers you expect)");
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith("testdata");
  });
});

describe("test data is offered for a service built from a requirements document", () => {
  const done = [{ key: "document", status: "done" }] as Migration["phases"];
  it("shows once the documents are written, whatever the source", () => {
    expect(showTestData(mig({ phases: done }))).toBe(true);
    expect(showTestData(mig({ phases: done, sourceType: "requirements" } as Partial<Migration>))).toBe(true);
  });
  it("stays hidden before the documents exist and for a checked-only package", () => {
    expect(showTestData(mig({ phases: [] }))).toBe(false);
    expect(showTestData(mig({ phases: done, apiName: null }))).toBe(false);
    expect(showTestData(mig({ phases: done, checkOnly: true }))).toBe(false);
  });
});
