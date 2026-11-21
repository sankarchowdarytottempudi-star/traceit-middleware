// "Paste code" in New migration, single files on the upload, and the "Partial source" notice (server calls are stand-ins).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MigrationNew } from "../src/migrate/MigrationNew.tsx";
import { PartialSourceNotice, SourceWays } from "../src/migrate/ui.tsx";
import { partialOf, pasteNameHint, validatePaste } from "../src/lib/migrate.ts";

const rules = { maxSnippets: 3, maxSnippetKb: 1, maxTotalKb: 2 };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("pasted pieces are checked", () => {
  it("needs at least one piece of code", () => {
    expect(validatePaste([{ name: "", text: " " }], rules).all).toMatch(/at least one/);
    expect(validatePaste([{ name: "flow.xml", text: "<FLOW/>" }], rules)).toEqual({ pieces: {} });
  });
  it("says what is wrong with each piece", () => {
    const v = validatePaste([{ name: "a.dwl", text: "x" }, { name: "", text: "" }, { name: "../b.xml", text: "y" }], rules);
    expect(v.pieces[1]).toMatch(/empty/);
    expect(v.pieces[2]).toMatch(/file name/);
    expect(validatePaste([{ name: "a.dwl", text: "x" }, { name: "A.DWL", text: "y" }], rules).pieces[1]).toMatch(/already called/);
    expect(validatePaste([{ name: "flow.xml", text: "x" }, { name: "flow.xml", text: "y" }], rules).pieces).toEqual({});
    expect(validatePaste([{ name: "", text: "x".repeat(1100) }], rules).pieces[0]).toMatch(/larger than 1 KB/);
    expect(validatePaste([{ name: "", text: "x".repeat(1000) }, { name: "", text: "x".repeat(1000) }, { name: "", text: "x".repeat(1000) }], rules).all).toMatch(/together/);
    expect(validatePaste(Array.from({ length: 4 }, () => ({ name: "", text: "x" })), rules).all).toMatch(/at most 3/);
  });
  it("suggests file names for the technology", () => {
    expect(pasteNameHint("webmethods")).toMatch(/flow\.xml/);
    expect(pasteNameHint("mule4")).toMatch(/\.dwl/);
    expect(pasteNameHint("other")).toMatch(/MyService\.java/);
  });
});

describe("partial source", () => {
  const m = { partialSource: { source: "pasted", why: "The input is 2 pasted snippets.", unknowns: [{ what: "connection settings", supply: "the global configuration XML" }, "schedules"] } };
  it("reads the tool's field", () => {
    expect(partialOf(m)).toEqual({ why: "The input is 2 pasted snippets.", source: "pasted", unknowns: [{ what: "connection settings", supply: "the global configuration XML" }, { what: "schedules", supply: "" }] });
    expect(partialOf({})).toBeNull();
    expect(partialOf({ partialSource: null })).toBeNull();
  });
  it("shows the notice with every unknown and what to supply", () => {
    render(<PartialSourceNotice migration={m} />);
    expect(screen.getByText(/Partial source \(pasted code\)\./)).toBeInTheDocument();
    expect(screen.getByText(/not a complete migration/)).toBeInTheDocument();
    expect(screen.getByText("connection settings")).toBeInTheDocument();
    expect(screen.getByText(/supply: the global configuration XML/)).toBeInTheDocument();
    expect(screen.getByText("schedules")).toBeInTheDocument();
  });
  it("shows nothing for a whole project", () => {
    const { container } = render(<PartialSourceNotice migration={{}} />);
    expect(container.textContent).toBe("");
  });
});

describe("the three source ways", () => {
  it("offers Paste code next to upload and git", () => {
    render(<MemoryRouter><SourceWays way="paste" /></MemoryRouter>);
    const paste = screen.getByRole("link", { name: /Paste code/ });
    expect(paste).toHaveAttribute("href", "/migrations/paste");
    expect(paste).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /Upload a file/ })).toHaveAttribute("href", "/migrations/new");
    expect(screen.getByRole("link", { name: /From a git repository/ })).toBeInTheDocument();
  });
});

const OPTIONS = {
  technologies: [{ id: "auto", label: "Detect automatically", upload: "A .zip or .jar of the project" }],
  targets: [{ id: "wso2", label: "WSO2", depth: "full", maturity: "complete" }, { id: "workato", label: "Workato", depth: "partial", maturity: "complete-unverified" }],
  extensions: [".zip", ".jar", ".json", ".xml", ".java"], maxUploadMb: 500, singleFileExtensions: [".xml", ".java"], singleFileMb: 10,
  paste: { technologies: [{ id: "auto", label: "Detect from the code" }, { id: "mule4", label: "MuleSoft (Mule 4 XML, DataWeave)" }], maxSnippets: 20, maxSnippetKb: 1024, maxTotalKb: 2048 },
};

function mountPaste(calls: { url: string; init?: RequestInit }[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/migrate/options")) return json(OPTIONS);
    if (url.endsWith("/workspaces")) return json({ workspaces: [{ name: "Shop" }] });
    if (url.endsWith("/migrations/paste")) return json({ id: "m9", name: "Orders" }, 201);
    if (url.includes("/run/")) return json({ ok: true });
    return json({});
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/migrations/paste"]}>
        <Routes>
          <Route path="/migrations/paste" element={<MigrationNew mode="paste" />} />
          <Route path="/migrations/:id" element={<p>detail screen</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("New migration, Paste code", () => {
  it("checks the form, then creates the migration from the pasted pieces", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    mountPaste(calls);
    await screen.findByText("Paste the code");
    expect(screen.getByText(/partial source/, { selector: "strong" })).toBeInTheDocument();
    // nothing pasted yet
    fireEvent.click(screen.getByRole("button", { name: /Create the migration from the pasted code/ }));
    expect(await screen.findByText("Paste at least one piece of code")).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/migrations/paste"))).toBe(false);

    fireEvent.change(screen.getByPlaceholderText("Customer profile API"), { target: { value: "Orders" } });
    fireEvent.click(screen.getByRole("radio", { name: /MuleSoft/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Workato/ }));
    fireEvent.change(screen.getByLabelText(/Piece 1: file name/), { target: { value: "orders-flow.xml" } });
    fireEvent.change(screen.getByLabelText("Code of piece 1"), { target: { value: "<mule xmlns=\"http://www.mulesoft.org/schema/mule/core\"/>" } });
    fireEvent.click(screen.getByRole("button", { name: /Add another piece/ }));
    fireEvent.change(screen.getByLabelText("Code of piece 2"), { target: { value: "%dw 2.0\n---\n{}" } });
    expect(screen.getByText(/2 pieces/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Create the migration from the pasted code/ }));

    await screen.findByText("detail screen");
    const post = calls.find((c) => c.url.endsWith("/migrations/paste"))!;
    expect(post.init?.method).toBe("POST");
    expect(JSON.parse(String(post.init?.body))).toEqual({ name: "Orders", workspace: "Shop", target: "workato", technology: "mule4",
      snippets: [{ name: "orders-flow.xml", text: "<mule xmlns=\"http://www.mulesoft.org/schema/mule/core\"/>" }, { name: "", text: "%dw 2.0\n---\n{}" }] });
    await waitFor(() => expect(calls.some((c) => c.url.includes("/migrations/m9/run/document"))).toBe(true));
  });

  it("removes a piece and shows a bad file name", async () => {
    mountPaste([]);
    await screen.findByText("Paste the code");
    fireEvent.click(screen.getByRole("button", { name: /Add another piece/ }));
    expect(screen.getByLabelText("Code of piece 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove piece 2" }));
    expect(screen.queryByLabelText("Code of piece 2")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Customer profile API"), { target: { value: "Orders" } });
    fireEvent.change(screen.getByLabelText(/Piece 1: file name/), { target: { value: "../x.xml" } });
    fireEvent.change(screen.getByLabelText("Code of piece 1"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /Create the migration from the pasted code/ }));
    expect(await screen.findByText(/The file name may use letters/)).toBeInTheDocument();
  });
});
