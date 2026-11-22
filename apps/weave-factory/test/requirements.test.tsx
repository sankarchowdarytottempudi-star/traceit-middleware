// "New from requirements": the helpers, the Requirements panel and the start page (server calls are stand-ins).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Requirements, countsLine } from "../src/migrate/Requirements.tsx";
import { MigrationFromRequirements } from "../src/migrate/MigrationFromRequirements.tsx";
import { SourceWays } from "../src/migrate/ui.tsx";
import { correctable } from "../src/migrate/Corrections.tsx";
import { failureView, isRequirements, nextActions, openQuestionsText, validateRequirementsForm } from "../src/lib/migrate.ts";
import type { Migration } from "../src/api.ts";

const phases = (s: Record<string, string>) => ["upload", "document", "mapping", "scaffold", "implement", "test", "deploy"].map((key) => ({ key, title: key, status: s[key] ?? "pending", steps: [] }));
const READ = { name: "order-intake-api", document: "order-intake.docx", readAt: "2026-11-22T10:00:00Z", openQuestions: 3,
  counts: { operations: 2, triggers: 0, systems: 3, fields: 6, rules: 7, errors: 1, nonFunctional: 3 },
  coverage: { requirementStatements: 22, turnedIntoItems: 21, leftAsOpenQuestions: 1, contextOnly: 0 }, reviews: [] };
const mig = (over: Partial<Migration> = {}): Migration => ({ id: "m1", name: "Order intake", sourceType: "requirements", targetTech: "workato", apiName: null,
  phases: phases({ upload: "done", document: "done", mapping: "action_required" }) as any, progress: { overallPercent: 30, majorPhase: "Review", done: false, outcome: "In progress" }, requirements: READ, ...over });
function mount(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("helpers", () => {
  it("knows a requirements migration and words the counts", () => {
    expect(isRequirements(mig())).toBe(true);
    expect(isRequirements({ sourceType: "spec" })).toBe(false);
    expect(openQuestionsText(0)).toBe("no open questions");
    expect(openQuestionsText(1)).toBe("1 open question");
    expect(openQuestionsText(3)).toBe("3 open questions");
    expect(countsLine(READ.counts)).toBe("2 operations, 3 systems, 6 field mappings, 7 business rules, 1 error-handling item, 3 non-functional notes");
    expect(countsLine({})).toBe("no items");
  });
  it("checks the form: name, workspace and a requirement document", () => {
    const ok = { name: "Order intake", workspace: "Shop", file: { name: "req.docx", size: 10 } };
    expect(validateRequirementsForm(ok, 25)).toEqual({});
    for (const n of ["a.xlsx", "a.md", "a.txt", "a.PDF"]) expect(validateRequirementsForm({ ...ok, file: { name: n, size: 1 } }, 25)).toEqual({});
    expect(validateRequirementsForm({ ...ok, file: { name: "a.zip", size: 1 } }, 25).file).toMatch(/\.docx/);
    expect(validateRequirementsForm({ ...ok, file: { name: "a.md", size: 26 * 1024 * 1024 } }, 25).file).toMatch(/25 MB/);
    expect(validateRequirementsForm({ ...ok, file: null }, 25).file).toBeTruthy();
    expect(validateRequirementsForm({ ...ok, name: " " }, 25).name).toBeTruthy();
  });
  it("offers reading, then generating, then the check and package", () => {
    const before = nextActions(mig({ phases: phases({}) as any, requirements: null }));
    expect(before.map((a) => a.id)).toEqual(["document"]);
    expect(before[0].primary).toBe(true);
    const read = nextActions(mig());
    expect(read.map((a) => a.id)).toEqual(["document", "generate"]);
    expect(read.find((a) => a.id === "generate")).toMatchObject({ primary: true, label: "Generate the Workato service" });
    expect(read.find((a) => a.id === "generate")!.hint).toMatch(/3 open questions not answered/);
    const gen = nextActions(mig({ phases: phases({ document: "done", scaffold: "done", test: "done", deploy: "done" }) as any, apiName: "order-intake-api" }));
    expect(gen.map((a) => a.id)).toEqual(["document", "generate", "test"]);
    expect(gen.some((a) => a.primary)).toBe(false);
    const changed = nextActions(mig({ phases: phases({ document: "done", scaffold: "done", deploy: "done" }) as any, requirements: { ...READ, changedSinceGenerate: true } }));
    expect(changed.find((a) => a.primary)?.id).toBe("generate");
    expect(nextActions(mig({ targetTech: "wso2", phases: phases({ document: "done", scaffold: "done" }) as any })).map((a) => a.id)).toEqual(["document", "generate", "test", "deploy"]);
  });
  it("does not offer to read a scanned PDF again, and retries a failed generation with generate", () => {
    const scanned = mig({ phases: phases({ document: "failed" }) as any, requirements: null, progress: { overallPercent: 5, majorPhase: "Requirements", done: false, outcome: "Failed",
      failure: { phase: "Requirements", phaseKey: "document", step: "Read the document", status: "failed", detail: "", help: { kind: "requirements-unreadable", what: "The requirement document could not be read: scanned or image PDF: upload a text copy (docx/md)", todo: ["Upload a text copy"] } } } as any });
    const v = failureView(scanned)!;
    expect(v.what).toMatch(/scanned or image PDF: upload a text copy \(docx\/md\)/);
    expect(v.retry).toBeUndefined();
    const gen = mig({ progress: { overallPercent: 40, majorPhase: "Generate", done: false, outcome: "Failed", failure: { phase: "Generate", phaseKey: "scaffold", status: "failed", help: { kind: "unknown" } } } as any });
    expect(failureView(gen)!.retry?.id).toBe("generate");
  });
  it("leaves the analysis corrections out for a requirements migration", () => {
    expect(correctable(mig({ apiName: "order-intake-api" }))).toBe(false);
  });
});

describe("the Requirements panel", () => {
  it("is not shown for other migrations", () => {
    const { container } = mount(<Requirements m={mig({ sourceType: undefined })} onRun={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
  it("says what was understood, links the documents and waits for a workbook", () => {
    mount(<Requirements m={mig()} onRun={() => {}} />);
    expect(screen.getByTestId("requirements-coverage").textContent).toMatch(/21 of 22 requirement sentences turned into items/);
    expect(screen.getByTestId("requirements-counts").textContent).toMatch(/7 business rules/);
    expect(screen.getByTestId("requirements-open").textContent).toMatch(/3 open questions/);
    expect(screen.getByTestId("requirements-read-md").getAttribute("href")).toMatch(/docs\/REQUIREMENTS-READ\.md/);
    expect(screen.getByTestId("requirements-upload")).toBeDisabled();
    expect(screen.getByTestId("requirements-generate").textContent).toBe("Generate the Workato service");
    expect(screen.getByTestId("requirements-generate-note").textContent).toMatch(/3 open questions not answered/);
    expect(document.body.textContent).not.toMatch(/migrated/i);
  });
  it("asks to generate through the caller", () => {
    const onRun = vi.fn();
    mount(<Requirements m={mig()} onRun={onRun} />);
    fireEvent.click(screen.getByTestId("requirements-generate"));
    expect(onRun).toHaveBeenCalledWith("generate");
  });
  it("before reading: says so, no workbook", () => {
    mount(<Requirements m={mig({ requirements: null, phases: phases({}) as any })} onRun={() => {}} />);
    expect(screen.getByTestId("requirements-unread").textContent).toMatch(/not been read yet/);
    expect(screen.queryByTestId("requirements-download")).toBeNull();
  });
  it("shows the generated line and asks to generate again after a review", () => {
    mount(<Requirements m={mig({ apiName: "order-intake-api", serviceDir: "services/order-intake-api", requirements: { ...READ, changedSinceGenerate: true,
      generated: { at: "2026-11-22T11:00:00Z", target: "workato", service: "order-intake-api", line: "built from requirements: 2 operations/triggers, 3 of 7 rules implemented as steps, 4 rules kept as TODO, 3 open questions not answered" } } })} onRun={() => {}} />);
    expect(screen.getByTestId("requirements-generated").textContent).toMatch(/generate again/);
    expect(screen.getByTestId("requirements-generated").textContent).toMatch(/3 of 7 rules implemented as steps/);
    expect(screen.getByTestId("requirements-generate").textContent).toBe("Generate the Workato service again");
  });
  it("lists the rows that need fixing", async () => {
    class X { status = 0; responseText = ""; upload = { onprogress: null }; onload: any; onerror: any; onabort: any;
      open() {} setRequestHeader() {} abort() {}
      send() { this.status = 400; this.responseText = JSON.stringify({ ok: false, error: "2 rows of the workbook need fixing. Nothing was changed.", errors: [{ sheet: "Rules", row: 3, problem: "Action \"maybe\" is not one of: (empty), change, delete, add" }, { sheet: "", row: "", problem: "the workbook has none of the review sheets" }] }); setTimeout(() => this.onload(), 0); } }
    vi.stubGlobal("XMLHttpRequest", X as any);
    mount(<Requirements m={mig()} onRun={() => {}} />);
    fireEvent.change(screen.getByTestId("requirements-review-file"), { target: { files: [new File([new Uint8Array([0x50, 0x4b, 3, 4])], "rv.xlsx")] } });
    fireEvent.click(screen.getByTestId("requirements-upload"));
    await waitFor(() => expect(screen.getByTestId("requirements-errors")).toBeInTheDocument());
    const rows = screen.getByTestId("requirements-errors").querySelectorAll("li");
    expect(rows[0].textContent).toMatch(/Sheet Rules, row 3: Action "maybe"/);
    expect(rows[1].textContent).toMatch(/^The workbook: the workbook has none/);
    expect(screen.getByTestId("requirements-error").textContent).toMatch(/Nothing was changed/);
  });
  it("says why the workbook cannot be downloaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "A step of this migration is running." }), { status: 409, headers: { "content-type": "application/json" } })));
    mount(<Requirements m={mig()} onRun={() => {}} />);
    fireEvent.click(screen.getByTestId("requirements-download"));
    await waitFor(() => expect(screen.getByTestId("requirements-download-error").textContent).toBe("A step of this migration is running."));
  });
});

describe("the start page", () => {
  it("offers four ways to start", () => {
    mount(<SourceWays way="requirements" />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([expect.stringMatching(/Upload a file/), expect.stringMatching(/git repository/), expect.stringMatching(/Paste code/), expect.stringMatching(/From requirements/)]);
    expect(screen.getByTestId("way-requirements").getAttribute("aria-current")).toBe("page");
  });
  it("explains what happens and checks the document type", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = String(url).includes("/migrate/options")
        ? { technologies: [], targets: [{ id: "workato", label: "Workato", depth: "full", hint: "" }, { id: "wso2", label: "WSO2", depth: "full", hint: "" }], extensions: [".zip"], maxUploadMb: 500, requirements: { extensions: [".docx", ".xlsx", ".md", ".txt", ".pdf"], maxMb: 25 } }
        : { workspaces: [{ name: "Shop" }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    mount(<MigrationFromRequirements />);
    await waitFor(() => expect(screen.getByTestId("requirements-explain")).toBeInTheDocument());
    const text = screen.getByTestId("requirements-explain").textContent || "";
    for (const w of [/on this server/, /cites the sentence/, /question for you/, /Nothing is invented/, /review/]) expect(text).toMatch(w);
    expect(screen.getByTestId("requirements-file").getAttribute("accept")).toBe(".docx,.xlsx,.md,.txt,.pdf");
    expect(screen.getByTestId("requirements-template")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Workato/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(screen.getByTestId("requirements-name"), { target: { value: "Order intake" } });
    fireEvent.change(screen.getByTestId("requirements-file"), { target: { files: [new File(["x"], "orders.zip")] } });
    fireEvent.click(screen.getByTestId("requirements-create"));
    await waitFor(() => expect(screen.getByTestId("requirements-file-error").textContent).toMatch(/\.docx/));
  });
});
