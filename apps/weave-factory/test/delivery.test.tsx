// The download panel of a project for another platform: the package to import comes first;
// Boomi and Workato projects can also be imported straight into the saved account.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Delivery, canImport, hasPackage, importStatus, packageLabel } from "../src/migrate/Delivery.tsx";
import type { Migration } from "../src/api.ts";

const mig = (over: Partial<Migration> = {}): Migration => ({ id: "m1", name: "pay", apiName: "pay-api", targetTech: "workato", serviceDir: "services/pay-api", phases: [], progress: { overallPercent: 60, majorPhase: "Test", done: false, outcome: "In progress" }, ...over });
function mount(m: Migration) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><Delivery m={m} /></MemoryRouter></QueryClientProvider>);
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body?: any };
function stub(accounts: unknown[], answer: (c: Call) => Response = () => json(202, { ok: true })) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const c = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    if (c.method === "GET" && c.url.includes("/target-accounts")) return json(200, accounts);
    return answer(c);
  }));
  return calls;
}
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("delivery panel", () => {
  it("puts the Workato import package first and marks the project download as not for importing", () => {
    stub([]);
    mount(mig());
    const pkg = screen.getByTestId("delivery-package");
    expect(pkg.textContent).toBe("Workato import package (.zip)");
    expect(pkg.className).toContain("mf-mg-btn-pri");
    const project = screen.getByTestId("delivery-project");
    expect(project.className).not.toContain("mf-mg-btn-pri");
    expect(screen.getByTestId("delivery-project-note").textContent).toBe("documents, tests and settings — not for importing");
    expect(pkg.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("names the package of other platforms after the platform", () => {
    stub([]);
    expect(packageLabel(mig({ targetTech: "webmethods" }))).toBe("webMethods package (.zip)");
    expect(hasPackage(mig({ targetTech: "springboot" }))).toBe(false);
    expect(hasPackage(mig({ targetTech: "springboot", packageFile: "app.zip" }))).toBe(true);
    expect(hasPackage(mig({ targetTech: "wso2" }))).toBe(false);
    mount(mig({ targetTech: "springboot" }));
    expect(screen.queryByTestId("delivery-package")).toBeNull();
    expect(screen.queryByTestId("delivery-project-note")).toBeNull();
    expect(screen.queryByTestId("delivery-import")).toBeNull();
    expect(screen.getByTestId("delivery-project")).toBeInTheDocument();
  });
  it("says in words when there is no package", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "This Workato project has no package to import." }), { status: 404, headers: { "content-type": "application/json" } })));
    mount(mig());
    fireEvent.click(screen.getByTestId("delivery-package"));
    await waitFor(() => expect(screen.getByTestId("delivery-package-error").textContent).toBe("This Workato project has no package to import."));
  });
});

describe("import into the target platform", () => {
  it("is offered for Boomi and Workato projects only", () => {
    expect(canImport(mig({ targetTech: "boomi" }))).toBe(true);
    expect(canImport(mig())).toBe(true);
    expect(canImport(mig({ targetTech: "mule" }))).toBe(false);
    expect(canImport(mig({ targetTech: "boomi", serviceDir: undefined }))).toBe(false);
  });
  it("says the last import in plain words", () => {
    expect(importStatus({ status: "imported", created: 140, total: 140, folder: "FLT_webMethods_Regression" }, "Boomi")?.text).toBe("Imported 140 of 140 components into Boomi folder FLT_webMethods_Regression.");
    expect(importStatus({ status: "partial", created: 138, total: 140, folder: "F" }, "Boomi")).toEqual({ tone: "warn", text: "Imported 138 of 140 components into Boomi folder F. 2 could not be imported." });
    expect(importStatus({ status: "failed", created: 0, total: 3 }, "Workato")).toEqual({ tone: "bad", text: "Nothing was imported into Workato." });
    expect(importStatus(null, "Boomi")).toBeNull();
  });
  it("shows the result with each failure and the platform's reason, and never mentions deploying", async () => {
    stub([{ target: "boomi", configured: true }]);
    mount(mig({ targetTech: "boomi", importResult: { target: "boomi", status: "partial", created: 1, total: 2, folder: "FLT", failures: [{ component: "Send order", file: "processes/send.xml", reason: "Connection 'SAP' does not exist in the account." }] } }));
    expect(screen.getByText("Import into Boomi")).toBeInTheDocument();
    expect(screen.getByTestId("delivery-import-status").textContent).toMatch(/Imported 1 of 2 components into Boomi folder FLT/);
    expect(screen.getByTestId("delivery-import-failures").textContent).toBe("Send order (processes/send.xml): Connection 'SAP' does not exist in the account.");
    expect(screen.getByTestId("delivery-import-note").textContent).toBe("Nothing is deployed or switched on: schedules and listeners stay off.");
    expect(screen.getByTestId("delivery-import").textContent).not.toMatch(/deploy(?!ed or switched)/i);
  });
  it("starts an import and switches automatic import", async () => {
    const calls = stub([{ target: "workato", configured: true }]);
    mount(mig());
    await waitFor(() => expect(screen.getByTestId("delivery-import-now")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("delivery-import-now"));
    await waitFor(() => expect(screen.getByTestId("delivery-import-started").textContent).toMatch(/import into Workato has started/));
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/factory/migrations/m1/import"))).toBe(true);
    const box = screen.getByTestId("delivery-import-auto") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/factory/migrations/m1/options"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/options"))!.body).toEqual({ autoImport: true });
    expect(box.checked).toBe(true);
  });
  it("puts the switch back and says why when it cannot be changed", async () => {
    stub([{ target: "workato", configured: true }], (c) => (c.url.endsWith("/options") ? json(409, { error: "A step of this migration is running." }) : json(202, {})));
    mount(mig({ autoImport: true }));
    const box = screen.getByTestId("delivery-import-auto") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(screen.getByTestId("delivery-import-auto-error").textContent).toBe("A step of this migration is running."));
    expect(box.checked).toBe(true);
  });
  it("points to the target platform settings when no account is set up", async () => {
    stub([{ target: "boomi", configured: false }]);
    mount(mig({ targetTech: "boomi" }));
    const note = await screen.findByTestId("delivery-import-noaccount");
    expect(note.textContent).toMatch(/No Boomi account is set up yet/);
    expect(note.querySelector("a")?.getAttribute("href")).toBe("/workspaces#target-platforms");
    expect(screen.getByTestId("delivery-import-now")).toBeDisabled();
  });
  it("shows a 400 refusal of the tool in its words", async () => {
    stub([{ target: "boomi", configured: true }], () => json(400, { error: "The project has not been generated yet." }));
    mount(mig({ targetTech: "boomi" }));
    await waitFor(() => expect(screen.getByTestId("delivery-import-now")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("delivery-import-now"));
    await waitFor(() => expect(screen.getByTestId("delivery-import-error").textContent).toBe("The project has not been generated yet."));
  });
});
