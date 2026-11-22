// "Target platforms": Boomi and Workato accounts (server calls are stand-ins). Tokens are never shown.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TargetPlatforms, centerOf } from "../src/screens/TargetPlatforms.tsx";

const SECRET = "tok-9f8e7d6c5b4a-SECRET";
type Call = { url: string; method: string; body?: any };
function stub(accounts: unknown[], answer: (c: Call) => Response = () => json(200, { ok: true })) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const c = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    if (c.method === "GET") return json(200, { accounts });
    return answer(c);
  }));
  return calls;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TargetPlatforms /></QueryClientProvider>);
}
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("target platforms", () => {
  it("knows the Workato data center of a saved address", () => {
    expect(centerOf("https://app.eu.workato.com/api")).toBe("https://app.eu.workato.com");
    expect(centerOf("")).toBe("https://www.workato.com");
  });
  it("shows a saved account masked and never renders a token", async () => {
    // even if a token ever came back, it must not reach the page
    stub([{ target: "boomi", configured: true, accountId: "acme-****CD12", user: "a***@acme.com", token: SECRET, updated: "2026-11-21T09:00:00Z", updatedBy: "anna" }, { target: "workato", configured: false }]);
    const { container } = mount();
    const boomi = await screen.findByTestId("target-boomi-saved");
    expect(boomi.textContent).toMatch(/acme-\*\*\*\*CD12/);
    expect(boomi.textContent).toMatch(/set \(not shown\)/);
    expect(container.innerHTML).not.toContain(SECRET);
    for (const el of container.querySelectorAll("input")) expect((el as HTMLInputElement).value).not.toContain(SECRET);
    expect((screen.getByTestId("boomi-token") as HTMLInputElement).type).toBe("password");
    expect(within(screen.getByTestId("target-workato")).getByText("Not set up")).toBeInTheDocument();
    expect(screen.getByTestId("target-workato-testbtn")).toBeDisabled();
    expect(screen.getByTestId("target-platforms").textContent).toMatch(/Platform API Tokens/);
    expect(screen.getByTestId("target-platforms").textContent).toMatch(/Recipe lifecycle management/);
  });
  it("tests the connection and shows the platform's message", async () => {
    const calls = stub([{ target: "boomi", configured: true, accountId: "acme-****CD12", user: "a***@acme.com" }], () => json(200, { ok: false, message: "Boomi refused the token: 401 Unauthorized." }));
    mount();
    await screen.findByTestId("target-boomi-saved");
    fireEvent.click(screen.getByTestId("target-boomi-testbtn"));
    await waitFor(() => expect(screen.getByTestId("target-boomi-test").textContent).toBe("Boomi refused the token: 401 Unauthorized."));
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/factory/target-accounts/boomi/test"))).toBe(true);
  });
  it("saves a Workato account with the chosen data center and clears the token field", async () => {
    const calls = stub([{ target: "workato", configured: false }]);
    mount();
    const card = await screen.findByTestId("target-workato");
    fireEvent.click(within(card).getByTestId("target-workato-save"));
    expect(screen.getByTestId("target-workato-problem").textContent).toMatch(/Paste the API token/);
    fireEvent.change(screen.getByTestId("workato-center"), { target: { value: "https://app.eu.workato.com" } });
    fireEvent.change(screen.getByTestId("workato-token"), { target: { value: SECRET } });
    fireEvent.change(screen.getByTestId("workato-folder"), { target: { value: "12345" } });
    fireEvent.click(within(card).getByTestId("target-workato-save"));
    await waitFor(() => expect(screen.getByTestId("target-workato-saved-note")).toBeInTheDocument());
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toContain("/api/factory/target-accounts/workato");
    expect(put.body).toEqual({ apiBase: "https://app.eu.workato.com", token: SECRET, parentFolderId: "12345" });
    expect((screen.getByTestId("workato-token") as HTMLInputElement).value).toBe("");
  });
  it("keeps the saved Boomi token when the field is left empty", async () => {
    const calls = stub([{ target: "boomi", configured: true, accountId: "acme-****CD12", user: "a***@acme.com" }]);
    mount();
    await screen.findByTestId("target-boomi-saved");
    fireEvent.change(screen.getByTestId("boomi-accountId"), { target: { value: "acme-AB12CD" } });
    fireEvent.change(screen.getByTestId("boomi-user"), { target: { value: "ops@acme.com" } });
    fireEvent.click(screen.getByTestId("target-boomi-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ accountId: "acme-AB12CD", user: "ops@acme.com", token: "" });
  });
  it("removes an account after asking", async () => {
    const calls = stub([{ target: "boomi", configured: true, accountId: "acme-****CD12", user: "a***@acme.com" }]);
    mount();
    await screen.findByTestId("target-boomi-saved");
    fireEvent.click(screen.getByTestId("target-boomi-remove"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/api/factory/target-accounts/boomi"))).toBe(true));
  });
});
