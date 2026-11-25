// The Cruise Saudi edition (VITE_WEAVE_EDITION=cruise-saudi) offers MuleSoft (Mule 4) to WSO2 only.
// The edition is read when the modules load, so the whole file runs in that edition (set before the imports).
import { afterEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => { vi.stubEnv("VITE_WEAVE_EDITION", "cruise-saudi"); });
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MigrationNew } from "../src/migrate/MigrationNew.tsx";
import { SourceWays } from "../src/migrate/ui.tsx";
import { Delivery, canImport } from "../src/migrate/Delivery.tsx";
import { migrateRoutes } from "../src/migrate/routes.tsx";
import * as edition from "../src/lib/edition.ts";
import type { Migration } from "../src/api.ts";

vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// what a default server sends: every technology and every target
const OPTIONS = {
  technologies: [
    { id: "auto", label: "Detect automatically", upload: "A .zip or .jar of the project" },
    { id: "mule4", label: "MuleSoft (Mule 4)", upload: "The project folder as a .zip, or the deployable .jar" },
    { id: "boomi", label: "Boomi", upload: "The exported process components as a .zip" },
    { id: "java", label: "Java (Spring / JAX-RS)", upload: "The project folder as a .zip, or the .jar" },
    { id: "spec", label: "Written specification (no source code)", upload: "A .json file", sourceType: "spec" },
  ],
  targets: [
    { id: "wso2", label: "WSO2 (Ballerina service)", depth: "full", maturity: "complete", hint: "Complete generator." },
    { id: "mule", label: "MuleSoft", depth: "full", maturity: "complete", hint: "" },
    { id: "workato", label: "Workato", depth: "partial", maturity: "complete-unverified", hint: "" },
  ],
  extensions: [".zip", ".jar", ".json", ".xml"], maxUploadMb: 500, singleFileExtensions: [".xml"], singleFileMb: 10,
  paste: { technologies: [{ id: "auto", label: "Detect from the code" }, { id: "mule4", label: "MuleSoft (Mule 4 XML, DataWeave)" }, { id: "java", label: "Java" }], maxSnippets: 20, maxSnippetKb: 1024, maxTotalKb: 2048 },
};

function mount(path: string, calls: { url: string; init?: RequestInit }[] = [], workspaces: unknown[] = [{ name: "Shop" }]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/migrate/options")) return json(OPTIONS);
    if (url.endsWith("/workspaces")) return json({ workspaces });
    if (url.endsWith("/migrations/paste")) return json({ id: "m9", name: "Orders" }, 201);
    return json({});
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {migrateRoutes()}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Cruise Saudi edition: Mule 4 to WSO2 only", () => {
  it("knows its edition", () => {
    expect(edition.MULE_TO_WSO2_ONLY).toBe(true);
    expect(edition.DEFAULT_SOURCE).toBe("mule4");
    expect(edition.OFFERS_REQUIREMENTS).toBe(false);
    expect(edition.OFFERS_TARGET_PLATFORMS).toBe(false);
    expect(edition.offeredSources(OPTIONS.technologies).map((t) => t.id)).toEqual(["mule4"]);
    expect(edition.offeredTargets(OPTIONS.targets).map((t) => t.id)).toEqual(["wso2"]);
  });

  it("New migration offers MuleSoft only and a fixed WSO2 target", async () => {
    mount("/migrations/new");
    await screen.findByText("Upload the source");
    const sources = screen.getAllByRole("radio");
    expect(sources.map((r) => r.textContent)).toEqual([expect.stringContaining("MuleSoft (Mule 4)")]);
    expect(sources[0]).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText("Detect automatically")).toBeNull();
    expect(screen.queryByText("Boomi")).toBeNull();
    expect(screen.queryByText(/Written specification/)).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Target" })).toBeNull();
    expect(screen.getByTestId("fixed-target").textContent).toContain("WSO2 (Ballerina service)");
    expect(screen.queryByText("Workato")).toBeNull();
    expect(screen.queryByText(/TIBCO/)).toBeNull();
  });

  it("Paste code offers Mule only and sends technology mule4 and target wso2", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    mount("/migrations/paste", calls);
    await screen.findByText("Paste the code");
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual([expect.stringContaining("MuleSoft")]);
    expect(screen.queryByText("Detect from the code")).toBeNull();
    expect(screen.queryByText("Java")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Customer profile API"), { target: { value: "Orders" } });
    fireEvent.change(screen.getByLabelText("Code of piece 1"), { target: { value: "%dw 2.0\n---\n{}" } });
    fireEvent.click(screen.getByRole("button", { name: /Create the migration from the pasted code/ }));
    // (the migration detail screen of migrateRoutes() opens next)
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/migrations/paste"))).toBe(true));
    const post = calls.find((c) => c.url.endsWith("/migrations/paste"))!;
    expect(JSON.parse(String(post.init?.body))).toMatchObject({ target: "wso2", technology: "mule4" });
  });

  it("does not offer From requirements, and its address leads to New migration", async () => {
    render(<MemoryRouter><SourceWays way="upload" /></MemoryRouter>);
    expect(screen.queryByRole("link", { name: /From requirements/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Upload a file/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /From a git repository/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Paste code/ })).toBeInTheDocument();
    cleanup();
    mount("/migrations/from-requirements");
    await screen.findByText("Upload the source");
    expect(screen.queryByText("New service from requirements")).toBeNull();
  });

  it("has no Boomi / Workato delivery or import", () => {
    const m: Migration = { id: "m1", name: "pay", apiName: "pay-api", targetTech: "workato", serviceDir: "services/pay-api", phases: [], progress: { overallPercent: 60, majorPhase: "Test", done: false, outcome: "In progress" } } as Migration;
    expect(canImport(m)).toBe(false);
    const qc = new QueryClient();
    const { container } = render(<QueryClientProvider client={qc}><MemoryRouter><Delivery m={m} /></MemoryRouter></QueryClientProvider>);
    expect(container.textContent).toBe("");
  });

  it("hides Target platforms on Workspaces", async () => {
    mount("/workspaces", [], []);
    await screen.findByText("No workspaces yet");
    expect(screen.queryByTestId("target-platforms")).toBeNull();
    expect(screen.queryByText(/Boomi/)).toBeNull();
  });

  it("is the default edition again without the setting", async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    const plain = await import("../src/lib/edition.ts");
    expect(plain.MULE_TO_WSO2_ONLY).toBe(false);
    expect(plain.offeredSources(OPTIONS.technologies)).toHaveLength(5);
    vi.stubEnv("VITE_WEAVE_EDITION", "cruise-saudi");
    vi.resetModules();
    const cs = await import("../src/lib/edition.ts");
    expect(cs.MULE_TO_WSO2_ONLY).toBe(true);
  });
});
