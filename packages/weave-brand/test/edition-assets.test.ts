// @vitest-environment node
// Build-time branding of the static files per edition: index.html title, web manifest, favicon/brand SVGs,
// TraceIT logo files, the Cruise Saudi guard, and the tab titles of screens.
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { brandText, findForeignBrand, indexTitle, isForeignBrandFile, parseEdition } from "../src/editionAssets.ts";
import { weaveEdition } from "../vite/editionPlugin.ts";

const FORBIDDEN = /traceit-tottech|traceit|tottempudi/i;
// the real public files of both apps
const APPS = ["weave-factory", "gateway-admin"].map((a) => resolve(__dirname, "../../../apps", a, "public"));
const FAVICON = readFileSync(join(APPS[0], "brand/favicon.svg"), "utf8");
const MANIFEST = readFileSync(join(APPS[0], "manifest.webmanifest"), "utf8");

const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

/** A tiny app with the real public/ files of an app (plus extras), built through the plugin. */
async function buildFixture(edition: string, publicSrc: string, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "weave-edition-"));
  tmp.push(root);
  writeFileSync(join(root, "index.html"), `<!doctype html><html><head><title>Weave</title><link rel="manifest" href="/manifest.webmanifest"></head><body><script type="module" src="/main.js"></script></body></html>`);
  writeFileSync(join(root, "main.js"), `document.body.dataset.ok = "1";`);
  const pub = join(root, "public");
  const copy = (from: string, to: string) => {
    for (const n of readdirSync(from, { withFileTypes: true })) {
      if (n.isDirectory()) { mkdirSync(join(to, n.name), { recursive: true }); copy(join(from, n.name), join(to, n.name)); }
      else writeFileSync(join(to, n.name), readFileSync(join(from, n.name)));
    }
  };
  mkdirSync(pub, { recursive: true });
  copy(publicSrc, pub);
  for (const [k, v] of Object.entries(extra)) writeFileSync(join(pub, k), v);
  const outDir = join(root, "dist");
  await build({ root, configFile: false, logLevel: "silent", publicDir: pub, build: { outDir, emptyOutDir: true }, plugins: [weaveEdition({ edition })] });
  return outDir;
}
const textFiles = (dir: string): [string, string][] => {
  const out: [string, string][] = [];
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name), r = rel ? `${rel}/${n.name}` : n.name;
      if (n.isDirectory()) walk(p, r);
      else if (/\.(html|js|css|webmanifest|svg|json)$/.test(n.name)) out.push([r, readFileSync(p, "utf8")]);
    }
  };
  walk(dir, "");
  return out;
};

describe("edition texts (pure)", () => {
  it("parses the edition exactly like constants.ts", () => {
    expect(parseEdition("cruise-saudi")).toBe("cruise-saudi");
    expect(parseEdition(undefined)).toBe("traceit");
    expect(parseEdition("traceit")).toBe("traceit");
    expect(parseEdition("other")).toBe("traceit");
  });
  it("TraceIT: manifest and favicon stay byte for byte", () => {
    expect(brandText(MANIFEST, "traceit")).toBe(MANIFEST);
    expect(brandText(FAVICON, "traceit")).toBe(FAVICON);
    expect(isForeignBrandFile("brand/traceit-logo-light.svg", "traceit")).toBe(false);
  });
  it("Cruise Saudi: manifest name/description and favicon title/label name Cruise Saudi Weave", () => {
    const m = JSON.parse(brandText(MANIFEST, "cruise-saudi"));
    expect(m.name).toBe("Cruise Saudi Weave");
    expect(m.description).toContain("Cruise Saudi Weave");
    const svg = brandText(FAVICON, "cruise-saudi");
    expect(svg).toContain("<title>Cruise Saudi Weave</title>");
    expect(svg).toContain('aria-label="Cruise Saudi Weave"');
    expect(svg).not.toMatch(FORBIDDEN);
    expect(isForeignBrandFile("brand/traceit-logo-light.svg", "cruise-saudi")).toBe(true);
    expect(isForeignBrandFile("brand/weave-mark-light.svg", "cruise-saudi")).toBe(false);
  });
  it("index.html title is the product name of the edition", () => {
    const html = "<html><head><title>Weave</title></head></html>";
    expect(indexTitle(html, "traceit")).toContain("<title>TraceIT Weave</title>");
    expect(indexTitle(html, "cruise-saudi")).toContain("<title>Cruise Saudi Weave</title>");
  });
  it("finds a leftover name with context", () => {
    expect(findForeignBrand("all good")).toBeNull();
    expect(findForeignBrand("a product of Tottempudi Software")).toContain("Tottempudi");
  });
});

describe("Vite build through the plugin, real public/ of both apps", () => {
  for (const pub of APPS) {
    const app = pub.split("/").slice(-2)[0];
    it(`${app}: Cruise Saudi build names Cruise Saudi Weave and nothing of TraceIT/Tottempudi`, async () => {
      const out = await buildFixture("cruise-saudi", pub);
      const files = textFiles(out);
      for (const [rel, text] of files) expect(`${rel}: ${findForeignBrand(text) ?? "clean"}`).toBe(`${rel}: clean`);
      expect(readFileSync(join(out, "index.html"), "utf8")).toContain("<title>Cruise Saudi Weave</title>");
      expect(JSON.parse(readFileSync(join(out, "manifest.webmanifest"), "utf8")).name).toBe("Cruise Saudi Weave");
      expect(readFileSync(join(out, "brand/favicon.svg"), "utf8")).toContain("<title>Cruise Saudi Weave</title>");
      expect(readdirSync(join(out, "brand")).filter((n) => FORBIDDEN.test(n))).toEqual([]);
      expect(existsSync(join(out, "icons/icon-192.png"))).toBe(true);
    }, 60_000);
    it(`${app}: TraceIT build ships public/ unchanged, title TraceIT Weave`, async () => {
      const out = await buildFixture("traceit", pub);
      expect(readFileSync(join(out, "manifest.webmanifest"), "utf8")).toBe(readFileSync(join(pub, "manifest.webmanifest"), "utf8"));
      expect(readFileSync(join(out, "brand/favicon.svg"), "utf8")).toBe(readFileSync(join(pub, "brand/favicon.svg"), "utf8"));
      expect(existsSync(join(out, "brand/traceit-logo-light.svg"))).toBe(true);
      expect(readFileSync(join(out, "index.html"), "utf8")).toContain("<title>TraceIT Weave</title>");
    }, 60_000);
  }
  it("the Cruise Saudi build fails when any output file still names Tottempudi/TraceIT", async () => {
    await expect(buildFixture("cruise-saudi", APPS[1], { "about.json": `{"by":"Tottempudi Software Solutions"}` }))
      .rejects.toThrow(/still names TraceIT\/Tottempudi.*about\.json/s);
  }, 60_000);
});

describe("tab titles of screens", () => {
  it("TraceIT keeps '<area> · <module>'", async () => {
    vi.resetModules();
    const b = await import("../src/constants.ts");
    expect(b.pageTitle("Migrations", b.MODULES.factory)).toBe("Migrations · Weave Factory");
  });
  it("Cruise Saudi: '<area> · Cruise Saudi Weave'", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_WEAVE_EDITION", "cruise-saudi");
    try {
      const b = await import("../src/constants.ts");
      expect(b.pageTitle("Migrations", b.MODULES.factory)).toBe("Migrations · Cruise Saudi Weave");
      expect(b.pageTitle("Rate limiting", b.MODULES.gateway)).toBe("Rate limiting · Cruise Saudi Weave");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
