import { describe, it, expect } from "vitest";
import { canRedo, canUndo, COALESCE_MS, HISTORY_LIMIT, historyInit, historyPush, historyRedo, historyUndo } from "../src/studio/history";

describe("undo / redo history", () => {
  it("starts with nothing to undo or redo", () => {
    const h = historyInit("a");
    expect([canUndo(h), canRedo(h)]).toEqual([false, false]);
    expect(historyUndo(h)).toBe(h);
    expect(historyRedo(h)).toBe(h);
  });
  it("undoes and redoes in order", () => {
    let h = historyInit("a");
    h = historyPush(h, "b");
    h = historyPush(h, "c");
    h = historyUndo(h);
    expect(h.present).toBe("b");
    h = historyUndo(h);
    expect(h.present).toBe("a");
    expect(canUndo(h)).toBe(false);
    h = historyRedo(historyRedo(h));
    expect(h.present).toBe("c");
    expect(canRedo(h)).toBe(false);
  });
  it("a new change after an undo discards the redo steps", () => {
    let h = historyPush(historyPush(historyInit("a"), "b"), "c");
    h = historyPush(historyUndo(h), "d");
    expect(canRedo(h)).toBe(false);
    expect(historyUndo(h).present).toBe("b");
  });
  it("typing in one field is a single undo step", () => {
    let h = historyInit("");
    h = historyPush(h, "J", "cfg:n1:url", 1000);
    h = historyPush(h, "Jo", "cfg:n1:url", 1200);
    h = historyPush(h, "Joh", "cfg:n1:url", 1900);
    expect(h.past).toEqual([""]);
    expect(historyUndo(h).present).toBe("");
  });
  it("a pause, another field or an unkeyed change starts a new step", () => {
    let h = historyPush(historyInit(""), "a", "k1", 0);
    h = historyPush(h, "ab", "k1", COALESCE_MS + 1);
    expect(h.past).toEqual(["", "a"]);
    h = historyPush(h, "abc", "k2", COALESCE_MS + 2);
    expect(h.past).toHaveLength(3);
    h = historyPush(h, "abcd", undefined, COALESCE_MS + 3);
    h = historyPush(h, "abcde", undefined, COALESCE_MS + 4);
    expect(h.past).toHaveLength(5);
  });
  it("does not merge into the step before an undo", () => {
    let h = historyPush(historyInit("a"), "b", "k", 0);
    h = historyUndo(h);
    h = historyPush(h, "c", "k", 10);
    expect(h.past).toEqual(["a"]);
    expect(h.present).toBe("c");
  });
  it("keeps a bounded number of steps", () => {
    let h = historyInit(0);
    for (let i = 1; i <= HISTORY_LIMIT + 25; i++) h = historyPush(h, i);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]).toBe(25);
  });
});
