import { describe, it, expect } from "vitest";
import { changeRequestBody } from "../src/changes/routes";

describe("change requests", () => {
  it("passes only the fields a change request takes", () => {
    const v = changeRequestBody({ requirement: "  When the catalogue answers 404, answer 404 with ITEM_NOT_FOUND.  ", flow: "GET /items/{itemId}", by: "someone else",
      examples: [{ op: "GET /items/{itemId}", pathValues: { itemId: "42" }, expectStatus: 404, expectBodyHas: ["ITEM_NOT_FOUND"], extra: 1 }] });
    expect(v).toEqual({ ok: true, body: { requirement: "When the catalogue answers 404, answer 404 with ITEM_NOT_FOUND.", flow: "GET /items/{itemId}",
      examples: [{ op: "GET /items/{itemId}", pathValues: { itemId: "42" }, expectStatus: 404, expectBodyHas: ["ITEM_NOT_FOUND"] }] } });
  });
  it("refuses short requirements, bad operations and too many examples", () => {
    expect(changeRequestBody({ requirement: "fix it" })).toMatchObject({ ok: false });
    expect(changeRequestBody({ requirement: "a long enough requirement", examples: [{ op: "items" }] })).toMatchObject({ ok: false });
    expect(changeRequestBody({ requirement: "a long enough requirement", examples: Array(21).fill({ op: "GET /x" }) })).toMatchObject({ ok: false });
    expect(changeRequestBody({ requirement: "a long enough requirement", examples: [{ op: "GET /x", expectStatus: 999 }] }))
      .toEqual({ ok: true, body: { requirement: "a long enough requirement", flow: "", examples: [{ op: "GET /x" }] } });
  });
});
