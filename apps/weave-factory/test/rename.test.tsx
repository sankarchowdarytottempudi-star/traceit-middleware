import { describe, expect, it } from "vitest";
import { nameProblem, renamable, suggestName } from "../src/migrate/Rename.tsx";
import { canCheck } from "../src/migrate/CheckCorrect.tsx";

describe("rename the API of a migration", () => {
  it("accepts plain names and refuses spaces, slashes and leading punctuation", () => {
    expect(nameProblem("OOH_webMethods_Integration_boomi")).toBe("");
    expect(nameProblem("api-2.v1")).toBe("");
    for (const bad of ["", "a b", "x/y", "../x", "-x", "x.", "a".repeat(81)]) expect(nameProblem(bad)).not.toBe("");
  });
  it("suggests the current name with the target added, never the current name", () => {
    expect(suggestName({ apiName: "OOH_webMethods_Integration", targetTech: "boomi" })).toBe("OOH_webMethods_Integration_boomi");
    expect(suggestName({ apiName: "X_boomi", targetTech: "boomi" })).toBe("X_boomi_2");
    expect(nameProblem(suggestName({ apiName: "a b/c", targetTech: "workato" }))).toBe("");
  });
  it("is offered only for migrations whose name comes from a source", () => {
    expect(renamable({ apiName: "A", sourceFile: "/u/a.zip" })).toBe(true);
    expect(renamable({ apiName: "A", sourceFile: "/u/a.zip", sourceType: "requirements" })).toBe(false);
    expect(renamable({ apiName: "A", sourceFile: "/u/a.zip", checkOnly: true })).toBe(false);
    expect(renamable({ apiName: "", sourceFile: "/u/a.zip" })).toBe(false);
  });
});

describe("check and correct panel", () => {
  const base = { id: "m", apiName: "A", phases: [{ key: "document", status: "done" }] } as never;
  it("shows once the documents exist", () => {
    expect(canCheck(base)).toBe(true);
    expect(canCheck({ ...(base as object), phases: [{ key: "document", status: "pending" }] } as never)).toBe(false);
    expect(canCheck({ ...(base as object), checkOnly: true } as never)).toBe(false);
  });
});
