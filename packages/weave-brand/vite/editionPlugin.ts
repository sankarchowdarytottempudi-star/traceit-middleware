/** Vite plugin: makes the static files of a Weave app follow the edition (VITE_WEAVE_EDITION).
 *  - index.html <title> is the product name ("TraceIT Weave" / "Cruise Saudi Weave")
 *  - Cruise Saudi build: manifest.webmanifest and the brand SVGs copied from public/ name
 *    "Cruise Saudi Weave", TraceIT's own logo files are left out, and the build FAILS if any file of
 *    the output (HTML, JS, CSS, manifest, SVG, JSON) still names TraceIT / Tottempudi.
 *  - TraceIT build: public/ ships exactly as it is.
 *  The dev server serves the same rewritten manifest and SVGs. */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import type { Edition } from "../src/constants.ts";
import { brandText, findForeignBrand, indexTitle, isForeignBrandFile, parseEdition } from "../src/editionAssets.ts";

const BRANDED = /\.(webmanifest|svg|json)$/i; // static files whose texts name the product
const SCANNED = /\.(html|js|mjs|css|webmanifest|svg|json|txt|xml|map)$/i; // checked by the Cruise Saudi guard
const TYPES: Record<string, string> = { svg: "image/svg+xml", webmanifest: "application/manifest+json", json: "application/json" };

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

export interface WeaveEditionOptions {
  /** Overrides VITE_WEAVE_EDITION (tests). */
  edition?: string;
}

export function weaveEdition(opts: WeaveEditionOptions = {}): Plugin {
  let edition: Edition = "traceit";
  let outDir = "";
  let publicDir = "";
  return {
    name: "weave-edition",
    configResolved(c) {
      edition = parseEdition(opts.edition ?? (c.env.VITE_WEAVE_EDITION as string | undefined) ?? process.env.VITE_WEAVE_EDITION);
      outDir = resolve(c.root, c.build.outDir);
      publicDir = c.publicDir ? resolve(c.publicDir) : "";
    },
    transformIndexHtml: { order: "pre", handler: (html) => indexTitle(html, edition) },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (edition === "traceit" || !publicDir || !req.url) return next();
        let path: string;
        try { path = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, ""); } catch { return next(); }
        const file = resolve(publicDir, path);
        if (!BRANDED.test(path) || !file.startsWith(publicDir + sep) || !existsSync(file)) return next();
        if (isForeignBrandFile(path, edition)) { res.statusCode = 404; res.end(); return; }
        res.setHeader("Content-Type", TYPES[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream");
        res.end(brandText(readFileSync(file, "utf8"), edition));
      });
    },
    writeBundle: {
      sequential: true,
      order: "post",
      handler() {
        if (edition === "traceit" || !existsSync(outDir)) return;
        const left: string[] = [];
        for (const file of walk(outDir)) {
          const rel = relative(outDir, file).split(sep).join("/");
          if (isForeignBrandFile(rel, edition)) { unlinkSync(file); continue; }
          if (!SCANNED.test(rel)) continue;
          const before = readFileSync(file, "utf8");
          const after = BRANDED.test(rel) ? brandText(before, edition) : before;
          if (after !== before) writeFileSync(file, after);
          const hit = findForeignBrand(after);
          if (hit) left.push(`${rel}: ...${hit}...`);
        }
        if (left.length) {
          this.error(`Cruise Saudi build still names TraceIT/Tottempudi in ${left.length} file(s):\n  ${left.slice(0, 20).join("\n  ")}`);
        }
      },
    },
  };
}
