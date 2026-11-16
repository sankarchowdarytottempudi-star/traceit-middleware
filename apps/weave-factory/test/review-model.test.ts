import { describe, it, expect } from "vitest";
import { caseChanges, distinctIdentities, fieldMark, versionsShown, age, slaWords, newIdempotencyKey } from "../src/review/model.ts";

const base: any = {
  caseId: "RC-1", caseStatus: "REVIEW_OPEN", kind: "MULTIPLE_IDENTITY_CONFLICT",
  incoming: { crmGuestRecordId: "R1", crmModifiedTime: "t1", display: { firstName: "Ali", dob: "1990-05-10" } },
  candidates: [
    { crmGuestRecordId: "R2", crmIdentityRecordId: "I1", crmModifiedTime: "t2", display: { firstName: "Ali", dob: "1990-05-10" } },
    { crmGuestRecordId: "R3", crmIdentityRecordId: "I2", crmModifiedTime: "t3", display: { firstName: "Ali", dob: "1991-01-01" } },
    { crmGuestRecordId: "R4", crmIdentityRecordId: "I1", crmModifiedTime: "t4", display: {} },
  ],
};

describe("review workbench model", () => {
  it("lists every record shown, once, with the version shown", () => {
    expect(versionsShown(base)).toEqual([
      { crmGuestRecordId: "R1", crmModifiedTime: "t1" }, { crmGuestRecordId: "R2", crmModifiedTime: "t2" },
      { crmGuestRecordId: "R3", crmModifiedTime: "t3" }, { crmGuestRecordId: "R4", crmModifiedTime: "t4" },
    ]);
  });
  it("counts the distinct people behind the candidates", () => {
    expect(distinctIdentities(base)).toEqual(["I1", "I2"]);
  });
  it("says what a field result means in words and a symbol", () => {
    expect(fieldMark("EXACT", true)?.label).toBe("Same");
    expect(fieldMark("CONFLICT", true)?.symbol).toBe("≠");
    expect(fieldMark("SUPPRESSED", true)?.label).toMatch(/many/);
    expect(fieldMark("LOW_CONFIDENCE", true)?.label).toBe("Not sure");
    expect(fieldMark(undefined, false)?.label).toBe("Missing");
    expect(fieldMark(undefined, true)).toBeNull();
  });
  it("names what changed between the case shown and the case now", () => {
    const after = structuredClone(base);
    after.candidates[1].display.dob = "1990-05-10";
    after.candidates[1].crmModifiedTime = "t3b";
    after.candidates[2].crmModifiedTime = "t4b";
    after.candidates.push({ crmGuestRecordId: "R5", crmModifiedTime: "t5", display: {} });
    const ch = caseChanges(base, after);
    expect(ch).toContainEqual({ record: "R3", what: "Date of birth", before: "1991-01-01", after: "1990-05-10" });
    expect(ch).toContainEqual({ record: "R4", what: "The record was saved again in CRM" });
    expect(ch).toContainEqual({ record: "R5", what: "A guest was added to the case" });
    expect(ch.find((c) => c.record === "R2")).toBeUndefined();
  });
  it("words ages, SLA states and keys plainly", () => {
    const now = Date.parse("2026-11-16T12:00:00Z");
    expect(age("2026-11-16T11:30:00Z", now)).toBe("30 min");
    expect(age("2026-11-16T06:00:00Z", now)).toBe("6 h");
    expect(age("2026-11-12T12:00:00Z", now)).toBe("4 days");
    expect(slaWords({ dueAt: "2026-11-17T08:00:00Z", state: "OVERDUE", escalate: true, days: 1 })?.text).toMatch(/^Overdue.*supervisor told/);
    expect(slaWords(null)).toBeNull();
    expect(newIdempotencyKey("RC-1", "z 1")).toMatch(/^[\w:.-]{6,120}$/);
  });
});
