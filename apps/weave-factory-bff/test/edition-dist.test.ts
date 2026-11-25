// deploy/edition-dist.mjs: the Docker build step that keeps TraceIT/Tottempudi names out of the server files
// of a Cruise Saudi image (go-live check B6) and leaves a TraceIT image untouched.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "../../../deploy/edition-dist.mjs");
const FORBIDDEN = /traceit-tottech|traceit|tottempudi/i;
// fixtures live under this package (in .data, git-ignored) so typescript and @traceit/weave-flow resolve
const base = resolve(__dirname, "../.data");
mkdirSync(base, { recursive: true });
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function fixture(extra: Record<string, string> = {}) {
  const app = mkdtempSync(join(base, "edition-dist-"));
  made.push(app);
  mkdirSync(join(app, "dist", "estate"), { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "fx", type: "module", dependencies: { "@traceit/weave-flow": "workspace:*", fastify: "5" }, scripts: { build: "tsc" } }));
  const files: Record<string, string> = {
    "dist/edition.js": `// The edition this server runs as. Unset (or "traceit"): everything.\nexport function editionOf(env) {\n    return (env.WEAVE_EDITION ?? "").trim().toLowerCase() === "cruise-saudi" ? "cruise-saudi" : "traceit";\n}\n`,
    "dist/settings.js": `/** Name on the sign-in page (TraceIT). */\nexport function productName(env) {\n    return env.WEAVE_EDITION === "cruise-saudi" ? "Cruise Saudi Weave" : "TraceIT Weave";\n}\nexport const greet = \`Welcome to TraceIT Weave\`;\n`,
    "dist/estate/power.js": `export const ANN = { replicas: "weave.traceit/stopped-replicas" };\n`,
    "dist/flow.js": `import { readValueTable } from "@traceit/weave-flow";\nexport const ok = typeof readValueTable === "function";\n`,
    ...extra,
  };
  for (const [k, v] of Object.entries(files)) writeFileSync(join(app, k), v);
  return app;
}
const run = (edition: string, app: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, edition, app, ...args], { encoding: "utf8" });

describe("edition-dist.mjs", () => {
  it("TraceIT edition: no file changes", () => {
    const app = fixture();
    const before = readFileSync(join(app, "dist/edition.js"), "utf8");
    const r = run("traceit", app, "--package", join(app, "package.json"));
    expect(r.status).toBe(0);
    expect(readFileSync(join(app, "dist/edition.js"), "utf8")).toBe(before);
    expect(readFileSync(join(app, "package.json"), "utf8")).toContain("@traceit/weave-flow");
    expect(existsSync(join(app, "dist/vendor"))).toBe(false);
  });

  it("Cruise Saudi edition: no TraceIT/Tottempudi left, code still works", async () => {
    const app = fixture();
    const r = run("cruise-saudi", app, "--package", join(app, "package.json"));
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    for (const f of ["dist/edition.js", "dist/settings.js", "dist/estate/power.js", "dist/flow.js", "package.json"]) {
      expect(readFileSync(join(app, f), "utf8")).not.toMatch(FORBIDDEN);
    }
    const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
    expect(pkg.dependencies).toEqual({ fastify: "5" });
    expect(pkg.type).toBe("module");
    const ed = await import(join(app, "dist/edition.js"));
    expect(ed.editionOf({})).toBe("cruise-saudi");
    const st = await import(join(app, "dist/settings.js"));
    expect(st.productName({})).toBe("Cruise Saudi Weave");
    expect(st.greet).toBe("Welcome to Cruise Saudi Weave");
    expect((await import(join(app, "dist/estate/power.js"))).ANN.replicas).toBe("weave.cruise-saudi/stopped-replicas");
    expect((await import(join(app, "dist/flow.js"))).ok).toBe(true); // vendored shared package
    expect(readFileSync(join(app, "dist/flow.js"), "utf8")).toContain("./vendor/weave-flow/index.js");
  });

  it("Cruise Saudi edition: fails the build when a name cannot be rebranded", () => {
    const app = fixture({ "dist/about.js": "export const by = \"Tottempudi Software Solutions\";\n" });
    const r = run("cruise-saudi", app);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/about\.js/);
  });

  it("Cruise Saudi edition: --scan directories are checked too", () => {
    const app = fixture();
    const spa = join(app, "spa"); mkdirSync(spa);
    writeFileSync(join(spa, "manifest.webmanifest"), `{"name":"TraceIT Weave"}`);
    const r = run("cruise-saudi", app, "--scan", spa);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/manifest\.webmanifest/);
  });

  it("Cruise Saudi edition: --node-modules drops the vendored @traceit package and pnpm bookkeeping, then is checked", () => {
    const app = fixture();
    const nm = join(app, "nm");
    for (const d of ["@traceit/weave-flow", ".pnpm/node_modules/@traceit/weave-flow", ".pnpm/@traceit+weave-flow@file+packages+weave-flow/node_modules/x", ".pnpm/fastify@5/node_modules/fastify"]) mkdirSync(join(nm, d), { recursive: true });
    writeFileSync(join(nm, "@traceit/weave-flow/package.json"), `{"name":"@traceit/weave-flow"}`);
    writeFileSync(join(nm, ".modules.yaml"), "@traceit/weave-flow: x");
    writeFileSync(join(nm, ".pnpm/lock.yaml"), "@traceit/weave-flow: x");
    writeFileSync(join(nm, ".pnpm/fastify@5/node_modules/fastify/index.js"), "module.exports = 1;");
    const r = run("cruise-saudi", app, "--node-modules", nm);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(existsSync(join(nm, "@traceit"))).toBe(false);
    expect(existsSync(join(nm, ".modules.yaml"))).toBe(false);
    expect(existsSync(join(nm, ".pnpm/node_modules/@traceit"))).toBe(false);
    expect(existsSync(join(nm, ".pnpm/lock.yaml"))).toBe(false);
    expect(existsSync(join(nm, ".pnpm/@traceit+weave-flow@file+packages+weave-flow"))).toBe(false);
    expect(existsSync(join(nm, ".pnpm/fastify@5/node_modules/fastify/index.js"))).toBe(true);
    // a dependency that names TraceIT is not silently shipped
    writeFileSync(join(nm, ".pnpm/fastify@5/node_modules/fastify/about.txt"), "made for TraceIT");
    expect(run("cruise-saudi", app, "--node-modules", nm).status).toBe(1);
  });

  it("is plain Node (no build needed)", () => {
    expect(() => execFileSync(process.execPath, ["--check", SCRIPT])).not.toThrow();
  });
});
