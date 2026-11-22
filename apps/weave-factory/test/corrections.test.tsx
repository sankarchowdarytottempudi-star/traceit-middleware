// "Correct the analysis" panel (server calls are stand-ins).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Corrections, correctable, countsText } from "../src/migrate/Corrections.tsx";
import type { Migration } from "../src/api.ts";

const mig = (over: Partial<Migration> = {}): Migration => ({ id: "m1", name: "orders", apiName: "orders-api", phases: [], progress: { overallPercent: 40, majorPhase: "Generate", done: false, outcome: "In progress" }, ...over });
function mount(m: Migration) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Corrections m={m} /></QueryClientProvider>);
}
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("correct the analysis", () => {
  it("is offered once documents exist and never for a checked-only package", () => {
    expect(correctable(mig())).toBe(true);
    expect(correctable(mig({ apiName: null }))).toBe(false);
    expect(correctable(mig({ checkOnly: true }))).toBe(false);
    const { container } = mount(mig({ checkOnly: true }));
    expect(container.innerHTML).toBe("");
  });
  it("says the counts in words", () => {
    expect(countsText({ changed: 2, added: 0, deleted: 1, marked: 0 })).toBe("2 changed, 1 deleted");
    expect(countsText({})).toBe("no rows changed");
  });
  it("explains the steps, waits for a file and shows earlier corrections", () => {
    mount(mig({ corrections: [{ at: "2026-11-20T10:00:00Z", by: "anna", applied: { changed: 3, added: 1, deleted: 0, marked: 0 } }] }));
    expect(screen.getByTestId("corrections-how").textContent).toMatch(/listed in the documents/);
    expect(screen.getByTestId("corrections-upload")).toBeDisabled();
    expect(screen.getByTestId("corrections-history").textContent).toMatch(/3 changed, 1 added/);
    expect(screen.getByTestId("corrections-history").textContent).toMatch(/anna/);
  });
  it("is closed while a step runs", () => {
    mount(mig({ busy: true }));
    expect(screen.getByTestId("corrections-download")).toBeDisabled();
    expect(screen.getByTestId("corrections-busy")).toBeInTheDocument();
  });
  it("says in words why the workbook cannot be downloaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "There are no documents yet." }), { status: 404, headers: { "content-type": "application/json" } })));
    mount(mig());
    fireEvent.click(screen.getByTestId("corrections-download"));
    await waitFor(() => expect(screen.getByTestId("corrections-download-error").textContent).toBe("There are no documents yet."));
  });
});
