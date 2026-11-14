// Runs the reader over the services that are really deployed. Needs their source on this machine:
//   ESTATE_TEST_SERVICES_DIR=<services dir[,name=dir+dir]> [ESTATE_TEST_CONFIG_DIR=<dir>] npx vitest run test/estate-real.test.ts
// Skipped when the variable is not set, so the normal test run needs nothing outside the repository.
import { describe, it, expect } from "vitest";
import { buildApi, discoverSources, type ApiModel } from "../src/estate/model";
import { buildFlow } from "../src/estate/flow";
import { correctBasePaths, targetApi } from "../src/estate/service";
import { isSecretKey } from "../src/estate/toml";

const dir = process.env.ESTATE_TEST_SERVICES_DIR;
const configDirs = (process.env.ESTATE_TEST_CONFIG_DIR || "").split(",").filter(Boolean);

describe.skipIf(!dir)("the deployed services", () => {
  let models: ApiModel[] = [];
  const load = () => {
    if (models.length) return models;
    models = discoverSources(dir).map((e) => buildApi(e, configDirs));
    correctBasePaths(models);
    return models;
  };
  const expected = Number(process.env.ESTATE_TEST_EXPECT || 0);

  it("are all found and readable", () => {
    const m = load();
    if (expected) expect(m.length).toBe(expected);
    expect(m.length).toBeGreaterThan(0);
    for (const api of m) { expect(api.sourceAvailable, api.name).toBe(true); expect(api.config.length, api.name).toBeGreaterThan(0); }
  });

  it("have operations with a path under the base path and a source position", () => {
    for (const api of load()) for (const o of api.operations) {
      expect(o.fullPath.startsWith("/"), `${api.name} ${o.id}`).toBe(true);
      expect(o.fullPath.includes("/health"), `${api.name} ${o.id}`).toBe(false);
      expect(o.line, `${api.name} ${o.id}`).toBeGreaterThan(0);
      expect(o.code.length, `${api.name} ${o.id}`).toBeGreaterThan(0);
      for (const c of o.calls) expect(api.connectors.some((k) => k.name === c.connector), `${api.name} ${o.id} ${c.connector}`).toBe(true);
    }
  });

  it("never carry the value of a secret-like setting", () => {
    for (const api of load()) {
      for (const c of api.config) if (isSecretKey(c.key)) expect(["set", "not set"], `${api.name} ${c.key}`).toContain(c.value);
      for (const k of api.connectors) {
        expect(k.target, `${api.name} ${k.name}`).not.toMatch(/:\/\/[^/@\s]+:[^/@\s]+@/);
        for (const s of k.settings) if (isSecretKey(s.key)) expect(["set", "not set"], `${api.name} ${s.key}`).toContain(s.value);
      }
    }
  });

  it("link to each other and render as flows without dangling edges", () => {
    const m = load();
    const names = m.map((a) => a.name);
    let links = 0;
    for (const api of m) {
      const apiOf = (connector: string) => { const c = api.connectors.find((k) => k.name === connector); return c ? targetApi(c, api.name, names, new Map()) : undefined; };
      links += api.connectors.filter((c) => apiOf(c.name)).length;
      const f = buildFlow(api, { apiOf });
      const ids = new Set(f.nodes.map((n) => n.id));
      expect(ids.size, api.name).toBe(f.nodes.length);
      for (const e of f.edges) { expect(ids.has(e.from), api.name).toBe(true); expect(ids.has(e.to), api.name).toBe(true); }
      expect(f.nodes.filter((n) => n.type === "trigger.http").length, api.name).toBe(api.operations.length);
      for (const n of f.nodes) if (n.type !== "respond") expect((n.config as any).__source?.file, `${api.name} ${n.name}`).toBeTruthy();
    }
    if (m.length > 1) expect(links).toBeGreaterThan(0);
  });
});
