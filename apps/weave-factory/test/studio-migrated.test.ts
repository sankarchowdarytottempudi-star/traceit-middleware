import { describe, expect, it } from "vitest";
import { calledBy, chainText, estateTotals, migratedStatusLabel, offsetLabel, stepHints, stepTone } from "../src/studio/migrated.ts";

describe("wording for calls of the migrated services", () => {
  it("names the caller and how the call arrived", () => {
    expect(calledBy({ kind: "call", via: "gateway", application: "booking-app" })).toEqual({ main: "booking-app", sub: "Through the gateway" });
    expect(calledBy({ kind: "call", via: "gateway" }).main).toBe("Unknown application");
    expect(calledBy({ kind: "call", via: "gateway", httpStatus: 401 }).main).toBe("Caller without a valid key");
    expect(calledBy({ kind: "call", via: "internal" })).toEqual({ main: "Another service", sub: "Inside the cluster" });
    expect(calledBy({ kind: "call", via: "direct" }).sub).toBe("Not through the gateway");
    expect(calledBy({ kind: "call", via: "unknown" }).main).toBe("-");
    expect(calledBy({ kind: "job", trigger: "SCHEDULED" })).toEqual({ main: "Scheduled", sub: "Job inside the service" });
    expect(calledBy({ kind: "job" }).main).toBe("Background job");
  });

  it("shows the chain only when more than one service took part", () => {
    expect(chainText({ chain: ["exp-api"] })).toBe("");
    expect(chainText({ chain: ["exp-api", "proc-api", "sys-api"] })).toBe("exp-api → proc-api → sys-api");
  });

  it("labels results and offsets", () => {
    expect(migratedStatusLabel("success")).toBe("Succeeded");
    expect(migratedStatusLabel("error")).toBe("Failed");
    expect(migratedStatusLabel("unknown")).toBe("No result logged");
    expect(offsetLabel(0)).toBe("+0 ms");
    expect(offsetLabel(412)).toBe("+412 ms");
    expect(offsetLabel(1530)).toBe("+1.53 s");
    expect(offsetLabel(75_000)).toBe("+1 min 15 s");
    expect(offsetLabel(-4)).toBe("-4 ms");
    expect(offsetLabel("x")).toBe("");
  });

  it("picks a few readable fields and a tone per line", () => {
    const hints = stepHints({ fields: { correlationId: "abc", operation: "getVoyages", status: 200, elapsedMs: 31, attempt: 1, bytes: 9000, other: "x" } });
    expect(hints.map((h) => h.key)).toEqual(["operation", "status", "attempt", "elapsedMs"]);
    expect(stepHints({ fields: { path: "x".repeat(100) } })[0].value.length).toBe(61);
    expect(stepTone("ERROR")).toBe("error");
    expect(stepTone("warning")).toBe("warn");
    expect(stepTone(undefined)).toBe("info");
  });
});

describe("what the Flows page adds up", () => {
  const why = { summary: "2 operations still answer \"not migrated\"", operations: [], entries: [], backends: [] };
  it("counts flows built here together with the migrated services, and says how many are not finished", () => {
    const t = estateTotals(7, [{ name: "a" }, { name: "b", unfinished: why }, { name: "c", unfinished: why }], { services: 3, finished: 1, unfinished: 2, migrations: 5, migratedApis: 4 });
    expect(t.total).toBe(10);
    expect(t.text).toBe("7 flows built here and 3 migrated services running (1 finished, 2 not finished)");
    expect(t.migrations).toContain("5 migrations for 4 APIs");
  });
  it("stays quiet about what does not apply", () => {
    expect(estateTotals(1, [{ name: "a" }]).text).toBe("1 flow built here and 1 migrated service running (1 finished)");
    expect(estateTotals(0, []).text).toBe("0 flows built here and 0 migrated services running");
    expect(estateTotals(2, [], undefined).migrations).toBe("");
  });
});
