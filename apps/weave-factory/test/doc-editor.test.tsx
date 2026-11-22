// Editing a generated document (server calls are stand-ins).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocEditor, editable, editedLabel, saveError } from "../src/migrate/DocEditor.tsx";

type Call = { url: string; method: string; body?: unknown };
function stub(answer: (method: string) => Response, source = "# Mapping\n| a | b |\n") {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(input), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET") return new Response(source, { status: 200, headers: { "content-type": "text/plain" } });
    return answer(method);
  }));
  return calls;
}
function mount(edit?: { doc: string; by?: string; at?: string }, m = { id: "m1" }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn();
  render(<QueryClientProvider client={qc}><DocEditor m={m} name="MAPPING.md" edit={edit} onClose={onClose} /></QueryClientProvider>);
  return onClose;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("document editor", () => {
  it("offers only markdown documents and says who edited one", () => {
    expect(editable("MAPPING.md")).toBe(true);
    expect(editable("analysis.json")).toBe(false);
    expect(editedLabel({ doc: "MAPPING.md", by: "anna" })).toBe("Edited by anna");
    expect(saveError(Object.assign(new Error("x"), { status: 413 }))).toMatch(/larger than 2 MB/);
    expect(saveError(Object.assign(new Error("x"), { status: 409, body: {} }))).toMatch(/step of this migration is running/);
  });
  it("loads the text, saves the changes with a note and says the migration is rebuilt", async () => {
    const calls = stub(() => json(200, { ok: true }));
    mount();
    const box = await screen.findByTestId("doc-editor-text") as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("# Mapping\n| a | b |\n"));
    expect(screen.getByTestId("doc-editor-explain").textContent).toBe("Your version replaces the generated document and is kept when the migration is rebuilt. Changes to the mapping table are also applied to the generated code.");
    expect(screen.getByTestId("doc-editor-save")).toBeDisabled();
    expect(screen.queryByTestId("doc-editor-revert")).toBeNull();
    fireEvent.change(box, { target: { value: "# Mapping\n| a | c |\n" } });
    fireEvent.change(screen.getByTestId("doc-editor-note"), { target: { value: "b is c" } });
    fireEvent.click(screen.getByTestId("doc-editor-save"));
    await waitFor(() => expect(screen.getByTestId("doc-editor-done").textContent).toMatch(/being rebuilt/));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toContain("/api/factory/migrations/m1/documents/MAPPING.md/source");
    expect(put.body).toEqual({ text: "# Mapping\n| a | c |\n", note: "b is c" });
  });
  it("says in words why a change was refused", async () => {
    stub(() => json(422, { error: "The mapping table could not be read.", errors: [{ line: 3, problem: "a row needs 4 columns" }] }));
    mount();
    const box = await screen.findByTestId("doc-editor-text");
    await waitFor(() => expect((box as HTMLTextAreaElement).value).not.toBe(""));
    fireEvent.change(box, { target: { value: "changed" } });
    fireEvent.click(screen.getByTestId("doc-editor-save"));
    await waitFor(() => expect(screen.getByTestId("doc-editor-error").textContent).toBe("The mapping table could not be read. Line 3: a row needs 4 columns"));
  });
  it("goes back to the generated version after asking", async () => {
    const calls = stub(() => json(200, { ok: true }));
    mount({ doc: "MAPPING.md", by: "anna" });
    await screen.findByTestId("doc-editor-text");
    expect(screen.getByText("Edited by anna")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("doc-editor-revert"));
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/documents/MAPPING.md/source"))).toBe(true));
    await waitFor(() => expect(screen.getByTestId("doc-editor-done").textContent).toMatch(/generated version/));
  });
  it("closes on Cancel and is locked while a step runs", async () => {
    stub(() => json(200, {}));
    const onClose = mount(undefined, { id: "m1", busy: true } as { id: string });
    await screen.findByTestId("doc-editor-busy");
    expect(screen.getByTestId("doc-editor-text")).toBeDisabled();
    fireEvent.click(screen.getByTestId("doc-editor-cancel"));
    expect(onClose).toHaveBeenCalled();
  });
});
