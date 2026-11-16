import { describe, it, expect } from "vitest";
import { revertBody, cloneBody, connectBody } from "../src/versions/routes";

describe("versions in git: only the fields each action takes", () => {
  it("revert needs a whole version number", () => {
    expect(revertBody({ version: 12, by: "browser-sent" })).toEqual({ ok: true, body: { version: 12 } });
    expect(revertBody({ version: "12" }).ok).toBe(false);
    expect(revertBody({ version: 0 }).ok).toBe(false);
    expect(revertBody({ version: 1.5 }).ok).toBe(false);
  });
  it("clone needs a new, valid API name", () => {
    expect(cloneBody({ name: " Shop-Copy " }, "shop-api")).toEqual({ ok: true, body: { name: "shop-copy" } });
    expect(cloneBody({ name: "shop-api" }, "shop-api").ok).toBe(false);
    expect(cloneBody({ name: "bad name!" }, "shop-api").ok).toBe(false);
  });
  it("connect accepts only a GitHub SSH address", () => {
    expect(connectBody({ remote: "git@github.com:owner/repo.git" }).ok).toBe(true);
    expect(connectBody({ remote: "https://github.com/owner/repo.git" }).ok).toBe(false);
    expect(connectBody({ remote: "git@evil.example:o/r.git" }).ok).toBe(false);
  });
});
