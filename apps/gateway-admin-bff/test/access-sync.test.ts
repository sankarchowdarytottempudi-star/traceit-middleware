// src/access is kept identical in the Gateway BFF and the Factory BFF (each image builds alone, so
// they cannot share a package without changing both builds). This fails when the copies drift.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const here = resolve(__dirname, "../src/access");
const there = resolve(__dirname, "../../weave-factory-bff/src/access");

describe("src/access is the same in both BFFs", () => {
  it.runIf(existsSync(there))("same files, same contents", () => {
    const a = readdirSync(here).sort(); const b = readdirSync(there).sort();
    expect(b).toEqual(a);
    for (const f of a) expect(readFileSync(join(there, f), "utf8"), f).toBe(readFileSync(join(here, f), "utf8"));
  });
});
