// "Open decisions" panel (server calls are stand-ins).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Decisions, answerOf, buildAnswers, draftOf, servicesOf, type Draft } from "../src/migrate/Decisions.tsx";
import type { AgentDecision, Migration } from "../src/api.ts";

const mig = (over: Partial<Migration> = {}): Migration => ({ id: "m1", name: "orders", apiName: "orders-api", phases: [], progress: { overallPercent: 40, majorPhase: "Generate", done: false, outcome: "In progress" }, ...over });
const DECISIONS: AgentDecision[] = [
  { id: "d1", flow: "ProcessOrder", where: "step 4: Send to SAP", source: "flows/order.xml:42", kind: "connector", construct: "sap:execute-rfc", summary: "Sends the order to SAP.", why: "No SAP connector is known for this target.",
    answerTypes: ["connector", "manual"], options: [{ connector: "sap", operation: "rfc-call", label: "SAP · call an RFC" }, { connector: "http", operation: "post", label: "HTTP · POST" }], answer: null },
  { id: "d2", flow: "ProcessOrder", where: "step 6: Price", source: "flows/order.xml:77", kind: "java", construct: "com.acme.Price#compute", summary: "Works out the price.", why: "Java code cannot be read.", answerTypes: ["code", "expression", "drop"], answer: null },
  { id: "d3", flow: "Nightly", where: "step 1", source: "flows/nightly.xml:3", kind: "dynamic-call", summary: "Calls a service chosen at run time.", why: "The service name is only known while running.", answerTypes: ["call"],
    answer: { type: "call", services: ["billing", "ledger"] }, answeredBy: "anna", answeredAt: "2026-11-20T10:00:00Z", scope: "workspace" },
];
const VIEW = { api: "orders-api", decisions: DECISIONS, counts: { open: 2, answered: 1 } };

type Call = { url: string; method: string; body?: unknown };
function stub(post: (body: any) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST") return post(JSON.parse(String(init!.body)));
    return new Response(JSON.stringify(VIEW), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}
function mount(m: Migration) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Decisions m={m} /></QueryClientProvider>);
}
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("answers", () => {
  const base = (p: Partial<Draft>): Draft => ({ type: "manual", option: "", text: "", language: "java", services: "", dropOk: false, scope: "api", note: "", ...p });
  it("turns each kind of answer into what the tool takes", () => {
    expect(answerOf(base({ type: "connector", option: "sap\u0000rfc-call" }))).toEqual({ answer: { type: "connector", connector: "sap", operation: "rfc-call" } });
    expect(answerOf(base({ type: "expression", text: "  price * 1.2 " }))).toEqual({ answer: { type: "expression", text: "price * 1.2" } });
    expect(answerOf(base({ type: "code", language: "groovy", text: "return 1" }))).toEqual({ answer: { type: "code", language: "groovy", text: "return 1" } });
    expect(answerOf(base({ type: "call", services: "billing, ledger\nbilling\n" }))).toEqual({ answer: { type: "call", services: ["billing", "ledger"] } });
    expect(answerOf(base({ type: "drop", dropOk: true }))).toEqual({ answer: { type: "drop" } });
    expect(answerOf(base({ type: "manual" }))).toEqual({ answer: { type: "manual" } });
    expect(servicesOf(" a ,b\n\n a")).toEqual(["a", "b"]);
  });
  it("names what is missing instead of sending it", () => {
    expect(answerOf(base({ type: "connector" }))).toEqual({ problem: "Choose the connector to use." });
    expect(answerOf(base({ type: "drop" }))).toEqual({ problem: "Tick the box to confirm the step can be removed." });
    const r = buildAnswers({ d1: base({ type: "connector", option: "http\u0000post", scope: "workspace", note: " fits " }), d2: base({ type: "code" }) }, DECISIONS);
    expect(r.answers).toEqual([{ id: "d1", answer: { type: "connector", connector: "http", operation: "post" }, scope: "workspace", note: "fits" }]);
    expect(r.problems).toEqual({ d2: "Write the code." });
  });
  it("starts a draft from the saved answer", () => {
    const d = draftOf(DECISIONS[2]);
    expect(d.type).toBe("call");
    expect(d.services).toBe("billing\nledger");
    expect(d.scope).toBe("workspace");
  });
});

describe("open decisions panel", () => {
  it("shows the open decisions with where, what and why, and the answered ones collapsed", async () => {
    stub(() => new Response("{}"));
    mount(mig());
    await screen.findAllByTestId("decision");
    expect(screen.getByTestId("decisions").textContent).toMatch(/needs a person's choice/);
    let cards = screen.getAllByTestId("decision");
    expect(cards.map((c) => c.getAttribute("data-decision"))).toEqual(["d1", "d2"]);
    expect(cards[0].textContent).toMatch(/ProcessOrder · step 4: Send to SAP/);
    expect(cards[0].textContent).toMatch(/flows\/order\.xml:42/);
    expect(cards[0].textContent).toMatch(/Connector step/);
    expect(cards[1].textContent).toMatch(/Java code/);
    expect(within(cards[0]).getByTestId("decision-why").textContent).toMatch(/No SAP connector/);
    fireEvent.click(screen.getByRole("radio", { name: /Answered/ }));
    cards = screen.getAllByTestId("decision");
    expect(cards).toHaveLength(1);
    expect(within(cards[0]).getByTestId("decision-answered").textContent).toMatch(/Call billing, ledger — Answered by anna on/);
    expect(screen.getByTestId("decisions-save")).toBeDisabled();
  });
  it("sends every changed answer in one request and says the migration is rebuilt", async () => {
    const calls = stub(() => new Response(JSON.stringify({ ok: true, applied: 2 }), { status: 200, headers: { "content-type": "application/json" } }));
    mount(mig());
    await screen.findAllByTestId("decision");
    const [c1, c2] = screen.getAllByTestId("decision");
    fireEvent.change(within(c1).getByTestId("decision-connector"), { target: { value: "sap\u0000rfc-call" } });
    fireEvent.click(within(c2).getByRole("radio", { name: "Write an expression" }));
    fireEvent.change(within(c2).getByTestId("decision-expression"), { target: { value: "qty * unitPrice" } });
    fireEvent.click(within(c2).getByTestId("decision-scope-workspace"));
    fireEvent.change(within(c2).getByTestId("decision-note"), { target: { value: "same rule everywhere" } });
    fireEvent.click(screen.getByTestId("decisions-save"));
    await waitFor(() => expect(screen.getByTestId("decisions-done").textContent).toBe("2 answers saved. The migration is being rebuilt with them."));
    const post = calls.filter((c) => c.method === "POST");
    expect(post).toHaveLength(1);
    expect(post[0].url).toContain("/api/factory/migrations/m1/decisions");
    expect(post[0].body).toEqual({ answers: [
      { id: "d1", answer: { type: "connector", connector: "sap", operation: "rfc-call" }, scope: "api" },
      { id: "d2", answer: { type: "expression", text: "qty * unitPrice" }, scope: "workspace", note: "same rule everywhere" },
    ] });
  });
  it("shows the rows the tool refused next to their cards", async () => {
    stub(() => new Response(JSON.stringify({ errors: [{ id: "d2", problem: "The expression does not compile: unknown field unitPrice." }] }), { status: 422, headers: { "content-type": "application/json" } }));
    mount(mig());
    await screen.findAllByTestId("decision");
    const c2 = screen.getAllByTestId("decision")[1];
    fireEvent.change(within(c2).getByTestId("decision-code"), { target: { value: "return qty * unitPrice;" } });
    fireEvent.click(screen.getByTestId("decisions-save"));
    await waitFor(() => expect(within(screen.getAllByTestId("decision")[1]).getByTestId("decision-error").textContent).toMatch(/does not compile/));
    expect(screen.getByTestId("decisions-error").textContent).toMatch(/1 answer was not accepted. Nothing was saved/);
  });
  it("marks an incomplete answer without sending anything", async () => {
    const calls = stub(() => new Response("{}"));
    mount(mig());
    await screen.findAllByTestId("decision");
    const c2 = screen.getAllByTestId("decision")[1];
    fireEvent.click(within(c2).getByRole("radio", { name: "Remove this step" }));
    expect(within(c2).getByText("Remove this step (owner confirmed)")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("decisions-save"));
    expect(within(screen.getAllByTestId("decision")[1]).getByTestId("decision-error").textContent).toMatch(/Tick the box/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
  it("says a step is running and keeps the answers from being saved", async () => {
    stub(() => new Response("{}"));
    mount(mig({ busy: true }));
    await screen.findByTestId("decisions-busy");
    expect(within(screen.getAllByTestId("decision")[0]).getByTestId("decision-connector")).toBeDisabled();
  });
  it("is hidden when the tool has no decisions for this migration", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ decisions: [] }), { status: 200, headers: { "content-type": "application/json" } })));
    const { container } = mount(mig());
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });
});
