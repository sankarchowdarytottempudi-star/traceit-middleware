// The download panel of a project for another platform: the package to import comes first.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Delivery, hasPackage, packageLabel } from "../src/migrate/Delivery.tsx";
import type { Migration } from "../src/api.ts";

const mig = (over: Partial<Migration> = {}): Migration => ({ id: "m1", name: "pay", apiName: "pay-api", targetTech: "workato", serviceDir: "services/pay-api", phases: [], progress: { overallPercent: 60, majorPhase: "Test", done: false, outcome: "In progress" }, ...over });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("delivery panel", () => {
  it("puts the Workato import package first and marks the project download as not for importing", () => {
    render(<Delivery m={mig()} />);
    const pkg = screen.getByTestId("delivery-package");
    expect(pkg.textContent).toBe("Workato import package (.zip) — import this file in Workato");
    expect(pkg.className).toContain("mf-mg-btn-pri");
    const project = screen.getByTestId("delivery-project");
    expect(project.className).not.toContain("mf-mg-btn-pri");
    expect(screen.getByTestId("delivery-project-note").textContent).toBe("documents, tests and settings — not for importing");
    expect(pkg.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("names the package of other platforms after the platform", () => {
    expect(packageLabel(mig({ targetTech: "webmethods" }))).toBe("webMethods package (.zip)");
    expect(hasPackage(mig({ targetTech: "springboot" }))).toBe(false);
    expect(hasPackage(mig({ targetTech: "springboot", packageFile: "app.zip" }))).toBe(true);
    expect(hasPackage(mig({ targetTech: "wso2" }))).toBe(false);
    render(<Delivery m={mig({ targetTech: "springboot" })} />);
    expect(screen.queryByTestId("delivery-package")).toBeNull();
    expect(screen.queryByTestId("delivery-project-note")).toBeNull();
    expect(screen.getByTestId("delivery-project")).toBeInTheDocument();
  });
  it("says in words when there is no package", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "This Workato project has no package to import." }), { status: 404, headers: { "content-type": "application/json" } })));
    render(<Delivery m={mig()} />);
    fireEvent.click(screen.getByTestId("delivery-package"));
    await waitFor(() => expect(screen.getByTestId("delivery-package-error").textContent).toBe("This Workato project has no package to import."));
  });
});
