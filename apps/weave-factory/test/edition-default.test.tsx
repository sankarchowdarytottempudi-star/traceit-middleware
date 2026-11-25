// The default (TraceIT) edition keeps every source technology, every target, "From requirements" and the
// Boomi / Workato accounts. The Cruise Saudi edition is covered by edition-cruise-saudi.test.tsx.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourceWays } from "../src/migrate/ui.tsx";
import { migrateRoutes } from "../src/migrate/routes.tsx";
import * as edition from "../src/lib/edition.ts";

vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const OPTIONS = {
  technologies: [{ id: "auto", label: "Detect automatically", upload: "A .zip" }, { id: "mule4", label: "MuleSoft (Mule 4)", upload: "A .zip" }, { id: "boomi", label: "Boomi", upload: "A .zip" }],
  targets: [{ id: "wso2", label: "WSO2 (Ballerina service)", depth: "full", maturity: "complete", hint: "" }, { id: "workato", label: "Workato", depth: "partial", maturity: "complete-unverified", hint: "" }],
  extensions: [".zip"], maxUploadMb: 500, singleFileExtensions: [], singleFileMb: 10,
  paste: { technologies: [{ id: "auto", label: "Detect from the code" }, { id: "mule4", label: "MuleSoft" }], maxSnippets: 20, maxSnippetKb: 1024, maxTotalKb: 2048 },
};
function mount(path: string) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/migrate/options")) return json(OPTIONS);
    if (url.endsWith("/workspaces")) return json({ workspaces: [] });
    if (url.endsWith("/target-accounts")) return json([]);
    return json({});
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><Routes>{migrateRoutes()}</Routes></MemoryRouter></QueryClientProvider>);
}

describe("default edition: every source and target", () => {
  it("offers everything the server lists", () => {
    expect(edition.MULE_TO_WSO2_ONLY).toBe(false);
    expect(edition.DEFAULT_SOURCE).toBe("auto");
    expect(edition.OFFERS_REQUIREMENTS).toBe(true);
    expect(edition.OFFERS_TARGET_PLATFORMS).toBe(true);
    expect(edition.offeredSources(OPTIONS.technologies)).toEqual(OPTIONS.technologies);
    expect(edition.offeredTargets(OPTIONS.targets)).toEqual(OPTIONS.targets);
  });
  it("New migration shows every technology and the target choice", async () => {
    mount("/migrations/new");
    await screen.findByText("Upload the source");
    expect(screen.getByRole("radio", { name: /Detect automatically/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Boomi/ })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Target" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Workato/ })).toBeInTheDocument();
    expect(screen.queryByTestId("fixed-target")).toBeNull();
  });
  it("offers From requirements", () => {
    render(<MemoryRouter><SourceWays way="upload" /></MemoryRouter>);
    expect(screen.getByRole("link", { name: /From requirements/ })).toHaveAttribute("href", "/migrations/from-requirements");
  });
  it("shows Target platforms on Workspaces", async () => {
    mount("/workspaces");
    expect(await screen.findByTestId("target-platforms")).toBeInTheDocument();
  });
});
